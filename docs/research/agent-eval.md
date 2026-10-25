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
| `deck_paper_report` | 論文報告簡報（有 PDF） | 交給 Agent | paper_report 且是那篇論文、Lab-Hub 模板語言（投影片英文、講稿繁中；請求明確指定語言時照請求）、≥ 8 頁 |
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
| `deck_spoken_survey` | 正式站 79ab0678 的原話（語音輸入、沒有標點的長句）：統計文獻庫的熱詞方法，每個方法優缺點、架構圖、論文與會議／期刊，英文 | 交給 Agent | 全英文、提到論文的頁都寫了會議／期刊（≥ 80%）、提到固定文獻庫 ≥ 6 篇、標題沒有使用者沒說的主題（efficiency／評估集）、≥ 3 頁有 pros 與 cons、≥ 3 張架構圖 |
| `deck_notes_zh_home` | 79ab0678：首頁聊天（沒有研究）對英文簡報說「講稿要是中文的…一比一的念出來」 | 交給 Agent（`home`：對話、頁面、inputs 都沒有研究，只有 deck_id） | 投影片（含封面）英文、每頁講稿以中文為主、頁數與標題不變、沒有問問題、Brief 有「講稿用繁體中文」 |
| `deck_study_answer_topic` | 79ab0678：首頁聊天沒有研究 → 研究選擇卡，Runner 以「其他」回答研究名稱 | 交給 Agent（`home` + `answer`） | 有問研究卡、研究名稱沒有進原話或要求、標題沒有研究名稱的詞、繁中、8 頁 |

每個任務都在自動駕駛下跑；Runner 只核准計畫卡、**不回答問題卡**（例外：任務有 `answer`，例如 `deck_study_answer_topic` 回答研究選擇卡；`home` 任務從沒有研究的首頁對話開始）（停下來問就記為 `awaiting_input` 後取消）；時間上限從 run 真正開始執行（`started_at`）起算（預設 60 分，主題／論文 90–120，目標 240），排隊時間另記為 `queued_s`。

## 記錄與評分

- **結果**：PASS = 交付物正確 + 所有確定性評分通過 + 沒有逾時。另列 run 狀態（done／partial…）與系統自己的驗收（criteria 通過數，括號為使用者要求 `req_*`）。
- **交付物**：run 的 artifacts 種類 vs 期望（目標任務允許中間階段的筆記）；停止型任務看狀態與「沒有替代成果」。
- **確定性評分**（`graders.ts`）刻意不重用 workflow 的 checks/requirements 程式（避免繼承被測物的 bug）：簡報解析（YAML 封面 + `#`/`##` 投影片，跳過程式碼區塊，講稿 div）、頁數、標題保留與順序、語言（英文 = 封面／標題／內文／講稿沒有任何 CJK，〈〉引號內書名除外；繁中 = 封面有漢字、漢字多於英文字、沒有整頁全英文的內文或講稿）、逐項欄位、比較表、段落、引用鍵解析、提到的文獻庫論文（論文鍵、冒號前的標題、≥ 30 字母的標題字首——主題簡報的來源行把標題截在 56 字內——或作者 + 年份）、表格列數、佔位文字、Brief 是否只引用原話。引用鍵的「研究文獻庫」= 固定資料的鍵 + run 結束時研究裡的鍵（主題調研在 run 中把論文匯入研究，這些也算）。論文報告的語言照 Lab-Hub 模板（`backend/src/lib/slides/templates.ts`：投影片英文、講稿繁中；學生自填頁與封面不評），請求明確指定語言時才改用一般的語言評分（`explicitLanguage`）。
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
5. **論文報告簡報的投影片內文是英文、講稿是中文**（`deck_paper_report`，3395f787）：請求是中文、沒指定語言，9 頁內文整頁英文（封面是論文英文標題，這點合理）。若 Lab-Hub 模板刻意用英文投影片，評分應改成只看講稿；否則是語言預設的 bug。→ 確認是模板規定（投影片英文、講稿繁中），P5 改評分。
6. **展開時其他頁沒有保留**（`deck_expand_fields_zh`，2b6d7935）：「目前進度」「下週與要問」被拿掉或換位置，系統驗收卻 18/18。系統沒有「未被要求修改的頁要保留」的檢查。→ P5 修正（見下）。
7. **慢**：6 頁翻譯 56 分、加一頁 51 分（visual_fix 一次 3–10 分鐘）；`note_reading` 86 次呼叫（`reading_part` 為主），修正輪呼叫約佔 28%。
8. 系統的 partial 有 5 個是我們評分全過的（多半是 visual_qa／coverage 的判斷題），代表「部分完成」仍常是評審的判斷而非真正未達成的要求；`deck_progress_single_paper` 有一次 coverage 由 pass 翻成 fail。

