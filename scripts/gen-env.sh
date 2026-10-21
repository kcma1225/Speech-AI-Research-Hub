#!/bin/sh
# Creates .env from .env.example with freshly generated secrets. Never overwrites an existing .env.
set -eu
cd "$(dirname "$0")/.."
if [ -e .env ]; then
  echo ".env already exists; not touching it." >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
rand() { openssl rand -base64 "$1" | tr -d '\n=+/' | cut -c1-"$2"; }
umask 077
sed \
  -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(rand 24 24)|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 32 40)|" \
  -e "s|^WORKER_DB_PASSWORD=.*|WORKER_DB_PASSWORD=$(rand 32 40)|" \
  -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(rand 48 64)|" \
  -e "s|^PROVIDER_TOKEN_KEY=.*|PROVIDER_TOKEN_KEY=$(openssl rand -base64 32 | tr -d '\n')|" \
  -e "s|^S3_ACCESS_KEY=.*|S3_ACCESS_KEY=hub$(openssl rand -hex 10)|" \
  -e "s|^S3_SECRET_KEY=.*|S3_SECRET_KEY=$(rand 32 40)|" \
  -e "s|^LATEX_REGISTER_PASSWORD=.*|LATEX_REGISTER_PASSWORD=$(rand 24 24)|" \
  -e "s|^LATEX_OIDC_CLIENT_SECRET=.*|LATEX_OIDC_CLIENT_SECRET=$(rand 48 48)|" \
  .env.example > .env
chmod 600 .env
echo "Wrote .env (mode 600). Initial admin: name admin, password in ADMIN_PASSWORD (.env)."
