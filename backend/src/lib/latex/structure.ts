/**
 * The structure of a LaTeX project as the reader of its PDF sees it (docs/architecture.md "LaTeX" → part-scoped edits):
 * every heading (\part … \subsubsection, starred or not), table, figure and the abstract, in document order — the root
 * file from \begin{document}, descending into \input / \include where they appear — with the numbers LaTeX prints
 * (「第三節」「Section 4」「Table 2」「Figure 3」「附錄 A」, per-chapter numbering in theses, \appendix lettering,
 * \frontmatter / \backmatter unnumbered), each with its exact character range in its own file.
 *
 * `resolveParts` maps the user's words onto those blocks (by number, Chinese numeral, title, label-free English refs,
 * paragraphs of a block, citation keys) so an edit can touch only the parts the words name and keep everything else byte
 * for byte (`spliceKept`). The last compile's `.aux` (`\newlabel`), when available, overrides computed numbers.
 *
 * Pure: no database, no storage. Comments (`%`) are ignored when reading the structure, never removed from the text.
 */

export type SourceFile = { path: string; text: string };
export type HeadingLevel = "part" | "chapter" | "section" | "subsection" | "subsubsection";
export type BlockKind = "heading" | "table" | "figure" | "abstract";

export type Block = {
  kind: BlockKind;
  /** Headings only. */
  level?: HeadingLevel;
  starred?: boolean;
  /** Heading title / float caption (plain, as written). */
  title: string;
  label: string | null;
  /** The number LaTeX prints ("3", "3.2", "A", "A.1", table "2" / "3.1"); null when unnumbered. */
  number: string | null;
  appendix: boolean;
  path: string;
  /** [start, end) in the file: a heading's block runs to the next heading of the same or a higher level. */
  start: number;
  end: number;
  /** Headings: end of the heading command (and a \label right after it): the body starts here. */
  bodyStart: number;
  /** Index in `ProjectStructure.blocks` (document order). */
  index: number;
};

export type ProjectStructure = {
  blocks: Block[];
  /** The document uses \chapter (theses): sections, tables and figures are numbered per chapter. */
  chapters: boolean;
  /** Files reached from the root, in document order. */
  order: string[];
  /** Every cite key used in a \cite-like command. */
  citeKeys: string[];
};

const LEVELS: HeadingLevel[] = ["part", "chapter", "section", "subsection", "subsubsection"];
const rank = (l: HeadingLevel) => LEVELS.indexOf(l);

/** The text with every comment replaced by spaces (same length; `\%` is not a comment). */
export function maskComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "%") {
      const nl = text.indexOf("\n", i);
      const stop = nl < 0 ? text.length : nl;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The balanced `{…}` group starting at `open` (text[open] === "{"): [content, index after the closing brace]. */
export function braceGroup(text: string, open: number): [string, number] | null {
  if (text[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return [text.slice(open + 1, i), i + 1];
  }
  return null;
}

const plain = (t: string) => t.replace(/\\label\{[^}]*\}/g, "").replace(/\\[a-zA-Z]+\*?\s*/g, "").replace(/[{}~]/g, " ").replace(/\s+/g, " ").trim();

/** `\newlabel{key}{{number}{page}…}` of an .aux file → key → number. */
export function auxNumbers(aux: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of (aux ?? "").matchAll(/\\newlabel\{([^}]+)\}\{\{([^{}]*)\}/g)) if (m[2]) out.set(m[1]!, m[2]);
  return out;
}

const normPath = (p: string) => {
  let v = p.trim().replace(/^"(.*)"$/, "$1");
  while (v.startsWith("./")) v = v.slice(2);
  return /\.[A-Za-z0-9]+$/.test(v.slice(v.lastIndexOf("/") + 1)) ? v : `${v}.tex`;
};

const letter = (n: number) => (n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : String(n));

type Ev =
  | { t: "heading"; pos: number; lineStart: number; level: HeadingLevel; starred: boolean; title: string; after: number }
  | { t: "input"; pos: number; path: string; after: number }
  | { t: "float"; pos: number; lineStart: number; kind: "table" | "figure" | "abstract"; end: number; caption: string | null; label: string | null }
  | { t: "mark"; pos: number; what: "appendix" | "frontmatter" | "mainmatter" | "backmatter" | "biblio" | "enddoc" };

