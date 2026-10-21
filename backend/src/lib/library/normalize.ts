import type { PaperAuthor, PaperRecord } from "./types.js";

// ---------------------------------------------------------------- identifiers

const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/i;

/** Bare DOI ("10.1109/ICASSP.2022.1"; case kept for display), or undefined if the input has none. Compare with doiKey(). */
export function normalizeDoi(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  let s = String(input).trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as-is */
  }
  s = s.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  const m = DOI_RE.exec(s);
  if (!m) return undefined;
  // Trailing punctuation from prose ("…/abc)." or "…/abc,").
  let doi = m[0].replace(/[.,;:'"\])}>]+$/, "");
  // Keep balanced parentheses, e.g. 10.1016/s0140-6736(20)30183-5
  while (doi.endsWith(")") && (doi.match(/\(/g)?.length ?? 0) < (doi.match(/\)/g)?.length ?? 0)) doi = doi.slice(0, -1);
  return doi;
}

/** Case-folded DOI for comparisons and unique indexes (DOIs are case-insensitive). */
export function doiKey(input: string | undefined | null): string | undefined {
  return normalizeDoi(input)?.toLowerCase();
}

const ARXIV_NEW_FULL = /^(\d{4}\.\d{4,5})(?:v\d+)?$/;
const ARXIV_OLD_FULL = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i;
const ARXIV_IN_TEXT = /arxiv[:\s]*(\d{4}\.\d{4,5})(?:v\d+)?(?!\d)/i;

/** Bare arXiv id without version ("2005.08100", "cs/0601001"). Accepts URLs, "arXiv:" prefixes and arXiv DOIs. */
export function normalizeArxivId(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  let s = String(input).trim();
  s = s.replace(/^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\//i, "");
  s = s.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "").replace(/^10\.48550\/arxiv\./i, "");
  s = s.replace(/^arxiv:\s*/i, "").replace(/\.pdf$/i, "").replace(/[?#].*$/, "").trim();
  const n = ARXIV_NEW_FULL.exec(s);
  if (n) return n[1];
  const o = ARXIV_OLD_FULL.exec(s);
  if (o?.[1]) {
    const [cls, num] = o[1].split("/");
    const [arch, sub] = (cls ?? "").split(".");
    return `${arch!.toLowerCase()}${sub ? "." + sub.toUpperCase() : ""}/${num}`;
  }
  return ARXIV_IN_TEXT.exec(s)?.[1];
}

/** arXiv DOIs (10.48550/arXiv.XXXX) carry the arXiv id. */
export function arxivIdFromDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const m = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
  return m ? normalizeArxivId(m[1]) : undefined;
}

/** ACL Anthology id from an ACL DOI (10.18653/v1/2020.acl-main.1 → 2020.acl-main.1). */
export function aclIdFromDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const m = /^10\.18653\/v1\/(.+)$/i.exec(doi);
  return m?.[1];
}

export function normalizeIsbn(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const s = input.replace(/[^0-9Xx]/g, "").toUpperCase();
  return s.length === 10 || s.length === 13 ? s : input.trim() || undefined;
}

// ---------------------------------------------------------------- text

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : all;
    }
    return HTML_ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Strip HTML/JATS/MathML tags (titles and abstracts from APIs are unsanitized) and collapse whitespace. */
export function cleanText(s: string | undefined | null): string | undefined {
  if (s == null) return undefined;
  const out = decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return out || undefined;
}

/** JATS abstracts start with a "Abstract" heading inside <jats:title>. */
export function cleanAbstract(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const noTitle = String(s).replace(/<(jats:)?title>\s*abstract\s*<\/(jats:)?title>/i, "");
  return cleanText(noTitle);
}

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;
export const hasCjk = (s: string | undefined): boolean => !!s && CJK_RE.test(s);
export const hasHan = (s: string | undefined): boolean => !!s && HAN_RE.test(s);

/** Remove diacritics (NFKD, drop combining marks) and map a few Latin letters NFKD leaves alone. */
export function foldAscii(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[ßæœøłđþ]/g, (c) => ({ ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", þ: "th" })[c] ?? c)
    .replace(/[ÆŒØŁĐÞ]/g, (c) => ({ Æ: "AE", Œ: "OE", Ø: "O", Ł: "L", Đ: "D", Þ: "TH" })[c] ?? c);
}

/** Strip common LaTeX markup that may survive in titles from other tools. */
export function stripLatex(s: string): string {
  return s
    .replace(/\\(?:textbf|textit|emph|textsc|texttt|mathrm|mathbf|mathit|text|url|mbox)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+\s*/g, " ")
    .replace(/\\./g, "")
    .replace(/[{}$]/g, "");
}

/**
 * Title key for exact comparison: NFKC, casefold, strip LaTeX/HTML/accents/punctuation, collapse spaces.
 * CJK text is kept (only spaces between CJK characters are removed).
 */
export function normalizeTitle(title: string | undefined | null): string {
  if (!title) return "";
  let s = cleanText(title) ?? "";
  s = stripLatex(s).normalize("NFKC").toLowerCase();
  s = foldAscii(s);
  s = s.replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/(?<=[　-鿿가-힯]) (?=[　-鿿가-힯])/g, "");
  return s;
}

// ---------------------------------------------------------------- pg_trgm mirror

/** The trigram set pg_trgm builds for a string (words of alphanumerics, padded "  w "). */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const words = s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const w of words) {
    const chars = Array.from(`  ${w} `);
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(""));
  }
  return out;
}

