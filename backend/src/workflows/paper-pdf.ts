/**
 * A paper run whose paper has no PDF (docs/architecture.md "Workflows" → Missing PDFs). Before giving up the run tries,
 * with the owner's library permissions: (1) the library's open-access resolution (`autoFetchPdf` → arXiv / ACL / ISCA /
 * Unpaywall / OpenAlex / Semantic Scholar; identifiers only leave the hub, as for a library import), (2) the URLs in the
 * paper record (`oa_url`, CSL `URL` / `link`) through the PDF-from-URL service. Still missing →
 * - autopilot: the run is **skipped** with status `needs_pdf` (「需要 PDF」) and the card offers 「從網址下載 PDF」 /
 *   upload, then re-plans (`POST /workflows/:id/pdf-url`, resume);
 * - otherwise: a question card 「〈…〉沒有 PDF」 with 提供網址 / 上傳 PDF / 只用摘要 / 跳過 (answers: `url` → download and
 *   continue, `upload` → `needs_pdf`, `abstract` → an abstract-only run, clearly marked, `skip` → the run ends skipped).
 */
import { paperPermissions } from "../lib/library/detail.js";
import { getPaper, type PaperRow } from "../lib/library/store.js";
import { askUser, asksOf } from "./questions.js";
import type { WorkflowEnv } from "./env.js";
import type { PlanResult } from "./playbooks/registry.js";

type Deps = {
  autoFetch: (env: WorkflowEnv, paper: PaperRow) => Promise<{ status: string; message?: string }>;
  fromUrl: (env: WorkflowEnv, paper: PaperRow, url: string) => Promise<void>;
};

const realDeps: Deps = {
  async autoFetch(env, paper) {
    const { autoFetchPdf } = await import("../lib/library/auto-pdf.js");
    return autoFetchPdf(env.db, env.storage, paper, env.user.id, { budgetMs: 25_000, queueOnFailure: false, signal: env.signal });
  },
  async fromUrl(env, paper, url) {
    const [{ attachPdfFromUrl }, { libraryService }] = await Promise.all([import("../lib/library/pdf-url.js"), import("../lib/library/settings.js")]);
    const { service } = await libraryService(env.db);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40_000);
    const onAbort = () => ctrl.abort();
    env.signal.addEventListener("abort", onAbort);
    try {
      await attachPdfFromUrl(env.db, env.storage, service, { paperId: paper.id, url, userId: env.user.id, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      env.signal.removeEventListener("abort", onAbort);
    }
  },
};
let deps: Deps = realDeps;
/** Tests: replace the network parts. */
export const setPaperPdfDeps = (d: Partial<Deps> | null) => {
  deps = d ? { ...realDeps, ...d } : realDeps;
};

/** URLs in the paper record worth trying (landing pages are resolved by the PDF-from-URL service). */
export function recordUrls(paper: Pick<PaperRow, "oa_url" | "record">): string[] {
  const rec = (paper.record ?? {}) as { URL?: unknown; url?: unknown; link?: unknown };
  const links = Array.isArray(rec.link) ? rec.link.map((l) => (l && typeof l === "object" ? (l as { URL?: unknown }).URL : l)) : [];
  const out = [paper.oa_url, rec.URL, rec.url, ...links].filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u.trim())).map((u) => u.trim());
  return [...new Set(out)].slice(0, 3);
}

/** Tries open access, then the record's URLs. Returns the (reloaded) paper. */
export async function tryFetchPdf(env: WorkflowEnv, paper: PaperRow): Promise<{ paper: PaperRow; tried: string[] }> {
  if (paper.pdf_key) return { paper, tried: [] };
  const tried: string[] = [];
  if (!(await paperPermissions(env.db, paper, env.user)).edit) return { paper, tried };
  await env.activity("research", "researcher", `〈${paper.title.slice(0, 40)}〉沒有 PDF：查詢開放取用全文`);
  tried.push("開放取用（arXiv／ACL／ISCA／Unpaywall／OpenAlex／Semantic Scholar）");
  const oa = await deps.autoFetch(env, paper).catch((e: unknown) => ({ status: "failed", message: (e as Error).message }));
  let fresh = (await getPaper(env.db, paper.id)) ?? paper;
  if (fresh.pdf_key) {
    await env.note(`已自動取得〈${paper.title.slice(0, 60)}〉的開放取用 PDF。`);
    return { paper: fresh, tried };
  }
  if (oa.status === "failed" && oa.message) env.deps.log.info({ workflowId: env.run.id, paperId: paper.id }, `open access lookup failed: ${oa.message}`);
  for (const url of recordUrls(fresh)) {
    tried.push(url);
    await env.activity("research", "researcher", `從文獻紀錄的網址下載 PDF：${url.slice(0, 80)}`);
    try {
      await deps.fromUrl(env, fresh, url);
    } catch {
      continue;
    }
    fresh = (await getPaper(env.db, paper.id)) ?? fresh;
    if (fresh.pdf_key) {
      await env.note(`已從文獻紀錄的網址取得〈${paper.title.slice(0, 60)}〉的 PDF。`);
      return { paper: fresh, tried };
    }
  }
  return { paper: fresh, tried };
}

