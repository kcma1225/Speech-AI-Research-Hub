/**
 * Production 61666f10 (synthetic shapes): 「簡報低一頁要有這是哪個會議哪一年的」 lost its page, the library only knew
 * 「arXiv」, the venue ended up in page 2's notes, the AI's cover edit added a second `subtitle:` and broke the build,
 * three stacked charts ran off a slide, and page numbers differed between the steps, the checks and the assistant.
 */
import { describe, expect, it } from "vitest";
import { anchorPlacement, detectPlacements, detectRequirements, fixPageTypos, requirementCriteria, requirementsBlock } from "../src/workflows/requirements.js";
import { namedSlides, numberedDeck, runChecks, slidePage } from "../src/workflows/checks.js";
import { coverCitation, coverVenue, venueTerms, withVenueTerms, type VenueFacts } from "../src/workflows/venue.js";
import { newSourceProblems, sourceProblems } from "../src/lib/slides/source-lint.js";
import { latexProblems, newLatexProblems } from "../src/lib/latex-projects/source-lint.js";
import { addedText, pageAt, pagesTouched, snippetSimilarity } from "../src/lib/slides/agent-tools.js";
import { applyHunks } from "../src/lib/suggestions/diff.js";
import { arrangeVisuals } from "../src/lib/slides/deck-layout.js";
import { plainLog } from "../src/lib/slides/render-followup.js";
import { preprintOnly, venueLabel } from "../src/lib/library/published.js";
import { createLibraryService, isPublishedRecord } from "../src/lib/library/service.js";
import { mergeRecords } from "../src/lib/library/dedupe.js";
import { checkConversation, checkRun, placementsOf, type ConversationBundle, type RunBundle } from "../src/workflows/invariants.js";
import type { Requirement } from "../src/workflows/types.js";
import type { PaperRecord } from "../src/lib/library/types.js";

const ASK = "#簡報 這週 meeting 要報告這篇，幫我做簡報，簡報低一頁要有這是哪個會議哪一年的";
const DECK = `---\ntitle: "Fast Context-Biasing"\nsubtitle: "Andrusenko et al., Interspeech 2024"\nauthor: "A"\n---\n\n## One-sentence claim\n\nCTC-WS\n\n::: {.notes}\n這篇發表於 Interspeech 2024。\n:::\n\n## Main results\n\nx\n`;

describe("page positions and the venue in the user's words", () => {
  it("fixes the 第 typo, not 降低 / 最低", () => {
    expect(fixPageTypos("簡報低一頁要有會議")).toBe("簡報第一頁要有會議");
    expect(fixPageTypos("弟3頁放圖")).toBe("第3頁放圖");
    expect(fixPageTypos("頁數降低一頁")).toBe("頁數降低一頁");
    expect(fixPageTypos("最低一頁")).toBe("最低一頁");
  });
  it("「低一頁要有…哪個會議哪一年」 → a venue requirement on page 1 (the cover)", () => {
    const reqs = detectRequirements(ASK, { kind: "deck" });
    const venue = reqs.find((r) => r.params?.venue);
    expect(venue).toMatchObject({ type: "other", params: { venue: true, page: 1, part: "slides" } });
    expect(venue!.text).toContain("第 1 頁（封面）");
    expect(venue!.text).not.toContain("至少");
  });
  it("other positions and what is not one", () => {
    expect(detectPlacements("封面要有指導教授的名字")[0]).toMatchObject({ page: 1, venue: false });
    expect(detectPlacements("第三頁加上實驗設定的表")[0]).toMatchObject({ page: 3 });
    expect(detectPlacements("最後一頁放參考文獻")[0]).toMatchObject({ page: -1 });
    expect(detectPlacements("我是要第一頁加，不是第二頁")[0]).toMatchObject({ page: 1 });
    expect(detectPlacements("刪掉第三頁")).toEqual([]);
    expect(detectPlacements("第三頁的講稿加上出處")).toEqual([]);
    // Not a position: a page count, a per-item field.
    expect(detectPlacements("做 10 頁的簡報")).toEqual([]);
    expect(detectPlacements("每個方法都要有架構圖、會議或是期刊")).toEqual([]);
    // A venue without a page: anywhere on the slides (not the notes).
    const v = detectRequirements("要寫出這篇是哪個會議發表的", { kind: "deck" }).find((r) => r.params?.venue)!;
    expect(v.params).toMatchObject({ venue: true });
    expect(v.params?.page).toBeUndefined();
    expect(v.text).toContain("講稿不算");
  });
  it("a requirement whose text lost the page gets it back from its quote", () => {
    const lost: Omit<Requirement, "id"> = { type: "other", text: "簡報至少要有一頁說明這篇論文是哪個會議、哪一年。", quote: "簡報低一頁要有這是哪個會議哪一年的", source: "request" };
    const r = anchorPlacement(lost, "deck");
    expect(r.params).toMatchObject({ page: 1, venue: true, part: "slides" });
    expect(r.text.startsWith("第 1 頁（封面）")).toBe(true);
    expect(anchorPlacement({ ...lost, quote: "整份用英文" }, "deck")).toEqual({ ...lost, quote: "整份用英文" });
  });
});

