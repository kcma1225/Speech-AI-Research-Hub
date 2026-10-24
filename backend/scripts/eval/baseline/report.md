# Agent eval 2026-10-23T16-41-32

- Hub: http://127.0.0.1:18090（使用者 linyating）；2026-10-23T16:41:32.543Z → 2026-10-24T01:26:20.335Z；選擇：all; re-run 2026-10-23T23-39-25: only deck_translate_en,deck_followup_expand,deck_add_page,note_en_compare; regraded 2026-10-24T01:35
- 部署版本（ai-worker image / 本機 git）：4232638b6ab1 @ 2026-10-23T16:01:50.97619738Z / b547fff+dirty；e474128d9df5 @ 2026-10-23T17:13:48.499931846Z / b547fff+dirty；9441a37e8a71 @ 2026-10-23T19:23:06.358357348Z / b547fff+dirty；3ab300da254d @ 2026-10-23T21:00:17.099125721Z / b547fff+dirty；f3565b40eb9f @ 2026-10-23T21:26:25.048376664Z / b547fff+dirty；ad3e62833088 @ 2026-10-23T22:53:22.552869956Z / b547fff+dirty；e7fb9fc1d8f9 @ 2026-10-24T00:24:37.178486915Z / b547fff+dirty；e7fb9fc1d8f9 @ 2026-10-24T00:24:37.178486915Z / 6987144
- 通過 14/20；交付物正確 17/20；狀態 done 9/20；程式檢查 48/60
- 時間中位數 27.9 分；模型呼叫 834（修正輪／修正類 28.2%）；修正輪 50；翻轉（對→錯）1；評審平均 4.14/5

| 任務 | 結果 | 狀態 | 交付物 | 程式檢查 | 系統驗收 (req) | 分鐘 | 呼叫 | 修正輪 | 翻轉 | 評審 | 版本 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `deck_translate_en` | PASS | done | ✓ deck | 3/3 | 16/16 (1/1) | 55.6 | 28 | 1 | 0 | 4.25 | ad3e62833088→e7fb9fc1d8f9 |
| `deck_followup_expand` | PASS | partial | ✓ deck | 3/3 | 18/19 (4/4) | 49.6 | 44 | 5 | 0 | 4.25 | e7fb9fc1d8f9 |
| `deck_expand_fields_zh` | FAIL | partial | ✓ deck | 2/3 | 18/18 (3/3) | 37.4 | 49 | 1 | 0 | 5 | e474128d9df5→9441a37e8a71 |
| `deck_add_page` | PASS | partial | ✓ deck | 4/4 | 17/18 (3/3) | 51.4 | 39 | 4 | 0 | – | ad3e62833088→e7fb9fc1d8f9 |
| `deck_exact_pages` | PASS | partial | ✓ deck | 4/4 | 14/15 (1/1) | 33.8 | 48 | 5 | 0 | 4.25 | 9441a37e8a71 |
| `deck_remove_page` | PASS | done | ✓ deck | 4/4 | 17/17 (2/2) | 19.1 | 25 | 1 | 0 | – | 9441a37e8a71 |
| `deck_topic_paper_title` | PASS | done | ✓ deck | 4/4 | 19/19 (5/5) | 15.4 | 17 | 1 | 0 | 4.75 | 4232638b6ab1 |
| `deck_paper_report` | FAIL | partial | ✓ deck | 2/3 | 16/16 (2/2) | 33.8 | 64 | 5 | 0 | 3.75 | 4232638b6ab1→e474128d9df5 |
| `note_topic_research` | FAIL | awaiting_input | ✗ — | 0/4 | – | 5 | 4 | 0 | 0 | – | 4232638b6ab1 |
| `note_lit_review` | PASS | done | ✓ note | 3/3 | 7/7 (2/2) | 15.2 | 50 | 0 | 0 | 4.75 | e474128d9df5 |
| `note_reading` | PASS | partial | ✓ note | 3/3 | 6/7 (2/2) | 20.7 | 86 | 2 | 0 | – | 9441a37e8a71→3ab300da254d |
| `latex_paper_goal` | FAIL | partial | ✓ note+latex | 1/3 | 13/15 (6/6) | 66.8 | 68 | 4 | 0 | 1.75 | 4232638b6ab1→e474128d9df5 |
| `deck_progress_single_paper` | PASS | partial | ✓ deck | 3/3 | 15/17 (3/3) | 44.8 | 52 | 4 | 1 | – | 9441a37e8a71→f3565b40eb9f |
| `deck_progress_en` | PASS | done | ✓ deck | 3/3 | 17/17 (3/3) | 29 | 45 | 5 | 0 | – | 3ab300da254d→f3565b40eb9f |
| `note_en_compare` | PASS | done | ✓ note | 3/3 | 10/10 (4/4) | 26.4 | 60 | 4 | 0 | 4.5 | e7fb9fc1d8f9 |
| `deck_translate_zh` | PASS | done | ✓ deck | 2/2 | 16/16 (1/1) | 12.6 | 23 | 1 | 0 | – | f3565b40eb9f |
| `chat_paraphrase` | PASS | done | ✓ deck | 3/3 | 17/17 (3/3) | 49 | 46 | 3 | 0 | – | f3565b40eb9f→ad3e62833088 |
| `deck_missing_pdf` | PASS | needs_pdf | ✓ — | 1/1 | – | 0.5 | 1 | 0 | 0 | – | f3565b40eb9f |
| `kind_conflict` | FAIL | done | ✗ note | 0/1 | 7/7 (2/2) | 26.8 | 84 | 4 | 0 | – | f3565b40eb9f→ad3e62833088 |
| `note_generic_metrics` | FAIL | awaiting_input | ✗ — | 0/3 | – | 0.4 | 1 | 0 | 0 | – | ad3e62833088 |

