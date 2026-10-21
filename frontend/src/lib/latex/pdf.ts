/**
 * Lazy pdf.js (pdfjs-dist, Apache-2.0). The worker is a same-origin script (CSP `worker-src 'self'`). Loaded only by the LaTeX editor and project cards that show a PDF.
 */
type PdfJs = typeof import("pdfjs-dist");
let loading: Promise<PdfJs> | null = null;

export function pdfjs(): Promise<PdfJs> {
  loading ??= (async () => {
    // Bundled as a Vite worker chunk (`.js`, served as JavaScript; nginx does not know `.mjs`), one port shared by every document.
    const [lib, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?worker")]);
    lib.GlobalWorkerOptions.workerPort = new worker.default();
    return lib;
  })();
  return loading;
}

/** Opens a PDF (Range requests with the session cookie); `close()` releases the document and its worker side. */
export async function openPdf(url: string) {
  const lib = await pdfjs();
  const task = lib.getDocument({ url, withCredentials: true, rangeChunkSize: 262144 });
  const doc = await task.promise;
  return Object.assign(doc, { close: () => task.destroy() });
}
export type OpenPdf = Awaited<ReturnType<typeof openPdf>>;
