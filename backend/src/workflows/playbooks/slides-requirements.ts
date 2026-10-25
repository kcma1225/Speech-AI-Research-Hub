/**
 * The user's requirements on decks (requirements.ts → slides): the cover title in the target language, targeted
 * page rewrites for requirement failures, and the no-regression guard every step that rewrites existing pages
 * (speaker notes, visual fix, render fix) goes through.
 */
import { cleanBody } from "../../lib/slides/ai-context.js";
import { normalizeDiagrams } from "../../lib/slides/deck-visuals.js";
import { dataBlock } from "../llm.js";
import { checkedCriteria, languageViolations, regressions, requirementResults, runLabels, translateTitle } from "../requirements.js";
import type { WorkflowEnv } from "../env.js";
import { closeOpenBlocks, VISUAL_RULES } from "./slides-visual.js";
import { systemFor } from "./common.js";

const yamlString = (s: string) => JSON.stringify(s);

/** The cover title in the target language (requirements.ts `translateTitle`; a generic title when nothing is left). */
export const frontTitle = (env: WorkflowEnv, base: string) => translateTitle(env, base, "Progress Report");

/** The deck's front matter as the requirement checks see it (title + subtitle; author / date are names). */
export function frontMatterText(title: string, subtitle?: string) {
  return `---\ntitle: ${yamlString(title)}\n${subtitle ? `subtitle: ${yamlString(subtitle)}\n` : ""}---\n\n`;
}

/** The subtitle a generated paper-report deck gets, in the artifact's language. */
export const deckSubtitle = (env: WorkflowEnv, paperReport: boolean, abstractOnly: boolean) => {
  if (!paperReport) return undefined;
  const L = runLabels(env);
  return abstractOnly ? L.abstractOnly : L.paperReport;
};

/** `## ` chunks of a body (with whatever precedes the first slide). */
export function splitChunks(body: string): { pre: string; chunks: string[] } {
  const parts = body.replace(/\r\n/g, "\n").split(/^(?=## )/m);
  const pre = parts[0]?.startsWith("## ") ? "" : (parts.shift() ?? "");
  return { pre, chunks: parts };
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
    } else for (const m of r.detail.matchAll(/第\s*(\d+)\s*頁/g)) pages.add(Number(m[1]));
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
  await env.note(`「${label}」讓已經符合的要求退步（${reg.map((r) => r.detail.slice(0, 80)).join("；")}），針對${pages.length ? pages.map((p) => `第 ${p} 頁`).join("、") : "改過的頁面"}修正。`, "warn");
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
      await env.note(`已把${pages.map((p) => `第 ${p} 頁`).join("、")}還原成「${label}」之前的版本，保住你的要求。`, "warn");
      return rolled;
    }
  }
  await env.note(`「${label}」的修改違反你的要求，已整份還原。`, "warn");
  return before;
}
