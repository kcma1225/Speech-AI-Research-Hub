/**
 * Starting points for in-app Quarto decks, following the professor's Lab-Hub formats
 * (skills/labhub-report/templates/progress_report.qmd and paper_report.qmd): fixed YAML (1280×800, KaTeX,
 * MathML notes fix), fixed page titles, speaker notes in `::: {.notes}`, `〔〕` where the student must fill in.
 * Figures of the original templates are placeholders here (the tree starts without images).
 */
export type DeckTemplate = "progress" | "paper_report" | "blank";
export const DECK_TEMPLATES: readonly DeckTemplate[] = ["progress", "paper_report", "blank"];

/** Fixed Lab-Hub revealjs YAML (core-rules §1: do not restyle). */
export const LABHUB_FORMAT = `format:
  revealjs:
    width: 1280
    height: 800
    margin: 0.04
    slide-number: c/t
    center: false
    navigation-mode: linear
    html-math-method:
      method: katex
      # Without an explicit url Quarto's revealjs output appends katex.min.js to the MathJax URL (a file that does not exist).
      url: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/"
    include-after-body:
      - text: |
          <script>
          (function () {
            var items = [];
            document.querySelectorAll("aside.notes .math").forEach(function (el) {
              items.push({ el: el, tex: el.textContent, display: el.classList.contains("display") });
              el.classList.remove("math");
            });
            document.addEventListener("DOMContentLoaded", function () {
              items.forEach(function (it) {
                katex.render(it.tex, it.el, { displayMode: it.display, output: "mathml", throwOnError: false });
              });
            });
          })();
          </script>`;

export type TemplateInput = { title: string; author: string; date: string; subtitle?: string; /** Generated decks: the hub-deck.css type scale + neutral Mermaid theme. */ theme?: boolean };

/** Format additions of generated decks (stylesheet `hub-deck.css` written next to the entry, Mermaid theme). */
export const GENERATED_FORMAT = `    css: hub-deck.css
`;

/** YAML-safe double-quoted string. */
export const yamlString = (value: string) => JSON.stringify(value.replace(/[\r\n]+/g, " "));

/** YAML front matter (fixed Lab-Hub format) for a deck. */
export const qmdHeader = (input: TemplateInput) =>
  [
    "---",
    `title: ${yamlString(input.title)}`,
    ...(input.subtitle ? [`subtitle: ${yamlString(input.subtitle)}`] : []),
    `author: ${yamlString(input.author)}`,
    `date: ${yamlString(input.date)}`,
    input.theme ? LABHUB_FORMAT.replace("    navigation-mode: linear\n", `    navigation-mode: linear\n${GENERATED_FORMAT}`) : LABHUB_FORMAT,
    "---",
  ].join("\n");

// No HTML comment before the first heading: Quarto would turn it into an empty slide.
const PROGRESS_BODY = `
## 問題定義

<!-- 進度報告固定 8 頁（Lab-Hub group meeting）。每個數字要對得回 results.csv 的某一列；前兩頁沒變就沿用上週。 -->

〔示意圖：題目在解什麼、原本做法在哪裡壞掉〕

::: {.notes}
一句話：我在解什麼
:::

## Idea 或架構

〔示意圖：idea card 的假設，或 method figure；新成分用不同框標出〕

::: {.notes}
一句話：我動的是哪一格
:::

## 對帳

| 上週說要做 | 實際做到 |
|---|---|
| 〔從上週投影片/Issue複製〕 | 〔做到／沒做到，標紅並寫原因〕 |

::: {.notes}
沒做到的原因，一句
:::

## Table 1 現況

距上次新數字：〔N〕 週 <!-- 超過4週：這次meeting固定要討論換題/砍格子/再給兩週 -->

〔整張 Table 1，本週新填的格子加粗，空格留 — ；數值代碼 C=引用 R=重跑 O=自己方法〕

::: {.notes}
每個新格子的數字從哪個 run_id 來
:::

## 本週關鍵結果

〔一張圖或一張小表，只放最重要的一個〕

::: {.notes}
這個結果代表什麼、和預期差在哪
:::

## 卡住

- 問題：〔　〕
- 試過：〔　〕
- 卡在哪：〔　〕

::: {.notes}
想請教授或partner幫什麼
:::

## Idea card

<!-- 八格精簡版，不可由AI生成idea內容，使用者自己填 -->

- 痛點：〔　〕
- 假設：〔　〕
- 最小驗證：〔　〕
- 最接近的 prior work：〔　〕

::: {.notes}
為什麼這張值得做；沒把握的地方
:::

## 下週與要問

下週要跑的 run：

1. 〔　〕

要教授決定的事：

1. 〔　〕

本週淺讀：〔2篇短名〕
`;

