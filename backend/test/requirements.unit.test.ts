/**
 * Requirement ledger (pure parts): detection from the user's words, cleaning model output, merging with standing
 * preferences, the deterministic checks on whole artifacts (cover included), the prompt block and the regression diff.
 */
import { describe, expect, it } from "vitest";
import { runChecks } from "../src/workflows/checks.js";
import {
  cleanRequirement, detectExclude, detectLanguage, detectPageCount, detectPerItemFields, detectRequirements, editedRequirements, frontMatter,
  inferLanguage, labelsFor, languageViolations, mergeRequirements, regressions, requirementCriteria, requirementsBlock, requirementRepair, withRequirementCriteria,
} from "../src/workflows/requirements.js";
import { withRequirements } from "../src/workflows/env.js";
import { replacePages } from "../src/workflows/playbooks/slides-requirements.js";
import { editKindOf } from "../src/workflows/playbooks/slides.js";
import { latexHeadings } from "../src/workflows/playbooks/latex.js";
import type { Criterion, Requirement, StepRow } from "../src/workflows/types.js";

const deck = (title: string, slides: string[]) => `---\ntitle: "${title}"\nauthor: "陳柏宇"\ndate: "2026-10-23"\n---\n\n${slides.join("\n\n")}\n`;
const slide = (t: string, body: string, notes: string) => `## ${t}\n\n${body}\n\n::: {.notes}\n${notes}\n:::`;

describe("detection", () => {
  it("finds the output language only when the user asks for it", () => {
    expect(detectLanguage("我整個簡報要用英文")).toBe("en");
    expect(detectLanguage("整份改成英文")).toBe("en");
    expect(detectLanguage("Translate every remaining Chinese phrase into clear academic English")).toBe("en");
    expect(detectLanguage("做一份英文版簡報")).toBe("en");
    expect(detectLanguage("改回中文")).toBe("zh");
    // 「專有名詞保留英文」 is about terms, not the output language; a plain follow-up says nothing.
    expect(detectLanguage("專有名詞保留英文，其他照舊")).toBeNull();
    expect(detectLanguage("還不夠細，focus 在動態熱詞")).toBeNull();
  });

  it("page counts: exact, ranges, bounds; page references are not counts", () => {
    expect(detectPageCount("做成 20 頁")).toEqual({ exact: 20 });
    expect(detectPageCount("15–20 頁的簡報")).toEqual({ min: 15, max: 20 });
    expect(detectPageCount("至少 10 頁")).toEqual({ min: 10 });
    expect(detectPageCount("a 12-slide deck")).toEqual({ exact: 12 });
    expect(detectPageCount("第 8 頁還有中文")).toBeNull();
    expect(detectPageCount("x", 9)).toEqual({ exact: 9 });
  });

  it("per-item fields from 「每個方法要有架構、Pros/Cons」 with bilingual aliases", () => {
    const p = detectPerItemFields("再詳細一點，每個方法要有架構、Pros/Cons")!;
    expect(p.item_kind).toBe("方法");
    expect(p.fields!.map((f) => f.name)).toEqual(["架構", "Pros", "Cons"]);
    expect(p.fields![0]!.aliases).toContain("Architecture");
    expect(p.fields![2]!.aliases).toContain("缺點");
    expect(detectPerItemFields("For each method include the architecture, pros and cons")!.fields!.map((f) => f.name)).toEqual(["architecture", "pros", "cons"]);
  });

  it("removals by page number or quoted title", () => {
    expect(detectExclude("刪掉第 3 頁")).toEqual({ scope: "page", pages: [3], terms: [] });
    expect(detectExclude("把「卡住」這頁拿掉")).toBeNull();
    expect(detectExclude("拿掉「卡住」這頁")!.terms).toEqual([{ name: "卡住" }]);
  });

  it("detectRequirements types each one; notes get no page count", () => {
    const r = detectRequirements("整份改成英文，做成 12 頁", { kind: "deck" });
    expect(r.map((x) => x.type)).toEqual(["language", "page_count"]);
    expect(detectRequirements("用英文寫，大約 3 頁", { kind: "doc" }).map((x) => x.type)).toEqual(["language"]);
  });
});

