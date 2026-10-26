# Agent 不變量（invariants）：整類問題一次找出來

日期：2026-10-25。起因：使用者一次回報一個 Agent 失敗（簡報還是中文、頁不見、放錯研究、要求被翻成相反、修訂卻出現「從 0 到 1」卡片、澄清問題的回答變成主題…），每次只修那一個。使用者的要求：「我要能夠徹底解決類似的問題不要我提一個問題你再修一個」。

做法：把「一個 run 必須滿足的規則」寫成**純函式**，跑在已經存下來的資料上（`workflow_runs` 的 brief、route、state.asks、plan、criteria、report、status，加上 `workflow_events`、`workflow_steps` 和對話訊息）。同一套規則用在三個地方：

1. **單元測試**：用正式站對話 79ab0678 的兩個 run（0668a3d7、e6d552fc）當 fixture，每條規則都要抓到它的失敗，並且在修好的同一份資料上**不誤報**。
2. **正式站稽核**（唯讀）：跑最近的 run 與對話，依規則分組列出 run id 與證據。
3. **情境矩陣**（staging，只跑到計畫卡或第一個問題）：交叉各種進入點、對話歷史、說法、意圖、語言、指代與澄清回答，產生 73 個情境，每個都檢查全部規則再取消。

程式：

| 檔案 | 內容 |
|---|---|
| `backend/src/workflows/invariants.ts` | 規則目錄（`INVARIANTS`）、`checkRun(bundle)`、`checkConversation(bundle)`、斷句與語言判讀等工具；純函式，不呼叫模型、不碰資料庫 |
| `backend/test/invariants.unit.test.ts` + `test/fixtures/invariants/conv-79ab0678.json` | 正式站兩個 run 的資料形狀（已去掉使用者 id／email、長文字截短）；每條規則一個「抓得到」＋一個「修好後不誤報」 |
| `backend/scripts/audit/load.ts` | 唯讀載入：連線帶 `default_transaction_read_only=on`、整段在 `BEGIN READ ONLY` 裡、只接受 SELECT／WITH |
| `backend/scripts/audit/run.ts` | 稽核 CLI：`--db <url>`（或 `AUDIT_DB_URL`，或 `--staging`）、`--since 7d`、`--runs`、`--conversations`、`--user`、`--only`；輸出 `audit.md` + `audit.json` |
| `backend/scripts/eval/scenarios/{matrix,seed,oracles,run}.ts` | 情境矩陣：產生器、情境準備（staging）、情境專屬期望、執行器 |

規則刻意**不重用** workflow 的程式（brief.ts、requirements.ts、route.ts…）：自己重新讀存下來的形狀，被測物的 bug 不會傳給檢查者。存下來的形狀都是寬鬆型別（欄位可有可無），新舊 run 都能讀。

## 規則目錄

嚴重度：critical = 使用者會拿到錯的東西或卡住；high = 明顯違反使用者的話或浪費一輪；medium = 說明／用詞問題。單一 finding 可以降級（例如只出現在紀錄裡的用詞問題 = medium）。

