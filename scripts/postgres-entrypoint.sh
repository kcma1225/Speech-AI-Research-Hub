#!/bin/sh
set -eu
# Start official entrypoint, then reconcile password for existing volumes.
docker-entrypoint.sh postgres &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true' TERM INT
n=0
until pg_isready -q -h /var/run/postgresql -U "$POSTGRES_USER"; do
  n=$((n+1))
  if [ "$n" -ge 60 ]; then echo 'PostgreSQL startup timed out' >&2; exit 1; fi
  sleep 1
done
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}"
: "${POSTGRES_USER:?POSTGRES_USER required}"
# psql variables quote both identifier and string; values never enter shell command text.
psql -X -v ON_ERROR_STOP=1 -h /var/run/postgresql -U "${POSTGRES_USER}" -d postgres \
  -v role="${POSTGRES_USER}" -v pass="${POSTGRES_PASSWORD}" \
  <<'SQL' >/dev/null
SELECT format('ALTER ROLE %I PASSWORD %L', :'role', :'pass') \gexec
SQL
wait "$pid"
