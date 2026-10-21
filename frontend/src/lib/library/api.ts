import { t } from "#lib/i18n.svelte.ts";

/** JSON request that also returns error bodies (the 409 duplicate prompt carries candidates). */
export async function requestRaw<T = unknown>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string; code?: string } }> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined || body instanceof FormData ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, data: { error: t("common.offline") } as T & { error: string } };
  }
  let data: T & { error?: string };
  try {
    data = (await response.json()) as T & { error?: string };
  } catch {
    data = { error: t("common.error") } as T & { error: string };
  }
  return { ok: response.ok, status: response.status, data };
}

/** Copies text; returns false when the clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
