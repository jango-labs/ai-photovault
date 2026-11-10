# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [1.0.0-rc.1] — unreleased

First public release candidate, extracted from a private production application.

### Added
- Library, filters and metadata (EXIF), duplicate and version review, offline map, collections.
- Natural-language search (full-text + semantic, reciprocal-rank fusion), find-similar by visual fingerprint, AI Curator with reasons.
- Optional local AI via Ollama (vision descriptions, `nomic-embed-text` embeddings); measured analysis needs no AI service.
- Docker Compose stack (db, one-shot bootstrap, app, worker, optional ollama profile), setup scripts for macOS/Linux/Windows, backup/restore scripts, install validator, synthetic demo library.
- Mandatory TOTP two-factor sign-in, row-level security with five database roles, host allow-list, CSRF protection.

### Changed (relative to the private application)
- Secrets come from environment variables or `*_FILE` instead of the macOS Keychain.
- No dependency on launchd, a NAS, volume UUIDs or a VPN; all paths and ports are configurable and default to loopback.
- Place-name lookup is off by default; import folders must be approved.

### Not included
- Production data, photographs, account records, hosted AI wiring, real Instagram publishing.
