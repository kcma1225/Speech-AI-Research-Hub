/**
 * User-provided material (material.ts) and the requirement / cover / start-message fixes of production 301b6e1a: an
 * attached Deep-Research file and 「幫我以此做成能像教授報告的簡報」 went the topic route (online search, imported papers),
 * the file was never read, none of the listed parts appeared, the cover was repeated and the assistant asked the user to
 * confirm a plan autopilot approves by itself. Pure functions; the attachment flow end to end is
 * workflows-material.test.ts.
 */
import { describe, expect, it } from "vitest";
import { detectDistinction, detectRequirements, detectSections, requirementCriteria, sectionTitleHit, segmentClauses, uncoveredClauses } from "../src/workflows/requirements.js";
import { CHECKS, coverRepeat, parseSlides, runChecks } from "../src/workflows/checks.js";
import { deckModeOf, route } from "../src/workflows/route.js";
import { digestMarkdown, instructionOf, isPasted, MATERIAL_REF_RE, materialForPages, materialText, materialTitleOf, sectionsOf, type LoadedMaterial } from "../src/workflows/material.js";
import { dropCoverPages, sectionChecks, sectionRule, type SlideOutline } from "../src/workflows/playbooks/slides.js";
import { startMessage } from "../src/workflows/service.js";
import { checkRun, type RunBundle, type StoredMessage } from "../src/workflows/invariants.js";
import { DEEP_RESEARCH_MD, MATERIAL_REQUEST, MATERIAL_SECTIONS, PASTED_NOTES } from "../scripts/eval/material-fixture.js";
import type { Requirement, RunRow } from "../src/workflows/types.js";
import "../src/workflows/playbooks/index.js";

/** The user's own words in production 301b6e1a (the only production text in this file besides the assistant's request). */
const PROD_WORDS = "〈台灣中文與台語語音語料蒐集〉 關於這個部分 我已經有一個deep research的結果 幫我以此做成能像教授報告的簡報 #簡報";
/** The assistant's start_workflow request of 301b6e1a — here as if the user had typed it (its asks must all become requirements). */
const PROD_REQUEST = "請使用本次附加的〈taiwan_speech_deep_research_prompts.md〉，製作研究〈台灣中文與台語語音語料蒐集〉的教授報告簡報。以附件中的 Deep Research 結果與研究目前階段為主要材料，清楚區分已知事實、合理推論與待驗證構想，呈現研究背景、既有資源與限制、候選研究方向、優先順序、最小可行研究設計與需要教授決策的問題。";
const SECTIONS = ["研究背景", "既有資源與限制", "候選研究方向", "優先順序", "最小可行研究設計", "需要教授決策的問題"];

const withIds = (rs: Omit<Requirement, "id" | "source">[]): Requirement[] => rs.map((r, i) => ({ ...r, id: `r${i + 1}`, source: "request" }));

