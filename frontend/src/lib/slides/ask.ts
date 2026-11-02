import { ApiError } from "#lib/api.ts";
import { t } from "#lib/i18n.svelte.ts";

/**
 * 「提問助手」 request (`POST /api/slides/:id/ask`, Server-Sent Events): with `gate` the server first decides whether
 * `heard` is a question for the presenter — `skip` ends it without an answer, `question` says one is coming — then
 * `delta` {text}… `error` {error} `done`. Resolves with the answer text, or null when it was skipped.
 */
export async function askDeck(
  deckId: string,
  body: { heard: string; transcript: string; page: number | null; gate: boolean },
  opts: { onQuestion?: () => void; onDelta?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`/api/slides/${encodeURIComponent(deckId)}/ask`, {
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
  let text = "";
  let skipped = false;
  let failure: string | null = null;
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
      if (event === "skip") skipped = true;
      else if (event === "question") opts.onQuestion?.();
      else if (event === "delta" && typeof data.text === "string") {
        text += data.text;
        opts.onDelta?.(data.text);
      } else if (event === "error") failure = String(data.error ?? t("common.error"));
    }
  }
  if (failure) throw new ApiError(502, failure);
  return skipped ? null : text;
}
