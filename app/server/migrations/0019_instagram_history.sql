-- Up Migration
-- Phase 13: Instagram history. The tables for posts, media, fingerprints and matches exist since 0006; this adds the sync log and
-- a vector index for the local picture embedding on Instagram media (so a post can be compared with the library by appearance).
CREATE TABLE ig_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','OK','PARTIAL','FAILED')),
  posts_seen integer NOT NULL DEFAULT 0,
  posts_new integer NOT NULL DEFAULT 0,
  media_fetched integer NOT NULL DEFAULT 0,
  media_failed integer NOT NULL DEFAULT 0,
  matched integer NOT NULL DEFAULT 0,
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  FOREIGN KEY (user_id, social_account_id) REFERENCES social_accounts (user_id, id) ON DELETE CASCADE
);
CREATE INDEX ig_sync_runs_idx ON ig_sync_runs (user_id, started_at DESC);
CREATE INDEX ig_sync_runs_account_idx ON ig_sync_runs (user_id, social_account_id);
SELECT secure_user_table('ig_sync_runs', 'SELECT');

CREATE INDEX social_post_media_local_hnsw ON social_post_media USING hnsw ((embedding::halfvec(256)) halfvec_cosine_ops) WHERE embedding_model = 'local-visual-v1';
CREATE INDEX social_post_media_unmatched_idx ON social_post_media (user_id, created_at) WHERE phash IS NOT NULL;

-- Down Migration
DROP INDEX social_post_media_unmatched_idx;
DROP INDEX social_post_media_local_hnsw;
DROP TABLE ig_sync_runs;
