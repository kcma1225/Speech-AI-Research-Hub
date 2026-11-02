/**
 * Will a LaTeX file still compile? Deterministic structure checks run before an AI edit is suggested (or, under
 * autopilot, applied): braces balanced, every \begin{env} closed by its \end{env} in order. Only problems the edit
 * introduces count (the class of production 61666f10, where an AI deck edit broke the build after it was accepted).
 */

/** Comments and escaped braces removed (`\%` is a percent sign, `\{` a literal brace); verbatim bodies dropped. */
function code(text: string): string {
  return text
    .replace(/\\begin\{(verbatim|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g, " ")
    .replace(/\\verb(.)[^\n]*?\1/g, " ")
    .replace(/(?<!\\)%.*$/gm, "")
    .replace(/\\[{}]/g, "");
}

export function latexProblems(path: string, text: string): string[] {
  if (!/\.(?:tex|bib|sty|cls)$/i.test(path)) return [];
  const src = code(text.replace(/\r\n/g, "\n"));
  const out: string[] = [];
  let depth = 0;
  let line = 1;
  let firstExtra = 0;
  for (const ch of src) {
    if (ch === "\n") line++;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0 && !firstExtra) firstExtra = line;
      if (depth < 0) depth = 0;
    }
  }
  if (firstExtra) out.push(`第 ${firstExtra} 行附近多了一個 }`);
  if (depth > 0) out.push(`有 ${depth} 個 { 沒有關閉`);
  if (/\.tex$/i.test(path)) {
    const stack: string[] = [];
    for (const m of src.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
      const env = m[2]!.trim();
      if (m[1] === "begin") stack.push(env);
      else if (stack.at(-1) === env) stack.pop();
      else {
        out.push(stack.length ? `\\end{${env}} 對不上 \\begin{${stack.at(-1)}}` : `\\end{${env}} 沒有對應的 \\begin`);
        const i = stack.lastIndexOf(env);
        if (i >= 0) stack.splice(i);
      }
    }
    for (const env of stack) out.push(`\\begin{${env}} 沒有 \\end{${env}}`);
  }
  return out;
}

const key = (p: string) => p.replace(/第 \d+ 行附近/g, "").replace(/有 \d+ 個/, "有 N 個").trim();

/** Problems `after` has that `before` did not. */
export function newLatexProblems(path: string, before: string, after: string): string[] {
  const had = latexProblems(path, before);
  const now = latexProblems(path, after);
  // More unclosed braces than before is new even when the message kind existed.
  const depthOf = (ps: string[]) => Number(/有 (\d+) 個 \{/.exec(ps.join(" "))?.[1] ?? 0);
  const out = now.filter((p) => !had.map(key).includes(key(p)));
  if (depthOf(now) > depthOf(had) && !out.some((p) => p.includes("沒有關閉"))) out.push(`多了 ${depthOf(now) - depthOf(had)} 個沒有關閉的 {`);
  return out;
}
