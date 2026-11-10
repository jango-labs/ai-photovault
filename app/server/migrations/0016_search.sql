-- Up Migration
-- Phase 9: full-text search documents, local visual-embedding index, search history, colour filter index.

-- One searchable document per photograph: title/filename (A), place + species (B), your description + AI tags (C), keywords/notes/colours (D).
-- It is rebuilt by refresh_search() whenever something searchable changes (edits, species decisions, analyses, imports).
CREATE TABLE search_documents (
  photo_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc tsvector NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, photo_id) REFERENCES photos (user_id, id) ON DELETE CASCADE
);
CREATE INDEX search_documents_user_idx ON search_documents (user_id);
CREATE INDEX search_documents_gin_idx ON search_documents USING gin (doc);
SELECT secure_user_table('search_documents', 'SELECT, INSERT, UPDATE, DELETE');

-- Runs with the caller's rights (so row-level security still applies). p_photos NULL = every photograph of the user.
CREATE FUNCTION refresh_search(p_user uuid, p_photos uuid[] DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS
$$ DECLARE n integer; BEGIN
  INSERT INTO search_documents (photo_id, user_id, doc)
  SELECT p.id, p.user_id,
    setweight(to_tsvector('english', coalesce(p.title, '') || ' ' || regexp_replace(regexp_replace(v.source_relpath, '^.*/', ''), '[_.-]+', ' ', 'g')), 'A')
    || setweight(to_tsvector('english', coalesce(p.trip_location, '') || ' ' || coalesce(sp.names, '')), 'B')
    || setweight(to_tsvector('english', coalesce(p.description, '') || ' ' || coalesce(an.text, '')), 'C')
    || setweight(to_tsvector('simple', array_to_string(v.keywords, ' ') || ' ' || coalesce(p.notes, '') || ' ' || coalesce(an.colours, '')), 'D')
  FROM photos p
  JOIN photo_versions v ON v.id = p.current_version_id
  LEFT JOIN LATERAL (SELECT string_agg(s.common_name || ' ' || coalesce(s.scientific_name, ''), ' ') AS names
                       FROM photo_species ps JOIN species s ON s.id = ps.species_id WHERE ps.photo_id = p.id AND ps.status <> 'REJECTED') sp ON true
  LEFT JOIN LATERAL (SELECT array_to_string(a.tags, ' ') || ' ' || CASE WHEN a.mode = 'local' THEN '' ELSE coalesce(a.description, '') END AS text,
                            array_to_string(a.dominant_color_names, ' ') AS colours
                       FROM ai_analyses a WHERE a.photo_version_id = v.id ORDER BY a.created_at DESC LIMIT 1) an ON true
  WHERE p.user_id = p_user AND p.deleted_at IS NULL AND (p_photos IS NULL OR p.id = ANY (p_photos))
  ON CONFLICT (photo_id) DO UPDATE SET doc = excluded.doc, updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION refresh_search(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_search(uuid, uuid[]) TO pv_app, pv_service;

-- The local visual-embedding model: 256 dimensions (8×8×3 layout + 4×4×4 colour histogram), cosine distance.
CREATE INDEX photo_embeddings_local_hnsw ON photo_embeddings USING hnsw ((embedding::halfvec(256)) halfvec_cosine_ops) WHERE model = 'local-visual-v1' AND kind = 'image';
-- colour filter on the analyses
CREATE INDEX ai_analyses_colours_idx ON ai_analyses USING gin (dominant_color_names);

-- What was searched, newest first (you can clear it).
CREATE TABLE search_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  q text NOT NULL CHECK (char_length(q) BETWEEN 1 AND 300),
  parsed jsonb,
  result_count integer,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_history_user_idx ON search_history (user_id, at DESC);
SELECT secure_user_table('search_history', 'SELECT, INSERT, DELETE');

-- Down Migration
DROP TABLE search_history;
DROP INDEX ai_analyses_colours_idx;
DROP INDEX photo_embeddings_local_hnsw;
DROP FUNCTION refresh_search(uuid, uuid[]);
DROP TABLE search_documents;
