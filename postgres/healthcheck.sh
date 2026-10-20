#!/bin/sh
# Healthy only once both roles accept the passwords from .env (see entrypoint.sh).
set -eu
PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc 'SELECT 1' | grep -qx 1
PGPASSWORD="$WORKER_DB_PASSWORD" psql -X -h 127.0.0.1 -U hub_worker -d "$POSTGRES_DB" -Atqc 'SELECT 1' | grep -qx 1
