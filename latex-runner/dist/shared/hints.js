/** Ordered: the first matching pattern wins, so specific entries come before generic ones. */
export const LATEX_HINTS = [
    {
        code: "undefined-control-sequence",
        pattern: /Undefined control sequence/,
        title_zh: "未定義的指令",
        hint_zh: "這一行用到的指令（錯誤內容最後一個 \\ 開頭的字）不存在。常見原因：拼錯字、忘了在前言 \\usepackage 對應的套件，或把只在某套件才有的指令用在沒載入它的文件裡。",
    },
    {
        code: "missing-dollar",
        pattern: /Missing \$ inserted/,
        title_zh: "缺少數學模式符號 $",
        hint_zh: "數學專用的符號（_、^、\\alpha、\\sum 等）只能放在數學模式裡。請用 $...$ 或 \\( ... \\) 包起來；若是要印出底線字元本身，請寫 \\_。也可能是上一個 $ 沒有成對關閉。",
    },
    {
        code: "file-not-found",
        pattern: /File [`'"]?([^'`"]+)['`"]? not found|I can't find file|cannot find image file|Cannot find file/i,
        title_zh: "找不到檔案",
        hint_zh: "編譯時找不到這個檔案。請確認：檔名與大小寫完全一致（Linux 區分大小寫）、路徑以專案根目錄為準、檔案已上傳到專案。若是 .sty/.cls，代表編譯環境沒有這個套件，請把它上傳到專案中。",
    },
    {
        code: "unicode-not-setup",
        pattern: /Unicode character .* not set up for use with LaTeX|Invalid UTF-8 byte/,
        title_zh: "pdfLaTeX 無法處理這個字元",
        hint_zh: "pdfLaTeX 不支援中文等 Unicode 字元。含中文的文件請在專案設定把編譯器改成 XeLaTeX（並使用 ctex 或 xeCJK），或把該字元改成對應的 LaTeX 指令。",
    },
    {
        code: "font-not-found",
        pattern: /The font "?([^"]+)"? cannot be found|font-not-found|Font .* not loadable|Metric \(TFM\) file .* not found/,
        title_zh: "找不到字型",
        hint_zh: "指定的字型不在編譯環境中。中文請使用 Noto Serif CJK TC / Noto Sans CJK TC（或 ctex 的 fontset=fandol）。字型名稱要完全一致，或把字型檔上傳到專案並以檔名載入。",
    },
    {
        code: "environment-undefined",
        pattern: /Environment (\S+) undefined/,
        title_zh: "未定義的環境",
        hint_zh: "\\begin{...} 裡的環境名稱不存在。請檢查拼字，或在前言載入提供這個環境的套件（例如 align 需要 amsmath、algorithm 需要 algorithm 套件）。",
    },
    {
        code: "begin-end-mismatch",
        pattern: /\\begin\{([^}]*)\} on input line \d+ ended by \\end\{([^}]*)\}|ended by \\end/,
        title_zh: "\\begin 與 \\end 不成對",
        hint_zh: "某個 \\begin{環境} 沒有用同名的 \\end{環境} 關閉，或關閉順序交錯了。請從錯誤行往上找最近的 \\begin，確認名稱與巢狀順序。",
    },
    {
        code: "missing-begin-document",
        pattern: /Missing \\begin\{document\}/,
        title_zh: "缺少 \\begin{document}",
        hint_zh: "在 \\begin{document} 之前出現了要排版的文字。可能是前言裡有多餘字元、某個分檔被放到前言，或 \\documentclass 那行有打錯字。",
    },
    {
        code: "preamble-only",
        pattern: /Can be used only in preamble/,
        title_zh: "只能用在前言的指令",
        hint_zh: "\\usepackage 等指令只能放在 \\documentclass 與 \\begin{document} 之間。請把它移到 main.tex 的前言，分檔（章節檔）裡不要載入套件。",
    },
    {
        code: "option-clash",
        pattern: /Option clash for package (\S+)/,
        title_zh: "套件選項衝突",
        hint_zh: "同一個套件被載入兩次但選項不同（常見是文件類別或其他套件已經載入過）。請只載入一次，並把選項合併；或改用 \\PassOptionsToPackage 在 \\documentclass 之前傳入選項。",
    },
    {
        code: "command-already-defined",
        pattern: /Command (\S+) already defined|already defined/,
        title_zh: "指令重複定義",
        hint_zh: "\\newcommand 定義的名稱已經存在（可能是套件已定義）。請換一個名稱，或確定要覆寫時改用 \\renewcommand。",
    },
    {
        code: "extra-brace-or-dollar",
        pattern: /Extra \}, or forgotten (\$|\\endgroup|\\right)/,
        title_zh: "多了 } 或少了 $",
        hint_zh: "大括號或數學模式沒有成對。請檢查這一行的 { } 數量，以及 $ 是否成對出現；\\left 與 \\right 也必須成對。",
    },
    {
        code: "missing-brace",
        pattern: /Missing [{}] inserted/,
        title_zh: "缺少大括號",
        hint_zh: "TeX 在這裡需要 { 或 }，但沒有找到。通常是大括號不成對，或在數學式裡用了需要參數的指令卻沒給參數。",
    },
    {
        code: "too-many-braces",
        pattern: /Too many \}'s/,
        title_zh: "右大括號太多",
        hint_zh: "這一行的 } 比 { 多。請找出多餘的 }，或補上漏掉的 {。",
    },
    {
        code: "extra-alignment-tab",
        pattern: /Extra alignment tab has been changed to \\cr/,
        title_zh: "表格欄位太多",
        hint_zh: "這一列的 & 數量超過表格宣告的欄數。請檢查 tabular 的欄位格式（例如 {lcr} 是三欄），或刪掉多餘的 &。",
    },
    {
        code: "misplaced-alignment-tab",
        pattern: /Misplaced alignment tab character &/,
        title_zh: "& 出現在表格外",
        hint_zh: "& 只能用在表格或 align 等對齊環境中。若要印出 & 字元，請寫 \\&。",
    },
    {
        code: "runaway-argument",
        pattern: /Paragraph ended before (\S+) was complete|Runaway argument|File ended while scanning use of/,
        title_zh: "參數沒有結束",
        hint_zh: "某個指令的參數缺少右大括號 }，導致 TeX 一路讀到段落或檔案結尾。請從錯誤位置往前找沒有關閉的 {。",
    },
    {
        code: "double-script",
        pattern: /Double (superscript|subscript)/,
        title_zh: "重複的上標或下標",
        hint_zh: "像 x^2^3 或 x_a_b 這種寫法有歧義。請用大括號分組，例如 x^{2^3} 或 x_{ab}。",
    },
    {
        code: "bad-math-delimiter",
        pattern: /Display math should end with \$\$|Bad math environment delimiter|Math formula deleted: Insufficient symbol fonts/,
        title_zh: "數學模式開關錯誤",
        hint_zh: "數學模式的開始與結束符號不一致（例如用 \\[ 開始卻用 $$ 結束），或在數學模式裡又開了一次數學模式。",
    },
    {
        code: "no-line-to-end",
        pattern: /There's no line here to end/,
        title_zh: "這裡沒有可以換行的行",
        hint_zh: "\\\\ 或 \\newline 用在段落開頭或空行後面。要留空白請改用 \\vspace{...}，分段請用空行。",
    },
    {
        code: "illegal-unit",
        pattern: /Illegal unit of measure/,
        title_zh: "長度單位錯誤",
        hint_zh: "長度需要單位，例如 0.5\\textwidth、3cm、12pt。請檢查 \\vspace、\\hspace、\\includegraphics[width=...] 等參數。",
    },
    {
        code: "missing-number",
        pattern: /Missing number, treated as zero/,
        title_zh: "缺少數字",
        hint_zh: "TeX 需要一個數字或長度，但讀到別的東西。常見於 \\\\ 後面接了 [ 開頭的文字（請改成 \\\\ \\relax [ 或加 {}），或計數器、長度參數寫錯。",
    },
    {
        code: "lonely-item",
        pattern: /Lonely \\item/,
        title_zh: "\\item 不在清單中",
        hint_zh: "\\item 必須放在 itemize、enumerate 或 description 環境裡。",
    },
    {
        code: "missing-item",
        pattern: /Something's wrong--perhaps a missing \\item/,
        title_zh: "清單或環境用法錯誤",
        hint_zh: "清單環境裡第一個項目前少了 \\item，或在不能放文字的地方（例如 \\\\ 用在段落外）放了內容。",
    },
    {
        code: "not-in-outer-par",
        pattern: /Not in outer par mode|Float\(s\) lost|Too many unprocessed floats/,
        title_zh: "浮動物件放錯位置或太多",
        hint_zh: "figure/table 不能放在其他盒子或浮動物件裡；若是「Too many unprocessed floats」，請在適當位置加 \\clearpage，或減少連續的圖表。",
    },
    {
        code: "graphics-problem",
        pattern: /Unknown graphics extension|Cannot determine size of graphic|Division by 0|cannot find image/,
        title_zh: "圖片無法載入",
        hint_zh: "圖片格式不支援或檔案有問題。建議使用 PDF、PNG、JPG；EPS 需要 shell-escape 轉檔，本系統已關閉，請先轉成 PDF 再上傳。",
    },
    {
        code: "illegal-parameter",
        pattern: /Illegal parameter number in definition/,
        title_zh: "定義中的參數編號錯誤",
        hint_zh: "\\newcommand 裡的 #1、#2 超過宣告的參數數量，或在定義裡直接寫了 # 字元（要印出 # 請寫 \\#）。",
    },
    {
        code: "extra-brace-argument",
        pattern: /Argument of (\S+) has an extra \}/,
        title_zh: "參數裡多了 }",
        hint_zh: "傳給指令的參數不完整或有多餘的 }。常見於脆弱指令（如 \\footnote）被放在 \\section 標題等移動參數中，請在前面加 \\protect。",
    },
    {
        code: "lr-mode",
        pattern: /Not allowed in LR mode|\\verb illegal in command argument|\\verb ended by end of line/,
        title_zh: "這個指令不能用在此處",
        hint_zh: "某些指令（如 \\verb、清單、浮動物件）不能放在 \\mbox、標題或其他指令的參數裡。請把它移出來，或改用 \\texttt。",
    },
    {
        code: "undefined-color",
        pattern: /Undefined color/,
        title_zh: "未定義的顏色",
        hint_zh: "使用的顏色名稱沒有定義。請先用 \\definecolor 定義，或用 xcolor 的 [dvipsnames] 等選項載入更多顏色名稱。",
    },
    {
        code: "capacity-exceeded",
        pattern: /TeX capacity exceeded/,
        title_zh: "TeX 記憶體不足",
        hint_zh: "多半是無窮遞迴（某個指令定義成呼叫自己）或巨集展開失控，而不是文件真的太大。請檢查最近新增的 \\newcommand / \\renewcommand。",
    },
    {
        code: "cannot-write",
        pattern: /I can't write on file|Not writing to .* \(openout_any = p\)/,
        title_zh: "無法寫入檔案",
        hint_zh: "編譯只能寫入專案目錄裡的檔案，不能寫到上層或絕對路徑。請改用相對路徑。",
    },
    {
        code: "biblatex-backend",
        pattern: /Please \(re\)run Biber|Please \(re\)run BibTeX|Please rerun LaTeX/,
        title_zh: "需要重新編譯參考文獻",
        hint_zh: "參考文獻還沒處理完成，通常再編譯一次就會好。若持續出現，請查看 BibTeX/biber 的訊息（.blg）中的錯誤。",
    },
    {
        code: "undefined-citation",
        pattern: /Citation [`'"]?([^'`"]+)['`"]?.*undefined|I didn't find a database entry for/,
        title_zh: "找不到引用的文獻",
        hint_zh: "\\cite 的鍵值不在 .bib 檔中。請檢查鍵值拼字、確認 .bib 已用 \\bibliography{...} 或 \\addbibresource{...} 引入，並完整重新編譯（不要用草稿模式）。",
    },
    {
        code: "undefined-reference",
        pattern: /Reference [`'"]?([^'`"]+)['`"]?.*undefined|There were undefined references/,
        title_zh: "找不到交叉參照標籤",
        hint_zh: "\\ref 或 \\cref 用到的 \\label 不存在，或還需要再編譯一次。請檢查標籤名稱是否一致。",
    },
    {
        code: "multiply-defined-label",
        pattern: /Label [`'"]?([^'`"]+)['`"]? multiply defined|There were multiply-defined labels/,
        title_zh: "標籤重複定義",
        hint_zh: "同一個 \\label 名稱用了兩次以上，參照會指到錯的位置。請改成不重複的名稱（例如加上章節前綴 sec:、fig:）。",
    },
    {
        code: "missing-glyph",
        pattern: /Missing character: There is no/,
        title_zh: "字型缺字",
        hint_zh: "目前字型沒有這個字元，PDF 裡會缺字。中文請確認使用 XeLaTeX 並設定中文字型（ctex 或 \\setCJKmainfont{Noto Serif CJK TC}）。",
    },
    {
        code: "bib-syntax",
        pattern: /I was expecting a|syntax error|Illegal, another \\bibdata command|I'm skipping whatever remains of this entry|Repeated entry/,
        title_zh: "參考文獻檔語法錯誤",
        hint_zh: ".bib 檔在這一行附近有語法錯誤：常見是少了逗號、大括號不成對、鍵值重複，或欄位值裡有未跳脫的特殊字元。",
    },
    {
        code: "bib-database-missing",
        pattern: /I couldn't open database file|Cannot find ['"]?.+\.bib|Data source .* not found/,
        title_zh: "找不到 .bib 檔",
        hint_zh: "\\bibliography{...} 或 \\addbibresource{...} 指定的 .bib 檔不存在。\\addbibresource 需要寫副檔名（refs.bib），\\bibliography 則不寫。",
    },
    {
        code: "bib-tool-failed",
        pattern: /^(biber|bibtex) (執行失敗|結束代碼)/,
        title_zh: "參考文獻工具執行失敗",
        hint_zh: "BibTeX 或 biber 沒有正常結束，參考文獻可能是空的或過期的。請查看 .blg 與完整編譯記錄；常見原因是 .bib 語法錯誤或檔案編碼不是 UTF-8。",
    },
    {
        code: "emergency-stop",
        pattern: /Emergency stop|job aborted|Fatal error occurred/,
        title_zh: "編譯中止",
        hint_zh: "前面的錯誤讓 TeX 無法繼續。請先修正清單中的第一個錯誤，後續錯誤常會一起消失。",
    },
];
export function findHint(message) {
    for (const hint of LATEX_HINTS)
        if (hint.pattern.test(message))
            return hint;
    return null;
}
/** Returns a copy of `diagnostic` with `code`, `title_zh`, `hint_zh` filled when a hint matches. */
export function withHint(diagnostic) {
    const hint = findHint(diagnostic.message);
    return hint ? { ...diagnostic, code: hint.code, title_zh: hint.title_zh, hint_zh: hint.hint_zh } : diagnostic;
}
//# sourceMappingURL=hints.js.map