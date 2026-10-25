/**
 * Production conversation 79ab0678 (2026-10-25), with its exact texts: a spoken (ASR) topic-deck request whose 6 asks
 * became 1 requirement, a notes-language revise whose standing English preference overrode the new words, unrelated chat
 * turns in the Brief, a study name that became the topic, venues that never reached the writers, a taxonomy no rewrite
 * could fix, and a judge that named no number or page.
 */
import { describe, expect, it } from "vitest";
import { taskTurns } from "../src/workflows/brief.js";
import { detectPartLanguages, detectPerItemFields, detectRequirements, languageViolations, mergeRequirements, notesLanguage, requirementCriteria, segmentClauses, targetLanguage, trivialClause, uncoveredClauses } from "../src/workflows/requirements.js";
import { REFER_BACK_RE } from "../src/workflows/context.js";
import { missingNames, nameIn, topicSubjectOf, LIBRARY_SURVEY_RE, withAllSources } from "../src/workflows/playbooks/slides.js";
import { bibLine } from "../src/workflows/playbooks/research.js";
import { playbookLabel } from "../src/workflows/playbooks/index.js";
import { withLocation } from "../src/workflows/verify.js";
import { runChecks } from "../src/workflows/checks.js";
import type { Requirement } from "../src/workflows/types.js";
import { REQUEST_A, REQUEST_B } from "./fixtures-79ab.js";

const QUESTION = "我想要知道我們目前這個簡報它是偏向Hot Word還是Contextual Biasing";
const STUDY = "串流 ASR 的動態熱詞效率研究";

const req = (r: Omit<Requirement, "id" | "source">, source: Requirement["source"] = "request") => ({ ...r, source });

describe("79ab0678 problem 5: a spoken request's asks are all accounted for", () => {
  it("segments the run-on request into one clause per ask", () => {
    expect(segmentClauses(REQUEST_A)).toEqual([
      "我要你幫我做一個簡報這個簡報裡面詳細描述了目前時數界是怎麼在Zipformer和RNNT的架構下做熱詞機制的",
      "我要你參考我們的文獻庫",
      "那請你詳細統計一下有哪幾種方法",
      "並且詳細敘述每一種方法的好處跟壞處",
      "我要這份報告簡報是用英文的",
      "並且在講解方法的時候要搭配模型的架構圖來更好的演示",
      "並且在提到方法的時候要講到這一篇論文是哪一篇",
      "還有他們的會議或是期刊是哪一個",
    ]);
  });
  it("detects the language with a short quote and ONE per-item requirement with all five fields", () => {
    const r = detectRequirements(REQUEST_A, { kind: "deck" });
    expect(r.find((x) => x.type === "language")).toMatchObject({ params: { language: "en" }, quote: "我要這份報告簡報是用英文的" });
    const f = r.find((x) => x.type === "per_item_fields")!;
    expect(f.params!.item_kind).toBe("方法");
    expect(f.params!.fields!.map((x) => x.name)).toEqual(["優點", "缺點", "架構圖", "論文", "發表會議／期刊"]);
    expect(f.params!.fields!.find((x) => x.name === "發表會議／期刊")!.aliases).toEqual(expect.arrayContaining(["Interspeech", "ICASSP", "arXiv", "Venue"]));
    expect(f.quote).toContain("好處跟壞處");
    expect(f.quote).toContain("會議或是期刊");
  });
  it("every other content clause becomes a judged requirement unless mapped or dropped", () => {
    const clauses = segmentClauses(REQUEST_A);
    const det = detectRequirements(REQUEST_A, { kind: "deck" });
    const left = uncoveredClauses(clauses, det, new Set(), new Set(), "deck");
    // The library + tally asks are a deterministic requirement now; the topic clause is left for the user's own words.
    expect(det.find((r) => r.type === "other")).toMatchObject({ text: "以研究文獻庫的論文為來源，統計並列出有哪幾種方法（每一類都有代表論文）", quote: "我要你參考我們的文獻庫 那請你詳細統計一下有哪幾種方法" });
    expect(left).toEqual([clauses[0]]);
    // A clause the model mapped (1-based → index) or dropped with a reason is accounted for.
    expect(uncoveredClauses(clauses, det, new Set([0]), new Set(), "deck")).toEqual([]);
  });
  it("a one-ask request is the task itself (no extra items); filler clauses are trivial", () => {
    expect(uncoveredClauses(segmentClauses("整理一份熱詞方法的筆記"), [], new Set(), new Set(), "doc")).toEqual([]);
    expect(trivialClause("有個東西")).toBe(true);
    expect(trivialClause("我要你幫我做一個簡報")).toBe(true);
  });
  it("the classic forms still work", () => {
    expect(detectPerItemFields("每個方法要有架構、Pros/Cons")!.fields!.map((f) => f.name)).toEqual(["架構", "Pros", "Cons"]);
  });
});

