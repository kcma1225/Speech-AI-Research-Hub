/**
 * The user's requirements on decks (requirements.ts → slides): the cover title in the target language, targeted
 * page rewrites for requirement failures, and the no-regression guard every step that rewrites existing pages
 * (speaker notes, visual fix, render fix) goes through.
 */
import { cleanBody } from "../../lib/slides/ai-context.js";
import { normalizeDiagrams } from "../../lib/slides/deck-visuals.js";
import { dataBlock } from "../llm.js";
import { checkedCriteria, labelsFor, languageViolations, regressions, requirementResults, runLabels, translateTitle } from "../requirements.js";
import { coverCitation, type VenueFacts } from "../venue.js";
import type { WorkflowEnv } from "../env.js";
import { namedSlides, parseSlides, slidePage, titleMatches } from "../checks.js";
import { closeOpenBlocks, VISUAL_RULES } from "./slides-visual.js";
import { systemFor } from "./common.js";

const yamlString = (s: string) => JSON.stringify(s);

/** The cover title in the target language (requirements.ts `translateTitle`; a generic title when nothing is left). */
export const frontTitle = (env: WorkflowEnv, base: string) => translateTitle(env, base, "Progress Report");

/** The deck's front matter as the requirement checks see it (title + subtitle; author / date are names). */
export function frontMatterText(title: string, subtitle?: string) {
  return `---\ntitle: ${yamlString(title)}\n${subtitle ? `subtitle: ${yamlString(subtitle)}\n` : ""}---\n\n`;
}

/**
 * The cover subtitle a generated deck gets: a paper report's citation in the Lab-Hub template's form (「Andrusenko et al.,
 * Interspeech 2024」, workflows/venue.ts — production 61666f10: the cover said only 「Paper report」 and the venue the user
 * asked for on the first page never got there), then what the user asked to have on the cover (`cover_extra`).
 */
export const deckSubtitle = (env: WorkflowEnv, paperReport: boolean, abstractOnly: boolean) => {
  const L = runLabels(env);
  const extra = env.state<CoverExtra>("cover_extra")?.lines ?? [];
  const cite = paperReport ? coverCitation(env.state<VenueFacts>("venue_facts") ?? null) : null;
  const head = paperReport ? (cite ? (abstractOnly ? `${cite}（${L.abstractOnly}）` : cite) : abstractOnly ? L.abstractOnly : L.paperReport) : null;
  const parts = [head, ...extra].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : undefined;
};

export type CoverExtra = { key: string; lines: string[]; missing?: string };

/**
 * What the user asked to have on the cover besides the venue (「封面要有指導教授的名字」): the cover is code's front matter,
 * so no page writer can put it there. One small call writes ≤ 2 short subtitle lines from the run's facts; cached by the
 * requirements' text. Venue requirements are the citation's (deckSubtitle).
 */
export async function coverExtras(env: WorkflowEnv): Promise<string[]> {
  const reqs = env.requirements().filter((r) => r.params?.page === 1 && !r.params.venue);
  if (!reqs.length) {
    if (env.state<CoverExtra>("cover_extra")?.lines.length) await env.setState({ cover_extra: null });
    return [];
  }
  const key = reqs.map((r) => r.text).join("\n");
  const cached = env.state<CoverExtra>("cover_extra");
  if (cached?.key === key) return cached.lines;
  const facts = env.state<VenueFacts>("venue_facts");
  const lang = runLabels(env) === labelsFor("en") ? "English" : "繁體中文（專有名詞保留英文）";
  const res = await env.callJson<{ lines?: unknown; missing?: unknown }>({
    purpose: "cover_extra",
    role: "writer",
    messages: [
      { role: "system", content: `你替投影片封面寫副標題的補充文字。只輸出 JSON：{"lines":["…"],"missing":"做不到的原因（選填）"}。lines 最多 2 行、每行 ≤ 60 字，用${lang}；只能用下面給的資料，資料裡沒有的（例如沒給的人名、單位）不要編，放進 missing。不要重複封面已經有的標題、作者、日期與論文出處。` },
      { role: "user", content: [
        `使用者對封面（第 1 頁）的要求：\n${reqs.map((r) => `- ${r.text}${r.quote ? `（原話：「${r.quote}」）` : ""}`).join("\n")}`,
        dataBlock("facts", [`報告者：${env.user.name}`, env.state<string>("front_title") ? `封面標題：${env.state<string>("front_title")}` : "", facts?.label ? `論文出處：${coverCitation(facts)}` : ""].filter(Boolean).join("\n")),
      ].join("\n\n") },
    ],
    maxTokens: 400,
  }, (v): v is { lines?: unknown; missing?: unknown } => !!v && typeof v === "object");
  const lines = (Array.isArray(res.value?.lines) ? res.value!.lines : []).filter((x): x is string => typeof x === "string").map((x) => x.replace(/[\r\n]+/g, " ").trim().slice(0, 80)).filter(Boolean).slice(0, 2);
  const missing = typeof res.value?.missing === "string" ? res.value.missing.slice(0, 200) : undefined;
  await env.setState({ cover_extra: { key, lines, ...(missing ? { missing } : {}) } satisfies CoverExtra });
  if (missing) await env.note(`封面的要求有一部分沒有資料可以填：${missing}`, "warn");
  return lines;
}