describe("cleaning and merging", () => {
  it("cleans model output per type and drops unusable entries", () => {
    expect(cleanRequirement({ type: "include_topics", text: "聚焦動態熱詞", params: { topics: [{ name: "dynamic hotwording", aliases: ["動態熱詞"] }] } }, "request")!.params!.topics![0]!.aliases).toEqual(["動態熱詞"]);
    expect(cleanRequirement({ type: "include_topics", text: "聚焦", params: {} }, "request")!.type).toBe("other");
    expect(cleanRequirement({ type: "per_item_fields", text: "每個方法要有 Pros/Cons", params: { fields: [{ name: "Pros/Cons" }] } }, "request")!.params!.fields!.map((f) => f.name)).toEqual(["Pros", "Cons"]);
    expect(cleanRequirement({ type: "page_count", text: "10 頁" }, "request", "doc")!.type).toBe("length");
    expect(cleanRequirement({ type: "nonsense", text: "" }, "request")).toBeNull();
  });

  it("the request beats standing preferences; standing fills what the request did not say", () => {
    const standing = [{ type: "language" as const, text: "成果全部用 English（沿用這份簡報的設定）", params: { language: "en" as const }, source: "standing" as const }];
    const follow = mergeRequirements(detectRequirements("再詳細一點，每個方法要有架構、Pros/Cons").map((r) => ({ ...r, source: "request" as const })), standing);
    expect(follow.find((r) => r.type === "language")!.source).toBe("standing");
    expect(follow.find((r) => r.type === "per_item_fields")).toBeTruthy();
    const switched = mergeRequirements(detectRequirements("改回中文").map((r) => ({ ...r, source: "request" as const })), standing);
    expect(switched.filter((r) => r.type === "language")).toHaveLength(1);
    expect(switched[0]!.params!.language).toBe("zh");
  });

  it("plan-card edits: reworded text is typed again, removed ones are reported", () => {
    const prev: Requirement[] = [{ id: "r1", type: "language", text: "成果全部用English", params: { language: "en" }, source: "request" }, { id: "r2", type: "audience", text: "給指導教授看", source: "request" }];
    const { list, removed } = editedRequirements(prev, [{ id: "r1", text: "改成中文" }, { text: "每個方法要有 Pros/Cons" }], "deck");
    expect(list.map((r) => r.type)).toEqual(["language", "per_item_fields"]);
    expect(list[0]!.params!.language).toBe("zh");
    expect(list[0]!.source).toBe("user");
    expect(removed).toHaveLength(1);
  });

  it("standing language is inferred from an English artifact", () => {
    expect(inferLanguage("## Problem\n\nDynamic hotwording biases the decoder towards user-provided phrases during streaming recognition so rare names are recognised; contextual biasing adds a trie of the phrases and boosts matching prefixes while decoding, which helps rare words without retraining the acoustic model. Shallow fusion is the simplest variant and needs no extra training data at all.")).toBe("en");
    expect(inferLanguage("## 問題\n\n動態熱詞讓解碼器偏向使用者提供的詞，Zipformer 與 RNN-T 都適用。")).toBeNull();
  });
});

