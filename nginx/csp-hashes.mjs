// Prints CSP source expressions ('sha256-…') for every inline <script> in the given HTML file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const html = readFileSync(process.argv[2], "utf8");
const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
process.stdout.write(hashes.join(" "));
