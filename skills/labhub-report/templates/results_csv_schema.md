# results.csv 欄位規範

> 唯一事實來源，投影片任何數字要對回這裡某一列。見 references/reproduce-log.md。

```
run_id,date,commit,dataset,metric,value,config,seed,notes
```

- `run_id`：唯一識別，建議 `〔YYYYMMDD〕_〔簡稱〕_s〔seed〕`
- `commit`：跑這個 run 時的 git commit hash
- `config`：用的 config 檔路徑
- `notes`：為什麼跑這次（例：「復現baseline」「錯誤分析後改善」）

產學專案另有 `acceptance.csv`（放專案 repo，不是研究 repo），欄位：

```
date,commit,system,test_set,metric,value,threshold,pass,conditions,reason
```

`conditions` 寫硬體/解碼設定/checkpoint；`reason` 寫為什麼跑這次。驗收集每跑一次記一行，跑太多次等於拿它調參數。
