# Agent 評估集（P4）

日期：2026-10-24。對應 `agent-planning-redesign.md` §4 P4：一組固定的真實任務，每次改 Agent 架構都跑一遍，追蹤完成率、交付物是否正確、時間、模型呼叫數、修正輪與「對→錯」翻轉。程式在 `backend/scripts/eval/`，committed 的基準在 `backend/scripts/eval/baseline/`（report.json／report.md／artifacts）。

## 怎麼跑

只對 staging（`hubv3`，http://127.0.0.1:18090）；正式站的網址與 compose project `hub` 會被拒絕。

```bash
cd backend
npx tsx scripts/eval/run.ts --list                         # 列出任務與標籤
npx tsx scripts/eval/run.ts --tags quick                   # 子集（任一標籤）：quick / core / deck / note / latex / lang / edit / stop / slow …
npx tsx scripts/eval/run.ts --only deck_add_page,kind_conflict
npx tsx scripts/eval/run.ts                                # 全部 20 個（便宜模型、與其他人共用 2 個 ai-worker 槽：約 6–9 小時）
# --concurrency 2  --out <dir>  --compare <report.json>  --no-judge  --fixtures（只建立固定資料）
# --into <dir>     重跑部分任務並取代某次報告裡的結果（例如基礎設施問題造成的逾時）
# --regrade <dir>  用目前的評分程式重評一次（評分程式修正後，舊的結果仍可比較；計時與評審保留）
```

環境變數：`HUB_URL`、`EVAL_USER` / `EVAL_PASSWORD`（預設 `linyating` / `password123`，避開其他 agent 用的 `chenbaiyu` 的每人 3 個工作流程上限）、`EVAL_COMPOSE_PROJECT`（預設 `hubv3`；用 `docker exec` 讀 staging 資料庫的 `ai_call_log` / `workflow_steps` / `workflow_events`，評審也在 backend 容器內用平台的 `analysis` 角色呼叫）。結果寫到 `scripts/eval/runs/<時間>/`（gitignored）：`report.json`、`report.md`、`artifacts/<任務>.txt`。下次執行會自動和最新一次（沒有就和 `baseline/`）比較，並對有評審的任務做兩種順序的 pairwise 評比。

- `quick`（6 個，約 1.5–2 小時）：加一頁、刪一頁、閱讀筆記、單篇論文研究的進度簡報、缺 PDF、交付物衝突。
- `core`（10 個）：每類問題一個代表（翻譯＋接續、加／刪頁、頁數、主題簡報、論文報告、聊天交辦、缺 PDF、交付物衝突）。
- 單元測試：`npx vitest run test/eval-graders.test.ts`（評分程式與評審回覆解析）。

## 固定資料（`fixtures.ts`，冪等）

- 研究「Agent 評估集：串流 ASR 熱詞偏置」（林雅婷擁有）：10 篇有 PDF 的 contextual biasing／ASR 論文（從實驗室文獻庫依 arXiv／DOI 連結，沒有就用識別碼加入）、1 篇刻意沒有 PDF、也沒有識別碼的紀錄（缺 PDF 的情境）、週會筆記、調研筆記、3 個任務、2 個里程碑。
- 研究「Agent 評估集：單篇論文研究」：只有 1 篇論文（wav2vec 2.0）＋進度資料——進度簡報不能因為只有一篇論文就變成論文報告。
- 要編輯的簡報每個任務各自從固定原始碼新建（`FIXTURE_DECKS`：6 頁繁中的熱詞簡報＝正式站 probe 的那份；6 頁英文版），任務之間不共用狀態。

## 任務（`tasks.ts`）