/** Same value as Postgres `similarity(a, b)` (pg_trgm): |A∩B| / |A∪B| of trigram sets. */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Title similarity on normalized titles. CJK titles (no word breaks) use character bigrams instead. */
export function titleSimilarity(a: string | undefined, b: string | undefined): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (hasCjk(na) || hasCjk(nb)) {
    const bg = (s: string) => {
      const c = Array.from(s.replace(/\s+/g, ""));
      const set = new Set<string>();
      for (let i = 0; i + 2 <= c.length; i++) set.add(c[i]! + c[i + 1]!);
      return set;
    };
    const A = bg(na);
    const B = bg(nb);
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const uni = A.size + B.size - inter;
    return uni ? inter / uni : 0;
  }
  return trigramSimilarity(na, nb);
}

// ---------------------------------------------------------------- names

const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "di", "da", "du", "le", "la", "dos", "das", "ter", "ten", "zu", "op", "het", "'t", "al", "el", "bin", "ibn"]);

/** Split a leading lower-case particle from a family name ("van der Berg" → particle "van der", family "Berg"). */
export function splitParticle(family: string): { particle?: string; family: string } {
  const parts = family.trim().split(/\s+/);
  const lead: string[] = [];
  while (parts.length > 1 && PARTICLES.has(parts[0]!) && parts[0] === parts[0]!.toLowerCase()) lead.push(parts.shift()!);
  return lead.length ? { particle: lead.join(" "), family: parts.join(" ") } : { family: family.trim() };
}

/**
 * Parse a free-form personal name: "Gulati, Anmol", "Anmol Gulati", "王小明", "Wang, Xiaoming".
 * CJK names without separators become `literal` (family/given split is left to display code).
 */
export function parseName(raw: string): PaperAuthor | undefined {
  const s = (cleanText(raw) ?? "").replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  if (s.includes(",")) {
    const [family, ...rest] = s.split(",");
    const given = rest.join(",").trim();
    const fam = (family ?? "").trim();
    if (!fam) return { literal: s };
    const sp = splitParticle(fam);
    return { ...sp, ...(given ? { given } : {}) };
  }
  if (hasCjk(s) && !/\s/.test(s)) return { literal: s };
  const parts = s.split(" ");
  if (parts.length === 1) return { family: s };
  // "Anmol Gulati", "Jan van der Berg"
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1]!) && parts[i - 1] === parts[i - 1]!.toLowerCase()) i--;
  const given = parts.slice(0, i).join(" ");
  const fam = parts.slice(i).join(" ");
  const out: PaperAuthor = { family: parts[parts.length - 1]!, given };
  if (i < parts.length - 1) out.particle = parts.slice(i, parts.length - 1).join(" ");
  else out.family = fam;
  return out;
}

/** Display form "Given Family" / literal. */
export function authorDisplayName(a: PaperAuthor): string {
  if (a.literal) return a.literal;
  const fam = [a.particle, a.family].filter(Boolean).join(" ");
  if (hasCjk(fam) && hasCjk(a.given)) return `${fam}${a.given}`;
  return [a.given, fam, a.suffix].filter(Boolean).join(" ").trim();
}

/** Surname used for matching / citation keys (no particle). CJK literals: first character(s). */
export function authorFamily(a: PaperAuthor | undefined): string {
  if (!a) return "";
  if (a.family) return a.family;
  if (a.literal) {
    if (hasHan(a.literal) && !/\s/.test(a.literal)) return chineseSurname(a.literal);
    const parts = a.literal.split(/\s+/);
    return parts[parts.length - 1] ?? a.literal;
  }
  return "";
}

const COMPOUND_SURNAMES = ["歐陽", "欧阳", "司馬", "司马", "諸葛", "诸葛", "上官", "東方", "东方", "皇甫", "尉遲", "尉迟", "長孫", "长孙", "慕容", "令狐", "公孫", "公孙", "夏侯", "宇文", "司徒", "端木", "張簡", "张简", "范姜"];

/** Surname of an unsplit Chinese name (1 char, or a known compound surname). */
export function chineseSurname(name: string): string {
  for (const c of COMPOUND_SURNAMES) if (name.startsWith(c) && name.length > 2) return c;
  return Array.from(name)[0] ?? name;
}

/** Normalized surname for comparisons. */
export function familyKey(a: PaperAuthor | undefined): string {
  return foldAscii(authorFamily(a).normalize("NFKC").toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, "");
}

// ---------------------------------------------------------------- misc fields

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export function parseMonth(s: string | number | undefined): number | undefined {
  if (s == null) return undefined;
  if (typeof s === "number") return s >= 1 && s <= 12 ? s : undefined;
  const t = s.trim().toLowerCase();
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 12 ? n : undefined;
  }
  return MONTHS[t.slice(0, 4)] ?? MONTHS[t.slice(0, 3)];
}

