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
import { STEP_ROLES, type CheckSpec, type Criterion, type OutlineItem, type StepOutput, type StepRole, type StepRow, type StepSpec } from "../types.js";
import { clipText, depOutputs, paperOf, resolveStudy, systemFor, taskPrompt } from "./common.js";
import { registerWorkflowPlaybook, type PlanResult, type WorkflowPlaybook } from "./registry.js";

type Fix = { previous: StepOutput; issues: string[] } | null;

/** Read tools a researcher may use (the assistant's own read tools; permissions and taint as in the chat). */
export const RESEARCH_TOOLS = [
  "get_study", "get_study_progress", "list_notes", "get_note", "list_tasks", "list_papers", "get_paper", "read_paper", "view_paper_pages",
  "search", "list_decks", "get_deck", "get_deck_pages", "get_deck_reviews", "list_meetings", "get_meeting", "get_transcript_excerpt",
  "latex_list_projects", "latex_read_file", "get_study_bibtex", "get_recent_activity", "search_papers_online",
];

const PART_CHECKS: CheckSpec[] = [{ id: "min_length", params: { chars: 150 } }, { id: "no_placeholder" }, { id: "not_truncated" }];

async function studyOrQuestion(env: WorkflowEnv): Promise<StudyAccess | { question: string }> {
  const access = await resolveStudy(env);
  if (!access) return { question: "要在哪個研究進行？請在補充指示寫研究名稱，或從研究頁面再按一次「交給 Agent」。" };
  if (!access.canEdit) return { question: `你不是〈${access.study.title}〉的成員，工作流程不能在這裡建立筆記。請指定你參與的研究。` };
  return access;
}

/** Assemble step: parts in outline order under the note title (no model call). */
function assembleSpec(partKeys: string[], sections: string[]): StepSpec {
  return {
    key: "assemble", role: "integrator", kind: "integrate", title: "整合成一份筆記", instructions: "依大綱順序整合各段內容。",
    depends_on: partKeys, expected: "完整筆記",
    verify: { checks: [{ id: "sections_present", params: { sections } }, { id: "no_placeholder" }, { id: "not_truncated" }], judge: false },
  };
}
const finalSpec = (dep = "assemble"): StepSpec => ({ key: "final", role: "verifier", kind: "final", title: "最終驗收", instructions: "依目標逐條驗收。", depends_on: [dep], expected: "每一條驗收標準都通過" });

async function assembleDoc(env: WorkflowEnv, step: StepRow): Promise<StepOutput> {
  const steps = await getSteps(env.db, env.run.id);
  const parts = step.depends_on.map((k) => steps.find((s) => s.key === k)).filter((s): s is StepRow => !!s?.output?.text);
  const title = env.state<string>("note_title") ?? env.run.title;
  const text = `# ${title}\n\n${parts.map((p) => p.output!.text!.trim()).join("\n\n")}\n`;
  await env.setState({ doc: text });
  return { summary: `整合 ${parts.length} 段，共 ${text.length} 字`, text };
}

async function writePart(env: WorkflowEnv, step: StepRow, fix: Fix, context: Record<string, string>, format: string, aiRole?: "writing" | "assistant") {
  const user = taskPrompt(env, step, { context, format }, fix);
  const res = await env.call({ purpose: `write:${env.run.playbook}`, role: step.role === "researcher" ? "researcher" : "writer", aiRole: aiRole ?? (step.role === "writer" ? "writing" : undefined), messages: [{ role: "system", content: systemFor(step.role) }, { role: "user", content: user }], maxTokens: 8000 }, step.id);
  return { summary: `${res.text.length} 字${res.stopReason === "max_tokens" ? "（輸出被截斷）" : ""}`, text: res.text };
}

/** Commit: the assembled note, once. A partial run says so at the top. */
async function commitNote(env: WorkflowEnv, outcome: "done" | "partial", kind: NoteKind) {
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
  const body = outcome === "partial" && unmet.length ? `> 這份筆記由工作流程產生，**尚未通過**這些驗收標準：${unmet.map((c) => c.text).join("；")}\n\n${doc}` : doc;
  const id = await transaction(env.db, async (client) => {
    const locked = await loadStudyAccess(client, access.study.id, env.user, { forUpdate: true });
    if (!locked.canEdit) throw new WorkflowInputError("你已經不是這個研究的成員。");
    return createNote(client, { studyId: locked.study.id, studySlug: locked.study.slug, title, templateId: null, kind, contentMd: body, eventDate: taipeiToday(), actorId: env.user.id, author: "ai" });
  });
  await env.setState({ note_id: id, committed_doc: doc });
  await addArtifact(env.db, env.run.id, { kind: "note", id, url: noteUrl(access.study.slug, id), title, role: "draft" });
  return `已建立新筆記〈${title}〉。`;
}

