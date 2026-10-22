/**
 * ZIP import (Overleaf or any LaTeX folder exported as ZIP) and the pure heuristics it needs: the root file
 * (`\documentclass` + `\begin{document}` outside comments; conventional names first) and the compiler (magic
 * comment or packages that need XeLaTeX/LuaLaTeX). Files are kept as they are (no splitting).
 */
import path from "node:path";
import yauzl from "yauzl";
import { badRequest } from "../http.js";
import type { LatexCompiler } from "../latex/contract.js";
import { isSafeProjectPath } from "../latex/contract.js";
import { isBlockedPath, MAX_BINARY_BYTES, MAX_FILES, MAX_TEXT_BYTES } from "./store.js";

// `.aldine-out`: build output in project exports from the retired v2 Aldine editor.
const SKIPPED_DIRS = new Set([".git", "__MACOSX", "node_modules", ".out", ".aldine-out", "_minted"]);
const SKIPPED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
/** Build products that must not become project files (latexmk recreates them). */
const BUILD_EXT = new Set(["aux", "log", "fls", "fdb_latexmk", "synctex", "gz", "toc", "lof", "lot", "out", "bcf", "blg", "run", "xdv", "nav", "snm", "vrb"]);
export const IMPORT_LIMITS = { files: MAX_FILES, totalBytes: 300 * 1024 * 1024 };

export type ZipFile = { path: string; data: Buffer };

/** Reads every usable entry (skips junk and build products). Throws 400 for unsafe or oversized archives. */
export function readProjectZip(zipPath: string): Promise<ZipFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return reject(badRequest("ZIP 檔案無法讀取。"));
      const files: ZipFile[] = [];
      let total = 0;
      const fail = (cause: unknown) => {
        zip.close();
        if (cause instanceof Error && "status" in cause) return reject(cause);
        const unsafe = /absolute path|invalid relative path|invalid characters in fileName/.test(String((cause as Error)?.message));
        reject(badRequest(unsafe ? "ZIP 包含不安全路徑。" : "ZIP 檔案無法讀取。"));
      };
      zip.on("entry", (entry: yauzl.Entry) => {
        try {
          const name = entry.fileName;
          if (name.endsWith("/")) return zip.readEntry();
          const parts = name.split("/");
          if (parts.some((p) => SKIPPED_DIRS.has(p)) || SKIPPED_FILES.has(parts[parts.length - 1]!) || parts.some((p) => p.startsWith("._"))) return zip.readEntry();
          const ext = path.posix.extname(name).slice(1).toLowerCase();
          if (BUILD_EXT.has(ext) || /\.synctex\.gz$/i.test(name)) return zip.readEntry();
          if (parts.some((p) => p.startsWith(".env"))) throw badRequest("ZIP 包含禁止的檔案。");
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & 0o170000) === 0o120000) throw badRequest("ZIP 不可包含 symbolic link。");
          if (entry.isEncrypted()) throw badRequest("ZIP 不可加密。");
          if (entry.uncompressedSize > MAX_BINARY_BYTES) throw badRequest(`檔案太大（上限 ${MAX_BINARY_BYTES / 1024 / 1024} MB）：${name}`);
          total += entry.uncompressedSize;
          if (files.length >= IMPORT_LIMITS.files || total > IMPORT_LIMITS.totalBytes) throw badRequest("ZIP 超過檔案數量或容量限制。");
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) return fail(err);
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("error", fail);
            stream.on("end", () => {
              files.push({ path: name, data: Buffer.concat(chunks) });
              zip.readEntry();
            });
          });
        } catch (cause) {
          fail(cause);
        }
      });
      zip.on("end", () => resolve(stripCommonFolder(files)));
      zip.on("error", fail);
      zip.readEntry();
    });
  });
}

/** `project/main.tex`, `project/fig/a.png` → `main.tex`, `fig/a.png` (a single wrapping folder is removed). */
export function stripCommonFolder(files: ZipFile[]): ZipFile[] {
  if (!files.length) return files;
  const first = files[0]!.path.split("/")[0]!;
  if (!files.every((f) => f.path.includes("/") && f.path.split("/")[0] === first)) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

/** Valid UTF-8 text without NUL bytes and within the text size limit. */
export function decodeText(data: Buffer): string | null {
  if (data.length > MAX_TEXT_BYTES || data.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

const code = (text: string) => text.split(/\r?\n/).map((line) => line.replace(/(^|[^\\])%.*$/, "$1")).join("\n");

const PREFERRED = ["main.tex", "paper.tex", "thesis.tex", "manuscript.tex", "article.tex", "root.tex", "report.tex"];

/** The root document among `.tex` files, or null when none has `\documentclass` and `\begin{document}`. */
export function detectRoot(texFiles: { path: string; text: string }[]): string | null {
  const roots = texFiles.filter((f) => {
    const c = code(f.text);
    return /\\documentclass\b/.test(c) && /\\begin\{document\}/.test(c);
  });
  if (!roots.length) return null;
  const score = (p: string) => {
    const name = p.toLowerCase();
    const pref = PREFERRED.indexOf(name);
    return (pref >= 0 ? 100 - pref : 0) + (p.includes("/") ? 0 : 20) - p.split("/").length;
  };
  return roots.sort((a, b) => score(b.path) - score(a.path) || a.path.localeCompare(b.path))[0]!.path;
}

/** `% !TEX program = xelatex`, else packages that need Unicode engines (ctex, xeCJK, fontspec), else pdfLaTeX. */
export function detectCompiler(rootText: string): LatexCompiler {
  const magic = /^%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(rootText)?.[1]?.toLowerCase();
  if (magic === "xelatex" || magic === "lualatex" || magic === "pdflatex") return magic;
  const c = code(rootText);
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\bluatexja\b/.test(c)) return "lualatex";
  if (/\\documentclass(\[[^\]]*\])?\{ctex(art|rep|book|beamer)\}|\\usepackage(\[[^\]]*\])?\{[^}]*\b(ctex|xeCJK|fontspec|unicode-math)\b/.test(c)) return "xelatex";
  return "pdflatex";
}

/** Import paths must also satisfy the runner's rules; others are reported back as skipped. */
export const importablePath = (p: string) => isSafeProjectPath(p) && !p.split("/").some((s) => s.startsWith(".")) && !isBlockedPath(p);