const lineStartOf = (text: string, pos: number) => {
  const s = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*$/.test(text.slice(s, pos)) ? s : pos;
};
const lineEndOf = (text: string, pos: number) => {
  const m = /^[ \t]*\r?\n/.exec(text.slice(pos));
  return m ? pos + m[0].length : pos;
};

/** The events of one file in order (comments masked). Root: only the document body. */
function events(text: string, root: boolean): Ev[] {
  const masked = maskComments(text);
  let from = 0;
  let to = masked.length;
  if (root) {
    const b = /\\begin\{document\}/.exec(masked);
    if (b) from = b.index + b[0].length;
    const e = /\\end\{document\}/.exec(masked.slice(from));
    if (e) to = from + e.index;
  }
  const out: Ev[] = [];
  const re = /\\(part|chapter|section|subsection|subsubsection)(\*?)\s*(?:\[[^\]]*\]\s*)?(?=\{)|\\(input|include)\s*\{([^{}]+)\}|\\begin\{(table|figure|abstract)(\*?)\}|\\(appendix|frontmatter|mainmatter|backmatter)\b|\\(bibliography|printbibliography)\b|\\begin\{thebibliography\}/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) && m.index < to) {
    if (m[1]) {
      const g = braceGroup(masked, m.index + m[0].length);
      if (!g) continue;
      let after = g[1];
      const title = plain(text.slice(m.index + m[0].length + 1, g[1] - 1));
      re.lastIndex = after;
      out.push({ t: "heading", pos: m.index, lineStart: lineStartOf(text, m.index), level: m[1] as HeadingLevel, starred: m[2] === "*", title, after });
    } else if (m[3]) {
      out.push({ t: "input", pos: m.index, path: normPath(m[4]!), after: m.index + m[0].length });
    } else if (m[5]) {
      const env = `${m[5]}${m[6] ?? ""}`;
      const endRe = new RegExp(`\\\\end\\{${env.replace("*", "\\*")}\\}`, "g");
      endRe.lastIndex = m.index + m[0].length;
      const e = endRe.exec(masked);
      const end = e ? e.index + e[0].length : to;
      const body = masked.slice(m.index, end);
      const cap = /\\caption\s*(?:\[[^\]]*\]\s*)?(?=\{)/.exec(body);
      const capGroup = cap ? braceGroup(body, cap.index + cap[0].length) : null;
      const label = /\\label\{([^}]+)\}/.exec(body)?.[1] ?? null;
      out.push({ t: "float", pos: m.index, lineStart: lineStartOf(text, m.index), kind: m[5] as "table" | "figure" | "abstract", end: lineEndOf(text, end), caption: capGroup ? plain(text.slice(m.index + cap!.index + cap![0].length + 1, m.index + capGroup[1] - 1)) : null, label });
      re.lastIndex = end;
    } else if (m[7]) out.push({ t: "mark", pos: m.index, what: m[7] as "appendix" });
    else out.push({ t: "mark", pos: m.index, what: "biblio" });
  }
  out.push({ t: "mark", pos: to, what: "enddoc" });
  return out;
}

/** A heading's own \label right after it (same or next line). */
function labelAfter(text: string, after: number): { label: string; end: number } | null {
  const m = /^[ \t]*(?:\r?\n[ \t]*)?\\label\{([^}]+)\}/.exec(text.slice(after));
  return m ? { label: m[1]!, end: after + m[0].length } : null;
}

/**
 * The project's structure from its root file and the files it reaches. `aux`: the last successful compile's .aux text
 * (its \newlabel numbers win over the computed ones).
 */
