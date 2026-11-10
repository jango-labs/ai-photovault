-- Up Migration
-- TOTP replay protection: the last accepted 30-second time step; a code can only be used once.
ALTER TABLE users ADD COLUMN totp_last_step bigint;
GRANT UPDATE (totp_last_step) ON users TO pv_app;

-- One-time recovery codes (stored hashed; shown once at enrolment).
CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  UNIQUE (user_id, code_hash)
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id) WHERE used_at IS NULL;
ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY app_isolation ON recovery_codes TO pv_app USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY service_all ON recovery_codes TO pv_service USING (true) WITH CHECK (true);
CREATE POLICY backup_read ON recovery_codes FOR SELECT TO pv_backup USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON recovery_codes TO pv_service;
GRANT SELECT ON recovery_codes TO pv_backup;
GRANT SELECT, INSERT, UPDATE (used_at), DELETE ON recovery_codes TO pv_app;

-- Sessions expire absolutely (expires_at) AND after inactivity (14 days without use).
CREATE OR REPLACE FUNCTION auth_resolve_session(p_token_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$ DECLARE v uuid;
BEGIN
  UPDATE sessions s SET last_seen_at = now()
   FROM users u
   WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
     AND s.last_seen_at > now() - interval '14 days'
     AND u.id = s.user_id AND u.disabled_at IS NULL
   RETURNING s.user_id INTO v;
  RETURN v;
END $$;

-- Which session id does this token belong to (for "this device" and revoke-others). Same validity rules, no side effects.
CREATE FUNCTION auth_session_id(p_token_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
      AND s.last_seen_at > now() - interval '14 days' AND u.disabled_at IS NULL $$;
REVOKE ALL ON FUNCTION auth_session_id(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_session_id(bytea) TO pv_app;

-- Photograph viewer background defaults to neutral grey (teal remains an option).
ALTER TABLE user_settings ALTER COLUMN viewer_surface SET DEFAULT 'neutral';

-- Down Migration
ALTER TABLE user_settings ALTER COLUMN viewer_surface SET DEFAULT 'teal';
DROP FUNCTION auth_session_id(bytea);
CREATE OR REPLACE FUNCTION auth_resolve_session(p_token_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$ DECLARE v uuid;
BEGIN
  UPDATE sessions s SET last_seen_at = now()
   FROM users u
   WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
     AND u.id = s.user_id AND u.disabled_at IS NULL
   RETURNING s.user_id INTO v;
  RETURN v;
END $$;
DROP TABLE recovery_codes;
ALTER TABLE users DROP COLUMN totp_last_step;
