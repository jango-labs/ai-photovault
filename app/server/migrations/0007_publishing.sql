-- Up Migration
CREATE TABLE publishing_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  photo_version_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'instagram' CHECK (platform IN ('instagram')),
  social_account_id uuid,
  internal_title text,
  caption_body text NOT NULL DEFAULT '' CHECK (char_length(caption_body) <= 2200),
  hashtags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(hashtags) <= 30),
  internal_notes text,
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','READY','SCHEDULED','PUBLISHING','PUBLISHED','FAILED','CANCELLED')),
  created_by text NOT NULL DEFAULT 'USER' CHECK (created_by IN ('USER','AI')),
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  history_check jsonb,
  history_override_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  -- Nothing can be scheduled/published without an explicit user approval.
  CHECK (state NOT IN ('SCHEDULED','PUBLISHING','PUBLISHED') OR approved_at IS NOT NULL),
  -- AI-created drafts stay drafts until a user approves them.
  CHECK (created_by <> 'AI' OR approved_at IS NOT NULL OR state IN ('DRAFT','CANCELLED')),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  FOREIGN KEY (user_id, photo_id) REFERENCES photos (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, photo_version_id) REFERENCES photo_versions (user_id, id),
  FOREIGN KEY (user_id, social_account_id) REFERENCES social_accounts (user_id, id) ON DELETE SET NULL (social_account_id)
);
CREATE TRIGGER publishing_drafts_updated BEFORE UPDATE ON publishing_drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX drafts_photo_idx ON publishing_drafts (user_id, photo_id);
CREATE INDEX drafts_state_idx ON publishing_drafts (user_id, state);
CREATE INDEX drafts_approved_by_idx ON publishing_drafts (approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX drafts_version_idx ON publishing_drafts (photo_version_id);
CREATE INDEX drafts_account_idx ON publishing_drafts (social_account_id) WHERE social_account_id IS NOT NULL;

CREATE TABLE caption_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  draft_id uuid,
  parent_id uuid,
  body text NOT NULL,
  style text CHECK (style IN ('STORYTELLING','EDUCATIONAL','SHORT')),
  origin text NOT NULL CHECK (origin IN ('AI','USER','AI_EDITED')),
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, photo_id) REFERENCES photos (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, draft_id) REFERENCES publishing_drafts (user_id, id) ON DELETE SET NULL (draft_id),
  FOREIGN KEY (user_id, parent_id) REFERENCES caption_versions (user_id, id) ON DELETE SET NULL (parent_id)
);
CREATE INDEX caption_versions_photo_idx ON caption_versions (user_id, photo_id, created_at DESC);
CREATE INDEX caption_versions_draft_idx ON caption_versions (draft_id) WHERE draft_id IS NOT NULL;
CREATE INDEX caption_versions_parent_idx ON caption_versions (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE scheduled_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL,
  scheduled_at timestamptz NOT NULL,
  timezone text NOT NULL CHECK (is_valid_timezone(timezone)),
  state text NOT NULL DEFAULT 'SCHEDULED' CHECK (state IN ('SCHEDULED','PUBLISHING','PUBLISHED','FAILED','CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  error_code text,
  error_message text,
  idempotency_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  container_id text,                               -- persisted BEFORE media_publish
  publish_requested_at timestamptz,                -- set in the same tx BEFORE media_publish; drives UNKNOWN_OUTCOME recovery
  platform_post_id text,
  permalink text,
  published_at timestamptz,
  verified_at timestamptz,
  locked_by text,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (draft_id),
  -- PUBLISHED only after the post has been verified on the platform; an API request alone is never enough.
  CHECK (state <> 'PUBLISHED' OR (platform_post_id IS NOT NULL AND verified_at IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (publish_requested_at IS NULL OR container_id IS NOT NULL),
  CHECK (attempt_count <= max_attempts + 1),
  FOREIGN KEY (user_id, draft_id) REFERENCES publishing_drafts (user_id, id)
);
CREATE TRIGGER scheduled_publications_updated BEFORE UPDATE ON scheduled_publications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX scheduled_platform_post_uq ON scheduled_publications (user_id, platform_post_id) WHERE platform_post_id IS NOT NULL;
CREATE INDEX scheduled_due_idx ON scheduled_publications (scheduled_at) WHERE state = 'SCHEDULED';
CREATE INDEX scheduled_user_time_idx ON scheduled_publications (user_id, scheduled_at);
CREATE INDEX scheduled_lock_idx ON scheduled_publications (locked_until) WHERE locked_until IS NOT NULL;

-- A publication may only be scheduled for a draft that a user has approved.
CREATE FUNCTION enforce_schedule_approval() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF NEW.state IN ('SCHEDULED','PUBLISHING','PUBLISHED') THEN
    IF NOT EXISTS (SELECT 1 FROM publishing_drafts d WHERE d.id = NEW.draft_id AND d.user_id = NEW.user_id AND d.approved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'draft % has not been approved by a user; refusing to schedule/publish', NEW.draft_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scheduled_requires_approval BEFORE INSERT OR UPDATE OF state, draft_id ON scheduled_publications
  FOR EACH ROW EXECUTE FUNCTION enforce_schedule_approval();

CREATE TABLE publication_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_publication_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  phase text NOT NULL CHECK (phase IN ('PREFLIGHT','CREATE_CONTAINER','POLL_STATUS','PUBLISH','VERIFY','RECONCILE')),
  outcome text CHECK (outcome IN ('OK','FAILED','UNKNOWN')),
  error_code text,
  http_status integer,
  platform_error jsonb,
  FOREIGN KEY (user_id, scheduled_publication_id) REFERENCES scheduled_publications (user_id, id) ON DELETE CASCADE
);
CREATE INDEX publication_attempts_pub_idx ON publication_attempts (scheduled_publication_id, started_at);
CREATE INDEX publication_attempts_user_idx ON publication_attempts (user_id, started_at DESC);
-- append-only: only the completion fields of an open attempt may change; rows are never deleted
CREATE FUNCTION publication_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;   -- cascade from removing the whole user
    RAISE EXCEPTION 'publication_attempts is append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.finished_at IS NOT NULL
     OR (NEW.id, NEW.user_id, NEW.scheduled_publication_id, NEW.started_at, NEW.phase)
        IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.scheduled_publication_id, OLD.started_at, OLD.phase) THEN
    RAISE EXCEPTION 'publication_attempts rows are immutable once finished' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_attempts_append_only BEFORE UPDATE OR DELETE ON publication_attempts
  FOR EACH ROW EXECUTE FUNCTION publication_attempts_guard();

-- Short-lived tokens for the isolated public image-delivery service (hash only; plaintext never stored).
CREATE TABLE delivery_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_publication_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  file_relpath text NOT NULL CHECK (file_relpath NOT LIKE '/%' AND file_relpath NOT LIKE '%..%'),   -- under DATA_ROOT/delivery
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  max_hits integer NOT NULL DEFAULT 5 CHECK (max_hits BETWEEN 1 AND 20),
  hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  FOREIGN KEY (user_id, scheduled_publication_id) REFERENCES scheduled_publications (user_id, id) ON DELETE CASCADE
);
CREATE INDEX delivery_tokens_pub_idx ON delivery_tokens (scheduled_publication_id);
CREATE INDEX delivery_tokens_user_idx ON delivery_tokens (user_id);
CREATE INDEX delivery_tokens_expiry_idx ON delivery_tokens (expires_at) WHERE revoked_at IS NULL;

-- Down Migration
DROP TABLE delivery_tokens;
DROP TABLE publication_attempts;
DROP FUNCTION publication_attempts_guard();
DROP TABLE scheduled_publications;
DROP FUNCTION enforce_schedule_approval();
DROP TABLE caption_versions;
DROP TABLE publishing_drafts;