const outlineFrom = (sections: { title: string; points?: string[] }[]): OutlineItem[] => sections.map((s, i) => ({ n: i + 1, title: s.title, points: s.points ?? [] }));

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
    if ("question" in access) return { kind: "question", question: access.question };
    const paper = await paperOf(env);
    if (!paper) return { kind: "question", question: "要讀哪一篇論文？請先把論文加入文獻庫（或附加它），再在補充指示寫出論文標題。" };
    if (!paper.pdf_key) return { kind: "question", question: `〈${paper.title}〉還沒有 PDF，無法讀全文。請在文獻庫抓取或上傳 PDF 後，按「繼續」。` };
    const ft = await paperFullText(env.storage, paper.pdf_key).catch(() => null);
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
        verify: { checks: [...PART_CHECKS, { id: "sections_present", params: { sections: [title] } }, ...(isGroup ? [{ id: "source_refs", params: { min: 1 } }] : []), ...(isMethod && hasMath ? [{ id: "equations", params: { min: 1 } }] : [])], judge: isGroup },
      };
    });
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
      plan: { summary: `依論文目錄分成 ${sections.length} 段，由研究者子代理平行讀對應章節並撰寫，每段檢查出處${hasMath ? "與公式" : ""}，最後整合並逐條驗收。`, outline: outlineFrom(sections.map((t) => ({ title: t }))), writes: [{ kind: "note", label: `新筆記「閱讀筆記：${clipText(paper.title, 60)}」` }] },
      steps,
    };
  },
  async execute(env, step, fix) {
    if (step.key === "assemble") return assembleDoc(env, step);
    const title = (env.state<string[]>("sections") ?? [])[Number(step.key.slice(5)) - 1] ?? step.title;
    const paperId = String(step.inputs.paper_id ?? env.run.inputs.paper_id ?? "");
    const user = taskPrompt(env, step, { context: { paper: `論文：〈${env.state<string>("paper_title") ?? ""}〉，paper_id ${paperId}（呼叫 read_paper / view_paper_pages 時用這個 paper_id）${env.run.study_id ? `；研究 study id ${env.run.study_id}` : ""}` }, format: `只輸出「## ${title}」這一段的 Markdown（可以有 ### 小標），不要其他段落。` }, fix);
    const r = await env.researcher(step, { system: systemFor("researcher", "你讀完需要的內容後，直接寫出筆記的這一段。"), user, tools: ["read_paper", "view_paper_pages", "get_paper", "get_study"], maxToolSteps: 5, maxTokens: 10_000, purpose: "reading_part" });
    return { summary: `讀了 ${r.toolCalls} 次，寫了 ${r.text.length} 字`, text: r.text };
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
    if ("question" in access) return { kind: "question", question: access.question };
    const papers = await studyPapers(env, access.study.id);
    if (papers.length < 2) return { kind: "question", question: `〈${access.study.title}〉的文獻庫只有 ${papers.length} 篇論文；文獻回顧至少需要 2 篇。請先加入論文後按「繼續」。` };
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
    const steps: StepSpec[] = [
      ...reads,
      { key: "table", role: "writer", title: "撰寫方法比較表", instructions: `用 Markdown 表格比較 ${papers.length} 篇論文（每篇一列；欄位：論文（[@key]）、問題、方法、資料、指標、主要結果），之前加一段「## 研究背景與範圍」。`, depends_on: readKeys, expected: "## 研究背景與範圍 + ## 方法比較表", verify: { checks: [{ id: "table_rows", params: { min: papers.length } }, { id: "citations", params: { keys, min: papers.length } }, { id: "sections_present", params: { sections: LIT_SECTIONS.slice(0, 2) } }, { id: "no_placeholder" }], judge: true } },
      { key: "synthesis", role: "writer", title: "綜合分析與研究缺口", instructions: "寫「## 綜合分析」「## 研究缺口」「## 與本研究的關係」三段：歸納共同點與差異、尚未解決的問題，引用時用 [@key]。只根據論文摘要，不替使用者決定研究方向。", depends_on: [...readKeys, "table"], expected: "三段綜合分析（含引用）", verify: { checks: [{ id: "citations", params: { keys, min: Math.min(2, papers.length) } }, { id: "sections_present", params: { sections: LIT_SECTIONS.slice(2) } }, { id: "no_placeholder" }, { id: "not_truncated" }], judge: true } },
      assembleSpec(["table", "synthesis"], LIT_SECTIONS),
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
      plan: { summary: `平行精讀 ${papers.length} 篇論文（${papers.map((p) => p.cite_key).join("、")}），再寫比較表與綜合分析，每段驗收引用與內容，最後整合成一份筆記。`, outline: outlineFrom(LIT_SECTIONS.map((t) => ({ title: t }))), writes: [{ kind: "note", label: `新筆記「文獻回顧：${clipText(access.study.title, 60)}」` }] },
      steps,
    };
  },
  async execute(env, step, fix) {
    if (step.key === "assemble") return assembleDoc(env, step);
    if (step.key.startsWith("read_")) {
      const user = taskPrompt(env, step, { format: "Markdown 條列，開頭寫 `### [@key] 論文標題`。" }, fix);
      const r = await env.researcher(step, { system: systemFor("researcher"), user, tools: ["read_paper", "get_paper", "view_paper_pages"], maxToolSteps: 4, purpose: "lit_read" });
      return { summary: `讀了 ${r.toolCalls} 次，摘要 ${r.text.length} 字`, text: r.text };
    }
    const steps = await getSteps(env.db, env.run.id);
    const reads = steps.filter((s) => s.key.startsWith("read_") && s.output?.text).map((s) => s.output!.text!).join("\n\n");
    const table = step.key === "synthesis" ? steps.find((s) => s.key === "table")?.output?.text ?? "" : "";
    return writePart(env, step, fix, { paper_summaries: reads.slice(0, 30_000), ...(table ? { comparison_table: table } : {}), cite_keys: (env.state<string[]>("keys") ?? []).join("、") }, "Markdown；引用寫成 [@key]（只能用提供的 key）。只輸出要求的段落。");
  },
  async finalText(env) {
    return { text: env.state<string>("doc") ?? "", data: null };
  },
  async repair(_env, failing) {
    const out: { key: string; issues: string[] }[] = [];
    for (const c of failing) {
      if (c.id === "table") out.push({ key: "table", issues: [c.reason ?? c.text] });
      else if (c.id === "synthesis" || c.id === "sections") out.push({ key: "synthesis", issues: [c.reason ?? c.text] });
      else out.push({ key: "table", issues: [`${c.text}：${c.reason ?? ""}`] }, { key: "synthesis", issues: [`${c.text}：${c.reason ?? ""}`] });
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
    if ("question" in access) return { kind: "question", question: access.question };
    const notes = await noteSources(env);
    const source = [env.run.request, notes.text].filter(Boolean).join("\n\n");
    if (!/\d/.test(source) || source.length < 40) return { kind: "question", question: "找不到實驗數據。請把結果貼在補充指示，或附加實驗筆記後按「繼續」。" };
    await env.setState({ note_title: `實驗報告：${clipText(notes.titles[0] ?? env.run.request.split("\n")[0]!, 80)}`, source: source.slice(0, 40_000), sections: EXP_SECTIONS });
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
      plan: { summary: "先整理表格與圖表（數字逐一對照原始資料），再寫分析，最後整合成筆記並驗收。", outline: outlineFrom(EXP_SECTIONS.map((t) => ({ title: t }))), writes: [{ kind: "note", label: "新的實驗報告筆記" }] },
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
    if ("question" in access) return { kind: "question", question: access.question };
    const progress = await env.tool("get_study_progress", { study: access.study.id });
    const activity = await env.tool("get_recent_activity", { study: access.study.id, limit: 30 });
    const source = [progress.ok ? progress.text : "", activity.ok ? activity.text : ""].join("\n\n");
    await env.setState({ note_title: `會議準備 ${taipeiToday()}：${clipText(access.study.title, 60)}`, source: source.slice(0, 40_000), sections: MEET_SECTIONS });
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
      plan: { summary: "讀研究進度、上次回饋與最近動態，擬出五段議程，驗收後建立筆記。", outline: outlineFrom(MEET_SECTIONS.map((t) => ({ title: t }))), writes: [{ kind: "note", label: "新的會議準備筆記" }] },
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

type GenericPlan = { title?: string; objective: string; criteria: string[]; steps: { key: string; title: string; role: string; instructions: string; depends_on?: string[]; expected?: string }[] };
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
    if ("question" in access) return { kind: "question", question: access.question };
    const context = await env.tool("get_study", { study: access.study.id });
    const user = [
      `使用者的要求：${env.run.request}`,
      env.guidanceText(),
      dataBlock("study", context.ok ? context.text.slice(0, 8000) : `研究〈${access.study.title}〉`),
      `把這個要求拆成 2–8 個步驟。role 只能是 ${STEP_ROLES.filter((r) => r !== "verifier").join("、")}（researcher 可以用唯讀工具讀研究資料、筆記、論文；writer 寫內容；integrator 整合）。最後一步要是 integrator，把成果整合成一份 Markdown 文件。`,
      "criteria 寫 2–5 條可以檢查的驗收標準（具體，不要空泛）。不要加入使用者沒要求的時程或下一步。",
      '只輸出 JSON：{"title":"簡短標題","objective":"一句目標","criteria":["…"],"steps":[{"key":"s1","title":"…","role":"researcher","instructions":"…","depends_on":[],"expected":"…"}]}',
    ].filter(Boolean).join("\n\n");
    const { value } = await env.callJson<GenericPlan>({ purpose: "plan_generic", role: "orchestrator", messages: [{ role: "system", content: systemFor("planner", "你是主要的協調者（orchestrator），負責把任務拆給子代理。") }, { role: "user", content: user }], maxTokens: 5000 }, isGenericPlan);
    if (!value) throw new WorkflowInputError("無法擬出工作計畫，請換個方式描述任務。");
    const raw = value.steps.slice(0, 8);
    const keys = raw.map((s, i) => (/^[a-z0-9_-]{1,40}$/.test(s.key ?? "") && !["assemble", "final"].includes(s.key) ? s.key : `s${i + 1}`));
    const unique = keys.map((k, i) => (keys.indexOf(k) === i ? k : `${k}_${i}`));
    const steps: StepSpec[] = raw.map((s, i) => ({
      key: unique[i]!,
      role: (STEP_ROLES as readonly string[]).includes(s.role) && s.role !== "verifier" ? (s.role as StepRole) : "writer",
      title: clipText(String(s.title || `步驟 ${i + 1}`), 80),
      instructions: String(s.instructions ?? "").slice(0, 2000),
      depends_on: (s.depends_on ?? []).map((d) => unique[keys.indexOf(d)] ?? d).filter((d) => unique.slice(0, i).includes(d)),
      expected: String(s.expected ?? "").slice(0, 300),
      verify: { checks: [{ id: "min_length", params: { chars: 80 } }, { id: "no_placeholder" }, { id: "not_truncated" }], judge: true },
    }));
    const last = steps.at(-1)!;
    steps.push({ key: "assemble", role: "integrator", kind: "integrate", title: "整合成果", instructions: "整合成一份文件。", depends_on: [last.key], expected: "完整文件", verify: { checks: [{ id: "no_placeholder" }, { id: "not_truncated" }], judge: false } }, finalSpec());
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
      plan: { summary: `分成 ${raw.length} 個步驟由子代理執行，每步驗收後整合成一份新筆記。`, writes: [{ kind: "note", label: `新筆記「${title}」` }] },
      steps,
    };
  },
  async execute(env, step, fix) {
    if (step.key === "assemble") {
      const steps = await getSteps(env.db, env.run.id);
      const parts = steps.filter((s) => s.kind === "task" && s.output?.text && s.status === "passed");
      const lastText = steps.find((s) => s.key === step.depends_on[0])?.output?.text ?? "";
      const text = /^#\s/m.test(lastText) && lastText.length > 400 ? lastText : `# ${env.state<string>("note_title") ?? env.run.title}\n\n${parts.map((p) => p.output!.text!.trim()).join("\n\n")}\n`;
      await env.setState({ doc: text });
      return { summary: `整合 ${parts.length} 個步驟的成果`, text };
    }
    const deps = await depOutputs(env, step);
    const context = Object.fromEntries(Object.entries(deps).map(([k, v]) => [`step_${k}`, `【${v.title}】\n${v.text}`]));
    if (step.role === "researcher") {
      const user = taskPrompt(env, step, { context, format: "Markdown，每個重點標註出處。" }, fix);
      const r = await env.researcher(step, { system: systemFor("researcher"), user, tools: RESEARCH_TOOLS, maxToolSteps: 6, purpose: "generic_research" });
      return { summary: `讀了 ${r.toolCalls} 次，整理 ${r.text.length} 字`, text: r.text };
    }
    return writePart(env, step, fix, context, step.role === "integrator" ? "一份完整的 Markdown 文件（# 標題開頭）。" : "Markdown。");
  },
  async finalText(env) {
    return { text: env.state<string>("doc") ?? "", data: null };
  },
  async repair(env, failing) {
    const steps = await getSteps(env.db, env.run.id);
    const writers = steps.filter((s) => s.kind === "task" && s.role !== "researcher").slice(-2);
    return writers.map((s) => ({ key: s.key, issues: failing.map((c) => `${c.text}：${c.reason ?? ""}`) }));
  },
  commit: (env, outcome) => commitNote(env, outcome, "custom"),
};

for (const p of [readingNote, litReview, experimentReport, meetingPrep, generic]) registerWorkflowPlaybook(p);
export { readingNote, litReview, experimentReport, meetingPrep, generic };