export function projectStructure(files: SourceFile[], rootPath: string, aux?: string | null): ProjectStructure {
  const byPath = new Map(files.map((f) => [normPath(f.path), f] as const));
  const auxNum = auxNumbers(aux);
  type Raw = { ev: Ev; path: string; anchors: Map<string, number> };
  const raws: Raw[] = [];
  const order: string[] = [];
  const visit = (path: string, root: boolean, anchors: Map<string, number>, seen: Set<string>) => {
    const f = byPath.get(path);
    if (!f || seen.has(path)) return;
    order.push(path);
    const inner = new Set(seen).add(path);
    for (const ev of events(f.text, root)) {
      if (ev.t === "input") {
        const next = new Map(anchors).set(path, lineStartOf(f.text, ev.pos));
        visit(ev.path, false, next, inner);
      } else raws.push({ ev, path, anchors: new Map(anchors).set(path, ev.t === "heading" || ev.t === "float" ? ev.lineStart : ev.pos) });
    }
  };
  visit(normPath(rootPath), true, new Map(), new Set());
  const chapters = raws.some((r) => r.ev.t === "heading" && r.ev.level === "chapter");
  // Counters as LaTeX keeps them (article / report / book), numbering per chapter when there are chapters.
  const c: Record<HeadingLevel, number> = { part: 0, chapter: 0, section: 0, subsection: 0, subsubsection: 0 };
  let tables = 0;
  let figures = 0;
  let appendix = false;
  let numbered = true;
  const chapterNo = () => (appendix && chapters ? letter(c.chapter) : String(c.chapter));
  const sectionNo = () => (chapters ? `${chapterNo()}.${c.section}` : appendix ? letter(c.section) : String(c.section));
  const blocks: Block[] = [];
  const pending: { block: Block; raw: Raw }[] = [];
  for (const raw of raws) {
    const ev = raw.ev;
    if (ev.t === "mark") {
      if (ev.what === "appendix") {
        appendix = true;
        if (chapters) c.chapter = 0;
        else c.section = 0;
      } else if (ev.what === "frontmatter" || ev.what === "backmatter") numbered = false;
      else if (ev.what === "mainmatter") {
        numbered = true;
        c.chapter = 0;
      }
      continue;
    }
    if (ev.t === "input") continue;
    const text = byPath.get(raw.path)!.text;
    if (ev.t === "heading") {
      let number: string | null = null;
      // \frontmatter / \backmatter (books, theses): nothing is numbered there.
      if (!ev.starred && numbered) {
        c[ev.level]++;
        // A \part does not reset the chapter counter; every other level resets the ones below it.
        for (const l of LEVELS.slice(rank(ev.level) + 1)) if (l !== "chapter") c[l] = 0;
        if (ev.level === "chapter") {
          tables = 0;
          figures = 0;
        }
        number = ev.level === "part" ? String(c.part) : ev.level === "chapter" ? chapterNo() : ev.level === "section" ? sectionNo() : ev.level === "subsection" ? `${sectionNo()}.${c.subsection}` : `${sectionNo()}.${c.subsection}.${c.subsubsection}`;
      }
      const lab = labelAfter(text, ev.after);
      const label = lab?.label ?? null;
      if (label && auxNum.has(label)) number = auxNum.get(label)!;
      const block: Block = { kind: "heading", level: ev.level, starred: ev.starred, title: ev.title, label, number, appendix, path: raw.path, start: ev.lineStart, end: text.length, bodyStart: lineEndOf(text, lab?.end ?? ev.after), index: blocks.length };
      blocks.push(block);
      pending.push({ block, raw });
    } else {
      let number: string | null = null;
      if (ev.kind !== "abstract" && ev.caption !== null) {
        const n = ev.kind === "table" ? ++tables : ++figures;
        number = chapters && c.chapter ? `${chapterNo()}.${n}` : String(n);
      }
      if (ev.label && auxNum.has(ev.label)) number = auxNum.get(ev.label)!;
      blocks.push({ kind: ev.kind, title: ev.caption ?? "", label: ev.label, number, appendix, path: raw.path, start: ev.lineStart, end: ev.end, bodyStart: ev.lineStart, index: blocks.length });
    }
  }
  // A heading's block ends where the next heading of the same or a higher level begins (its anchor in this file: the line
  // of the \input that leads to it), at the bibliography / \appendix / \backmatter of this file, or at the end of its region.
  for (const { block, raw } of pending) {
    const text = byPath.get(raw.path)!.text;
    let end = text.length;
    const rootEnd = raws.find((r) => r.path === raw.path && r.ev.t === "mark" && r.ev.what === "enddoc" && r.ev.pos > block.start);
    if (rootEnd) end = Math.min(end, rootEnd.ev.pos);
    const i = raws.indexOf(raw);
    for (const r of raws.slice(i + 1)) {
      const stop = (r.ev.t === "heading" && rank(r.ev.level) <= rank(block.level!)) || (r.ev.t === "mark" && r.ev.what !== "enddoc" && r.ev.what !== "mainmatter" && r.ev.what !== "frontmatter");
      if (!stop) continue;
      const at = r.anchors.get(raw.path);
      if (at !== undefined && at > block.start) {
        end = Math.min(end, at);
        break;
      }
      // Outside this file's subtree: the block runs to the end of its file.
      if (at === undefined) break;
    }
    block.end = end;
  }
  const citeKeys = new Set<string>();
  for (const path of order) {
    const masked = maskComments(byPath.get(path)!.text);
    for (const m of masked.matchAll(CITE_RE)) for (const k of m[2]!.split(",")) if (k.trim()) citeKeys.add(k.trim());
  }
  return { blocks, chapters, order, citeKeys: [...citeKeys] };
}

