/**
 * New-project templates for the split-file convention (spec §13 item 14): `main.tex` holds the preamble
 * and the ordered `\input{sections/<name>}` list; each section/chapter is its own file under `sections/`.
 * All templates compile in `latex-runner` (verified by the e2e test).
 */
import type { LatexCompiler } from "./contract.js";
import { addInput, inputTarget } from "./inputs.js";

export type LatexTemplateId = "zh-thesis" | "ieee-conference" | "article-zh" | "article-en";
export type LatexBibTool = "biber" | "bibtex";

export type LatexTemplateInfo = {
  id: LatexTemplateId;
  name_zh: string;
  name_en: string;
  description_zh: string;
  description_en: string;
  compiler: LatexCompiler;
  bibTool: LatexBibTool;
  /** `\chapter` for book classes, `\section` otherwise; used for new section files. */
  sectionCommand: "chapter" | "section";
};

export const LATEX_TEMPLATES: readonly LatexTemplateInfo[] = [
  {
    id: "zh-thesis",
    name_zh: "中文碩士論文",
    name_en: "Chinese master's thesis",
    description_zh: "ctexbook + XeLaTeX，思源宋體（Noto Serif CJK TC），biblatex/biber 參考文獻，中英文摘要與章節分檔。",
    description_en: "ctexbook + XeLaTeX, Noto Serif CJK TC, biblatex/biber references, Chinese and English abstracts, one file per chapter.",
    compiler: "xelatex",
    bibTool: "biber",
    sectionCommand: "chapter",
  },
  {
    id: "ieee-conference",
    name_zh: "IEEE 會議論文（ICASSP / Interspeech 類）",
    name_en: "IEEE conference paper (ICASSP / Interspeech style)",
    description_zh: "IEEEtran 雙欄會議格式 + pdfLaTeX，BibTeX（IEEEtran.bst）。投稿時可上傳官方 spconf.sty / Interspeech.cls 替換。",
    description_en: "IEEEtran two-column conference format + pdfLaTeX, BibTeX (IEEEtran.bst). Upload the official spconf.sty / Interspeech.cls to switch when submitting.",
    compiler: "pdflatex",
    bibTool: "bibtex",
    sectionCommand: "section",
  },
  {
    id: "article-zh",
    name_zh: "一般中文文章",
    name_en: "Article (Chinese)",
    description_zh: "ctexart + XeLaTeX，biblatex/biber。適合報告、筆記、短文。",
    description_en: "ctexart + XeLaTeX, biblatex/biber. For reports, notes and short articles.",
    compiler: "xelatex",
    bibTool: "biber",
    sectionCommand: "section",
  },
  {
    id: "article-en",
    name_zh: "一般英文文章",
    name_en: "Article (English)",
    description_zh: "article + pdfLaTeX，natbib/BibTeX。",
    description_en: "article + pdfLaTeX, natbib/BibTeX.",
    compiler: "pdflatex",
    bibTool: "bibtex",
    sectionCommand: "section",
  },
];

export type LatexTemplateFile = { path: string; content: string };
export type LatexTemplateProject = {
  template: LatexTemplateId;
  compiler: LatexCompiler;
  bibTool: LatexBibTool;
  rootFile: "main.tex";
  files: LatexTemplateFile[];
  /** Section file paths in `\input` order. */
  sections: string[];
};

export type LatexTemplateOptions = { title?: string; author?: string; advisor?: string; institution?: string };

export function templateInfo(id: LatexTemplateId): LatexTemplateInfo {
  const info = LATEX_TEMPLATES.find(template => template.id === id);
  if (!info) throw new Error(`unknown LaTeX template: ${id}`);
  return info;
}

/** Escapes LaTeX special characters in user text (titles, names). */
export function escapeLatex(text: string): string {
  return text.replace(/[\\{}$&#^_%~]/g, ch => {
    switch (ch) {
      case "\\": return "\\textbackslash{}";
      case "^": return "\\textasciicircum{}";
      case "~": return "\\textasciitilde{}";
      default: return "\\" + ch;
    }
  }).replace(/[\r\n]+/g, " ");
}

const SECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** `intro` → `sections/intro.tex`. Names are ASCII so every engine (pdfLaTeX too) can \input them. */
export function sectionPath(name: string): string {
  if (!SECTION_NAME.test(name)) throw new Error("章節檔名只能使用英數字、- 與 _，且以英數字開頭（最多 64 字）。");
  return `sections/${name}.tex`;
}

