-- Up Migration
-- Roles are cluster-level and created by scripts/db/init-cluster.sh (pv_owner, pv_app, pv_service, pv_delivery, pv_backup).
-- None is a superuser or has BYPASSRLS.

-- ---------------------------------------------------------------- row-level security
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'user_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Auth tables are NOT forced for the owner: the SECURITY DEFINER auth_* functions (owned by pv_owner) are their only pre-login path.
    IF t NOT IN ('sessions','device_tokens','login_attempts') THEN
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    END IF;
    EXECUTE format('CREATE POLICY app_isolation ON %I TO pv_app USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id())', t);
    EXECUTE format('CREATE POLICY service_all ON %I TO pv_service USING (true) WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY backup_read ON %I FOR SELECT TO pv_backup USING (true)', t);
  END LOOP;
END $$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;   -- not forced (auth functions), keyed on id
CREATE POLICY app_isolation ON users TO pv_app USING (id = app_user_id()) WITH CHECK (id = app_user_id());
CREATE POLICY service_all ON users TO pv_service USING (true) WITH CHECK (true);
CREATE POLICY backup_read ON users FOR SELECT TO pv_backup USING (true);

-- the public image-delivery process may look up and count hits on tokens, nothing else
CREATE POLICY delivery_lookup ON delivery_tokens FOR SELECT TO pv_delivery USING (true);
CREATE POLICY delivery_hit ON delivery_tokens FOR UPDATE TO pv_delivery USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO pv_app, pv_service, pv_delivery, pv_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_user_id(), hamming64(bigint, bigint), is_valid_timezone(text) TO pv_app, pv_service, pv_backup;

-- service role: the background processes (worker, scheduler, agent API-side, backup of last resort)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pv_service;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO pv_service, pv_app;
GRANT EXECUTE ON FUNCTION claim_jobs(text, text[], integer, interval) TO pv_service;
GRANT EXECUTE ON FUNCTION forbid_modification(), set_updated_at(), enforce_schedule_approval(), publication_attempts_guard() TO pv_service, pv_app;

-- backup role: read everything (RLS policy backup_read), no writes
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pv_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO pv_backup;   -- pg_dump reads sequence state

-- delivery role: one table, one writable column
GRANT SELECT ON delivery_tokens TO pv_delivery;
GRANT UPDATE (hits) ON delivery_tokens TO pv_delivery;

-- API role (every request runs with SET LOCAL app.user_id): read/write the user's own data, nothing more
GRANT SELECT, INSERT, UPDATE, DELETE ON
  locations, photos, photo_versions, species, photo_species, collections, collection_photos,
  publishing_drafts, caption_versions, user_settings, review_queue, ai_budget, library_roots, device_tokens
  TO pv_app;
GRANT SELECT, INSERT ON sync_events TO pv_app;
GRANT SELECT ON ai_analyses, photo_embeddings, ai_usage_ledger, social_posts, social_post_media, photo_social_matches,
  publication_attempts, job_attempts, service_heartbeats, backup_runs TO pv_app;
GRANT UPDATE (state, decided_by, decided_at, signals) ON photo_social_matches TO pv_app;       -- confirm / reject a match
GRANT INSERT ON photo_social_matches TO pv_app;
GRANT SELECT, INSERT, UPDATE ON scheduled_publications TO pv_app;                              -- guarded by trigger below
GRANT SELECT, INSERT, UPDATE ON jobs TO pv_app;
GRANT SELECT, UPDATE ON notifications TO pv_app;
GRANT SELECT, UPDATE (display_name, timezone, password_hash, totp_secret_ciphertext, totp_enabled) ON users TO pv_app;
GRANT SELECT, UPDATE (revoked_at) ON sessions TO pv_app;
-- social accounts: the API can WRITE tokens (OAuth callback) but can never READ them back
GRANT SELECT (id, user_id, platform, external_id, username, account_type, token_expires_at, scopes, status,
              last_sync_at, last_error, created_at, updated_at) ON social_accounts TO pv_app;
GRANT INSERT, UPDATE, DELETE ON social_accounts TO pv_app;
REVOKE SELECT (token_ciphertext, token_key_id) ON social_accounts FROM pv_app;

-- login_attempts, delivery_tokens, social tokens: no direct access for pv_app (functions / service only)

-- The API may schedule or cancel, but only the scheduler may move a publication through PUBLISHING/PUBLISHED/FAILED
-- or touch container / platform ids and leases.
CREATE FUNCTION scheduled_publications_api_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF current_user = 'pv_app' THEN
    IF NEW.state NOT IN ('SCHEDULED','CANCELLED') THEN
      RAISE EXCEPTION 'API role may only set state SCHEDULED or CANCELLED (got %)', NEW.state USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF (NEW.container_id, NEW.publish_requested_at, NEW.platform_post_id, NEW.permalink, NEW.published_at,
          NEW.verified_at, NEW.locked_by, NEW.locked_until, NEW.last_attempt_at) IS DISTINCT FROM
         (NULL::text, NULL::timestamptz, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::timestamptz, NULL::timestamptz)
         OR NEW.attempt_count <> 0 THEN
        RAISE EXCEPTION 'API role cannot set publication progress fields' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF OLD.state IN ('PUBLISHING','PUBLISHED') THEN
        RAISE EXCEPTION 'API role cannot modify a % publication', OLD.state USING ERRCODE = '42501';
      END IF;
      IF (NEW.container_id, NEW.publish_requested_at, NEW.platform_post_id, NEW.permalink, NEW.published_at,
          NEW.verified_at, NEW.locked_by, NEW.locked_until, NEW.idempotency_key, NEW.draft_id) IS DISTINCT FROM
         (OLD.container_id, OLD.publish_requested_at, OLD.platform_post_id, OLD.permalink, OLD.published_at,
          OLD.verified_at, OLD.locked_by, OLD.locked_until, OLD.idempotency_key, OLD.draft_id) THEN
        RAISE EXCEPTION 'API role cannot modify publication progress fields' USING ERRCODE = '42501';
      END IF;
      -- retry after FAILED is a user action that resets the attempt counter and error
      IF OLD.state = 'FAILED' AND NEW.state = 'SCHEDULED' THEN
        NEW.attempt_count := 0; NEW.error_code := NULL; NEW.error_message := NULL; NEW.next_attempt_at := NULL;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scheduled_publications_api_guard BEFORE INSERT OR UPDATE ON scheduled_publications
  FOR EACH ROW EXECUTE FUNCTION scheduled_publications_api_guard();

-- auth functions are executable by the API role only
GRANT EXECUTE ON FUNCTION auth_find_user(citext), auth_resolve_session(bytea), auth_resolve_device(bytea),
  auth_record_login(uuid, inet, boolean), auth_recent_failures(uuid, inet, interval),
  auth_create_session(uuid, bytea, interval, inet, text) TO pv_app;

-- Down Migration
DROP TRIGGER scheduled_publications_api_guard ON scheduled_publications;
DROP FUNCTION scheduled_publications_api_guard();
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pv_app, pv_service, pv_delivery, pv_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM pv_app, pv_service;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM pv_app, pv_service, pv_delivery, pv_backup;
REVOKE ALL ON SCHEMA public FROM pv_app, pv_service, pv_delivery, pv_backup;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;
END $$;