describe("requirements: listed parts, distinctions, material, audience (301b6e1a)", () => {
  it("the production user words: material, subject and audience requirements; every clause accounted for", () => {
    const reqs = detectRequirements(PROD_WORDS, { kind: "deck" });
    expect(reqs.map((r) => r.type)).toEqual(["other", "other", "audience"]);
    expect(reqs[0]!.text).toMatch(/以你提供的資料為主要材料/);
    expect(reqs[1]!.text).toBe("主題是〈台灣中文與台語語音語料蒐集〉");
    expect(uncoveredClauses(segmentClauses(PROD_WORDS), withIds(reqs), new Set(), new Set(), "deck")).toEqual([]);
  });

  it("an enumerated list of parts becomes ONE section requirement checked page by page; the distinction is judged", () => {
    const reqs = detectRequirements(PROD_REQUEST, { kind: "deck" });
    const sec = reqs.find((r) => r.type === "include_topics")!;
    expect(sec.params!.sections).toBe(true);
    expect(sec.params!.topics!.map((t) => t.name)).toEqual(SECTIONS);
    expect(sec.quote).toContain("呈現研究背景");
    const dist = reqs.find((r) => r.type === "other" && /區分/.test(r.text))!;
    expect(dist.text).toContain("「已知事實」、「合理推論」、「待驗證構想」");
    expect(dist.quote).toBe("清楚區分已知事實、合理推論與待驗證構想");
    expect(reqs.some((r) => r.type === "other" && /主要材料/.test(r.text))).toBe(true);
    expect(uncoveredClauses(segmentClauses(PROD_REQUEST), withIds(reqs), new Set(), new Set(), "deck")).toEqual([]);
    const crit = requirementCriteria(withIds(reqs), "deck");
    expect(crit.find((c) => c.check?.id === "req_sections")!.check!.params!.judge_fallback).toBe(true);
    expect(crit.find((c) => /區分/.test(c.text))!.kind).toBe("judge");
  });

  it("list shapes: 包含 / 要有 / 分成, the last item split only when both sides are real parts", () => {
    expect(detectSections("簡報要包含問題定義、資料集介紹和實驗結果")[0]!.items).toEqual(["問題定義", "資料集介紹", "實驗結果"]);
    expect(detectSections("要有背景與動機、方法")[0]!.items).toEqual(["背景與動機", "方法"]);
    expect(detectSections("分成以下幾個部分：現況、困難、下一步等")[0]!.items).toEqual(["現況", "困難", "下一步"]);
    // Not part lists: per-item fields, language extensions, Latin topic lists (the compare / cover rule), a single item.
    expect(detectSections("每個方法都要有架構、優點、缺點")).toEqual([]);
    expect(detectSections("整份翻成英文，包含封面和講稿")).toEqual([]);
    expect(detectSections("包含 shallow fusion、CLAS")).toEqual([]);
    expect(detectSections("要有比較表")).toEqual([]);
    // (eval staging: 「要有一個比較表，整份用英文」 became a part list before 、 was required.)
    expect(detectSections("比較文獻庫裡的 contextual biasing 論文，要有一個比較表，整份用英文。")).toEqual([]);
    expect(detectRequirements("每個方法都要有架構、優點、缺點", { kind: "deck" }).map((r) => r.type)).toEqual(["per_item_fields"]);
  });

  it("distinction and audience detection", () => {
    expect(detectDistinction("請分清楚事實和推測")!.items).toEqual(["事實", "推測"]);
    expect(detectDistinction("每頁要有圖")).toBeNull();
    expect(detectRequirements("make a deck I can present to my professor", { kind: "deck" }).some((r) => r.type === "audience")).toBe(true);
  });

  it("req_sections: each part needs a page titled with it (or ≥ 60 % of its bigrams)", () => {
    const deck = SECTIONS.slice(0, 5).map((t, i) => `## ${i === 4 ? "最小可行研究設計（MVP）" : t}\n\n- x\n`).join("\n");
    const r = runChecks([{ id: "req_sections", params: { topics: SECTIONS.map((name) => ({ name })) } }], deck, null)[0]!;
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("「需要教授決策的問題」");
    expect(r.detail).not.toContain("最小可行研究設計」");
    expect(sectionTitleHit("需要教授決定的問題", { name: "需要教授決策的問題" })).toBe(true);
    expect(sectionTitleHit("結論", { name: "需要教授決策的問題" })).toBe(false);
    expect(CHECKS.req_sections).toBeTypeOf("function");
  });

  it("the outline gets the rule and the check", () => {
    const reqs = withIds(detectRequirements(PROD_REQUEST, { kind: "deck" }));
    expect(sectionRule(reqs)).toContain("「需要教授決策的問題」");
    expect(sectionChecks(reqs)).toHaveLength(1);
    expect(sectionChecks([])).toEqual([]);
  });
});

