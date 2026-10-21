import { authorDisplayName, hasCjk } from "./normalize.js";
import type { PaperAuthor, PaperRecord } from "./types.js";

// Plain-text citation strings for UI display (no citeproc; CPAL/AGPL avoided). Not a full style implementation.

function initials(given: string): string {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((g) => g.split("-").map((p) => (p ? `${Array.from(p)[0]!.toUpperCase()}.` : "")).join("-"))
    .join(" ");
}

const isCjkName = (a: PaperAuthor) => hasCjk(a.literal ?? `${a.family ?? ""}${a.given ?? ""}`);

/** "Gulati, A.", "van der Berg, J.", "王小明" */
function apaName(a: PaperAuthor): string {
  if (a.literal || isCjkName(a)) return authorDisplayName(a);
  const fam = [a.particle, a.family].filter(Boolean).join(" ");
  const g = a.given ? initials(a.given) : "";
  return [fam, g].filter(Boolean).join(", ") + (a.suffix ? `, ${a.suffix}` : "");
}

/** "A. Gulati", "J. van der Berg", "王小明" */
function ieeeName(a: PaperAuthor): string {
  if (a.literal || isCjkName(a)) return authorDisplayName(a);
  const fam = [a.particle, a.family].filter(Boolean).join(" ");
  return [a.given ? initials(a.given) : "", fam, a.suffix].filter(Boolean).join(" ");
}

function doiUrl(r: PaperRecord): string | undefined {
  if (r.doi) return `https://doi.org/${r.doi}`;
  if (r.arxivId) return `https://arxiv.org/abs/${r.arxivId}`;
  return r.url;
}

const end = (s: string) => (/[.?!。？！]$/.test(s) ? s : `${s}.`);

/** APA 7-like: "Gulati, A., Qin, J., & Pang, R. (2020). Title. Container, 12(3), 5036–5040. https://doi.org/…" */
export function formatApa(r: PaperRecord): string {
  const names = r.authors.map(apaName);
  let authors = "";
  if (names.length === 1) authors = names[0]!;
  else if (names.length === 2) authors = `${names[0]}, & ${names[1]}`;
  else if (names.length > 20) authors = `${names.slice(0, 19).join(", ")}, … ${names[names.length - 1]}`;
  else if (names.length > 2) authors = `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
  const parts: string[] = [];
  const year = `(${r.year ?? "n.d."})`;
  parts.push(authors ? `${end(authors)} ${year}.` : `${end(r.title)} ${year}.`);
  if (authors) parts.push(end(r.title));
  let container = r.containerTitle ?? (r.type === "article" && r.arxivId ? "arXiv" : "");
  if (container) {
    if (r.volume) container += `, ${r.volume}${r.issue ? `(${r.issue})` : ""}`;
    if (r.pages) container += `, ${r.pages}`;
    else if (r.type === "article" && r.arxivId && !r.containerTitle) container = `arXiv:${r.arxivId}`;
    parts.push(end(container));
  } else if (r.publisher) parts.push(end(r.publisher));
  const link = doiUrl(r);
  if (link) parts.push(link);
  return parts.join(" ");
}

/** IEEE-like: 'A. Gulati, J. Qin, and R. Pang, "Title," in Proc. Interspeech, 2020, pp. 5036–5040, doi: …' */
export function formatIeee(r: PaperRecord): string {
  const names = r.authors.map(ieeeName);
  let authors = "";
  if (names.length > 6) authors = `${names[0]} et al.`;
  else if (names.length === 1) authors = names[0]!;
  else if (names.length === 2) authors = `${names[0]} and ${names[1]}`;
  else if (names.length > 2) authors = `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  const segs: string[] = [];
  const title = `“${r.title.replace(/[.]$/, "")},”`;
  const head = authors ? `${authors}, ${title}` : title;
  const bits: string[] = [];
  if (r.containerTitle) bits.push(r.type === "paper-conference" || r.type === "chapter" ? `in ${r.containerTitle}` : r.containerTitle);
  else if (r.type === "article" && r.arxivId) bits.push(`arXiv:${r.arxivId}`);
  if (r.volume) bits.push(`vol. ${r.volume}`);
  if (r.issue) bits.push(`no. ${r.issue}`);
  if (r.publisher && !r.containerTitle) bits.push(r.publisher);
  if (r.year) bits.push(r.month ? `${["Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec."][r.month - 1]} ${r.year}` : String(r.year));
  if (r.pages) bits.push(r.pages.includes("–") ? `pp. ${r.pages}` : `p. ${r.pages}`);
  if (r.doi) bits.push(`doi: ${r.doi}`);
  segs.push(head);
  if (bits.length) segs.push(`${bits.join(", ")}.`);
  else segs[0] = segs[0]!.replace(/,”$/, ".”");
  return segs.join(" ");
}

export type CitationStyle = "apa" | "ieee";

export function formatCitation(r: PaperRecord, style: CitationStyle = "apa"): string {
  return style === "ieee" ? formatIeee(r) : formatApa(r);
}