describe("venue facts → checked words, the cover citation", () => {
  const facts: VenueFacts = { paper_id: "p", label: "Interspeech 2024", venue: "Interspeech", year: 2024, doi: "10.21437/Interspeech.2024-1002", preprint: false, first_author: "Andrusenko", more_authors: true, lookup: "updated" };
  it("the Lab-Hub cover form; a preprint says so", () => {
    expect(coverCitation(facts)).toBe("Andrusenko et al., Interspeech 2024");
    expect(coverVenue({ ...facts, venue: "arXiv", label: "arXiv 2024", preprint: true })).toBe("arXiv preprint 2024");
    expect(coverCitation(null)).toBeNull();
    expect(venueTerms(facts).map((t) => t.name)).toEqual(["Interspeech", "2024"]);
  });
  it("a venue requirement becomes a check on the page the user named — the cover, never the notes", () => {
    const [r] = withVenueTerms([{ id: "r1", type: "other", text: "第 1 頁（封面）的畫面上標示這篇論文發表的會議／期刊與年份（以查證過的正式出處為準）", params: { venue: true, page: 1, part: "slides" }, source: "request" }], facts);
    expect(r!.text).toContain("Interspeech 2024（查證過的正式出處）");
    const [c] = requirementCriteria([r!], "deck");
    expect(c).toMatchObject({ kind: "check", check: { id: "req_venue", params: { page: 1 } } });
    expect(runChecks([c!.check!], "", { full: DECK })[0]).toMatchObject({ ok: true });
    // Only in the notes of page 2 (the production deck): fails, and says the notes do not count.
    const notesOnly = DECK.replace('subtitle: "Andrusenko et al., Interspeech 2024"', 'subtitle: "Paper report"');
    const res = runChecks([c!.check!], "", { full: notesOnly })[0]!;
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("第 1 頁（封面）");
    expect(res.detail).toContain("講稿");
    // Page 2 = the first `## ` slide (player numbering); its notes never count.
    const p2 = runChecks([{ id: "req_venue", params: { page: 2, terms: venueTerms(facts) } }], "", { full: notesOnly })[0]!;
    expect(p2.ok).toBe(false);
    expect(p2.detail).toContain("第 2 頁「One-sentence claim」");
    const onSlide = notesOnly.replace("CTC-WS\n", "CTC-WS（Interspeech 2024）\n");
    expect(runChecks([{ id: "req_venue", params: { page: 2, terms: venueTerms(facts) } }], "", { full: onSlide })[0]!.ok).toBe(true);
  });
  it("a position without words is judged on that page only; the writers are told the numbering", () => {
    const req: Requirement = { id: "r1", type: "other", text: "第 3 頁的畫面上要有：實驗設定的表（講稿不算）", params: { page: 3, part: "slides" }, source: "request" };
    expect(requirementCriteria([req], "deck")[0]).toMatchObject({ kind: "judge" });
    expect(requirementCriteria([req], "deck")[0]!.text).toContain("講稿裡都不算");
    expect(requirementsBlock([req], "producer")).toContain("封面是第 1 頁，第一個「## 」投影片是第 2 頁");
  });
});

