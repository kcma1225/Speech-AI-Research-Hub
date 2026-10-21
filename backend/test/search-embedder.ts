/**
 * Deterministic mock embedding model for search tests: hashed bag of character n-grams (CJK unigrams + bigrams,
 * ASCII words + trigrams), signed feature hashing, L2-normalized. Texts sharing n-grams get high cosine similarity —
 * good enough to test plumbing and rough relevance, not real semantics.
 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function features(text: string): string[] {
  const t = text.normalize("NFKC").toLowerCase();
  const out: string[] = [];
  for (const run of t.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (CJK.test(run)) {
      const chars = [...run];
      chars.forEach((c, i) => {
        out.push(`u:${c}`);
        if (i + 1 < chars.length) out.push(`b:${c}${chars[i + 1]}`, `b:${c}${chars[i + 1]}`);
      });
    } else {
      out.push(`w:${run}`, `w:${run}`);
      const padded = `^${run}$`;
      for (let i = 0; i + 3 <= padded.length; i++) out.push(`t:${padded.slice(i, i + 3)}`);
    }
  }
  return out;
}

export function mockEmbed(text: string, dims = 64): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const f of features(text)) {
    const h = fnv1a(f);
    v[h % dims]! += (h >>> 31) & 1 ? 1 : -1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