## P5：保留原頁 + 評分修正（2026-10-24 07:19 → 13:49 UTC，staging、glm-5.3-flash）

改了什麼（P0–P3 + LaTeX 修正已在正式站）：

- **原頁保留**（`deck_expand_fields_zh` 的 bug）：修改／擴充簡報時，使用者原話沒有要求刪除、展開或調整順序的原頁都要保留（`keepRule`／`matchOriginals`／`keepOriginals`，見 architecture.md「Original pages preserved」）。大綱步驟檢查 `pages_kept`，規劃者自己修一輪後由程式放回漏掉的頁、改回標題與順序；每頁記 `from`（改寫自原第幾頁：revise 的撰寫者讀對的原頁，刪頁後不再錯位）；新的驗收 `kept` 檢查最後的簡報，驗收不能在掉頁時通過。
- **大綱完全失敗時的退路**：第一次全套執行時 `deck_followup_expand` 的 3 次大綱呼叫都把 14k token 花在思考（`outline:budget` 也沒有可解析的 JSON）→ run `failed`。現在最後一輪仍沒有大綱時，照原本的頁面（扣掉要刪的）當大綱繼續做，不再整個失敗。部署後（a7d6e73a）與它依賴的 `deck_translate_en` 一起以 `--into` 重跑；重跑時大綱一次就成功，所以這條退路在 staging 上沒有被觸發到（有整合測試 2c）。
- **評分修正**（`--regrade` 後的結果）：`deck_paper_report` 改成看模板語言；引用鍵也接受 run 中匯入研究的論文（`note_topic_research`、`note_lit_review` 先前把 topic run 匯入、確實在研究文獻庫裡的 5 個鍵算成不存在）；提到文獻庫論文也接受來源行截短的標題（`deck_topic_paper_title` 寫了 4 篇文獻庫論文，其中 2 篇只出現在截短的來源行）。基準用同一套評分重評（`runs/baseline-regraded`，不改 committed 的基準）：**14/20 → 15/20**（只有 `deck_paper_report` 由 FAIL 變 PASS），所以下面的比較在評分上是同一把尺。

**通過 19/20（基準以同評分 15/20）；交付物正確 20/20（17）；run 狀態 done 14/20（9）；確定性評分 59/60（49）；時間中位數 30.5 分（27.9）；模型呼叫 816（834；修正輪／修正類 16.5%，基準 28.2%）；修正輪 35（50）；翻轉 1（1）；評審平均 4.52/5（4.14）。** 18 個任務在 ai-worker image `bcc2dd0c`（本次修正，未含大綱退路），`deck_translate_en`、`deck_followup_expand` 在 `a7d6e73a`（+ 大綱退路）；執行中沒有重新部署。報告：`backend/scripts/eval/runs/p5-kept-pages/`（gitignored）。

