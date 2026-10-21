import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * Paste and drop handling for Markdown editors:
 * - rich HTML on the clipboard (web pages, Word, Google Docs) becomes Markdown via Turndown (MIT, + GFM tables),
 *   loaded in the background when the editor mounts; plain-text pastes and pastes from code editors stay as is;
 * - pasted or dropped image files go to `onImages` (upload → `![](url)`), other dropped files to `onFiles`.
 * Every insertion is a normal transaction (Yjs-safe, undoable as one step).
 */
type Turndown = { turndown(html: string): string };
let turndown: Turndown | null = null;
let loading: Promise<Turndown | null> | null = null;

export function loadTurndown(): Promise<Turndown | null> {
  loading ??= Promise.all([import("turndown"), import("@joplin/turndown-plugin-gfm")])
    .then(([{ default: TurndownService }, gfm]) => {
      const service = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
        emDelimiter: "*",
        strongDelimiter: "**",
        hr: "---",
        linkStyle: "inlined",
      });
      service.use([gfm.tables, gfm.strikethrough, gfm.taskListItems]);
      service.remove(["script", "style", "noscript", "iframe", "object", "embed", "template", "meta", "link", "title", "head"] as never);
      // Images embedded as data: URLs would paste megabytes of base64; keep their alt text only.
      service.addRule("dataImages", {
        filter: (node: HTMLElement) => node.nodeName === "IMG" && /^data:/i.test(node.getAttribute("src") ?? ""),
        replacement: (_c: string, node: HTMLElement) => node.getAttribute("alt") ?? "",
      });
      turndown = service as Turndown;
      return turndown;
    })
    .catch(() => null);
  return loading;
}

const STRUCTURE = /<(h[1-6]|ul|ol|li|table|tr|strong|b|em|i|a\s[^>]*href|pre|blockquote|img|del|s|code|hr)\b/i;

/** Whether pasted HTML is worth converting (has structure, is not a code editor's highlighted copy). */
export function isRichHtml(html: string, plain: string): boolean {
  if (!html || !STRUCTURE.test(html)) return false;
  // VS Code / JetBrains copies: monospace divs with spans only.
  if (/vscode|jetbrains|monaco|data-ccp-|class="?cm-/i.test(html) && !/<(h[1-6]|ul|ol|table)\b/i.test(html)) return false;
  // Already Markdown in the plain text (copied from another Markdown editor/preview source).
  if (/^(#{1,6} |[-*] |\d+\. |> |```|\|.*\|)/m.test(plain) && !/<(h[1-6]|table)\b/i.test(html)) return false;
  return true;
}

/** HTML → tidy Markdown (null when Turndown is not loaded yet). */
export function htmlToMarkdown(html: string): string | null {
  if (!turndown) return null;
  // Office HTML: drop conditional comments and <o:p> paragraphs before conversion.
  const cleaned = html.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "").replace(/<\/?o:p>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  return turndown
    .turndown(cleaned)
    .replace(/\u00a0/g, " ")
    // Turndown pads list markers to 4 columns ("-   item"); keep the usual single space.
    .replace(/^(\s*)([-*+]|\d+[.)])[ ]{2,}/gm, "$1$2 ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type PasteOptions = {
  /** Upload images (paste/drop); return Markdown to insert or null to skip. */
  onImages?: (files: File[], view: EditorView, at: number) => void;
  /** Other dropped files (e.g. documents to import). */
  onFiles?: (files: File[], view: EditorView, at: number) => void;
};

const images = (list: FileList | null | undefined) => [...(list ?? [])].filter(f => f.type.startsWith("image/"));

export function markdownPaste(options: PasteOptions = {}): Extension {
  if (typeof window !== "undefined") {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 400));
    idle(() => void loadTurndown());
  }
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      const data = event.clipboardData;
      if (!data) return false;
      const files = images(data.files);
      if (files.length && options.onImages) {
        event.preventDefault();
        options.onImages(files, view, view.state.selection.main.from);
        return true;
      }
      const html = data.getData("text/html");
      const plain = data.getData("text/plain");
      if (!isRichHtml(html, plain)) return false;
      const converted = htmlToMarkdown(html);
      if (!converted) return false;
      event.preventDefault();
      // Block content pasted in the middle of a line starts on its own paragraph.
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      const block = /^(#{1,6} |[-*+] |\d+[.)] |\||> |```)/m.test(converted);
      const lead = block && from > line.from ? "\n\n" : block && line.number > 1 && from === line.from && view.state.doc.line(line.number - 1).text.trim() ? "\n" : "";
      view.dispatch(view.state.replaceSelection(lead + converted), { scrollIntoView: true, userEvent: "input.paste" });
      return true;
    },
    dragover(event) {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        return true;
      }
      return false;
    },
    drop(event, view) {
      const list = event.dataTransfer?.files;
      if (!list?.length || view.state.readOnly) return false;
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      const imgs = images(list);
      const others = [...list].filter(f => !f.type.startsWith("image/"));
      if (!(imgs.length && options.onImages) && !(others.length && options.onFiles)) return false;
      event.preventDefault();
      if (imgs.length && options.onImages) options.onImages(imgs, view, at);
      if (others.length && options.onFiles) options.onFiles(others, view, at);
      return true;
    },
  });
}
