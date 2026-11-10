#!/usr/bin/env bash
# Database backup (custom-format pg_dump, verified by listing it back). Works with the Docker install (default) or a native PostgreSQL.
#   ./scripts/backup.sh [output-dir]                 Docker: dumps from the "db" container   (default dir: ./backups; run from the project folder)
#   PHOTOVAULT_BACKUP_MODE=native PGHOST=... PGPORT=... ./scripts/backup.sh   native: uses pg_dump with the backup role from your environment
# What is backed up: the database (metadata, analyses, embeddings, collections, settings, accounts). NOT your original photographs
# (PhotoVault never touches them; back them up yourself) and NOT the preview cache (it is rebuilt automatically).
# The dump contains your account password hashes and authenticator secrets (encrypted): store it like a password file.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-./backups}"; mkdir -p "$OUT"; chmod 700 "$OUT"
DB="${PHOTOVAULT_DB:-photovault}"; STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; FILE="$OUT/photovault-$STAMP.dump"
umask 077
if [ "${PHOTOVAULT_BACKUP_MODE:-docker}" = "native" ]; then
  : "${PHOTOVAULT_DB_BACKUP_PASSWORD:?load your .env first (set -a; . ./.env; set +a)}"
  PGPASSWORD="$PHOTOVAULT_DB_BACKUP_PASSWORD" pg_dump -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -U pv_backup -d "$DB" -Fc --no-owner --enable-row-security > "$FILE"
else
  docker compose exec -T db pg_dump -U postgres -d "$DB" -Fc --no-owner > "$FILE"
fi
# verify: the archive must list its table of contents and contain the core tables
if [ "${PHOTOVAULT_BACKUP_MODE:-docker}" = "native" ]; then LIST="$(pg_restore -l "$FILE")"; else LIST="$(docker compose exec -T db pg_restore -l < "$FILE")"; fi
grep -q "TABLE DATA public photos" <<<"$LIST" || { echo "backup verification FAILED: no photos table in $FILE" >&2; rm -f "$FILE"; exit 1; }
( cd "$OUT" && { shasum -a 256 "$(basename "$FILE")" 2>/dev/null || sha256sum "$(basename "$FILE")"; } > "$(basename "$FILE").sha256" )
echo "backup written and verified: $FILE ($(wc -c < "$FILE") bytes)"