| id | 情境（來自正式站問題） | 啟動 | 確定性評分 |
|---|---|---|---|
| `deck_translate_en` | 中文簡報「全英文翻譯」，含封面 | 交給 Agent | 全英文（封面、標題、內文、圖表標籤、講稿）、頁數不變、封面英文 |
| `deck_followup_expand` | 接著上一個、不重說語言：「再詳細一點…每個方法要有架構、Pros/Cons」 | 同一對話 | 仍是英文、≥ 2 頁有架構／Pros／Cons、頁數不少於原本 |
| `deck_expand_fields_zh` | 展開成每個方法一頁，每頁架構／優點／缺點 | 交給 Agent | 繁中、逐項欄位、其他頁保留且順序不變 |
| `deck_add_page` | 英文簡報、中文指令加一頁比較表 | 交給 Agent | 頁數 +1、原頁保留、有一個表格同時比較三種方法、仍是英文 |
| `deck_exact_pages` | 「8 頁的進度報告」 | 交給 Agent | 剛好 8 頁、繁中、進度簡報、無佔位文字 |
| `deck_remove_page` | 刪掉「卡住」這頁 | 交給 Agent | 5 頁、那頁不見、其他保留 |
| `deck_topic_paper_title` | 英文主題簡報，請求裡有 "Paper title:"（50b49d80 類） | 交給 Agent | 全英文、不是論文報告、提到 ≥ 4 篇文獻庫論文、≥ 6 頁 |
| `deck_paper_report` | 論文報告簡報（有 PDF） | 交給 Agent | paper_report 且是那篇論文、繁中、≥ 8 頁 |
| `note_topic_research` | 主題調研筆記（Zipformer + RNN-T 動態熱詞） | 交給 Agent | 繁中、提到 ≥ 4 篇、引用鍵 ≥ 3 且都在研究文獻庫、≥ 1500 字 |
| `note_lit_review` | 文獻回顧要有比較表 | 交給 Agent | 繁中、表格 ≥ 5 列、引用鍵 ≥ 5 且都存在 |
| `note_reading` | 單篇閱讀筆記 | 交給 Agent | 繁中、是那篇論文、≥ 800 字 |
| `latex_paper_goal` | 從零寫 LaTeX 論文（目標，多階段） | POST /goals | 編譯成功、≥ 4 個 `\section`、引用鍵都存在 |
| `deck_progress_single_paper` | 只有一篇論文的研究做進度簡報 | 交給 Agent | 進度簡報（不是論文報告）、繁中、用到研究進度資料 |
| `deck_progress_en` | 英文指令的進度簡報 | 交給 Agent | 全英文含封面、進度簡報 |
| `note_en_compare` | 英文筆記 | 交給 Agent | 英文、提到 ≥ 3 篇、≥ 1500 字 |
| `deck_translate_zh` | 英文簡報翻成繁中 | 交給 Agent | 繁中含封面、頁數不變 |
| `chat_paraphrase` | 聊天交辦，助理會改寫請求（1bb39a8 類） | 聊天 | Brief 每條要求都引用使用者原話、沒有憑空的語言／頁數、進度簡報、繁中 |
| `deck_missing_pdf` | 論文沒有 PDF | 交給 Agent | 停在 `needs_pdf`，不寫任何替代成果 |
| `kind_conflict` | 指定 reading_note 流程，原話卻是「做成簡報」 | 交給 Agent | 交付物是簡報或先問交付物；絕不能是筆記；Brief 交付物 = deck |
| `note_generic_metrics` | 一般筆記：評估指標與計算方式 | 交給 Agent | 繁中、四個指標都寫到、≥ 800 字 |

每個任務都在自動駕駛下跑；Runner 只核准計畫卡、**從不回答問題卡**（停下來問就記為 `awaiting_input` 後取消）；時間上限從 run 真正開始執行（`started_at`）起算（預設 60 分，主題／論文 90–120，目標 240），排隊時間另記為 `queued_s`。

## 記錄與評分

- **結果**：PASS = 交付物正確 + 所有確定性評分通過 + 沒有逾時。另列 run 狀態（done／partial…）與系統自己的驗收（criteria 通過數，括號為使用者要求 `req_*`）。
- **交付物**：run 的 artifacts 種類 vs 期望（目標任務允許中間階段的筆記）；停止型任務看狀態與「沒有替代成果」。
- **確定性評分**（`graders.ts`）刻意不重用 workflow 的 checks/requirements 程式（避免繼承被測物的 bug）：簡報解析（YAML 封面 + `#`/`##` 投影片，跳過程式碼區塊，講稿 div）、頁數、標題保留與順序、語言（英文 = 封面／標題／內文／講稿沒有任何 CJK，〈〉引號內書名除外；繁中 = 封面有漢字、漢字多於英文字、沒有整頁全英文的內文或講稿）、逐項欄位、比較表、段落、引用鍵解析、提到的文獻庫論文、表格列數、佔位文字、Brief 是否只引用原話。
- **時間**：`wall_s` = 第一個 run 的 `started_at` → 最後一個的 `finished_at`；`active_s` = usage.active_ms 合計。
- **模型呼叫**：`ai_call_log`（final）依 `purpose` 分組；「修正輪／修正類」= `round > 0` 或 purpose 含 fix／repair／revise 的呼叫佔比。
- **翻轉**：criteria 在 `workflow_events` 的 workflow 快照之間由 pass 變 fail；以及步驟的確定性 check 在某一輪通過、下一輪失敗（`inputs.conv.rounds[].failures` 的 `c:<id>`）。
- **評審**：一次 rubric 評分（要求、內容、結構、形式，各 1–5），用 staging 的模型（`analysis`，`purpose eval_judge`）；有上一次的成果時做 pairwise，兩種順序都判同一邊才算勝負，否則平手。評審與被測物是同一個便宜模型（有自我偏好的風險），只看相對變化，不看絕對分數。
- **版本歸屬**：每個任務記錄開始與結束時的 ai-worker image id（＋本機 git，`+dirty` 只表示工作目錄有未提交的修改，以 image id 為準）；中途重新部署會標「執行中重新部署」。

