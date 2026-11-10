#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh into a database. SAFE BY DEFAULT: restores into a NEW scratch database so you can inspect it;
# pass --replace to overwrite the live database (stop the app and worker first: docker compose stop app worker).
#   ./scripts/restore.sh backups/photovault-XXXX.dump                 -> restores into database photovault_restore_check
#   ./scripts/restore.sh backups/photovault-XXXX.dump --replace       -> replaces the live database (asks you to type the name)
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?usage: restore.sh <dump> [--replace]}"; [ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }
if [ -f "$FILE.sha256" ]; then ( cd "$(dirname "$FILE")" && { shasum -a 256 -c "$(basename "$FILE").sha256" 2>/dev/null || sha256sum -c "$(basename "$FILE").sha256"; } ) || { echo "checksum mismatch: refusing" >&2; exit 1; }; fi
LIVE="${PHOTOVAULT_DB:-photovault}"; TARGET="${LIVE}_restore_check"
if [ "${2:-}" = "--replace" ]; then
  read -r -p "This DELETES the current database '$LIVE' and replaces it with the backup. Type the database name to continue: " ans
  [ "$ans" = "$LIVE" ] || { echo "aborted"; exit 1; }
  TARGET="$LIVE"
fi
run_sql() { if [ "${PHOTOVAULT_BACKUP_MODE:-docker}" = "native" ]; then psql -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -U "${PGUSER:-postgres}" -d postgres -v ON_ERROR_STOP=1 -X -q "$@"; else docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q "$@"; fi; }
# extensions are created by the bootstrap, not restored: drop their entries from the restore list (they cannot be re-owned)
RESTORE_SNIPPET='f=$(mktemp); l=$(mktemp); cat > "$f"; pg_restore -l "$f" | grep -v " EXTENSION " > "$l"; pg_restore -d "$1" --no-owner --role=pv_owner --exit-on-error -L "$l" "$f"; rm -f "$f" "$l"'
run_restore() { if [ "${PHOTOVAULT_BACKUP_MODE:-docker}" = "native" ]; then PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" sh -c "$RESTORE_SNIPPET" sh "$TARGET" < "$FILE"; else docker compose exec -T db sh -c "$RESTORE_SNIPPET" sh "$TARGET" < "$FILE"; fi; }
run_sql -c "DROP DATABASE IF EXISTS \"$TARGET\"" -c "CREATE DATABASE \"$TARGET\" OWNER pv_owner TEMPLATE template0 ENCODING 'UTF8'"
run_sql -d "$TARGET" -c "CREATE EXTENSION IF NOT EXISTS vector" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" -c "CREATE EXTENSION IF NOT EXISTS unaccent" -c "CREATE EXTENSION IF NOT EXISTS btree_gin" -c "CREATE EXTENSION IF NOT EXISTS citext"
run_restore
echo "restored into database '$TARGET'. $( [ "$TARGET" = "$LIVE" ] && echo 'Start the app again: docker compose up -d' || echo 'Inspect it, then drop it: psql ... -c "DROP DATABASE '"$TARGET"'"' )"
