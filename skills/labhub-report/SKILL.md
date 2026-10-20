---
name: labhub-report
description: 把研究成果、進度、idea、實驗設計或產學專案轉換成 SigSpeechAI-NTNU Lab-Hub（李鴻欣教授）要求的報告格式，也能幫忙在 INTERSPEECH/ICASSP/ASRU/SLT 等語音頂會找候選論文。觸發情境：用戶提到「教授的格式」「Lab-Hub」「group meeting 報告」「論文投影片」「idea card」「Table 1」「進度報告」「週報」「產學雙週報告」「研究測試報告」，或要求把任何研究輸出轉成網頁簡報（Quarto，非 PPT、非 Google Slides），或要求「找論文」「找最近頂會論文」「找候選要報告的論文」。
metadata:
  author: pi
  version: "1.0.0"
---

# Lab-Hub 報告格式

把任意研究成果/文件轉成 SigSpeechAI-NTNU 實驗室教授要求的固定格式：**Quarto（`.qmd` → revealjs `.html`，含演講稿）**，不是 PPT、不是 Google Slides。所有格式細節來自教授的 Lab-Hub repo（`guides/`、`conventions/`）；這個 skill 把那套規則變成可直接套用的模板與檢查清單。

## 先讀這份：核心鐵律（每種文件都適用）

**必讀** `references/core-rules.md`，再進對應文件類型的 reference。鐵律摘要：

1. **輸出工具只能是 Quarto**（`.qmd` render 成 `.html`，reveal.js）。不產 PPT、Keynote、Google Slides、純 Markdown 簡報。
2. **某些頁面 AI 絕對不能代寫**，依文件類型不同（見下表「AI 禁寫頁」）。這些頁留 `〔〕` 讓使用者自己填，不可生成內容去填滿它們。
3. **語言規則依文件類型固定**：進度報告投影片可中文；論文報告投影片本體一律英文、演講稿繁體中文；Deep Research／設計文件／核對紀錄全繁體中文（專有名詞留英文）。
4. **每個數字、每個論文引用都要標來源**（`AI`／`✓`已核對／`我`自己寫），且教材规定「核對」是義務動作，不是選讀。
5. **教授決定的事不能由 AI 代答**（題目、資料、GPU、截稿日、門檻、baseline 降不降層……）。這些欄位永遠留白或寫「待教授確認」。
6. **Mermaid 圖**：節點標籤不含括號/引號/斜線；畫圖前先用文字列出節點與邊。
7. 任何「審核/確認」紀錄（設計文件的審核紀錄、需求規格表的確認紀錄、group meeting 的 Issue 回饋）**不可覆蓋舊版，只能新增一行**。

## 路由表：使用者想產出什麼 → 讀哪份 reference → 用哪個模板

| 使用者情境 / 要產出的東西 | 對應站 | Reference | 模板 |
|---|---|---|---|
| 每週向教授報進度（group meeting） | 第 5 站 | `references/progress-report.md` | `templates/progress_report.qmd` |
| 把一篇論文變成報告投影片 | 貫穿（論文報告） | `references/paper-report.md` | `templates/paper_report.qmd` |
| 把「我覺得可以做 X」寫成可判斷的提案 | 第 1b 站 | `references/idea-card.md` | `templates/idea_card.md` |
| 實驗設計：Table 1、消融表、method figure、決策紀錄 | 第 2 站 | `references/design-table1.md` | `templates/design_doc.md` |
| 復現 baseline／錯誤分析／實驗紀錄／repo README | 第 3+4 站 | `references/reproduce-log.md` | `templates/results_csv_schema.md`、`templates/repo_readme.md` |
| Deep Research 建地圖 / 深挖路線（研究用，非簡報） | 第 0、1 站 | `references/deep-research.md` | （指令全文在 reference 裡，直接複製貼進 AI 的 Deep Research） |
| 給產業方的雙週進度報告 | 產學分支 | `references/industry-biweekly.md` | `templates/industry_biweekly.qmd`、`templates/industry_minutes.md` |
| 給產業方工程師的研究測試報告 | 產學分支 | `references/industry-test-report.md` | `templates/industry_test_report.qmd` |
| 產學需求規格表、驗收紀錄 | 產學分支 | `references/industry-biweekly.md` §需求規格表 | `templates/requirement_spec.md`、`templates/acceptance.csv` |
| 審稿意見回來後的對帳 | 慣例 | `references/review-reconciliation.md` | `templates/review_reconciliation.md` |
| 不確定某件事該不該自己決定 | 總表 | `references/ask-professor-index.md` | — |
| 從頂會找候選論文供選擇要讀/要報的（INTERSPEECH/ICASSP/ASRU/SLT等） | 貫穿 | `references/paper-scouting.md` | `templates/paper_shortlist.md` |

不確定使用者要哪一種時，先問：「這是要報進度、報一篇論文、出一個 idea、設計實驗、還是給產業方的報告？」——這五類格式完全不同，不要猜。若使用者還沒有論文可報、想先找候選，就用上方「找候選論文」那一行，別直接跳進 paper-report 流程。

## 標準工作流程

1. **判斷文件類型**，用上表選 reference + 模板。
2. **讀對應 reference 的全文**（不要只讀 SKILL.md 就動手，每種文件的鐵律、頁數、AI 禁寫頁都在 reference 裡）。
3. **複製模板**到使用者的 repo 位置（依 reference 裡標的路徑慣例，例如 `reports/progress_〔YYMMDD〕.qmd`、`notes/idea_log.md`、`design/〔題目〕_design_〔日期〕.md`）。
4. **只填使用者提供或可從其既有檔案（results.csv、日誌、上週 Issue）查到的內容**；沒有依據的格子留 `〔〕`，不要編數字、編論文、編結論。
5. **AI 禁寫頁留白**，明確告知使用者「這幾頁/這幾格要你自己寫」。
6. **檢查語言規則、Mermaid 規則**是否符合該文件類型要求。
7. **render**：`quarto render <path>.qmd`（需本機已裝 [Quarto](https://quarto.org)；未裝則提示安裝指令，不要用其他工具代替產生 html）。
8. **提醒後續同步動作**：依文件類型提醒使用者要同步到哪裡（例如進度報告要開/更新 GitHub Issue；設計文件要等教授審核紀錄才能開始寫程式；idea card 要更新 idea_log 的狀態與預測紀錄）。
9. **跑一遍該 reference 的「怎麼核對」清單**，把核對結果回報給使用者，不要自行判定「已核對」。

## 這個 skill 不做的事

- 不幫使用者**選題目、選 baseline、選資料集、估截稿日、定門檻**——這些永遠是教授或使用者自己的判斷，skill 只提供格式與流程。
- 不把 AI 生成的 idea 包裝成 idea card 直接呈現為「可以報給教授」的樣子；idea card 的痛點證據、prior work 查證、八格內容必須使用者自己確認後才算完成。
- 不生成未經核對就宣稱正確的論文引用、數字、Table 1 格子。
