/// <reference lib="webworker" />
/**
 * SyncTeX in a Web Worker: downloads `output.synctex.gz` of one compile (same-origin, cookie), decompresses it with
 * DecompressionStream and answers forward/inverse lookups. Messages carry an `id` echoed in the reply.
 */
import { forwardSearch, inverseSearch, parseSynctex, type SyncData } from "./synctex.ts";
import { pageSources } from "../vision/page-sources.ts";

type Request =
  | { id: number; type: "load"; url: string; key: string }
  | { id: number; type: "forward"; key: string; file: string; line: number }
  | { id: number; type: "inverse"; key: string; page: number; x: number; y: number }
  | { id: number; type: "page"; key: string; page: number };

let current: { key: string; data: Promise<SyncData> } | null = null;

async function load(url: string): Promise<SyncData> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok || !res.body) throw new Error(`synctex ${res.status}`);
  const text = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
  return parseSynctex(text);
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const msg = event.data;
  try {
    if (msg.type === "load") {
      if (current?.key !== msg.key) current = { key: msg.key, data: load(msg.url) };
      const data = await current.data;
      self.postMessage({ id: msg.id, ok: true, result: { boxes: data.boxes.length } });
      return;
    }
    if (!current || current.key !== msg.key) throw new Error("not loaded");
    const data = await current.data;
    const result =
      msg.type === "forward" ? forwardSearch(data, msg.file, msg.line) : msg.type === "page" ? pageSources(data, msg.page) : inverseSearch(data, msg.page, msg.x, msg.y);
    self.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    if (msg.type === "load") current = null;
    self.postMessage({ id: msg.id, ok: false, error: (e as Error).message });
  }
};
