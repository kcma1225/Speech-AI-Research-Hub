/**
 * Note-producing playbooks: 閱讀筆記 (reading_note), 文獻回顧 (lit_review), 實驗報告筆記 (experiment_report),
 * 會議準備 (meeting_prep) and the free-form generic planner. Parts are written by sub-agents (parallel where
 * independent), verified, assembled in memory, verified against the objective, and committed once as a NEW note.
 */
import { transaction } from "../../db.js";
import { paperFullText, type PaperSection } from "../../lib/library/fulltext.js";
import { createNote, noteUrl, type NoteKind } from "../../lib/notes/store.js";
import { createSuggestion } from "../../lib/suggestions/service.js";
import { loadStudyAccess, type StudyAccess } from "../../lib/studies/access.js";
import { taipeiToday } from "../../lib/slides/templates.js";
import { requireEditor, WorkflowInputError } from "../engine.js";
import { dataBlock } from "../llm.js";
import { addArtifact, getSteps } from "../store.js";
import type { WorkflowEnv } from "../env.js";
import { type CheckSpec, type Criterion, type OutlineItem, type StepOutput, type StepRole, type StepRow, type StepSpec } from "../types.js";
import { clipText, depOutputs, paperOf, requireStudy, systemFor, taskPrompt } from "./common.js";
import { requestLine } from "../brief.js";
import { currentRoute, splitBatch } from "../route.js";
import { askUser } from "../questions.js";
import { askStudentView, isAiFilled } from "../student-input.js";
import { localizeHeadings, runLabels, targetLanguage } from "../requirements.js";
import { ensurePaperPdf } from "../paper-pdf.js";
import { buildContentRefs, contentRefsOf } from "../content-refs.js";
import { generateUnit, stitch, unitContext, unitTokens, type Unit, type UnitBudget } from "../units.js";
import { registerWorkflowPlaybook, type PlanResult, type WorkflowPlaybook } from "./registry.js";

type Fix = { previous: StepOutput; issues: string[] } | null;

/** Read tools a researcher may use (the assistant's own read tools; permissions and taint as in the chat). */
export const RESEARCH_TOOLS = [
  "get_study", "get_study_progress", "list_notes", "get_note", "list_tasks", "list_papers", "get_paper", "read_paper", "view_paper_pages",
  "search", "list_decks", "get_deck", "get_deck_pages", "get_deck_reviews", "list_meetings", "get_meeting", "get_transcript_excerpt",
  "latex_list_projects", "latex_read_file", "get_study_bibtex", "get_recent_activity", "search_papers_online",
];

const PART_CHECKS: CheckSpec[] = [{ id: "min_length", params: { chars: 150 } }, { id: "no_placeholder" }, { id: "not_truncated" }];

export async function studyOrQuestion(env: WorkflowEnv): Promise<StudyAccess | { question: string }> {
  const access = await requireStudy(env, "這份成果");
  if ("question" in access) return access;
  if (!access.canEdit) return { question: `你不是〈${access.study.title}〉的成員，工作流程不能在這裡建立筆記。請指定你參與的研究。` };
  return access;
}

/** Assemble step: parts in outline order under the note title, stitched deterministically (no model call). */
function assembleSpec(partKeys: string[], sections: string[]): StepSpec {
  return {
    key: "assemble", role: "integrator", kind: "integrate", title: "整合成一份筆記", instructions: "依大綱順序整合各段內容。",
    depends_on: partKeys, expected: "完整筆記",
    verify: { checks: [{ id: "sections_present", params: { sections } }, { id: "no_placeholder" }, { id: "not_truncated" }], judge: false },
  };
}
export const finalSpec = (dep = "assemble"): StepSpec => ({ key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "依目標逐條驗收。", depends_on: [dep], expected: "每一條驗收標準都通過" });

async function assembleDoc(env: WorkflowEnv, step: StepRow): Promise<StepOutput> {
  const steps = await getSteps(env.db, env.run.id);
  const parts = step.depends_on.map((k) => steps.find((s) => s.key === k)).filter((s): s is StepRow => !!s?.output?.text);
  const title = env.state<string>("note_title") ?? env.run.title;
  const text = stitch(parts.map((p) => p.output!.text!), { title });
  await env.setState({ doc: text });
  return { summary: `整合 ${parts.length} 段，共 ${text.length} 字`, text };
}

/** The outline units of a note playbook (`state.units`): one per writer step, each with its purpose and length budget. */
export function noteUnits(steps: StepSpec[], budgets: Record<string, UnitBudget | undefined>): Unit[] {
  return steps.filter((s) => budgets[s.key]).map((s) => ({ key: s.key, title: s.title, purpose: s.expected, budget: budgets[s.key] }));
}

/**
 * One unit of a note (a section): the step's task + its length budget and neighbours (units.ts), generated in its own call;
 * a reply cut at the output limit is continued / regenerated for this unit only.
 */
export async function writePart(env: WorkflowEnv, step: StepRow, fix: Fix, context: Record<string, string>, format: string, aiRole?: "writing" | "assistant") {
  const u = await unitContext(env, step, targetLanguage(env.requirements()));
  const user = taskPrompt(env, step, { context, format: [format, u.budget, u.neighbours].filter(Boolean).join("\n") }, fix);
  const res = await generateUnit(env, { purpose: `write:${env.run.playbook}`, role: step.role === "researcher" ? "researcher" : "writer", aiRole: aiRole ?? (step.role === "writer" ? "writing" : undefined), messages: [{ role: "system", content: systemFor(step.role) }, { role: "user", content: user }], maxTokens: unitTokens(u.unit?.budget, 8000) }, step.id);
  return { summary: `${res.text.length} 字${res.continued ? `（接續寫完 ${res.continued} 次）` : ""}${res.regenerated ? "（重寫精簡版）" : ""}${res.truncated ? "（輸出仍被截斷）" : ""}`, text: res.text };
}