export type PdfDecision = { kind: "ok"; paper: PaperRow } | { kind: "abstract"; paper: PaperRow } | Extract<PlanResult, { kind: "needs_pdf" | "skip" }>;

const cardId = (paperId: string, n: number) => `pdf_${paperId.slice(0, 8)}_${n}`;

/**
 * The planning-time decision for a paper without a PDF (see the module comment). Throws WorkflowStop("ask") when the
 * user has to choose (outside autopilot).
 */
export async function ensurePaperPdf(env: WorkflowEnv, paper: PaperRow, opts: { allowAbstract?: boolean } = {}): Promise<PdfDecision> {
  const allowAbstract = opts.allowAbstract ?? true;
  if (paper.pdf_key) return { kind: "ok", paper };
  // Answers to earlier cards (newest first): a URL that failed asks again with a new card.
  const asks = asksOf(env.run.state);
  let n = 0;
  while (asks[cardId(paper.id, n + 1)]) n++;
  const last = n ? asks[cardId(paper.id, n)] : undefined;
  const choice = last?.answers?.find((a) => a.id === "how")?.value;
  const url = String(last?.answers?.find((a) => a.id === "url")?.value ?? "").trim();
  if (choice === "abstract" && allowAbstract) return { kind: "abstract", paper };
  if (choice === "skip") return { kind: "skip", message: `已依你的選擇跳過〈${paper.title.slice(0, 80)}〉（沒有 PDF）。` };
  let failed = "";
  if (choice === "url" && url) {
    try {
      await deps.fromUrl(env, paper, url);
    } catch (e) {
      failed = (e as Error).message || "下載失敗";
    }
    const fresh = (await getPaper(env.db, paper.id)) ?? paper;
    if (fresh.pdf_key) return { kind: "ok", paper: fresh };
    failed ||= "下載的不是 PDF";
  }
  const message = `〈${paper.title.slice(0, 80)}〉找不到 PDF（已試過開放取用與文獻紀錄的網址），這份先跳過：貼上 PDF 網址按「從網址下載 PDF」，或到文獻庫上傳後按「繼續」。`;
  if (choice === "upload") return { kind: "needs_pdf", paperId: paper.id, message };
  if (!last || last.answers) {
    // First time (or a failed URL): retrieval first, then ask / skip.
    if (!last) {
      const got = await tryFetchPdf(env, paper);
      if (got.paper.pdf_key) return { kind: "ok", paper: got.paper };
    }
    if (env.run.autopilot) return { kind: "needs_pdf", paperId: paper.id, message };
    await askUser(env, {
      id: cardId(paper.id, n + 1),
      title: `〈${paper.title.slice(0, 60)}〉沒有 PDF`,
      intro: `${failed ? `剛才的網址沒有成功（${failed.slice(0, 120)}）。` : "已試過開放取用（arXiv、ACL、ISCA、Unpaywall、OpenAlex、Semantic Scholar）與文獻紀錄的網址，都沒有拿到 PDF。"}要怎麼處理這一篇？`,
      questions: [
        { id: "how", prompt: "怎麼處理沒有 PDF 的這篇？", type: "single_choice", required: true, options: [
          { value: "url", label: "提供網址", description: "貼上 PDF 或論文頁面的網址，我下載後繼續。" },
          { value: "upload", label: "上傳 PDF", description: "我到文獻庫上傳 PDF，之後按「繼續」。" },
          ...(allowAbstract ? [{ value: "abstract", label: "只用摘要", description: "只依摘要做，成果會清楚標示「僅依摘要」。" }] : []),
          { value: "skip", label: "跳過這篇", description: "這篇先不做。" },
        ] },
        { id: "url", prompt: "PDF 網址（選「提供網址」時填）", type: "short_text", required: false, placeholder: "https://arxiv.org/abs/…" },
      ],
      step_key: null,
      purpose: "input",
      ai_suggested: false,
    });
  }
  return { kind: "needs_pdf", paperId: paper.id, message };
}

/** Research brief of an abstract-only run (clearly marked). */
export function abstractBrief(paper: PaperRow): string {
  return [
    `# 僅依摘要（沒有全文 PDF）`,
    `論文：〈${paper.title}〉${paper.year ? `（${paper.year}）` : ""}${paper.venue ? `，${paper.venue}` : ""}`,
    paper.authors_text ? `作者：${paper.authors_text}` : "",
    `## 摘要\n${paper.abstract?.trim() || "（文獻紀錄沒有摘要）"}`,
    "注意：只讀得到摘要；方法細節、公式、實驗數字與圖表都沒有讀到，不要補寫或推測，需要時寫「摘要未提供」。",
  ].filter(Boolean).join("\n\n");
}
