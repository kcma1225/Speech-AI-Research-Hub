import { t } from "#lib/i18n.svelte.ts";
import type { PaperAuthor, PaperRecord, PaperSummary } from "./types.ts";

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

export function authorName(a: PaperAuthor): string {
  if (a.literal) return a.literal;
  const fam = [a.particle, a.family].filter(Boolean).join(" ");
  if (CJK.test(fam) && a.given && CJK.test(a.given)) return `${fam}${a.given}`;
  return [a.given, fam, a.suffix].filter(Boolean).join(" ").trim();
}

/** "Gulati, Qin, Chiu et al." (max `n` names). */
export function authorsShort(authors: PaperAuthor[] | undefined, n = 3): string {
  const list = authors ?? [];
  if (!list.length) return t("library.noAuthors");
  const names = list.slice(0, n).map(a => a.family ?? a.literal ?? a.given ?? "").filter(Boolean);
  return names.join(", ") + (list.length > n ? " et al." : "");
}

export const authorsFull = (authors: PaperAuthor[] | undefined) => (authors ?? []).map(authorName).join(", ");

/** "Interspeech 2020" / container title. */
export function venueLine(p: Pick<PaperSummary, "venue" | "container_title" | "year">): string {
  return [p.venue ?? p.container_title, p.year].filter(Boolean).join(" · ");
}

export const recordVenue = (r: PaperRecord) => [r.venue ?? r.containerTitle, r.year].filter(Boolean).join(" · ");

/** One author per line: "Family, Given" or a literal name. */
export function authorsToText(authors: PaperAuthor[]): string {
  return authors.map(a => (a.literal ? a.literal : [[a.particle, a.family].filter(Boolean).join(" "), a.given].filter(Boolean).join(", "))).join("\n");
}

export function textToAuthors(text: string): PaperAuthor[] {
  return text
    .split(/\n|;/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      if (l.includes(",")) {
        const [family, ...rest] = l.split(",");
        return { family: family!.trim(), given: rest.join(",").trim() || undefined };
      }
      if (CJK.test(l) || !l.includes(" ")) return { literal: l };
      const parts = l.split(/\s+/);
      return { family: parts.pop()!, given: parts.join(" ") };
    });
}

export const doiUrl = (doi: string) => `https://doi.org/${doi}`;
export const arxivUrl = (id: string) => `https://arxiv.org/abs/${id}`;
export const pdfUrl = (paperId: string, download = false) => `/api/library/papers/${paperId}/pdf${download ? "?download=1" : ""}`;