/** Commit: the assembled note, once. A partial run says so at the top. */
export async function commitNote(env: WorkflowEnv, outcome: "done" | "partial", kind: NoteKind) {
  const doc = env.state<string>("doc");
  if (!doc) return outcome === "partial" ? "筆記沒有寫入（流程在整合前就停止了）。" : null;
  if (!env.run.study_id) return null;
  const access = await requireEditor(env, env.run.study_id);
  const existing = env.state<string>("note_id");
  if (existing) {
    // 繼續改 after the note was created: the improved text is a suggestion on that note (the user may have edited it).
    if (env.state<string>("committed_doc") === doc) return null;
    const s = await createSuggestion({ db: env.db, collab: null }, { targetType: "note", targetId: existing, proposedText: doc, title: "Agent：繼續改", source: "ai", actorId: env.user.id, conversationId: env.run.conversation_id, user: env.user }).catch((e: Error) => {
      if (/相同/.test(e.message)) return null;
      throw e;
    });
    await env.setState({ committed_doc: doc });
    if (!s) return null;
    await addArtifact(env.db, env.run.id, { kind: "note", id: existing, url: `${noteUrl(access.study.slug, existing)}?suggestion=${s.id}`, title: env.state<string>("note_title") ?? "筆記", role: "suggestion" });
    return "修正後的內容已做成筆記的修改建議，請在筆記中逐段接受。";
  }
  const title = clipText(env.state<string>("note_title") ?? env.run.title, 190);
  const unmet = env.run.criteria.filter((c) => c.status !== "pass");
  // The playbook's fixed section headings in the note's language (an English note gets no Chinese headings).
  const localized = await localizeHeadings(env, doc);
  const body = outcome === "partial" && unmet.length ? `${runLabels(env).partialBanner(unmet.map((c) => c.text))}\n\n${localized}` : localized;
  const id = await transaction(env.db, async (client) => {
    const locked = await loadStudyAccess(client, access.study.id, env.user, { forUpdate: true });
    if (!locked.canEdit) throw new WorkflowInputError("你已經不是這個研究的成員。");
    return createNote(client, { studyId: locked.study.id, studySlug: locked.study.slug, title, templateId: null, kind, contentMd: body, eventDate: taipeiToday(), actorId: env.user.id, author: "ai" });
  });
  await env.setState({ note_id: id, committed_doc: doc });
  await addArtifact(env.db, env.run.id, { kind: "note", id, url: noteUrl(access.study.slug, id), title, role: "draft" });
  return `已建立新筆記〈${title}〉。`;
}

export const outlineFrom = (sections: { title: string; points?: string[] }[]): OutlineItem[] => sections.map((s, i) => ({ n: i + 1, title: s.title, points: s.points ?? [] }));

// ---------------------------------------------------------------- 閱讀筆記

const mainSections = (secs: PaperSection[]) => secs.filter((s) => s.level === 1 && s.kind === "body" && !/^(?:references?|bibliography|acknowledge?ments?|參考文獻|致謝)$/i.test(s.title.trim()));

