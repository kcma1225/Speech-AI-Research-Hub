/** `read_attachment`: pages through the extracted text of a document uploaded into the current conversation. */
import { z } from "zod";
import { notFound } from "../../lib/http.js";
import { registerAgentTool } from "../tools/registry.js";
import { clip, isUuid, scrub, uuidArg } from "../tools/util.js";
import { ownUpload, uploadUrl } from "./uploads.js";

registerAgentTool({
  name: "read_attachment",
  title: "讀取附加檔案",
  titleEn: "Read attached file",
  risk: "read",
  mcp: false,
  description:
    "Read the extracted text of a file the user uploaded into this conversation (attachment_id from the <attachments> list). Long files are paged: pass `offset` (characters).",
  input: z.object({
    attachment_id: uuidArg("Attachment"),
    offset: z.number().int().min(0).optional(),
    max_chars: z.number().int().min(500).max(12000).optional().describe("Default 9000"),
  }),
  summarize: () => "讀取附加的檔案",
  async execute(a, ctx) {
    if (!isUuid(a.attachment_id)) throw notFound("找不到這個附加檔案。");
    const up = await ownUpload(ctx.db, ctx.user.id, a.attachment_id, ctx.conversationId);
    if (!up) throw notFound("找不到這個附加檔案。");
    const source = `上傳的檔案〈${up.filename}〉`;
    if (up.kind === "image") return { data: { file: up.filename, kind: "image", note: "這是圖片；內容已附在使用者的訊息中。" }, untrusted: true, source };
    const text = scrub(up.text_md ?? "");
    const offset = a.offset ?? 0;
    const max = a.max_chars ?? 9000;
    const chunk = text.slice(offset, offset + max);
    return {
      data: {
        file: clip(up.filename, 200),
        format: up.format,
        length: text.length,
        offset,
        text: chunk,
        ...(offset + chunk.length < text.length ? { next_offset: offset + chunk.length } : {}),
        ...(up.truncated ? { note: "原始檔案過長，擷取時已截斷。" } : {}),
      },
      untrusted: true,
      source,
      links: [{ label: up.filename, url: uploadUrl(up.id) }],
    };
  },
});
