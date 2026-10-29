/**
 * Imported meeting summaries (`meetings.summary_md`): a Markdown summary written on another platform. The analysis uses
 * it as the main source; this file finds its action items in code (checkboxes, bullets / tables under a 待辦 / Action
 * items heading) with their assignee and due date, and makes sure every one of them ends up as a proposed task
 * (`reconcileSummaryTasks`): the model may merge, drop or misplace items, the code does not.
 * Pure functions, unit-tested in test/meeting-summary.unit.test.ts.
 */
import type { AnalysisInput, AnalysisResult } from "./analysis.js";

export const SUMMARY_MAX = 100_000;

export type ActionItem = { title: string; detail: string; assignee: string | null; due: string | null; headings: string[] };

/** Headings whose bullets are action items. */
const TASK_HEAD = /待辦|代辦|行動|任務|分工|工作分配|後續|下一步|下次|追蹤|action\s*items?|to-?\s*dos?|tasks?|next\s*steps?|follow[\s-]*ups?|assignments?/i;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING = /^\s*(?:\*\*|__)([^*_]{1,60})(?:\*\*|__)\s*[:：]?\s*$/;
const BULLET = /^(\s*)(?:[-*+•]|\d{1,3}[.)、])\s+(.*)$/;
const CHECKBOX = /^\[( |x|X)\]\s+/;

const stripMd = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .trim();

const pad = (n: number) => String(n).padStart(2, "0");
const realDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/**
 * A due date in the text: 2026-11-05 / 2026/11/5 / 11/5 / 11月5日 (a year-less date takes the meeting's year, or the
 * next year when that would be more than 60 days before the meeting). Returns the date and the text without it.
 */
export function findDue(text: string, meetingDate: string): { due: string | null; rest: string } {
  const [my, mm, md] = meetingDate.split("-").map(Number) as [number, number, number];
  const meeting = Date.UTC(my, mm - 1, md);
  const year = (m: number, d: number) => (Date.UTC(my, m - 1, d) < meeting - 60 * 86400_000 ? my + 1 : my);
  const lead = String.raw`(?:(?:截止|期限|due|deadline|by|before|前|於)\s*[:：]?\s*)?`;
  const trail = String.raw`(?:\s*(?:前|以前|之前|截止|為止))?`;
  const patterns: [RegExp, (m: RegExpExecArray) => string | null][] = [
    [new RegExp(`${lead}(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})${trail}`, "i"), (m) => realDate(+m[1]!, +m[2]!, +m[3]!)],
    [new RegExp(`${lead}(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*[日號号]?${trail}`, "i"), (m) => realDate(year(+m[1]!, +m[2]!), +m[1]!, +m[2]!)],
    [new RegExp(`${lead}(?<![\\d/])(\\d{1,2})/(\\d{1,2})(?![\\d/])${trail}`, "i"), (m) => realDate(year(+m[1]!, +m[2]!), +m[1]!, +m[2]!)],
  ];
  for (const [re, toDate] of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const due = toDate(m);
    if (!due) continue;
    const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/[（(]\s*[)）]/g, "").replace(/\s{2,}/g, " ");
    return { due, rest: rest.trim() };
  }
  return { due: null, rest: text };
}

/** A written name: 1–6 Han characters (no spaces), or an English name of one or two capitalised words. */
const NAME = String.raw`\p{Script=Han}{1,6}|[A-Za-z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*)?`;

/** The assignee written in an item: @名字, （負責：名字）, 負責人：名字, Owner: name, [名字] / 名字： at the start. */
export function findAssignee(text: string): { assignee: string | null; rest: string } {
  const patterns: RegExp[] = [
    new RegExp(String.raw`[（(]\s*(?:負責人?|負責者|owner|assignee|by)\s*[:：]?\s*(${NAME})\s*[)）]`, "iu"),
    new RegExp(String.raw`(?:負責人?|負責者|owner|assignee)\s*[:：]\s*(${NAME})`, "iu"),
    new RegExp(String.raw`@\s*(${NAME})`, "u"),
    new RegExp(String.raw`^\s*[\[【]\s*(${NAME})\s*[\]】]\s*`, "u"),
    new RegExp(String.raw`^\s*(${NAME})\s*[:：]\s*(?=\S)`, "u"),
    new RegExp(String.raw`[（(]\s*(${NAME})\s*[)）]\s*$`, "u"),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const name = m[1]!.trim().replace(/[.．·]+$/, "");
    // 「注意：」「備註：」 and long phrases are not names.
    if (!name || /^(?:注意|備註|說明|重點|決議|結論|note|todo|問題|目標|討論)$/i.test(name) || [...name].length > 20) continue;
    const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/^\s*[-–—:：,，]\s*/, "").trim();
    if (!rest) continue;
    return { assignee: name, rest };
  }
  return { assignee: null, rest: text };
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => stripMd(c.trim()));
}

