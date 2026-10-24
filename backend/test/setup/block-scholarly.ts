/**
 * Global test setup (vitest `setupFiles`): tests never reach the real scholarly APIs (OpenAlex, Semantic Scholar, arXiv,
 * Crossref, Unpaywall, doi.org). A request to one of them throws, and because library code often catches network errors
 * (search returns [] on failure), the attempt is also recorded and fails the test in `afterEach` — loudly, with the URL.
 * Tests stub these services instead (`setTopicResearchDeps`, a local mock server, or their own `fetch` stub).
 */
import { afterEach } from "vitest";

export const BLOCKED_HOST_RE = /(^|\.)(openalex\.org|semanticscholar\.org|arxiv\.org|crossref\.org|unpaywall\.org|doi\.org)$/i;

const attempts: string[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // not an absolute URL: let fetch report it
  }
  if (host && BLOCKED_HOST_RE.test(host)) {
    attempts.push(url);
    throw new Error(`測試不可以連到真正的學術 API：${url}（請在測試中 stub 這個服務）`);
  }
  return realFetch(input, init);
}) as typeof fetch;

afterEach(() => {
  if (!attempts.length) return;
  const urls = attempts.splice(0);
  throw new Error(`這個測試試圖連到真正的學術 API（已被擋下）：\n${urls.join("\n")}`);
});