const readingNote: WorkflowPlaybook = {
  id: "reading_note",
  title: "閱讀筆記",
  titleEn: "Reading note",
  description: "逐章讀論文全文（含公式），分段撰寫深度閱讀筆記，驗收是否涵蓋每一章",
  descriptionEn: "Read the paper section by section (with equations), write a deep reading note, verify every section is covered",
  autoApprovable: true,
  detect: (req, inputs) => (/閱讀筆記|讀書筆記|reading note|精讀|整理.*論文.*筆記|論文筆記/i.test(req) ? 0.85 : inputs.paper_id && /筆記|note/i.test(req) ? 0.6 : 0),
  async plan(env): Promise<PlanResult> {
    const access = await studyOrQuestion(env);
    if ("question" in access) return { kind: "question", question: access.question, setup: true };
    // 「每一篇文獻」 whose study was only found now: the router's batch, and this run ends.
    const r = await currentRoute(env);
    if (r?.batch && !env.run.batch_id) {
      const message = await splitBatch(env, "reading_note");
      if (message) return { kind: "skip", message };
    }
    let paper = await paperOf(env);
    if (!paper) {
      // A topic survey without a paper never gets here: the router sends it to topic research (route.ts).
      return { kind: "question", question: "要讀哪一篇論文？請先把論文加入文獻庫（或附加它），再在補充指示寫出論文標題。" };
    }
    if (!paper.pdf_key) {
      // Open access + the record's URLs first; autopilot skips (needs_pdf), otherwise the user chooses (paper-pdf.ts).
      const d = await ensurePaperPdf(env, paper, { allowAbstract: false });
      if (d.kind === "needs_pdf" || d.kind === "skip") return d;
      paper = d.paper;
      if (!paper.pdf_key) return { kind: "needs_pdf", paperId: paper.id, message: `〈${paper.title}〉還沒有 PDF，無法讀全文。` };
    }
    const ft = await paperFullText(env.storage, paper.pdf_key).catch(() => null);
    // Names + figure list the parts are checked against (grounded_names / figure_refs, content-refs.ts).
    await buildContentRefs(env, { brief: "", pdfKey: paper.pdf_key, extra: [paper.title] });
    const main = ft ? mainSections(ft.sections) : [];
    const hasMath = !!ft?.sections.some((s) => /[=∑∫√]|\\frac|argmax|log\s*p/.test(s.text));
    // Parts: overview, then the paper's main sections in groups of ≤ 2, then my questions / relation to my study.
    const groups: PaperSection[][] = [];
    // One paper section per part: a part covering two long sections overflows a cheap model's output.
    for (const sec of main.slice(0, 8)) groups.push([sec]);
    const sections = ["論文資訊與一句話總結", ...groups.map((g) => g.map((s) => `${s.number ? `${s.number} ` : ""}${s.title}`).join("／")), "限制、我的疑問與待追問", "與我研究的關係"];
    if (!groups.length) sections.splice(1, 0, "問題與動機", "方法（公式與符號）", "實驗與結果");
    await env.setState({ note_title: `閱讀筆記：${clipText(paper.title, 120)}`, has_math: hasMath, sections, paper_title: paper.title });
    const steps: StepSpec[] = sections.map((title, i) => {
      const g = groups.length ? groups[i - 1] : undefined;
      const isGroup = !!g && i >= 1 && i <= groups.length;
      const isMethod = isGroup && g!.some((s) => /method|approach|model|architecture|方法|formulation|framework/i.test(s.title));
      return {
        key: `part_${i + 1}`,
        role: "researcher" as StepRole,
        title: `撰寫「${clipText(title, 40)}」`,
        instructions: isGroup
          ? `用 read_paper 讀論文的 ${g!.map((s) => `§${s.number ?? s.title}（section: "${s.number ?? s.title}"）`).join("、")}，寫成筆記的「## ${title}」一段：重點、方法步驟、關鍵公式（LaTeX，逐一說明符號）、數字照原文並標出處（§、p.）。`
          : i === 0
            ? "讀目錄與摘要，寫「## 論文資訊與一句話總結」：標題、作者、年份、出處，一句話總結，以及要解決的問題與動機。"
            : i === sections.length - 1
              ? "根據研究的摘要與這篇論文，寫「## 與我研究的關係」：哪些方法或結論和研究有關、可以怎麼用（不替使用者決定方向，只說明關聯）。"
              : "寫「## 限制、我的疑問與待追問」：論文自述與明顯的限制、讀的時候不清楚的地方（標出處），以及值得追問的問題。",
        inputs: { paper_id: paper.id, sections: g?.map((s) => s.number ?? s.title) ?? [] },
        expected: `「## ${title}」一段（Markdown）`,
        verify: { checks: [...PART_CHECKS, { id: "sections_present", params: { sections: [title] } }, ...(isGroup ? [{ id: "source_refs", params: { min: 1 } }, { id: "grounded_names", params: { doc: true } }, { id: "figure_refs", params: { doc: true } }] : []), ...(isMethod && hasMath ? [{ id: "equations", params: { min: 1 } }] : [])], judge: isGroup },
      };
    });
    // 「我的想法」 (below) is the user's own judgement: ask with grounded options (student-input.ts) instead of inventing it.
    // Length budgets per part (a part covering one paper section; the overview and the closing parts are short).
    await env.setState({ units: noteUnits(steps, Object.fromEntries(steps.map((s, i) => [s.key, { chars: i === 0 ? 800 : i === steps.length - 1 ? 600 : i === steps.length - 2 ? 900 : 1800 }]))) });
    steps.push({ key: "my_view", role: "planner", title: "請你寫下自己的想法", instructions: "依筆記內容與研究資料草擬候選想法，向你提問；以你的回答寫成「## 我的想法」。", depends_on: steps.map((s) => s.key), expected: "「## 我的想法」（你的回答，或先跳過）", verify: { checks: [], judge: false } });
    steps.push(assembleSpec(steps.map((s) => s.key), sections), finalSpec());
    const criteria: Omit<Criterion, "status">[] = [
      { id: "coverage", kind: "check", text: "筆記涵蓋論文的每一個主要章節", check: { id: "sections_present", params: { sections } } },
      ...(hasMath ? [{ id: "math", kind: "check" as const, text: "方法部分寫出關鍵公式（LaTeX）並說明符號", check: { id: "equations", params: { min: 2 } } }] : []),
      { id: "refs", kind: "check", text: "重點標註出處（§／頁碼／表號）", check: { id: "source_refs", params: { min: Math.max(3, groups.length) } } },
      { id: "clean", kind: "check", text: "沒有佔位文字或被截斷的內容", check: { id: "no_placeholder" } },
      { id: "grounded", kind: "judge", text: "內容與數字都來自論文，沒有捏造；不確定處有明說" },
    ];
    return {
      kind: "plan",
      title: `閱讀筆記：${clipText(paper.title, 80)}`,
      studyId: access.study.id,
      objective: `為〈${clipText(paper.title, 100)}〉寫一份深度閱讀筆記：逐章讀全文${hasMath ? "（含公式）" : ""}，涵蓋每一個主要章節並標註出處。`,
      criteria,
      plan: { summary: `依論文目錄分成 ${sections.length} 段，由研究者子代理平行讀對應章節並撰寫，每段檢查出處${hasMath ? "與公式" : ""}，最後整合並逐條驗收。`, outline: outlineFrom(sections.map((t) => ({ title: t }))), writes: [{ kind: "note", label: `新筆記「閱讀筆記：${clipText(paper.title, 60)}」`, effect: "new" }] },
      steps,
    };
  },
  async execute(env, step, fix) {
    if (step.key === "assemble") return assembleDoc(env, step);
    if (step.key === "my_view") {
      const drafted = (await getSteps(env.db, env.run.id)).filter((s) => s.key.startsWith("part_") && s.output?.text).map((s) => s.output!.text!).join("\n\n");
      const got = await askStudentView(env, step, {
        cardId: "my_view", title: "讀完這篇，你自己的想法？",
        questions: [
          { id: "view", prompt: "你對這篇論文的看法？（可複選）", type: "multi_choice", hint: "這篇論文具體的優點、缺點或疑問，扣住筆記內容" },
          { id: "use", prompt: "這篇對你的研究有什麼用？", type: "multi_choice", hint: "和研究目前方向、階段、待解問題相關的具體用法或下一步" },
        ],
        context: { reading_note: drafted.slice(0, 12_000) },
      });
      const lines = [...(got.view ?? []), ...(got.use ?? [])];
      const ai = isAiFilled(env, "my_view") && lines.length > 0;
      const L = runLabels(env);
      return { summary: lines.length ? (ai ? `自動駕駛代填（${lines.length} 點，待你確認）` : `收到你的想法（${lines.length} 點）`) : "你選擇先跳過", text: `## ${L.myView}\n\n${ai ? `> **${L.aiFilled}**：${L.aiDraftBanner}\n\n` : ""}${lines.length ? lines.map((l) => `- ${l}`).join("\n") : L.laterOwn}\n` };
    }
    const title = (env.state<string[]>("sections") ?? [])[Number(step.key.slice(5)) - 1] ?? step.title;
    const paperId = String(step.inputs.paper_id ?? env.run.inputs.paper_id ?? "");
    const u = await unitContext(env, step, targetLanguage(env.requirements()));
    const user = taskPrompt(env, step, { context: { paper: `論文：〈${env.state<string>("paper_title") ?? ""}〉，paper_id ${paperId}（呼叫 read_paper / view_paper_pages 時用這個 paper_id）${env.run.study_id ? `；研究 study id ${env.run.study_id}` : ""}` }, format: [`只輸出「## ${title}」這一段的 Markdown（可以有 ### 小標），不要其他段落。`, u.budget, u.neighbours].filter(Boolean).join("\n") }, fix);
    const r = await env.researcher(step, { system: systemFor("researcher", "你讀完需要的內容後，直接寫出筆記的這一段。"), user, tools: ["read_paper", "view_paper_pages", "get_paper", "get_study"], maxToolSteps: 50, maxTokens: 10_000, purpose: "reading_part" });
    return { summary: `讀了 ${r.toolCalls} 次，寫了 ${r.text.length} 字`, text: r.text, data: { refs: contentRefsOf(env) } };
  },
  async finalText(env) {
    return { text: env.state<string>("doc") ?? "", data: null };
  },
  async repair(env, failing) {
    const sections = env.state<string[]>("sections") ?? [];
    const doc = env.state<string>("doc") ?? "";
    const out: { key: string; issues: string[] }[] = [];
    sections.forEach((t, i) => {
      if (!new RegExp(`^#{1,3}\\s+${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 20)}`, "m").test(doc)) out.push({ key: `part_${i + 1}`, issues: [`缺少「## ${t}」這一段。`] });
    });
    for (const c of failing) if (c.id === "math") out.push({ key: "part_2", issues: [c.reason ?? "需要寫出關鍵公式"] });
    return out.length ? out : failing.some((c) => c.kind === "judge") ? sections.slice(1, -2).map((_, i) => ({ key: `part_${i + 2}`, issues: failing.map((c) => `${c.text}：${c.reason ?? ""}`) })).slice(0, 4) : [];
  },
  commit: (env, outcome) => commitNote(env, outcome, "reading"),
};

