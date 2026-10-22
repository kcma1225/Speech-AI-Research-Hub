/**
 * Auto bibliography (`bib_mode auto`): the bib file is rewritten from the study library before each compile. Entries
 * that are not in the library but still cited by the project (the template's sample entries, or a project switched
 * from manual to auto) are carried over, so the first compile of a new template never shows "[?]".
 */

/** Cite keys used in TeX sources (\cite, \citep, \parencite, \textcite, \autocite, \nocite… with optional args); comments ignored. */
export function citedKeys(texts: string[]): Set<string> {
  const keys = new Set<string>();
  const re = /\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)\}/g;
  for (const text of texts) {
    const clean = text.replace(/(^|[^\\])%.*$/gm, "$1");
    for (const m of clean.matchAll(re)) for (const k of m[1]!.split(",")) if (k.trim()) keys.add(k.trim());
  }
  return keys;
}

/** `@type{key, …}` entries of a bib file (no @comment/@string/@preamble), each with its full source text. */
export function bibEntries(bib: string): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const m of bib.matchAll(/^@(\w+)\s*\{\s*([^,\s{}]+)\s*,[\s\S]*?(?=^@|(?![\s\S]))/gm)) {
    if (/^(comment|string|preamble)$/i.test(m[1]!)) continue;
    out.push({ key: m[2]!, text: m[0].trimEnd() });
  }
  return out;
}

/** Entries of `oldBib` that are cited, not in `libraryKeys` (case-insensitive, like BibTeX) and not duplicated. */
export function carriedEntries(oldBib: string, libraryKeys: Iterable<string>, cited: Set<string>): { key: string; text: string }[] {
  const lib = new Set([...libraryKeys].map((k) => k.toLowerCase()));
  const seen = new Set<string>();
  return bibEntries(oldBib).filter((e) => {
    const k = e.key.toLowerCase();
    if (lib.has(k) || seen.has(k) || !cited.has(e.key)) return false;
    seen.add(k);
    return true;
  });
}