## 細節

### `deck_translate_en` 中文簡報整份翻成英文（含封面）
- api · playbook slides · runs 065a9f7f · 2026-10-23T23:39:26.011Z → 2026-10-24T00:35:43.953Z · 注意：執行中重新部署
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ language_en：English（漢字 0、英文字 909）
- ✓ page_count：6 頁（要求 6）
- ✓ cover_en：封面：「Zipformer + RNNT with Dynamic Hotwords: State of the Art (Agent draft)」
- 呼叫（依 purpose）：write_slides 8（5 分）、verify 7（5 分）、visual_qa 4（4 分）、visual_fix 3（10 分）、outline 1（1 分）、requirements 1（0 分）、title_translate 1（0 分）、verify:budget 1（0 分）、verify_final 1（2 分）、visual_qa:retry 1（0 分）
- 步驟停止原因：converged ×10
- 評審：要求 4、內容 5、結構 4、形式 4 — The deck is in natural English throughout—slides, tables, takeaways, and speaker notes—but the cover retains the Chinese author name 林雅婷, so the 'all English' constraint is not fully met, and the external SVG diagram labels cannot be verified. Content is technically accurate and specific (shallow fusion, TCPGen, trie-based RNNT biasing) with no invented numbers or filler. Organization is logical, 

### `deck_followup_expand` 接著上一個：再詳細一點、每個方法要有架構與 Pros/Cons（不重說語言）
- api · playbook slides · runs 48397922 · 2026-10-24T00:35:44.049Z → 2026-10-24T01:26:20.246Z
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ language_en：English（漢字 0、英文字 1908）
- ✓ per_item_fields：4 頁有全部欄位（architecture／pros／cons），0 頁只有部分；要求 ≥ 2
- ✓ expanded：9 頁（原本 6）
- 系統未通過的驗收：clean：這些頁面還有佔位文字（〔　〕、待補、TODO…）：第 9 頁「Idea Card and Next Week and Questions」。請填入依據資料的內容；資料裡真的沒有就明寫「資料未提供」。
- 呼叫（依 purpose）：write_slides 15（19 分）、verify 8（9 分）、visual_qa 5（3 分）、outline 3（11 分）、outline:budget 3（4 分）、visual_fix 3（6 分）、verify:budget 2（1 分）、verify_final 2（6 分）、verify_final:budget 2（1 分）、requirements 1（0 分）
- 步驟停止原因：converged ×11、same_failure ×1、cap ×1
- 評審：要求 5、內容 4、結構 4、形式 4 — Delivers exactly the ask: four dynamic hotwording methods (shallow fusion/KMP, CLAS, bias tokens, WCTC), each with architecture and explicit Pros/Cons, in English and clearly more detailed than the prior overview, with cited numbers and equation references. Substance is strong but slightly inconsistent: the sudo2024 slide reports a headline number (B-WER 14.3→3.1) yet Table 1 omits the method clai