| id | 類別 | 嚴重度 | 規則 | 讀什麼 | 正式站例子 |
|---|---|---|---|---|---|
| `route.no_new_artifact_option` | 路由 | critical | 修改既有成果（route.deck=edit／edit／plan.edit_kind）的卡片不能有「新建成果」或「改做別種成果」的選項（「仍做簡報：用研究的文獻庫…」、「改做筆記」、value `topic`／`switch`） | state.route、asks 的選項 | e6d552fc：講稿改中文，卡片給「仍做簡報（新主題簡報）／改做筆記」 |
| `route.wording` | 路由 | high（只在紀錄 = medium） | 修改時卡片、問題、通知、紀錄、計畫、標題不能用「從 0 到 1／建立簡報／新簡報／主題簡報」；寫到「Agent 草稿」副本的計畫寫入是設計，不算 | asks、question、plan_question、log、notice、plan | e6d552fc：「「從 0 到 1 建立簡報」需要的資料不足」 |
| `route.plan_matches` | 路由 | high | 修改路由的計畫不能寫一份新簡報（「Agent 草稿」副本除外）；新建路由不能覆蓋；plan.edit_kind = route.edit | route、plan.writes、plan.edit_kind | — |
| `deliverable.consistent` | 交付物 | critical | Brief 的交付物 = 路由的種類 = 計畫寫入 = 實際成果（目標的階段 run 不比成果） | brief.deliverable、route.kind、plan.writes、artifacts | 50b49d80 類（簡報變筆記） |
| `req.clause_coverage` | 要求 | high（主題句 = medium） | 使用者這次每一句有內容的話，都對應到一條要求（引用它、或型別參數在講它），或被明確列為不採用（`state.requirements_dropped`）；只說「幫我做一個簡報／幫我改」的核心句不算；新建成果的主題句由主題帶著 | 這個任務的原話、要求的 quote、dropped、主題欄位 | 0668a3d7：6 句要求只抓到語言 1 句 |
| `req.contradicts_newest` | 要求 | critical | 要求不能違反使用者最新的話：語言分「投影片／講稿／整份」，越新的話越優先；頁數 | 原話（新到舊）、language 要求的 part、page_count | e6d552fc：講稿要中文，要求是整份英文 |
| `req.standing_not_override` | 要求 | high | 沿用的設定（source standing）在使用者這次有講的維度上，不能是唯一生效的那條 | standing 要求、原話的語言／頁數 | e6d552fc：只有「沿用這份簡報的英文設定」 |
| `req.setup_not_content` | 要求 | high（進入原話 = medium） | 設定問題（哪個研究、哪篇論文）的回答不能變成要求、原話或主題（state.topic_title、topic.topic、標題、封面）；進度簡報用研究名稱當標題可以 | 設定問題、guidance（含 `setup`）、「（回答「…」）」行、要求、主題欄位 | 0668a3d7：研究名稱「…動態熱詞效率研究」變成主題與標題 |
| `req.user_words_scope` | 要求 | high | Brief 的原話只能是這個任務的話：啟動前連續的使用者訊息（中間是助理的澄清問題也算），加上 guidance；之前另一段問答、「ok」不算 | brief.user_words、啟動 start_workflow 前後的訊息 | e6d552fc：原話含「偏向 Hot Word 還是 Contextual Biasing」與「ok」 |
| `input.material_used` | 輸入 | critical（拿到卻沒讀、或簡報走了主題調研 = high） | 使用者在這個任務的訊息附加了檔案／筆記、貼了長篇內容，或說「附件／我上傳的／deep research 結果」而對話有上傳過檔案：run 的 `inputs.materials`（或附加筆記的 note_ids）要有它、規劃時要讀過（`state.material.read_at`）；有資料時簡報不能走主題調研（route.deck = topic），除非使用者要搜尋 | 任務訊息的 attachments／長度、原話、inputs.materials、state.material、state.route.deck | 301b6e1a：附了 deep research 檔、說「以此做成簡報」，inputs 只有 study，主題路線線上搜尋並匯入兩篇論文，檔案從沒被讀 |
| `deck.cover_repeated` | 交付物 | high | 新簡報第 1 頁的標題不能和封面（front matter）一樣，相鄰兩頁標題也不能一樣；修改既有簡報不檢查 | state.deck.body（沒有就看 plan.outline）、state.front_title／plan.front_title／state.cover_title | 301b6e1a：第 1、2 頁同標題（主題簡報的「題目」頁＋系統封面） |
| `assistant.no_confirm_under_autopilot` | 助理 | high | 自動駕駛開啟（計畫自動核准）時，助理在啟動那一輪不能叫使用者確認計畫 | run.autopilot、start 那則之後到下一則使用者訊息之間的助理文字 | 301b6e1a：「計畫卡片準備好後請確認」 |
| `ctx.input_artifact_study` | 脈絡 | critical | 有輸入成果（deck_id、note_id(s)、project_id）就在那個成果的研究裡 | inputs → 成果的 study_id、run.study_id | e6d552fc：簡報在 654c8823，run 的研究是空的 |
| `ctx.no_derivable_study_question` | 脈絡 | critical | 研究推得出來（輸入成果、對話的研究、頁面、訊息的 page_context、同對話較早的 run）就不能問「放在哪個研究」 | 問過的問題、以上來源 | e6d552fc |
| `q.not_repeated` | 問題 | high | 回答過後不能再問同一個問題（文字 bigram 涵蓋 ≥ 60%；卡片的 intro 也算） | 狀態快照的 question、plan_question、asks、guidance／卡片回答時間 | e6d552fc：回答「就剛剛的那個研究…」後又問一次 |
| `q.options_match` | 問題 | high（要寫字卻只有選項 = medium） | 問研究就要列研究、問論文就要列論文（或「不指定」）；要使用者「寫」卻只有選項 | asks 的題目／intro vs 選項、使用者的研究、文獻庫 | e6d552fc：問研究，選項是「仍做簡報／改做筆記／先停下來」 |
| `q.options_route` | 問題 | high | 不是交付物卡片卻提供改變交付物的選項；「仍做 X」的 X 必須是 Brief 的交付物 | asks、brief.deliverable | — |
| `repair.same_failures` | 修正 | high | 步驟連兩輪失敗相同還繼續修第三輪；最終驗收修正（含「修」）後同樣的項目又失敗 | steps.inputs.conv.rounds、完成時的 criteria 快照 | 0668a3d7：grounded、coverage 修完原樣失敗 |
| `repair.structural_not_rewrite` | 修正 | high（還沒修 = medium） | 結構性失敗（缺少某類、涵蓋不足、找不到來源）不能送去重寫頁面；只給「修」也算 | 失敗理由、之後的 writer 重跑紀錄、下一次驗收 | 0668a3d7：分類不完整來自只讀 4 篇，重寫無效 |
| `repair.actionable_reason` | 修正 | medium | 失敗理由要指出哪個數字、哪一頁 | criteria 的 reason | 0668a3d7：「此數字…找不到對應來源」 |
| `outcome.partial_explained` | 結果 | high | partial 要用使用者看得懂的話說明（不含 approved_outline、P1…、req_x、write_3、budget_*…）；預算停止要講 | report.issues、stop_reason | 0668a3d7：「approved_outline」「P1…」 |
| `outcome.not_stuck_awaiting` | 結果 | high | 使用者回答後超過 10 分鐘仍停在 awaiting_input、之後沒有進展 | 回答時間、之後的狀態快照 | e6d552fc：卡了一小時以上 |
| `assistant.read_before_claim` | 助理 | high | 使用者問成果內容時，助理談內容（列出 ≥ 2 項＋涵蓋／包括…）之前，同一輪要有讀內容的工具（get_deck、get_deck_pages、get_note、read_paper…；get_workflow 不算） | 對話訊息與工具呼叫 | 79ab0678：只呼叫 get_workflow 就說簡報涵蓋 density-ratio |
| `assistant.target_grounded` | 助理 | critical | 助理對某份成果（deck_id／note_id／project_id）呼叫會動手的工具（start_workflow、suggest_deck_edit、刪除…）時，那份成果要是這個對話的（頁面、這個對話的 run 的 inputs／artifacts、create_* 的結果）或使用者指定的；只在搜尋／列表結果出現過的不行 | 對話訊息的工具呼叫與結果、page_context、對話的 runs | 情境 g22：沒開簡報，助理搜尋後挑了無關的評估集簡報並提議刪頁 |
| `grounding.library_fields` | 依據 | high | 文獻庫有 venue／year 時，不能說「venue 未提供」（說法數超過真的沒有 venue 的篇數才算） | 文獻庫欄位、步驟輸出、topic picks、report、criteria | 0668a3d7：10/10 有 venue，8 處說未提供 |
| `grounding.library_coverage` | 依據 | medium | 要用文獻庫整理、且有 PDF 的論文 ≤ 12 篇時，讀到的要 ≥ 60% | 原話、文獻庫、state.topic.picks | 0668a3d7：10 篇只讀 4 篇 |

