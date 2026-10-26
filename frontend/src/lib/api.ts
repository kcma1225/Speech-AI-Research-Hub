import { t } from "./i18n.svelte.ts";

/**
 * Thin JSON client for the backend under /api. Errors carry the backend's 繁中 `error` message; responses
 * without one (nginx 429/502 pages, network failures as status 0) get a localised fallback instead.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The whole error body (`code`, `pending`, …). */
    readonly data: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown> | unknown[] | FormData | undefined;

async function request<T>(method: string, path: string, body?: Body): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, t("common.offline"));
  }
  const text = await response.text();
  let data: { error?: unknown } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (response.ok) throw new ApiError(response.status, t("common.error"));
  }
  if (!response.ok) {
    if (typeof data?.error === "string") throw new ApiError(response.status, data.error, data as Record<string, unknown>);
    throw new ApiError(response.status, t(response.status === 429 ? "common.rateLimited" : response.status >= 500 ? "common.offline" : "common.error"));
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: Body) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: Body) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: Body) => request<T>("PUT", path, body),
  del: <T>(path: string, body?: Body) => request<T>("DELETE", path, body),
};