| 任務 | 基準 | 本次 | 狀態 | 評分 | 系統驗收 (req) | 分鐘 | 呼叫 | 修正輪 | 評審 | image |
|---|---|---|---|---|---|---|---|---|---|---|
| deck_translate_en | PASS | PASS | partial | 3/3 | 16/17 (1/1) | 40 | 40 | 3 | 4.75 | a7d6 |
| deck_followup_expand | PASS | PASS | partial | 3/3 | 20/20 (4/4) | 25 | 33 | 4 | 4.75 | a7d6 |
| deck_expand_fields_zh | FAIL | **PASS** | done | 3/3 | 19/19 (3/3) | 28 | 31 | 0 | 4.75 | bcc2 |
| deck_add_page | PASS | PASS | partial | 4/4 | 17/18 (2/2) | 36 | 35 | 1 | – | bcc2 |
| deck_exact_pages | PASS | **FAIL** | partial | 3/4 | 15/16 (2/2) | 48 | 50 | 5 | 3.25 | bcc2 |
| deck_remove_page | PASS | PASS | done | 4/4 | 18/18 (2/2) | 14 | 19 | 1 | – | bcc2 |
| deck_topic_paper_title | PASS | PASS | done | 4/4 | 20/20 (6/6) | 44 | 56 | 5 | 4.75 | bcc2 |
| deck_paper_report | FAIL（重評 PASS） | PASS | done | 3/3 | 16/16 (2/2) | 37 | 50 | 0 | 4.25 | bcc2 |
| note_topic_research | FAIL | **PASS** | done | 4/4 | 15/15 (2/2) | 43 | 81 | 0 | 4.5 | bcc2 |
| note_lit_review | PASS | PASS | done | 3/3 | 7/7 (2/2) | 22 | 52 | 2 | 4.75 | bcc2 |
| note_reading | PASS | PASS | done | 3/3 | 5/5 (0/0) | 14 | 47 | 0 | – | bcc2 |
| latex_paper_goal | FAIL | **PASS** | done | 3/3 | 16/16 (6/6) | 39 | 41 | 0 | 4.5 | bcc2 |
| deck_progress_single_paper | PASS | PASS | done | 3/3 | 18/18 (4/4) | 31 | 35 | 2 | – | bcc2 |
| deck_progress_en | PASS | PASS | done | 3/3 | 17/17 (3/3) | 19 | 35 | 4 | – | bcc2 |
| note_en_compare | PASS | PASS | done | 3/3 | 10/10 (4/4) | 44 | 59 | 3 | 4.75 | bcc2 |
| deck_translate_zh | PASS | PASS | done | 2/2 | 17/17 (1/1) | 15 | 24 | 1 | – | bcc2 |
| chat_paraphrase | PASS | PASS | done | 3/3 | 17/17 (3/3) | 30 | 33 | 2 | – | bcc2 |
| deck_missing_pdf | PASS | PASS | needs_pdf | 1/1 | – | 1 | 1 | 0 | – | bcc2 |
| kind_conflict | FAIL | **PASS** | partial | 1/1 | 15/16 (2/2) | 52 | 56 | 2 | – | bcc2 |
| note_generic_metrics | FAIL | **PASS** | done | 3/3 | 8/8 (3/3) | 26 | 38 | 0 | 4.75 | bcc2 |

分析：

- **改善**：`deck_expand_fields_zh`——大綱 9 頁：原 1 頁、「動態熱詞的做法」拆成 4 個方法頁（都標 `from: 2`）、原 3–6 頁照原標題與順序；`kept` 驗收通過，呼叫 49 → 31、修正輪 1 → 0。`deck_followup_expand` 的大綱也保留了全部 6 頁（原頁＋插入 3 個方法頁）。`latex_paper_goal`、`kind_conflict`、`note_generic_metrics`、`note_topic_research` 的進步來自已在正式站的 P2／P3（逐段生成＋程式拼接、Brief 交付物不變量、一次路由決策、主題調研用文獻庫），基準時還沒部署完整。修正類呼叫佔比 28% → 16.5%，done 9 → 14。
- **已修**：`deck_exact_pages` 第一次全套時「對帳」頁留了範本的「〔N〕待補」（寫作者三輪都沒改，`clean` 驗收 → partial）。修法：寫作者提示說明範本〔　〕槽位要依資料算出或刪掉（附今天日期）、修正輪引用沒填的原文；寫入簡報前由程式移除學生自填頁以外仍留下的佔位（投影片上的那一行／`｜` 段／表格列、講稿裡的那一句，`scrubPlaceholders`）。重跑（image `a71222a9`）：PASS、done、43 呼叫（50）、41 分；程式移除了「對帳」「Table 1 現況」各 1 處。**全套因此 20/20。** `deck_translate_en` 這次 40 分（基準 56、第一次全套 18 分）、visual_qa 第 4 頁版面硬傷→ partial，評分仍全過。
- **仍然慢**：時間中位數 30.5 分（共用 2 個槽）；`note_topic_research` 81 次呼叫（`topic_read` 55）。
- 評審是同一個便宜模型，只看相對變化；pairwise 對基準：勝 3（topic 簡報、論文報告、英文筆記）、平 4、負 3（兩個翻譯／接續擴充、`deck_exact_pages`）。

