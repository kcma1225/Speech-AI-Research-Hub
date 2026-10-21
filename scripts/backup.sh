#!/bin/sh
# Backs up the running v2 stack into backups/<UTC timestamp>/: a PostgreSQL dump and a mirror of the
# RustFS bucket. Run from the repo root host: scripts/backup.sh [compose project name]
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Missing .env" >&2; exit 1; }
project="${1:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]')}"
compose() { docker compose -p "$project" "$@"; }
# Read only the keys we need: .env is a compose env file (unquoted values may contain spaces), not a shell script.
envval() { sed -n "s/^$1=//p" .env | tail -n 1; }
DATABASE_NAME=$(envval DATABASE_NAME); DATABASE_USER=$(envval DATABASE_USER); S3_BUCKET=$(envval S3_BUCKET)
S3_ACCESS_KEY=$(envval S3_ACCESS_KEY); S3_SECRET_KEY=$(envval S3_SECRET_KEY)
db_name="${DATABASE_NAME:-research_hub}"
db_user="${DATABASE_USER:-research_hub}"
bucket="${S3_BUCKET:-hub}"

[ -n "$(compose ps -q db)" ] || { echo "db service of project '$project' is not running" >&2; exit 1; }
[ -n "$(compose ps -q rustfs)" ] || { echo "rustfs service of project '$project' is not running" >&2; exit 1; }

out="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out/objects"
chmod 700 backups "$out"

echo "Dumping database $db_name…"
compose exec -T db pg_dump -U "$db_user" -d "$db_name" --format=custom --no-owner > "$out/db.dump"

echo "Mirroring bucket $bucket…"
# Throwaway CLI container on the stack's internal network; credentials passed via env, not argv.
network="${project}_internal"
docker run --rm --network "$network" \
  -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" -e AWS_DEFAULT_REGION=us-east-1 -e HOME=/tmp \
  -v "$PWD/$out/objects:/backup" --user "$(id -u):$(id -g)" \
  amazon/aws-cli:2.31.0 --endpoint-url http://rustfs:9000 s3 sync "s3://$bucket" /backup --only-show-errors

# Aldine (profile `latex`) keeps projects (git repos) and its own secrets/database in two volumes.
for volume in latex_data latex_secrets; do
  if docker volume inspect "${project}_${volume}" >/dev/null 2>&1; then
    echo "Archiving volume $volume…"
    docker run --rm -v "${project}_${volume}:/src:ro" -v "$PWD/$out:/out" alpine:3.22 \
      tar -C /src -czf "/out/${volume}.tar.gz" .
  fi
done

echo "Backup written to $out"
echo "Restore: Aldine volumes: stop latex-app/latex-compiler, then untar into the volumes."
echo "Restore: pg_restore --clean -d $db_name < db.dump; aws s3 sync objects/ s3://$bucket"