情境矩陣另有**情境專屬期望**（`scripts/eval/scenarios/oracles.ts`，id `scenario.*`）：`scenario.kind`（交付物種類）、`scenario.deck_resolved`（從頁面／前一個 run／指代找到要改的那份簡報）、`scenario.edit_route`、`scenario.edit_kind`、`scenario.new_not_edit`（在簡報頁要「新」簡報不能變成修改那份）、`scenario.study_resolved`、`scenario.part_language`（投影片／講稿的語言照使用者講的）、`scenario.started`（聊天要交給工作流程）、`scenario.reached_plan`、`scenario.material_input`（使用者提供的資料要進 inputs.materials）、`scenario.material_route`（用資料做簡報要走 material 路線；用資料寫筆記不能變成線上主題調研）。

### 關鍵的判讀工具（`invariants.ts`）

- `clauses` / `contentClauses`：斷句也處理**沒有標點的口語轉寫**——標點之外，用「並且、還有、然後、那請你、我要、當然、你應該要…」這些開始新要求的連接詞切；太短的片段併到下一句。0668a3d7 的請求切成 9 句，只有「我要你幫我做一個簡報」是核心句。
- `languageClaims`：每句判斷講的是講稿、投影片還是整份，以及中文／英文；「多用英文的專有名詞」是名詞用法，不是語言要求。
- `taskTurns`：從 start_workflow 的 tool_result 找回是哪一則助理訊息啟動了這個 run，往回收連續的使用者訊息（中間若是助理的澄清問題就繼續往回），遇到助理的回答就停。
- `setupAnswers`：問過「哪個研究／哪篇論文」之後，短的回答若是研究／論文名稱、「剛剛那個」「你決定」，或 guidance 帶 `setup`、或「（回答「哪個研究…」）」行，就是設定回答。

## 正式站稽核（唯讀）

```bash
cd backend
npx tsx scripts/audit/run.ts --db "$AUDIT_DB_URL" --since 7d --out /tmp/audit
npx tsx scripts/audit/run.ts --db … --conversations 79ab0678-e29e-4f51-9541-e53bce99970d
npx tsx scripts/audit/run.ts --staging --since 30d          # staging（hubv3 的 db 容器位址 + .env.staging 的密碼；不讀 .env）
```

