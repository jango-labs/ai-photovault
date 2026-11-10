-- Up Migration
-- Release 6: a security audit trail. One row per sensitive thing that happened to an account (sign-in, failed second factor, password change, session
-- revoked, Instagram connected or disconnected, a post approved / scheduled / cancelled, an import started). Append-only (no UPDATE or DELETE for anyone),
-- private to the account (forced row-level security), and it never stores request bodies, passwords, codes, tokens or captions — only what happened,
-- when, from which address, and the ids involved.
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
  ip inet,
  detail jsonb NOT NULL DEFAULT '{}' CHECK (pg_column_size(detail) < 4096)
);
CREATE INDEX audit_events_user_at_idx ON audit_events (user_id, at DESC);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_modification();
SELECT secure_user_table('audit_events', 'SELECT, INSERT');
REVOKE UPDATE, DELETE ON audit_events FROM pv_service;
GRANT SELECT ON SEQUENCE audit_events_id_seq TO pv_backup;       -- pg_dump reads sequence state
GRANT USAGE ON SEQUENCE audit_events_id_seq TO pv_app, pv_service;

-- Down Migration
DROP TABLE audit_events;
