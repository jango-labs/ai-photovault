#!/usr/bin/env bash
# End-to-end clean-install test WITHOUT Docker, against a PostgreSQL (with pgvector) you provide. Used by CI and for local verification.
# It uses a throw-away database name, a temp folder, random secrets and its own port; it never touches any other database or service.
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=... ./scripts/e2e-native.sh
set -euo pipefail
cd "$(dirname "$0")/.."
WORK="$(mktemp -d)"; PORT="${PV_E2E_PORT:-18490}"; export PHOTOVAULT_DB="${PV_E2E_DB:-photovault_e2e}"
rnd() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
export PHOTOVAULT_PGHOST="${PGHOST:-127.0.0.1}" PHOTOVAULT_PGPORT="${PGPORT:-5432}"
export PHOTOVAULT_DB_OWNER_PASSWORD="$(rnd 12)" PHOTOVAULT_DB_APP_PASSWORD="$(rnd 12)" PHOTOVAULT_DB_SERVICE_PASSWORD="$(rnd 12)" PHOTOVAULT_DB_DELIVERY_PASSWORD="$(rnd 12)" PHOTOVAULT_DB_BACKUP_PASSWORD="$(rnd 12)"
export PHOTOVAULT_SESSION_SECRET="$(rnd 32)" PHOTOVAULT_TOKEN_ENC_KEY="$(rnd 32)"
export PHOTOVAULT_STATE_DIR="$WORK/state" PHOTOVAULT_DATA_ROOT="$WORK/data" PHOTOVAULT_API_PORT="$PORT" PHOTOVAULT_DEMO_MODE=0
export PHOTOVAULT_OLLAMA_URL="http://127.0.0.1:1"   # nothing listens here: proves the demo works without any AI service
EMAIL="e2e@example.test"; PW="$(rnd 10)-Aa1"; export E2E_PW="$PW"
PID=""
cleanup() { [ -z "$PID" ] || kill "$PID" 2>/dev/null || true; psql -X -q -d postgres -c "DROP DATABASE IF EXISTS \"$PHOTOVAULT_DB\"" -c "DROP DATABASE IF EXISTS \"${PHOTOVAULT_DB}_restore_check\"" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
start_server() { node app/server/dist/main.js > "$WORK/api.log" 2>&1 & PID=$!; for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "server did not start"; tail -20 "$WORK/api.log"; return 1; }
stop_server() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""; }
validate() { PHOTOVAULT_VALIDATE_EMAIL="$EMAIL" PHOTOVAULT_VALIDATE_PASSWORD="$PW" node scripts/validate-install.mjs --url "http://127.0.0.1:$PORT" --expect-photos 36; }

step "build";               [ -f app/server/dist/main.js ] && [ -f app/web/dist/index.html ] || npm run build >/dev/null
step "database bootstrap";  ./scripts/db-bootstrap.sh
step "migrations";          node app/server/dist/db/migrate.js up
step "create account";      PHOTOVAULT_USER_PASSWORD="$PW" node app/server/dist/cli/user.js create --email "$EMAIL" --password-env PHOTOVAULT_USER_PASSWORD
step "import demo library, previews, analysis (no AI service running)"
node --import tsx app/server/src/cli/seed-demo.ts --email "$EMAIL" 2>&1 | tail -8
step "start server (first run)"; start_server
step "validate (first run)";  validate
step "restart: data must persist"; stop_server; start_server
node app/server/dist/cli/user.js reset-mfa --email "$EMAIL" >/dev/null
step "validate (after restart)"; validate
step "backup (native mode)"
BK="$WORK/backups"; PHOTOVAULT_BACKUP_MODE=native PGHOST="$PHOTOVAULT_PGHOST" PGPORT="$PHOTOVAULT_PGPORT" ./scripts/backup.sh "$BK"
step "restore into a scratch database and compare"
PHOTOVAULT_BACKUP_MODE=native ./scripts/restore.sh "$(ls "$BK"/*.dump | head -1)"
A="$(psql -X -At -d "$PHOTOVAULT_DB" -c 'SELECT count(*) FROM photos')"; B="$(psql -X -At -d "${PHOTOVAULT_DB}_restore_check" -c 'SELECT count(*) FROM photos')"
echo "photos live=$A restored=$B"; [ "$A" = "$B" ] && [ "$A" = "36" ] || { echo "RESTORE MISMATCH"; exit 1; }
echo; echo "E2E PASSED"
