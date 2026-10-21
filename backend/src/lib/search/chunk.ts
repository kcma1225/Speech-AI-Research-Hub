/**
 * Markdown chunker for embeddings: splits by headings and paragraphs into ~800-character chunks with a short overlap.
 * Each chunk is prefixed with the document title and its heading path so it embeds with context. Pure and
 * deterministic (same input → same chunks → same content hashes, so unchanged chunks are never re-embedded).
 */

export type ChunkOptions = { target?: number; max?: number; overlap?: number; maxChunks?: number };

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

type Block = { path: string; text: string; heading: boolean };

function blocks(md: string): Block[] {
  const out: Block[] = [];
  const path: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) out.push({ path: path.filter(Boolean).join(" › "), text, heading: false });
    buf = [];
  };
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence ? HEADING.exec(line) : null;
    if (h) {
      flush();
      const level = h[1]!.length;
      path.length = level - 1;
      path[level - 1] = h[2]!.trim();
      out.push({ path: path.filter(Boolean).join(" › "), text: "", heading: true });
      continue;
    }
    if (!inFence && !line.trim()) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** Splits an over-long paragraph at sentence ends (、。！？.!? or newlines), then hard-splits what is still too long. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/g) ?? [text];
  const parts: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) {
      parts.push(cur);
      cur = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
      continue;
    }
    cur += s;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Tail of a chunk used as overlap, starting at a sentence or word boundary when possible. */
function tail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n > 0 && text.length <= n ? text : "";
  const t = text.slice(-n);
  const cut = t.search(/[。！？.!?\s]/);
  return (cut >= 0 && cut < n / 2 ? t.slice(cut + 1) : t).trim();
}

/**
 * Chunks Markdown. `title` (optional) is prepended to every chunk together with the heading path.
 * Returns [] for empty input.
 */
export function chunkMarkdown(md: string, title = "", opts: ChunkOptions = {}): string[] {
  const target = opts.target ?? 800;
  const max = opts.max ?? Math.round(target * 1.5);
  const overlap = opts.overlap ?? 100;
  const maxChunks = opts.maxChunks ?? 200;
  const chunks: { path: string; body: string }[] = [];
  let cur: { path: string; body: string } | null = null;
  let prevTail = "";
  const flush = () => {
    if (cur && cur.body.trim()) {
      chunks.push(cur);
      prevTail = tail(cur.body, overlap);
    }
    cur = null;
  };
  for (const b of blocks(md)) {
    if (b.heading) {
      // A new section starts a new chunk once the current one has some substance.
      if (cur && (cur as { body: string }).body.length >= target / 3) {
        flush();
        prevTail = "";
      }
      continue;
    }
    for (const piece of splitLong(b.text, max)) {
      if (cur && cur.body.length + piece.length + 2 > target) flush();
      if (!cur) {
        const withTail = prevTail && prevTail.length + piece.length + 2 <= max;
        cur = { path: b.path, body: withTail ? `${prevTail}\n\n` : "" };
        prevTail = "";
      }
      cur.body += (cur.body && !cur.body.endsWith("\n\n") ? "\n\n" : "") + piece;
    }
  }
  flush();
  const head = title.trim();
  return chunks.slice(0, maxChunks).map((c) => [head, c.path && c.path !== head ? c.path : "", c.body.trim()].filter(Boolean).join("\n"));
}

