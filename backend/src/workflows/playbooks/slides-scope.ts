/**
 * Page-scoped deck edits (「把第九頁刪掉」「第三頁的標題改成…」): the pages the user's words name, and the rest of the deck
 * kept byte for byte — no writer, no screenshot pass, no requirement rewrite on a page the user did not ask to change
 * (production 12e713d3: deleting one page rewrote and re-screenshotted all ten pages, and the page stayed).
 */
import { parseSlides, titleMatches } from "../checks.js";
import { detectExclude, pageRefs, segmentClauses, trivialClause } from "../requirements.js";
import type { Requirement } from "../types.js";
import { splitChunks } from "./slides-requirements.js";

/**
 * 1-based content page = the user's page number (the player's, cover included when the deck has one), else null.
 * Negative: from the end (「最後一頁」 -1 = the last content page, 「倒數第二頁」 -2).
 */
export function contentPage(n: number, pages: number, cover: boolean): number | null {
  const i = n < 0 ? pages + 1 + n : cover ? n - 1 : n;
  return i >= 1 && i <= pages ? i : null;
}

/** Content pages an exclude requirement removes (its page numbers as the user counts, its terms as page titles). */
export function excludedPages(params: Requirement["params"] | undefined, titles: string[], cover: boolean): number[] {
  if (!params) return [];
  const out = new Set<number>();
  for (const n of params.pages ?? []) {
    const i = contentPage(n, titles.length, cover);
    if (i) out.add(i);
  }
  for (const t of (params.terms ?? []).flatMap((x: { name: string; aliases?: string[] }) => [x.name, ...(x.aliases ?? [])])) {
    const i = titles.findIndex((p) => !!p && titleMatches(t, p));
    if (i >= 0) out.add(i + 1);
  }
  return [...out].sort((a, b) => a - b);
}

/** Words about the deck as a whole: not a page-scoped edit. */
const DECK_WIDE_RE = /每一?[頁張]|所有(?:的)?(?:頁|投影片|內容|標題)|全部|都|其他頁|其餘|各頁|整份|整個簡報|整體|全篇|通篇|翻譯|翻成|譯成|語氣|風格|排版|版面|順序|重新組織|重組|\bevery (?:slide|page)\b|\ball (?:the )?(?:slides|pages)\b|\b(?:whole|entire) deck\b|\bthroughout\b|\btranslat/i;
/** A reason or a remark, not an ask (「因為這頁的內容不準確」). */
const REASON_RE = /^(?:因為|畢竟|不然|否則|由於|because\b|since\b)/i;
/** Adds pages (「在第三頁後面加一頁」「再加一頁結論」「add a slide after slide 3」). */
const ADD_RE = /(?:加上|加入|新增|增加|多加|補上|再加|插入|加)\s*(?:\d{1,2}|[一二兩三四五六七八九十])?\s*(?:頁|張投影片)|\b(?:add|insert)\b[^.\n]{0,30}\b(?:slides?|pages?)\b/i;
/** A page named as a position for added pages, not as a page to change (「在第三頁後面」「after slide 3」). */
const ANCHOR_RE = /後面|之後|以後|前面|之前|以前|[前後](?=加|插|新增|補)|\b(?:after|before|between)\b/i;
/** Requirement types that change the deck as a whole (a run-wide language, page count, topics…). */
const DECK_WIDE_TYPES = new Set<Requirement["type"]>(["language", "page_count", "include_topics", "per_item_fields", "audience", "length", "tone", "format"]);

const squash = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

/** Content pages a clause names: by number (as the user counts) or by quoting / writing out a page title. */
function namedPages(clause: string, titles: string[], cover: boolean): number[] {
  const out = new Set<number>();
  for (const n of pageRefs(clause)) {
    const i = contentPage(n, titles.length, cover);
    if (i) out.add(i);
  }
  const said = squash(clause);
  titles.forEach((t, i) => {
    const k = squash(t);
    if (k.length >= 4 && said.includes(k)) out.add(i + 1);
  });
  return [...out];
}

/** `added`: the words add pages (placed by the planner, next to the anchor they name); the other pages stay. */
export type PageScope = { removed: number[]; touched: number[]; added: boolean };

/**
 * The edit's page scope, or null when the words are about the deck as a whole. Every content clause has to name pages
 * (by number or title) or refer back to them (「這一頁」); reasons and filler are skipped. `removed`: pages to drop;
 * `touched`: pages to rewrite (named, not removed). A page the words do not name stays exactly as it is.
 */
export function pageScope(words: string, reqs: { type: Requirement["type"]; params?: Requirement["params"]; source?: Requirement["source"] }[], titles: string[], cover: boolean): PageScope | null {
  if (!titles.length || DECK_WIDE_RE.test(words)) return null;
  // (Not a language the system inferred from an English message: 「Delete slide 3」 asks for no translation.)
  if (reqs.some((r) => r.source !== "standing" && !r.params?.inferred && DECK_WIDE_TYPES.has(r.type))) return null;
  const removed = new Set(excludedPages(reqs.find((r) => r.type === "exclude")?.params, titles, cover));
  const named: number[] = [];
  let last: number[] = [];
  let added = false;
  for (const c of segmentClauses(words)) {
    if (REASON_RE.test(c.trim())) continue;
    const hits = namedPages(c, titles, cover);
    // Added pages: the pages a clause names are where they go, not pages to change.
    if (ADD_RE.test(c)) {
      added = true;
      if (hits.length && !ANCHOR_RE.test(c)) named.push(...hits);
      continue;
    }
    // A short clause that names a page is not filler (「Delete slide 3 from this deck」).
    if (!hits.length && trivialClause(c)) continue;
    if (!hits.length) {
      // A clause after one that names pages is about those pages (「第三頁的內容太多了，精簡一點」).
      if (last.length) {
        if (!last.every((n) => removed.has(n))) named.push(...last);
        continue;
      }
      return null;
    }
    last = hits;
    // A removal in the clause itself (the requirement may have missed it): those pages go, not rewritten.
    const ex = detectExclude(c);
    if (ex) for (const i of excludedPages(ex, titles, cover)) removed.add(i);
    named.push(...hits);
  }
  const touched = [...new Set(named)].filter((n) => !removed.has(n)).sort((a, b) => a - b);
  if (!removed.size && !touched.length && !added) return null;
  return { removed: [...removed].sort((a, b) => a - b), touched, added };
}

const titleOf = (raw: string) => parseSlides(raw)[0]?.title ?? "";

/** Every page of `body` titled like a kept original is that original, byte for byte (whatever a later pass wrote). */
export function keepPages(body: string, kept: string[]): string {
  if (!kept.length) return body;
  const byTitle = new Map(kept.map((raw) => [titleOf(raw), raw.trim()] as const).filter(([t]) => !!t));
  const { pre, chunks } = splitChunks(body);
  return `${pre}${chunks.map((c) => {
    const raw = c.startsWith("## ") ? byTitle.get(titleOf(c)) : undefined;
    return raw === undefined ? c : `${raw}\n\n`;
  }).join("")}`.replace(/\n{3,}/g, "\n\n");
}

/** The kept original titled `title`, if any. */
export const keptPage = (kept: string[] | undefined, title: string) => (kept ?? []).find((raw) => titleOf(raw) === title);