const CITE_RE = /\\(cite[a-zA-Z]*|[Cc]ite[pt]?\*?|parencite|textcite|autocite|footcite)\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)\}/g;

// ---------------------------------------------------------------- paragraphs, citations

export type Range = { path: string; start: number; end: number };

/** The paragraphs of a heading block (blank-line separated prose; heading / label lines and floats are not paragraphs). */
export function paragraphsOf(text: string, block: Block, floats: Block[] = []): Range[] {
  const out: Range[] = [];
  const masked = maskComments(text);
  const from = block.kind === "heading" ? block.bodyStart : block.start;
  const re = /(?:^|\n)[ \t]*\r?\n/g;
  const cuts: number[] = [from];
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) && m.index < block.end) cuts.push(m.index + m[0].length);
  cuts.push(block.end);
  for (let i = 0; i < cuts.length - 1; i++) {
    let s = cuts[i]!;
    const e = cuts[i + 1]!;
    if (e <= s) continue;
    // Leading heading / label lines belong to no paragraph (a subsection heading starts the chunk).
    for (;;) {
      const line = /^[ \t]*\\(?:(?:sub)*section|chapter|paragraph|label)\*?\s*(?:\[[^\]]*\])?\{[^\n]*\}[ \t]*(?:\r?\n|$)/.exec(masked.slice(s, e));
      if (!line) break;
      s += line[0].length;
    }
    const chunk = masked.slice(s, e);
    if (!chunk.trim()) continue;
    if (floats.some((f) => f.path === block.path && s >= f.start && s < f.end)) continue;
    const lead = chunk.length - chunk.trimStart().length;
    const trail = chunk.length - chunk.trimEnd().length;
    out.push({ path: block.path, start: s + lead, end: e - trail });
  }
  return out;
}

/** Every \cite command in `text` that uses `key`: its range and the command without that key ("" when it was the only key). */
export function citeEdits(text: string, key: string): { start: number; end: number; after: string }[] {
  const out: { start: number; end: number; after: string }[] = [];
  const masked = maskComments(text);
  for (const m of masked.matchAll(CITE_RE)) {
    const keys = m[2]!.split(",").map((k) => k.trim());
    if (!keys.includes(key)) continue;
    const rest = keys.filter((k) => k !== key);
    let start = m.index!;
    const end = start + m[0].length;
    if (!rest.length) {
      // The whole command goes, with the tie / space that joined it to the word before.
      while (start > 0 && (text[start - 1] === "~" || text[start - 1] === " ")) start--;
      out.push({ start, end, after: "" });
    } else out.push({ start, end, after: text.slice(start, end).replace(/\{[^{}]*\}$/, `{${rest.join(",")}}`) });
  }
  return out;
}

// ---------------------------------------------------------------- the user's words → blocks

const CN: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 「三」「十二」「二十一」「3」「３」 → number (null when not a number). */
export function numeral(s: string): number | null {
  const t = s.trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(t)) return Number(t);
  if (!/^[零〇一二兩三四五六七八九十百]+$/.test(t)) return null;
  if (t === "十") return 10;
  const ten = t.indexOf("十");
  if (ten < 0) return t.length === 1 ? CN[t]! : null;
  const hi = ten === 0 ? 1 : CN[t[ten - 1]!] ?? null;
  const lo = ten === t.length - 1 ? 0 : CN[t[ten + 1]!] ?? null;
  return hi === null || lo === null ? null : hi * 10 + lo;
}
const ORD_EN: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const NUM = "[0-9０-９]+|[零〇一二兩三四五六七八九十]+";

/** A removal in the words (verb before or after the part: 「刪掉第三節」「把第三節刪掉」「remove Table 2」). */
export const REMOVE_RE = /刪掉|刪除|刪去|拿掉|拿走|去掉|移除|不要了|不需要了?|砍掉|\bremove\b|\bdelete\b|\bdrop\b|get rid of|\btake\b[^.\n]{0,60}\bout\b|\bcut\b/i;
/** Words about the paper as a whole: not a part-scoped edit. */
export const WHOLE_DOC_RE = /整篇|全文|全篇|通篇|整份|整個(?:論文|專案|檔案)|所有(?:的)?(?:章節|段落|內容)|每一?[節章段]|全部(?:的)?(?:章節|內容)?|\bwhole (?:paper|document|thesis)\b|\bentire (?:paper|document|thesis)\b|\bevery (?:section|paragraph|chapter)\b|\ball (?:the )?(?:sections|chapters)\b|\bthroughout\b/i;

