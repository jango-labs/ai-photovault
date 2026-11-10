-- Up Migration
-- Phase 6: photo management. Helper used by this and later migrations to give a new user-owned table the same
-- row-level-security shape as every other one (forced RLS, per-user API policy, service policy, backup read).
CREATE FUNCTION secure_user_table(t regclass, app_grants text) RETURNS void LANGUAGE plpgsql AS
$$ BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY app_isolation ON %s TO pv_app USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id())', t);
  EXECUTE format('CREATE POLICY service_all ON %s TO pv_service USING (true) WITH CHECK (true)', t);
  EXECUTE format('CREATE POLICY backup_read ON %s FOR SELECT TO pv_backup USING (true)', t);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO pv_service', t);
  EXECUTE format('GRANT SELECT ON %s TO pv_backup', t);
  IF app_grants <> '' THEN EXECUTE format('GRANT %s ON %s TO pv_app', app_grants, t); END IF;
END $$;
REVOKE ALL ON FUNCTION secure_user_table(regclass, text) FROM PUBLIC;

-- Description with provenance (like title, capture date, location).
ALTER TABLE photos ADD COLUMN description text, ADD COLUMN description_source meta_source,
  ADD CONSTRAINT photos_description_source_ck CHECK (description IS NULL OR description_source IS NOT NULL);

-- Every user edit of photograph metadata, append-only. An undo is a new row that points at the edit it reverts.
CREATE TABLE photo_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  batch_id uuid NOT NULL DEFAULT gen_random_uuid(),                 -- edits saved together
  field text NOT NULL CHECK (field IN ('title','description','notes','capture_at','trip_location','gps','current_version','hidden')),
  old_value jsonb, new_value jsonb,
  old_source text, new_source text,
  kind text NOT NULL DEFAULT 'EDIT' CHECK (kind IN ('EDIT','UNDO','BULK')),
  reverts_id uuid,
  edited_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CHECK ((kind = 'UNDO') = (reverts_id IS NOT NULL)),
  FOREIGN KEY (user_id, photo_id) REFERENCES photos (user_id, id) ON DELETE CASCADE
);
CREATE INDEX photo_edits_photo_idx ON photo_edits (user_id, photo_id, edited_at DESC);
CREATE UNIQUE INDEX photo_edits_reverts_uq ON photo_edits (reverts_id) WHERE reverts_id IS NOT NULL;   -- an edit can be undone once
CREATE TRIGGER photo_edits_append_only BEFORE UPDATE OR DELETE ON photo_edits FOR EACH ROW EXECUTE FUNCTION forbid_modification();
SELECT secure_user_table('photo_edits', 'SELECT, INSERT');

-- Near-duplicate candidates found from perceptual hashes. Decisions are remembered (DISTINCT pairs are never proposed again).
CREATE TABLE duplicate_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_a uuid NOT NULL,
  photo_b uuid NOT NULL,
  distance smallint NOT NULL CHECK (distance BETWEEN 0 AND 64),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','DUPLICATE','DISTINCT')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK (photo_a < photo_b),
  CHECK ((state = 'OPEN') = (decided_at IS NULL)),
  UNIQUE (photo_a, photo_b),
  FOREIGN KEY (user_id, photo_a) REFERENCES photos (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, photo_b) REFERENCES photos (user_id, id) ON DELETE CASCADE
);
CREATE INDEX duplicate_pairs_a_idx ON duplicate_pairs (user_id, photo_a);
CREATE INDEX duplicate_pairs_b_idx ON duplicate_pairs (user_id, photo_b);
CREATE INDEX duplicate_pairs_open_idx ON duplicate_pairs (user_id, distance, id) WHERE state = 'OPEN';
SELECT secure_user_table('duplicate_pairs', 'SELECT, INSERT, UPDATE (state, decided_at)');

-- Down Migration
DROP TABLE duplicate_pairs;
DROP TABLE photo_edits;
ALTER TABLE photos DROP CONSTRAINT photos_description_source_ck, DROP COLUMN description_source, DROP COLUMN description;
DROP FUNCTION secure_user_table(regclass, text);
