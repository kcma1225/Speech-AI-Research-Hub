import { defineConfig } from "vitest/config";

export default defineConfig({
  // block-scholarly: no test may reach the real scholarly APIs (OpenAlex / S2 / arXiv / Crossref / Unpaywall / doi.org).
  test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup/block-scholarly.ts"], testTimeout: 90_000, hookTimeout: 60_000 },
});
