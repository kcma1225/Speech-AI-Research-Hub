# 研究：為什麼我們的 Agent 一直「部分完成」、做錯東西、跑很久 —— 業界怎麼做，以及改造方案

日期：2026-10-23。依據五份研究（全文在 session scratchpad `research/r1–r5`，主要結論與出處整理於本文）：

- R1 Anthropic／Cognition／Manus 的規劃與上下文設計
- R2 OpenAI Deep Research／Codex、Google Gemini Deep Research／TTD-DR、Devin、OpenHands、12-factor agents
- R3 簡報與長文件生成 agent（Gamma、Kimi、Copilot、PPTAgent、AutoPresent、PosterAgent、STORM、LongWriter…）
- R4 驗收迴圈的研究（Self-Refine、Reflexion、CRITIC、LLM-as-judge 偏誤、checklist 評估）
- R5 我們自己的稽核：2026-10-21 以來正式站全部 67 個工作流程（唯讀）

---

## 1. 結論（一頁版）

**我們的問題不是個別 bug，而是架構違反了業界幾條已被驗證的原則。** 正式站 67 個工作流程只有 **2 個（3%）完成**，62 個「部分完成」；中位數 14 分鐘、60 次模型呼叫，最長 115 分鐘、215 次。花費最多的不是寫內容，而是**不會收斂的修正迴圈**：52% 的步驟執行是修正輪，其中 43% 的問題和上一輪一模一樣；最終修正「修好 63 條、改壞 55 條」，幾乎是零和。

五個根本原因（依代價排序）：

| # | 根本原因 | 我們的證據 | 業界怎麼說 |
|---|---|---|---|
| 1 | **三層 LLM 評審都能卡關，卻沒有收斂控制** | 步驟驗收、截圖檢查、最終驗收都能讓整個流程「部分完成」；80% 的問題被標「嚴重」；修 3 輪、再最終修、再自動駕駛加一輪 | 沒有外部訊號的自我修正常越改越差（GPT-4 在 GSM8K 兩輪後 95.5→89.0）；增益集中在前 1–2 輪；要回傳**最好的版本**而不是最後一版；「叫審查者找缺口，它一定找得到」 |
| 2 | **審查者看到的資料比撰寫者少** | 撰寫者拿 30k 字的資料，審查者只拿 16k；論文原文節錄放在最後被截掉；≥21% 的問題在要求來源裡「沒有」的東西 | 審查者要有參考資料（grounded judge），問「X 有沒有支持這句」，而不是「好不好」；引用必須逐字找得到 |
| 3 | **交付物不是硬性約束** | 簡報、LaTeX 被 fallback 悄悄變成筆記（c1b9a129、a3b59ddd、50b49d80） | 在對話外存一份「需求簡報／驗收紀錄」，agent 不能改；完成與否由程式檢查，不由 agent 自己宣布 |
| 4 | **你的意圖被一層層重新詮釋** | 助理改寫後的請求中位數是你原話的 5.7 倍；之後路由、驗收標準、需求、目標階段各自再讀一次；約 15 層會做決定，其中 7 層各自重新解讀 | 先釐清一次，寫成一份固定的 brief（保留使用者原話、格式、語言、長度），每一步都帶著它；子 agent 的任務說明要完整 |
| 5 | **固定流程 + LLM 路由 + 一次寫完長文** | 寫作呼叫 19% 撞到輸出上限被截斷；修正輪又整份重寫；一個 deck 平均重新編譯 16 次，截圖檢查佔簡報流程 31% 時間且只過 15/48 | 長文要「先大綱與每段預算，再逐段寫」；只重寫有問題的那一段；簡報逐頁生成、只重驗有改的頁、每頁修正上限 2–3 輪 |

---

## 2. 業界的共同做法（我們該遵守的原則）

整理自 R1–R4，取五份報告交集最高的原則：

### 2.1 意圖與計畫
1. **先釐清一次，再寫成固定的 brief。** OpenAI Deep Research：先分流 → 問少量釐清問題 → 改寫成研究 brief → 一個長的研究迴圈；brief 要保留使用者每個偏好、明確標出「未指定」而不是自己編、寫明格式與語言。
2. **brief／驗收清單存在對話外、agent 不能改。** Anthropic 長時間任務：計畫是一份 JSON 功能清單，agent 只能把 `passes` 從 false 改成 true。Codex 社群回報：壓縮上下文後弄丟原本的驗收目標、把自己寫的測試當成完成證據——解法就是對話外的固定驗收紀錄。
3. **先給使用者一份可編輯的計畫／大綱。** Gemini、ChatGPT Deep Research、Devin、Gamma、Kimi、Copilot 都這樣做；大綱決定連貫性（PPTAgent 拿掉大綱後連貫度 4.48→3.36）。
4. **把計畫「背誦」在上下文裡。** Manus 每步重寫 `todo.md`，讓目標一直在注意力範圍內。