// ---------------------------------------------------------------- 文獻回顧

type PaperPick = { id: string; title: string; cite_key: string; has_pdf: boolean; year: number | null };

async function studyPapers(env: WorkflowEnv, studyId: string): Promise<PaperPick[]> {
  const want = Array.isArray(env.run.inputs.paper_ids) ? (env.run.inputs.paper_ids as string[]) : null;
  const rows = (await env.db.query<PaperPick>(
    `SELECT p.id, p.title, sp.cite_key, (p.pdf_key IS NOT NULL) AS has_pdf, p.year FROM study_papers sp JOIN papers p ON p.id=sp.paper_id
      WHERE sp.study_id=$1 AND ($2::uuid[] IS NULL OR p.id = ANY($2)) ORDER BY (p.pdf_key IS NOT NULL) DESC, sp.created_at DESC LIMIT 6`,
    [studyId, want],
  )).rows;
  return rows.slice(0, 6);
}

const LIT_SECTIONS = ["研究背景與範圍", "方法比較表", "綜合分析", "研究缺口", "與本研究的關係"];
/** The synthesis units after the comparison table (one section each, with its length budget). */
const LIT_UNITS = [
  { key: "synthesis", section: "綜合分析", title: "撰寫「綜合分析」", cites: true, budget: { chars: 1400 }, instructions: "寫「## 綜合分析」：歸納各論文的共同點與差異（方法、資料、評估），引用時用 [@key]；不要逐篇重複摘要。" },
  { key: "gaps", section: "研究缺口", title: "撰寫「研究缺口」", cites: true, budget: { chars: 900 }, instructions: "寫「## 研究缺口」：這些論文尚未解決或彼此矛盾的問題（≤ 6 點，每點引用 [@key]）；只根據論文摘要，不替使用者決定研究方向。" },
  { key: "relation", section: "與本研究的關係", title: "撰寫「與本研究的關係」", cites: false, budget: { chars: 700 }, instructions: "寫「## 與本研究的關係」：哪些方法或結論和這個研究有關、可以參考什麼（≤ 5 點）；只說明關聯，不替使用者決定方向或時程。" },
];