### `deck_expand_fields_zh` 展開：每個方法一頁，每頁要有架構、優點、缺點
- api · playbook slides · runs 2b6d7935 · 2026-10-23T18:00:27.249Z → 2026-10-23T19:38:18.564Z · 注意：執行中重新部署
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ language_zh：繁體中文（漢字 2466、英文字 414）
- ✓ per_item_fields：6 頁有全部欄位（架構／優點／缺點），0 頁只有部分；要求 ≥ 2
- ✗ titles_kept：少了或順序變了：目前進度、下週與要問
- 呼叫（依 purpose）：write_slides 14（22 分）、verify 11（7 分）、verify:budget 5（1 分）、visual_qa 4（3 分）、outline:budget 3（6 分）、outline 3（9 分）、visual_fix 2（4 分）、write_slides:budget 2（1 分）、verify_final:budget 1（1 分）、requirements 1（0 分）、verify_final 1（2 分）、visual_qa:budget 1（1 分）、verify:retry 1（0 分）
- 步驟停止原因：converged ×13、cap ×1
- 評審：要求 5、內容 5、結構 5、形式 5 — Exactly five method slides (Shallow fusion, CLAS, contextual adapters, adaptive contextual biasing, dynamic vocabulary), each with a dedicated 架構 diagram plus 優點/缺點 columns, while the surrounding pages (問題定義, 總覽, Table 1, 卡住, Idea card) are retained unchanged. Content is dense and source-attributed with concrete numbers (e.g., B-WER 14.3→3.1 at N=100, 68% relative WER for CLAS, 320ms lookahead) an

### `deck_add_page` 英文簡報加一頁比較表（中文指令，簡報維持英文）
- api · playbook slides · runs f614cdd3 · 2026-10-23T23:39:26.026Z → 2026-10-24T00:33:03.878Z · 注意：執行中重新部署
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ page_count：7 頁（要求 7）
- ✓ titles_kept：原本的 6 頁都在
- ✓ comparison_table：p2「Shallow fusion vs. CLAS vs. contextual adapters」的表格比較了 shallow、CLAS、adapter
- ✓ language_en：English（漢字 0、英文字 1445）
- 系統未通過的驗收：coverage：大綱第 2 頁 Shallow fusion 與第 4 頁 Contextual adapters 的獨立頁面缺席，比較表頁原封不動重複出現三次，頁面結構與大綱不符且不連貫。
- 呼叫（依 purpose）：write_slides 11（9 分）、verify 9（9 分）、visual_qa 6（6 分）、visual_fix 4（16 分）、verify_final 2（4 分）、verify:budget 2（1 分）、outline 2（6 分）、visual_fix:budget 1（2 分）、outline:retry 1（2 分）、requirements 1（0 分）
- 步驟停止原因：converged ×11

### `deck_exact_pages` 剛好 8 頁的進度報告
- api · playbook slides · runs 6d78e5b4 · 2026-10-23T19:38:18.654Z → 2026-10-23T20:34:32.291Z
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ page_count：8 頁（要求 8）
- ✓ language_zh：繁體中文（漢字 1457、英文字 192）
- ✓ deck_mode：kind=progress，paper=無
- ✓ no_placeholder：沒有佔位文字
- 系統未通過的驗收：coverage：共8頁且各頁對應大綱，自填頁已標「AI 代填，待你確認」；但第4頁「Table 1 現況」整頁（表格、圖、takeaway、notes）皆未出現大綱要求的固定元素「距上次新數字：N 週」。
- 呼叫（依 purpose）：write_slides 13（16 分）、verify 10（6 分）、visual_qa 6（4 分）、verify:budget 5（1 分）、visual_fix 3（7 分）、verify_final:budget 2（1 分）、outline 2（4 分）、verify_final 2（3 分）、requirements 1（0 分）、write_slides:budget 1（0 分）、visual_qa:retry 1（1 分）、ask_options:budget 1（0 分）、ask_options 1（1 分）
- 步驟停止原因：converged ×13
- 評審：要求 5、內容 4、結構 4、形式 4 — Delivers exactly 8 Traditional-Chinese slides in a coherent progress-report arc (problem → idea → milestones → results → blockers → next steps), grounded in dated study artifacts with verifiable specifics (Zipformer RNN-T, AISHELL-1 dev CER 5.1%, 320-term bias list, CLAS/shallow-fusion comparison). Substance is docked because three of the eight slides (卡住, Idea card, 下週與要問) are explicitly flagged 

