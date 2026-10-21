import { t } from "#lib/i18n.svelte.ts";
import type { PaperDraft } from "#lib/components/library/PaperForm.svelte";
import { authorsToText, textToAuthors } from "./format.ts";
import type { PaperRecord } from "./types.ts";

export const emptyDraft = (): PaperDraft => ({
  type: "article-journal", title: "", authors: "", year: "", containerTitle: "", venue: "", volume: "", issue: "", pages: "", publisher: "", doi: "", arxivId: "", url: "", abstract: "",
});

export const draftOf = (r: PaperRecord): PaperDraft => ({
  type: r.type,
  title: r.title ?? "",
  authors: authorsToText(r.authors ?? []),
  year: r.year ? String(r.year) : "",
  containerTitle: r.containerTitle ?? "",
  venue: r.venue ?? "",
  volume: r.volume ?? "",
  issue: r.issue ?? "",
  pages: r.pages ?? "",
  publisher: r.publisher ?? "",
  doi: r.doi ?? "",
  arxivId: r.arxivId ?? "",
  url: r.url ?? "",
  abstract: r.abstract ?? "",
});

/** Validates a draft; returns field errors or the record (merged over `base` so unshown fields survive). */
export function recordOf(d: PaperDraft, base: Partial<PaperRecord> = {}): { errors: Partial<Record<keyof PaperDraft, string>>; record?: PaperRecord } {
  const errors: Partial<Record<keyof PaperDraft, string>> = {};
  if (!d.title.trim()) errors.title = t("library.form.titleRequired");
  const year = d.year.trim() ? Number(d.year.trim()) : undefined;
  if (year !== undefined && (!Number.isInteger(year) || year < 1000 || year > 3000)) errors.year = t("library.form.yearInvalid");
  if (d.url.trim() && !/^https?:\/\//i.test(d.url.trim())) errors.url = t("library.form.urlInvalid");
  if (Object.keys(errors).length) return { errors };
  const s = (v: string) => v.trim() || undefined;
  const { citeKey: _c, ...rest } = base as PaperRecord;
  const record: PaperRecord = {
    ...rest,
    type: d.type,
    title: d.title.trim().replace(/\s+/g, " "),
    authors: textToAuthors(d.authors),
    year,
    containerTitle: s(d.containerTitle),
    venue: s(d.venue),
    volume: s(d.volume),
    issue: s(d.issue),
    pages: s(d.pages),
    publisher: s(d.publisher),
    doi: s(d.doi),
    arxivId: s(d.arxivId),
    url: s(d.url),
    abstract: s(d.abstract),
  };
  return { errors, record };
}
