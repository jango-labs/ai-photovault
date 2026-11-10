-- Up Migration
-- Release 6: meaning-based search over the descriptions written by the local vision model. Text embeddings (nomic-embed-text, 768 numbers) live in
-- photo_embeddings with kind 'text'; one partial HNSW index serves that model. Nothing else changes: rows only exist for photographs a person had
-- analysed with the local vision model, and the search says how many photographs it covers.
CREATE INDEX photo_embeddings_ollama_nomic_hnsw ON photo_embeddings USING hnsw ((embedding::halfvec(768)) halfvec_cosine_ops) WHERE model = 'ollama:nomic-embed-text' AND kind = 'text';

-- Down Migration
DROP INDEX IF EXISTS photo_embeddings_ollama_nomic_hnsw;