- 偵測全部是確定性程式；**不對正式站資料呼叫任何模型**。
- 連線參數 `default_transaction_read_only=on`、`BEGIN READ ONLY`、載入器只接受 SELECT／WITH；大欄位在 SQL 裡就截短（狀態快照只取 status／question／criteria；步驟輸出只取含 venue／會議／期刊／年份的行；工具結果取前 600 字）。
- `workflow_events` 在 run 結束 7 天後清掉：超過 7 天的 run 少了快照類規則（q.not_repeated、repair.same_failures 的最終輪部分），其餘照跑。

### 每日稽核的掛點（提案，尚未接線）

放在 ai-worker（它已經有 DB 連線與排程迴圈），不要放在 backend 的請求路徑：

1. ai-worker 啟動時註冊一個每日（台北 04:00）的計時器，或新增 job kind `ai_invariant_audit`（由 `jobs` 表排程，`run_after` = 下一個 04:00；完成後自己排下一次），用唯讀的 DB 角色連線（建議新角色 `hub_audit`：只有相關表的 SELECT）。
2. 跑 `loadRuns({since: 前 26 小時})` + `loadBundles` + `checkRun`／`checkConversation`（`load.ts` 與 `invariants.ts` 直接重用；`load.ts` 需搬到 `src/` 才能進 image）。
3. 結果寫到新表 `invariant_audits {id, ran_at, window, runs_checked, findings jsonb, by_invariant jsonb}`（migration `NNNN_invariant_audits.sql`；保留 30 天）——這是唯一的寫入，而且寫在稽核自己的表。
4. 管理頁 `/admin/agent-quality`（`requireAdmin`）：每條規則的每日次數趨勢、點進去看 run id＋證據＋連到 run 卡片；critical 新增時給管理員站內通知。
5. 新增一條規則 = 在 `INVARIANTS` 加一個物件＋單元測試；稽核、矩陣、管理頁自動帶到。

## 情境矩陣（staging，只到計畫卡）

```bash
cd backend
npx tsx scripts/eval/scenarios/matrix.ts                    # 列出 73 個情境與每個維度的覆蓋
npx tsx scripts/eval/scenarios/run.ts --concurrency 2       # 全部；--only id,id / --match regex / --resume <dir>
npx tsx scripts/eval/scenarios/run.ts --resume <dir> --sweep # 取消某次執行留下的 run
```

維度：進入點（首頁無研究、研究頁、簡報頁）× 對話歷史（無、前一個 run 做了這份簡報、無關的先前問答）× 說法（打字有標點、口語無標點、英文、中英混）× 意圖（新進度／論文報告／主題簡報、只改講稿語言、只改投影片語言、展開方法、加頁、刪頁、翻譯、筆記、文獻回顧、LaTeX 章節）× 各部分語言（投影片英文＋講稿中文、全中文、全英文、未講）× 指代（「剛剛那個」「同一個簡報」「繼續」）× 澄清回答（研究名稱、「你決定」、自由文字）× 啟動方式（交給 Agent、聊天）。產生方式：意圖 × 進入點的完整格子（36）其他維度輪替，加上指代（12）、澄清回答（9）、各部分語言（6）、正式站兩個請求原文（3：run A；run B 含那段無關問答與「ok」；run B 用交給 Agent），以及**使用者提供的資料**（7，301b6e1a）：附件＋「以此做成簡報」（聊天、交給 Agent 從首頁用正式站那句話的形式、英文）、貼上的筆記、「用我上傳的 PDF」（PDF 先上傳到對話、這一輪沒有附加；聊天與口語交給 Agent）、附件整理成筆記。資料是合成的（`scripts/eval/material-fixture.ts`：deep research 風格的 Markdown、一份最小的英文 PDF、貼上的實驗筆記），不含正式站內容。

執行器：每個情境開新對話（autopilot 關）、建一份固定簡報的副本、準備歷史（「前一個 run 做了這份簡報」是直接在 staging 插入一段完成的交給 Agent 紀錄＋一列 done 的 `workflow_runs`＋英文簡報的 standing 偏好，和真的 run 留下的資料一樣，不必每個情境跑一次完整流程）、照使用者的方式啟動、等到計畫卡或第一個問題（遇到問題用該情境的回答方式答一次，再等）、唯讀讀回 run 檢查全部規則＋情境期望、取消。每個開始的 run 先記在 `started.json`，結束、Ctrl-C 都會取消；staging 中途重新部署時 API 會重試，基礎設施中斷的情境重跑一次。

結果與分析見 `docs/research/agent-eval.md`「情境矩陣與不變量稽核」。
