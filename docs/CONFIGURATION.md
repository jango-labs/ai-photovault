# Configuration

All settings are environment variables (the Docker install reads them from `.env`). Secrets can alternatively be supplied as files: for any secret `PHOTOVAULT_NAME` you may set `PHOTOVAULT_NAME_FILE=/run/secrets/name` (Docker/Kubernetes secrets). `npm run setup:env` generates every secret for you.

## Where things are

| Variable | Default | Meaning |
|---|---|---|
| `PHOTOVAULT_PHOTOS_DIR` | `./photos` | Docker only: host folder mounted **read-only** at `/photos`. |
| `PHOTOVAULT_INGEST_DIR` | `/photos` (Docker) | The folder the app imports from (native installs set this directly). It must also be approved: see [SECURITY.md](../SECURITY.md#import-approval). |
| `PHOTOVAULT_INGEST_NAME` | `My photos` | Label shown in the app. |
| `PHOTOVAULT_SCAN_INTERVAL_MIN` | `360` | Worker rescan interval. `0` = never, minimum 15. |
| `PHOTOVAULT_STATE_DIR` | OS app-data folder | Import approvals. |
| `PHOTOVAULT_DATA_ROOT` | `<state>/data` | Previews, thumbnails, derived files (all rebuildable). |
| `PHOTOVAULT_PORT` | `8480` | Docker host port (loopback). Native: `PHOTOVAULT_API_PORT`. |

## Network

| Variable | Default | Meaning |
|---|---|---|
| `PHOTOVAULT_HOST` | `127.0.0.1` | Bind address. Non-loopback is **refused** unless running in the container (`PHOTOVAULT_IN_CONTAINER=1`, where Docker publishes the port on `127.0.0.1` only). |
| `PHOTOVAULT_ALLOWED_HOSTS` | loopback names | Extra `Host` header names the app will answer to (comma-separated). Any other Host gets HTTP 421 (DNS-rebinding protection). Needed only if you put a reverse proxy in front. |
| `PHOTOVAULT_COOKIE_SECURE` | auto | Set `1` when serving through HTTPS. |

To reach PhotoVault from another device, put your own HTTPS reverse proxy or VPN in front and read [SECURITY.md](../SECURITY.md) first. Do not simply publish the port.

## Database and secrets

`PHOTOVAULT_DB` (default `photovault`; must match `photovault[a-z0-9_]*`), `PHOTOVAULT_PGHOST`, `PHOTOVAULT_PGPORT`, and one password per role: `PHOTOVAULT_DB_OWNER_PASSWORD`, `_APP_`, `_SERVICE_`, `_DELIVERY_`, `_BACKUP_`. The web app connects as the restricted `app` role under row-level security; migrations use `owner`; backups use the read-only `backup` role. `PHOTOVAULT_SESSION_SECRET` and `PHOTOVAULT_TOKEN_ENC_KEY` are 64 hex characters (32 bytes). Changing the token key makes stored integration tokens unreadable.

## AI (all optional)

| Variable | Default | Meaning |
|---|---|---|
| `PHOTOVAULT_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama. Photographs are sent here only. |
| `PHOTOVAULT_OLLAMA_ALLOWED_HOSTS` | *(empty)* | Extra hosts you explicitly trust for Ollama (e.g. `ollama` in Docker, or a GPU machine on your LAN). Anything not loopback and not listed is refused, as is `https`/credentials in the URL. |
| `PHOTOVAULT_OLLAMA_VISION_MODEL` | `gemma3:4b` | Describes photographs. Any Ollama vision model works. |
| `PHOTOVAULT_OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Text embeddings for meaning-based search (768 dimensions). |
| `PHOTOVAULT_GEOCODER` | `off` | `on` sends **typed place text** (never photos or coordinates of your library) to OpenStreetMap Nominatim, rate-limited and cached. |
| `PHOTOVAULT_DEMO_MODE` | `0` | `1` uses synthetic media and mock AI (for demos and tests). |

No telemetry or analytics exist in the code.

## Optional storage guard

If your photo library or data folder lives on an external drive, set `PHOTOVAULT_STORAGE_MOUNT` (mount folder) and `PHOTOVAULT_STORAGE_ID` (any 8–64 character id), run `npm run storage:init` once, and the app will refuse to write previews anywhere if the drive is missing (instead of silently filling your internal disk). `PHOTOVAULT_STORAGE_REQUIRE_SEPARATE_DEVICE=1` additionally insists the mount is a different device from `/`.

## Instagram (optional, off by default)

Requires your own Meta developer app: `PHOTOVAULT_IG_APP_ID`, `PHOTOVAULT_IG_APP_SECRET`, `PHOTOVAULT_IG_REDIRECT_URI` (your own HTTPS address). In this release it reads history only; publishing is a mock.
