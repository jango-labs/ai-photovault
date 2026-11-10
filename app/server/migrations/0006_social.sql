-- Up Migration
CREATE TABLE social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('instagram')),
  external_id text NOT NULL,
  username text,
  account_type text,
  token_ciphertext bytea,            -- AES-256-GCM; key only in the PHOTOVAULT_TOKEN_ENC_KEY secret. Column-level SELECT is revoked from the API role (0009).
  token_key_id text,
  token_expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'DISCONNECTED' CHECK (status IN ('CONNECTED','EXPIRED','DISCONNECTED','ERROR')),
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, platform, external_id),
  CHECK (status <> 'CONNECTED' OR token_ciphertext IS NOT NULL)
);
CREATE TRIGGER social_accounts_updated BEFORE UPDATE ON social_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL,
  platform_post_id text NOT NULL,
  permalink text,
  media_type text,
  posted_at timestamptz NOT NULL,
  caption text,
  hashtags text[] NOT NULL DEFAULT '{}',
  origin text NOT NULL DEFAULT 'SYNCED' CHECK (origin IN ('SYNCED','APP_PUBLISHED')),
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (social_account_id, platform_post_id),
  FOREIGN KEY (user_id, social_account_id) REFERENCES social_accounts (user_id, id) ON DELETE CASCADE
);
CREATE TRIGGER social_posts_updated BEFORE UPDATE ON social_posts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX social_posts_posted_idx ON social_posts (user_id, posted_at DESC);
CREATE INDEX social_posts_hashtags_idx ON social_posts USING gin (hashtags);

CREATE TABLE social_post_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  social_post_id uuid NOT NULL,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  platform_media_id text,
  file_relpath text CHECK (file_relpath IS NULL OR (file_relpath NOT LIKE '/%' AND file_relpath NOT LIKE '%..%')),  -- under DATA_ROOT/ig-media
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  sha256 bytea CHECK (octet_length(sha256) = 32),
  phash bigint,
  dhash bigint,
  phash_s0 integer GENERATED ALWAYS AS (CASE WHEN phash IS NULL THEN NULL ELSE ((phash >> 48) & 65535)::int END) STORED,
  phash_s1 integer GENERATED ALWAYS AS (CASE WHEN phash IS NULL THEN NULL ELSE ((phash >> 32) & 65535)::int END) STORED,
  phash_s2 integer GENERATED ALWAYS AS (CASE WHEN phash IS NULL THEN NULL ELSE ((phash >> 16) & 65535)::int END) STORED,
  phash_s3 integer GENERATED ALWAYS AS (CASE WHEN phash IS NULL THEN NULL ELSE (phash & 65535)::int END) STORED,
  embedding halfvec,
  embedding_model text,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (social_post_id, position),
  CHECK ((embedding IS NULL) = (embedding_model IS NULL)),
  FOREIGN KEY (user_id, social_post_id) REFERENCES social_posts (user_id, id) ON DELETE CASCADE
);
CREATE INDEX social_post_media_phash0_idx ON social_post_media (user_id, phash_s0) WHERE phash IS NOT NULL;
CREATE INDEX social_post_media_phash1_idx ON social_post_media (user_id, phash_s1) WHERE phash IS NOT NULL;
CREATE INDEX social_post_media_phash2_idx ON social_post_media (user_id, phash_s2) WHERE phash IS NOT NULL;
CREATE INDEX social_post_media_phash3_idx ON social_post_media (user_id, phash_s3) WHERE phash IS NOT NULL;
CREATE INDEX social_post_media_mock_hnsw ON social_post_media
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WHERE embedding_model = 'mock-embedding';

CREATE TABLE photo_social_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  social_post_media_id uuid NOT NULL,
  photo_id uuid NOT NULL,
  photo_version_id uuid,
  state text NOT NULL CHECK (state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH','POSSIBLE_MATCH','NO_MATCH','USER_CONFIRMED','USER_REJECTED')),
  phash_distance integer CHECK (phash_distance BETWEEN 0 AND 64),
  embedding_similarity real CHECK (embedding_similarity BETWEEN -1 AND 1),
  score real CHECK (score BETWEEN 0 AND 1),
  signals jsonb NOT NULL DEFAULT '{}',
  decided_by text NOT NULL DEFAULT 'SYSTEM' CHECK (decided_by IN ('SYSTEM','USER')),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (social_post_media_id, photo_id),    -- one verdict per pair; USER_REJECTED pairs are never re-proposed
  CHECK (state NOT IN ('USER_CONFIRMED','USER_REJECTED') OR (decided_by = 'USER' AND decided_at IS NOT NULL)),
  FOREIGN KEY (user_id, social_post_media_id) REFERENCES social_post_media (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, photo_id) REFERENCES photos (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, photo_version_id) REFERENCES photo_versions (user_id, id) ON DELETE SET NULL (photo_version_id)
);
CREATE TRIGGER psm_updated BEFORE UPDATE ON photo_social_matches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX psm_photo_idx ON photo_social_matches (user_id, photo_id, state);
CREATE INDEX psm_review_idx ON photo_social_matches (user_id, score DESC) WHERE state = 'POSSIBLE_MATCH';
CREATE INDEX psm_version_idx ON photo_social_matches (photo_version_id) WHERE photo_version_id IS NOT NULL;

-- Down Migration
DROP TABLE photo_social_matches;
DROP TABLE social_post_media;
DROP TABLE social_posts;
DROP TABLE social_accounts;
