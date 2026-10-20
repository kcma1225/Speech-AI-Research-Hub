#!/bin/sh
# First-init only (docker-entrypoint-initdb.d): create the least-privilege role the worker connects as.
# Table grants come from backend migrations; postgres/entrypoint.sh keeps the password in sync later.
set -eu
: "${WORKER_DB_PASSWORD:?WORKER_DB_PASSWORD required}"
psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v pass="$WORKER_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE hub_worker LOGIN PASSWORD %L', :'pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_worker') \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hub_worker;
SQL
