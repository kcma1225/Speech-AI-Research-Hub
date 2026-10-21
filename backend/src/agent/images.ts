/**
 * Images returned by agent tools (`view_paper_pages`): stored in S3 under `agent/<conversationId>/`, referenced from
 * the tool message as `image` blocks with a `hub-s3:<key>` URL, and inlined as base64 only when the model context is
 * built. Only the newest `KEEP_IMAGE_RESULTS` tool messages keep their images (older ones become a note, so a long
 * discussion does not resend every page), and none are sent when the role cannot take images right now (the run
 * would otherwise fail with `vision_unavailable`).
 */
import type { ChatMessage, ImageBlock, TextBlock } from "../ai/types.js";
import type { Storage } from "../lib/storage.js";

export const agentImagePrefix = (conversationId: string) => `agent/${conversationId}/`;
export const agentImageKey = (conversationId: string, toolCallId: string, i: number, ext: string) => `agent/${conversationId}/${toolCallId}-${i}.${ext}`;

export const IMAGE_REF = "hub-s3:";
export const KEEP_IMAGE_RESULTS = 2;
/** Rough token cost of one page image for the context estimate. */
export const IMAGE_TOKENS = 1600;

export type ToolImage = { mediaType: "image/jpeg" | "image/png" | "image/webp"; data: Buffer; label?: string };
export type StoredToolImage = { key: string; mediaType: string; label?: string };

const extOf = (t: string) => (t === "image/png" ? "png" : t === "image/webp" ? "webp" : "jpg");

export async function storeToolImages(storage: Storage, conversationId: string, toolCallId: string, images: ToolImage[]): Promise<StoredToolImage[]> {
  const out: StoredToolImage[] = [];
  for (const [i, img] of images.entries()) {
    const key = agentImageKey(conversationId, toolCallId, i, extOf(img.mediaType));
    await storage.put(key, img.data, img.mediaType);
    out.push({ key, mediaType: img.mediaType, ...(img.label ? { label: img.label } : {}) });
  }
  return out;
}

/** Tool-result content: the text envelope plus image references. */
export function toolResultContent(text: string, images: StoredToolImage[] | undefined): string | Array<TextBlock | ImageBlock> {
  if (!images?.length) return text;
  return [{ type: "text", text }, ...images.map((im) => ({ type: "image" as const, source: { kind: "url" as const, url: `${IMAGE_REF}${im.key}`, mediaType: im.mediaType } }))];
}

const isRef = (b: { type: string; source?: { kind: string; url?: string } }) => b.type === "image" && b.source?.kind === "url" && !!b.source.url?.startsWith(IMAGE_REF);

/** Number of stored image references in model messages (for the token estimate). */
export function countImageRefs(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_result" && Array.isArray(b.content)) n += b.content.filter((c) => isRef(c as ImageBlock)).length;
  }
  return n;
}

/**
 * Replaces `hub-s3:` image references with base64 data (newest `keep` image results only; all dropped when
 * `vision` is false). Mutates and returns `messages`.
 */
export async function inlineToolImages(storage: Storage, messages: ChatMessage[], opts: { vision: boolean; keep?: number }): Promise<ChatMessage[]> {
  let kept = 0;
  const keep = opts.keep ?? KEEP_IMAGE_RESULTS;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || !Array.isArray(b.content) || !b.content.some((c) => isRef(c as ImageBlock))) continue;
      const allow = opts.vision && kept < keep;
      kept++;
      const next: Array<TextBlock | ImageBlock> = [];
      let dropped = 0;
      for (const c of b.content) {
        if (!isRef(c as ImageBlock)) {
          next.push(c);
          continue;
        }
        if (!allow) {
          dropped++;
          continue;
        }
        const src = (c as ImageBlock).source as { url: string; mediaType?: string };
        const data = await storage.getBuffer(src.url.slice(IMAGE_REF.length)).catch(() => null);
        if (data) next.push({ type: "image", source: { kind: "base64", mediaType: src.mediaType ?? "image/jpeg", data: data.toString("base64") } });
        else dropped++;
      }
      if (dropped) next.push({ type: "text", text: opts.vision ? `（較早的 ${dropped} 張頁面圖片已省略；需要時請再呼叫 view_paper_pages。）` : `（${dropped} 張頁面圖片未送出：目前的模型無法看圖。）` });
      b.content = next;
    }
  }
  return messages;
}
