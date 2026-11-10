#!/bin/sh
# One-shot job: creates/updates the PhotoVault database roles, database and extensions (idempotent). Runs on every `docker compose up`.
set -eu
export PGHOST="${PGHOST:-db}" PGUSER="${POSTGRES_USER:-postgres}" PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set; run the setup script to create .env}"
until pg_isready -q; do sleep 1; done
psql -X -q -d postgres -v ON_ERROR_STOP=1 -v dbname="${PHOTOVAULT_DB:-photovault}" \
  -v owner_pw="$PHOTOVAULT_DB_OWNER_PASSWORD" -v app_pw="$PHOTOVAULT_DB_APP_PASSWORD" -v service_pw="$PHOTOVAULT_DB_SERVICE_PASSWORD" \
  -v delivery_pw="$PHOTOVAULT_DB_DELIVERY_PASSWORD" -v backup_pw="$PHOTOVAULT_DB_BACKUP_PASSWORD" -f /bootstrap/bootstrap.sql
echo "database ${PHOTOVAULT_DB:-photovault} ready"
