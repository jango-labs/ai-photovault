-- Up Migration
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,                       -- argon2id
  totp_secret_ciphertext bytea,
  totp_enabled boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'UTC' CHECK (is_valid_timezone(timezone)),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT totp_needs_secret CHECK (NOT totp_enabled OR totp_secret_ciphertext IS NOT NULL)
);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip inet,
  user_agent text,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  scope text[] NOT NULL DEFAULT '{}' CHECK (scope <@ ARRAY['ingest','read'] ),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (user_id, name),
  UNIQUE (user_id, id)
);

CREATE TABLE login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  ip inet,
  at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL
);
CREATE INDEX login_attempts_user_idx ON login_attempts (user_id, at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, at DESC);

-- The only library root kind is FINAL. There is deliberately no RAW kind and the root is always read-only.
CREATE TABLE library_roots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'FINAL' CHECK (kind = 'FINAL'),
  path text NOT NULL CHECK (path LIKE '/%' AND path <> '/'),
  volume_uuid text,
  read_only boolean NOT NULL DEFAULT true CHECK (read_only),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, path),
  UNIQUE (user_id, id)
);

-- Auth is the one place that must work before a user is known. These SECURITY DEFINER functions are the
-- only pre-authentication access path (tables below are not FORCE-RLS'd for the owner, see 0009).
CREATE FUNCTION auth_find_user(p_email citext)
RETURNS TABLE (id uuid, password_hash text, totp_secret_ciphertext bytea, totp_enabled boolean, disabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT u.id, u.password_hash, u.totp_secret_ciphertext, u.totp_enabled, u.disabled_at IS NOT NULL
   FROM users u WHERE u.email = p_email $$;

CREATE FUNCTION auth_resolve_session(p_token_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$ DECLARE v uuid;
BEGIN
  UPDATE sessions s SET last_seen_at = now()
   FROM users u
   WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
     AND u.id = s.user_id AND u.disabled_at IS NULL
   RETURNING s.user_id INTO v;
  RETURN v;
END $$;

CREATE FUNCTION auth_resolve_device(p_token_hash bytea)
RETURNS TABLE (user_id uuid, scope text[])
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS
$$ UPDATE device_tokens d SET last_seen_at = now()
   FROM users u
   WHERE d.token_hash = p_token_hash AND d.revoked_at IS NULL AND u.id = d.user_id AND u.disabled_at IS NULL
   RETURNING d.user_id, d.scope $$;

CREATE FUNCTION auth_record_login(p_user uuid, p_ip inet, p_ok boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS
$$ INSERT INTO login_attempts (user_id, ip, ok) VALUES (p_user, p_ip, p_ok) $$;

CREATE FUNCTION auth_recent_failures(p_user uuid, p_ip inet, p_window interval) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT count(*)::int FROM login_attempts
   WHERE NOT ok AND at > now() - p_window AND (user_id = p_user OR ip = p_ip) $$;

CREATE FUNCTION auth_create_session(p_user uuid, p_token_hash bytea, p_ttl interval, p_ip inet, p_ua text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS
$$ INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
   SELECT p_user, p_token_hash, now() + p_ttl, p_ip, p_ua FROM users WHERE id = p_user AND disabled_at IS NULL
   RETURNING id $$;

REVOKE ALL ON FUNCTION auth_find_user(citext), auth_resolve_session(bytea), auth_resolve_device(bytea),
  auth_record_login(uuid, inet, boolean), auth_recent_failures(uuid, inet, interval),
  auth_create_session(uuid, bytea, interval, inet, text) FROM PUBLIC;

-- Down Migration
DROP FUNCTION auth_create_session(uuid, bytea, interval, inet, text);
DROP FUNCTION auth_recent_failures(uuid, inet, interval);
DROP FUNCTION auth_record_login(uuid, inet, boolean);
DROP FUNCTION auth_resolve_device(bytea);
DROP FUNCTION auth_resolve_session(bytea);
DROP FUNCTION auth_find_user(citext);
DROP TABLE library_roots;
DROP TABLE login_attempts;
DROP TABLE device_tokens;
DROP TABLE sessions;
DROP TABLE users;