### 2.2 執行結構
5. **用最簡單能用的結構。** 步驟已知就用固定流程，開放式才用 agent 迴圈（Anthropic）。
6. **寫入單執行緒。** Cognition：「行動帶著隱含的決定」；可行的多 agent 是「子 agent 只讀／研究／審查，一個 agent 擁有一份成品」。
7. **子 agent 的 brief 要完整**：目標、輸出格式、可用工具與來源、邊界、所有已決定的事（Anthropic、Claude Code）。我們目前子 agent 的步驟說明平均只有 100 字。
8. **每個項目一個新上下文。** Manus：同一個上下文處理第 8–9 項開始亂編。
9. **長輸出按大綱與預算逐段寫**（LongWriter/AgentWrite、STORM、TTD-DR「先草稿再用證據修訂」）；偵測截斷只重生那一段；永遠不要為了改一部分而整份重寫。
10. **簡報：LLM 只選版型、不出座標；用宣告式格式（Quarto/HTML）；圖表保留成資料＋程式碼。**

### 2.3 驗收與停止
11. **先做程式檢查**（頁數、語言、必要欄位、引用存在、編譯／渲染成功），LLM 評審只負責程式檢查不了的。
12. **沒有外部訊號就不要叫模型自我批評**；只在有具體失敗理由時修正。
13. **修正預設 2 輪、上限 3 輪；沒有進步（同樣的失敗）就停；回傳最好的版本。**
14. **評審用逐條「是／否」清單**（TICK、CheckEval），每條對應使用者自己的要求；不要 1–10 分的整體分數。
15. **評審要先引用證據再下判斷**，而且程式要檢查引用真的存在；找不到的就丟掉那條意見。
16. **完成由程式判定，不由 agent 自己宣布**；回報要附證據。
17. **全部都要有上限**：每步、每次執行的回合與時間；同一工具連續錯 3 次就停；重複動作／重複問題偵測；碰到上限就停下來給「部分結果＋問使用者」，不要默默重試。
18. **一次執行一份事件紀錄**，可以暫停、續跑、只重試某一步。

---

## 3. 我們的系統對照（R5 稽核）

### 3.1 會做決定的層（意圖在這些地方被重新詮釋）
助理 LLM → start_workflow／start_goal 的路由 → playbook detect → playbook 自己的 mode 判斷（例如 paper_report）→ 規劃（大綱）→ 需求擷取 → 每步驗收 → 問題清單 ledger → 第二意見 → 最終驗收 → 最終修正 → 截圖視覺檢查 → 自動駕駛加輪 → 目標重新規劃。

**沒有一份貫穿全程、帶著「交付物種類＋你的原話」的 brief**，每一層都從前一層改寫過的文字重新理解。

### 3.2 已發生的代表案例
| 執行 | 發生什麼 |
|---|---|
| 50b49d80（仍在跑） | 你要英文簡報 → 「paper title」字樣讓簡報流程誤判成「單篇論文報告」→ 問「哪一篇」→ 你說自己去找 → fallback 變成一般流程 → 一小時都在寫一份 Markdown 筆記 |
| a4a9be0a | 115 分鐘、172 次呼叫、最終驗收 7 輪（2→3→3→3→3→5→2）、簡報修訂 64 次 |
| b1d94e79 | 215 次呼叫，最終驗收 9 輪，結果在 1–4 項之間來回 |
| 00bd5d93 | 視覺模型給 4.9/5，卻被「空白帶 > 35%」程式規則判不通過 → 整份部分完成 |
| 0f427194 | 「寫第 1–3 頁」的步驟寫出 8 頁，因為它拿到的是整份請求 |
| 目標 12a6578b | 計畫 3 階段，實際跑了 9 個，其中 7 個是重複的調研 |
| 5 個執行 | 所有驗收標準都通過，卻因為「每一步都要 passed」而顯示部分完成 |

### 3.3 可觀測性缺口
`ai_call_log` 沒有記錄每次呼叫的用途（撰寫／驗收／修正／看圖）與步驟，所以無法直接量出每個階段花多少。

---

## 4. 改造方案（依優先序）

原則：**不再一個個打補丁**，而是把上面的原則做成架構。

### P0 — 一份固定的 Brief（意圖的唯一來源）
- 開始任何工作前產生 **Brief**：交付物種類（deck／note／LaTeX…，硬性）、你的**原話**（逐字保存）、明確要求（語言、頁數、主題、欄位…，每條引用你的原話）、未指定的事項標「未指定」、驗收清單（逐條是／否）。
- 只有在缺關鍵資訊時問一次（多選題卡片）；助理的改寫只能當「建議」，不能新增你沒說的要求。
- Brief 存在 DB、版本化；**agent 不能改**，只有你在卡片上確認才產生新版本。每個子 agent 都拿到完整 Brief（不是 100 字的步驟說明）。
- **交付物種類是不變量**：任何路由或 fallback 改變交付物種類 → 直接停下來問，不准默默換。

