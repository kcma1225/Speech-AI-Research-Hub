import { ApiError } from "#lib/api.ts";
import { t } from "#lib/i18n.svelte.ts";
import type { Suggestion } from "#lib/components/suggest/types.ts";

export class AiStreamError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/**
 * POSTs to an AI action that answers with Server-Sent Events (`delta` {text}… then `suggestion` or `error`, then
 * `done`), e.g. `/notes/<id>/ai/rewrite`. Calls `onDelta` with each chunk; resolves with the created suggestion.
 * Errors before the stream starts are ordinary JSON errors (ApiError).
 */
export async function postAiStream(path: string, body: Record<string, unknown>, opts: { onDelta?: (text: string) => void; signal?: AbortSignal } = {}): Promise<Suggestion> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, t("common.offline"));
  }
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new ApiError(response.status, typeof data?.error === "string" ? data.error : t("common.error"));
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let suggestion: Suggestion | null = null;
  let failure: AiStreamError | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const raw = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !raw) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }
      if (event === "delta" && typeof data.text === "string") opts.onDelta?.(data.text);
      else if (event === "suggestion") suggestion = data.suggestion as Suggestion;
      else if (event === "error") failure = new AiStreamError(String(data.error ?? t("common.error")), data.code as string | undefined, data.hint as string | undefined);
    }
  }
  if (failure) throw failure;
  if (!suggestion) throw new AiStreamError(t("common.error"));
  return suggestion;
}
