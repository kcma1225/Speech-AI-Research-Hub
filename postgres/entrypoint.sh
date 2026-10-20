#!/bin/sh
# Wraps the official entrypoint: after the server is up, re-applies POSTGRES_PASSWORD and
# WORKER_DB_PASSWORD from .env to the existing roles, so rotating a secret is "edit .env + recreate".
# The compose healthcheck logs in with both passwords, so dependants wait until this has run.
set -eu
: "${POSTGRES_USER:?POSTGRES_USER required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}"
: "${WORKER_DB_PASSWORD:?WORKER_DB_PASSWORD required}"
docker-entrypoint.sh postgres &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true' TERM INT
n=0
# Wait for the final server (the initdb phase runs a temporary socket-only server first).
until pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER"; do
  n=$((n+1))
  if [ "$n" -ge 120 ]; then echo 'PostgreSQL startup timed out' >&2; exit 1; fi
  sleep 1
done
# psql variables quote identifiers and literals; secret values never enter shell command text.
psql -X -v ON_ERROR_STOP=1 -h /var/run/postgresql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" \
  -v role="$POSTGRES_USER" -v pass="$POSTGRES_PASSWORD" -v wpass="$WORKER_DB_PASSWORD" <<'SQL' >/dev/null
SELECT format('ALTER ROLE %I PASSWORD %L', :'role', :'pass') \gexec
SELECT format('CREATE ROLE hub_worker LOGIN PASSWORD %L', :'wpass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_worker') \gexec
SELECT format('ALTER ROLE hub_worker PASSWORD %L', :'wpass') \gexec
SQL
wait "$pid"
