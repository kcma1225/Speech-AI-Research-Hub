import { autocompletion, snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { Symbols } from "./types.ts";

/**
 * LaTeX editing support for CodeMirror: highlighting from the MIT `stex` legacy mode (never codemirror-lang-latex
 * ≥ 0.5, which is AGPL), and completion of common commands/environments, `\cite{}` keys (study library + .bib files),
 * `\ref{}` labels across every file and `\input`/`\includegraphics` paths.
 */
export const latexLanguage = StreamLanguage.define(stex);

/** BibTeX: no MIT mode worth shipping; the stex tokenizer still marks `@entry`, braces and `%` comments. */
export const bibLanguage = latexLanguage;

const COMMANDS: [string, string?][] = [
  ["section{${}}", "章節"], ["subsection{${}}"], ["subsubsection{${}}"], ["chapter{${}}", "章"], ["paragraph{${}}"],
  ["label{${}}"], ["ref{${}}"], ["eqref{${}}"], ["cref{${}}"], ["Cref{${}}"], ["autoref{${}}"], ["pageref{${}}"],
  ["cite{${}}", "引用"], ["citep{${}}"], ["citet{${}}"], ["parencite{${}}"], ["textcite{${}}"], ["autocite{${}}"],
  ["textbf{${}}", "粗體"], ["textit{${}}", "斜體"], ["emph{${}}"], ["underline{${}}"], ["texttt{${}}"], ["textsc{${}}"], ["footnote{${}}", "註腳"],
  ["url{${}}"], ["href{${url}}{${text}}"], ["includegraphics[width=\\linewidth]{${}}", "插入圖片"], ["caption{${}}"], ["centering"],
  ["input{${}}"], ["include{${}}"], ["item"], ["frac{${}}{${}}"], ["sqrt{${}}"], ["sum_{${}}^{${}}"], ["int_{${}}^{${}}"], ["mathbf{${}}"], ["mathcal{${}}"],
  ["mathrm{${}}"], ["text{${}}"], ["left("], ["right)"], ["alpha"], ["beta"], ["gamma"], ["delta"], ["epsilon"], ["theta"], ["lambda"], ["mu"], ["sigma"],
  ["log"], ["exp"], ["cdot"], ["times"], ["leq"], ["geq"], ["approx"], ["infty"], ["hline"], ["toprule"], ["midrule"], ["bottomrule"], ["multicolumn{${}}{${}}{${}}"],
  ["newcommand{\\${name}}{${}}"], ["usepackage{${}}"], ["vspace{${}}"], ["hspace{${}}"], ["clearpage"], ["newpage"], ["noindent"], ["today"],
  ["tableofcontents"], ["maketitle"], ["appendix"], ["printbibliography"], ["bibliography{${}}"], ["bibliographystyle{${}}"], ["SI{${}}{${}}"], ["num{${}}"],
];
const ENVIRONMENTS: [string, string?][] = [
  ["figure", "圖"], ["table", "表"], ["equation", "方程式"], ["align"], ["itemize", "項目清單"], ["enumerate", "編號清單"], ["description"],
  ["tabular"], ["abstract", "摘要"], ["algorithm"], ["algorithmic"], ["center"], ["minipage"], ["quote"], ["verbatim"], ["theorem"], ["proof"],
  ["subfigure"], ["gather"], ["cases"], ["matrix"], ["bmatrix"], ["tikzpicture"], ["axis"], ["frame"], ["thebibliography"],
];

const ENV_BODY: Record<string, string> = {
  figure: "[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${file}}\n  \\caption{${caption}}\\label{fig:${label}}\n",
  table: "[htbp]\n  \\centering\n  \\caption{${caption}}\\label{tab:${label}}\n  \\begin{tabular}{${ll}}\n    \\toprule\n    ${} \\\\\n    \\bottomrule\n  \\end{tabular}\n",
  equation: "\n  ${}\n  \\label{eq:${label}}\n",
  itemize: "\n  \\item ${}\n",
  enumerate: "\n  \\item ${}\n",
  tabular: "{${ll}}\n  ${}\n",
};

const commandCompletions: Completion[] = COMMANDS.map(([body, detail]) => {
  const label = `\\${body.replace(/[[{].*$/, "")}`;
  return snippetCompletion(`\\${body.replace(/\\/g, "\\")}`, { label, detail, type: "keyword", boost: detail ? 2 : 0 });
});

function environmentCompletions(withBegin: boolean): Completion[] {
  return ENVIRONMENTS.map(([env, detail]) => {
    const body = ENV_BODY[env] ?? "\n  ${}\n";
    return snippetCompletion(`${withBegin ? "\\begin{" : ""}${env}}${body}\\end{${env}}`, { label: withBegin ? `\\begin{${env}}` : env, detail, type: "type", boost: detail ? 2 : 0 });
  });
}
const envAfterBegin = environmentCompletions(false);
const envWithBegin = environmentCompletions(true);

const CITE = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/;
const REF = /\\(?:ref|eqref|cref|Cref|autoref|pageref|nameref|vref)\*?\{([^}]*)$/;
const INPUT = /\\(?:input|include|subfile)\{([^}]*)$/;
const GRAPHICS = /\\includegraphics\*?(?:\[[^\]]*\])?\{([^}]*)$/;
const BEGIN = /\\begin\{([A-Za-z*]*)$/;

/** Completion over the current project's symbols (`getSymbols` is read on every request, so updates apply live). */
export function latexCompletion(getSymbols: () => Symbols | null): Extension {
  const source = (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const symbols = getSymbols();
    const argStart = (match: RegExpExecArray) => {
      const arg = match[1]!;
      const lastComma = arg.lastIndexOf(",");
      return context.pos - (arg.length - lastComma - 1) + (arg.slice(lastComma + 1).match(/^\s*/)?.[0].length ?? 0);
    };
    let m = CITE.exec(before);
    if (m) {
      return {
        from: argStart(m),
        options: (symbols?.citations ?? []).map((c) => ({ label: c.key, detail: c.year ? String(c.year) : undefined, info: [c.title, c.authors].filter(Boolean).join(" · ") || undefined, type: "text" })),
        validFor: /^[^,}\s]*$/,
      };
    }
    if ((m = REF.exec(before))) {
      return { from: argStart(m), options: (symbols?.labels ?? []).map((l) => ({ label: l.key, detail: `${l.path}:${l.line}`, type: "variable" })), validFor: /^[^,}\s]*$/ };
    }
    if ((m = INPUT.exec(before))) {
      const files = (symbols?.files ?? []).filter((f) => /\.tex$/i.test(f.path)).map((f) => ({ label: f.path.replace(/\.tex$/i, ""), type: "namespace" }));
      return { from: context.pos - m[1]!.length, options: files, validFor: /^[^}]*$/ };
    }
    if ((m = GRAPHICS.exec(before))) {
      const files = (symbols?.files ?? []).filter((f) => /\.(png|jpe?g|pdf|eps|svg)$/i.test(f.path)).map((f) => ({ label: f.path.replace(/^figures\//, ""), detail: f.path, type: "namespace" }));
      return { from: context.pos - m[1]!.length, options: files, validFor: /^[^}]*$/ };
    }
    if ((m = BEGIN.exec(before))) return { from: context.pos - m[1]!.length, options: envAfterBegin, validFor: /^[A-Za-z*]*$/ };
    const word = context.matchBefore(/\\[A-Za-z]*$/);
    if (word && (word.from !== word.to || context.explicit)) return { from: word.from, options: [...commandCompletions, ...envWithBegin], validFor: /^\\[A-Za-z]*$/ };
    return null;
  };
  return [autocompletion({ override: [source], activateOnTyping: true, maxRenderedOptions: 80 }), keymap.of([])];
}