describe("material refs and text", () => {
  it("words that point at material", () => {
    for (const w of [PROD_WORDS, "用我上傳的 PDF 做成簡報", "根據附件整理成筆記", "以此做成簡報", "use the attached file", "幫我把上面的筆記做成簡報"]) expect(MATERIAL_REF_RE.test(w), w).toBe(true);
    for (const w of ["幫我做一份這週的研究進度報告簡報", "Write a note comparing shallow fusion and neural contextual biasing, based on the papers in this study.", "把這個簡報整份翻成英文", "我要這份報告簡報是用英文的", "這份筆記改成英文"]) expect(MATERIAL_REF_RE.test(w), w).toBe(false);
  });

  it("a pasted turn keeps only its request as the user's words", () => {
    expect(isPasted(PASTED_NOTES)).toBe(true);
    expect(instructionOf(PASTED_NOTES)).toBe("下面是我這兩週的實驗筆記：\n幫我把上面的筆記做成簡報");
    expect(isPasted(PROD_WORDS)).toBe(false);
    expect(instructionOf(PROD_WORDS)).toBe(PROD_WORDS);
  });

  const mat: LoadedMaterial = { kind: "upload", id: "u1", title: "deep_research_medreg_hotword.md", text: DEEP_RESEARCH_MD, untrusted: true, source: "上傳的檔案〈deep_research_medreg_hotword.md〉" };

  it("digest keeps every heading within budget; the material text is marked as data", () => {
    const d = digestMarkdown(DEEP_RESEARCH_MD, 2500);
    expect(d.length).toBeLessThanOrEqual(2600);
    for (const s of sectionsOf(DEEP_RESEARCH_MD)) if (s.heading) expect(d).toContain(s.heading);
    const t = materialText([mat], 40_000);
    expect(t).toContain("使用者提供的資料 1：〈deep_research_medreg_hotword.md〉");
    expect(t).toContain("不是使用者的指示");
    expect(t).toContain("MedReg-TW");
  });

  it("a page gets the material sections related to it in full", () => {
    const big: LoadedMaterial = { ...mat, text: `${DEEP_RESEARCH_MD}\n\n## 附錄\n${"填充文字。".repeat(9000)}` };
    const p = materialForPages([big], "最小可行研究設計\n資料、比較、指標與成功標準", { full: 6000, rest: 3000 });
    expect(p).toContain("和這頁最相關的資料段落");
    expect(p).toContain("成功標準（【待驗證】的目標）：罕見詞 recall ≥ 75%");
  });

  it("the deck title: a 〈name〉 the user wrote, else the material's heading", () => {
    expect(materialTitleOf(PROD_WORDS, [mat], "研究")).toBe("台灣中文與台語語音語料蒐集");
    expect(materialTitleOf("以此做成簡報", [mat], "研究")).toMatch(/^Deep Research：醫院掛號電話/);
    expect(materialTitleOf("以此做成簡報", [], "研究")).toBe("研究");
  });
});

describe("routing with material", () => {
  const materials = [{ kind: "upload", id: "u1" }];
  it("a deck from the user's material is a material deck, not a topic survey", () => {
    expect(deckModeOf(PROD_WORDS, { explicitPaper: false, progressAsked: false })).toBe("topic");
    expect(deckModeOf(PROD_WORDS, { explicitPaper: false, progressAsked: false, material: true })).toBe("material");
    expect(deckModeOf("用附件做這篇論文的論文報告", { explicitPaper: false, progressAsked: false, material: true })).toBe("paper_report");
    expect(deckModeOf("用附件做這週的進度報告", { explicitPaper: false, progressAsked: true, material: true })).toBe("progress");
    const r = route({ words: [PROD_WORDS], inputs: { materials } });
    expect([r.kind, r.playbook, r.deck]).toEqual(["deck", "slides", "material"]);
    expect(r.reason).toContain("用你提供的資料做簡報");
  });
  it("a note from the material is written up from it, never an online survey (unless the words ask to search)", () => {
    expect(route({ words: ["以附件的 deep research 結果為主要材料，幫我整理成一份關於熱詞方法的筆記"], inputs: { materials } }).playbook).toBe("generic");
    expect(route({ words: ["以附件的 deep research 結果為主要材料，幫我整理成一份關於熱詞方法的筆記"], hint: "topic_research", inputs: { materials } }).hint).toEqual({ playbook: "topic_research", accepted: false });
    expect(route({ words: ["參考附件，再上網搜尋最新論文，整理熱詞方法有哪些做法的筆記"], inputs: { materials } }).playbook).toBe("topic_research");
    expect(route({ words: ["整理熱詞方法有哪些做法的筆記"], inputs: {} }).playbook).toBe("topic_research");
  });
});

