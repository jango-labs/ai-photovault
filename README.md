# AI PhotoVault

An open-source, **private, self-hosted** photography library with semantic image search, intelligent curation and photographer-focused workflows. It runs on your own computer, reads your exported photographs **read-only**, and keeps everything (including any AI processing) local unless you explicitly decide otherwise.

> Status: **1.0.0 release candidate 2.** Verified on macOS (native PostgreSQL) and, in GitHub Actions on Ubuntu, the Docker Compose stack and the native install. Windows is written and reviewed but **not yet verified** on a real machine (see [Known limitations](#known-limitations)).

## What it does

| Area | What you get |
|---|---|
| **Library** | Fast gallery over a folder of exported JPEG images (up to 8 folders deep); EXIF camera, lens, focal length, aperture, ISO, shutter, capture date and GPS; filters by year, month, folder, camera and lens; photo detail view with metadata. |
| **Find anything** | Natural-language search (“mountain mist”, “calm blue evening”) that fuses full-text and meaning-based search; **find similar** from any photograph using a measured 256-dimension visual fingerprint. |
| **AI Curator** | Picks a ranked selection for a purpose (portfolio, social, print…) with plain-language reasons, series suppression (no five near-identical frames) and quality scoring from measured sharpness, exposure and colour. |
| **Duplicates & versions** | Exact duplicates by SHA-256, near-duplicates by perceptual fingerprint, and a review queue for versions of the same shot. |
| **Map & collections** | Offline world map of geotagged photographs (no tile server), curated collections. |
| **Local AI (optional)** | Image descriptions and meaning-based search through [Ollama](https://ollama.com) running on **your** machine. Without it the app still works: measured analysis, full-text search and visual similarity need no AI service. |
| **Privacy by construction** | Originals are never modified. A folder is read only after you approve it. The web app listens on `127.0.0.1` only. Mandatory two-factor sign-in. No telemetry. Place-name lookup, hosted AI and Instagram are **off** unless you configure them. |

## Quick start (Docker — recommended)

Requires Docker Desktop (Windows/macOS) or Docker Engine + Compose (Linux), and [Node.js 24+](https://nodejs.org) only for the one-line setup script (or use the Node-free scripts in [docs/INSTALL.md](docs/INSTALL.md)).

```bash
git clone https://github.com/jango-labs/ai-photovault.git
cd ai-photovault
npm run setup:env                 # creates .env with random secrets; to choose your folder: npm run setup:env -- --photos "/path/to/your/exports"
docker compose up -d --build      # database + app + worker, bound to 127.0.0.1:8480
docker compose exec app node app/server/dist/cli/user.js create --email you@example.com
```

Open <http://127.0.0.1:8480>, sign in, and enrol an authenticator app when asked.

**Try it with sample data first** (36 generated pictures, no real photographs needed):

```bash
docker compose exec app node app/server/dist/cli/seed-demo.js --email you@example.com
```

Full instructions for Windows, macOS and Linux, native (no Docker) installs, backup/restore, upgrade and uninstall: **[docs/INSTALL.md](docs/INSTALL.md)**.

## Adding local AI (optional)

```bash
docker compose --profile ollama up -d
docker compose exec ollama ollama pull gemma3:4b          # image descriptions
docker compose exec ollama ollama pull nomic-embed-text   # meaning-based search
```

Photographs are only ever sent to Ollama on this computer or to a host you list in `PHOTOVAULT_OLLAMA_ALLOWED_HOSTS`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Documentation

- [Installation](docs/INSTALL.md) · [Configuration](docs/CONFIGURATION.md) · [Architecture](docs/ARCHITECTURE.md)
- [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Known limitations

- **Verified**: macOS with native PostgreSQL 17 + pgvector + Node 24 (full automated suite, end-to-end clean install, real Ollama embeddings); and on every push in GitHub Actions on Ubuntu: lint, typecheck, unit/web/database tests, the native clean install with backup and restore, and the Docker Compose stack (builds, becomes healthy, answers on `127.0.0.1` only, database not published).
- **Not yet verified**: Windows (setup script and Docker Desktop paths), Docker on macOS, and Ollama *vision* descriptions on a clean machine. Please report problems.
- **Hosted AI providers** (cloud vision APIs) have adapters in the source but are intentionally **not wired in**; nothing is sent to a cloud service.
- **Instagram**: history can be read if you configure your own Meta app; publishing is a **mock** in this build.
- **Two-factor sign-in is mandatory** (single-owner library; there is no public sign-up).
- AI description prompts are tuned for **landscape and wildlife photography**; other genres work but descriptions may be less precise.
- **JPEG only**: the importer reads `.jpg`/`.jpeg` exports. RAW, PNG, TIFF and HEIC files are skipped (and reported as skipped); export JPEGs first.

## Development

```bash
npm ci
npm run check          # lint + typecheck + unit/web tests
npm run test:db        # database tests; needs PostgreSQL + pgvector (see CONTRIBUTING.md)
```

## License

[MIT](LICENSE). Bundled third-party software is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The sample images are generated by this project's own script and are dedicated to the public domain (CC0).
