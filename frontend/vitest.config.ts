import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// Unit tests for pure frontend modules (editor commands, tables, text stats). `.svelte.ts` modules compile through
// the Svelte plugin; there is no DOM, so tests drive CodeMirror through EditorState only.
export default defineConfig({
  plugins: [svelte({ compilerOptions: { runes: true } })],
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
