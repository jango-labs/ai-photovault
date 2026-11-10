-- Up Migration
CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  country text,
  region text,
  centroid_lat double precision CHECK (centroid_lat BETWEEN -90 AND 90),
  centroid_lon double precision CHECK (centroid_lon BETWEEN -180 AND 180),
  source meta_source NOT NULL DEFAULT 'USER_DEFINED',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((centroid_lat IS NULL) = (centroid_lon IS NULL)),
  UNIQUE (user_id, id)
);
CREATE UNIQUE INDEX locations_name_uq ON locations (user_id, lower(name), coalesce(country, ''));

-- Photo = logical photographic asset. User-owned fields live here and are never written by AI.
CREATE TABLE photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_version_id uuid,
  title text,                    title_source meta_source,
  capture_at timestamptz,        capture_at_source meta_source,
  year integer CHECK (year BETWEEN 1826 AND 2200),   year_source meta_source,
  trip_location text,            trip_location_source meta_source,
  subpath text,
  location_id uuid,
  rating smallint NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  favorite boolean NOT NULL DEFAULT false,
  portfolio_candidate boolean NOT NULL DEFAULT false,
  hidden boolean NOT NULL DEFAULT false,
  notes text,
  identity_key text,             -- EXIF capture time + subsec + body serial (+ shutter count); NOT the filename
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,        -- soft delete; never deletes files in FINAL
  UNIQUE (user_id, id),
  CHECK (title IS NULL OR title_source IS NOT NULL),
  CHECK (capture_at IS NULL OR capture_at_source IS NOT NULL),
  CHECK (year IS NULL OR year_source IS NOT NULL),
  CHECK (trip_location IS NULL OR trip_location_source IS NOT NULL),
  FOREIGN KEY (user_id, location_id) REFERENCES locations (user_id, id) ON DELETE SET NULL (location_id)
);
CREATE TRIGGER photos_updated BEFORE UPDATE ON photos FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX photos_capture_idx ON photos (user_id, capture_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX photos_rating_idx ON photos (user_id, rating DESC) WHERE deleted_at IS NULL AND rating > 0;
CREATE INDEX photos_favorite_idx ON photos (user_id) WHERE favorite AND deleted_at IS NULL;
CREATE INDEX photos_portfolio_idx ON photos (user_id) WHERE portfolio_candidate AND deleted_at IS NULL;
CREATE INDEX photos_year_trip_idx ON photos (user_id, year, trip_location) WHERE deleted_at IS NULL;
CREATE INDEX photos_identity_idx ON photos (user_id, identity_key) WHERE identity_key IS NOT NULL;
CREATE INDEX photos_location_idx ON photos (user_id, location_id) WHERE location_id IS NOT NULL;
CREATE INDEX photos_title_trgm_idx ON photos USING gin (title gin_trgm_ops);

-- PhotoVersion = one rendered/exported JPEG. The original is referenced in place, never copied.
CREATE TABLE photo_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  library_root_id uuid NOT NULL,
  source_relpath text NOT NULL CHECK (source_relpath <> '' AND source_relpath NOT LIKE '/%' AND source_relpath NOT LIKE '%..%'),
  source_mtime timestamptz,
  source_present boolean NOT NULL DEFAULT true,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  phash bigint,
  dhash bigint,
  phash_s0 integer GENERATED ALWAYS AS (CASE WHEN phash IS NULL THEN NULL ELSE ((phash >> 48) & 65535)::int END) STORED,
  phash_s1 integer GENERATED ALWAYS AS (CASE WHEN phash IS NULL THEN NULL ELSE ((phash >> 32) & 65535)::int END) STORED,
  phash_s2 integer GENERATED ALWAYS AS (CASE WHEN phash IS NULL THEN NULL ELSE ((phash >> 16) & 65535)::int END) STORED,
  phash_s3 integer GENERATED ALWAYS AS (CASE WHEN phash IS NULL THEN NULL ELSE (phash & 65535)::int END) STORED,
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  bytes bigint CHECK (bytes > 0),
  mime text NOT NULL DEFAULT 'image/jpeg' CHECK (mime = 'image/jpeg'),
  deriv_status text NOT NULL DEFAULT 'PENDING' CHECK (deriv_status IN ('PENDING','READY','FAILED')),
  deriv_spec integer NOT NULL DEFAULT 1,
  exif jsonb,
  camera_make text, camera_model text, lens text,
  focal_length_mm real CHECK (focal_length_mm > 0),
  aperture real CHECK (aperture > 0),
  shutter_s real CHECK (shutter_s > 0),
  iso integer CHECK (iso > 0),
  copyright text, photographer text,
  keywords text[] NOT NULL DEFAULT '{}',
  gps_lat double precision CHECK (gps_lat BETWEEN -90 AND 90),
  gps_lon double precision CHECK (gps_lon BETWEEN -180 AND 180),
  gps_source meta_source,
  dominant_colors jsonb,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','ACTIVE','SUPERSEDED','PENDING_REVIEW')),
  exported_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (photo_id, id),
  UNIQUE (photo_id, version_no),
  UNIQUE (user_id, photo_id, content_sha256),
  CHECK ((gps_lat IS NULL) = (gps_lon IS NULL)),
  CHECK (gps_lat IS NULL OR gps_source IS NOT NULL),
  FOREIGN KEY (user_id, photo_id) REFERENCES photos (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, library_root_id) REFERENCES library_roots (user_id, id)
);
CREATE UNIQUE INDEX photo_versions_one_active_uq ON photo_versions (photo_id) WHERE state = 'ACTIVE';
CREATE INDEX photo_versions_sha_idx ON photo_versions (user_id, content_sha256);
CREATE INDEX photo_versions_path_idx ON photo_versions (user_id, library_root_id, source_relpath);
CREATE INDEX photo_versions_state_idx ON photo_versions (user_id, state) WHERE state <> 'ACTIVE';
CREATE INDEX photo_versions_deriv_idx ON photo_versions (user_id, deriv_status) WHERE deriv_status <> 'READY';
CREATE INDEX photo_versions_gps_idx ON photo_versions (gps_lat, gps_lon) WHERE gps_lat IS NOT NULL;
CREATE INDEX photo_versions_keywords_idx ON photo_versions USING gin (keywords);
-- multi-index hashing: any two hashes within Hamming distance <= 3 share at least one 16-bit segment
CREATE INDEX photo_versions_phash_s0_idx ON photo_versions (user_id, phash_s0) WHERE phash IS NOT NULL;
CREATE INDEX photo_versions_phash_s1_idx ON photo_versions (user_id, phash_s1) WHERE phash IS NOT NULL;
CREATE INDEX photo_versions_phash_s2_idx ON photo_versions (user_id, phash_s2) WHERE phash IS NOT NULL;
CREATE INDEX photo_versions_phash_s3_idx ON photo_versions (user_id, phash_s3) WHERE phash IS NOT NULL;

-- The displayed version must belong to the photo (composite FK, checked at commit so both rows can be created together).
ALTER TABLE photos ADD CONSTRAINT photos_current_version_fk
  FOREIGN KEY (id, current_version_id) REFERENCES photo_versions (photo_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX photos_current_version_idx ON photos (current_version_id) WHERE current_version_id IS NOT NULL;

-- Down Migration
ALTER TABLE photos DROP CONSTRAINT photos_current_version_fk;
DROP TABLE photo_versions;
DROP TABLE photos;
DROP TABLE locations;