/** Parse "2020", "2020-10-25", "2020/10", "Oct 2020" into parts. */
export function parseDate(s: string | undefined): { year?: number; month?: number; day?: number } {
  if (!s) return {};
  const t = s.trim();
  let m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?/.exec(t);
  if (m) {
    const out: { year?: number; month?: number; day?: number } = { year: Number(m[1]) };
    const mo = m[2] ? Number(m[2]) : undefined;
    if (mo && mo >= 1 && mo <= 12) out.month = mo;
    const d = m[3] ? Number(m[3]) : undefined;
    if (d && d >= 1 && d <= 31 && out.month) out.day = d;
    return out;
  }
  m = /\b(1[5-9]\d\d|20\d\d)\b/.exec(t);
  if (!m) return {};
  const month = parseMonth(t.replace(m[0], "").trim().split(/[\s,]+/)[0]);
  return { year: Number(m[1]), ...(month ? { month } : {}) };
}

/** "5036--5040" / "5036-5040" → "5036–5040". */
export function normalizePages(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const s = p.trim().replace(/\s*(?:--|—|–|-)\s*/g, "–");
  return s || undefined;
}

const VENUES: [RegExp, string][] = [
  [/\binterspeech\b|\beurospeech\b/i, "Interspeech"],
  [/\bicassp\b|international conference on acoustics,? speech,? and signal processing/i, "ICASSP"],
  [/\basru\b|automatic speech recognition and understanding/i, "ASRU"],
  [/\bslt\b|spoken language technology workshop/i, "SLT"],
  [/transactions on audio,? speech,? and language processing|\btaslp\b/i, "TASLP"],
  [/\bfindings of the association for computational linguistics\b/i, "Findings"],
  [/\bemnlp\b|empirical methods in natural language processing/i, "EMNLP"],
  [/\bnaacl\b|north american chapter of the association for computational linguistics/i, "NAACL"],
  [/\beacl\b|european chapter of the association for computational linguistics/i, "EACL"],
  [/transactions of the association for computational linguistics|\btacl\b/i, "TACL"],
  [/\bacl\b|annual meeting of the association for computational linguistics/i, "ACL"],
  [/\bneurips\b|\bnips\b|neural information processing systems/i, "NeurIPS"],
  [/\biclr\b|international conference on learning representations/i, "ICLR"],
  [/\bicml\b|international conference on machine learning/i, "ICML"],
  [/\baaai\b/i, "AAAI"],
  [/\bijcai\b/i, "IJCAI"],
  [/\bcvpr\b|computer vision and pattern recognition/i, "CVPR"],
  [/\barxiv\b/i, "arXiv"],
];

/** Short venue label from a container title / DOI, or undefined. */
export function deriveVenue(r: Pick<PaperRecord, "containerTitle" | "doi" | "arxivId" | "type">): string | undefined {
  const doi = r.doi?.toLowerCase();
  if (doi?.startsWith("10.21437/interspeech")) return "Interspeech";
  if (doi?.startsWith("10.1109/icassp")) return "ICASSP";
  if (doi?.startsWith("10.1109/asru")) return "ASRU";
  if (doi?.startsWith("10.1109/slt")) return "SLT";
  const c = r.containerTitle ?? "";
  for (const [re, v] of VENUES) if (re.test(c)) return v;
  if (!c && r.arxivId && r.type === "article") return "arXiv";
  return undefined;
}

/** Drop undefined / empty values so records stay compact (JSONB-friendly). */
export function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

/** Final pass for every importer/source: normalize ids, pages, venue; drop empties. */
/** NFC-normalize every string in a value (BibTeX accent macros come out of the parser decomposed). */
function nfcDeep<T>(v: T): T {
  if (typeof v === "string") return v.normalize("NFC") as T;
  if (Array.isArray(v)) return v.map(nfcDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "bibtex" ? x : nfcDeep(x)])) as T;
  return v;
}

export function finalizeRecord(r0: PaperRecord): PaperRecord {
  const r = nfcDeep(r0);
  const doi = normalizeDoi(r.doi);
  const arxivId = normalizeArxivId(r.arxivId) ?? arxivIdFromDoi(doi);
  const out: PaperRecord = {
    ...r,
    title: (cleanText(r.title) ?? "").replace(/\s+/g, " "),
    authors: r.authors.filter((a) => a.family || a.literal || a.given),
    doi,
    arxivId,
    pages: normalizePages(r.pages),
    isbn: normalizeIsbn(r.isbn),
    abstract: cleanText(r.abstract),
    keywords: r.keywords ? [...new Set(r.keywords.map((k) => k.trim()).filter(Boolean))] : undefined,
  };
  const acl = out.ids?.acl ?? aclIdFromDoi(doi);
  if (acl) out.ids = { ...out.ids, acl };
  if (out.ids) out.ids = compact(out.ids);
  if (!out.venue) out.venue = deriveVenue(out);
  return { ...compact(out), title: out.title, authors: out.authors };
}
