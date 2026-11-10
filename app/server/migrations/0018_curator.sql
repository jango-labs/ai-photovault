-- Up Migration
-- Phase 11: the AI Curator is advisory. It records what it was asked and what it suggested (curator_runs), and what the person
-- said about the suggestions (curator_feedback, append-only: the latest verdict per photograph wins). It writes nothing else
-- except AI-draft collections, which a person must activate.
CREATE TABLE curator_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request text NOT NULL CHECK (char_length(request) BETWEEN 0 AND 300),
  purpose text NOT NULL CHECK (purpose IN ('general','instagram','portfolio')),
  count integer NOT NULL CHECK (count BETWEEN 1 AND 60),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);
CREATE INDEX curator_runs_user_idx ON curator_runs (user_id, created_at DESC);
SELECT secure_user_table('curator_runs', 'SELECT, INSERT, DELETE');

CREATE TABLE curator_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  run_id uuid,                                    -- informational: the run the verdict was given in (runs may be pruned; feedback never changes)
  verdict text NOT NULL CHECK (verdict IN ('LIKE','DISLIKE','CLEAR')),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, photo_id) REFERENCES photos (user_id, id) ON DELETE CASCADE
);
CREATE INDEX curator_feedback_photo_idx ON curator_feedback (user_id, photo_id, at DESC);
CREATE TRIGGER curator_feedback_append_only BEFORE UPDATE OR DELETE ON curator_feedback FOR EACH ROW EXECUTE FUNCTION forbid_modification();
SELECT secure_user_table('curator_feedback', 'SELECT, INSERT');

-- Down Migration
DROP TABLE curator_feedback;
DROP TABLE curator_runs;
