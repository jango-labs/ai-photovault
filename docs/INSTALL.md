# Installation

AI PhotoVault runs entirely on your own computer. Pick **Docker** (easiest, same on every OS) or **native** (no Docker; you provide PostgreSQL).

> **Verification status.** Native install on macOS is verified end to end by `scripts/e2e-native.sh`. The Docker Compose stack, Windows and Linux instructions below have **not been tested on real machines yet**; they follow the same scripts and are covered by CI where noted. If something fails, please open an issue with the output of `docker compose logs`.

## What you need

| | Docker install | Native install |
|---|---|---|
| Software | Docker Desktop (Win/macOS) or Docker Engine + Compose v2 (Linux) | Node.js 24+, PostgreSQL 17 with the **pgvector** extension, `psql` on your PATH |
| Memory/disk | 2 GB RAM free; disk for previews (roughly 5–10% of your photo folder size) | same |
| Optional AI | Ollama (container profile provided) | Ollama installed on the same computer |

Your photographs are mounted **read-only**. PhotoVault never writes to, renames or deletes originals.

## 1. Get the code

```bash
git clone https://github.com/junwalla73/ai-photovault.git
cd ai-photovault
```

## 2. Create your configuration

This writes `.env` with random database passwords and secrets. It never overwrites an existing `.env` and never prints secrets.

| OS | Command |
|---|---|
| Any, with Node 24+ | `npm run setup:env -- --photos "/path/to/your/exports"` |
| macOS / Linux, no Node | `./scripts/setup-env.sh` (needs `openssl`), then edit `PHOTOVAULT_PHOTOS_DIR` in `.env` |
| Windows PowerShell | `powershell -ExecutionPolicy Bypass -File scripts\setup-env.ps1 -Photos "C:\Users\you\Pictures\Exports"` |

On Windows use forward slashes in `.env` (`C:/Users/you/Pictures/Exports`). Share the drive with Docker Desktop (Settings → Resources → File sharing) if it is not on `C:`.

## 3a. Docker install

```bash
docker compose up -d --build
docker compose ps                       # db, app, worker should be running (bootstrap exits after it finishes)
docker compose exec app node app/server/dist/cli/user.js create --email you@example.com
```

You are prompted for a password (12+ characters; not echoed). Open <http://127.0.0.1:8480>, sign in, and scan the QR code with an authenticator app. Save the recovery codes shown once.

The folder you mounted at `/photos` is approved for import automatically. Start your first import from the **Imports** page (`/imports`: “Dry run” previews, “Import” applies); the worker then keeps rescanning every `PHOTOVAULT_SCAN_INTERVAL_MIN` minutes (default 360, `0` = never).

### Try it with sample data

```bash
docker compose exec app node app/server/dist/cli/seed-demo.js --email you@example.com
```

This generates 36 synthetic pictures inside the container's data volume, imports them through the real pipeline, and adds short descriptions so search works without any AI service.

## 3b. Native install (no Docker)

1. Install PostgreSQL 17 and pgvector (macOS: `brew install postgresql@17 pgvector`; Debian/Ubuntu: `apt install postgresql-17 postgresql-17-pgvector`; Windows: the EnterpriseDB installer plus a pgvector build).
2. Run `npm ci && npm run build`.
3. Load `.env` into your shell, then create the database and its five least-privilege roles, migrate, and create your account:

```bash
set -a; . ./.env; set +a                     # PowerShell: see the note below
PGUSER=postgres ./scripts/db-bootstrap.sh    # creates database + roles (needs a PostgreSQL superuser)
npm run db:migrate
npm run user -- create --email you@example.com
PHOTOVAULT_STATE_DIR=./state PHOTOVAULT_DATA_ROOT=./data PHOTOVAULT_INGEST_DIR="/path/to/your/exports" \
  npm run ingest:approve -- --path "/path/to/your/exports" --modes dry-run,apply
npm start                                    # http://127.0.0.1:8480  (and `npm run worker` in a second terminal)
```

PowerShell users: set each variable from `.env` with `$env:NAME="value"` (or run the Docker install, which is simpler on Windows).

`scripts/e2e-native.sh` runs this whole flow against a throw-away database and is the reference for what a correct native install does.

## Optional: local AI with Ollama

*Docker:* `docker compose --profile ollama up -d`, then pull models:

```bash
docker compose exec ollama ollama pull gemma3:4b
docker compose exec ollama ollama pull nomic-embed-text
```

*Native:* install Ollama from <https://ollama.com>, pull the same models, and set `PHOTOVAULT_OLLAMA_URL=http://127.0.0.1:11434`.

Without Ollama, importing, measured analysis, full-text search, find-similar and the Curator all still work.

## Verify the install

```bash
PHOTOVAULT_VALIDATE_EMAIL=you@example.com PHOTOVAULT_VALIDATE_PASSWORD='your password' \
  node scripts/validate-install.mjs --url http://127.0.0.1:8480
```

It checks sign-in, loopback binding, the DNS-rebinding guard, anonymous-access refusal, gallery, search, Curator and the map endpoint. (It enrols an authenticator on first use; do not run it against an account whose authenticator you already set up unless you reset it, or use a separate test account.)

## Backup and restore

```bash
./scripts/backup.sh ./backups                       # Docker: dumps the database (custom format, listed back to verify, chmod 600)
./scripts/restore.sh backups/photovault-XXXX.dump   # restores into a NEW scratch database for inspection
docker compose stop app worker
./scripts/restore.sh backups/photovault-XXXX.dump --replace   # replaces the live database (asks you to type its name)
docker compose start app worker
```

Native: `PHOTOVAULT_BACKUP_MODE=native` plus the usual `PGHOST`/`PGPORT`. The dump holds password hashes and encrypted authenticator secrets: store it like a password file. **Your originals are not in the backup** (back them up yourself). Previews are rebuilt automatically.

## Upgrade

```bash
./scripts/backup.sh ./backups        # always first
git pull
docker compose up -d --build         # migrations run automatically when the app starts
```

Native: `git pull && npm ci && npm run build && npm run db:migrate`, then restart. Read [CHANGELOG.md](../CHANGELOG.md) first.

## Uninstall

```bash
docker compose down            # stops everything, KEEPS your data volumes
docker compose down -v         # also DELETES the database, previews and approvals (cannot be undone)
```

Your photographs are never touched. Delete the project folder (and `.env`, which holds your secrets) to finish.

## Troubleshooting

| Symptom | Fix |
|---|---|
| “run the setup script to create .env” | Step 2. |
| Port 8480 in use | Set `PHOTOVAULT_PORT` in `.env`, then `docker compose up -d`. |
| Locked out of two-factor | `docker compose exec app node app/server/dist/cli/user.js reset-mfa --email you@example.com` |
| Import finds nothing | Only `.jpg`/`.jpeg` files up to 8 folders deep are read; check `PHOTOVAULT_PHOTOS_DIR` and that the folder is shared with Docker. |
| Semantic search says “not available” | Ollama is not running or the models are not pulled (see above). Full-text search still works. |
| Browser shows “421 Misdirected” | You opened it by a hostname other than `127.0.0.1`/`localhost`; see `PHOTOVAULT_ALLOWED_HOSTS` in [CONFIGURATION.md](CONFIGURATION.md). |
