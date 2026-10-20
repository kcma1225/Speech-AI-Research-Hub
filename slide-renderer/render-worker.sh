#!/bin/sh
set -eu
while true; do
  found=0
  for root in /data/slides/jobs/*; do
    [ -d "$root" ] || continue
    [ -f "$root/queued" ] || continue
    found=1
    mv "$root/queued" "$root/rendering" 2>/dev/null || continue
    entry="$(cat "$root/entry")"
    case "$entry" in /*|*..*) echo 'invalid entry path' > "$root/render.log"; touch "$root/failed"; rm -f "$root/rendering"; continue;; esac
    rm -rf "$root/output"
    mkdir -p "$root/output"
    entry_dir="$(dirname "$entry")"
    entry_file="$(basename "$entry")"
    if (cd "$root/source/$entry_dir" && timeout 180 quarto render "$entry_file" --to revealjs --output-dir "$root/output" --no-execute) > "$root/render.log" 2>&1; then
      html="$root/output/$(basename "$entry" .qmd).html"
      if /usr/local/bin/offline-pdf.sh "$root/output" "$html" >> "$root/render.log" 2>&1; then
        quarto --version > "$root/quarto-version"
        touch "$root/complete"
      else
        printf '\nPDF 匯出失敗。\n' >> "$root/render.log"
        touch "$root/failed"
      fi
    else
      touch "$root/failed"
    fi
    rm -f "$root/rendering"
  done
  [ "$found" = 1 ] || sleep 2
done
