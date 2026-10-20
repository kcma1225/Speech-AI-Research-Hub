# 怎麼使用這個 skill

用法分三層:觸發、流程、範例。

## 怎麼觸發

Pi 會自動偵測技能相關性。只要用自然語言描述要做的事,帶出以下任一線索,就會載入這個 skill:

- 提到「Lab-Hub」「教授的格式」「group meeting」
- 要做「進度報告」「論文投影片」「idea card」「Table 1」「實驗設計」
- 要做「產學雙週報告」「研究測試報告」「需求規格表」
- 要求「把這個弄成網頁簡報」「不要PPT,要Quarto」
- 要求「找論文」「找最近頂會論文」「找候選要報告的論文」

不用記指令,直接說需求即可,例如:

```
幫我把這篇論文整理成報告投影片
這週的進度幫我生成group meeting的8頁
我有個idea想寫成card
幫我在INTERSPEECH、ICASSP找一批跟我題目相關的候選論文
```

## 執行時會做什麼(標準流程)

1. **判斷文件類型**——先確認是哪一類(進度/論文/idea/設計/復現紀錄/Deep Research/產學/審稿對帳/找候選論文),不確定會直接問。
2. **讀對應 reference**——拿該類型的完整鐵律、頁數規格、AI禁寫頁、語言規則。
3. **複製模板**到 repo 該放的路徑(例如`reports/progress_〔YYMMDD〕.qmd`)。
4. **只填提供或既有檔案(results.csv、日誌、上週Issue)能查到的內容**;沒有依據的留`〔〕`,不編數字不編論文、不編idea。
5. **明確告知哪幾頁/哪幾格要自己寫**(AI不能代填的部分)。
6. **檢查語言規則**(論文投影片本體英文、進度報告中文可、講稿一律繁中)。
7. 提示 `quarto render <path>.qmd`(需本機先裝 [Quarto](https://quarto.org))。
8. **提醒後續同步動作**(開/更新GitHub Issue、等教授審核紀錄才能寫程式、更新idea_log狀態)。
9. 跑一遍該類型的「怎麼核對」清單,回報哪些還沒核對。

## 路由表:要產出什麼 → 讀哪份 reference → 用哪個模板

| 要產出的東西 | 對應站 | Reference | 模板 |
|---|---|---|---|
| 每週向教授報進度(group meeting) | 第5站 | `references/progress-report.md` | `templates/progress_report.qmd` |
| 把一篇論文變成報告投影片 | 貫穿(論文報告) | `references/paper-report.md` | `templates/paper_report.qmd` |
| 從頂會找候選論文供選擇要讀/要報的(INTERSPEECH/ICASSP/ASRU/SLT等) | 貫穿 | `references/paper-scouting.md` | `templates/paper_shortlist.md` |
| 把「我覺得可以做X」寫成可判斷的提案 | 第1b站 | `references/idea-card.md` | `templates/idea_card.md` |
| 實驗設計:Table 1、消融表、method figure、決策紀錄 | 第2站 | `references/design-table1.md` | `templates/design_doc.md` |
| 復現baseline/錯誤分析/實驗紀錄/repo README | 第3+4站 | `references/reproduce-log.md` | `templates/results_csv_schema.md`、`templates/repo_readme.md` |
| Deep Research建地圖/深挖路線 | 第0、1站 | `references/deep-research.md` | 指令全文在reference裡,直接複製貼進AI的Deep Research |
| 給產業方的雙週進度報告 | 產學分支 | `references/industry-biweekly.md` | `templates/industry_biweekly.qmd`、`templates/industry_minutes.md` |
| 給產業方工程師的研究測試報告 | 產學分支 | `references/industry-test-report.md` | `templates/industry_test_report.qmd` |
| 產學需求規格表、驗收紀錄 | 產學分支 | `references/industry-biweekly.md` §需求規格表 | `templates/requirement_spec.md`、`templates/acceptance.csv` |
| 審稿意見回來後的對帳 | 慣例 | `references/review-reconciliation.md` | `templates/review_reconciliation.md` |
| 不確定某件事該不該自己決定 | 總表 | `references/ask-professor-index.md` | — |

## 六種常見情境範例

| 你說 | 會做什麼 |
|---|---|
| "這週進度報告" | 讀`progress-report.md`,問你要results.csv/log.md內容,套`progress_report.qmd`,8頁填好,卡住/card部分留`〔〕` |
| "報一篇論文" | 讀`paper-report.md`,你給PDF或連結,生13頁草稿,**第7/12/13頁空白要自己寫** |
| "幫我找候選論文" | 讀`paper-scouting.md`,先問你的題目關鍵字,搜INTERSPEECH/ICASSP/ASRU/SLT,出8-15篇候選清單讓你選,**不直接幫你決定讀哪篇** |
| "我有個idea" | 讀`idea-card.md`,問痛點證據、prior work,**核心三格你自己判斷**,只幫排版整理 |
| "設計實驗/畫Table 1" | 讀`design-table1.md`,套`design_doc.md`,數值代碼C/R/O/—,審核紀錄欄留白等教授 |
| "產學雙週報告" | 讀`industry-biweekly.md`,**先確認資料沒進過外部AI**,套`industry_biweekly.qmd` |

## 「找候選論文」功能怎麼用

這是搜尋輔助,**不是閱讀捷徑**。流程:

1. 先給關鍵字來源——目前題目、design doc的一句話主張、idea card的假設、或one-pager的技術關鍵詞。沒有具體題目就會先問,不會用泛用詞亂搜。
2. 依題目搜 INTERSPEECH(ISCA Archive)、ICASSP(IEEE Xplore)、ASRU、SLT,每個會議跑多個關鍵字變體,必要時加EUSIPCO/ACL系/ICML系等次要會議。
3. 輸出`paper_shortlist.md`:至少8-15篇,每篇標題/作者/會議年/連結/一句話主張(標明摘要層級未深讀)/關係類別(可借、是baseline、競品、無關但有趣、背景)/建議理由/優先度。
4. **不會替你斷言「這篇最好」**,只給排序依據讓你自己比較。
5. 你選定要深讀的那篇之後,**必須重新走`paper-report.md`的五步流程**(餵PDF→AI生草稿→兩遍讀核對→自己寫第7/12/13頁→核對紀錄)——候選清單的摘要描述不能直接當報告內容用。
6. arXiv預印本若未確認正式收錄會明確標出,不會替你斷言已收錄。

## 使用前要準備什麼

依類型不同,大致是:
- 進度報告:`results.csv`、`notes/log.md`本週小結、上週Issue連結
- 論文報告:論文PDF
- 找候選論文:目前題目關鍵字(來自design doc/idea_log/one-pager,或直接口述)
- idea card:具體痛點證據(不能只是「我覺得」)
- 設計文件:教授挑定的card、要比較的baseline清單
- 產學報告:`acceptance.csv`/`results.csv`數字(**不要貼產業方原始資料,不會用於外部AI服務**)

## 這個 skill 不做的事

- 不幫你選題目、選baseline、選資料集、估截稿日、定門檻——這些永遠是教授或你自己的判斷。
- 不把AI生成的idea包裝成idea card直接呈現為「可以報給教授」的樣子;痛點證據、prior work查證、八格內容必須你自己確認。
- 不生成未經核對就宣稱正確的論文引用、數字、Table 1格子。
- 不替你決定「找候選論文清單裡要報哪一篇」,也不把摘要層級的篩選結果當成已深讀的論文報告內容。

## 核心鐵律(先讀 `references/core-rules.md`)

1. 輸出工具只能是 Quarto(`.qmd` → `.html`,reveal.js),不產 PPT、Keynote、Google Slides。
2. 特定頁面AI絕對不能代寫,依文件類型固定(見上面路由表對應reference的「AI禁寫頁」)。
3. 語言規則依文件類型固定:論文投影片本體英文、講稿繁中;進度報告中文可;Deep Research/設計文件/idea card全繁中。
4. 每個數字、每個引用都要標來源(`AI`/`AI→✓`已核對/`我`自己寫)。
5. 教授專屬決定的事(題目、資料、GPU、截稿日、門檻、baseline降級……)永遠留白寫「待教授決定」。
6. Mermaid節點標籤不含括號/引號/斜線。
7. 審核/確認紀錄只能新增,不能覆蓋舊版。

## 檔案結構

```
labhub-report/
├── SKILL.md                  路由入口
├── USAGE.md                  本檔
├── references/ (12份)        每種文件的完整規則、鐵律、核對清單
└── templates/ (13份)         可直接複製填寫的 qmd/md 骨架
```