describe("79ab0678 problem 1: the new words override a standing preference on the same dimension", () => {
  it("「講稿要是中文的」 is a notes-only language (+ English terms) and 「一比一的念出來」 a read-aloud tone", () => {
    expect(detectPartLanguages(REQUEST_B)).toEqual([{ part: "notes", language: "zh", span: "講稿要是中文" }]);
    const r = detectRequirements(REQUEST_B, { kind: "deck" });
    expect(r.map((x) => [x.type, x.params?.language ?? null, x.params?.part])).toEqual([["language", "zh", "notes"], ["tone", null, "notes"]]);
    expect(r[0]!.text).toContain("專有名詞多用英文");
  });
  it("merged with the deck's standing 「全部 English」: notes 繁中 (request), slides English (standing, narrowed)", () => {
    const standing = req({ type: "language", text: "成果全部用English（封面、標題、內文、圖表標籤與講稿都不留中文）（沿用這份簡報的設定）", params: { language: "en" } }, "standing");
    const merged = mergeRequirements(detectRequirements(REQUEST_B, { kind: "deck" }).map((x) => req(x)), [standing]);
    expect(merged.map((x) => [x.type, x.params?.language ?? null, x.params?.part ?? null, x.source])).toEqual([["language", "zh", "notes", "request"], ["tone", null, "notes", "request"], ["language", "en", "slides", "standing"]]);
    expect(merged[2]!.text).toBe("投影片（封面、標題、內文、圖表標籤）用English（沿用這份簡報的設定）");
    expect(targetLanguage(merged)).toBe("en");
    expect(notesLanguage(merged)).toBe("zh");
    // Checked per part: English slides + Chinese notes pass both; English notes fail the notes requirement only.
    const crit = requirementCriteria(merged, "deck");
    const deck = (notes: string) => `---\ntitle: "Hotword Mechanisms"\n---\n\n## Shallow Fusion\n\n- Adds a contextual score during beam search\n\n::: {.notes}\n${notes}\n:::\n`;
    const zhNotes = "這一頁講 shallow fusion：在 beam search 的時候，我們把 contextual biasing 的分數加進去，所以不用重新訓練 model。";
    const enNotes = "This slide explains shallow fusion: during beam search we add a contextual score, so the model does not need retraining at all.";
    const check = (c: (typeof crit)[number], text: string) => runChecks([c.check!], text, { full: text })[0]!;
    expect(check(crit[0]!, deck(zhNotes)).ok).toBe(true);
    expect(check(crit[2]!, deck(zhNotes)).ok).toBe(true);
    expect(check(crit[0]!, deck(enNotes)).ok).toBe(false);
    expect(check(crit[2]!, deck(enNotes)).ok).toBe(true);
    expect(crit[1]!.kind).toBe("judge");
    expect(languageViolations(deck(zhNotes), "en", [], false, "slides")).toEqual([]);
  });
});

describe("79ab0678 problem 3: only the turns of this task are the user's words", () => {
  it("drops a question the assistant answered and an 「ok」", () => {
    const turns = [
      { role: "user", text: QUESTION, content: [] },
      { role: "assistant", text: "", content: [{ type: "tool_use", name: "get_workflow" }] },
      { role: "assistant", text: "目前這份簡報整體偏向 Contextual Biasing。", content: [] },
      { role: "user", text: "ok", content: [] },
      { role: "assistant", text: "好的。", content: [] },
      { role: "user", text: REQUEST_B, content: [] },
    ];
    expect(taskTurns(turns)).toEqual([REQUEST_B]);
  });
  it("keeps turns the assistant answered by asking back, and consecutive user messages", () => {
    expect(taskTurns([
      { role: "user", text: "幫我做簡報", content: [] },
      { role: "assistant", text: "要做哪個主題？", content: [] },
      { role: "user", text: "熱詞", content: [] },
    ])).toEqual(["幫我做簡報", "熱詞"]);
    expect(taskTurns([{ role: "user", text: "做一份簡報", content: [] }, { role: "user", text: "要英文", content: [] }])).toEqual(["做一份簡報", "要英文"]);
  });
});

describe("79ab0678 problems 2 + 4: study answers and the topic", () => {
  it("「就剛剛的那個研究 同一個簡報繼續做」 points back at the conversation", () => {
    expect(REFER_BACK_RE.test("就剛剛的那個研究 同一個簡報繼續做")).toBe(true);
  });
  it("the topic is the request's subject, never the study's name", () => {
    const t = topicSubjectOf(REQUEST_A)!;
    expect(t).toContain("Zipformer");
    expect(t).toContain("熱詞機制");
    expect(t).not.toContain("效率");
    expect(topicSubjectOf(STUDY)).toBeNull();
    expect(topicSubjectOf("幫我做一份關於動態熱詞做法的簡報")).toBe("動態熱詞做法");
  });
  it("an edit of a deck is named 「修改簡報」, not 「從 0 到 1 建立簡報」", () => {
    expect(playbookLabel("slides", { deck: "edit", edit: "revise" })).toBe("修改簡報");
    expect(playbookLabel("slides", { deck: "topic" })).toBe("從 0 到 1 建立簡報");
  });
});