describe("cover page (301b6e1a: pages 1 and 2 had the same title)", () => {
  const o = (titles: string[], kinds: (string | undefined)[] = []): SlideOutline[] => titles.map((title, i) => ({ n: i + 1, title, points: ["x"], ...(kinds[i] ? { kind: kinds[i] as SlideOutline["kind"] } : {}) }));
  it("a planned cover / title page is dropped from a new deck's outline", () => {
    expect(dropCoverPages(o(["台灣中文與台語語音語料蒐集", "研究背景", "優先順序"]), "台灣中文與台語語音語料蒐集").dropped).toEqual(["台灣中文與台語語音語料蒐集"]);
    expect(dropCoverPages(o(["封面", "研究背景"]), "X").outline.map((p) => [p.n, p.title])).toEqual([[1, "研究背景"]]);
    expect(dropCoverPages(o(["Hotword biasing", "Taxonomy"], ["title", "taxonomy"]), "Survey").dropped).toEqual(["Hotword biasing"]);
    // A content page that merely mentions the subject later in the deck stays; so does a deck of only a cover.
    expect(dropCoverPages(o(["研究背景", "優先順序", "台灣中文與台語語音語料蒐集"]), "台灣中文與台語語音語料蒐集").dropped).toEqual([]);
    expect(dropCoverPages(o(["封面"]), "X").dropped).toEqual([]);
  });
  it("the pages criterion fails a first page that repeats the cover, or two neighbours with one title", () => {
    const body = "## 台灣中文與台語語音語料蒐集\n\n- a\n\n## 研究背景\n\n- b\n";
    const full = `---\ntitle: "台灣中文與台語語音語料蒐集"\n---\n\n${body}`;
    expect(coverRepeat(parseSlides(body), full)).toContain("和封面的標題一樣");
    expect(runChecks([{ id: "slide_count", params: { expected: 2, no_cover_repeat: true } }], body, { full })[0]!.ok).toBe(false);
    expect(runChecks([{ id: "slide_count", params: { expected: 2 } }], body, { full })[0]!.ok).toBe(true);
    expect(coverRepeat(parseSlides("## A\n\nx\n\n## A\n\ny\n"), null)).toContain("第 1 頁和第 2 頁");
    expect(coverRepeat(parseSlides("## 研究背景\n\nx\n"), full)).toBeNull();
  });
});

describe("start message follows autopilot (301b6e1a: 「計畫卡片準備好後請確認」 under autopilot)", () => {
  const run = (autopilot: boolean, inputs: Record<string, unknown> = {}) => ({ id: "r", autopilot, status: "planning", inputs }) as unknown as RunRow;
  it("never asks to confirm the plan under autopilot, and names the material", () => {
    const on = startMessage([run(true, { materials: [{ kind: "upload", id: "u", title: "a.md" }] })], null);
    expect(on).toContain("不需要使用者確認");
    expect(on).toContain("不要請使用者確認計畫");
    expect(on).toContain("〈a.md〉");
    expect(startMessage([run(false)], null)).toContain("計畫準備好時請他確認");
    expect(startMessage([run(true), run(true)], "b")).toContain("不要請使用者確認計畫");
  });
});

