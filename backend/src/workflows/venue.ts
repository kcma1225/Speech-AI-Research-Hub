/**
 * Where the run's paper was published (production 61666f10: the user asked for 「哪個會議哪一年」 on the first page; the
 * library only knew 「arXiv」, the deck said the paper was not a conference paper, and the venue landed in page 2's notes).
 * `venueFacts` looks the published version up once per run (lib/library/published.ts; only the paper's stored identifiers
 * leave the hub — fine on a tainted run) and remembers it in `state.venue_facts`; `fillVenueTerms` turns a venue
 * requirement (requirements.ts `params.venue`) into a checked one: the label's words must be on the page.
 */
import { authorFamily } from "../lib/library/normalize.js";
import { getPaper } from "../lib/library/store.js";
import { preprintOnly, refreshPublished, venueLabel } from "../lib/library/published.js";
import { libraryService, onlineLookupsAllowed } from "../lib/library/settings.js";
import type { WorkflowEnv } from "./env.js";
import type { Criterion, Requirement, RequirementTerm } from "./types.js";
import "../lib/artifacts/facts.js";

export type VenueFacts = {
  paper_id: string;
  /** 「Interspeech 2024」, 「arXiv 2024」 (preprint only), 「2024」. */
  label: string;
  venue: string | null;
  year: number | null;
  doi: string | null;
  /** The library knows only a preprint (no published version found / looked up). */
  preprint: boolean;
  /** First author's family name and whether there are more (the Lab-Hub cover: 「Andrusenko et al., Interspeech 2024」). */
  first_author: string | null;
  more_authors: boolean;
  lookup: "updated" | "unchanged" | "published" | "not_found" | "skipped" | "failed";
};

const runPaperId = (env: WorkflowEnv): string | null => {
  const id = (env.run.inputs.paper_id as string | undefined) ?? (env.run.context.paperId as string | undefined) ?? null;
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
};

/** The run's paper's venue (looked up online once when the library only has a preprint); null without a paper. */
export async function venueFacts(env: WorkflowEnv, paperId = runPaperId(env)): Promise<VenueFacts | null> {
  if (!paperId) return null;
  const cached = env.state<VenueFacts>("venue_facts");
  if (cached?.paper_id === paperId) return cached;
  let paper = await getPaper(env.db, paperId);
  if (!paper) return null;
  let lookup: VenueFacts["lookup"] = "published";
  if (preprintOnly(paper)) {
    if (!onlineLookupsAllowed()) lookup = "skipped";
    else {
      try {
        const { service } = await libraryService(env.db);
        const r = await refreshPublished(env.db, service, paper, env.user.id, { signal: env.signal });
        paper = r.paper;
        lookup = r.status;
        if (r.status === "updated") await env.note(`文獻庫原本只有預印本紀錄（${venueLabel({ venue: r.before.venue, year: r.before.year }) || "沒有出處"}），已查到正式發表出處並更新：${venueLabel(paper)}${paper.doi ? `（DOI ${paper.doi}）` : ""}。`);
      } catch (e) {
        lookup = "failed";
        env.deps.log.warn({ err: e, paperId, workflowId: env.run.id }, "published-version lookup failed");
      }
    }
  }
  const authors = paper.record.authors ?? [];
  const first = authorFamily(authors[0]).trim() || null;
  const facts: VenueFacts = { paper_id: paper.id, label: venueLabel(paper), venue: paper.venue, year: paper.year, doi: paper.doi, preprint: preprintOnly(paper), first_author: first, more_authors: authors.length > 1, lookup };
  await env.setState({ venue_facts: facts });
  return facts;
}

/** The words a page must show for a venue requirement: the venue (any case) and the year. */
export function venueTerms(f: Pick<VenueFacts, "venue" | "year">): RequirementTerm[] {
  const out: RequirementTerm[] = [];
  const v = f.venue?.trim();
  if (v) out.push({ name: v, aliases: [v.toUpperCase(), v.toLowerCase()] });
  if (f.year) out.push({ name: String(f.year) });
  return out;
}

/** The cover subtitle's venue part: 「Interspeech 2024」, a preprint 「arXiv preprint 2024」. */
export const coverVenue = (f: VenueFacts | null) => (!f?.label ? "" : f.preprint && /arxiv/i.test(f.venue ?? "") ? `arXiv preprint${f.year ? ` ${f.year}` : ""}` : f.label);

/**
 * The Lab-Hub paper-report cover subtitle (skills/labhub-report/templates/paper_report.qmd: 「〔第一作者 et al., 會議 年份〕」):
 * 「Andrusenko et al., Interspeech 2024」; null when the paper's venue and year are unknown.
 */
export function coverCitation(f: VenueFacts | null): string | null {
  const where = coverVenue(f);
  if (!f || !where) return null;
  const who = f.first_author ? `${f.first_author}${f.more_authors ? " et al." : ""}` : "";
  return [who, where].filter(Boolean).join(", ");
}

/** Venue requirements get the paper's facts: checked words + the label in their text (the plan card shows it). */
export function withVenueTerms(reqs: Requirement[], f: VenueFacts | null): Requirement[] {
  if (!f) return reqs;
  const terms = venueTerms(f);
  return reqs.map((r) => {
    if (!r.params?.venue || !terms.length) return r;
    const text = r.text.replace(/（以查證過的正式出處為準）|：[^：]*（[^）]*出處[^）]*）$/, "");
    const note = f.preprint ? `${coverVenue(f)}（文獻庫只有預印本紀錄${f.lookup === "not_found" ? "，查不到正式發表版本" : ""}）` : `${f.label}（查證過的正式出處）`;
    return { ...r, text: `${text}：${note}`, params: { ...r.params, terms } };
  });
}

/** Fills the run's venue requirements (state.requirements) once the paper is known. */
export async function fillVenueTerms(env: WorkflowEnv): Promise<void> {
  const reqs = env.state<Requirement[]>("requirements") ?? [];
  if (!reqs.some((r) => r.params?.venue && !r.params.terms?.length)) return;
  const next = withVenueTerms(reqs, await venueFacts(env));
  if (JSON.stringify(next) !== JSON.stringify(reqs)) await env.setState({ requirements: next });
}

/** The criterion that a run's claims about its paper's venue match the library record (check `bib_claims`). */
export function bibCriterion(f: VenueFacts): Omit<Criterion, "status"> {
  return {
    id: "bib", kind: "check",
    text: f.preprint ? "沒有沒查證的出處說法：文獻庫只有預印本紀錄，不寫「不是會議論文」或沒查證的會議" : `提到論文出處時和文獻庫紀錄一致（${f.label}），沒有「不是會議論文」這類說法`,
    check: { id: "bib_claims", params: { venue: f.venue, year: f.year, preprint: f.preprint, first_author: f.first_author } },
  };
}
