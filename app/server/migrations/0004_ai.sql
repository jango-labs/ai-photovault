-- Up Migration
-- AI output is immutable and versioned; it never overwrites user-owned data on photos / photo_species.
CREATE TABLE ai_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_version_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('mock','live')),
  created_at timestamptz NOT NULL DEFAULT now(),
  primary_subject text,
  secondary_subjects text[] NOT NULL DEFAULT '{}',
  objects text[] NOT NULL DEFAULT '{}',
  scenes text[] NOT NULL DEFAULT '{}',
  environment text,
  categories text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  description text,
  suggested_title text,
  style text, lighting text, location_clues text,
  dominant_color_names text[] NOT NULL DEFAULT '{}',
  wildlife jsonb NOT NULL DEFAULT '[]',
  scores jsonb NOT NULL DEFAULT '{}',
  overall_score real CHECK (overall_score BETWEEN 0 AND 1),
  confidence jsonb NOT NULL DEFAULT '{}',
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, photo_version_id) REFERENCES photo_versions (user_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_analyses_version_idx ON ai_analyses (photo_version_id, created_at DESC);
CREATE INDEX ai_analyses_score_idx ON ai_analyses (user_id, overall_score DESC NULLS LAST);
CREATE INDEX ai_analyses_tags_idx ON ai_analyses USING gin (tags);
CREATE TRIGGER ai_analyses_immutable BEFORE UPDATE ON ai_analyses FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- Embeddings are provider-agnostic: dimension is per row; one partial HNSW index per active model/dimension.
CREATE TABLE photo_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_version_id uuid NOT NULL,
  model text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image','text')),
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 2 AND 4000),
  embedding halfvec NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (vector_dims(embedding) = dimensions),
  UNIQUE (photo_version_id, model, kind),
  FOREIGN KEY (user_id, photo_version_id) REFERENCES photo_versions (user_id, id) ON DELETE CASCADE
);
CREATE INDEX photo_embeddings_user_idx ON photo_embeddings (user_id, model);
-- Mock model (1024-d) so the pipeline and search can be built at zero cost. Real models add their own index in a new migration.
CREATE INDEX photo_embeddings_mock_hnsw ON photo_embeddings
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WHERE model = 'mock-embedding' AND kind = 'image';

CREATE TABLE species (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  common_name text NOT NULL,
  scientific_name text,
  taxon_rank text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);
CREATE UNIQUE INDEX species_common_uq ON species (user_id, lower(common_name));
CREATE UNIQUE INDEX species_scientific_uq ON species (user_id, lower(scientific_name)) WHERE scientific_name IS NOT NULL;

CREATE TABLE photo_species (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  species_id uuid NOT NULL,
  analysis_id uuid,                                   -- the AI run that suggested it, if any
  subject_count integer CHECK (subject_count >= 0),
  behavior text,
  habitat text,
  confidence real CHECK (confidence BETWEEN 0 AND 1),
  source meta_source NOT NULL,
  status text NOT NULL DEFAULT 'SUGGESTED' CHECK (status IN ('SUGGESTED','CONFIRMED','REJECTED')),  -- rejected AI suggestions are remembered
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (photo_id, species_id),
  CHECK (source <> 'USER_DEFINED' OR status = 'CONFIRMED'),
  FOREIGN KEY (user_id, photo_id) REFERENCES photos (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, species_id) REFERENCES species (user_id, id),
  FOREIGN KEY (user_id, analysis_id) REFERENCES ai_analyses (user_id, id) ON DELETE SET NULL (analysis_id)
);
CREATE TRIGGER photo_species_updated BEFORE UPDATE ON photo_species FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX photo_species_species_idx ON photo_species (user_id, species_id) WHERE status <> 'REJECTED';
CREATE INDEX photo_species_analysis_idx ON photo_species (analysis_id) WHERE analysis_id IS NOT NULL;

-- Spend control (enforced by AiGateway; live_enabled=false means the mock provider only).
CREATE TABLE ai_budget (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  live_enabled boolean NOT NULL DEFAULT false,
  monthly_cap_usd numeric(10,2) NOT NULL DEFAULT 0 CHECK (monthly_cap_usd >= 0),
  per_run_cap_usd numeric(10,2) NOT NULL DEFAULT 0 CHECK (per_run_cap_usd >= 0),
  lifetime_photo_cap integer NOT NULL DEFAULT 200 CHECK (lifetime_photo_cap >= 0),
  approved_at timestamptz,
  approved_note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT live_enabled OR approved_at IS NOT NULL)   -- live AI can only be switched on with an explicit approval stamp
);
CREATE TRIGGER ai_budget_updated BEFORE UPDATE ON ai_budget FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ai_usage_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  model text NOT NULL,
  purpose text NOT NULL,
  units jsonb NOT NULL DEFAULT '{}',
  est_cost_usd numeric(12,6) NOT NULL CHECK (est_cost_usd >= 0),
  photo_version_id uuid,
  run_id text,
  job_id uuid
);
CREATE INDEX ai_ledger_month_idx ON ai_usage_ledger (user_id, at);
CREATE INDEX ai_ledger_run_idx ON ai_usage_ledger (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX ai_ledger_photo_idx ON ai_usage_ledger (user_id, photo_version_id) WHERE photo_version_id IS NOT NULL;
CREATE TRIGGER ai_ledger_append_only BEFORE UPDATE OR DELETE ON ai_usage_ledger FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- Down Migration
DROP TABLE ai_usage_ledger;
DROP TABLE ai_budget;
DROP TABLE photo_species;
DROP TABLE species;
DROP TABLE photo_embeddings;
DROP TABLE ai_analyses;
