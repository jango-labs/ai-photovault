-- Up Migration
-- Release 5: (D1) capture year/month separate from the folder year; (D4) capture instant + UTC offset in structured fields; (D3) IPTC/XMP place names;
-- Lightroom metadata (hierarchical keywords, colour label, GPS altitude); (D2) camera/lens/place/keyword text in the search document;
-- and a run kind for the originals backup.

-- ---- photos: capture instant, offset, local wall clock, derived capture year/month ------------------------------------------------------------
-- capture_at stays the INSTANT (what chronological sorting uses). When the file states a UTC offset, the importer stores wall clock minus offset
-- and the offset; otherwise capture_at is the wall clock read as UTC (as before) and the offset is NULL. capture_local is always the wall clock the
-- camera wrote (computed by the trigger below); the year and month filters read it, so a photograph taken at 23:30 on 31 December belongs to that year.
-- `year` keeps its meaning as the FOLDER year (it is never taken from the capture date any more).
ALTER TABLE photos
  ADD COLUMN capture_offset_min smallint CHECK (capture_offset_min BETWEEN -840 AND 899),
  ADD COLUMN capture_offset_source text CHECK (capture_offset_source IN ('EXIF','XMP','IPTC','USER_DEFINED')),
  ADD COLUMN place_city text, ADD COLUMN place_state text, ADD COLUMN place_country text, ADD COLUMN place_country_code text, ADD COLUMN place_sublocation text,
  ADD COLUMN place_source meta_source,
  ADD COLUMN color_label text;
-- generated (so existing rows are filled in by the table rewrite, with no data migration that row-level security would hide)
ALTER TABLE photos
  ADD COLUMN capture_local timestamp GENERATED ALWAYS AS ((capture_at AT TIME ZONE 'UTC') + make_interval(mins => coalesce(capture_offset_min, 0)::integer)) STORED,
  ADD COLUMN capture_year integer GENERATED ALWAYS AS (extract(year FROM (capture_at AT TIME ZONE 'UTC') + make_interval(mins => coalesce(capture_offset_min, 0)::integer))::integer) STORED,
  ADD COLUMN capture_month smallint GENERATED ALWAYS AS (extract(month FROM (capture_at AT TIME ZONE 'UTC') + make_interval(mins => coalesce(capture_offset_min, 0)::integer))::smallint) STORED;
CREATE INDEX photos_capture_year_idx ON photos (user_id, capture_year, capture_month) WHERE deleted_at IS NULL AND capture_year IS NOT NULL;
CREATE INDEX photos_place_idx ON photos (user_id, place_country, place_state, place_city) WHERE deleted_at IS NULL AND place_country IS NOT NULL;

-- the edit history remembers the offset that went with each capture time, so an undo restores the wall clock exactly
ALTER TABLE photo_edits ADD COLUMN old_offset_min smallint, ADD COLUMN new_offset_min smallint;

-- ---- versions: Lightroom keyword paths, GPS altitude -------------------------------------------------------------------------------------------
ALTER TABLE photo_versions ADD COLUMN keywords_hier text[] NOT NULL DEFAULT '{}', ADD COLUMN gps_altitude_m real;

