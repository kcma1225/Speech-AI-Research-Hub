/**
 * The sources the content checks compare against (lib/slides/content-lint.ts), built once per run and cached in the
 * run state: name-like terms of the brief + the paper's full text (references excluded: a name that is only cited is
 * not something the paper uses) + the request, sentences about training, and the paper's measured figure list.
 * Steps pass them to the checks as `data.refs` (checks stay pure).
 */
import { paperFullText } from "../lib/library/fulltext.js";
import { listFigures } from "../lib/library/figure-locate.js";
import { sourceTerms, trainingSentences, type ContentRefs, type RefFigure } from "../lib/slides/content-lint.js";
import type { WorkflowEnv } from "./env.js";

type Cached = { terms: string[]; training: string; figures: RefFigure[] };

/** Figures / tables of the paper measured from the PDF layout (cached per run; [] without a PDF). */
export async function paperFigures(env: WorkflowEnv, pdfKey: string | null | undefined): Promise<RefFigure[]> {
  const cached = env.state<RefFigure[]>("figures");
  if (Array.isArray(cached)) return cached;
  const pdf = pdfKey ? await env.storage.getBuffer(pdfKey).catch(() => null) : null;
  const figs = pdf ? await listFigures(pdf, { maxPages: 16, max: 14 }).catch(() => []) : [];
  const out = figs.map((f) => ({ label: f.label, page: f.page, top: f.box.top, bottom: f.box.bottom, left: f.box.left, right: f.box.right, caption: f.caption.replace(/\s+/g, " ").slice(0, 200) }));
  await env.setState({ figures: out });
  return out;
}

/**
 * Builds (once) and caches the run's content refs. `brief` = the research brief / study data the writers get;
 * `pdfKey` = the paper (full text + figures), when there is one.
 */
export async function buildContentRefs(env: WorkflowEnv, opts: { brief: string; pdfKey?: string | null; extra?: string[] }): Promise<Cached> {
  const cached = env.state<Cached>("content_refs");
  if (cached?.terms) return cached;
  const ft = opts.pdfKey ? await paperFullText(env.storage, opts.pdfKey).catch(() => null) : null;
  const body = ft ? ft.sections.filter((s) => s.kind !== "references").map((s) => `${s.title}\n${s.text}`).join("\n") : "";
  const texts = [opts.brief, body, env.run.request, env.run.title, ...(opts.extra ?? [])];
  const out: Cached = { terms: sourceTerms(texts), training: trainingSentences([opts.brief, body]), figures: await paperFigures(env, opts.pdfKey) };
  await env.setState({ content_refs: out });
  return out;
}

/** The refs for a check (`data.refs`): the cached ones + names in the user's later guidance; {} before they exist. */
export function contentRefsOf(env: WorkflowEnv, outline?: { title: string; points: string[] }[]): ContentRefs {
  const c = env.state<Cached>("content_refs");
  if (!c?.terms) return outline ? { outline } : {};
  const guidance = (env.run.guidance ?? []).map((g) => g.text);
  const terms = guidance.length ? [...new Set([...c.terms, ...sourceTerms(guidance)])] : c.terms;
  return { terms, training: c.training, figures: c.figures, ...(outline ? { outline } : {}) };
}
