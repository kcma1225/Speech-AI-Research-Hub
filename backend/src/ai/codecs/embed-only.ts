/** Embedding-only codecs: Voyage, Jina, Hugging Face TEI. */
import { AiError } from "../errors.js";
import { joinUrl, send, sendJson, serverRoot, timedProbe } from "../providers/http.js";
import type { EmbedRequest, ModelInfo } from "../types.js";
import type { Codec, CodecContext } from "./codec.js";
import { applyEmbedTemplate, batchSize, chunk, decodeBase64Floats, finishVectors, num } from "./shared.js";

const staticList = (ctx: CodecContext): Promise<ModelInfo[]> => Promise.resolve((ctx.quirks.staticModels ?? []).map((id) => ({ id, kind: "embedding" as const })));

function mapDetailError(input: { status: number; body: unknown }): AiError | undefined {
  const detail = (input.body as Record<string, unknown>)?.detail;
  if (typeof detail === "string" && /too long|too many tokens|max.*tokens/i.test(detail)) return new AiError("context_too_long", { status: input.status, vendorMessage: detail });
  return undefined;
}

type Row = { embedding: number[] | string; index?: number };
function rows(json: Record<string, unknown>, n: number, providerId: string): number[][] {
  const data = (json.data ?? []) as Row[];
  if (!Array.isArray(data) || data.length !== n) throw new AiError("unavailable", { vendorMessage: "embedding count mismatch", providerId });
  return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => (typeof d.embedding === "string" ? decodeBase64Floats(d.embedding) : d.embedding));
}

async function embedProbe(codec: Codec, ctx: CodecContext, signal?: AbortSignal) {
  return timedProbe(async () => {
    const model = String(ctx.config.probeModel || ctx.config.defaultModel || ctx.quirks.probeModel || ctx.quirks.staticModels?.[0] || "");
    if (!model) throw new AiError("bad_request", { vendorMessage: "no probe model", providerId: ctx.entry.id });
    const r = await codec.embed!(ctx, { model, inputs: ["ping"], inputType: "query", signal });
    return { detail_zh: `連線成功，向量維度 ${r.dims}。` };
  });
}

// ---------------------------------------------------------------- Voyage

export const voyageCodec: Codec = {
  id: "voyage-embed",
  listModels: staticList,
  async embed(ctx, req: EmbedRequest) {
    const vectors: number[][] = [];
    let tokens = 0;
    for (const batch of chunk(req.inputs, batchSize(ctx, 128))) {
      const body: Record<string, unknown> = { model: req.model, input: batch, input_type: req.inputType, truncation: ctx.config.truncate !== false };
      if (req.dimensions) body.output_dimension = req.dimensions;
      const json = (await sendJson(ctx, { url: "/embeddings", body, signal: req.signal, timeoutMs: req.timeoutMs, mapError: mapDetailError })) as Record<string, unknown>;
      vectors.push(...rows(json, batch.length, ctx.entry.id));
      tokens += num((json.usage as Record<string, unknown>)?.total_tokens) ?? 0;
    }
    return finishVectors(ctx, vectors, req.model, tokens || undefined);
  },
  probe(ctx, signal) {
    return embedProbe(voyageCodec, ctx, signal);
  },
};

// ---------------------------------------------------------------- Jina

export const jinaCodec: Codec = {
  id: "jina-embed",
  listModels: staticList,
  async embed(ctx, req) {
    const vectors: number[][] = [];
    let tokens = 0;
    for (const batch of chunk(req.inputs, batchSize(ctx, 64))) {
      const body: Record<string, unknown> = {
        model: req.model,
        input: batch,
        task: req.inputType === "query" ? "retrieval.query" : "retrieval.passage",
        normalized: true,
        embedding_type: "float",
        truncate: ctx.config.truncate !== false,
      };
      if (req.dimensions) body.dimensions = req.dimensions;
      if (ctx.config.lateChunking === true) body.late_chunking = true;
      const json = (await sendJson(ctx, { url: "/embeddings", body, signal: req.signal, timeoutMs: req.timeoutMs, mapError: mapDetailError })) as Record<string, unknown>;
      vectors.push(...rows(json, batch.length, ctx.entry.id));
      tokens += num((json.usage as Record<string, unknown>)?.total_tokens) ?? num((json.usage as Record<string, unknown>)?.prompt_tokens) ?? 0;
    }
    return finishVectors(ctx, vectors, req.model, tokens || undefined);
  },
  probe(ctx, signal) {
    return embedProbe(jinaCodec, ctx, signal);
  },
};

// ---------------------------------------------------------------- TEI

async function teiInfo(ctx: CodecContext, signal?: AbortSignal) {
  return (await sendJson(ctx, { url: joinUrl(serverRoot(ctx.baseUrl), "/info"), signal })) as { model_id?: string; max_client_batch_size?: number; max_input_length?: number };
}

export const teiCodec: Codec = {
  id: "tei-embed",
  async listModels(ctx, signal) {
    const info = await teiInfo(ctx, signal);
    return info.model_id ? [{ id: info.model_id, kind: "embedding", contextWindow: info.max_input_length }] : [];
  },
  async embed(ctx, req) {
    const native = ctx.config.useNativeEndpoint !== false;
    const promptName = req.inputType === "query" ? ctx.config.queryPromptName : ctx.config.documentPromptName;
    // Server-side prompts (prompt_name) replace client templates when configured.
    const inputs = native && typeof promptName === "string" && promptName ? req.inputs : applyEmbedTemplate(ctx, req.inputs, req.inputType);
    const vectors: number[][] = [];
    const root = serverRoot(ctx.baseUrl);
    for (const batch of chunk(inputs, batchSize(ctx, 32))) {
      if (native) {
        const body: Record<string, unknown> = { inputs: batch, normalize: true, truncate: ctx.config.truncate !== false };
        if (typeof promptName === "string" && promptName) body.prompt_name = promptName;
        if (req.dimensions) body.dimensions = req.dimensions;
        const json = await sendJson(ctx, { url: joinUrl(root, "/embed"), body, signal: req.signal, timeoutMs: req.timeoutMs });
        if (!Array.isArray(json) || json.length !== batch.length) throw new AiError("unavailable", { vendorMessage: "embedding count mismatch", providerId: ctx.entry.id });
        vectors.push(...(json as number[][]));
      } else {
        const body: Record<string, unknown> = { model: req.model, input: batch, encoding_format: "float" };
        if (req.dimensions) body.dimensions = req.dimensions;
        const json = (await sendJson(ctx, { url: joinUrl(root, "/v1/embeddings"), body, signal: req.signal, timeoutMs: req.timeoutMs })) as Record<string, unknown>;
        vectors.push(...rows(json, batch.length, ctx.entry.id));
      }
    }
    return finishVectors(ctx, vectors, req.model);
  },
  probe(ctx, signal) {
    return timedProbe(async () => {
      const { call } = await send(ctx, { url: joinUrl(serverRoot(ctx.baseUrl), "/health"), signal, noAuth: true });
      call.done();
      const info = await teiInfo(ctx, signal);
      return { detail_zh: `連線成功，模型 ${info.model_id ?? "?"}。`, modelCount: info.model_id ? 1 : 0 };
    });
  },
};