/**
 * Action items of a Markdown summary: every checkbox item; under a heading that names tasks (待辦、Action items…) every
 * top-level bullet (deeper bullets become its detail) and every table row (task / owner / due columns).
 */
export function extractActionItems(md: string, meetingDate: string): ActionItem[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: ActionItem[] = [];
  const stack: { level: number; text: string }[] = [];
  let taskLevel: number | null = null;
  let baseIndent: number | null = null;
  let last: ActionItem | null = null;
  let table: { cols: { task: number; who: number; due: number } } | null = null;

  const push = (raw: string, headings: string[], extra?: { who?: string; due?: string }) => {
    let text = stripMd(raw);
    let assignee: string | null = null;
    if (extra?.who) assignee = extra.who;
    else {
      const a = findAssignee(text);
      assignee = a.assignee;
      text = a.rest;
    }
    const d = findDue(extra?.due ? `${text} ${extra.due}` : text, meetingDate);
    text = d.rest.replace(/[，,;；。\s]+$/, "").trim();
    if (!text) return null;
    const item: ActionItem = { title: text.slice(0, 300), detail: "", assignee, due: d.due, headings };
    out.push(item);
    return item;
  };

  for (const line of lines) {
    const h = HEADING.exec(line) ?? (BOLD_HEADING.exec(line) ? ["", "######", BOLD_HEADING.exec(line)![1]!] : null);
    if (h) {
      const level = h[1]!.length;
      const text = stripMd(h[2]!);
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      stack.push({ level, text });
      if (taskLevel !== null && level <= taskLevel) taskLevel = null;
      if (TASK_HEAD.test(text) && [...text].length <= 40) taskLevel = level;
      baseIndent = null;
      last = null;
      table = null;
      continue;
    }
    const headings = stack.map((s) => s.text);
    const inTasks = taskLevel !== null;
    if (/^\s*\|/.test(line)) {
      const cells = splitRow(line);
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || !c)) continue;
      if (!table) {
        const find = (re: RegExp) => cells.findIndex((c) => re.test(c));
        const task = find(/任務|事項|工作|待辦|代辦|項目|內容|task|item|action|to-?do/i);
        if (task >= 0) table = { cols: { task, who: find(/負責|人員|指派|owner|assignee|who|person/i), due: find(/期限|截止|日期|時間|due|deadline|date|when/i) } };
        continue;
      }
      const title = cells[table.cols.task] ?? "";
      if (title) last = push(title, headings, { who: table.cols.who >= 0 ? cells[table.cols.who] || undefined : undefined, due: table.cols.due >= 0 ? cells[table.cols.due] || undefined : undefined });
      continue;
    }
    table = null;
    const b = BULLET.exec(line);
    if (!b) {
      if (!line.trim()) continue;
      continue;
    }
    const indent = b[1]!.replace(/\t/g, "    ").length;
    let body = b[2]!;
    const box = CHECKBOX.exec(body);
    if (box) body = body.slice(box[0].length);
    if (box && (!inTasks || baseIndent === null || indent <= baseIndent)) {
      last = push(body, headings);
      if (inTasks && baseIndent === null) baseIndent = indent;
      continue;
    }
    if (!inTasks) continue;
    if (baseIndent === null) baseIndent = indent;
    if (indent <= baseIndent) last = push(body, headings);
    else if (last) last.detail = [last.detail, `- ${stripMd(body)}`].filter(Boolean).join("\n").slice(0, 4000);
  }
  return out;
}

