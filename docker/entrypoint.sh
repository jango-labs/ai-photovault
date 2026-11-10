#!/bin/sh
# Container entrypoint: `api` (default) migrates the database and serves the web app; `worker` runs background jobs.
set -eu
cd /opt/photovault
node_cli() { exec node "app/server/dist/$1" "$@"; }

# Importing is opt-in per folder. The folder you mounted at /photos (read-only) is the one you chose to import, so it is approved here.
if [ -d /photos ] && [ "${PHOTOVAULT_APPROVE_MOUNTED_PHOTOS:-1}" = "1" ]; then
  node app/server/dist/cli/ingest.js approve --path /photos --modes dry-run,apply --note "mounted by docker-compose (read-only)" >/dev/null
fi

case "${1:-api}" in
  api)
    node app/server/dist/db/migrate.js up
    exec node app/server/dist/main.js ;;
  worker)
    exec node app/server/dist/cli/worker.js ;;
  *)
    exec "$@" ;;
esac