## P5b：把 partial 的根因修掉（2026-10-24 15:52 → 19:16 UTC）

P5 之後 20/20 通過，但 4 個任務的 run 狀態是 `partial`。根因與修正（不改評分門檻；評分只**加嚴**）：

| 任務 | 根因 | 修正 |
|---|---|---|
| `deck_add_page`（126957f2） | 視覺修正重寫比較表頁「Shallow fusion vs. CLAS vs. contextual adapters」，`replaceSlides` 用寬鬆的 `titleMatches`（子字串）找頁 → 同時取代了「Shallow fusion」「Contextual adapters」兩頁：三份相同的比較頁、兩頁不見；`slide_count` 只看頁數、`pages_kept` 與評分 `titles_kept` 也用子字串，全部通過 | `assignTitles`／`findByTitle`（一對一、同標題優先、含其他頁標題的不算）用在所有依標題找頁、換頁的地方；`pages` 驗收（`slide_count` + 大綱標題）與 `slide_titles` 抓缺頁、順序、重複頁（`duplicatePages`），重複時由 writers 的頁重新組裝；評分 `titles_kept` 一對一，新增 `no_duplicates`（6 個簡報編輯任務） |
| `kind_conflict`（95fe95c9） | 有上下標公式的頁「字太小（1px）」：KaTeX 的 `.vlist-s` 支撐元素是 1px 的零寬字元（U+200B，JS `trim()` 不會去掉），worker 的版面量測把它算成文字 | `worker/src/layout-metrics.ts` 忽略零寬字元與 KaTeX 的 `.katex-mathml`（worker 測試重現 1px → 24px） |
| `deck_translate_en`（d2e938cb；重跑 cf7e5321） | p4 狀態時間軸與狀態表重複呈現（視覺 QA 的硬傷「重複呈現」），重寫三輪都保留兩者；重跑時另一個問題：翻譯的「偏高／待驗證」表被版面修正改成編造數字（10 % / 2 %）的長條圖 | `dedupeVisuals`（`fixContent`）：同頁的流程圖若大多是表格第一欄的項目就拿掉圖、圖表與表格同數字就拿掉表；修改既有簡報（revise）時視覺修正只處理硬傷；版面修正帶進頁面與來源都沒有的數字就不採用（`inventedNumbers`）；`<small>`／inline `font-size`／`[x]{.small}` 由程式移除（`deck_expand_fields_zh` 重跑時 15.6px 引用兩輪「字太小」） |
| `deck_followup_expand`（5b112199） | 英文簡報的 writer 把第 5 頁標題寫成中文 → `slide_titles` 失敗、修一輪仍失敗；後面的語言修正把頁修好、驗收全過，但 `outcomeOf` 只要有步驟的確定性檢查失敗就判 partial | writer 頁數對時 `## ` 標題一律設成大綱標題（`outlineHeadings`）；`outcomeOf` 的步驟檢查若被通過的驗收在成品上重新檢查（playbook `coveredChecks`：`slide_titles`/`slide_count`→`pages`、`speaker_notes`→`notes`、`no_placeholder`→`clean`、`not_truncated`→`complete`、`slide_density`/`slide_length`→`visual_qa`）就不算壞步驟（`deck_add_page` 第一次重跑也因 writer 的密度檢查而 partial，成品視覺 QA 通過） |

重跑（ai-worker `a1c6ebb0`，worker `e7cd4517`，`--into runs/p5-kept-pages`）：