### `deck_remove_page` 刪掉一頁
- api · playbook slides · runs 088bb1e5 · 2026-10-23T19:59:54.564Z → 2026-10-23T20:53:08.166Z
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ page_count：5 頁（要求 5）
- ✓ removed：已移除
- ✓ titles_kept：原本的 5 頁都在
- ✓ language_zh：繁體中文（漢字 1112、英文字 44）
- 呼叫（依 purpose）：verify 5（3 分）、visual_qa 5（2 分）、write_slides 5（3 分）、visual_fix 4（8 分）、verify_final 2（2 分）、outline 1（1 分）、requirements 1（0 分）、verify:budget 1（0 分）、visual_qa:retry 1（0 分）
- 步驟停止原因：converged ×9

### `deck_topic_paper_title` 從文獻做主題簡報（英文、「paper title」說法）
- api · playbook slides · runs 64789a56 · 2026-10-23T16:41:32.555Z → 2026-10-23T17:03:38.845Z
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ language_en：English（漢字 0、英文字 1822）
- ✓ deck_mode：kind=progress，paper=無
- ✓ library_papers：提到文獻庫 9 篇（要求 ≥ 4）：gulati2020conformer, nakagome2025wctc, tang2024improving, huang2024improving, sudo2024contextualized, wang2023contextual
- ✓ pages：10 頁（≥ 6）
- 呼叫（依 purpose）：write_slides 5（9 分）、verify 4（3 分）、visual_qa 3（3 分）、outline 1（3 分）、requirements 1（0 分）、verify:budget 1（0 分）、verify_final 1（1 分）、visual_fix 1（3 分）
- 步驟停止原因：converged ×8
- 評審：要求 5、內容 5、結構 4、形式 5 — Delivers an English revealjs survey deck with the exact paper title, a two-axis taxonomy covering all nine library methods with injection points, per-method citations, and a synthesis/next-steps slide. Substance is technically specific and correct (KMP-vs-WFST, CLAS OOV handling and attention scatter, WCTC inter-layer retraining-free KWS, dynamic-vocabulary subword issue), with project numbers exp

### `deck_paper_report` 論文報告簡報（有 PDF）
- api · playbook slides · runs 3395f787 · 2026-10-23T17:08:41.624Z → 2026-10-23T17:43:48.479Z · 注意：執行中重新部署
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ paper_report：kind=paper_report，paper=3b647776-698f-4ef0-b6d2-f8782fa7b5aa
- ✗ language_zh：不是全繁體中文：封面（沒有中文）、p1 內文、p2 內文、p3 內文、p4 內文、p6 內文…共 9 處（CJK 3286、英文字 947）
- ✓ pages：13 頁（≥ 8）
- 呼叫（依 purpose）：write_slides 18（24 分）、verify 11（8 分）、research_paper 10（4 分）、verify:budget 6（1 分）、visual_qa 5（4 分）、outline 2（4 分）、write_slides:budget 2（1 分）、visual_fix 1（4 分）、requirements 1（1 分）、requirements:budget 1（0 分）、verify_final 1（1 分）、visual_qa:budget 1（1 分）、write_slides:continue 1（0 分）、ask_options:budget 1（0 分）、ask_options 1（1 分）、research_paper:continue 1（0 分）、ask_options:retry 1（0 分）
- 步驟停止原因：converged ×16、no_improvement ×1、same_failure ×1
- 評審：要求 4、內容 5、結構 3、形式 3 — The deck delivers the requested Chinese journal-club format (problem → architecture → training/inference → setup/fairness → main results → assessment) with dense, correctly-attributed paper numbers (NE-WERR +34.10/+44.33 vs SF +27.70/+38.12, 86% time saving, <500k params, Tables 2–4 ablations), and the Quarto/revealjs source is clean. However, three slides carry explicit '[AI 代填，待你確認]' placeholder