describe("79ab0678 problems 6–8: metadata, library coverage, structural failures, located fails", () => {
  it("bibliographic lines carry the venue (arXiv when there is none, nothing invented)", () => {
    expect(bibLine({ authors_text: "Zhehuai Chen; Mahaveer Jain", year: 2019, venue: "Interspeech" })).toBe("Chen et al., 2019, Interspeech");
    expect(bibLine({ authors_text: "Andrei Andrusenko", year: 2024, venue: null, arxiv_id: "2406.07096" })).toBe("Andrusenko, 2024, arXiv preprint (arXiv:2406.07096)");
    expect(bibLine({ authors_text: "", year: 2020, venue: null })).toBe("2020");
  });
  it("「參考我們的文獻庫…統計有哪幾種方法」 asks to cover the library; the taxonomy then rests on every paper", () => {
    expect(LIBRARY_SURVEY_RE.test(REQUEST_A)).toBe(true);
    expect(LIBRARY_SURVEY_RE.test("做一份關於熱詞偏置做法的主題簡報")).toBe(false);
    const outline = withAllSources([{ n: 1, title: "T", points: [], kind: "title" }, { n: 2, title: "Taxonomy", points: [], kind: "taxonomy", sources: ["P1"] }], 3);
    expect(outline[1]!.sources).toEqual(["P1", "P2", "P3"]);
  });
  it("names a coverage failure is missing, and whether a paper covers them", () => {
    const reason = "分類頁未呈現完整六類方法，缺少 Contextual density-ratio，且未以明確方法名稱呈現 CTC detection and post-processing。";
    expect(missingNames(reason)).toEqual(["Contextual density-ratio", "CTC detection and post-processing"]);
    expect(nameIn("Contextual density-ratio", "Contextual Density Ratio for Language Model Biasing of Sequence to Sequence ASR Systems")).toBe(true);
    expect(nameIn("Contextual density-ratio", "Fast Context-Biasing for CTC and Transducer ASR models with CTC-based Word Spotter")).toBe(false);
  });
  it("a fail with evidence names its page and numbers", () => {
    const deck = "## Method 2\n\n- Precision decreased.\n\n::: {.notes}\nits contextual-word precision decreased from 0.934 to 0.922.\n:::\n\n## Results\n\n- x";
    expect(withLocation("此數字在提供的論文摘錄與研究資料中找不到對應來源。", "its contextual-word precision decreased from 0.934 to 0.922.", deck))
      .toBe("此數字在提供的論文摘錄與研究資料中找不到對應來源。（第 1 頁「Method 2」：「its contextual-word precision decreased from 0.934 to 0.922.」；數字 0.934、0.922）");
  });
});

describe("79ab0678 problem 3: an assistant answer ends the task's turns (scenario matrix: an unrelated Q&A in the Brief)", () => {
  it("drops an earlier exchange the assistant answered, even when the question had no question mark", () => {
    expect(taskTurns([
      { role: "user", text: "CER 和 WER 有什麼差別？用兩三句話回答就好。", content: [] },
      { role: "assistant", text: "CER 以字為單位計算錯誤率，WER 以詞為單位。", content: [] },
      { role: "user", text: "在這個簡報加一頁比較表", content: [] },
    ])).toEqual(["在這個簡報加一頁比較表"]);
  });
  it("keeps the request when the assistant asked back before the go-ahead", () => {
    expect(taskTurns([
      { role: "user", text: "幫我做一份熱詞的簡報", content: [] },
      { role: "assistant", text: "要用中文還是英文？", content: [] },
      { role: "user", text: "要英文，開始吧", content: [] },
    ])).toEqual(["幫我做一份熱詞的簡報", "要英文，開始吧"]);
  });
});

describe("mixed Chinese / English words are not split at their spaces", () => {
  it("「介紹串流 ASR 的 contextual biasing 有哪些做法」 stays one clause and is the topic", () => {
    const t = "幫我做一份簡報，介紹串流 ASR 的 contextual biasing 有哪些做法，用我們的文獻庫，8 頁";
    expect(segmentClauses(t)).toEqual(["幫我做一份簡報", "介紹串流 ASR 的 contextual biasing 有哪些做法", "用我們的文獻庫 8 頁"]);
    expect(topicSubjectOf(t)).toBe("串流 ASR 的 contextual biasing 有哪些做法");
  });
});