| 任務 | 之前 | 之後 | 分鐘 | 呼叫 | 評分 |
|---|---|---|---|---|---|
| deck_add_page | partial（36 分、35 次） | **done** | 23 | 27 | 5/5 |
| deck_translate_en | partial（40、40） | **done** | 15 | 26 | 4/4 |
| deck_followup_expand | partial（25、33） | **done** | 28 | 36 | 4/4 |
| kind_conflict | partial（52、56） | **done** | 25 | 48 | 1/1 |
| deck_remove_page（回歸） | done（14、19） | done | 17 | 19 | 5/5 |
| deck_expand_fields_zh（回歸） | done（28、31） | done | 35 | 33 | 4/4 |

整份報告現在：**通過 20/20、run 狀態 done 19/20（另一個是預期的 `needs_pdf`）、確定性評分 65/65、時間中位數 27.1 分、呼叫 784（修正類 13.8%）、評審 4.57**。評分多了 `no_duplicates`（總數 60 → 65），只會更難通過。

## 已知限制

- 便宜模型 + 共用的 2 個 ai-worker 槽：時間會受其他 agent 的 run 影響（`queued_s` 另記；wall 時間從開始執行算），只比較同條件的兩次執行。
- 評審與被測物同模型；rubric 不給原始來源（翻譯類評審看不到原文），只當輔助訊號。
- `--regrade` 讀回當時存下的成果文字，但簡報種類／編譯狀態等中繼資料是從 hub 重新讀取。
- 改任務的請求文字會讓結果不可比較：改的時候在這份文件記下來，並重跑基準。

## 情境矩陣與不變量稽核（2026-10-25）

20 個固定任務只能抓到它們剛好涵蓋的失敗；正式站對話 79ab0678 的 9 個問題（講稿語言被 standing 蓋掉、放錯研究、澄清回答變主題、6 句要求只抓到 1 句…）全都不在裡面。所以加了一層**不變量**：一個 run 必須滿足的規則，寫成存下來的資料上的純函式（`backend/src/workflows/invariants.ts`，22 條，目錄與每條的正式站例子見 `agent-invariants.md`），同一套規則用在單元測試（79ab0678 兩個 run 的資料形狀）、唯讀稽核（`scripts/audit/run.ts`）和情境矩陣（`scripts/eval/scenarios/`）。

**情境矩陣**：進入點 × 對話歷史 × 說法（含口語無標點）× 12 種意圖 × 各部分語言 × 指代 × 澄清回答 × 啟動方式 → 66 個情境，只跑到計畫卡或路由＋需求完成（`--depth route`：Brief、要求、路由都存好、規劃者又跑了 90 秒沒問問題就停；問研究／論文／交付物的卡片都在大綱之前），檢查全部規則＋情境期望，然後取消。

第一次全套（`runs/scenarios-matrix-1/`，gitignored）：staging 中途被另一個 agent 部署了兩次，66 個情境分屬三個 ai-worker image（a1c6eb 12 個、48adcc 14 個、b5f346 40 個；後者已含 79ab0678 的修正）；前 18 個用 `linyating`，之後改用新建的 `scenario-eval`（同研究的成員），因為 eval runner 佔滿了 linyating 每人 3 個的工作流程上限；ai-worker 兩個槽被 eval 的長流程佔住時，暫時加開一個**同 image** 的 ai-worker 容器（`hubv3-ai-worker-scen`，image 一變就由看門程式停掉，跑完已移除）。每個開始的 run 都已取消（59/59 cancelled）。