export type PartRef =
  | { type: "heading"; level: "chapter" | "section" | "any"; number: string; text: string }
  | { type: "appendix"; letter: string | null; text: string }
  | { type: "float"; kind: "table" | "figure"; number: string; text: string }
  | { type: "abstract"; text: string }
  | { type: "title"; block: number; text: string }
  | { type: "paragraph"; n: number | "last"; text: string }
  | { type: "citation"; key: string; text: string };

const squash = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");

/** The parts one clause names (in the order they appear). */
export function partRefs(clause: string, s: ProjectStructure): PartRef[] {
  const out: { at: number; ref: PartRef }[] = [];
  const add = (at: number, ref: PartRef) => out.push({ at, ref });
  // 第三章第二節 / 3.2 節 / Section 3.2 / §3.2
  for (const m of clause.matchAll(new RegExp(`第\\s*(${NUM})\\s*章\\s*(?:的)?\\s*第\\s*(${NUM})\\s*節`, "g"))) {
    const a = numeral(m[1]!), b = numeral(m[2]!);
    // (In an article 章 is its section and 節 its subsection.)
    if (a && b) add(m.index!, { type: "heading", level: s.chapters ? "section" : "any", number: `${a}.${b}`, text: m[0] });
  }
  const covered = (i: number) => out.some((o) => i >= o.at && i < o.at + o.ref.text.length);
  for (const m of clause.matchAll(new RegExp(`第\\s*(${NUM}(?:\\.\\d+)*)\\s*(節|章|小節)`, "g"))) {
    if (covered(m.index!)) continue;
    const raw = m[1]!;
    const n = raw.includes(".") ? raw : String(numeral(raw) ?? "");
    if (!n) continue;
    // 章 in a document without chapters is its top-level section (students say 第三章 for Section 3 of an article).
    add(m.index!, { type: "heading", level: m[2] === "章" ? (s.chapters ? "chapter" : "section") : m[2] === "小節" ? "any" : "section", number: n, text: m[0] });
  }
  for (const m of clause.matchAll(/(\d+(?:\.\d+)+)\s*(?:節|小節)|(?:\b(?:sub)*sections?|\bsec\.?|§)\s*(\d+(?:\.\d+)*)\b|\b(?:chapter|ch\.)\s*(\d+)\b/gi)) {
    if (covered(m.index!)) continue;
    if (m[3]) add(m.index!, { type: "heading", level: s.chapters ? "chapter" : "section", number: m[3], text: m[0] });
    else add(m.index!, { type: "heading", level: (m[1] ?? m[2]!).includes(".") ? "any" : "section", number: m[1] ?? m[2]!, text: m[0] });
  }
  for (const m of clause.matchAll(/附錄\s*([A-Za-zＡ-Ｚ]|[一二三四五六七八九十])?|\bappendix(?:\s+([A-Z])\b)?/gi)) {
    const g = (m[1] ?? m[2] ?? "").normalize("NFKC");
    const n = g ? numeral(g) : null;
    add(m.index!, { type: "appendix", letter: g ? (n ? letter(n) : g.toUpperCase()) : null, text: m[0] });
  }
  for (const m of clause.matchAll(new RegExp(`((?<![代發列簡報])表|(?<![地試企意構藍])圖|\\btables?\\b|\\btab\\.|\\bfigures?\\b|\\bfig\\.)\\s*(${NUM}(?:[.-]\\d+)?)`, "gi"))) {
    const kind = /表|tab/i.test(m[1]!) ? "table" : "figure";
    const raw = m[2]!.replace("-", ".");
    const n = raw.includes(".") ? raw : String(numeral(raw) ?? "");
    if (n) add(m.index!, { type: "float", kind, number: n, text: m[0] });
  }
  for (const m of clause.matchAll(/摘要|\babstract\b/gi)) add(m.index!, { type: "abstract", text: m[0] });
  for (const m of clause.matchAll(new RegExp(`第\\s*(${NUM})\\s*段|最後一段|\\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\\s+paragraph\\b|\\bparagraph\\s+(\\d+)\\b`, "gi"))) {
    const n = m[1] ? numeral(m[1]) : m[2] ? (m[2].toLowerCase() === "last" ? "last" : ORD_EN[m[2].toLowerCase()]!) : m[3] ? Number(m[3]) : "last";
    if (n) add(m.index!, { type: "paragraph", n, text: m[0] });
  }
  // A heading named by its title (「Related Work 那節」「把緒論的第二段…」): the longest title the clause contains.
  const said = squash(clause);
  const longEnough = (k: string) => k.length >= (/[\u3400-\u9fff]/.test(k) ? 2 : 4);
  const titled = s.blocks.filter((b) => b.kind === "heading" && longEnough(squash(b.title)) && said.includes(squash(b.title)));
  const longest = Math.max(0, ...titled.map((b) => squash(b.title).length));
  for (const b of titled.filter((x) => squash(x.title).length === longest)) {
    // 「摘要」 the heading of a thesis abstract chapter is the abstract itself (one ref, not two).
    if (out.some((o) => o.ref.type === "abstract") && /^(?:摘要|abstract)$/i.test(b.title.trim())) continue;
    const at = clause.toLowerCase().indexOf(b.title.toLowerCase());
    add(at < 0 ? 0 : at, { type: "title", block: b.index, text: b.title });
  }
  // A citation named by its key next to 引用 / cite / citation.
  if (/引用|參考文獻|\bcit(?:e|ation)s?\b|\breference\b/i.test(clause)) {
    for (const k of s.citeKeys) {
      const at = clause.indexOf(k);
      if (at >= 0 && k.length >= 3) add(at, { type: "citation", key: k, text: k });
    }
  }
  return out.sort((a, b) => a.at - b.at).map((o) => o.ref);
}