/** `## ` chunks of a body (with whatever precedes the first slide). */
export function splitChunks(body: string): { pre: string; chunks: string[] } {
  const parts = body.replace(/\r\n/g, "\n").split(/^(?=## )/m);
  const pre = parts[0]?.startsWith("## ") ? "" : (parts.shift() ?? "");
  return { pre, chunks: parts };
}

const NOTES_BLOCK_RE = /^:::+\s*\{?\.?notes\}?\s*\n[\s\S]*?^:::+\s*$/gm;

/**
 * A notes-only edit: every original page with the speaker notes of its rewritten counterpart (same title, else the
 * same position); a page without new notes keeps its own. The result has exactly the original pages, bodies byte for
 * byte, whatever the writers changed, added or dropped.
 */
export function keepSlideBodies(body: string, originals: string[]): string {
  const fresh = parseSlides(body);
  const used = new Set<number>();
  const pages = originals.map((raw, i) => {
    const title = parseSlides(raw)[0]?.title ?? "";
    let j = fresh.findIndex((f, k) => !used.has(k) && !!title && f.title === title);
    if (j < 0) j = fresh.findIndex((f, k) => !used.has(k) && !!title && titleMatches(title, f.title));
    if (j < 0 && fresh[i] && !used.has(i)) j = i;
    if (j >= 0) used.add(j);
    const notes = j >= 0 ? fresh[j]!.notes.trim() : "";
    if (!notes) return raw.trim();
    return `${raw.replace(NOTES_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim()}\n\n::: {.notes}\n${notes}\n:::`;
  });
  return `${pages.join("\n\n")}\n`;
}

/** Replaces the given pages (1-based) by position; null when the counts do not line up. */
export function replacePages(body: string, pages: number[], rewritten: string): string | null {
  const { pre, chunks } = splitChunks(body);
  const fresh = splitChunks(closeOpenBlocks(rewritten)).chunks.filter((c) => c.startsWith("## "));
  if (fresh.length !== pages.length) return null;
  pages.forEach((p, i) => {
    if (p >= 1 && p <= chunks.length) chunks[p - 1] = `${fresh[i]!.trim()}\n\n`;
  });
  return `${pre}${chunks.join("")}`.replace(/\n{3,}/g, "\n\n");
}

/**
 * Rewrites only the given pages so they satisfy the requirements (`purpose requirement_fix`): same order and count,
 * layout, visuals, figures, formulas, numbers and sources kept. Null when the reply cannot be placed.
 */
export async function fixPages(env: WorkflowEnv, body: string, pages: number[], issues: string[], stepId?: string): Promise<string | null> {
  const { chunks } = splitChunks(body);
  const targets = pages.filter((p) => p >= 1 && p <= chunks.length);
  if (!targets.length) return null;
  const user = [
    VISUAL_RULES,
    `下面這 ${targets.length} 頁投影片沒有符合使用者的要求。逐頁重寫成符合要求的版本：頁數與順序不變，每頁以「## 標題」開頭（標題逐字不變，只有語言要求要換語言時才翻譯標題）並保留 ::: {.notes} 講稿；保留原本的版型、圖（\`\`\`diagram / \`\`\`chart 規格只改文字標籤）、論文圖（paper-fig 語法不要動）、公式、表格、數字與出處。只輸出這 ${targets.length} 頁，不要其他文字。`,
    `要修正的問題：\n${issues.map((i) => `- ${i}`).join("\n")}`,
    ...targets.map((p) => dataBlock(`page_${p}`, chunks[p - 1]!.trim())),
  ].join("\n\n");
  const res = await env.call({ purpose: "requirement_fix", role: "writer", aiRole: "slides", messages: [{ role: "system", content: systemFor("writer", "你寫 Quarto revealjs 投影片的 Markdown 本體。") }, { role: "user", content: user }], maxTokens: 12_000 }, stepId);
  const fixed = cleanBody(res.text);
  if (!fixed) return null;
  const out = replacePages(body, targets, normalizeDiagrams(fixed));
  return out ? keepTitles(body, out, targets, env) : null;
}

/**
 * The rewritten pages keep their titles unless the title itself breaks a language requirement (production-style eval
 * 79ab0678: a per-item-field fix retitled three method pages 「Shallow Fusion Cuts B-WER from 30.6…」 and the deck lost its
 * outline pages one-to-one).
 */
function keepTitles(before: string, after: string, pages: number[], env: WorkflowEnv): string {
  const a = splitChunks(before).chunks;
  const { pre, chunks } = splitChunks(after);
  const langs = checkedCriteria(env.run.criteria).filter((c) => c.check?.id === "req_language");
  for (const p of pages) {
    const old = /^## (.+)$/m.exec(a[p - 1] ?? "")?.[1]?.trim();
    const cur = /^## (.+)$/m.exec(chunks[p - 1] ?? "")?.[1]?.trim();
    if (!old || !cur || old === cur) continue;
    const oldBreaks = langs.some((c) => languageViolations(`## ${old}\n`, c.check!.params?.language === "zh" ? "zh" : "en", [], false, (c.check!.params?.part as "slides" | "notes" | undefined)).some((v) => v.part === "title"));
    if (!oldBreaks) chunks[p - 1] = chunks[p - 1]!.replace(/^## .+$/m, `## ${old}`);
  }
  return `${pre}${chunks.join("")}`;
}

/** Pages whose requirement checks fail, with the problems per check (language: the exact spots; per-item fields: the item's pages). */
/**
 * `hard`: failures a judge cannot overrule (language, page count, removals…). Topic / per-item-field checks have a judged
 * fallback (`judge_fallback`): a literal miss may be met in other words, so the final judge decides — they never fail the
 * constraints step on their own (production: 「where each injects the bias」 was demanded verbatim).
 */
export function failingPages(env: WorkflowEnv, body: string, front: string): { pages: number[]; issues: string[]; hard: string[]; cover: boolean } {
  const res = requirementResults(env.run.criteria, body, `${front}${body}`).filter((r) => !r.ok);
  const pages = new Set<number>();
  let cover = false;
  for (const r of res) {
    if (r.check.id === "req_language") {
      const lang = r.check.params?.language === "zh" ? "zh" : "en";
      const part = r.check.params?.part === "notes" || r.check.params?.part === "slides" ? (r.check.params.part as "notes" | "slides") : undefined;
      for (const v of languageViolations(`${front}${body}`, lang, (r.check.params?.allow as string[] | undefined) ?? [], false, part)) v.page === 0 ? (cover = true) : pages.add(v.page);
    } else if (r.check.id === "req_venue" && r.check.params?.page === 1) cover = true;
    // Details name the player's pages (the cover is page 1): back to `## ` slide indexes.
    else for (const n of namedSlides(r.detail)) pages.add(n);
  }
  return { pages: [...pages].sort((a, b) => a - b), issues: res.map((r) => r.detail), hard: res.filter((r) => !r.check.params?.judge_fallback).map((r) => r.detail), cover };
}

/**
 * No-regression guard: a step that rewrote existing pages (`label`) must not break a requirement that held before.
 * Regressed pages get one targeted rewrite; still failing → those pages are rolled back to `before`.
 */
export async function guardRequirements(env: WorkflowEnv, before: string, after: string, label: string, front: string, stepId?: string): Promise<string> {
  if (before === after || !checkedCriteria(env.run.criteria).length) return after;
  const reg = regressions(env.run.criteria, `${front}${before}`, `${front}${after}`);
  if (!reg.length) return after;
  const a = splitChunks(before).chunks;
  const b = splitChunks(after).chunks;
  const now = failingPages(env, after, front).pages;
  const was = new Set(failingPages(env, before, front).pages);
  // Pages that fail now and did not before (same deck length: compare by position; else every failing page).
  const pages = now.filter((p) => !was.has(p) || a.length !== b.length);
  await env.note(`「${label}」讓已經符合的要求退步（${reg.map((r) => r.detail.slice(0, 80)).join("；")}），針對${pages.length ? pages.map((p) => `第 ${slidePage(p)} 頁`).join("、") : "改過的頁面"}修正。`, "warn");
  if (pages.length) {
    const fixed = await fixPages(env, after, pages, reg.map((r) => r.detail), stepId).catch(() => null);
    if (fixed && !regressions(env.run.criteria, `${front}${before}`, `${front}${fixed}`).length) return fixed;
  }
  // Roll back the regressed pages (or the whole change when pages cannot be matched).
  if (a.length === b.length && pages.length) {
    const { pre, chunks } = splitChunks(after);
    for (const p of pages) chunks[p - 1] = a[p - 1]!;
    const rolled = `${pre}${chunks.join("")}`;
    if (!regressions(env.run.criteria, `${front}${before}`, `${front}${rolled}`).length) {
      await env.note(`已把${pages.map((p) => `第 ${slidePage(p)} 頁`).join("、")}還原成「${label}」之前的版本，保住你的要求。`, "warn");
      return rolled;
    }
  }
  await env.note(`「${label}」的修改違反你的要求，已整份還原。`, "warn");
  return before;
}