describe("partial reports in plain words", () => {
  it("P<n> and approved_outline become the paper's title / 確認的大綱", async () => {
    const { plainLabels } = await import("../src/workflows/notify.js");
    const run = { state: { topic: { picks: [{ title: "Contextual Density Ratio: for biasing" }] } } };
    expect(plainLabels(run, "內容只來自論文摘錄（P1…）：P1 摘錄沒有這個數字；分類頁未列出 approved_outline 要求的分類")).toBe("內容只來自論文摘錄：〈Contextual Density Ratio〉 摘錄沒有這個數字；分類頁未列出 確認的大綱 要求的分類");
  });
});

describe("scenario matrix (docs/research/agent-invariants.md) classes on the current code", () => {
  const det = (t: string) => detectRequirements(t, { kind: "deck" });
  it("「大概 8 頁」 is a page count; 「講稿維持中文」 a notes language; 「整份 translate 成英文」 the whole deck", () => {
    expect(det("幫我做一份這週的研究進度報告簡報，大概 8 頁，投影片用英文，講稿用中文。").map((r) => [r.type, r.params?.exact ?? r.params?.language, r.params?.part])).toEqual([["language", "zh", "notes"], ["language", "en", "slides"], ["page_count", 8, undefined]]);
    expect(det("把這個簡報的投影片內容改成英文，講稿維持中文。").map((r) => [r.params?.language, r.params?.part])).toEqual([["zh", "notes"], ["en", "slides"]]);
    expect(det("同一個簡報 整份 translate 成英文，cover 跟 speaker notes 也要。")[0]).toMatchObject({ params: { language: "en" }, quote: "整份 translate 成英文 cover 跟 speaker notes 也要" });
  });
  it("「註明論文和會議或期刊」「專有名詞保留英文」 are accounted for", () => {
    const r = det("每種方法都要寫優點和缺點，提到方法時要註明是哪一篇論文和它的會議或期刊");
    expect(r.find((x) => x.type === "per_item_fields")!.params!.fields!.map((f) => f.name)).toEqual(["優點", "缺點", "論文", "發表會議／期刊"]);
    expect(det("幫我改剛剛那個簡報的講稿，講稿要是中文的，專有名詞保留英文")[0]!.quote).toContain("專有名詞保留英文");
  });
  it("「幫我整理一份筆記…用我們文獻庫的論文」 is a note, not a LaTeX paper", async () => {
    const { deliverableFromWords } = await import("../src/workflows/brief.js");
    expect(deliverableFromWords(["幫我整理一份筆記，說明串流 ASR 熱詞偏置有哪些做法，用我們文獻庫的論文。"])).toBe("note");
  });
  it("a new deck asked on a deck page is new; 「剛剛那個／同一個／繼續」 point at the conversation's deck", async () => {
    const { newDeckAsked } = await import("../src/workflows/route.js");
    const { POINTS_AT_RE } = await import("../src/workflows/context.js");
    expect(newDeckAsked("Make a progress report deck for this week's research, about 8 slides")).toBe(true);
    expect(newDeckAsked("幫我做 paper report 的 slides，報告〈Contextual Adapters〉")).toBe(true);
    expect(newDeckAsked("幫我改這個簡報的講稿，講稿要是中文的")).toBe(false);
    expect(newDeckAsked("把這個簡報做成英文版")).toBe(false);
    for (const t of ["幫我改剛剛那個簡報的講稿", "同一個簡報 的 speaker notes 改成中文", "繼續剛剛的，把那個簡報整份翻成英文"]) expect(POINTS_AT_RE.test(t)).toBe(true);
  });
  it("a delegate answer picks among the items; a title wins", async () => {
    const { pickFromAnswer } = await import("../src/workflows/playbooks/common.js");
    const projects = [{ id: "a", title: "串流 RNN-T 動態熱詞偏置方法綜述" }, { id: "b", title: "低資源語音辨識" }];
    expect(pickFromAnswer(projects, "你決定")?.id).toBe("a");
    expect(pickFromAnswer(projects, "寫進 低資源語音辨識")?.id).toBe("b");
    expect(pickFromAnswer(projects, "隨便寫點東西吧不知道")?.id).toBe("a");
  });
});

describe("a bare page count at the end of a clause", () => {
  it("「用我們的文獻庫，8 頁」 is 8 pages; 「第 8 頁」 is not a count", async () => {
    const { detectPageCount } = await import("../src/workflows/requirements.js");
    expect(detectPageCount("幫我做一份簡報，介紹串流 ASR 的 contextual biasing 有哪些做法，用我們的文獻庫，8 頁")).toEqual({ exact: 8 });
    expect(detectPageCount("第 8 頁要改")).toBeNull();
    expect(detectPageCount("刪掉第 3 頁")).toBeNull();
  });
});
