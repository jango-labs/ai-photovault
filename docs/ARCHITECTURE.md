# Architecture

```
 browser ──► Fastify API + React app (127.0.0.1:8480) ──► PostgreSQL 17 + pgvector
                         │                                   (5 roles, row-level security)
          worker process ┤ imports (read-only folder) · previews · analysis · embeddings
                         └──► Ollama on this computer (optional)
```

- **Monorepo** (npm workspaces): `app/shared` (ports, secrets, shared types), `app/server` (Fastify 5, jobs, CLI tools, SQL migrations), `app/web` (React + Vite, offline world map).
- **Ingest**: a folder walk (JPEG only, symlinks and traversal refused) → SHA-256 + EXIF read → photo/version records → derive previews and a 256-dimension visual fingerprint → measured analysis (sharpness, exposure, colour) → optional AI description → text embedding. Originals are never written.
- **Search**: Postgres full-text (with trigram and unaccent) and pgvector (halfvec, HNSW) are combined by reciprocal-rank fusion; “find similar” uses the visual fingerprint. Without embeddings the app falls back to full-text.
- **AI Curator**: deterministic scoring from measured quality and metadata, with series suppression and a human-readable reason for each pick; no model is required.
- **Jobs**: a Postgres-backed queue consumed by the worker, with heartbeats and recovery of interrupted runs.
- **Security model**: see [SECURITY.md](../SECURITY.md). Database roles: `owner` (migrations), `app` (web, RLS-restricted), `service` (worker), `delivery`, `backup` (read-only).
- **Secrets**: `EnvSecretStore` reads `PHOTOVAULT_<NAME>` or `PHOTOVAULT_<NAME>_FILE`.
- **Ports**: Postgres 54329 (native dev), API 8480, delivery 8481, web dev server 5173, dev API 8482; all loopback.