const notes = (minutes: string, hint: string, source: string) => `::: {.notes}
**【講述】**（約 ${minutes} 分鐘）

${hint}

**【提示】**

- 出處：${source}
:::`;

const ARCH = (extra = "", styles = "  style C stroke-width:4px") => `\`\`\`{mermaid}
flowchart LR
  A[Input] --> B[Encoder]
  B --> C[New Module]
  C --> D[Decoder]
  D --> E[Output]${extra}
${styles}
\`\`\``;

const PAPER_BODY = `
## One-sentence claim

<!-- 論文報告固定 13 頁：投影片本體英文、講稿繁體中文。第 7、12、13 頁使用者自己寫（AI 不生）。 -->

In 〔task〕, 〔method〕 improves 〔metric〕 on 〔dataset〕 from 〔A〕 to 〔B〕, at the cost of 〔　〕.
(Table 〔N〕)

〔Author, Venue Year, URL〕

${notes("1", "為什麼挑這篇", "論文表〔N〕")}

## Background

〔Original pipeline — diagram〕

${notes("1.5", "原本怎麼做", "§〔　〕")}

## Pain point

〔Where the background pipeline breaks; one concrete failure example〕

${notes("1.5", "這個例子為什麼錯", "§〔　〕")}

## Architecture

<!-- Mermaid flowchart LR；新模組用 stroke-width:4px 標出；節點標籤不含括號/引號/斜線 -->

${ARCH()}

${notes("2", "輸入、輸出、每個模組一句", "§〔　〕")}

## Training

<!-- 同一張架構圖，節點命名一致；加損失節點與梯度流向；凍結模組 fill:#ddd -->

${ARCH("\n  E --> L[Loss]", "  style C stroke-width:4px\n  style B fill:#ddd")}

Data: 〔　〕　Loss: 〔　〕　Updated: 〔　〕　Frozen: 〔　〕

${notes("2", "資料從哪來、算什麼損失、更新什麼", "§〔　〕")}

## Inference

<!-- 同一張架構圖，拿掉訓練才有的節點 -->

${ARCH()}

Differences from training: 〔　〕

${notes("1.5", "和訓練哪裡不同", "§〔　〕")}

## Trace one example

<!-- 這頁我自己寫，AI不生 -->

〔　〕

::: {.notes}
〔　〕
:::

## Why it works

- Without it: 〔　〕
- Why here: 〔　〕
- Cost: 〔　〕

::: {.notes}
**【講述】**（約 0.5 分鐘）

**【提示】**

- 之後和第11頁消融表對
:::

## Setup and fairness

| Dataset | Metric | Baseline |
|---|---|---|
| 〔　〕 | 〔　〕 | 〔　〕 |

Same backbone? 〔　〕　Same data? 〔　〕　Baseline re-run or cited? 〔　〕　Multiple seeds? 〔　〕

${notes("1.5", "哪裡不公平", "實驗設定節")}

## Main results

<!-- 主表只留3-5列，關鍵數字加粗 -->

| Method | 〔metric〕 |
|---|---|
| Baseline | 〔　〕 |
| **〔method〕** | **〔　〕** |

From Table 〔N〕 of the paper

${notes("2", "贏多少、哪裡贏最多、哪裡沒贏", "表〔N〕")}

## Ablation and key figure

| Removed | Change |
|---|---|
| 〔　〕 | 〔　〕 |

〔Key figure — from the paper, Fig. N, annotations mine〕

Not reported: 〔inference speed / other datasets / seeds〕

${notes("1.5", "消融有沒有驗證第8頁的推理；圖想證明什麼", "表/圖〔N〕")}

## My assessment

<!-- 這頁我自己寫，AI不生 -->

- Strongest point: 〔　〕
- Weakest point: 〔　〕
- What a reviewer would ask: 〔　〕

::: {.notes}
〔　〕
:::

## Takeaways for my work

<!-- 這頁我自己寫，AI不生 -->

- What to borrow: 〔　〕
- Idea card?: 〔是：來源〔　〕編號〔　〕／否：原因〕

::: {.notes}
〔　〕
:::
`;