## 基準（2026-10-23 16:41 → 10-24 01:26 UTC，staging、glm-5.3-flash）

P0 + P1 已部署（b547fff）；**P2 同時在 staging 反覆部署**（ai-worker image 4232638b → e474128d → 9441a37e → 3ab300da → f3565b40 → ad3e6283 → e7fb9fc1），所以每列標了執行時的 image，12 個任務橫跨兩個版本。三個任務第一次因 Runner 的計時從「排隊」開始算而誤判逾時（`deck_translate_en`、`deck_add_page`、`note_en_compare`；連帶 `deck_followup_expand` 被跳過），修正計時後以 `--into` 在 e7fb9fc1 上重跑。

**通過 14/20；交付物正確 17/20；run 狀態 done 9/20；確定性評分 48/60；時間中位數 27.9 分；模型呼叫 834（修正輪／修正類 28.2%）；修正輪 50；翻轉 1；評審平均 4.14/5。**

| 任務 | 結果 | 狀態 | 交付物 | 評分 | 系統驗收 (req) | 分鐘 | 呼叫 | 修正輪 | 評審 | image |
|---|---|---|---|---|---|---|---|---|---|---|
| deck_translate_en | PASS | done | deck | 3/3 | 16/16 (1/1) | 56 | 28 | 1 | 4.25 | ad3e→e7fb |
| deck_followup_expand | PASS | partial | deck | 3/3 | 18/19 (4/4) | 50 | 44 | 5 | 4.25 | e7fb |
| deck_expand_fields_zh | FAIL | partial | deck | 2/3 | 18/18 (3/3) | 37 | 49 | 1 | 5 | e474→9441 |
| deck_add_page | PASS | partial | deck | 4/4 | 17/18 (3/3) | 51 | 39 | 4 | – | ad3e→e7fb |
| deck_exact_pages | PASS | partial | deck | 4/4 | 14/15 (1/1) | 34 | 48 | 5 | 4.25 | 9441 |
| deck_remove_page | PASS | done | deck | 4/4 | 17/17 (2/2) | 19 | 25 | 1 | – | 9441 |
| deck_topic_paper_title | PASS | done | deck | 4/4 | 19/19 (5/5) | 15 | 17 | 1 | 4.75 | 4232 |
| deck_paper_report | FAIL | partial | deck | 2/3 | 16/16 (2/2) | 34 | 64 | 5 | 3.75 | 4232→e474 |
| note_topic_research | FAIL | awaiting_input | 無 | 0/4 | – | 5 | 4 | 0 | – | 4232 |
| note_lit_review | PASS | done | note | 3/3 | 7/7 (2/2) | 15 | 50 | 0 | 4.75 | e474 |
| note_reading | PASS | partial | note | 3/3 | 6/7 (2/2) | 21 | 86 | 2 | – | 9441→3ab3 |
| latex_paper_goal | FAIL | partial | note+latex | 1/3 | 13/15 (6/6) | 67 | 68 | 4 | 1.75 | 4232→e474 |
| deck_progress_single_paper | PASS | partial | deck | 3/3 | 15/17 (3/3) | 45 | 52 | 4 | – | 9441→f356 |
| deck_progress_en | PASS | done | deck | 3/3 | 17/17 (3/3) | 29 | 45 | 5 | – | 3ab3→f356 |
| note_en_compare | PASS | done | note | 3/3 | 10/10 (4/4) | 26 | 60 | 4 | 4.5 | e7fb |
| deck_translate_zh | PASS | done | deck | 2/2 | 16/16 (1/1) | 13 | 23 | 1 | – | f356 |
| chat_paraphrase | PASS | done | deck | 3/3 | 17/17 (3/3) | 49 | 46 | 3 | – | f356→ad3e |
| deck_missing_pdf | PASS | needs_pdf | — | 1/1 | – | 0.5 | 1 | 0 | – | f356 |
| kind_conflict | FAIL | done | **note** | 0/1 | 7/7 (2/2) | 27 | 84 | 4 | – | f356→ad3e |
| note_generic_metrics | FAIL | awaiting_input | 無 | 0/3 | – | 0.4 | 1 | 0 | – | ad3e |

