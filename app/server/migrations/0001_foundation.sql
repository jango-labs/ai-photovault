-- Up Migration
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS citext;

-- Provenance of a metadata value (never present AI/folder values as camera facts).
CREATE DOMAIN meta_source AS text
  CHECK (VALUE IN ('FOLDER_DERIVED','EXIF','IPTC','USER_DEFINED','AI_INFERRED'));

-- Current user for row-level security. Set per transaction by the API: SET LOCAL app.user_id = '<uuid>'.
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Append-only guard. UPDATEs and direct DELETEs are refused; a DELETE that arrives through a foreign-key cascade
-- (trigger depth > 1, i.e. removing a whole user) is allowed so that an account can still be erased.
CREATE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

-- 64-bit perceptual-hash Hamming distance (hashes stored as signed bigint).
CREATE FUNCTION hamming64(a bigint, b bigint) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
$$ SELECT bit_count((a # b)::bit(64))::int $$;

CREATE FUNCTION is_valid_timezone(tz text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = tz) $$;

-- Down Migration
DROP FUNCTION is_valid_timezone(text);
DROP FUNCTION hamming64(bigint, bigint);
DROP FUNCTION forbid_modification();
DROP FUNCTION set_updated_at();
DROP FUNCTION app_user_id();
DROP DOMAIN meta_source;
-- extensions are left installed (cluster-level, created by bootstrap)