const BLANK_BODY = `
## 第一頁

內容

::: {.notes}
演講稿（按 S 開啟講者模式）
:::
`;

/** The `index.qmd` of a new tree. */
export function templateQmd(template: DeckTemplate, input: TemplateInput): string {
  const body = template === "progress" ? PROGRESS_BODY : template === "paper_report" ? PAPER_BODY : BLANK_BODY;
  return `${qmdHeader(input)}\n${body}`;
}

/** Default title of a progress deck: `<study> 進度報告 <YYMMDD>`. */
export function progressTitle(studyTitle: string, date: string) {
  return `${studyTitle} 進度報告 ${date.slice(2).replace(/-/g, "")}`;
}

/** Today in Asia/Taipei as YYYY-MM-DD. */
export const taipeiToday = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(now);

/** Compact format rules given to the model (from skills/labhub-report references). */
export const LABHUB_RULES = {
  progress: `Lab-Hub 進度報告（group meeting）規則：
- 固定 8 頁，標題逐字：問題定義、Idea 或架構、對帳、Table 1 現況、本週關鍵結果、卡住、Idea card、下週與要問。
- 投影片與講稿都用繁體中文（臺灣用語），專有名詞留英文。
- 每頁下方放 ::: {.notes} 講稿 :::。
- 只填資料裡查得到的事實；沒有依據的格子留〔　〕，絕不編數字、論文或結論。
- 「卡住」、「Idea card」、「下週與要問」頁的內容由學生自己提供：只放資料中明確寫到的，否則留〔　〕。
- 教授才能決定的事（題目、資料、GPU、截稿日、baseline）寫「待教授決定」。
- 第 4 頁要有「距上次新數字：〔N〕 週」。不要美化、不要加主題或 CSS。`,
  paper_report: `Lab-Hub 論文報告規則：
- 固定 13 頁，英文標題逐字：One-sentence claim, Background, Pain point, Architecture, Training, Inference, Trace one example, Why it works, Setup and fairness, Main results, Ablation and key figure, My assessment, Takeaways for my work.
- 投影片本體一律英文；講稿（::: {.notes}）用繁體中文，格式：**【講述】**（約 N 分鐘）段落，空一行，**【提示】**，空一行，條列（含「出處：表/§」）。
- 第 7（Trace one example）、12（My assessment）、13（Takeaways for my work）頁 AI 不寫：內容與講稿只留〔　〕。
- Architecture/Training/Inference 用同一張 Mermaid flowchart LR，節點命名一致；新模組 style X stroke-width:4px；凍結模組 fill:#ddd；節點標籤不可含括號、引號、斜線。
- Main results 主表 3–5 列，關鍵數字加粗，標出處表號。只用提供的論文資訊；查不到的數字留〔　〕，不可編造。`,
} as const;
