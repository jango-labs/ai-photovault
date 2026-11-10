-- AI PhotoVault database bootstrap. Idempotent. Run ONCE as a PostgreSQL superuser (the Docker image does this automatically;
-- natively, use scripts/db-bootstrap.sh). It creates the five least-privilege login roles, the database(s) and the extensions
-- (pgvector, pg_trgm, unaccent, btree_gin, citext). Application roles are never superusers and never bypass row-level security.
--
--   psql -v ON_ERROR_STOP=1 -v dbname=photovault -v owner_pw=... -v app_pw=... -v service_pw=... -v delivery_pw=... -v backup_pw=... -f db/bootstrap.sql
\set ON_ERROR_STOP on

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', r, pw)
  FROM (VALUES ('pv_owner', :'owner_pw'), ('pv_app', :'app_pw'), ('pv_service', :'service_pw'), ('pv_delivery', :'delivery_pw'), ('pv_backup', :'backup_pw')) v(r, pw)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

-- keep the passwords in step with the configuration (.env) on every run
SELECT format('ALTER ROLE %I PASSWORD %L', r, pw)
  FROM (VALUES ('pv_owner', :'owner_pw'), ('pv_app', :'app_pw'), ('pv_service', :'service_pw'), ('pv_delivery', :'delivery_pw'), ('pv_backup', :'backup_pw')) v(r, pw)
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

ALTER ROLE pv_app SET statement_timeout = '30s';
ALTER ROLE pv_delivery SET statement_timeout = '5s';
ALTER ROLE pv_backup SET default_transaction_read_only = on;

SELECT format('CREATE DATABASE %I OWNER pv_owner ENCODING ''UTF8'' TEMPLATE template0', :'dbname')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname') \gexec

REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO pv_owner, pv_app, pv_service, pv_delivery, pv_backup;

\connect :dbname
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS citext;
ALTER SCHEMA public OWNER TO pv_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