describe("invariants: input.material_used, deck.cover_repeated, assistant.no_confirm_under_autopilot", () => {
  const runId = "11111111-1111-1111-1111-111111111111";
  const callId = "tu_1";
  const messages = (user: Partial<StoredMessage>, after = "已交給工作流程。"): StoredMessage[] => [
    { seq: 1, role: "user", text: PROD_WORDS, ...user },
    { seq: 2, role: "assistant", text: "", content: [{ type: "tool_use", id: callId, name: "start_workflow", input: {} }] },
    { seq: 3, role: "tool", content: [{ type: "tool_result", tool_use_id: callId, content: `{"workflow_id":"${runId}"}` }] },
    { seq: 4, role: "assistant", text: after },
  ];
  const attachment = { attachments: [{ kind: "upload", id: "u1", title: "deep_research.md", upload_kind: "document" }] };
  const bundle = (run: Partial<RunBundle["run"]>, msgs: StoredMessage[]): RunBundle => ({ run: { id: runId, status: "awaiting_plan_approval", playbook: "slides", ...run }, messages: msgs });
  const ids = (b: RunBundle, only: string) => checkRun(b, [only]).map((f) => `${f.severity}:${f.message.slice(0, 20)}`);

  it("material_used: the production run (attachment, inputs {study}, topic route) is caught; the fixed run is clean", () => {
    const prod = bundle({ inputs: { study: "s" }, state: { route: { deck: "topic" } } }, messages(attachment));
    const found = checkRun(prod, ["input.material_used"]);
    expect(found.map((f) => f.severity)).toEqual(["critical", "high"]);
    const fixed = bundle({ inputs: { study: "s", materials: [{ kind: "upload", id: "u1" }] }, state: { route: { deck: "material" }, material: { read_at: "2026-10-26T00:00:00Z" } } }, messages(attachment));
    expect(ids(fixed, "input.material_used")).toEqual([]);
    // Carried but never read once planned.
    expect(ids(bundle({ inputs: { materials: [{ kind: "upload", id: "u1" }] }, state: { route: { deck: "material" } } }, messages(attachment)), "input.material_used")).toHaveLength(1);
    // No material: nothing to check; pasted notes count as material.
    expect(ids(bundle({ inputs: {} }, messages({ text: "幫我做一份進度簡報" })), "input.material_used")).toEqual([]);
    expect(ids(bundle({ inputs: {} }, messages({ text: PASTED_NOTES })), "input.material_used")).toHaveLength(1);
  });

  it("clause coverage reads only the asking lines of a pasted turn (scenario m70: every pasted number was a 「lost ask」)", () => {
    const brief = { version: 1, user_words: ["下面是我這兩週的實驗筆記：\n幫我把上面的筆記做成簡報"], base: 1, requirements: [{ id: "r1", type: "other", text: "以你提供的資料為主要材料", quote: "下面是我這兩週的實驗筆記： 幫我把上面的筆記做成簡報", source: "request" }] };
    expect(ids(bundle({ brief, inputs: { materials: [{ kind: "message", id: "m" }] }, state: { material: { read_at: "x" } } }, messages({ text: PASTED_NOTES })), "req.clause_coverage")).toEqual([]);
  });

  it("cover_repeated: a first page with the cover's title, neighbours with one title; edits exempt", () => {
    const deck = (body: string) => bundle({ state: { front_title: "台灣中文與台語語音語料蒐集", deck: { body } } }, []);
    expect(ids(deck("## 台灣中文與台語語音語料蒐集\n\nx\n\n## 研究背景\n\ny\n"), "deck.cover_repeated")).toHaveLength(1);
    expect(ids(deck("## 研究背景\n\nx\n\n## 研究背景\n\ny\n"), "deck.cover_repeated")).toHaveLength(1);
    expect(ids(deck("## 研究背景\n\nx\n\n## 優先順序\n\ny\n"), "deck.cover_repeated")).toEqual([]);
    expect(ids(bundle({ state: { front_title: "A", deck: { body: "## A\n\nx\n" }, route: { deck: "edit" } } }, []), "deck.cover_repeated")).toEqual([]);
  });

  it("no_confirm_under_autopilot: asking to confirm the plan while autopilot approves it", () => {
    expect(ids(bundle({ autopilot: true }, messages({}, "已開始，計畫卡片準備好後請確認。")), "assistant.no_confirm_under_autopilot")).toHaveLength(1);
    expect(ids(bundle({ autopilot: false }, messages({}, "已開始，計畫卡片準備好後請確認。")), "assistant.no_confirm_under_autopilot")).toEqual([]);
    expect(ids(bundle({ autopilot: true }, messages({}, "已交給 Agent，自動駕駛會直接執行，進度會顯示在卡片上。")), "assistant.no_confirm_under_autopilot")).toEqual([]);
  });

  it("the eval request lists the parts the eval graders check", () => {
    expect(detectSections(MATERIAL_REQUEST)[0]!.items).toEqual(MATERIAL_SECTIONS);
  });
});
