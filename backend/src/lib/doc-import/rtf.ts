/**
 * A small RTF reader: text, paragraphs, headings (outline level / "Heading N" styles), list items and tables.
 * Destinations that are not body text (font/colour tables, pictures, objects, headers/footers, footnotes, field
 * instructions, …) are skipped. \'hh bytes are decoded with the font's charset or the document's \ansicpg.
 */
import { DocImportError } from "./errors.js";
import { gfmTable, heading, inlineText, joinBlocks, mergeLists, TABLE_CAPS, textToMarkdown } from "./markdown.js";
import type { Extracted } from "./types.js";

const SKIP_DESTINATIONS = new Set([
  "colortbl", "pict", "object", "objdata", "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr",
  "footerf", "footnote", "fldinst", "themedata", "colorschememapping", "latentstyles", "datastore", "xmlnstbl",
  "listtable", "listoverridetable", "rsidtbl", "mmathPr", "generator", "pgdsctbl", "revtbl", "filetbl", "background",
  "docvar", "private", "nonshppict", "shp", "shpinst", "sp", "annotation", "atnid", "atnauthor", "bkmkstart",
  "bkmkend", "fontemb", "fontfile", "stylerestrictions", "pnseclvl", "pntxta", "pntxtb", "txe", "xe", "tc", "rxe",
  "operator", "company", "author", "keywords", "comment", "doccomm", "subject", "manager", "category", "hlinkbase",
  "creatim", "revtim", "printim", "buptim", "passwordhash", "protusertbl", "wgrffmtfilter", "ftnsep", "ftnsepc",
  "ftncn", "aftnsep", "aftnsepc", "aftncn", "userprops", "blipuid", "panose", "falt",
]);

/** \fcharset → Windows code page. */
const CHARSET_CP: Record<number, number> = {
  0: 0, 1: 0, 2: 1252, 77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258,
  177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 254: 437, 255: 850,
};

const CP_LABEL: Record<number, string> = {
  65001: "utf-8", 950: "big5", 936: "gbk", 54936: "gb18030", 932: "shift_jis", 949: "euc-kr", 1361: "euc-kr",
  874: "windows-874", 10000: "macintosh", 20127: "us-ascii", 28591: "iso-8859-1",
};

const decoders = new Map<number, InstanceType<typeof TextDecoder>>();
function decoder(cp: number): InstanceType<typeof TextDecoder> {
  let d = decoders.get(cp);
  if (!d) {
    const label = CP_LABEL[cp] ?? (cp >= 1250 && cp <= 1258 ? `windows-${cp}` : "windows-1252");
    try {
      d = new TextDecoder(label);
    } catch {
      d = new TextDecoder("windows-1252");
    }
    decoders.set(cp, d);
  }
  return d;
}

const SYMBOLS: Record<string, string> = {
  emdash: "—", endash: "–", bullet: "•", lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”", emspace: " ",
  enspace: " ", qmspace: " ", zwj: "", zwnj: "", ltrmark: "", rtlmark: "",
};

const PARAGRAPH_WORDS = new Set(["pard", "s", "outlinelevel", "intbl", "cell", "row", "nestcell", "nestrow", "par", "sect", "page"]);

type GroupState = { skip: boolean; dest: string | null; uc: number; font: number; first: boolean; star: boolean };
type Para = { text: string; level: number; style: number; list: string | null; intbl: boolean };