逐項細節（每個評分的說明、未通過的系統驗收、各 purpose 的呼叫數與時間、步驟停止原因）見 `backend/scripts/eval/baseline/report.md`。

## 基準發現的問題（給 workflow 程式，P4 沒有改）

1. **明確指定的 playbook 蓋過使用者原話的交付物**（`kind_conflict`，run 99564733；smoke 325e5280 也一樣）：`playbook: reading_note` + 「把〈Deep context…〉做成簡報」→ Brief `deliverable = reading_note`（source plan），寫出筆記，系統自己的驗收 7/7 全過。交付物不變量對「建立時就指定的 playbook」沒有生效；應該依原話是簡報而改用 slides 或問 `deliverable_*` 卡。
2. **主題調研在自動駕駛下停下來問**（`note_topic_research`，38cafe55）：線上搜尋找不到可匯入的論文就出問題卡，但研究文獻庫裡已有 10 篇相關論文；應該先用文獻庫（主題簡報已經這樣做），自動駕駛下不該因此停住。
3. **「評估指標…寫成一份筆記」被路由到 `experiment_report`**（`note_generic_metrics`，5220d4f3）：`detect` 看到 CER 就給 0.75，接著因為「找不到實驗數據」而停下來問。原話沒有實驗結果；應該是 generic／筆記。
4. **LaTeX 目標：編譯失敗、章節重複**（`latex_paper_goal`，goal 2f782d4c）：s01 自己是一篇完整的小論文（摘要、分類、結論、thebibliography），之後 s02–s08 又重寫一次；s04.tex 內含完整的 `\documentclass` → 編譯失敗；3 個引用鍵不在文獻庫（graves2012sequence、rao2017streaming、he2019streaming）。評審 1.75／5。這正是 P2「大綱→逐段→程式拼接」要解的。
5. **論文報告簡報的投影片內文是英文、講稿是中文**（`deck_paper_report`，3395f787）：請求是中文、沒指定語言，9 頁內文整頁英文（封面是論文英文標題，這點合理）。若 Lab-Hub 模板刻意用英文投影片，評分應改成只看講稿；否則是語言預設的 bug。待確認。
6. **展開時其他頁沒有保留**（`deck_expand_fields_zh`，2b6d7935）：「目前進度」「下週與要問」被拿掉或換位置，系統驗收卻 18/18。系統沒有「未被要求修改的頁要保留」的檢查。
7. **慢**：6 頁翻譯 56 分、加一頁 51 分（visual_fix 一次 3–10 分鐘）；`note_reading` 86 次呼叫（`reading_part` 為主），修正輪呼叫約佔 28%。
8. 系統的 partial 有 5 個是我們評分全過的（多半是 visual_qa／coverage 的判斷題），代表「部分完成」仍常是評審的判斷而非真正未達成的要求；`deck_progress_single_paper` 有一次 coverage 由 pass 翻成 fail。

## 已知限制

- 便宜模型 + 共用的 2 個 ai-worker 槽：時間會受其他 agent 的 run 影響（`queued_s` 另記；wall 時間從開始執行算），只比較同條件的兩次執行。
- 評審與被測物同模型；rubric 不給原始來源（翻譯類評審看不到原文），只當輔助訊號。
- `--regrade` 讀回當時存下的成果文字，但簡報種類／編譯狀態等中繼資料是從 hub 重新讀取。
- 改任務的請求文字會讓結果不可比較：改的時候在這份文件記下來，並重跑基準。
