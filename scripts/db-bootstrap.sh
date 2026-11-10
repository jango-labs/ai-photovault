#!/usr/bin/env bash
# Creates the PhotoVault roles, database and extensions on a PostgreSQL server you already run (native, non-Docker install).
# Needs a superuser connection (PGHOST/PGPORT/PGUSER/PGPASSWORD as usual) and the passwords from your .env.
#   set -a; . ./.env; set +a; PGUSER=postgres ./scripts/db-bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PHOTOVAULT_DB:=photovault}"
for v in PHOTOVAULT_DB_OWNER_PASSWORD PHOTOVAULT_DB_APP_PASSWORD PHOTOVAULT_DB_SERVICE_PASSWORD PHOTOVAULT_DB_DELIVERY_PASSWORD PHOTOVAULT_DB_BACKUP_PASSWORD; do
  [ -n "${!v:-}" ] || { echo "error: $v is not set (run: npm run setup:env, then load .env)" >&2; exit 1; }
done
[[ "$PHOTOVAULT_DB" =~ ^photovault[a-z0-9_]*$ ]] || { echo "error: PHOTOVAULT_DB must match ^photovault[a-z0-9_]*$" >&2; exit 1; }
psql -X -q -d postgres -v ON_ERROR_STOP=1 -v dbname="$PHOTOVAULT_DB" \
  -v owner_pw="$PHOTOVAULT_DB_OWNER_PASSWORD" -v app_pw="$PHOTOVAULT_DB_APP_PASSWORD" -v service_pw="$PHOTOVAULT_DB_SERVICE_PASSWORD" \
  -v delivery_pw="$PHOTOVAULT_DB_DELIVERY_PASSWORD" -v backup_pw="$PHOTOVAULT_DB_BACKUP_PASSWORD" -f db/bootstrap.sql
echo "database $PHOTOVAULT_DB ready"
