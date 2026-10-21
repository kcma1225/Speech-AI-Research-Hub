/**
 * Simplified → Traditional conversion with opencc-js (MIT; dictionaries Apache-2.0).
 * `s2tw`: character-level Taiwan standard; `s2twp`: plus Taiwan phrases (软件 → 軟體).
 */
import { Converter } from "opencc-js/cn2t";
import type { ScriptConversion, Transcript } from "./types.js";

type Fn = (s: string) => string;
const cache = new Map<ScriptConversion, Fn>();

export function scriptConverter(mode: ScriptConversion): Fn {
  if (mode === "none") return (s) => s;
  let fn = cache.get(mode);
  if (!fn) {
    fn = Converter({ from: "cn", to: mode === "s2twp" ? "twp" : "tw" }) as Fn;
    cache.set(mode, fn);
  }
  return fn;
}

export function convertScript(text: string, mode: ScriptConversion): string {
  return scriptConverter(mode)(text);
}

/** Converts segment and word text in place; adds the `script_converted` warning when anything changed. */
export function convertTranscript(t: Transcript, mode: ScriptConversion): Transcript {
  t.source.scriptConversion = mode;
  if (mode === "none") return t;
  const fn = scriptConverter(mode);
  let changed = false;
  for (const s of t.segments) {
    const n = fn(s.text);
    if (n !== s.text) changed = true;
    s.text = n;
  }
  for (const w of t.words ?? []) w.text = fn(w.text);
  if (changed && !t.warnings.includes("script_converted")) t.warnings.push("script_converted");
  return t;
}