export function parseRtf(input: Uint8Array): Extracted {
  const head = Buffer.from(input.subarray(0, 16)).toString("latin1");
  if (!/^\s*\{\\rtf/.test(head)) throw new DocImportError(415, "content_mismatch", "檔案內容與副檔名不符。", "檔案開頭沒有 RTF 標記。");
  const src = input;
  let docCp = 1252;
  const fontCp = new Map<number, number>();
  const styleLevel = new Map<number, number>();
  let defaultFont = -1;

  let state: GroupState = { skip: false, dest: null, uc: 1, font: -1, first: true, star: false };
  const stack: GroupState[] = [];
  const blocks: string[] = [];
  let para: Para = { text: "", level: 0, style: 0, list: null, intbl: false };
  let row: string[] = [];
  let table: string[][] = [];
  let tableCapped = false;
  let title = "";
  let titleBuf = "";
  let listBuf = "";
  let fontNum = -1;
  let styleNum = 0;
  let styleBuf = "";
  let styleOutline = 0;
  let pendingBytes: number[] = [];
  let skipChars = 0;

  const cpOf = (font: number) => {
    const cp = fontCp.get(font >= 0 ? font : defaultFont);
    return cp ? cp : docCp;
  };
  const emit = (s: string) => {
    if (!s) return;
    switch (state.dest) {
      case null:
        if (!para.intbl && table.length) flushTable();
        para.text += s;
        break;
      case "title":
        titleBuf += s;
        break;
      case "listtext":
        listBuf += s;
        break;
      case "stylesheet":
        styleBuf += s;
        break;
      default:
        break; // fonttbl names, info fields
    }
  };
  const flushBytes = () => {
    if (!pendingBytes.length) return;
    const bytes = new Uint8Array(pendingBytes);
    pendingBytes = [];
    emit(decoder(cpOf(state.font)).decode(bytes));
  };
  const flushTable = () => {
    if (row.length) table.push(row);
    row = [];
    if (table.length) {
      if (table.length > TABLE_CAPS.maxRows) tableCapped = true;
      blocks.push(gfmTable(table.slice(0, TABLE_CAPS.maxRows).map((r) => r.slice(0, TABLE_CAPS.maxCols))));
    }
    table = [];
  };
  const endParagraph = () => {
    const text = para.text;
    para.text = "";
    if (para.intbl) {
      para.text = text + " "; // paragraph inside a table cell
      return;
    }
    if (table.length) flushTable();
    const level = para.level || styleLevel.get(para.style) || 0;
    const plain = text.replace(/[ \t]+/g, " ").trim();
    if (!plain) return;
    if (level) blocks.push(heading(level, plain));
    else if (para.list !== null) {
      const marker = para.list.replace(/\s+/g, "");
      const num = /^(\d{1,9})[.)]$/.exec(marker);
      blocks.push(`${num ? `${num[1]}.` : "-"} ${inlineText(plain)}`);
    } else blocks.push(textToMarkdown(text));
    para.list = null;
  };
  const endStyle = () => {
    const name = styleBuf.replace(/;\s*$/, "").trim();
    const m = /(?:heading|標題)\s*(\d)/i.exec(name);
    const level = styleOutline || (m ? Number(m[1]) : /^title$/i.test(name) ? 1 : 0);
    if (level) styleLevel.set(styleNum, Math.min(level, 6));
    styleBuf = "";
    styleOutline = 0;
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === 0x7b /* { */) {
      flushBytes();
      stack.push(state);
      state = { ...state, first: true, star: false };
      if (state.dest === "stylesheet") styleNum = 0;
      skipChars = 0;
      i++;
      continue;
    }
    if (c === 0x7d /* } */) {
      flushBytes();
      const closing = state;
      state = stack.pop() ?? state;
      if (closing.dest === "title" && !closing.skip && titleBuf.trim()) title = titleBuf.trim();
      if (closing.dest === "title") titleBuf = "";
      if (closing.dest === "listtext" && state.dest !== "listtext") {
        para.list = listBuf;
        listBuf = "";
      }
      if (closing.dest === "stylesheet" && state.dest === "stylesheet" && styleBuf.trim()) endStyle();
      skipChars = 0;
      i++;
      continue;
    }
    if (c === 0x5c /* \ */) {
      const next = src[i + 1];
      if (next === undefined) break;
      // \'hh
      if (next === 0x27) {
        const hex = String.fromCharCode(src[i + 2] ?? 0, src[i + 3] ?? 0);
        i += 4;
        if (skipChars > 0) {
          skipChars--;
          continue;
        }
        if (state.skip) continue;
        const v = parseInt(hex, 16);
        if (Number.isFinite(v)) pendingBytes.push(v);
        continue;
      }
      const isLetter = (b: number | undefined) => b !== undefined && ((b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a));
      if (!isLetter(next)) {
        i += 2;
        if (next === 0x2a /* * */) {
          state.star = true;
          continue;
        }
        if (skipChars > 0) {
          skipChars--;
          continue;
        }
        if (state.skip) continue;
        flushBytes();
        if (next === 0x5c || next === 0x7b || next === 0x7d) emit(String.fromCharCode(next));
        else if (next === 0x7e) emit(" ");
        else if (next === 0x5f) emit("-");
        else if (next === 0x0a || next === 0x0d) {
          if (state.dest === null) endParagraph();
        }
        continue;
      }
      // Control word with optional numeric parameter and one optional space delimiter.
      let j = i + 1;
      while (isLetter(src[j])) j++;
      const word = Buffer.from(src.subarray(i + 1, j)).toString("latin1");
      let k = j;
      if (src[k] === 0x2d || (src[k]! >= 0x30 && src[k]! <= 0x39)) {
        k++;
        while (src[k]! >= 0x30 && src[k]! <= 0x39) k++;
      }
      const param = k > j ? Number(Buffer.from(src.subarray(j, k)).toString("latin1")) : null;
      if (src[k] === 0x20) k++;
      i = k;
      const first = state.first;
      state.first = false;

      if (word === "bin" && param !== null && param > 0) {
        i += param; // raw binary data
        continue;
      }
      if (state.skip) continue;
      if (skipChars > 0 && word !== "u") {
        skipChars--;
        continue;
      }
      // Destinations
      if (first || state.star) {
        if (word === "ud" || word === "upr") {
          state.star = false;
          continue;
        }
        if (state.star && !["listtext", "pntext"].includes(word)) {
          state.skip = true;
          continue;
        }
        if (SKIP_DESTINATIONS.has(word)) {
          state.skip = true;
          continue;
        }
        if (word === "fonttbl" || word === "stylesheet" || word === "info") {
          flushBytes();
          state.dest = word;
          continue;
        }
        if (word === "title" && state.dest === "info") {
          state.dest = "title";
          titleBuf = "";
          continue;
        }
        if (word === "listtext" || word === "pntext") {
          flushBytes();
          state.dest = "listtext";
          listBuf = "";
          continue;
        }
      }
      if (state.dest === "info" || state.dest === "fonttbl") {
        if (state.dest === "fonttbl") {
          if (word === "f" && param !== null) fontNum = param;
          else if (word === "fcharset" && param !== null && fontNum >= 0) {
            const cp = CHARSET_CP[param];
            if (cp) fontCp.set(fontNum, cp);
          } else if (word === "cpg" && param !== null && fontNum >= 0) fontCp.set(fontNum, param);
        }
        continue;
      }
      if (state.dest === "stylesheet") {
        if (word === "s" && param !== null) styleNum = param;
        else if (word === "outlinelevel" && param !== null) styleOutline = Math.min(param + 1, 6);
        continue;
      }
      // Inside list markers and the title only character-level words matter.
      if (state.dest !== null && PARAGRAPH_WORDS.has(word)) continue;
      switch (word) {
        case "ansicpg":
          if (param) docCp = param;
          break;
        case "deff":
          if (param !== null) defaultFont = param;
          break;
        case "f":
          flushBytes();
          if (param !== null) state.font = param;
          break;
        case "uc":
          if (param !== null) state.uc = Math.max(0, param);
          break;
        case "u":
          if (param !== null) {
            flushBytes();
            emit(String.fromCharCode(param < 0 ? param + 65536 : param));
            skipChars = state.uc;
          }
          break;
        case "par":
        case "sect":
        case "page":
          flushBytes();
          if (state.dest === null) endParagraph();
          break;
        case "line":
          flushBytes();
          emit("\n");
          break;
        case "tab":
          flushBytes();
          emit(state.dest === "listtext" ? " " : "\t");
          break;
        case "pard":
          flushBytes();
          para.level = 0;
          para.style = 0;
          para.intbl = false;
          break;
        case "s":
          if (param !== null) para.style = param;
          break;
        case "outlinelevel":
          if (param !== null && param < 9) para.level = Math.min(param + 1, 6);
          break;
        case "intbl":
          para.intbl = true;
          break;
        case "cell":
        case "nestcell":
          flushBytes();
          row.push(para.text.replace(/\s+/g, " ").trim());
          para.text = "";
          break;
        case "row":
        case "nestrow":
          flushBytes();
          if (row.length) table.push(row);
          row = [];
          break;
        default: {
          const sym = SYMBOLS[word];
          if (sym !== undefined) {
            flushBytes();
            emit(sym);
          }
        }
      }
      continue;
    }
    // Plain character
    i++;
    if (c === 0x0a || c === 0x0d) continue;
    if (skipChars > 0) {
      skipChars--;
      continue;
    }
    if (state.skip) continue;
    if (state.dest === "stylesheet" && c === 0x3b /* ; */) {
      flushBytes();
      endStyle();
      continue;
    }
    if (c >= 0x80) {
      pendingBytes.push(c);
      continue;
    }
    flushBytes();
    emit(String.fromCharCode(c));
  }
  flushBytes();
  endParagraph();
  if (table.length || row.length) flushTable();
  return {
    markdown: joinBlocks(mergeLists(blocks)),
    title: title || null,
    warnings: tableCapped ? [`表格超過 ${TABLE_CAPS.maxRows} 列，只匯入前 ${TABLE_CAPS.maxRows} 列。`] : [],
  };
}