### `note_topic_research` 主題調研筆記
- api · playbook topic_research · runs 38cafe55 · 2026-10-23T17:03:38.935Z → 2026-10-23T17:08:41.537Z
- 交付物：要 note，得到 無（Brief：note）
- ✗ language_zh：漢字 0、CJK 0、英文字 0
- ✗ library_papers：提到文獻庫 0 篇（要求 ≥ 4）
- ✗ citations：0 個引用鍵，都在研究文獻庫（至少要 3 個）
- ✗ length：0 字元（要求 ≥ 1500）
- 呼叫（依 purpose）：requirements 1（0 分）、topic_plan 1（1 分）、topic_select 1（1 分）、topic_select:budget 1（1 分）
- 問題卡：找不到和這個主題相關、可以匯入的論文（線上搜尋：「contextual biasing streaming ASR evaluation」、「shallow fusion contextual biasing ASR」、「contextual RNN-T joiner biasing」、「Zipformer contextual biasing RNN-T」、「contextual biasing WERR comparison」、「contextual biasing false trigger」、「contextual biasing ASR survey」、「seminal hotword contextual biasing methods」、「hotword WERR false trigger metrics」、「deep context listen attend spell」）。請在補充指示提供更具體的英文關鍵字、論文標題或 arXiv 編號，或先把論文加入研究文獻庫後按「繼續」。

### `note_lit_review` 文獻回顧（要有比較表）
- api · playbook lit_review · runs 058b7923 · 2026-10-23T17:43:48.575Z → 2026-10-23T18:00:27.163Z
- 交付物：要 note，得到 note（Brief：lit_review）
- ✓ language_zh：漢字 2322、CJK 2758、英文字 767
- ✓ table_rows：最大表格 6 列（要求 ≥ 5）
- ✓ citations：6 個引用鍵，都在研究文獻庫
- 呼叫（依 purpose）：lit_read 35（11 分）、verify:budget 4（2 分）、write:lit_review 4（6 分）、verify 4（3 分）、verify_final:budget 1（0 分）、requirements 1（0 分）、verify_final 1（1 分）
- 步驟停止原因：converged ×11
- 評審：要求 5、內容 5、結構 4、形式 5 — Delivers exactly what was asked: a Traditional-Chinese literature review of contextual biasing with a dense comparison table, covering five genuine biasing papers plus a justified backbone reference. Substance is highly specific and internally consistent (numbers cross-referenced across sections, honest caveats like the shallow-fusion tension and metric non-comparability), with no filler or fabric

### `note_reading` 單篇閱讀筆記
- api · playbook reading_note · runs 12ce26cf · 2026-10-23T20:34:32.381Z → 2026-10-23T21:07:23.823Z · 注意：執行中重新部署
- 交付物：要 note，得到 note（Brief：reading_note）
- ✓ language_zh：漢字 6457、CJK 7787、英文字 1860
- ✓ about_paper：提到 CLAS / Deep context
- ✓ length：20421 字元（要求 ≥ 800）
- 系統未通過的驗收：grounded：「我的想法」區塊捏造了論文與來源資料中都沒有的使用者研究細節（逾 300 個、recall 下降、老師要求、ICASSP），雖標註 AI 代填但並非「依研究資料草擬」，具體數字與情境屬無中生有。
- 呼叫（依 purpose）：reading_part 60（24 分）、verify 12（9 分）、verify:budget 6（3 分）、verify_final 2（3 分）、verify:retry:budget 1（0 分）、verify_final:budget 1（1 分）、requirements 1（1 分）、ask_options 1（1 分）、verify:retry 1（1 分）、ask_options:retry 1（1 分）
- 步驟停止原因：converged ×11