### P1 — 驗收重做：程式檢查為主、LLM 評審為輔、明確收斂
- 驗收清單分兩類：**程式可檢查**（頁數、語言、欄位、引用存在、編譯／渲染、版面量測）與**需判斷**（逐條是／否、必須引用證據、引用經程式比對）。
- 只有**程式檢查失敗**或**有證據的判斷失敗**才觸發修正；評審拿到與撰寫者**完全相同**的來源（同一份、不截斷順序錯位）。
- **每個單位最多 2 輪**（硬上限 3）；同樣的失敗重複出現立即停；**保留最好的版本**（以清單通過數評分），不是最後一版。
- 取消「最終修正→再全部重跑」與「自動駕駛加一輪」的疊加：最終只針對有證據、可修的單位，最多 1 次。
- 「完成」= 必要的程式檢查全過＋需判斷的清單過門檻；不再要求「每一步都 passed」。
- 截圖視覺檢查從「整份全頁卡關」改成「逐頁、只重驗有改的頁、每頁上限 2 輪、評分與程式規則衝突時以評分為主並記錄」。

### P2 — 長輸出與簡報管線
- 所有長文件與簡報：**大綱（每段／每頁有目的、重點、來源、字數預算）→ 逐段／逐頁生成（新上下文，帶大綱＋相鄰頁摘要）→ 偵測截斷只重生那一段**；整合由程式拼接，不再叫模型整份重寫。
- 簡報：LLM 只選版型＋填內容；過長用固定縮放變體讓視覺模型挑。
- 研究類：每篇論文一個新上下文的萃取（已有雛形），寫作只拿需要的部分。

### P3 — 路由簡化與單一主迴圈
- 把「先選 playbook」改成「先確定交付物＋ Brief」，playbook 只是執行某種交付物的工具組；沒有適用的就問，不 fallback 到一般流程。
- 目標（多階段）沿用，但每次重新規劃都要對照 Brief，不能新增 Brief 沒有的階段類型；重複階段上限。

### P4 — 可觀測性與評估
- `ai_call_log` 加上 purpose、step_id、round；報告顯示每步時間、輪數、停止原因。
- 建立固定的評估集（約 20 個真實任務：英文簡報、主題調研、加一頁、論文…），每次改架構都跑一遍，追蹤「完成率、時間、呼叫數、改壞率（對→錯的翻轉）」。

### 預期效果
- 交付物錯置：消失（不變量＋停下來問）。
- 呼叫數與時間：修正輪佔比從 52% 降到 ≤ 20%（2 輪上限＋同問題即停＋只重驗有改的單位）。
- 「部分完成」的意義：只代表真的有未達成的要求，並附證據。

### 建議施工順序
1. P0 Brief＋交付物不變量（最根本，也修好 50b49d80 那類問題）。
2. P1 驗收重做（成本最大的一塊）。
3. P2 逐段／逐頁生成與截斷處理。
4. P4 評估集與紀錄（和 1–3 同步建立，用來驗證改造是否真的變好）。
5. P3 路由簡化。

---

## 5. 主要出處
- Anthropic: Building effective agents; How we built our multi-agent research system; Effective context engineering for AI agents; Effective harnesses for long-running agents; Claude Code best practices; Agent SDK subagents; Writing tools for agents.
- Cognition: Don't Build Multi-Agents; Multi-agents working; Devin + Sonnet 4.5 lessons.
- Manus: Context Engineering for AI Agents; Wide Research.
- OpenAI: Deep Research API cookbook; Agents SDK; Codex compaction/goal-loss community thread; "Why Language Models Hallucinate".
- Google: Gemini Deep Research; TTD-DR (Deep Researcher with Test-Time Diffusion).
- OpenHands condenser and stuck detector; 12-factor agents; LangChain planning/reflection agents.
- Slides/docs: PPTAgent, AutoPresent/SlidesBench, Paper2Poster/PosterAgent, Paper2Video, SlideGen, PresentBench, D2S, DOC2PPT, LongWriter/AgentWrite, STORM, Copilot in PowerPoint, Kimi Slides.
- Verification: Self-Refine, Reflexion, CRITIC, Huang et al. 2023, Tyen et al. 2023, Kamoi et al. 2024, MT-Bench judge, LLMs are not Fair Evaluators, self-preference, TICK, CheckEval, RocketEval, SAFE, PoLL juries, "One Token to Fool LLM-as-a-Judge".
（各篇 URL 見 scratchpad `research/r1–r4` 的 Sources 段。）
