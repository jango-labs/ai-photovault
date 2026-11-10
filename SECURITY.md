# Security

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private vulnerability reporting (Security tab → “Report a vulnerability”) on this repository. You will get an acknowledgement within a few days. This is a volunteer project; there is no bounty.

## Threat model

AI PhotoVault is a **single-owner, self-hosted** application for a computer you control. It is designed so that a mistake in configuration fails closed.

| Protection | How |
|---|---|
| Not reachable from your network | Binds to `127.0.0.1`. A non-loopback bind is refused unless in the container, where Compose publishes only on `127.0.0.1`. The database has no published port. |
| DNS rebinding / foreign Host | Requests whose `Host` is not on the allow-list get HTTP 421. |
| Authentication | Argon2id password hashes; **mandatory TOTP two-factor** (enrolled at first sign-in) with single-use recovery codes; session cookies are HttpOnly and SameSite=Lax (Secure over HTTPS); rate limiting on sign-in; no public sign-up. |
| CSRF | Per-session CSRF token on every state-changing request. |
| Database | Five least-privilege roles; row-level security keyed to the signed-in user on every table; the web role cannot alter schema. |
| Secrets | Only from environment variables or `*_FILE`; never written to the database in plain text (integration tokens are encrypted with `PHOTOVAULT_TOKEN_ENC_KEY`); a repository scan (`npm run scan:secrets`) runs in CI. |
| Originals | Mounted read-only; the code never writes, renames or deletes source files. |
| Import approval | <a id="import-approval"></a>A folder is read only if listed in `<state dir>/approvals/ingest.json` (created by `npm run ingest:approve`, or automatically for the read-only `/photos` mount in Docker). Symlinks, path traversal and files outside the approved root are skipped. |
| AI privacy | Ollama is called only on loopback or hosts you list. Hosted AI adapters are not wired in. Model output is treated as untrusted text (control characters stripped, lengths bounded). Place lookup is off by default. |
| Containers | `read_only`, all capabilities dropped, `no-new-privileges`, non-root. |

## Out of scope / your responsibility

- Anyone with access to your operating-system account, `.env`, or a backup file can read your library metadata and secrets. Protect them like a password file and encrypt your disk.
- If you expose the app beyond `127.0.0.1` (reverse proxy, VPN), you own TLS, access control and patching. Keep `PHOTOVAULT_COOKIE_SECURE=1` behind HTTPS.
- Pin and update the base images (`pgvector/pgvector`, `ollama/ollama`) yourself; Compose uses current tags.

## Known dependency advisories (at release time)

`npm audit --omit=dev` reports, after applying all non-breaking fixes:

| Package | Advisory | Why it is accepted for 1.0 |
|---|---|---|
| `zod` 3.25 (high) | Memory exhaustion validating oversized constrained collections | Request bodies are capped by the server's body limit and only the authenticated owner can reach validators; upgrade to zod 4 is a breaking migration planned for 1.1. |
| `glob`, `minimatch` via `node-pg-migrate` (moderate) | Pattern/abort handling issues | Used only by the migration tool against this repository's own migration folder, never on user input. |

## Supported versions

Only the latest release receives fixes.