export type PartTarget = {
  kind: "block" | "paragraph" | "citation";
  action: "remove" | "rewrite";
  /** What the user called it (「第三節」「Table 2」「Related Work 第二段」). */
  ref: string;
  /** The block (headings / floats / abstract), or the block a paragraph is in. */
  block: Block | null;
  /** Ranges in their files (a citation key may appear several times). */
  ranges: (Range & { after?: string })[];
  /** The user's clause about it (the instruction for a rewrite). */
  clause: string;
};

export type PartResolution =
  | { kind: "parts"; targets: PartTarget[] }
  /** The words are about the whole paper (or name no part): not a part-scoped edit. */
  | { kind: "none"; why: string }
  /** A named part is not in the source, or matches several parts: ask the user (never guess). */
  | { kind: "ask"; question: string; candidates: Block[]; /** The words that matched several parts (a card picks one). */ ref?: string };

export const blockLabel = (b: Block) => {
  if (b.kind === "table") return `表 ${b.number ?? "（無編號）"}${b.title ? `「${b.title.slice(0, 30)}」` : ""}`;
  if (b.kind === "figure") return `圖 ${b.number ?? "（無編號）"}${b.title ? `「${b.title.slice(0, 30)}」` : ""}`;
  if (b.kind === "abstract") return "摘要";
  const n = b.number ? (b.appendix && /^[A-Z]/.test(b.number) && (b.level === "chapter" || b.level === "section") ? `附錄 ${b.number} ` : `${b.number} `) : "";
  return `${n}${b.title}`.trim();
};

function matchRef(ref: PartRef, s: ProjectStructure): Block[] {
  const heads = s.blocks.filter((b) => b.kind === "heading");
  switch (ref.type) {
    case "heading": {
      const exact = heads.filter((b) => b.number === ref.number && (ref.level === "any" || b.level === ref.level));
      if (exact.length || ref.number.includes(".")) return exact;
      // 「第三節」 in a thesis: section x.3 of whichever chapter — unique, else ambiguous.
      if (ref.level === "section" && s.chapters) return heads.filter((b) => b.level === "section" && !b.appendix && b.number?.split(".").at(-1) === ref.number);
      return exact;
    }
    case "appendix": {
      const top = s.chapters ? "chapter" : "section";
      const app = heads.filter((b) => b.appendix && b.level === top);
      return ref.letter ? app.filter((b) => b.number === ref.letter) : app;
    }
    case "float":
      return s.blocks.filter((b) => b.kind === ref.kind && b.number === ref.number);
    case "abstract": {
      const env = s.blocks.filter((b) => b.kind === "abstract");
      if (env.length) return env;
      // A thesis has 「摘要」 and 「Abstract」 chapters: the one the user named.
      const named = heads.filter((b) => b.title.trim().toLowerCase() === ref.text.toLowerCase());
      return named.length ? named : heads.filter((b) => /^(?:摘要|abstract)$/i.test(b.title.trim()));
    }
    case "title":
      return [s.blocks[ref.block]!];
    default:
      return [];
  }
}