### `latex_paper_goal` 從零寫 LaTeX 論文（目標）
- goal · playbook paper_outline · runs 6eee6f62, 674481d0 · goal 2f782d4c · 2026-10-23T16:41:32.545Z → 2026-10-23T17:49:13.839Z · 注意：執行中重新部署
- 交付物：要 latex，得到 note、latex（Brief：無）
- ✗ compiles：最後編譯：failure
- ✓ sections：19 個 \section（≥ 4）
- ✗ citations：14 個引用鍵，3 個不在研究文獻庫：graves2012sequence, rao2017streaming, he2019streaming
- 系統未通過的驗收：compile：LaTeX 編譯有錯誤：編譯失敗，沒有產生 PDF。請查看完整編譯記錄。；cites：這些引用鍵不在研究的文獻庫中：graves2012sequence、rao2017streaming、he2019streaming。只能使用：nakagome2025wctc、sudo2024contextualized、tang2024improving、huang2024i
- 呼叫（依 purpose）：verify 14（11 分）、paper_section 13（24 分）、verify:budget 11（5 分）、paper_fix 8（16 分）、paper_section:budget 5（6 分）、paper_fix:budget 4（5 分）、verify_final 3（5 分）、verify_final:budget 2（4 分）、paper_abstract 2（1 分）、requirements 2（1 分）、paper_abstract:budget 2（0 分）、paper_outline 1（1 分）、paper_section:continue 1（0 分）
- 步驟停止原因：converged ×11、unchanged ×1
- 評審：要求 2、內容 3、結構 1、形式 1 — The topic, scope, and language match the request and the technical content (RNN-T math, CLAS, shallow fusion, KMP matching, adapters, dynamic vocabulary) is genuinely substantive, but the artifact is two-plus conflicting drafts stitched together rather than the single survey requested. Structure fails catastrophically: duplicate abstract and title, three incompatible taxonomies (3-axis, 5-category

### `deck_progress_single_paper` 只有一篇論文的研究做進度簡報（不能變論文報告）
- api · playbook slides · runs 010d6756 · 2026-10-23T20:53:08.259Z → 2026-10-23T21:38:01.917Z · 注意：執行中重新部署
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ deck_mode：kind=progress，paper=無
- ✓ language_zh：繁體中文（漢字 1412、英文字 82）
- ✓ progress_content：用到研究的進度資料（CER 18.2%／SpecAugment／微調）
- 系統未通過的驗收：clean：這些頁面還有佔位文字（〔　〕、待補、TODO…）：第 3 頁「對帳」。請填入依據資料的內容；資料裡真的沒有就明寫「資料未提供」。；coverage：「本週關鍵結果」講稿宣稱對照長條圖放在「對帳」頁，但 final 的對帳頁只有 timeline 時間軸圖，hbar 長條圖實際位於「Table 1 現況」頁，前後指涉不一致，破壞連貫，不適合直接在組會報告。
- 呼叫（依 purpose）：write_slides 15（13 分）、verify 11（6 分）、visual_qa 7（5 分）、visual_fix 5（13 分）、verify_final 3（4 分）、verify:budget 3（1 分）、outline 2（5 分）、verify_final:budget 1（1 分）、outline:retry 1（1 分）、requirements 1（1 分）、write_slides:budget 1（0 分）、visual_qa:budget 1（0 分）、ask_options 1（1 分）
- 步驟停止原因：converged ×13
- 翻轉：criterion coverage

### `deck_progress_en` 英文指令的進度簡報
- api · playbook slides · runs ea1aeb4f · 2026-10-23T21:07:23.930Z → 2026-10-23T21:36:31.537Z · 注意：執行中重新部署
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ language_en：English（漢字 0、英文字 1133）
- ✓ deck_mode：kind=progress，paper=無
- ✓ cover_en：封面：「Agent Evaluation Set for Streaming ASR Hotword Biasing: Progress Report 261024」
- 呼叫（依 purpose）：write_slides 12（11 分）、verify 11（7 分）、verify:budget 5（3 分）、visual_qa 4（2 分）、outline 3（8 分）、verify_final 2（3 分）、requirement_fix 2（1 分）、outline:budget 1（1 分）、title_translate 1（0 分）、visual_fix 1（1 分）、requirements 1（0 分）、write_slides:budget 1（0 分）、ask_options 1（0 分）
- 步驟停止原因：converged ×13

### `note_en_compare` 英文筆記：比較兩類做法
- api · playbook generic · runs f4936c78 · 2026-10-24T00:33:03.971Z → 2026-10-24T01:00:28.318Z
- 交付物：要 note，得到 note（Brief：note）
- ✓ language_en：漢字 0、CJK 0、英文字 690
- ✓ library_papers：提到文獻庫 4 篇（要求 ≥ 3）：sudo2024contextualized, wang2023contextual, sathyendra2022contextual, zhao2019shallow
- ✓ length：4254 字元（要求 ≥ 1500）
- 呼叫（依 purpose）：generic_research 27（6 分）、verify 10（13 分）、write:generic 9（13 分）、verify:budget 7（8 分）、write:generic:budget 3（3 分）、generic_research:budget 1（2 分）、plan_generic 1（1 分）、requirements 1（0 分）、verify_final 1（1 分）
- 步驟停止原因：converged ×7
- 評審：要求 5、內容 4、結構 4、形式 5 — Delivers exactly the requested note: an English head-to-head comparison of shallow fusion vs. neural biasing for streaming RNN-T grounded in the study's papers (Zhao, Wang, Sathyendra, Xu, Sudo). Substance is highly specific and honest about gaps, but the combined/NE figures are internally unexplained and inconsistent (31.29% vs +34.1, 36.17% vs +39.70%), which a strict grader cannot wave off. Str

### `deck_translate_zh` 英文簡報整份翻成繁中
- api · playbook slides · runs b5b8558f · 2026-10-23T21:38:02.036Z → 2026-10-23T22:51:04.815Z
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ language_zh：繁體中文（漢字 772、英文字 93）
- ✓ page_count：6 頁（要求 6）
- 呼叫（依 purpose）：verify 7（4 分）、write_slides 7（3 分）、visual_qa 3（2 分）、visual_fix 2（3 分）、outline 1（1 分）、requirements 1（0 分）、verify:budget 1（1 分）、verify_final 1（1 分）
- 步驟停止原因：converged ×10

### `chat_paraphrase` 聊天交辦：助理改寫不能新增要求
- chat · playbook slides · runs 8abfc42a · 2026-10-23T22:38:18.941Z → 2026-10-23T23:37:25.675Z · 注意：執行中重新部署
- 交付物：要 deck，得到 deck（Brief：deck）
- ✓ brief_grounded：3 條要求都引用原話
- ✓ deck_mode：kind=progress，paper=無
- ✓ language_zh：繁體中文（漢字 1770、英文字 175）
- 呼叫（依 purpose）：write_slides 11（18 分）、verify 11（9 分）、visual_qa 6（3 分）、outline 3（11 分）、visual_fix 3（10 分）、outline:retry 3（4 分）、verify_final 2（4 分）、verify:budget 2（1 分）、verify_final:budget 1（1 分）、requirements 1（0 分）、write_slides:budget 1（1 分）、ask_options:budget 1（0 分）、ask_options 1（1 分）
- 步驟停止原因：converged ×13

### `deck_missing_pdf` 論文沒有 PDF：要停下來要 PDF，不能換成別的
- api · playbook slides · runs c2dcbb12 · 2026-10-23T22:51:04.906Z → 2026-10-23T22:51:37.375Z
- 交付物：狀態 needs_pdf，成果 無
- ✓ no_substitute：沒有寫出替代成果
- 呼叫（依 purpose）：requirements 1（0 分）
- 問題卡：〈Hotword Biasing for Low-Resource Taiwanese Mandarin Streaming ASR (eval fixture 〉找不到 PDF（已試過開放取用與文獻紀錄的網址），這份先跳過：貼上 PDF 網址按「從網址下載 PDF」，或到文獻庫上傳後按「繼續」。

### `kind_conflict` 交付物衝突：指定閱讀筆記流程，卻要簡報
- api · playbook reading_note · runs 99564733 · 2026-10-23T22:51:37.442Z → 2026-10-23T23:18:35.845Z · 注意：執行中重新部署
- 交付物：成果 note；不該出現 note
- ✗ brief_deck：Brief 交付物：reading_note
- 呼叫（依 purpose）：reading_part 63（28 分）、verify 14（13 分）、verify_final 2（4 分）、verify_final:budget 1（0 分）、requirements 1（0 分）、reading_part:budget 1（0 分）、ask_options 1（1 分）、ask_options:retry 1（1 分）
- 步驟停止原因：converged ×11

### `note_generic_metrics` 一般筆記：評估指標與計算方式
- api · playbook experiment_report · runs 5220d4f3 · 2026-10-23T23:18:35.932Z → 2026-10-23T23:37:40.903Z
- 交付物：要 note，得到 無（Brief：note）
- ✗ language_zh：漢字 0、CJK 0、英文字 0
- ✗ covers_metrics：四個指標都有寫到
- ✗ length：0 字元（要求 ≥ 800）
- 呼叫（依 purpose）：requirements 1（0 分）
- 問題卡：找不到實驗數據。請把結果貼在補充指示，或附加實驗筆記後按「繼續」。
