-- Up Migration
-- Release 10: a typed location ("Washington, DC") can be resolved to an APPROXIMATE position on the map, and a person can place or adjust a pin by hand — without
-- ever losing the coordinates the camera recorded.
--   * a new provenance value GEOCODED = "the centre of a named place, looked up in OpenStreetMap" (never an exact photograph position);
--   * photo_versions.gps_original_* keeps the camera/IPTC coordinates when something else (a pin, a lookup) replaces them for display, so they can be restored;
--   * photo_versions.gps_label = the place the lookup found, shown next to an approximate position;
--   * geocode_cache = lookups already made (per account), so the same text is never sent twice (OpenStreetMap's usage policy asks for caching).
ALTER DOMAIN meta_source DROP CONSTRAINT meta_source_check;
ALTER DOMAIN meta_source ADD CONSTRAINT meta_source_check CHECK (VALUE IN ('FOLDER_DERIVED','EXIF','IPTC','USER_DEFINED','AI_INFERRED','GEOCODED'));

ALTER TABLE photo_versions
  ADD COLUMN gps_original_lat double precision, ADD COLUMN gps_original_lon double precision, ADD COLUMN gps_original_source meta_source,
  ADD COLUMN gps_label text,
  ADD CONSTRAINT photo_versions_gps_original_ck CHECK ((gps_original_lat IS NULL) = (gps_original_lon IS NULL) AND (gps_original_lat IS NULL) = (gps_original_source IS NULL)),
  ADD CONSTRAINT photo_versions_gps_label_ck CHECK (gps_label IS NULL OR gps_source = 'GEOCODED');

CREATE TABLE geocode_cache (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query text NOT NULL CHECK (length(query) BETWEEN 1 AND 200),
  found boolean NOT NULL,
  candidates jsonb NOT NULL DEFAULT '[]',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, query)
);
SELECT secure_user_table('geocode_cache', 'SELECT, INSERT, UPDATE, DELETE');

-- Down Migration
DROP TABLE geocode_cache;
UPDATE photo_versions SET gps_lat = NULL, gps_lon = NULL, gps_source = NULL, gps_label = NULL WHERE gps_source = 'GEOCODED';
ALTER TABLE photo_versions DROP CONSTRAINT photo_versions_gps_label_ck, DROP CONSTRAINT photo_versions_gps_original_ck,
  DROP COLUMN gps_label, DROP COLUMN gps_original_source, DROP COLUMN gps_original_lon, DROP COLUMN gps_original_lat;
-- (photo_edits is append-only and keeps its text sources untouched)
ALTER DOMAIN meta_source DROP CONSTRAINT meta_source_check;
ALTER DOMAIN meta_source ADD CONSTRAINT meta_source_check CHECK (VALUE IN ('FOLDER_DERIVED','EXIF','IPTC','USER_DEFINED','AI_INFERRED'));