describe("one page numbering (the player's: the cover is page 1)", () => {
  it("slide n is page n + 1; verdict pages map back", () => {
    expect(slidePage(10)).toBe(11);
    expect(namedSlides("第 11 頁「Main results」超出；第 1 頁（封面）")).toEqual([10]);
  });
  it("the verifier reads every page labeled", () => {
    const out = numberedDeck(DECK);
    expect(out).toMatch(/^<!-- 第 1 頁（封面） -->\nFast Context-Biasing\nAndrusenko et al., Interspeech 2024/);
    expect(out).toContain("<!-- 第 2 頁「One-sentence claim」 -->\nOne-sentence claim\nCTC-WS\n[講稿（不顯示在投影片上）]\n這篇發表於 Interspeech 2024。");
    expect(out).toContain("<!-- 第 3 頁「Main results」 -->");
    expect(numberedDeck("## A\n\nx\n")).toContain("<!-- 第 1 頁「A」 -->");
  });
});

describe("an edit must still compile (suggest_deck_edit / latex_suggest_edit)", () => {
  it("a second subtitle, an unquoted colon, an unclosed div; problems the file already had do not count", () => {
    const twice = DECK.replace('title: "Fast Context-Biasing"', 'title: "Fast Context-Biasing"\nsubtitle: "Interspeech 2024 · DOI: 10.21437/x"');
    expect(newSourceProblems("index.qmd", DECK, twice)[0]).toMatch(/第 4 行.*subtitle 寫了兩次/);
    expect(newSourceProblems("index.qmd", DECK, DECK.replace('subtitle: "Andrusenko et al., Interspeech 2024"', "subtitle: Interspeech 2024 · DOI: 10.1"))[0]).toContain("沒有加引號");
    expect(newSourceProblems("index.qmd", DECK, DECK.replace("CTC-WS\n", "::: {.takeaway}\nCTC-WS\n"))).toEqual(["::: 區塊沒有關閉"]);
    expect(sourceProblems("index.qmd", DECK)).toEqual([]);
    expect(newSourceProblems("index.qmd", twice, `${twice}\n## New\n`)).toEqual([]);
    expect(sourceProblems("index.qmd", "---\ntitle: x\n")).toEqual(["front matter（開頭的 ---）沒有結束的 ---"]);
    expect(sourceProblems("_quarto.yml", "a: 1\na: 2\n")[0]).toContain("a 寫了兩次");
    expect(sourceProblems("hub-deck.css", "a{")).toEqual([]);
  });
  it("LaTeX: braces and environments", () => {
    const ok = "\\section{A}\n\\begin{table}\\centering x\\end{table}\n% {unbalanced in a comment\n\\{literal\\}";
    expect(latexProblems("a.tex", ok)).toEqual([]);
    expect(newLatexProblems("a.tex", ok, ok.replace("\\end{table}", ""))).toContain("\\begin{table} 沒有 \\end{table}");
    expect(newLatexProblems("a.tex", ok, `${ok}\n\\textbf{x`)[0]).toMatch(/沒有關閉/);
    expect(newLatexProblems("a.tex", `${ok}\n\\textbf{x`, `${ok}\n\\textbf{x\nmore`)).toEqual([]);
  });
  it("where an edit's text lands, what it adds, how alike two snippets are", () => {
    const hunks = [{ from: DECK.indexOf("CTC-WS"), to: DECK.indexOf("CTC-WS") + 6, after: "CTC-WS\n\n**發表會議：Interspeech 2024**" }];
    const after = applyHunks(DECK, hunks);
    expect(pagesTouched(after, ["**發表會議：Interspeech 2024**"])).toEqual([2]);
    expect(pageAt(DECK, 5)).toBe(1);
    expect(pageAt(DECK, DECK.indexOf("x\n", DECK.indexOf("## Main")))).toBe(3);
    expect(addedText('subtitle: "Paper report"', 'subtitle: "Interspeech 2024"')).toBe("Interspeech 2024");
    expect(snippetSimilarity("**發表會議：Interspeech 2024**  DOI: `10.21437/Interspeech.2024-1002`", "Interspeech 2024 · DOI: 10.21437/Interspeech.2024-1002")).toBeGreaterThanOrEqual(0.5);
    expect(snippetSimilarity("Interspeech 2024", "WER 9.90%")).toBeLessThan(0.2);
  });
  it("Quarto logs lose their colours", () => {
    expect(plainLog("\u001b[91mERROR: YAMLException\u001b[39m")).toBe("ERROR: YAMLException");
  });
});

