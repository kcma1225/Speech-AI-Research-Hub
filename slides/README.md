# Speech-AI Research Hub 簡報

Quarto website 專案。首頁列出各次 reveal.js 簡報。

## 本機預覽

```bash
cd slides
quarto preview
```

`slides/` 保留 QMD 原始碼供本機預覽。正式服務不使用 `_site` 或 nginx alias。將單份 deck 的 QMD、CSS、圖片打包成 ZIP，至 `/slides` 上傳；App 自動補 annotate 插件並交由隔離 renderer 編譯。含多個 QMD 時需指定入口路徑，除非有根目錄 `index.qmd`。原有 `meet1` 與 `interspeech_2019_zhao` 也須依相同流程匯入。

簡報擁有版本、參考資料、獨立標籤及 Professor 審閱。`_quarto.yml` 只用於本機 website 預覽，不參與匯入。

## 會議流程

會前建立 GitHub Issue：`261013 進度`，label `progress`。貼週小結五格與 `/meet1/` 連結。會中直接在 Issue 留言記錄教授回饋；會後同步決定並關閉 Issue。

## 標註插件（`_extensions/annotate`）

reveal.js 插件，在每份簡報 YAML 加 `revealjs-plugins: [annotate]` 啟用。右下角半透明工具列，箭頭按鈕展開／收合（狀態與筆刷設定記在 localStorage）。

- `1` 雷射筆：紅點加淡出軌跡，只做指示不留痕跡。
- `2` 畫筆：五色實心筆，細／中／粗。
- `3` 螢光筆：四色半透明，細／中／粗。
- `4` 物件橡皮擦：碰到的整條筆跡一起移除。
- 選畫筆或螢光筆時，工具列上方出現顏色與粗細列；換色、換粗細不會關掉工具。`[`／`]` 調粗細，方向鍵切換選項。
- Shift 拖曳畫直線。`⌘Z`／`Ctrl+Z` 復原，`⇧⌘Z`／`Ctrl+Y` 重做，垃圾桶清除此頁（可復原）。
- 再按一次同工具或 `Esc` 關閉工具；`T` 展開／收合。
- 筆跡每頁各自保存於 sessionStorage，關閉分頁即清除。
- 橫向手機／PWA（高度 ≤480px）：工具列改成右側直立窄欄（每列兩鍵），顏色與粗細移到左下角直立窄欄，用投影片左右兩側的空白，不擋橫向視野。
- 概覽、暫停、窄螢幕 scroll view（<435px）時自動隱藏；列印／PDF 不輸出標註。

修改後重新打包並上傳為新版；不用重啟 nginx。
