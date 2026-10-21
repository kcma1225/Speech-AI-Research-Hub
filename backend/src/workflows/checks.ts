/**
 * Deterministic verification checks (pure; unit-tested). Each check gets the step/artifact text, its params and the
 * step's structured output data, and returns {ok, detail} with a 繁中 detail the fixer can act on.
 */
import type { CheckResult, CheckSpec } from "./types.js";
import { chartBlocks, lintMermaid, mermaidBlocks } from "../lib/slides/deck-visuals.js";

export type Slide = { title: string; body: string; notes: string; index: number };

/** Splits a Quarto body into `## ` slides; notes = `::: notes` / `::: {.notes}` blocks. */
export function parseSlides(text: string): Slide[] {
  const parts = text.replace(/\r\n/g, "\n").split(/^(?=## )/m).filter((p) => p.startsWith("## "));
  return parts.map((p, i) => {
    const nl = p.indexOf("\n");
    const title = (nl < 0 ? p.slice(3) : p.slice(3, nl)).replace(/\{[^}]*\}\s*$/, "").trim();
    const rest = nl < 0 ? "" : p.slice(nl + 1);
    const notesRe = /^:::+\s*\{?\.?notes\}?\s*\n([\s\S]*?)^:::+\s*$/gm;
    let notes = "";
    let m: RegExpExecArray | null;
    while ((m = notesRe.exec(rest))) notes += m[1]!;
    const body = rest.replace(notesRe, "").trim();
    return { title, body, notes: notes.trim(), index: i + 1 };
  });
}

const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
export const titleMatches = (want: string, got: string) => {
  const a = norm(want);
  const b = norm(got);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};

export const PLACEHOLDER_RE = /〔\s*　*\s*〕|待補|待填|待完成|\bTODO\b|\bTBD\b|lorem ipsum|\bXXX\b|\?\?\?|〔[^〕]{0,6}〕|\[(?:插入|在此|placeholder)[^\]]*\]|（此處[^）]{0,20}）/i;