describe("checks on the whole artifact", () => {
  const en = deck("Zipformer + RNNT 動態熱詞：學術現況", [
    slide("Problem", "- Streaming ASR misses rare names", "Rare entity names are often wrong in streaming ASR."),
    slide("Methods", "```diagram\n{\"type\":\"pipeline\",\"stages\":[\"Audio\",\"編碼器\"]}\n```", "We compare contextual biasing approaches."),
    slide("Next steps", "- Evaluate on 〈中文熱詞資料集〉", "下週要做的事情。"),
  ]);

  it("language (en): cover title, diagram labels and speaker notes are all caught; author / 〈quoted titles〉 are not", () => {
    const v = languageViolations(en, "en");
    expect(v.map((x) => [x.page, x.part])).toEqual([[0, "front"], [2, "body"], [3, "notes"]]);
    const [r] = runChecks([{ id: "req_language", params: { language: "en" } }], "", { full: en });
    expect(r!.ok).toBe(false);
    expect(r!.detail).toContain("封面標題");
    expect(r!.detail).toContain("第 2 頁「Methods」內文");
    expect(r!.detail).toContain("第 3 頁「Next steps」講稿");
    const fixed = en.replace("Zipformer + RNNT 動態熱詞：學術現況", "Dynamic Hotwording for Zipformer + RNN-T").replace("編碼器", "Encoder").replace("下週要做的事情。", "Next week's plan.");
    expect(runChecks([{ id: "req_language", params: { language: "en" } }], fixed, null)[0]!.ok).toBe(true);
    expect(frontMatter(fixed)!.title).toBe("Dynamic Hotwording for Zipformer + RNN-T");
  });

  it("language (zh, lenient): only a unit written entirely in English fails", () => {
    const zh = deck("進度", [slide("方法", "- Zipformer 加上 contextual biasing", "說明方法。"), slide("Results", "- WER", "This whole speaker note is written in English and it keeps going for many many words so that it is clearly not Chinese at all, which the check should flag as a problem.")]);
    const v = languageViolations(zh, "zh");
    expect(v).toHaveLength(1);
    expect(v[0]!.page).toBe(2);
  });

  it("documents: sections are units, fixed headings may be allowed", () => {
    const doc = "# Hotwording survey\n\n## 問題定義\n\nContextual biasing helps rare words.\n\n## Methods\n\nTCPGen uses a 字首樹.\n";
    expect(languageViolations(doc, "en", [], true).map((v) => v.page)).toEqual([2, 3]);
    const r = runChecks([{ id: "req_language", params: { language: "en", allow: ["問題定義"], doc: true } }], doc, null)[0]!;
    expect(r.detail).not.toContain("問題定義」標題");
    expect(r.detail).toContain("第 3 段「Methods」內文");
  });

  it("LaTeX: comments are ignored, section text is checked; include_topics works on sections", () => {
    const tex = latexHeadings("\\section{Introduction}\n% 這段之後再改\nDynamic hotwording improves rare-word recall by 12\\%.\n\\section{相關研究}\nShallow fusion 是最簡單的做法。\n");
    const [crit] = requirementCriteria([{ id: "r1", type: "language", text: "英文", params: { language: "en" }, source: "request" }], "latex");
    const r = runChecks([crit!.check!], tex, null)[0]!;
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("「相關研究」標題");
    expect(r.detail).not.toContain("之後再改");
    const [inc] = requirementCriteria([{ id: "r2", type: "include_topics", text: "shallow fusion", params: { topics: [{ name: "shallow fusion" }] }, source: "request" }], "latex");
    expect(runChecks([inc!.check!], tex, null)[0]!.ok).toBe(true);
  });

  it("page count, include topics (aliases), exclude, per-item fields", () => {
    const body = [slide("Shallow fusion", "- **Architecture**: LM added at decoding\n- **Pros**: simple", "n"), slide("TCPGen", "- Architecture: tree-constrained pointer\n- Pros: strong\n- Cons: needs training", "n"), slide("卡住", "- x", "n")].join("\n\n");
    expect(runChecks([{ id: "req_pages", params: { exact: 3 } }], body, null)[0]!.ok).toBe(true);
    expect(runChecks([{ id: "req_pages", params: { min: 5 } }], body, null)[0]!.detail).toContain("實際 3 頁");
    expect(runChecks([{ id: "req_include", params: { topics: [{ name: "動態熱詞", aliases: ["shallow fusion"] }] } }], body, null)[0]!.ok).toBe(true);
    expect(runChecks([{ id: "req_include", params: { topics: [{ name: "WFST" }] } }], body, null)[0]!.detail).toContain("WFST");
    expect(runChecks([{ id: "req_exclude", params: { terms: [{ name: "卡住" }], scope: "page" } }], body, null)[0]!.detail).toContain("第 3 頁");
    const fields = runChecks([{ id: "req_fields", params: { items: ["Shallow fusion", "TCPGen", "CLAS"], fields: [{ name: "架構", aliases: ["Architecture"] }, { name: "Pros" }, { name: "Cons", aliases: ["缺點", "Limitations"] }] } }], body, null)[0]!;
    expect(fields.ok).toBe(false);
    expect(fields.detail).toContain("「Shallow fusion」（第 1 頁）缺少：Cons");
    expect(fields.detail).toContain("找不到「CLAS」");
    expect(fields.detail).not.toContain("「TCPGen」");
  });

  it("criteria: checks where deterministic, judged otherwise; replacing keeps other criteria", () => {
    const reqs: Requirement[] = [
      { id: "r1", type: "language", text: "英文", params: { language: "en" }, source: "request" },
      { id: "r2", type: "per_item_fields", text: "每個方法有 Pros/Cons", params: { item_kind: "方法", fields: [{ name: "Pros" }] }, source: "request" },
      { id: "r3", type: "audience", text: "給指導教授", source: "request" },
    ];
    const c = requirementCriteria(reqs, "deck");
    expect(c.map((x) => [x.id, x.kind, x.check?.id])).toEqual([["req_r1", "check", "req_language"], ["req_r2", "judge", undefined], ["req_r3", "judge", undefined]]);
    const merged = withRequirementCriteria([{ id: "pages", kind: "check" as const, text: "頁數" }, { id: "req_old", kind: "judge" as const, text: "old" }], reqs.slice(0, 1), "deck");
    expect(merged.map((x) => x.id)).toEqual(["pages", "req_r1"]);
  });

  it("regressions: a requirement that held before and fails after", () => {
    const criteria = requirementCriteria([{ id: "r1", type: "language", text: "英文", params: { language: "en" }, source: "request" }], "deck") as Criterion[];
    const before = slide("Results", "- WER 8.1", "WER improves.");
    expect(regressions(criteria, before, slide("Results", "- WER 8.1", "WER 下降了。"))).toHaveLength(1);
    expect(regressions(criteria, before, slide("Results", "- WER 8.1", "WER drops."))).toHaveLength(0);
  });

  it("generic repair reopens only the writers whose own output fails", () => {
    const failing = [{ ...(requirementCriteria([{ id: "r1", type: "language", text: "英文", params: { language: "en" }, source: "request" }], "doc")[0]!), status: "fail" as const, reason: "x" }];
    const step = (key: string, text: string) => ({ key, kind: "task", role: "writer", output: { summary: "", text } }) as unknown as StepRow;
    const out = requirementRepair(failing, [step("part_1", "## Intro\n\nAll English."), step("part_2", "## 方法\n\n中文內容")]);
    expect(out.map((o) => o.key)).toEqual(["part_2"]);
    expect(out[0]!.issues[0]).toContain("第 1 段「方法」");
  });
});

