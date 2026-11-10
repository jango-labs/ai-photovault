-- Up Migration
-- Phase 8: analyses can come from the local image analyser (offline, measured) as well as the mock and (later, approved) hosted providers.
ALTER TABLE ai_analyses DROP CONSTRAINT ai_analyses_mode_check;
ALTER TABLE ai_analyses ADD CONSTRAINT ai_analyses_mode_check CHECK (mode IN ('mock','local','live'));

-- Every human decision about AI output, append-only: what the AI said, what the photographer decided.
CREATE TABLE ai_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  analysis_id uuid,
  kind text NOT NULL CHECK (kind IN ('SPECIES_CONFIRM','SPECIES_REJECT','SPECIES_ADD','SPECIES_CORRECT','DESCRIPTION_ACCEPT')),
  before jsonb,
  after jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, photo_id) REFERENCES photos (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, analysis_id) REFERENCES ai_analyses (user_id, id) ON DELETE SET NULL (analysis_id)
);
CREATE INDEX ai_corrections_photo_idx ON ai_corrections (user_id, photo_id, at DESC);
CREATE INDEX ai_corrections_analysis_idx ON ai_corrections (analysis_id) WHERE analysis_id IS NOT NULL;
CREATE INDEX ai_corrections_recent_idx ON ai_corrections (user_id, at DESC);
CREATE TRIGGER ai_corrections_append_only BEFORE UPDATE OR DELETE ON ai_corrections FOR EACH ROW EXECUTE FUNCTION forbid_modification();
SELECT secure_user_table('ai_corrections', 'SELECT, INSERT');

-- Analyses are looked up per photograph version, newest first (history, "latest").
CREATE INDEX ai_analyses_user_version_idx ON ai_analyses (user_id, photo_version_id, created_at DESC);

-- Down Migration
DROP INDEX ai_analyses_user_version_idx;
DROP TABLE ai_corrections;
ALTER TABLE ai_analyses DROP CONSTRAINT ai_analyses_mode_check;
ALTER TABLE ai_analyses ADD CONSTRAINT ai_analyses_mode_check CHECK (mode IN ('mock','live'));
