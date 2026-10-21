#!/bin/sh
# Copies the contract and parsers shared with the backend (backend/src/lib/latex is the source of truth).
# backend/test/latex-sync.test.ts fails when the copies drift.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
src="$here/../backend/src/lib/latex"
mkdir -p "$here/src/shared"
for f in contract.ts hints.ts log-parser.ts blg-parser.ts; do cp "$src/$f" "$here/src/shared/$f"; done
