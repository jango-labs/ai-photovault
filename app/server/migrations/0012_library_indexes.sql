-- Up Migration
-- Phase 5 (Library): keyset-pagination sort indexes. Every Library list query is
--   photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE <user, not deleted, not hidden, filters> ORDER BY <key>, p.id LIMIT n
-- so each sort key gets an index ending in id (the tie-breaker) restricted to the rows the Library shows.
CREATE INDEX photos_lib_captured_idx ON photos (user_id, capture_at DESC NULLS LAST, id DESC) WHERE deleted_at IS NULL AND NOT hidden;
CREATE INDEX photos_lib_modified_idx ON photos (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL AND NOT hidden;
CREATE INDEX photos_lib_rating_idx   ON photos (user_id, rating DESC, id DESC) WHERE deleted_at IS NULL AND NOT hidden;
-- "date imported" lives on the version
CREATE INDEX photo_versions_lib_ingested_idx ON photo_versions (user_id, ingested_at DESC, id DESC);
-- the Library filters and facets on these version columns
CREATE INDEX photo_versions_lib_lens_idx ON photo_versions (user_id, lens) WHERE lens IS NOT NULL;
CREATE INDEX photo_versions_lib_camera_idx ON photo_versions (user_id, camera_model) WHERE camera_model IS NOT NULL;
-- "AI processing status": jobs are looked up by the photo they concern
CREATE INDEX jobs_ai_photo_idx ON jobs (user_id, ((payload ->> 'photoId'))) WHERE kind = 'ai.analyze';

-- Down Migration
DROP INDEX jobs_ai_photo_idx;
DROP INDEX photo_versions_lib_camera_idx;
DROP INDEX photo_versions_lib_lens_idx;
DROP INDEX photo_versions_lib_ingested_idx;
DROP INDEX photos_lib_rating_idx;
DROP INDEX photos_lib_modified_idx;
DROP INDEX photos_lib_captured_idx;