/**
 * The parts the words name, or why not. Every content clause has to name a part (or refer back to one: 「這段」「那節」);
 * a clause about the whole paper makes the edit not part-scoped. Paragraph refs apply to the part named in the same clause
 * (or the previous one). Removals need no writer; rewrites carry their clause as the instruction.
 */
export function resolveParts(words: string, s: ProjectStructure, files: SourceFile[], chosen: Map<string, number> = new Map()): PartResolution {
  if (WHOLE_DOC_RE.test(words)) return { kind: "none", why: "你的話是對整份論文的修改" };
  const text = new Map(files.map((f) => [normPath(f.path), f.text] as const));
  const clauses = words.split(/[。！？!?；;\n]+|[，,]\s*(?=把|將|然後|再|也|並|另外|還有|and\b|then\b)/).map((c) => c.trim()).filter(Boolean);
  const targets: PartTarget[] = [];
  let last: Block[] = [];
  let any = false;
  const floats = s.blocks.filter((b) => b.kind !== "heading");
  for (const clause of clauses) {
    const refs = partRefs(clause, s);
    const remove = REMOVE_RE.test(clause);
    if (!refs.length) {
      // 「這段／那節／它」 continue the part named before; a short filler clause is skipped.
      if (last.length && /這|那|該|它|\bit\b|\bthis\b|\bthat\b/i.test(clause)) {
        const t = targets.at(-1);
        if (t) {
          t.clause = `${t.clause}，${clause}`;
          if (remove) t.action = "remove";
        }
        continue;
      }
      // Any other clause (「語氣要正式一點」) is an instruction for the parts named: the writer gets the user's whole words.
      continue;
    }
    any = true;
    let scope: Block[] = [];
    const paragraphs = refs.filter((r): r is Extract<PartRef, { type: "paragraph" }> => r.type === "paragraph");
    const citations = refs.filter((r): r is Extract<PartRef, { type: "citation" }> => r.type === "citation");
    for (const ref of refs.filter((r) => r.type !== "paragraph" && r.type !== "citation")) {
      let found = matchRef(ref, s);
      // The user picked one of several matches on a card.
      const pick = chosen.get(ref.text);
      if (found.length > 1 && pick !== undefined && found.some((b) => b.index === pick)) found = found.filter((b) => b.index === pick);
      if (!found.length) return { kind: "ask", question: `論文裡找不到「${ref.text}」。${outlineHint(s)}請說明要改的是哪一節、哪個表或圖。`, candidates: [] };
      if (found.length > 1) return { kind: "ask", question: `「${ref.text}」對應到好幾個地方：${found.slice(0, 6).map(blockLabel).map((x) => `「${x}」`).join("、")}。請說要改的是哪一個。`, candidates: found, ref: ref.text };
      if (!scope.includes(found[0]!)) scope.push(found[0]!);
    }
    if (!scope.length && (paragraphs.length || citations.length)) scope = last;
    for (const c of citations) {
      const ranges: PartTarget["ranges"] = [];
      for (const path of s.order) {
        const t = text.get(path) ?? "";
        for (const e of citeEdits(t, c.key)) {
          if (scope.length && !scope.some((b) => b.path === path && e.start >= b.start && e.end <= b.end)) continue;
          ranges.push({ path, start: e.start, end: e.end, after: e.after });
        }
      }
      if (!ranges.length) return { kind: "ask", question: `${scope.length ? `「${blockLabel(scope[0]!)}」` : "論文"}裡沒有引用 ${c.key}。請確認要拿掉的是哪一個引用。`, candidates: [] };
      targets.push({ kind: "citation", action: remove ? "remove" : "rewrite", ref: `引用 ${c.key}`, block: scope[0] ?? null, ranges, clause });
    }
    if (paragraphs.length) {
      if (scope.length !== 1 || scope[0]!.kind !== "heading") return { kind: "ask", question: `「${paragraphs[0]!.text}」是哪一節的？${outlineHint(s)}請一起說出節名或節號。`, candidates: [] };
      const b = scope[0]!;
      const paras = paragraphsOf(text.get(b.path) ?? "", b, floats);
      for (const p of paragraphs) {
        const n = p.n === "last" ? paras.length : p.n;
        const r = paras[n - 1];
        if (!r) return { kind: "ask", question: `「${blockLabel(b)}」只有 ${paras.length} 段，找不到「${p.text}」。請確認要改的是哪一段。`, candidates: [b] };
        targets.push({ kind: "paragraph", action: remove ? "remove" : "rewrite", ref: `${blockLabel(b)} ${p.text}`, block: b, ranges: [{ path: b.path, start: r.start, end: r.end }], clause });
      }
    } else if (!citations.length) {
      for (const b of scope) targets.push({ kind: "block", action: remove ? "remove" : "rewrite", ref: blockLabel(b), block: b, ranges: [{ path: b.path, start: b.start, end: b.end }], clause });
    }
    last = scope;
  }
  if (!any || !targets.length) return { kind: "none", why: "你的話沒有指出論文的哪一部分" };
  // Overlapping parts (a section and its own paragraph): the larger part wins only for a removal; else ask.
  const flat = targets.flatMap((t) => t.ranges.map((r) => ({ t, r })));
  for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) {
    const a = flat[i]!, b = flat[j]!;
    if (a.t === b.t || a.r.path !== b.r.path || a.r.end <= b.r.start || b.r.end <= a.r.start) continue;
    return { kind: "ask", question: `「${a.t.ref}」和「${b.t.ref}」重疊。請分開說明各要怎麼改。`, candidates: [] };
  }
  return { kind: "parts", targets };
}