// ---------------------------------------------------------------- matching to the model's tasks

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
  return m;
}
/** Whether two task titles are the same task: one contains the other (≥ 4 chars) or bigram Dice ≥ 0.5. */
export function sameTask(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return true;
  const A = bigrams(x);
  const B = bigrams(y);
  let both = 0;
  for (const [k, n] of A) both += Math.min(n, B.get(k) ?? 0);
  const total = Math.max(1, x.length - 1) + Math.max(1, y.length - 1);
  return (2 * both) / total >= 0.5;
}

/** An account for a written name: exact (ignoring case / spaces), else the one person whose name contains it or vice versa. */
export function resolvePerson(name: string | null, people: { id: string; name: string }[]): string | null {
  if (!name) return null;
  const n = norm(name);
  if (!n) return null;
  const exact = people.filter((p) => norm(p.name) === n);
  if (exact.length === 1) return exact[0]!.id;
  if ([...n].length < 2) return null;
  const partial = people.filter((p) => {
    const q = norm(p.name);
    return q.length >= 2 && (q.includes(n) || n.includes(q));
  });
  const ids = [...new Set(partial.map((p) => p.id))];
  return ids.length === 1 ? ids[0]! : null;
}

/**
 * Every action item of the imported summary becomes a proposed task. An item the model kept (same title in some draft)
 * gets the written assignee / due date when the model left them empty and the person may be assigned in that study. A
 * missing item goes to the study its heading names, else the one study its assignee works on, else the only study;
 * otherwise it is listed under 「其他」 so it is not lost. Returns how many were added / filled.
 */
export function reconcileSummaryTasks(result: AnalysisResult, input: AnalysisInput, items: ActionItem[]): { added: number; filled: number; unplaced: number } {
  const stats = { added: 0, filled: 0, unplaced: 0 };
  const people = new Map<string, { id: string; name: string }>();
  for (const s of input.studies) for (const m of s.members) people.set(m.id, { id: m.id, name: m.name });
  for (const p of input.participants) people.set(p.id, p);
  const editors = new Map(input.studies.map((s) => [s.id, new Set(s.members.filter((m) => m.role === "owner" || m.role === "member").map((m) => m.id))]));
  const unplaced: ActionItem[] = [];
  for (const item of items) {
    const who = resolvePerson(item.assignee, [...people.values()]);
    const hit = result.drafts.flatMap((d) => d.tasks.map((t) => ({ d, t }))).find(({ t }) => sameTask(t.title, item.title));
    if (hit) {
      if (!hit.t.assignee_id && who && editors.get(hit.d.studyId)?.has(who)) {
        hit.t.assignee_id = who;
        stats.filled++;
      }
      if (!hit.t.due && item.due) hit.t.due = item.due;
      continue;
    }
    const byHeading = input.studies.filter((s) => item.headings.some((h) => norm(h).length >= 2 && (norm(h).includes(norm(s.title)) || (norm(s.title).length >= 4 && norm(s.title).includes(norm(h))))));
    const byPerson = who ? input.studies.filter((s) => editors.get(s.id)?.has(who)) : [];
    const study = byHeading.length === 1 ? byHeading[0] : byPerson.length === 1 ? byPerson[0] : input.studies.length === 1 ? input.studies[0] : undefined;
    const draft = study ? result.drafts.find((d) => d.studyId === study.id) : undefined;
    // A draft holds at most 50 proposed tasks (the confirm input's limit).
    if (!draft || draft.tasks.length >= 50) {
      unplaced.push(item);
      continue;
    }
    draft.tasks.push({ title: item.title, detail: item.detail, assignee_id: who && editors.get(draft.studyId)?.has(who) ? who : null, due: item.due });
    stats.added++;
  }
  if (unplaced.length) {
    const list = unplaced.map((i) => `- ${i.title}${i.assignee ? `（${i.assignee}）` : ""}${i.due ? `，${i.due}` : ""}`).join("\n");
    result.other_md = [result.other_md, `**摘要中的待辦（無法判斷屬於哪個研究，請手動加到對應的草稿）**\n${list}`].filter(Boolean).join("\n\n");
    stats.unplaced = unplaced.length;
  }
  if (stats.added || stats.filled || stats.unplaced) result.warnings.push(`summary_tasks:added=${stats.added},filled=${stats.filled},unplaced=${stats.unplaced}`);
  return stats;
}