| 規則 | 情境數 | 其中最新 image（40） | 代表情境 |
|---|---|---|---|
| `req.clause_coverage` | 18 | 13 | 「大概 8 頁」沒有頁數要求（l58/l60/l62/c50/c53/c56）；「提到方法時要註明論文和會議或期刊」（c55、l61、l63）；「專有名詞／technical terms 保留英文」（a37、a41）；p64＝run A 原文仍漏「統計有哪幾種方法」 |
| `scenario.deck_resolved` | 9 | 7 | 前一個 run 做了簡報、使用者說「這個／剛剛那個／同一個簡報／繼續」→ 沒有 deck_id，被當成新簡報（p66＝run B 原文用交給 Agent） |
| `req.user_words_scope` | 8 | 4 | 先前另一段問答（「CER 和 WER 有什麼差別？」）進了 Brief 的原話 |
| `scenario.part_language` | 6 | 1 | 舊 image：「投影片英文、講稿中文」沒有分部語言要求；最新：「整份 translate 成英文」（中英混）沒有任何要求 |
| `route.wording` / `scenario.new_not_edit` | 4 / 3 | 0 | 舊 image：在簡報頁要「新」簡報（含語言字）被當成修改那份簡報 |
| `scenario.kind` | 3 | 3 | 「幫我整理一份筆記…用我們文獻庫的論文」→ Brief 是 **LaTeX 論文**（c51/c54/c57） |
| `q.not_repeated` | 2 | 2 | 「要寫進哪一份 LaTeX 專案？」回答「你決定」後立刻又問 |
| `ctx.no_derivable_study_question` 等 | 1 | 0 | 舊 image：前一個 run 已在研究裡仍問研究 |
| `scenario.started`（資訊） | 11 | — | 聊天沒有交給工作流程：講稿改中文、刪頁直接用 `suggest_deck_edit`（p65＝run B 原文）；沒有簡報時從首頁說「這個 deck 刪掉卡住」，助理用 search 找到**另一份無關的 eval 簡報**並提議刪頁（g22） |

**稽核**（`scripts/audit/run.ts --staging --since 30d`，211 個 run、153 個對話，唯讀）：扣掉矩陣自己的 run 與種子，44 個 finding：修改簡報的紀錄寫「由「從 0 到 1 建立簡報」執行」18 個 run；partial 說明含「P1…」3 個（含另一個 agent 今天的 eval run）；修正後同樣的驗收（grounded、coverage）又失敗 2 個（674cce09 是今天最新 image）；venue 說成未提供 1 個；smoke 的 c49 舊 image 重現了 run A 的「研究名稱變主題」（新 image 已不再出現）。

跑法與規則目錄：`agent-invariants.md`。改 workflow 之後：`npx tsx scripts/eval/scenarios/run.ts --concurrency 2`（約 2–3 分／情境，取決於 ai-worker 槽），偵測程式改了用 `--recheck <dir>` 重評，不必重跑。

## 正式站對話 79ab0678 的修正（2026-10-25，`runs/p6-conv-79ab`，對照 `p5-kept-pages`）

新任務 3 個＋回歸子集 8 個，staging ai-worker image b5f346be（部分任務跨 48adcc70→b5f346be 的重新部署）。staging 同時有其他人用同一個評估帳號跑 probe，兩個 ai_workflow 槽長時間被佔滿：`deck_study_answer_topic` 兩次都在等槽時逾時（計時從第一次規劃開始，回答研究卡後等了 > 60 分鐘），`kind_conflict` 第一次逾時、重跑通過。

| 任務 | p5 | p6 | 備註 |
|---|---|---|---|
| `deck_spoken_survey`（新） | – | PASS 6/6（partial） | 9/9 頁有會議／期刊、提到文獻庫 9 篇、沒有 efficiency 漂移；系統驗收 18/19 |
| `deck_notes_zh_home`（新） | – | PASS 5/5（done） | 研究從簡報推得、沒有問題、投影片英文＋講稿繁中 |
| `deck_study_answer_topic`（新） | – | FAIL（逾時）4/5 | 研究卡回答沒有進原話／要求、主題來自請求；頁數 10 ≠ 8（「，8 頁」沒被偵測，已修正、未重新部署驗證） |
| `deck_translate_en` | PASS done | PASS partial | grounded：模型把「待驗證」翻成「verified」（評審正確） |
| `deck_add_page` / `deck_remove_page` / `deck_progress_single_paper` / `deck_missing_pdf` | PASS | PASS | 同 |
| `deck_topic_paper_title` | PASS done | PASS partial | 104 分（槽位爭用）；系統驗收 18/19 |
| `note_reading` | PASS done | PASS partial | grounded：「我的想法」AI 代填用了週會筆記的內容，評審的來源沒有研究資料（既有缺口） |
| `kind_conflict` | PASS done | PASS partial | 重跑 33 分 |