type Ctx = { params: Record<string, unknown>; data: unknown };
type CheckFn = (text: string, ctx: Ctx) => { ok: boolean; detail: string };

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function unbalanced(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  const fences = lines.filter((l) => /^\s*```/.test(l)).length;
  if (fences % 2) out.push("程式碼區塊（```）沒有關閉");
  let depth = 0;
  for (const l of lines) {
    if (/^:{3,}\s*\S/.test(l)) depth++;
    else if (/^:{3,}\s*$/.test(l)) depth = Math.max(0, depth - 1);
  }
  if (depth > 0) out.push("::: 區塊沒有關閉");
  const begins = (text.match(/\\begin\{/g) ?? []).length;
  const ends = (text.match(/\\end\{/g) ?? []).length;
  if (begins !== ends) out.push(`\\begin 與 \\end 數量不一致（${begins} / ${ends}）`);
  const dollars = (text.replace(/\\\$/g, "").match(/\$\$/g) ?? []).length;
  if (dollars % 2) out.push("$$ 公式沒有關閉");
  return out;
}

export const CHECKS: Record<string, CheckFn> = {
  min_length(text, { params }) {
    const min = num(params.chars, 200);
    return text.trim().length >= min ? { ok: true, detail: `長度 ${text.trim().length} 字` } : { ok: false, detail: `內容太短：${text.trim().length} 字，至少需要 ${min} 字。` };
  },
  source_refs(text, { params }) {
    const min = num(params.min, 3);
    const n = (text.match(/§\s*\d|p\.\s*\d|頁\s*\d|第\s*\d+\s*頁|Table\s*\d|表\s*\d|Fig(?:ure|\.)\s*\d|圖\s*\d|〈[^〉]{2,}〉/g) ?? []).length;
    return n >= min ? { ok: true, detail: `標註了 ${n} 處出處` } : { ok: false, detail: `出處標註不足：只有 ${n} 處，至少需要 ${min} 處（例如（§3.2，p. 4）、表 2、〈筆記名稱〉）。` };
  },
  slide_count(text, { params }) {
    const want = num(params.expected, 0);
    const got = parseSlides(text).length;
    return got === want ? { ok: true, detail: `共 ${got} 頁` } : { ok: false, detail: `頁數不符：應為 ${want} 頁，實際 ${got} 頁（每頁以「## 標題」開頭）。` };
  },
  slide_titles(text, { params }) {
    const want = strs(params.titles);
    const got = parseSlides(text).map((s) => s.title);
    const missing = want.filter((w) => !got.some((g) => titleMatches(w, g)));
    return missing.length ? { ok: false, detail: `缺少這些頁面：${missing.map((m) => `「${m}」`).join("、")}。` } : { ok: true, detail: "頁面標題與大綱一致" };
  },
  speaker_notes(text, { params }) {
    const min = num(params.min_chars, 30);
    const allow = strs(params.allow_titles);
    const bad = parseSlides(text).filter((s) => s.notes.replace(/\s+/g, "").length < min && !allow.some((a) => titleMatches(a, s.title)));
    return bad.length ? { ok: false, detail: `這些頁面沒有講稿或講稿太短（< ${min} 字）：${bad.map((s) => `第 ${s.index} 頁「${s.title}」`).join("、")}。` } : { ok: true, detail: "每頁都有講稿" };
  },
  no_placeholder(text, { params }) {
    const allow = strs(params.allow_titles);
    const slides = parseSlides(text);
    if (slides.length) {
      const bad = slides.filter((s) => !allow.some((a) => titleMatches(a, s.title)) && PLACEHOLDER_RE.test(`${s.body}\n${s.notes}`));
      return bad.length ? { ok: false, detail: `這些頁面還有佔位文字（〔　〕、待補、TODO…）：${bad.map((s) => `第 ${s.index} 頁「${s.title}」`).join("、")}。請填入依據資料的內容；資料裡真的沒有就明寫「資料未提供」。` } : { ok: true, detail: "沒有佔位文字" };
    }
    const m = PLACEHOLDER_RE.exec(text);
    return m ? { ok: false, detail: `內容還有佔位文字「${m[0]}」。` } : { ok: true, detail: "沒有佔位文字" };
  },
  not_truncated(text) {
    const t = text.trimEnd();
    const problems = unbalanced(t);
    if (!t) problems.push("內容是空的");
    const slides = parseSlides(t);
    const last = slides.at(-1);
    if (last && !last.body && !last.notes) problems.push(`最後一頁「${last.title}」是空的，可能被截斷`);
    return problems.length ? { ok: false, detail: `輸出不完整：${problems.join("；")}。` } : { ok: true, detail: "輸出完整" };
  },
  slide_length(text, { params }) {
    const maxChars = num(params.max_chars, 1100);
    const maxBullets = num(params.max_bullets, 9);
    const bad = parseSlides(text).filter((s) => {
      const visible = s.body.replace(/```mermaid[\s\S]*?```/g, "");
      return visible.length > maxChars || (visible.match(/^\s*[-*+] /gm) ?? []).length > maxBullets;
    });
    return bad.length ? { ok: false, detail: `這些頁面內容太多，投影片放不下（> ${maxChars} 字或 > ${maxBullets} 個條列）：${bad.map((s) => `第 ${s.index} 頁「${s.title}」`).join("、")}。請精簡或移到講稿。` } : { ok: true, detail: "每頁份量適中" };
  },
  /** Slide density: visible bullets and words per slide (code, charts, notes excluded; CJK chars count as ½ word). */
  slide_density(text, { params }) {
    const maxBullets = num(params.max_bullets, 6);
    const maxWords = num(params.max_words, 75);
    const allow = strs(params.allow_titles);
    const bad: string[] = [];
    for (const s of parseSlides(text)) {
      if (allow.some((a) => titleMatches(a, s.title))) continue;
      const w = visibleWords(s.body);
      const b = (s.body.replace(/^```[\s\S]*?^```/gm, "").match(/^\s*(?:[-*+]|\d+\.) /gm) ?? []).length;
      if (w > maxWords || b > maxBullets) bad.push(`第 ${s.index} 頁「${s.title}」（約 ${w} 字詞、${b} 個條列）`);
    }
    return bad.length ? { ok: false, detail: `這些頁面文字太多（上限約 ${maxWords} 字詞、${maxBullets} 個條列；中文 2 字算 1 詞）：${bad.join("、")}。保留一個重點，把細節移到講稿，改用圖、表或圖表呈現。` } : { ok: true, detail: "每頁文字量適中" };
  },
  /** Mermaid cells lint (```{mermaid}); a plain ```mermaid fence would show as raw code. */
  diagram_syntax(text) {
    const problems: string[] = [];
    if (/^```\s*mermaid\b/m.test(text)) problems.push("Mermaid 必須寫成 ```{mermaid}（加大括號），```mermaid 會直接顯示成程式碼");
    mermaidBlocks(text).forEach((code, i) => {
      for (const issue of lintMermaid(code)) problems.push(`第 ${i + 1} 張圖：${issue}`);
    });
    for (const c of chartBlocks(text)) if (!c.spec) problems.push(`有一個 \`\`\`chart 區塊不是有效的圖表 JSON：${c.source.slice(0, 80)}`);
    return problems.length ? { ok: false, detail: `圖表語法有問題：${problems.slice(0, 8).join("；")}。` } : { ok: true, detail: "圖與圖表語法正確" };
  },
  /** At least `min_ratio` of content slides carry a visual (diagram, chart, figure, image, table). */
  visual_ratio(text, { params }) {
    const ratio = num(params.min_ratio, 0.5);
    const allow = strs(params.allow_titles);
    const slides = parseSlides(text).filter((s) => !allow.some((a) => titleMatches(a, s.title)));
    if (!slides.length) return { ok: true, detail: "（沒有內容頁）" };
    const without = slides.filter((s) => !hasVisual(s.body));
    const have = slides.length - without.length;
    const need = Math.ceil(slides.length * ratio);
    return have >= need ? { ok: true, detail: `${have}/${slides.length} 頁有視覺元素` } : { ok: false, detail: `只有 ${have}/${slides.length} 頁有圖、表或圖表（至少需要 ${need} 頁）。這些頁面只有文字：${without.slice(0, 8).map((s) => `第 ${s.index} 頁「${s.title}」`).join("、")}。請改用 Mermaid 流程圖、\`\`\`chart 圖表、論文圖（paper-fig）或表格。` };
  },
  /** Result of the slides playbook's screenshot QA (`data.visualQa`). */
  visual_qa(_text, { data }) {
    const qa = (data as { visualQa?: { failed?: number[]; scored?: number; vision?: boolean } } | null)?.visualQa;
    if (!qa) return { ok: false, detail: "還沒有做逐頁視覺檢查。" };
    const failed = qa.failed ?? [];
    return failed.length ? { ok: false, detail: `這些頁面沒有通過視覺檢查：${failed.map((n) => `第 ${n} 頁`).join("、")}。` } : { ok: true, detail: `${qa.scored ?? 0} 頁都通過${qa.vision ? "截圖" : "版面量測"}檢查` };
  },
  sections_present(text, { params }) {
    const want = strs(params.sections);
    const heads = [...[...text.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => m[1]!.trim()), ...[...text.matchAll(/\\(?:chapter|(?:sub)*section)\*?\{([^}]*)\}/g)].map((m) => m[1]!.trim())];
    const missing = want.filter((w) => !heads.some((h) => titleMatches(w, h)));
    return missing.length ? { ok: false, detail: `缺少這些段落標題：${missing.map((m) => `「${m}」`).join("、")}。` } : { ok: true, detail: `涵蓋 ${want.length} 個段落` };
  },
  citations(text, { params }) {
    const keys = new Set(strs(params.keys));
    const min = num(params.min, 0);
    const used = new Set<string>();
    for (const m of text.matchAll(/\[@([^\]\s;,]+)/g)) used.add(m[1]!);
    for (const m of text.matchAll(/@([A-Za-z][\w:.-]*\d{2,4}[\w:.-]*)/g)) if (keys.has(m[1]!)) used.add(m[1]!);
    for (const m of text.matchAll(/\\(?:no)?cite[pt]?\*?(?:\[[^\]]*\])*\{([^}]*)\}/g)) for (const k of m[1]!.split(",")) used.add(k.trim());
    const unknown = [...used].filter((k) => k && !keys.has(k));
    if (unknown.length) return { ok: false, detail: `這些引用鍵不在研究的文獻庫中：${unknown.slice(0, 10).join("、")}。只能使用：${[...keys].slice(0, 30).join("、") || "（文獻庫是空的）"}。` };
    if (used.size < min) return { ok: false, detail: `引用太少：用了 ${used.size} 個，至少需要 ${min} 個（可用：${[...keys].slice(0, 30).join("、")}）。` };
    return { ok: true, detail: `引用 ${used.size} 筆，皆在文獻庫中` };
  },
  equations(text, { params }) {
    const min = num(params.min, 1);
    const n = (text.match(/\$\$[\s\S]+?\$\$/g) ?? []).length + (text.match(/\\\[[\s\S]+?\\\]/g) ?? []).length + (text.match(/(?<![$\\])\$[^$\n]{2,}\$(?!\$)/g) ?? []).length;
    return n >= min ? { ok: true, detail: `${n} 個公式` } : { ok: false, detail: `公式不足：找到 ${n} 個，至少需要 ${min} 個（用 LaTeX：$…$ 或 $$…$$）。` };
  },
  table_rows(text, { params }) {
    const min = num(params.min, 2);
    const rows = text.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|?\s*:?-{2,}/.test(l));
    const data = Math.max(0, rows.length - 1);
    return data >= min ? { ok: true, detail: `表格 ${data} 列` } : { ok: false, detail: `表格資料列不足：${data} 列，至少需要 ${min} 列（Markdown 表格）。` };
  },
  chart_blocks(text, { params }) {
    const min = num(params.min, 1);
    const blocks = [...text.matchAll(/```chart\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const bad = blocks.filter((b) => {
      try {
        const j = JSON.parse(b) as { labels?: unknown; series?: unknown };
        return !Array.isArray(j.series) || !(Array.isArray(j.labels) || (j as { type?: string }).type === "scatter");
      } catch {
        return true;
      }
    });
    if (bad.length) return { ok: false, detail: `${bad.length} 個 \`\`\`chart 區塊不是有效的 JSON（需要 labels 與 series）。` };
    return blocks.length >= min ? { ok: true, detail: `${blocks.length} 張圖表` } : { ok: false, detail: `需要至少 ${min} 張 \`\`\`chart 圖表，找到 ${blocks.length} 張。` };
  },
  numbers_from_source(text, { params }) {
    const source = String(params.source ?? "");
    const tables = text.split("\n").filter((l) => /^\s*\|/.test(l)).join("\n");
    const charts = [...text.matchAll(/```chart\s*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
    const nums = [...`${tables}\n${charts}`.matchAll(/(?<![\w.])\d+\.\d+|(?<![\w.])\d{2,}(?![\w])/g)].map((m) => m[0]);
    const missing = [...new Set(nums)].filter((n) => !source.includes(n) && !source.includes(String(Number(n))));
    return missing.length ? { ok: false, detail: `表格或圖表中的這些數字在原始資料裡找不到：${missing.slice(0, 12).join("、")}。只能使用資料中的數字。` } : { ok: true, detail: `${nums.length} 個數字皆可在資料中找到` };
  },
  render_ok(_text, { data }) {
    const err = (data as { renderError?: string | null; renderTimedOut?: boolean } | null) ?? null;
    if (err?.renderTimedOut) return { ok: false, detail: "預覽編譯逾時，無法確認能否編譯。" };
    return err?.renderError ? { ok: false, detail: `編譯失敗：${err.renderError.slice(-800)}` } : { ok: true, detail: "預覽編譯成功" };
  },
  compile_ok(_text, { data }) {
    const d = (data as { compile?: { status: string; errors: string[] } } | null)?.compile;
    if (!d) return { ok: true, detail: "（沒有編譯）" };
    return d.status === "success" || (d.status === "partial" && !d.errors.length) ? { ok: true, detail: "LaTeX 編譯成功" } : { ok: false, detail: `LaTeX 編譯有錯誤：${d.errors.slice(0, 5).join("；") || d.status}` };
  },
};

/** Visible words of a slide body: code/diagram/chart blocks, HTML tags, images and Markdown syntax removed. */
export function visibleWords(body: string): number {
  const t = body
    .replace(/^```[\s\S]*?^```/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[.#][^}]*\}/g, " ")
    .replace(/^:::.*$/gm, " ")
    .replace(/\$[^$]*\$/g, " x ");
  const cjk = (t.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (t.replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9][\w'.%-]*/g) ?? []).length;
  return Math.round(latin + cjk / 2);
}

export const hasVisual = (body: string) => /^```\{?\.?(mermaid|chart|dot)\b|!\[[^\]]*\]\([^)]+\)|^\s*\|.*\|\s*$|<img\b|<svg\b|\.big-number/m.test(body);

export function runChecks(specs: CheckSpec[], text: string, data: unknown): CheckResult[] {
  return specs.map((s) => {
    const fn = CHECKS[s.id];
    if (!fn) return { id: s.id, ok: true, detail: "（未知的檢查，略過）" };
    try {
      const r = fn(text, { params: s.params ?? {}, data });
      return { id: s.id, ...r };
    } catch (e) {
      return { id: s.id, ok: false, detail: `檢查失敗：${(e as Error).message}` };
    }
  });
}