function outlineHint(s: ProjectStructure): string {
  const top = s.blocks.filter((b) => b.kind === "heading" && (b.level === "chapter" || (b.level === "section" && !s.chapters))).slice(0, 12);
  return top.length ? `目前的章節：${top.map(blockLabel).join("、")}。` : "";
}

// ---------------------------------------------------------------- the kept-everything-else guard

export type Splice = { start: number; end: number; after: string };

/** The file with these ranges replaced (non-overlapping), everything else byte for byte. */
export function applySplices(text: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of sorted) out = `${out.slice(0, s.start)}${s.after}${out.slice(s.end)}`;
  return out;
}

/** The text outside the splices, in order (what must stay byte for byte). */
export function keptSegments(text: string, splices: Splice[]): string[] {
  const sorted = [...splices].sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let at = 0;
  for (const s of sorted) {
    out.push(text.slice(at, s.start));
    at = s.end;
  }
  out.push(text.slice(at));
  return out;
}

/** Whether `next` keeps every kept segment byte for byte, in order (the write guard). */
export function keepsSegments(next: string, kept: string[]): boolean {
  let at = 0;
  for (const k of kept) {
    if (!k) continue;
    const i = next.indexOf(k, at);
    if (i < 0) return false;
    at = i + k.length;
  }
  return true;
}

/**
 * A rewritten heading block keeps its own heading command (level, star), its title unless `retitle`, and its \label:
 * the writer's text without its heading lines gets the original heading lines back.
 */
export function keepHeading(original: string, rewritten: string, opts: { retitle?: boolean } = {}): string {
  const head = /^[ \t]*\\(part|chapter|section|subsection|subsubsection)(\*?)\s*(?:\[[^\]]*\]\s*)?\{[^\n]*\}[^\n]*\r?\n?(?:[ \t]*\\label\{[^}]*\}[^\n]*\r?\n?)?/.exec(original);
  if (!head) return rewritten;
  const body = rewritten.replace(/^\s*\\(?:part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\]\s*)?\{[^\n]*\}[^\n]*\r?\n?(?:[ \t]*\\label\{[^}]*\}[^\n]*\r?\n?)?/, "");
  if (!opts.retitle) return `${head[0]}${head[0].endsWith("\n") ? "" : "\n"}${body.replace(/^\r?\n/, "")}`;
  // A new title: the writer's title inside the original command (level, star) and label.
  const t = /^\s*\\(?:part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\]\s*)?\{([^\n]*)\}/.exec(rewritten)?.[1];
  const headText = head[0];
  const open = headText.indexOf("{", headText.indexOf(`\\${head[1]}`));
  const g = braceGroup(headText, open);
  if (!t || !g) return `${headText}${body}`;
  return `${headText.slice(0, open)}{${t}}${headText.slice(g[1])}${body}`;
}