/** Suggests a free section name (`section-2`, …) when the user gives only a title. */
export function nextSectionName(existing: string[], base = "section"): string {
  const taken = new Set(existing.map(path => path.replace(/^sections\//, "").replace(/\.tex$/, "")));
  for (let i = 1; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Contents of a new section file: a heading and a label derived from the file name. */
export function newSectionContent(command: "chapter" | "section", title: string, name: string): string {
  const prefix = command === "chapter" ? "chap" : "sec";
  return `\\${command}{${escapeLatex(title)}}\\label{${prefix}:${name}}\n\n`;
}

/**
 * Adds a section to a project: returns the new file and the updated `main.tex` (input inserted after
 * `after`, or after the last section).
 */
export function addSection(main: string, options: { name: string; title: string; command: "chapter" | "section"; after?: string }) {
  const path = sectionPath(options.name);
  return {
    file: { path, content: newSectionContent(options.command, options.title, options.name) },
    main: addInput(main, path, { after: options.after }),
  };
}

export function generateTemplate(id: LatexTemplateId, options: LatexTemplateOptions = {}): LatexTemplateProject {
  const info = templateInfo(id);
  const built = BUILDERS[id](options);
  return {
    template: id,
    compiler: info.compiler,
    bibTool: info.bibTool,
    rootFile: "main.tex",
    files: [{ path: "main.tex", content: built.main }, ...built.sections.map(([path, content]) => ({ path, content })), { path: "refs.bib", content: REFS_BIB }],
    sections: built.sections.map(([path]) => path),
  };
}

type Built = { main: string; sections: [string, string][] };

function inputs(paths: string[], indent = ""): string {
  return paths.map(path => `${indent}\\input{${inputTarget(path)}}`).join("\n");
}

const REFS_BIB = `% 參考文獻資料庫。研究的文獻庫可自動產生此檔。
@inproceedings{vaswani2017attention,
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  title     = {Attention Is All You Need},
  booktitle = {Advances in Neural Information Processing Systems},
  volume    = {30},
  year      = {2017}
}

@inproceedings{baevski2020wav2vec,
  author    = {Baevski, Alexei and Zhou, Yuhao and Mohamed, Abdelrahman and Auli, Michael},
  title     = {wav2vec 2.0: A Framework for Self-Supervised Learning of Speech Representations},
  booktitle = {Advances in Neural Information Processing Systems},
  volume    = {33},
  pages     = {12449--12460},
  year      = {2020}
}

@inproceedings{radford2023whisper,
  author    = {Radford, Alec and Kim, Jong Wook and Xu, Tao and Brockman, Greg and McLeavey, Christine and Sutskever, Ilya},
  title     = {Robust Speech Recognition via Large-Scale Weak Supervision},
  booktitle = {Proceedings of the 40th International Conference on Machine Learning},
  pages     = {28492--28518},
  year      = {2023}
}
`;

const ZH_FONTS = `% 中文字型：思源宋體／黑體（Noto CJK TC，編譯環境已內建）
\\setCJKmainfont{Noto Serif CJK TC}
\\setCJKsansfont{Noto Sans CJK TC}
\\setCJKmonofont{Noto Sans Mono CJK TC}`;

/** ctexbook has a `bibname` key; the bibliography title of articles comes from \\printbibliography[title=…]. */
const zhNames = (kind: "book" | "article") => `% 繁體中文標題名稱（ctex 預設為簡體）
\\ctexset{
  contentsname = {目錄},
  listfigurename = {圖目錄},
  listtablename = {表目錄},
  figurename = {圖},
  tablename = {表},
  abstractname = {摘要},
  appendixname = {附錄},
${kind === "book" ? "  bibname = {參考文獻},\n" : ""}}`;

const BUILDERS: Record<LatexTemplateId, (options: LatexTemplateOptions) => Built> = {
  "zh-thesis": options => {
    const title = escapeLatex(options.title ?? "論文題目");
    const author = escapeLatex(options.author ?? "研究生姓名");
    const advisor = escapeLatex(options.advisor ?? "指導教授姓名");
    const institution = escapeLatex(options.institution ?? "（學校名稱）（系所名稱）");
    const front = ["sections/abstract-zh.tex", "sections/abstract-en.tex"];
    const chapters = ["sections/introduction.tex", "sections/related-work.tex", "sections/method.tex", "sections/experiments.tex", "sections/conclusion.tex"];
    const main = `% !TEX program = xelatex
% 主檔（索引）：前言與套件設定，以及各章節分檔的 \\input 清單。
% 編輯器的每個分頁對應一個章節檔；新增章節會自動在清單加入一行 \\input，拖曳分頁會調整順序。
\\documentclass[a4paper,12pt,oneside,fontset=none,zihao=-4]{ctexbook}

${ZH_FONTS}
\\setmainfont{TeX Gyre Termes}

${zhNames("book")}
\\ctexset{chapter = {name = {第,章}, number = \\chinese{chapter}}}

\\usepackage[margin=2.5cm]{geometry}
\\usepackage{setspace}
\\setstretch{1.5}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\graphicspath{{figures/}}
\\usepackage{booktabs}
\\usepackage{siunitx}
\\usepackage{tikz}
\\usepackage{algorithm}
\\usepackage{algpseudocode}
\\floatname{algorithm}{演算法}
\\usepackage[backend=biber,style=ieee]{biblatex}
\\addbibresource{refs.bib}
\\usepackage[hidelinks]{hyperref}
\\usepackage[nameinlink]{cleveref}
\\crefname{chapter}{第}{第}
\\creflabelformat{chapter}{#2#1#3 章}
\\crefname{figure}{圖}{圖}
\\crefname{table}{表}{表}
\\crefname{equation}{式}{式}
\\crefname{algorithm}{演算法}{演算法}

\\newcommand{\\thesistitle}{${title}}
\\newcommand{\\thesisauthor}{${author}}
\\newcommand{\\thesisadvisor}{${advisor}}
\\newcommand{\\thesisinstitution}{${institution}}

\\begin{document}

\\frontmatter
\\begin{titlepage}
  \\centering
  \\vspace*{2cm}
  {\\Large \\thesisinstitution\\par}
  \\vspace{1cm}
  {\\Large 碩士論文\\par}
  \\vspace{2cm}
  {\\huge\\bfseries \\thesistitle\\par}
  \\vspace{3cm}
  {\\large 研究生：\\thesisauthor\\par}
  \\vspace{0.5cm}
  {\\large 指導教授：\\thesisadvisor\\par}
  \\vfill
  {\\large \\today\\par}
\\end{titlepage}

${inputs(front)}

\\tableofcontents
\\listoffigures
\\listoftables

\\mainmatter
${inputs(chapters)}

\\backmatter
\\printbibliography[title={參考文獻}, heading=bibintoc]

\\end{document}
`;
    return {
      main,
      sections: [
        ["sections/abstract-zh.tex", `\\chapter*{摘要}\n\\addcontentsline{toc}{chapter}{摘要}\n\n在此撰寫中文摘要。\n\n\\noindent\\textbf{關鍵字：}語音辨識、自監督學習\n`],
        ["sections/abstract-en.tex", `\\chapter*{Abstract}\n\\addcontentsline{toc}{chapter}{Abstract}\n\nWrite the English abstract here.\n\n\\noindent\\textbf{Keywords:} speech recognition, self-supervised learning\n`],
        ["sections/introduction.tex", `\\chapter{緒論}\\label{chap:introduction}\n\n\\section{研究背景與動機}\n近年來，自監督學習大幅提升了語音辨識的表現\\cite{baevski2020wav2vec,radford2023whisper}。\n\n\\section{論文架構}\n本論文第~\\ref{chap:method}~章說明研究方法，第~\\ref{chap:experiments}~章呈現實驗結果。\n`],
        ["sections/related-work.tex", `\\chapter{文獻探討}\\label{chap:related-work}\n\nTransformer 架構\\cite{vaswani2017attention}已成為語音模型的主流。\n`],
        ["sections/method.tex", `\\chapter{研究方法}\\label{chap:method}\n\n\\section{模型架構}\n模型的訓練目標如\\cref{eq:loss}所示：\n\\begin{equation}\n  \\mathcal{L} = -\\sum_{t=1}^{T} \\log p(y_t \\mid x)\n  \\label{eq:loss}\n\\end{equation}\n\n\\begin{figure}[htbp]\n  \\centering\n  \\begin{tikzpicture}\n    \\draw[thick,->] (0,0) -- (3,0) node[right] {時間};\n    \\draw[thick,->] (0,0) -- (0,2) node[above] {振幅};\n    \\draw[domain=0:3,smooth,variable=\\x] plot ({\\x},{1+0.8*sin(200*\\x)});\n  \\end{tikzpicture}\n  \\caption{語音波形示意圖}\\label{fig:waveform}\n\\end{figure}\n\n\\begin{algorithm}[htbp]\n  \\caption{訓練流程}\\label{alg:train}\n  \\begin{algorithmic}[1]\n    \\For{每個訓練批次}\n      \\State 計算損失 $\\mathcal{L}$\n      \\State 更新模型參數\n    \\EndFor\n  \\end{algorithmic}\n\\end{algorithm}\n`],
        ["sections/experiments.tex", `\\chapter{實驗結果}\\label{chap:experiments}\n\n\\Cref{tab:results}列出各模型的字錯誤率。\n\n\\begin{table}[htbp]\n  \\centering\n  \\caption{各模型的字錯誤率}\\label{tab:results}\n  \\begin{tabular}{lS[table-format=2.1]}\n    \\toprule\n    模型 & {CER (\\%)} \\\\\n    \\midrule\n    基準模型 & 12.3 \\\\\n    本研究方法 & 9.8 \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n`],
        ["sections/conclusion.tex", `\\chapter{結論與未來工作}\\label{chap:conclusion}\n\n在此總結研究成果與未來方向。\n`],
      ],
    };
  },

  "ieee-conference": options => {
    const title = escapeLatex(options.title ?? "Paper Title");
    const author = escapeLatex(options.author ?? "Author Name");
    const institution = escapeLatex(options.institution ?? "Department, University");
    const sections = ["sections/abstract.tex", "sections/introduction.tex", "sections/related-work.tex", "sections/method.tex", "sections/experiments.tex", "sections/conclusion.tex"];
    const main = `% !TEX program = pdflatex
% 主檔（索引）：前言與套件設定，以及各節分檔的 \\input 清單。
% IEEE 雙欄會議格式。投稿 ICASSP 或 Interspeech 時，請上傳官方的 spconf.sty 或 Interspeech.cls，
% 並依官方範本修改 \\documentclass 與作者區塊；各節分檔不需要變動。
\\documentclass[conference]{IEEEtran}

\\usepackage[T1]{fontenc}
\\usepackage{cite}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\graphicspath{{figures/}}
\\usepackage{booktabs}
\\usepackage{siunitx}
\\usepackage{tikz}
\\usepackage{pgfplots}
\\pgfplotsset{compat=1.18}
\\usepackage{algorithm}
\\usepackage{algpseudocode}
\\usepackage{xcolor}
\\usepackage[hidelinks]{hyperref}
\\usepackage[capitalise]{cleveref}

\\begin{document}

\\title{${title}}
\\author{\\IEEEauthorblockN{${author}}
\\IEEEauthorblockA{${institution}}}
\\maketitle

${inputs(sections)}

\\bibliographystyle{IEEEtran}
\\bibliography{refs}

\\end{document}
`;
    return {
      main,
      sections: [
        ["sections/abstract.tex", `\\begin{abstract}\nWrite a 150--200 word abstract here.\n\\end{abstract}\n\n\\begin{IEEEkeywords}\nspeech recognition, self-supervised learning\n\\end{IEEEkeywords}\n`],
        ["sections/introduction.tex", `\\section{Introduction}\\label{sec:introduction}\n\nSelf-supervised models~\\cite{baevski2020wav2vec} and large weakly supervised models~\\cite{radford2023whisper} have changed speech recognition.\n`],
        ["sections/related-work.tex", `\\section{Related Work}\\label{sec:related-work}\n\nThe Transformer~\\cite{vaswani2017attention} is the dominant architecture.\n`],
        ["sections/method.tex", `\\section{Method}\\label{sec:method}\n\nWe minimise the loss in \\cref{eq:loss}:\n\\begin{equation}\n  \\mathcal{L} = -\\sum_{t=1}^{T} \\log p(y_t \\mid x).\n  \\label{eq:loss}\n\\end{equation}\n\n\\begin{algorithm}[t]\n  \\caption{Training loop}\\label{alg:train}\n  \\begin{algorithmic}[1]\n    \\For{each batch}\n      \\State compute $\\mathcal{L}$ and update the parameters\n    \\EndFor\n  \\end{algorithmic}\n\\end{algorithm}\n`],
        ["sections/experiments.tex", `\\section{Experiments}\\label{sec:experiments}\n\n\\Cref{tab:results} and \\cref{fig:curve} summarise the results.\n\n\\begin{table}[t]\n  \\centering\n  \\caption{Word error rate (\\%)}\\label{tab:results}\n  \\begin{tabular}{lS[table-format=2.1]}\n    \\toprule\n    System & {WER} \\\\\n    \\midrule\n    Baseline & 12.3 \\\\\n    Proposed & 9.8 \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n\n\\begin{figure}[t]\n  \\centering\n  \\begin{tikzpicture}\n    \\begin{axis}[width=0.9\\columnwidth, height=4cm, xlabel={Epoch}, ylabel={WER (\\%)}]\n      \\addplot coordinates {(1,20) (2,15) (3,12) (4,10.5) (5,9.8)};\n    \\end{axis}\n  \\end{tikzpicture}\n  \\caption{Validation WER during training.}\\label{fig:curve}\n\\end{figure}\n`],
        ["sections/conclusion.tex", `\\section{Conclusion}\\label{sec:conclusion}\n\nSummarise the contributions here.\n`],
      ],
    };
  },

  "article-zh": options => {
    const title = escapeLatex(options.title ?? "文章標題");
    const author = escapeLatex(options.author ?? "作者");
    const sections = ["sections/introduction.tex", "sections/method.tex", "sections/conclusion.tex"];
    const main = `% !TEX program = xelatex
% 主檔（索引）：前言與套件設定，以及各節分檔的 \\input 清單。
\\documentclass[a4paper,11pt,fontset=none]{ctexart}

${ZH_FONTS}

${zhNames("article")}

\\usepackage[margin=2.5cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\graphicspath{{figures/}}
\\usepackage{booktabs}
\\usepackage[backend=biber,style=ieee]{biblatex}
\\addbibresource{refs.bib}
\\usepackage[hidelinks]{hyperref}
\\usepackage{cleveref}

\\title{${title}}
\\author{${author}}
\\date{\\today}

\\begin{document}
\\maketitle

${inputs(sections)}

\\printbibliography[title={參考文獻}]

\\end{document}
`;
    return {
      main,
      sections: [
        ["sections/introduction.tex", `\\section{前言}\\label{sec:introduction}\n\n在此說明研究背景\\cite{vaswani2017attention}。\n`],
        ["sections/method.tex", `\\section{方法}\\label{sec:method}\n\n說明方法與實驗設定\\cite{baevski2020wav2vec}。\n`],
        ["sections/conclusion.tex", `\\section{結論}\\label{sec:conclusion}\n\n總結。\n`],
      ],
    };
  },

  "article-en": options => {
    const title = escapeLatex(options.title ?? "Article Title");
    const author = escapeLatex(options.author ?? "Author");
    const sections = ["sections/introduction.tex", "sections/method.tex", "sections/conclusion.tex"];
    const main = `% !TEX program = pdflatex
% Index file: preamble, packages and the ordered \\input list of section files.
\\documentclass[11pt]{article}

\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\graphicspath{{figures/}}
\\usepackage{booktabs}
\\usepackage[numbers]{natbib}
\\usepackage[hidelinks]{hyperref}
\\usepackage{cleveref}

\\title{${title}}
\\author{${author}}
\\date{\\today}

\\begin{document}
\\maketitle

${inputs(sections)}

\\bibliographystyle{plainnat}
\\bibliography{refs}

\\end{document}
`;
    return {
      main,
      sections: [
        ["sections/introduction.tex", `\\section{Introduction}\\label{sec:introduction}\n\nBackground~\\cite{vaswani2017attention}.\n`],
        ["sections/method.tex", `\\section{Method}\\label{sec:method}\n\nMethod~\\cite{baevski2020wav2vec}.\n`],
        ["sections/conclusion.tex", `\\section{Conclusion}\\label{sec:conclusion}\n\nConclusion.\n`],
      ],
    };
  },
};
