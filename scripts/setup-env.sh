#!/usr/bin/env sh
# macOS / Linux without Node: creates .env with random secrets (needs openssl). Never overwrites an existing .env.
set -eu
cd "$(dirname "$0")/.."
[ ! -e .env ] || { echo ".env already exists; not touching it." >&2; exit 1; }
umask 077
while IFS= read -r line; do
  case "$line" in
    *=__GENERATED_HEX__) printf '%s=%s\n' "${line%%=*}" "$(openssl rand -hex 32)" ;;
    *=__GENERATED__)     printf '%s=%s\n' "${line%%=*}" "$(openssl rand -hex 24)" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < .env.example > .env
echo "Created .env with new random secrets. Edit PHOTOVAULT_PHOTOS_DIR to point at your photo folder."
