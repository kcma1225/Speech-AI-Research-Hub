/**
 * Uploaded images attached to user turns are stored as `image` blocks with a `hub-s3:<key>` URL. When the model
 * request is built they are inlined as base64 (newest `keep` only) while the assistant role has vision; otherwise
 * each becomes a short note so the call never fails with `vision_unavailable`.
 */
import type { ChatMessage, ImageBlock, TextBlock } from "../../ai/types.js";
import type { Storage } from "../../lib/storage.js";
import { IMAGE_REF } from "../images.js";

export const KEEP_ATTACHED_IMAGES = 4;

const isRef = (b: { type: string; source?: { kind: string; url?: string } }) => b.type === "image" && b.source?.kind === "url" && !!b.source.url?.startsWith(IMAGE_REF);

/** Mutates and returns `messages`. */
export async function inlineAttachmentImages(storage: Storage, messages: ChatMessage[], opts: { vision: boolean; keep?: number }): Promise<ChatMessage[]> {
  const keep = opts.keep ?? KEEP_ATTACHED_IMAGES;
  let kept = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user" || typeof m.content === "string" || !m.content.some((b) => isRef(b as ImageBlock))) continue;
    const next: typeof m.content = [];
    for (const b of m.content) {
      if (!isRef(b as ImageBlock)) {
        next.push(b);
        continue;
      }
      const src = (b as ImageBlock).source as { url: string; mediaType?: string };
      let data: Buffer | null = null;
      if (opts.vision && kept < keep) data = await storage.getBuffer(src.url.slice(IMAGE_REF.length)).catch(() => null);
      if (data) {
        kept++;
        next.push({ type: "image", source: { kind: "base64", mediaType: src.mediaType ?? "image/jpeg", data: data.toString("base64") } } as ImageBlock);
      } else {
        next.push({ type: "text", text: opts.vision ? "（使用者先前附加的圖片已省略；需要時請使用者重新附加。）" : "（使用者附加了一張圖片，但目前的模型無法看圖；請告訴使用者，並只根據文字回答。）" } as TextBlock);
      }
    }
    m.content = next;
  }
  return messages;
}