-- ---- search document: camera, lens, place names, keyword paths, creator ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_search(p_user uuid, p_photos uuid[] DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS
$$ DECLARE n integer; BEGIN
  INSERT INTO search_documents (photo_id, user_id, doc)
  SELECT p.id, p.user_id,
    setweight(to_tsvector('english', coalesce(p.title, '') || ' ' || regexp_replace(regexp_replace(v.source_relpath, '^.*/', ''), '[_.-]+', ' ', 'g')), 'A')
    || setweight(to_tsvector('english', coalesce(p.trip_location, '') || ' ' || coalesce(sp.names, '')), 'B')
    || setweight(to_tsvector('simple', coalesce(p.place_city, '') || ' ' || coalesce(p.place_state, '') || ' ' || coalesce(p.place_country, '') || ' ' || coalesce(p.place_country_code, '') || ' ' || coalesce(p.place_sublocation, '')), 'B')
    || setweight(to_tsvector('simple', coalesce(v.camera_make, '') || ' ' || coalesce(v.camera_model, '') || ' ' || coalesce(v.lens, '')), 'B')
    || setweight(to_tsvector('english', coalesce(p.description, '') || ' ' || coalesce(an.text, '')), 'C')
    || setweight(to_tsvector('simple', array_to_string(v.keywords, ' ') || ' ' || replace(array_to_string(v.keywords_hier, ' '), '|', ' ') || ' ' || coalesce(v.photographer, '') || ' ' || coalesce(p.notes, '') || ' ' || coalesce(an.colours, '')), 'D')
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

DROP TRIGGER photos_search ON photos;
CREATE TRIGGER photos_search AFTER INSERT OR UPDATE OF title, description, notes, trip_location, current_version_id, place_city, place_state, place_country, place_country_code, place_sublocation ON photos FOR EACH ROW EXECUTE FUNCTION search_touch();
DROP TRIGGER photo_versions_search ON photo_versions;
CREATE TRIGGER photo_versions_search AFTER INSERT OR UPDATE OF keywords, keywords_hier, source_relpath, photo_id, camera_make, camera_model, lens, photographer ON photo_versions FOR EACH ROW EXECUTE FUNCTION search_touch();

-- ---- backup runs: the add-only copy of original photographs to an external backup location -----------------------------------------------------------------------
ALTER TABLE backup_runs DROP CONSTRAINT backup_runs_kind_check;
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_kind_check
  CHECK (kind IN ('DUMP','USERDATA_EXPORT','CONFIG','RESTORE_TEST','NAS_COPY','NAS_RESTORE_TEST','CONFIG_BUNDLE','ESCROW','ORIGINALS_COPY'));

-- Down Migration
DELETE FROM backup_runs WHERE kind = 'ORIGINALS_COPY';
ALTER TABLE backup_runs DROP CONSTRAINT backup_runs_kind_check;
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_kind_check
  CHECK (kind IN ('DUMP','USERDATA_EXPORT','CONFIG','RESTORE_TEST','NAS_COPY','NAS_RESTORE_TEST','CONFIG_BUNDLE','ESCROW'));

DROP TRIGGER photo_versions_search ON photo_versions;
CREATE TRIGGER photo_versions_search AFTER INSERT OR UPDATE OF keywords, source_relpath, photo_id ON photo_versions FOR EACH ROW EXECUTE FUNCTION search_touch();
DROP TRIGGER photos_search ON photos;
CREATE TRIGGER photos_search AFTER INSERT OR UPDATE OF title, description, notes, trip_location, current_version_id ON photos FOR EACH ROW EXECUTE FUNCTION search_touch();
CREATE OR REPLACE FUNCTION refresh_search(p_user uuid, p_photos uuid[] DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS
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
ALTER TABLE photo_versions DROP COLUMN keywords_hier, DROP COLUMN gps_altitude_m;
ALTER TABLE photo_edits DROP COLUMN IF EXISTS old_offset_min, DROP COLUMN IF EXISTS new_offset_min;
DROP INDEX IF EXISTS photos_place_idx; DROP INDEX IF EXISTS photos_capture_year_idx;
ALTER TABLE photos DROP COLUMN IF EXISTS capture_year, DROP COLUMN IF EXISTS capture_month;
ALTER TABLE photos DROP COLUMN color_label, DROP COLUMN place_source, DROP COLUMN place_sublocation, DROP COLUMN place_country_code, DROP COLUMN place_country, DROP COLUMN place_state, DROP COLUMN place_city,
  DROP COLUMN IF EXISTS capture_local, DROP COLUMN capture_offset_source, DROP COLUMN capture_offset_min;
