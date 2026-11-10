-- Up Migration
CREATE TABLE sync_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  relpath text,
  content_sha256 bytea CHECK (octet_length(content_sha256) = 32),
  photo_version_id uuid,
  detail jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (user_id, device_id) REFERENCES device_tokens (user_id, id) ON DELETE SET NULL (device_id),
  FOREIGN KEY (user_id, photo_version_id) REFERENCES photo_versions (user_id, id) ON DELETE SET NULL (photo_version_id)
);
CREATE INDEX sync_events_at_idx ON sync_events (user_id, at DESC);
CREATE INDEX sync_events_path_idx ON sync_events (user_id, relpath) WHERE relpath IS NOT NULL;
CREATE INDEX sync_events_version_idx ON sync_events (photo_version_id) WHERE photo_version_id IS NOT NULL;
CREATE INDEX sync_events_device_idx ON sync_events (user_id, device_id) WHERE device_id IS NOT NULL;
CREATE TRIGGER sync_events_append_only BEFORE UPDATE OR DELETE ON sync_events FOR EACH ROW EXECUTE FUNCTION forbid_modification();

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD','CANCELLED')),
  priority smallint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,                          -- lease; an expired lease means the worker died
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (user_id, id),
  CHECK (state <> 'RUNNING' OR (locked_by IS NOT NULL AND locked_until IS NOT NULL))
);
CREATE UNIQUE INDEX jobs_dedupe_uq ON jobs (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('QUEUED','RUNNING');
CREATE INDEX jobs_claim_idx ON jobs (priority DESC, run_after) WHERE state = 'QUEUED';
CREATE INDEX jobs_lease_idx ON jobs (locked_until) WHERE state = 'RUNNING';
CREATE INDEX jobs_user_kind_idx ON jobs (user_id, kind, state);

CREATE TABLE job_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  job_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  worker text,
  outcome text CHECK (outcome IN ('OK','ERROR','LEASE_EXPIRED','CANCELLED')),
  error text,
  FOREIGN KEY (user_id, job_id) REFERENCES jobs (user_id, id) ON DELETE CASCADE
);
CREATE INDEX job_attempts_job_idx ON job_attempts (job_id, started_at);

-- Lease-based claim; safe with concurrent workers (SKIP LOCKED). Expired leases are re-queued first.
CREATE FUNCTION claim_jobs(p_worker text, p_kinds text[], p_limit integer, p_lease interval)
RETURNS SETOF jobs LANGUAGE plpgsql AS
$$ BEGIN
  UPDATE jobs SET state = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
                  locked_by = NULL, locked_until = NULL,
                  last_error = coalesce(last_error, 'lease expired'),
                  finished_at = CASE WHEN attempts >= max_attempts THEN now() END
   WHERE state = 'RUNNING' AND locked_until < now();
  RETURN QUERY
  WITH picked AS (
    SELECT id FROM jobs
     WHERE state = 'QUEUED' AND run_after <= now() AND kind = ANY (p_kinds)
     ORDER BY priority DESC, run_after
     LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE jobs j SET state = 'RUNNING', attempts = j.attempts + 1, locked_by = p_worker,
                    locked_until = now() + p_lease
    FROM picked WHERE j.id = picked.id
  RETURNING j.*;
END $$;

-- Operational tables that are not user data.
CREATE TABLE service_heartbeats (
  service text PRIMARY KEY,
  instance text,
  pid integer,
  version text,
  at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('DUMP','USERDATA_EXPORT','CONFIG','RESTORE_TEST')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok boolean,
  bytes bigint,
  path text,
  verified_at timestamptz,
  verify_ok boolean,
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX backup_runs_kind_idx ON backup_runs (kind, started_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  severity text NOT NULL CHECK (severity IN ('INFO','WARN','ERROR')),
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  read_at timestamptz
);
CREATE INDEX notifications_unread_idx ON notifications (user_id, at DESC) WHERE read_at IS NULL;

CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  thumb_size integer NOT NULL DEFAULT 240 CHECK (thumb_size BETWEEN 80 AND 640),
  ai_scores_visible boolean NOT NULL DEFAULT false,
  viewer_surface text NOT NULL DEFAULT 'teal' CHECK (viewer_surface IN ('teal','neutral')),
  active_embedding_model text,
  settings jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_settings_updated BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Uncertain decisions that need a human: VERSION_MATCH (same photo?) and IG_MATCH (same post?).
CREATE TABLE review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('VERSION_MATCH','IG_MATCH','DUPLICATE_FILE')),
  subject jsonb NOT NULL,
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','CONFIRMED','REJECTED','SKIPPED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK ((state = 'OPEN') = (decided_at IS NULL) OR state = 'SKIPPED')
);
CREATE INDEX review_queue_open_idx ON review_queue (user_id, kind, created_at) WHERE state = 'OPEN';

-- Down Migration
DROP TABLE review_queue;
DROP TABLE user_settings;
DROP TABLE notifications;
DROP TABLE backup_runs;
DROP TABLE service_heartbeats;
DROP FUNCTION claim_jobs(text, text[], integer, interval);
DROP TABLE job_attempts;
DROP TABLE jobs;
DROP TABLE sync_events;
