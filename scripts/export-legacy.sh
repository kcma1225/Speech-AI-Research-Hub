#!/bin/sh
# Exports all data from a running v1 (Next.js MVP) stack into legacy-export/<UTC timestamp>/.
# v2 does not import it; this is an archive you can read or re-import by hand.
#
# Run on the host where the v1 stack runs:
#   scripts/export-legacy.sh [v1 compose project name]
# The project name defaults to $V1_PROJECT, else the name of the current directory (lowercased), which is
# what `docker compose up` used when v1 was started from its checkout. `docker compose ls` lists projects.
#
# Read-only against v1: it only runs pg_dump/psql SELECTs and mounts v1 volumes read-only.
set -eu

project="${1:-${V1_PROJECT:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]')}}"
here="$(cd "$(dirname "$0")/.." && pwd)"
helper_image="alpine:3.22"

die() { echo "export-legacy: $*" >&2; exit 1; }
command -v docker >/dev/null || die "docker is required"

container() {
  docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1" | head -n1
}
volume() {
  docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=$1" | head -n1
}

db="$(container db)"
[ -n "$db" ] || die "no running 'db' container for compose project '$project'. Start v1 (docker compose up -d db) or pass the project name; see: docker compose ls"
uploads="$(volume uploads)"
slides="$(volume slide_projects)"

final="$here/legacy-export/$(date -u +%Y%m%dT%H%M%SZ)"
# Work in a hidden directory and rename at the end, so an interrupted run never looks complete.
out="$final.partial"
mkdir -p "$here/legacy-export"
chmod 700 "$here/legacy-export"
rm -rf "$out"
mkdir -p "$out/notes" "$out/uploads" "$out/slides"
trap 'echo "export-legacy: failed; partial output left in $out" >&2' EXIT
echo "Exporting v1 project '$project' to $final"

psql_v1() {
  docker exec -i "$db" sh -c 'psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' psql "$@"
}

echo "- database dump (db.sql)"
docker exec "$db" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' > "$out/db.sql"

echo "- notes as Markdown (notes/)"
# One record per note: file name \037 document, records separated by \036. JSON strings are valid YAML scalars.
psql_v1 -F "$(printf '\037')" -R "$(printf '\036')" <<'SQL' > "$out/notes.raw"
SELECT
  to_char(i.event_date, 'YYYY-MM-DD') || '-' || left(i.id::text, 8) || '.md',
  '---' || E'\n' ||
  'id: ' || i.id || E'\n' ||
  'title: ' || to_json(i.title)::text || E'\n' ||
  'date: ' || to_char(i.event_date, 'YYYY-MM-DD') || E'\n' ||
  'tags: ' || coalesce((SELECT json_agg(t.name ORDER BY lower(t.name))::text FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id), '[]') || E'\n' ||
  'author: ' || coalesce(to_json(cu.name)::text, 'null') || E'\n' ||
  'updated_by: ' || coalesce(to_json(uu.name)::text, 'null') || E'\n' ||
  'created_at: ' || to_json(i.created_at)::text || E'\n' ||
  'updated_at: ' || to_json(i.updated_at)::text || E'\n' ||
  'audio_file: ' || coalesce(to_json(i.file_name)::text, 'null') || E'\n' ||
  'audio_storage_name: ' || coalesce(to_json(i.storage_name)::text, 'null') || E'\n' ||
  'transcript_file: ' || coalesce(to_json(i.transcript_name)::text, 'null') || E'\n' ||
  '---' || E'\n\n' ||
  i.content || E'\n' ||
  CASE WHEN i.transcript IS NULL OR jsonb_array_length(i.transcript) = 0 THEN ''
       ELSE E'\n## 逐字稿\n\n' || (SELECT string_agg('- [' || to_char(make_interval(secs => (c->>'start')::float8), 'HH24:MI:SS') || '] ' || replace(c->>'text', E'\n', ' '), E'\n' ORDER BY (c->>'start')::float8) FROM jsonb_array_elements(i.transcript) c) || E'\n'
  END
FROM items i
LEFT JOIN users cu ON cu.id = i.created_by
LEFT JOIN users uu ON uu.id = i.updated_by
ORDER BY i.event_date, i.created_at;
SQL
awk -v dir="$out/notes" 'BEGIN { RS = "\036"; FS = "\037" }
  NF >= 2 { name = $1; sub(/^\n+/, "", name); doc = substr($0, length($1) + 2); printf "%s", doc > (dir "/" name); close(dir "/" name); n++ }
  END { print "  " n + 0 " notes" }' "$out/notes.raw"
rm -f "$out/notes.raw"

copy_volume() { # volume target label
  if [ -z "$1" ]; then
    echo "- $3: volume not found, skipped"
    return
  fi
  echo "- $3 ($1)"
  docker run --rm -v "$1:/src:ro" "$helper_image" tar -C /src -cf - . | tar -C "$2" -xf -
}
copy_volume "$uploads" "$out/uploads" "uploaded media (uploads/)"
copy_volume "$slides" "$out/slides" "slide projects (slides/)"

cat > "$out/README.txt" <<TXT
Speech-AI Research Hub v1 export
Exported: $(date -u +%Y-%m-%dT%H:%M:%SZ) from compose project '$project'

db.sql     Full PostgreSQL dump of v1 (plain SQL). Inspect with any Postgres 17:
           createdb v1 && psql -d v1 -f db.sql
notes/     One Markdown file per research note (<date>-<id>.md). Front matter has
           title, date, tags, author, audio file name and the storage name of the
           audio inside uploads/. Transcript cues are appended as a list.
uploads/   v1 upload volume: <storage_name> audio files (24 kHz mono AAC/M4A).
slides/    v1 slide volume: projects/<project id>/versions/<version id>/{source,output}
           (source = QMD/CSS/images as uploaded, output = rendered reveal.js + slides.pdf).
           Map project ids to titles/slugs with the slide_projects table in db.sql.

v2 starts from an empty database and does not import this export.
TXT
trap - EXIT
mv "$out" "$final"
echo "Done: $final"