describe("prompts and labels", () => {
  const reqs: Requirement[] = [{ id: "r1", type: "language", text: "英文", params: { language: "en" }, source: "standing" }, { id: "r2", type: "page_count", text: "20 頁", params: { exact: 20 }, source: "request" }];

  it("every producer call gets the block and a language reminder; verifiers get the high-severity framing; extraction is exempt", () => {
    const req = withRequirements({ purpose: "speaker_notes", role: "writer", messages: [{ role: "system", content: "SYS" }, { role: "user", content: "寫講稿" }] }, reqs);
    expect(req.messages[0]!.content as string).toContain("Write every visible word of the output in English");
    expect(req.messages[0]!.content as string).toContain("頁數：正好 20 頁");
    expect(req.messages[1]!.content as string).toContain("Reminder: write the output in English only");
    const v = withRequirements({ purpose: "verify_final", role: "verifier", messages: [{ role: "system", content: "V" }, { role: "user", content: "x" }] }, reqs);
    expect(v.messages[0]!.content as string).toContain("high 問題");
    expect(v.messages[1]!.content).toBe("x");
    expect(withRequirements({ purpose: "requirements", role: "planner", messages: [{ role: "user", content: "x" }] }, reqs).messages).toHaveLength(1);
    expect(requirementsBlock([], "producer")).toBe("");
  });

  it("built-in labels follow the artifact's language", () => {
    expect(labelsFor("en").aiFilled).toBe("AI draft, please confirm");
    expect(labelsFor("en").skipped).not.toMatch(/[　-〿\p{Script=Han}]/u);
    expect(labelsFor(null).aiFilled).toBe("AI 代填，待你確認");
  });
});

describe("slides: edit kinds and page replacement", () => {
  it("translate = revise; deeper / per-item / many more pages = expand", () => {
    expect(editKindOf("我整個簡報要用英文", [], 12)).toBe("revise");
    expect(editKindOf("Translate the entire deck into English, keep the order", [], 12)).toBe("revise");
    expect(editKindOf("還不夠細，focus 在動態熱詞", [], 12)).toBe("expand");
    expect(editKindOf("精簡一下", [{ id: "r1", type: "page_count", text: "", params: { exact: 20 }, source: "request" }], 12)).toBe("expand");
    expect(editKindOf("改一下", [{ id: "r1", type: "per_item_fields", text: "", params: { fields: [{ name: "Pros" }] }, source: "request" }], 12)).toBe("expand");
  });

  it("replacePages swaps pages by position, also when the rewrite translated the titles", () => {
    const body = ["## 問題\n\nA", "## 方法\n\nB", "## 結果\n\nC"].join("\n\n");
    const out = replacePages(body, [2, 3], "## Method\n\nB2\n\n## Results\n\nC2")!;
    expect(out).toContain("## 問題");
    expect(out).toContain("## Method\n\nB2");
    expect(out).toContain("## Results\n\nC2");
    expect(replacePages(body, [2], "## A\n\nx\n\n## B\n\ny")).toBeNull();
  });
});
