/**
 * Will a deck source file still compile? Deterministic checks of a text file of a deck's Quarto tree, run before an AI
 * suggestion is created (production 61666f10: suggest_deck_edit added a second `subtitle:` to the front matter, the user
 * accepted it and the preview failed with `duplicated mapping key`). Only problems the edit introduces count, so a
 * file the user already broke elsewhere does not block an unrelated fix.
 */
import { parseDocument } from "yaml";
import { lintDiagrams } from "./diagram/index.js";

const FRONT_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

/** YAML problems of a text (`offset`: lines before it in the file), one line each, without the parser's code frame. */
function yamlProblems(text: string, where: string, offset = 0): string[] {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
  const lines = text.split("\n");
  return doc.errors.map((e) => {
    const at = e.linePos?.[0]?.line ?? 0;
    const field = /^\s*([^:\s][^:\n]*):/.exec(lines[at - 1] ?? "")?.[1]?.trim();
    const what = e.code === "DUPLICATE_KEY" ? `欄位${field ? ` ${field}` : ""} 寫了兩次（要改既有的那一行，不要再加一行同名欄位）`
      : e.code === "BLOCK_AS_IMPLICIT_KEY" ? "值裡有「: 」卻沒有加引號（整個值用雙引號包起來）"
        : e.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "");
    return `${where}${at ? `第 ${at + offset} 行` : ""}YAML 錯誤：${what}`;
  });
}

/** Structure of a Quarto / Markdown body: code fences and `:::` divs closed. */
function blockProblems(body: string): string[] {
  const out: string[] = [];
  const lines = body.split("\n");
  if (lines.filter((l) => /^\s*```/.test(l)).length % 2) out.push("程式碼區塊（```）沒有關閉");
  let depth = 0;
  let fence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) fence = !fence;
    if (fence) continue;
    if (/^:{3,}\s*[^:\s]/.test(l)) depth++;
    else if (/^:{3,}\s*$/.test(l)) depth = depth > 0 ? depth - 1 : (out.push("多了一個沒有對應開頭的 :::"), 0);
  }
  if (depth > 0) out.push("::: 區塊沒有關閉");
  return out;
}

/** Every compile-breaking problem of one deck source file (path decides the kind). */
export function sourceProblems(path: string, text: string): string[] {
  const src = text.replace(/\r\n/g, "\n");
  if (/\.ya?ml$/i.test(path)) return yamlProblems(src, `${path} `);
  if (!/\.(?:qmd|md)$/i.test(path)) return [];
  const out: string[] = [];
  let body = src;
  if (/^---[ \t]*\n/.test(src)) {
    const m = FRONT_RE.exec(src);
    if (!m) return ["front matter（開頭的 ---）沒有結束的 ---"];
    out.push(...yamlProblems(m[1]!, "front matter ", 1));
    body = src.slice(m[0].length);
  }
  out.push(...blockProblems(body));
  out.push(...lintDiagrams(body).map((p) => `diagram：${p}`));
  return out;
}

const key = (p: string) => p.replace(/第 \d+ 行/g, "").replace(/\s+/g, " ").trim();

/** Problems `after` has that `before` did not (an edit's own breakage). */
export function newSourceProblems(path: string, before: string, after: string): string[] {
  const had = new Set(sourceProblems(path, before).map(key));
  return sourceProblems(path, after).filter((p) => !had.has(key(p)));
}
