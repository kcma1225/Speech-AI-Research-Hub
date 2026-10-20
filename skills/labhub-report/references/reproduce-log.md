# 復現 baseline、錯誤分析、實驗紀錄（第 3+4 站）

來源：`guides/experiment_log/reproduce_and_log.md` v1.8。Table 1 審過之後，一直到投稿。

## 三個目的，順序固定

1. **Reproduce baseline 到對上論文數字**
2. **錯誤分析**（人工聽/看 100 個樣本，分類比例）
3. **記錄每一個實驗**（`results.csv`）

## 鐵律

**沒復現到對上數字之前，不改方法。** 這是鐵律。不能因為「復現差一點、先試試自己的想法」就跳過。復現超過 3 週還對不上，要帶 `reproduce.md` 問教授可否降一層 baseline——不是自己決定降級。

## repo 結構（教授指定，從 student-template 建）

```
〔研究 repo〕/
  README.md
  research/
  design/
  configs/
  scripts/
  results/
    results.csv
  notes/
    log.md             日誌，每天寫
    papers/             論文核對紀錄、reading_log.md
  reports/              進度/論文投影片
  pyproject.toml         uv 環境
  uv.lock
  .python-version
  .gitignore            資料不進 git
```

## `results.csv` 是唯一事實來源

投影片、報告任何數字都要對回這個檔案的某一列。欄位至少含：`run_id, date, commit, dataset, metric, value, config, seed, notes`（具體欄位依題目調整，但每一列要可追溯）。

## README 五段規則

寫給外人看的 README，固定五段：
1. 一句話：這個 repo 在做什麼
2. 安裝：`uv sync`
3. 怎麼跑：一行指令重跑主要結果
4. 目前結果：Table 1 的最新狀態（每次教授回饋同步後更新）
5. 目錄說明

## 日誌週小結（五格，供進度報告使用）

見 `progress-report.md` 的五格表；`notes/log.md` 每天寫，週末整理成五格。

## 錯誤分析的紀律

- 100 個樣本是人親自聽/看分類，不是讓 AI 分類後照抄
- 錯誤類別分法要問教授確認（通常在標完 100 個那次 meeting）
- 評測盲測：關鍵評測腳本由另一個人（不看你程式）照規格獨立寫一份，兩份對同一輸出數字一致才算數

## AI 禁寫/禁做部分

- 錯誤分析的分類結論使用者自己判斷，AI 可以幫忙整理統計但不能下最終類別判斷
- 降 baseline 與否教授決定
- 同一個問題卡超過 3 個工作天：先問 partner，再問教授（不是繼續自己試或讓 AI 猜）

## 要問教授的事

| 問題 | 什麼時候問 |
|---|---|
| 復現超過3週對不上，降一層baseline可以嗎？ | 帶著reproduce.md問 |
| 錯誤類別這樣分可以嗎？ | 標完100個那次meeting |
| 以目前速度截稿前填不完Table 1，砍哪幾格？ | 一發現就問，不要等 |
| 同一個問題卡超過3個工作天 | 先partner，再教授 |

## 怎麼核對

1. 復現數字和論文數字的相對差距有明確計算與記錄
2. `results.csv` 每一列可追溯到 config/commit/seed
3. 錯誤分析樣本數、分類比例、代表樣本都記錄在案
4. README 五段都更新到最新
5. 評測腳本有盲測對照（兩人獨立寫、數字一致）