describe("stacked visuals go side by side", () => {
  const chart = (n: number) => `![](charts/c${n}.svg){.hub-chart}`;
  it("three charts one under another → three columns; text between visuals and existing columns are left alone", () => {
    const body = `## Main results {.fit-90}\n\n${chart(1)}\n\n${chart(2)}\n\n${chart(3)}\n\n::: {.takeaway}\nbest\n:::\n\n::: {.notes}\nn\n:::\n`;
    const r = arrangeVisuals(body);
    expect(r.arranged).toEqual(["Main results"]);
    expect(r.body).toContain(':::: {.columns}\n::: {.column width="33%"}\n![](charts/c1.svg){.hub-chart}\n:::');
    expect(r.body.indexOf(":::: {.columns}")).toBeLessThan(r.body.indexOf("::: {.takeaway}"));
    expect((r.body.match(/\{\.column /g) ?? []).length).toBe(3);
    const fence = "```chart\n{\"type\":\"bar\"}\n```";
    expect(arrangeVisuals(`## A\n\n${fence}\n\n${fence}\n`).body).toContain('::: {.column width="50%"}\n```chart');
    expect(arrangeVisuals(`## A\n\n${chart(1)}\n\nSome text.\n\n${chart(2)}\n`).arranged).toEqual([]);
    expect(arrangeVisuals(`## A\n\n:::: {.columns}\n::: {.column}\n${chart(1)}\n\n${chart(2)}\n:::\n::::\n`).arranged).toEqual([]);
    const four = arrangeVisuals(`## A\n\n${[1, 2, 3, 4].map(chart).join("\n\n")}\n`).body;
    expect((four.match(/\{\.column /g) ?? []).length).toBe(2);
  });
});

describe("the library knows where a paper was published", () => {
  const arxiv: PaperRecord = { type: "article", title: "Fast Context-Biasing for CTC and Transducer ASR models with CTC-based Word Spotter", authors: [{ family: "Andrusenko", given: "Andrei" }], year: 2024, arxivId: "2406.07096", venue: "arXiv" };
  const pub: PaperRecord = { type: "paper-conference", title: arxiv.title, authors: arxiv.authors, year: 2024, doi: "10.21437/interspeech.2024-1002", containerTitle: "Interspeech 2024", venue: "Interspeech", pages: "757-761" };
  it("preprint-only vs published", () => {
    expect(preprintOnly({ venue: "arXiv", doi: null, arxiv_id: "2406.07096" })).toBe(true);
    expect(preprintOnly({ venue: null, doi: "10.48550/arXiv.2406.07096", arxiv_id: null })).toBe(true);
    expect(preprintOnly({ venue: "Interspeech", doi: "10.21437/interspeech.2024-1002", arxiv_id: "2406.07096" })).toBe(false);
    expect(preprintOnly({ venue: null, doi: null, arxiv_id: null })).toBe(false);
    expect(isPublishedRecord(pub)).toBe(true);
    expect(isPublishedRecord(arxiv)).toBe(false);
    expect(venueLabel({ venue: "Interspeech", year: 2024 })).toBe("Interspeech 2024");
  });
  it("the published version wins venue / container / year / pages over the preprint", () => {
    const m = mergeRecords(arxiv, { ...pub, year: 2025 });
    expect(m).toMatchObject({ type: "paper-conference", venue: "Interspeech", containerTitle: "Interspeech 2024", year: 2025, doi: "10.21437/interspeech.2024-1002", arxivId: "2406.07096", pages: "757-761" });
  });
  it("findPublishedVersion: Semantic Scholar's DOI → Crossref; a title match must be the same work; only the record's ids / title leave", async () => {
    const svc = createLibraryService();
    const asked: string[] = [];
    svc.clients.s2.getForRecord = (async (r: PaperRecord) => (asked.push(`s2:${r.arxivId}`), { record: { ...arxiv, doi: "10.21437/interspeech.2024-1002" }, paper: {} })) as never;
    svc.clients.crossref.getByDoi = (async (d: string) => (asked.push(`cr:${d}`), pub)) as never;
    svc.clients.crossref.matchBibliographic = (async () => { throw new Error("not reached"); }) as never;
    expect(await svc.findPublishedVersion(arxiv)).toMatchObject({ source: "crossref", record: { venue: "Interspeech", arxivId: "2406.07096" } });
    expect(asked).toEqual(["s2:2406.07096", "cr:10.21437/interspeech.2024-1002"]);
    expect(await svc.findPublishedVersion(pub)).toBeNull();
    // No DOI from S2: a Crossref title match, rejected when it is a different work or a posted preprint.
    svc.clients.s2.getForRecord = (async () => null) as never;
    svc.clients.crossref.matchBibliographic = (async () => ({ record: pub, score: 0.99 })) as never;
    expect((await svc.findPublishedVersion(arxiv))?.record.venue).toBe("Interspeech");
    svc.clients.crossref.matchBibliographic = (async () => ({ record: { ...pub, title: "Something else entirely", authors: [{ family: "Other" }] }, score: 0.99 })) as never;
    expect(await svc.findPublishedVersion(arxiv)).toBeNull();
    svc.clients.crossref.matchBibliographic = (async () => ({ record: { ...pub, type: "article", doi: "10.1101/x", containerTitle: undefined, venue: undefined }, score: 0.99 })) as never;
    expect(await svc.findPublishedVersion(arxiv)).toBeNull();
  });
});

describe("invariants (production 61666f10 shapes, synthetic)", () => {
  const run = (patch: Partial<RunBundle["run"]>): RunBundle => ({ run: { id: "r", status: "partial", playbook: "slides", brief: { user_words: [ASK] }, ...patch } });
  it("req.placement_kept: the page the user named is in the requirements", () => {
    const lost = run({ state: { requirements: [{ id: "r2", type: "other", text: "簡報至少要有一頁說明這篇論文是哪個會議、哪一年。" }] } });
    expect(checkRun(lost, ["req.placement_kept"])).toHaveLength(1);
    const kept = run({ state: { requirements: [{ id: "r2", type: "other", text: "第 1 頁（封面）的畫面上標示…", params: { page: 1 } }] } });
    expect(checkRun(kept, ["req.placement_kept"])).toEqual([]);
    expect(placementsOf("頁數降低一頁")).toEqual([]);
  });
  it("deck.cover_citation: a paper report's cover names the venue", () => {
    const st = (subtitle: string) => ({ mode: "paper_report", venue_facts: { label: "Interspeech 2024", venue: "Interspeech", year: 2024 }, deck: { last_written: `---\ntitle: "T"\nsubtitle: "${subtitle}"\n---\n\n## A\n` } });
    expect(checkRun(run({ state: st("Paper report") }), ["deck.cover_citation"])).toHaveLength(1);
    expect(checkRun(run({ state: st("Andrusenko et al., Interspeech 2024") }), ["deck.cover_citation"])).toEqual([]);
  });
  const conv = (messages: ConversationBundle["messages"], deck?: ConversationBundle["deck"]): ConversationBundle => ({ conversation: { id: "c" }, messages, ...(deck ? { deck } : {}) });
  const toolMsg = (seq: number, data: string) => ({ seq, role: "tool", content: [{ type: "tool_result", tool_use_id: "x", content: `<tool_result tool="suggest_deck_edit" trust="user">\n${data}\n</tool_result>` }] });
  it("deck.placement_followed: the suggestion lands on the page the user named", () => {
    const wrong = conv([{ seq: 1, role: "user", text: "我是要第一頁加，不是第二頁" }, toolMsg(2, '{"suggestion_id":"s","pages":[2]}')]);
    expect(checkConversation(wrong, ["deck.placement_followed"])).toHaveLength(1);
    expect(checkConversation(conv([{ seq: 1, role: "user", text: "我是要第一頁加" }, toolMsg(2, '{"suggestion_id":"s","pages":[1]}')]), ["deck.placement_followed"])).toEqual([]);
  });
  it("assistant.preprint_not_conference", () => {
    const said = conv([{ seq: 1, role: "assistant", text: "這篇論文發表於 arXiv，2024 年，並不是會議論文。" }]);
    expect(checkConversation(said, ["assistant.preprint_not_conference"])).toHaveLength(1);
    expect(checkConversation(conv([{ seq: 1, role: "assistant", text: "正式發表於 Interspeech 2024。" }]), ["assistant.preprint_not_conference"])).toEqual([]);
  });
  const deckActivity = (status: string, previews: { status: string; at: string }[], files = [{ id: "f", content: DECK }]) => ({
    suggestions: [
      { id: "s1", deck_id: "d", file_id: "f", title: "第 2 頁加出處", source: "ai", status: "applied", created_at: "2026-11-02T06:07:18Z", decided_at: "2026-11-02T06:07:48Z", added: ["這篇發表於 Interspeech 2024。"] },
      { id: "s2", deck_id: "d", file_id: "f", title: "封面加出處", source: "ai", status, created_at: "2026-11-02T06:10:47Z", decided_at: "2026-11-02T06:12:02Z", added: ["Andrusenko et al., Interspeech 2024"] },
    ],
    previews: previews.map((p) => ({ deck_id: "d", status: p.status, created_at: p.at })),
    files,
  });
  it("deck.render_failure_followed_up: a failure after an accepted AI edit is posted back", () => {
    // As in production: page 2's edit compiled (06:07:49), the cover edit did not (06:12:03).
    const failed = deckActivity("applied", [{ status: "ready", at: "2026-11-02T06:07:49Z" }, { status: "failed", at: "2026-11-02T06:12:03Z" }]);
    expect(checkConversation(conv([], failed), ["deck.render_failure_followed_up"])).toHaveLength(1);
    const told = conv([{ seq: 9, role: "notice", text: "…", created_at: "2026-11-02T06:12:05Z", content: [{ type: "notice", kind: "deck_render_failed", deckId: "d" }] }], failed);
    expect(checkConversation(told, ["deck.render_failure_followed_up"])).toEqual([]);
    expect(checkConversation(conv([], deckActivity("applied", [{ status: "ready", at: "2026-11-02T06:12:03Z" }])), ["deck.render_failure_followed_up"])).toEqual([]);
  });
  it("deck.moved_content_left_behind: the same text on two pages after a move", () => {
    // The production pair: the venue line on page 2, then the same venue + DOI on the cover.
    const both = deckActivity("applied", []);
    both.suggestions[0]!.added = ["**發表會議：Interspeech 2024**  DOI: 10.21437/Interspeech.2024-1002"];
    both.suggestions[1]!.added = ["Interspeech 2024 · DOI: 10.21437/Interspeech.2024-1002"];
    both.files[0]!.content = DECK.replace('subtitle: "Andrusenko et al., Interspeech 2024"', 'subtitle: "Interspeech 2024 · DOI: 10.21437/Interspeech.2024-1002"').replace("CTC-WS\n", "CTC-WS\n\n**發表會議：Interspeech 2024**  DOI: 10.21437/Interspeech.2024-1002\n");
    expect(checkConversation(conv([], both), ["deck.moved_content_left_behind"])[0]?.message).toMatch(/第 1 頁.*第 2 頁/);
    both.files[0]!.content = both.files[0]!.content!.replace("**發表會議：Interspeech 2024**  DOI: 10.21437/Interspeech.2024-1002\n", "");
    expect(checkConversation(conv([], both), ["deck.moved_content_left_behind"])).toEqual([]);
  });
});