const litReview: WorkflowPlaybook = {
  id: "lit_review",
  title: "文獻回顧",
  titleEn: "Literature review",
  description: "平行精讀研究中的多篇論文 → 比較表 → 綜合分析與研究缺口（引用文獻庫的 cite key）",
  descriptionEn: "Read several study papers in parallel → comparison table → synthesis and gaps (citing library keys)",
  autoApprovable: true,
  detect: (req) => (/文獻回顧|文獻探討|related work|literature review|survey|比較.*論文|整理.*文獻/i.test(req) ? 0.85 : 0),
  async plan(env) {
    const access = await studyOrQuestion(env);
    if ("question" in access) return { kind: "question", question: access.question, setup: true };
    const papers = await studyPapers(env, access.study.id);
    if (papers.length < 2) {
      // Too few papers: offer topic research (search online, import, read) instead of refusing. Autopilot switches
      // directly — the topic plan still waits for the user when it imports papers.
      const too = `〈${access.study.title}〉的文獻庫只有 ${papers.length} 篇論文`;
      if (env.run.autopilot) return { kind: "redirect", playbook: "topic_research", message: `${too}，文獻回顧至少需要 2 篇；自動駕駛改用「主題調研」：先線上找論文，匯入前會請你確認。` };
      const answers = await askUser(env, {
        id: "lit_too_few",
        title: `${too}，文獻回顧至少需要 2 篇`,
        intro: "可以改做主題調研：依這個主題線上搜尋論文（只送出關鍵字），列出候選讓你在計畫中確認後匯入文獻庫並精讀，再寫成研究筆記。",
        questions: [{ id: "how", prompt: "接下來要怎麼做？", type: "single_choice", required: true, options: [
          { value: "topic", label: "改做主題調研", description: "線上找相關論文，確認後匯入、精讀，整理成做法分類與比較。" },
          { value: "add", label: "我先加入論文", description: "我到文獻庫加入論文後按「繼續」，再做文獻回顧。" },
        ] }],
        step_key: null,
        purpose: "input",
        ai_suggested: false,
      });
      if (answers.find((a) => a.id === "how")?.value === "topic") return { kind: "redirect", playbook: "topic_research", message: "依你的選擇改用「主題調研」：先線上找論文，匯入前會請你確認。" };
      return { kind: "question", question: `${too}；文獻回顧至少需要 2 篇。請先加入論文後按「繼續」。` };
    }
    const keys = papers.map((p) => p.cite_key);
    await env.setState({ note_title: `文獻回顧：${clipText(access.study.title, 80)}`, papers, keys, sections: LIT_SECTIONS });
    const reads: StepSpec[] = papers.map((p, i) => ({
      key: `read_${i + 1}`,
      role: "researcher",
      title: `精讀〈${clipText(p.title, 40)}〉`,
      instructions: `讀論文〈${p.title}〉（paper_id ${p.id}，引用鍵 [@${p.cite_key}]）${p.has_pdf ? "：read_paper 先看目錄，再讀方法與實驗結果" : "：沒有 PDF，只能用 get_paper 的摘要，請明說只讀了摘要"}。整理：問題、方法、資料、評估指標、主要結果（數字照原文，標出處）、限制。`,
      inputs: { paper_id: p.id, cite_key: p.cite_key },
      expected: "結構化的論文摘要（含出處）",
      verify: { checks: [{ id: "min_length", params: { chars: 300 } }, { id: "not_truncated" }, ...(p.has_pdf ? [{ id: "source_refs", params: { min: 2 } }] : [])], judge: false },
    }));
    const readKeys = reads.map((r) => r.key);
    await env.setState({ units: [{ key: "table", title: "研究背景與方法比較表", purpose: "背景（≤ 300 字）＋比較表", budget: { chars: 1600 } }, ...LIT_UNITS.map((u) => ({ key: u.key, title: u.section, purpose: u.instructions, budget: u.budget }))] });
    const steps: StepSpec[] = [
      ...reads,
      { key: "table", role: "writer", title: "撰寫方法比較表", instructions: `用 Markdown 表格比較 ${papers.length} 篇論文（每篇一列；欄位：論文（[@key]）、問題、方法、資料、指標、主要結果），之前加一段「## 研究背景與範圍」。`, depends_on: readKeys, expected: "## 研究背景與範圍 + ## 方法比較表", verify: { checks: [{ id: "table_rows", params: { min: papers.length } }, { id: "citations", params: { keys, min: papers.length } }, { id: "sections_present", params: { sections: LIT_SECTIONS.slice(0, 2) } }, { id: "no_placeholder" }], judge: true } },
      // One unit per section (each in its own call, with its own budget): never one call for the whole synthesis.
      ...LIT_UNITS.map((u) => ({ key: u.key, role: "writer" as const, title: u.title, instructions: u.instructions, depends_on: [...readKeys, "table", ...(u.key === "synthesis" ? [] : ["synthesis"])], expected: `## ${u.section}`, verify: { checks: [...(u.cites ? [{ id: "citations", params: { keys, min: Math.min(2, papers.length) } }] : []), { id: "sections_present", params: { sections: [u.section] } }, { id: "no_placeholder" }, { id: "not_truncated" }], judge: true } })),
      assembleSpec(["table", ...LIT_UNITS.map((u) => u.key)], LIT_SECTIONS),
      finalSpec(),
    ];
    return {
      kind: "plan",
      title: `文獻回顧：${clipText(access.study.title, 80)}`,
      studyId: access.study.id,
      objective: `比較〈${access.study.title}〉文獻庫中的 ${papers.length} 篇論文，寫成含比較表與綜合分析的文獻回顧筆記，引用都對應到文獻庫。`,
      criteria: [
        { id: "table", kind: "check", text: `比較表涵蓋全部 ${papers.length} 篇論文`, check: { id: "table_rows", params: { min: papers.length } } },
        { id: "cites", kind: "check", text: "引用都對應到文獻庫的 cite key", check: { id: "citations", params: { keys, min: papers.length } } },
        { id: "sections", kind: "check", text: "包含背景、比較表、綜合分析、研究缺口與關係五段", check: { id: "sections_present", params: { sections: LIT_SECTIONS } } },
        { id: "grounded", kind: "judge", text: "每篇論文的描述都來自它的內容，沒有捏造結果" },
        { id: "synthesis", kind: "judge", text: "綜合分析指出具體的共同點、差異與缺口，不只是逐篇摘要" },
      ],
      plan: { summary: `平行精讀 ${papers.length} 篇論文（${papers.map((p) => p.cite_key).join("、")}），再逐段寫比較表、綜合分析、研究缺口與關係（每段各有長度預算、各自驗收），最後依序拼接成一份筆記。`, outline: outlineFrom(LIT_SECTIONS.map((t) => ({ title: t }))), writes: [{ kind: "note", label: `新筆記「文獻回顧：${clipText(access.study.title, 60)}」`, effect: "new" }] },
      steps,
    };
  },
  async execute(env, step, fix) {
    if (step.key === "assemble") return assembleDoc(env, step);
    if (step.key.startsWith("read_")) {
      const user = taskPrompt(env, step, { format: "Markdown 條列，開頭寫 `### [@key] 論文標題`。" }, fix);
      const r = await env.researcher(step, { system: systemFor("researcher"), user, tools: ["read_paper", "get_paper", "view_paper_pages"], maxToolSteps: 40, purpose: "lit_read" });
      return { summary: `讀了 ${r.toolCalls} 次，摘要 ${r.text.length} 字`, text: r.text };
    }
    const steps = await getSteps(env.db, env.run.id);
    const reads = steps.filter((s) => s.key.startsWith("read_") && s.output?.text).map((s) => s.output!.text!).join("\n\n");
    const table = step.key !== "table" ? steps.find((s) => s.key === "table")?.output?.text ?? "" : "";
    return writePart(env, step, fix, { paper_summaries: reads.slice(0, 30_000), ...(table ? { comparison_table: table } : {}), cite_keys: (env.state<string[]>("keys") ?? []).join("、") }, "Markdown；引用寫成 [@key]（只能用提供的 key）。只輸出要求的段落。");
  },
  async finalText(env) {
    return { text: env.state<string>("doc") ?? "", data: null };
  },
  async repair(env, failing) {
    const out: { key: string; issues: string[] }[] = [];
    for (const c of failing) {
      if (c.id === "table") out.push({ key: "table", issues: [c.reason ?? c.text] });
      else if (c.id === "synthesis") out.push({ key: "synthesis", issues: [c.reason ?? c.text] });
      else if (c.id === "sections") {
        // Only the units whose section is missing.
        const doc = env.state<string>("doc") ?? "";
        for (const u of LIT_UNITS) if (!doc.includes(`## ${u.section}`)) out.push({ key: u.key, issues: [`缺少「## ${u.section}」。`] });
        if (!/##\s*方法比較表/.test(doc) || !/##\s*研究背景與範圍/.test(doc)) out.push({ key: "table", issues: [c.reason ?? c.text] });
      } else out.push({ key: "table", issues: [`${c.text}：${c.reason ?? ""}`] }, { key: "synthesis", issues: [`${c.text}：${c.reason ?? ""}`] });
    }
    return out;
  },
  commit: (env, outcome) => commitNote(env, outcome, "reading"),
};

// ---------------------------------------------------------------- 實驗報告筆記

const EXP_SECTIONS = ["實驗目的", "實驗設定", "結果", "分析與討論", "結論與待確認"];

async function noteSources(env: WorkflowEnv): Promise<{ text: string; titles: string[] }> {
  const ids = [...new Set([...(Array.isArray(env.run.inputs.note_ids) ? (env.run.inputs.note_ids as string[]) : []), ...(env.run.context.noteId ? [String(env.run.context.noteId)] : [])])].slice(0, 6);
  const parts: string[] = [];
  const titles: string[] = [];
  for (const id of ids) {
    const r = await env.tool("get_note", { note_id: id });
    if (r.ok) {
      parts.push(r.text);
      titles.push(String((r.data as { note?: { title?: string } } | null)?.note?.title ?? id));
    }
  }
  return { text: parts.join("\n\n"), titles };
}

const experimentReport: WorkflowPlaybook = {
  id: "experiment_report",
  title: "實驗報告筆記",
  titleEn: "Experiment report",
  description: "從實驗筆記或貼上的結果整理成報告：表格、```chart 圖表、分析；數字逐一對照原始資料",
  descriptionEn: "Turn experiment notes or pasted results into a report with tables, charts and analysis; every number checked against the source",
  autoApprovable: true,
  detect: (req) => (/實驗報告|實驗結果|實驗紀錄|experiment|CER|WER|BLEU|accuracy|消融|ablation/i.test(req) ? 0.75 : 0),
  async plan(env) {
    const access = await studyOrQuestion(env);
    if ("question" in access) return { kind: "question", question: access.question, setup: true };
    const notes = await noteSources(env);
    const source = [env.run.request, notes.text].filter(Boolean).join("\n\n");
    if (!/\d/.test(source) || source.length < 40) return { kind: "question", question: "找不到實驗數據。請把結果貼在補充指示，或附加實驗筆記後按「繼續」。" };
    await env.setState({ note_title: `實驗報告：${clipText(notes.titles[0] ?? env.run.request.split("\n")[0]!, 80)}`, source: source.slice(0, 40_000), sections: EXP_SECTIONS });
    await env.setState({ units: [{ key: "results", title: "實驗目的、設定與結果", budget: { chars: 1800 } }, { key: "analysis", title: "分析與結論", budget: { chars: 1200 } }] });
    const steps: StepSpec[] = [
      { key: "results", role: "writer", title: "整理結果表格與圖表", instructions: "寫「## 實驗目的」「## 實驗設定」「## 結果」：結果用 Markdown 表格列出每個設定的數字，並用 ```chart 區塊畫出主要指標的比較。數字只能來自資料。", expected: "三段 + 表格 + 圖表", verify: { checks: [{ id: "table_rows", params: { min: 2 } }, { id: "chart_blocks", params: { min: 1 } }, { id: "numbers_from_source", params: { source } }, { id: "sections_present", params: { sections: EXP_SECTIONS.slice(0, 3) } }, { id: "no_placeholder" }], judge: false } },
      { key: "analysis", role: "writer", title: "分析與結論", instructions: "根據結果寫「## 分析與討論」「## 結論與待確認」：只描述資料顯示的趨勢與差異，資料不足以下結論的地方列為待確認。", depends_on: ["results"], expected: "兩段分析", verify: { checks: [{ id: "sections_present", params: { sections: EXP_SECTIONS.slice(3) } }, { id: "no_placeholder" }, { id: "not_truncated" }], judge: true } },
      assembleSpec(["results", "analysis"], EXP_SECTIONS),
      finalSpec(),
    ];
    return {
      kind: "plan",
      title: env.state<string>("note_title") ?? "實驗報告",
      studyId: access.study.id,
      objective: `把${notes.titles.length ? `筆記${notes.titles.map((t) => `〈${t}〉`).join("、")}的` : "貼上的"}實驗結果整理成報告筆記：表格、圖表與分析，每個數字都能在原始資料中找到。`,
      criteria: [
        { id: "table", kind: "check", text: "結果有 Markdown 表格", check: { id: "table_rows", params: { min: 2 } } },
        { id: "chart", kind: "check", text: "主要指標有 ```chart 圖表", check: { id: "chart_blocks", params: { min: 1 } } },
        { id: "numbers", kind: "check", text: "表格與圖表的數字都來自原始資料", check: { id: "numbers_from_source", params: { source } } },
        { id: "sections", kind: "check", text: "包含目的、設定、結果、分析、結論五段", check: { id: "sections_present", params: { sections: EXP_SECTIONS } } },
        { id: "analysis", kind: "judge", text: "分析只陳述資料支持的結論，沒有誇大" },
      ],
      plan: { summary: "先整理表格與圖表（數字逐一對照原始資料），再寫分析，最後整合成筆記並驗收。", outline: outlineFrom(EXP_SECTIONS.map((t) => ({ title: t }))), writes: [{ kind: "note", label: "新的實驗報告筆記", effect: "new" }] },
      steps,
    };
  },
  async execute(env, step, fix) {
    if (step.key === "assemble") return assembleDoc(env, step);
    const source = env.state<string>("source") ?? "";
    const prev = step.key === "analysis" ? (await getSteps(env.db, env.run.id)).find((s) => s.key === "results")?.output?.text ?? "" : "";
    return writePart(env, step, fix, { source_data: source, ...(prev ? { results: prev } : {}) }, '```chart 的內容是 JSON：{"type":"bar"|"line","title":"…","labels":["…"],"series":[{"name":"…","data":[1.2]}]}。只輸出要求的段落。');
  },
  async finalText(env) {
    return { text: env.state<string>("doc") ?? "", data: null };
  },
  async repair(_env, failing) {
    return failing.map((c) => ({ key: c.id === "analysis" || c.id === "sections" ? "analysis" : "results", issues: [`${c.text}：${c.reason ?? ""}`] }));
  },
  commit: (env, outcome) => commitNote(env, outcome, "experiment"),
};

// ---------------------------------------------------------------- 會議準備

const MEET_SECTIONS = ["本次報告重點", "上次回饋的處理情形", "待討論的問題", "需要教授決定的事", "未完成的待辦"];

const meetingPrep: WorkflowPlaybook = {
  id: "meeting_prep",
  title: "會議準備",
  titleEn: "Meeting prep",
  description: "讀未完成待辦、上次會議回饋、最近的筆記與簡報變更，擬出會議議程筆記",
  descriptionEn: "Read open tasks, last feedback, recent notes and deck changes; draft a meeting agenda note",
  autoApprovable: true,
  detect: (req) => (/會議準備|議程|agenda|meeting prep|組會準備|準備.*會議|開會/i.test(req) ? 0.8 : 0),
  async plan(env) {
    const access = await studyOrQuestion(env);
    if ("question" in access) return { kind: "question", question: access.question, setup: true };
    const progress = await env.tool("get_study_progress", { study: access.study.id });
    const activity = await env.tool("get_recent_activity", { study: access.study.id, limit: 30 });
    const source = [progress.ok ? progress.text : "", activity.ok ? activity.text : ""].join("\n\n");
    await env.setState({ note_title: `會議準備 ${taipeiToday()}：${clipText(access.study.title, 60)}`, source: source.slice(0, 40_000), sections: MEET_SECTIONS });
    await env.setState({ units: [{ key: "agenda", title: "會議議程", budget: { chars: 1600 } }] });
    const steps: StepSpec[] = [
      { key: "research", role: "researcher", title: "整理進度與回饋", instructions: "整理資料中：最近完成的事、上次會議回饋與目前處理情形、卡住的地方、未完成的待辦（原樣列出，不新增）。", expected: "條列整理（含出處：待辦／會議／筆記名稱）", verify: { checks: [{ id: "min_length", params: { chars: 200 } }], judge: false }, done: { output: { summary: `讀取研究進度與最近動態 ${source.length} 字`, text: source.slice(0, 20_000) } } },
      { key: "agenda", role: "writer", title: "擬會議議程", instructions: `依資料寫議程筆記，五段：${MEET_SECTIONS.map((s) => `「## ${s}」`).join("、")}。每一項都要能在資料中找到；不要自己新增下一步、時程或截止日。`, depends_on: ["research"], expected: "五段議程", verify: { checks: [{ id: "sections_present", params: { sections: MEET_SECTIONS } }, { id: "no_placeholder" }, { id: "not_truncated" }], judge: true } },
      assembleSpec(["agenda"], MEET_SECTIONS),
      finalSpec(),
    ];
    return {
      kind: "plan",
      title: env.state<string>("note_title") ?? "會議準備",
      studyId: access.study.id,
      objective: `為〈${access.study.title}〉的下次會議擬一份議程筆記，內容都來自目前的待辦、回饋、筆記與簡報。`,
      criteria: [
        { id: "sections", kind: "check", text: "包含重點、回饋處理、待討論、需教授決定、未完成待辦五段", check: { id: "sections_present", params: { sections: MEET_SECTIONS } } },
        { id: "clean", kind: "check", text: "沒有佔位文字", check: { id: "no_placeholder" } },
        { id: "grounded", kind: "judge", text: "每一項都來自研究資料，沒有自己新增的待辦、時程或截止日" },
      ],
      plan: { summary: "讀研究進度、上次回饋與最近動態，擬出五段議程，驗收後建立筆記。", outline: outlineFrom(MEET_SECTIONS.map((t) => ({ title: t }))), writes: [{ kind: "note", label: "新的會議準備筆記", effect: "new" }] },
      steps,
    };
  },
  async execute(env, step, fix) {
    if (step.key === "assemble") return assembleDoc(env, step);
    if (step.key === "research") return step.output ?? { summary: "", text: env.state<string>("source") ?? "" };
    return writePart(env, step, fix, { study_data: env.state<string>("source") ?? "" }, "Markdown，五個 ## 段落，條列為主。");
  },
  async finalText(env) {
    return { text: env.state<string>("doc") ?? "", data: null };
  },
  async repair(_env, failing) {
    return [{ key: "agenda", issues: failing.map((c) => `${c.text}：${c.reason ?? ""}`) }];
  },
  commit: (env, outcome) => commitNote(env, outcome, "meeting"),
};

// ---------------------------------------------------------------- generic

type GenericPlan = { title?: string; objective: string; criteria: string[]; steps: { key: string; title: string; role: string; instructions: string; depends_on?: string[]; expected?: string; section?: string; chars?: number }[] };
const isGenericPlan = (v: unknown): v is GenericPlan =>
  !!v && typeof v === "object" && typeof (v as GenericPlan).objective === "string" && Array.isArray((v as GenericPlan).steps) && (v as GenericPlan).steps.length > 0 && Array.isArray((v as GenericPlan).criteria);

const generic: WorkflowPlaybook = {
  id: "generic",
  title: "一般任務",
  titleEn: "General task",
  description: "由主要 Agent 自行規劃步驟、分派子代理並逐步驗收，成果寫成新筆記",
  descriptionEn: "The orchestrator plans the steps, dispatches sub-agents and verifies each; the result becomes a new note",
  autoApprovable: true,
  detect: () => 0.1,
  async plan(env) {
    const access = await studyOrQuestion(env);
    if ("question" in access) return { kind: "question", question: access.question, setup: true };
    const context = await env.tool("get_study", { study: access.study.id });
    const user = [
      requestLine(env),
      env.guidanceText(),
      dataBlock("study", context.ok ? context.text.slice(0, 8000) : `研究〈${access.study.title}〉`),
      "把這個要求拆成 2–8 個步驟：先 researcher（用唯讀工具讀研究資料、筆記、論文），再 writer。成果文件的大綱就是 writer 步驟：每個 writer 只寫文件的「一個 ## 章節」（section 寫章節標題），附這一節的長度預算 chars（300–3000 字）；不要 integrator 或「整合全文」的步驟，章節會由系統依序拼接。role 只能是 researcher、writer、coder。",
      "criteria 寫 2–5 條可以檢查的驗收標準（具體，不要空泛）。不要加入使用者沒要求的時程或下一步。",
      '只輸出 JSON：{"title":"簡短標題","objective":"一句目標","criteria":["…"],"steps":[{"key":"s1","title":"…","role":"researcher","instructions":"…","depends_on":[],"expected":"…"},{"key":"s2","title":"…","role":"writer","section":"章節標題","chars":1200,"instructions":"…","depends_on":["s1"],"expected":"…"}]}',
    ].filter(Boolean).join("\n\n");
    const { value } = await env.callJson<GenericPlan>({ purpose: "plan_generic", role: "orchestrator", messages: [{ role: "system", content: systemFor("planner", "你是主要的協調者（orchestrator），負責把任務拆給子代理。") }, { role: "user", content: user }], maxTokens: 5000 }, isGenericPlan);
    if (!value) throw new WorkflowInputError("無法擬出工作計畫，請換個方式描述任務。");
    // No model integrator: a step that would rewrite the whole document is dropped (its dependents keep its inputs).
    const integrators = new Set(value.steps.filter((x) => x.role === "integrator" || x.role === "designer").map((x) => x.key));
    const raw = value.steps.filter((x) => !integrators.has(x.key)).slice(0, 8);
    if (!raw.length) throw new WorkflowInputError("無法擬出工作計畫，請換個方式描述任務。");
    const keys = raw.map((s, i) => (/^[a-z0-9_-]{1,40}$/.test(s.key ?? "") && !["assemble", "final"].includes(s.key) ? s.key : `s${i + 1}`));
    const unique = keys.map((k, i) => (keys.indexOf(k) === i ? k : `${k}_${i}`));
    const role = (r: string): StepRole => (r === "researcher" || r === "coder" ? r : "writer");
    const steps: StepSpec[] = raw.map((s, i) => {
      const section = role(s.role) === "writer" ? clipText(String(s.section || s.title || `第 ${i + 1} 節`).replace(/^#+\s*/, ""), 80) : "";
      return {
        key: unique[i]!,
        role: role(s.role),
        title: clipText(String(s.title || `步驟 ${i + 1}`), 80),
        instructions: `${String(s.instructions ?? "").slice(0, 2000)}${section ? `\n只寫「${section}」這一節（一個 ## 標題，標題用成果的語言）。` : ""}`,
        depends_on: (s.depends_on ?? []).flatMap((d) => (integrators.has(d) ? value.steps.find((x) => x.key === d)?.depends_on ?? [] : [d])).map((d) => unique[keys.indexOf(d)] ?? d).filter((d) => unique.slice(0, i).includes(d)),
        inputs: section ? { section } : {},
        expected: String(s.expected ?? "").slice(0, 300) || (section ? `## ${section}` : ""),
        verify: { checks: [{ id: "min_length", params: { chars: 80 } }, { id: "no_placeholder" }, { id: "not_truncated" }], judge: true },
      };
    });
    const writers = steps.filter((s) => s.role !== "researcher");
    const parts = (writers.length ? writers : steps).map((s) => s.key);
    // The document's outline = the writer units, each with its length budget.
    const units: Unit[] = writers.map((w, i) => ({ key: w.key, title: String(w.inputs?.section ?? w.title), purpose: w.expected, budget: { chars: Math.min(3000, Math.max(300, Number(raw[steps.indexOf(w)]?.chars) || 1200)) } }));
    // (Section names come from the model, possibly in another language than the note: no heading check on them.)
    await env.setState({ units });
    steps.push({ key: "assemble", role: "integrator", kind: "integrate", title: "依大綱拼接成果", instructions: "依大綱順序拼接各節（不呼叫模型）。", depends_on: parts, expected: "完整文件", verify: { checks: [{ id: "no_placeholder" }, { id: "not_truncated" }], judge: false } }, finalSpec());
    const title = clipText(value.title || env.run.request.split("\n")[0]!, 80);
    await env.setState({ note_title: title });
    return {
      kind: "plan",
      title,
      studyId: access.study.id,
      objective: clipText(value.objective, 400),
      criteria: [
        ...value.criteria.slice(0, 5).map((t, i) => ({ id: `c${i + 1}`, kind: "judge" as const, text: clipText(String(t), 200) })),
        { id: "clean", kind: "check" as const, text: "沒有佔位文字或被截斷的內容", check: { id: "not_truncated" } },
      ],
      plan: { summary: `分成 ${raw.length} 個步驟由子代理執行（${units.length} 個章節各自撰寫，有長度預算），每步驗收後依大綱拼接成一份新筆記。`, ...(units.length ? { outline: outlineFrom(units.map((u) => ({ title: u.title }))) } : {}), writes: [{ kind: "note", label: `新筆記「${title}」`, effect: "new" }] },
      steps,
    };
  },
  async execute(env, step, fix) {
    if (step.key === "assemble") return assembleDoc(env, step);
    const deps = await depOutputs(env, step);
    const context = Object.fromEntries(Object.entries(deps).map(([k, v]) => [`step_${k}`, `【${v.title}】\n${v.text}`]));
    if (step.role === "researcher") {
      const user = taskPrompt(env, step, { context, format: "Markdown，每個重點標註出處。" }, fix);
      const r = await env.researcher(step, { system: systemFor("researcher"), user, tools: RESEARCH_TOOLS, maxToolSteps: 60, purpose: "generic_research" });
      return { summary: `讀了 ${r.toolCalls} 次，整理 ${r.text.length} 字`, text: r.text };
    }
    const section = typeof step.inputs?.section === "string" ? step.inputs.section : "";
    return writePart(env, step, fix, context, section ? `只輸出「${section}」這一節的 Markdown（一個 ## 標題，可以有 ### 小標），不要其他章節、不要 # 文件標題。` : "Markdown。");
  },
  async finalText(env) {
    return { text: env.state<string>("doc") ?? "", data: null };
  },
  async repair(env, failing) {
    // The user's requirements (`req_*`) are repaired by the engine on exactly the writers that fail them.
    const own = failing.filter((c) => !c.id.startsWith("req_"));
    if (!own.length) return [];
    const steps = await getSteps(env.db, env.run.id);
    const writers = steps.filter((s) => s.kind === "task" && s.role !== "researcher");
    // A reason that names a section reopens only that unit; otherwise the last two units (bounded).
    const named = writers.filter((s) => typeof s.inputs?.section === "string" && own.some((c) => (c.reason ?? "").includes(String(s.inputs.section))));
    return (named.length ? named : writers.slice(-2)).map((s) => ({ key: s.key, issues: own.map((c) => `${c.text}：${c.reason ?? ""}`) }));
  },
  commit: (env, outcome) => commitNote(env, outcome, "custom"),
};

for (const p of [readingNote, litReview, experimentReport, meetingPrep, generic]) registerWorkflowPlaybook(p);
export { readingNote, litReview, experimentReport, meetingPrep, generic };
