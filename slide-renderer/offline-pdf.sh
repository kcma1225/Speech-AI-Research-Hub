#!/bin/sh
set -eu
root="$1"
html="$2"
python3 /usr/local/bin/prepare-pdf.py "$root" "$html"
# Print needs web fonts, math and Reveal to finish; virtual time waits for timers.
# Chrome runs in network-isolated renderer with read-only root and tmpfs /tmp.
export FONTCONFIG_PATH=/etc/fonts
mkdir -p /tmp/chrome-profile
if ! timeout 120 /opt/chrome/chrome-headless-shell --headless --no-sandbox --disable-gpu \
  --disable-dev-shm-usage --allow-file-access-from-files --no-first-run \
  --user-data-dir=/tmp/chrome-profile --virtual-time-budget=12000 \
  --no-pdf-header-footer --print-to-pdf="$root/slides.pdf" \
  "file://$html?print-pdf" > "$root/pdf.log" 2>&1; then
  exit 1
fi
[ -s "$root/slides.pdf" ] && [ "$(head -c 5 "$root/slides.pdf")" = '%PDF-' ] && [ "$(wc -c < "$root/slides.pdf")" -gt 10000 ]
