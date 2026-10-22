#!/bin/sh
# v3 staging stack: compose project `hubv3` on http://127.0.0.1:18090 with its own volumes and `.env.staging`.
# It never touches the production project (hubv2) or its .env.
#   scripts/staging.sh up       generate .env.staging if missing, build, start (default)
#   scripts/staging.sh down     stop and remove containers (volumes kept)
#   scripts/staging.sh reset    down + delete hubv3 volumes (all staging data)
#   scripts/staging.sh logs [service…] | ps | env (print the env file path)
set -eu
cd "$(dirname "$0")/.."
ENV_FILE=.env.staging
PORT=18090
compose() { docker compose -p hubv3 -f compose.yaml -f compose.staging.yaml --env-file "$ENV_FILE" "$@"; }

gen_env() {
  [ -e "$ENV_FILE" ] && return 0
  command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
  rand() { openssl rand -base64 "$1" | tr -d '\n=+/' | cut -c1-"$2"; }
  umask 077
  sed \
    -e "s|^APP_ORIGIN=.*|APP_ORIGIN=http://127.0.0.1:$PORT|" \
    -e "s|^APP_HOSTNAME=.*|APP_HOSTNAME=127.0.0.1|" \
    -e "s|^HTTPS_ENABLED=.*|HTTPS_ENABLED=false|" \
    -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(rand 12 16)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 32 40)|" \
    -e "s|^WORKER_DB_PASSWORD=.*|WORKER_DB_PASSWORD=$(rand 32 40)|" \
    -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(rand 48 64)|" \
    -e "s|^PROVIDER_TOKEN_KEY=.*|PROVIDER_TOKEN_KEY=$(openssl rand -base64 32 | tr -d '\n')|" \
    -e "s|^S3_ACCESS_KEY=.*|S3_ACCESS_KEY=hub$(openssl rand -hex 10)|" \
    -e "s|^S3_SECRET_KEY=.*|S3_SECRET_KEY=$(rand 32 40)|" \
    .env.example > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE (admin; password: ADMIN_PASSWORD in .env.staging)."
}

cmd=${1:-up}
[ $# -gt 0 ] && shift
case "$cmd" in
  up)
    gen_env
    compose up -d --build "$@"
    echo "Staging: http://127.0.0.1:$PORT  (admin; password in .env.staging)"
    ;;
  down) compose down "$@" ;;
  reset)
    printf 'Delete ALL hubv3 staging data (volumes hubv3_*)? [y/N] '
    read -r answer
    [ "$answer" = y ] || exit 1
    compose down -v
    ;;
  logs) compose logs -f "$@" ;;
  ps) compose ps "$@" ;;
  env) echo "$ENV_FILE" ;;
  *) echo "usage: $0 [up|down|reset|logs|ps|env]" >&2; exit 2 ;;
esac
