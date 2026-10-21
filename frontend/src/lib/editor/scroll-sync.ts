import type { EditorView } from "@codemirror/view";

/**
 * Synchronized scrolling between a CodeMirror view and a rendered preview whose block elements carry
 * `data-line` (1-based source line, `renderMarkdown(…, { sourceLines: true })`). The pane the user scrolls
 * drives the other one; positions interpolate between neighbouring blocks, so long paragraphs and images stay
 * aligned. Returns a cleanup function.
 */
export function syncScroll(view: EditorView, preview: HTMLElement): () => void {
  const editor = view.scrollDOM;
  let driver: "editor" | "preview" | null = null;
  let release = 0;
  let frame = 0;

  const anchors = () => {
    const out: { line: number; top: number }[] = [];
    const base = preview.getBoundingClientRect().top - preview.scrollTop;
    for (const el of preview.querySelectorAll<HTMLElement>("[data-line]")) {
      const line = Number(el.dataset.line);
      if (!line) continue;
      const top = el.getBoundingClientRect().top - base;
      if (out.length && top < out[out.length - 1]!.top) continue;
      out.push({ line, top });
    }
    return out;
  };

  /** Fractional source line at the top of the editor viewport. */
  const editorLine = () => {
    const top = editor.scrollTop;
    const block = view.lineBlockAtHeight(top - view.documentPadding.top);
    const line = view.state.doc.lineAt(block.from).number;
    return line + Math.max(0, Math.min(1, (top - view.documentPadding.top - block.top) / Math.max(1, block.height)));
  };

  const editorTopFor = (line: number) => {
    const n = Math.max(1, Math.min(view.state.doc.lines, Math.floor(line)));
    const block = view.lineBlockAt(view.state.doc.line(n).from);
    return block.top + view.documentPadding.top + (line - n) * block.height;
  };

  const lock = (who: "editor" | "preview") => {
    driver = who;
    clearTimeout(release);
    release = window.setTimeout(() => (driver = null), 140);
  };

  const fromEditor = () => {
    if (driver === "preview") return;
    lock("editor");
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const maxEditor = editor.scrollHeight - editor.clientHeight;
      const maxPreview = preview.scrollHeight - preview.clientHeight;
      if (maxPreview <= 0) return;
      // Pin both ends so the last lines are reachable even when the preview is shorter.
      if (editor.scrollTop <= 1) return void (preview.scrollTop = 0);
      if (editor.scrollTop >= maxEditor - 1) return void (preview.scrollTop = maxPreview);
      const list = anchors();
      if (!list.length) return void (preview.scrollTop = (editor.scrollTop / Math.max(1, maxEditor)) * maxPreview);
      const line = editorLine();
      let i = list.findIndex(a => a.line > line);
      if (i === -1) i = list.length;
      const prev = list[i - 1] ?? { line: 1, top: 0 };
      const next = list[i] ?? { line: view.state.doc.lines + 1, top: preview.scrollHeight };
      const ratio = (line - prev.line) / Math.max(1, next.line - prev.line);
      preview.scrollTop = prev.top + (next.top - prev.top) * ratio;
    });
  };

  const fromPreview = () => {
    if (driver === "editor") return;
    lock("preview");
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const maxPreview = preview.scrollHeight - preview.clientHeight;
      const maxEditor = editor.scrollHeight - editor.clientHeight;
      if (preview.scrollTop <= 1) return void (editor.scrollTop = 0);
      if (preview.scrollTop >= maxPreview - 1) return void (editor.scrollTop = maxEditor);
      const list = anchors();
      if (!list.length) return void (editor.scrollTop = (preview.scrollTop / Math.max(1, maxPreview)) * maxEditor);
      const top = preview.scrollTop;
      let i = list.findIndex(a => a.top > top);
      if (i === -1) i = list.length;
      const prev = list[i - 1] ?? { line: 1, top: 0 };
      const next = list[i] ?? { line: view.state.doc.lines + 1, top: preview.scrollHeight };
      const ratio = (top - prev.top) / Math.max(1, next.top - prev.top);
      editor.scrollTop = editorTopFor(prev.line + (next.line - prev.line) * ratio);
    });
  };

  // The pane that scrolled first drives for 140 ms, so programmatic scrolls of the other pane do not echo back.
  editor.addEventListener("scroll", fromEditor, { passive: true });
  preview.addEventListener("scroll", fromPreview, { passive: true });
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(release);
    editor.removeEventListener("scroll", fromEditor);
    preview.removeEventListener("scroll", fromPreview);
  };
}

/** Scrolls the preview so the block for source line `line` is at the top (outline jumps). */
export function revealPreviewLine(preview: HTMLElement, line: number) {
  let best: HTMLElement | null = null;
  for (const el of preview.querySelectorAll<HTMLElement>("[data-line]")) {
    if (Number(el.dataset.line) <= line) best = el;
    else break;
  }
  if (!best) return;
  const top = best.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop - 8;
  preview.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
