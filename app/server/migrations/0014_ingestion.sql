-- Up Migration
-- Phase 7: import runs and what each run decided. The runs are an audit trail of what was scanned; they never contain photographs.
CREATE TABLE import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_root_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('DRY_RUN','APPLY')),
  state text NOT NULL DEFAULT 'RUNNING' CHECK (state IN ('RUNNING','COMPLETED','FAILED','INTERRUPTED','CANCELLED')),
  source_path text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counters jsonb NOT NULL DEFAULT '{}',
  error text,
  resumed_from uuid,
  UNIQUE (user_id, id),
  CHECK ((state = 'RUNNING') = (finished_at IS NULL) OR state = 'INTERRUPTED'),
  FOREIGN KEY (user_id, library_root_id) REFERENCES library_roots (user_id, id)
);
CREATE INDEX import_runs_user_idx ON import_runs (user_id, started_at DESC);
CREATE INDEX import_runs_root_idx ON import_runs (user_id, library_root_id);
CREATE INDEX import_runs_running_idx ON import_runs (heartbeat_at) WHERE state = 'RUNNING';
SELECT secure_user_table('import_runs', 'SELECT, INSERT, UPDATE');

CREATE TABLE import_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  relpath text NOT NULL,
  action text NOT NULL CHECK (action IN ('NEW','NEW_VERSION','MOVED','DUPLICATE_FILE','VERSION_REVIEW','UNCHANGED','SOURCE_MISSING','SKIPPED','ERROR')),
  detail text,
  sha256 bytea CHECK (octet_length(sha256) = 32),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, run_id) REFERENCES import_runs (user_id, id) ON DELETE CASCADE
);
CREATE INDEX import_items_run_idx ON import_items (user_id, run_id, id);
CREATE INDEX import_items_action_idx ON import_items (run_id, action);
SELECT secure_user_table('import_items', 'SELECT, INSERT');
GRANT USAGE ON SEQUENCE import_items_id_seq TO pv_app, pv_service;
GRANT SELECT ON SEQUENCE import_items_id_seq TO pv_backup;

-- Work the worker does for a photograph version is found by (kind, payload.versionId): one live job per version and kind.
CREATE INDEX jobs_version_idx ON jobs (user_id, ((payload ->> 'versionId'))) WHERE payload ? 'versionId';

-- Down Migration
DROP INDEX jobs_version_idx;
DROP TABLE import_items;
DROP TABLE import_runs;
