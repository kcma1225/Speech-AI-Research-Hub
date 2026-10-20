# Aldine 評估（取代 Overleaf CE）

評估日期：2026-10-20　版本：Aldine **0.12.3**（2026-10-19 發布）　方式：隔離部署（compose project `aldine-eval`，只開 127.0.0.1:18090/18091），以 API 腳本與 Playwright 雙瀏覽器實測，結束後已 `down -v`。

## 結論：有條件採用（adopt with caveats）

功能面全數通過：即時協作、繁中 XeLaTeX、biblatex／pgfplots、Overleaf ZIP 匯入、git 歷史、斷網編譯沙箱都實測可用。資源很輕（閒置約 70 MB）。

但有三件事必須先處理才能對外：
1. 密碼註冊是公開的（沒有邀請制）。
2. 帳號無法停用。
3. 編譯器可以讀到其他專案的檔案。

我們的用途是實驗室內部、成員互信，在下列緩解措施到位的前提下可以接受。不需要退回 Overleaf CE。

## 專案現況

- 原始碼：<https://github.com/trahloff/Aldine>，AGPL-3.0。
- repo 建立於 2026-07，至 2026-10-19 共 219 個 commit、81 stars、0 open issues。
- 版本 v0.5 至 v0.12.3，平均約每週一版；0.x 版的 minor 升級可能有 breaking change。
- Image：
  - `ghcr.io/trahloff/aldine-app:0.12.3`：563 MB。
  - `aldine-compiler:0.12.3`：解壓後 **7.96 GB**（TeX Live 2026 scheme-medium 加 pictures、latexextra、bibtexextra）。官網說的 1.1 GB 是壓縮後的大小。首次拉取約 7.5 分鐘。

## 逐項驗證

| 項目 | 結果 | 證據 |
|---|---|---|
| a. 帳號與註冊限制 | ⚠️ 註冊公開 | `AUTH_ENABLED=1` 時，任何人都能 `POST /api/auth/register`。實測：陌生信箱 `random@evil.test` 註冊成功。程式碼中沒有邀請碼或 email 白名單，只有 rate limit。`ALDINE_ADMIN_EMAILS` 只決定誰能看 `/admin`；`/api/admin/*` 只有 stats 和 users 兩個 GET，**不能停用或刪除帳號**。唯一的總閘是 `ALDINE_SSO_ONLY=1`（搭配 OIDC 的 `OIDC_ALLOWED_GROUPS`）。密碼用 scrypt 雜湊。 |
| b. 即時協作 | ✅ | 兩個獨立的 browser context（Admin、Bob，專案經 `/share` 加入協作者）：Admin→Bob 9 ms、Bob→Admin 13 ms。可看到對方游標與名字標籤、頭像在線狀態（截圖 `collab-admin.png`）。未加入的使用者存取專案得到 403。技術上使用 Yjs／Hocuspocus，走 `/collab` WebSocket。 |
| c1. 繁中 XeLaTeX | ⚠️ 需自建 image | 原版只有 Fandol（GB2312），實測「週」缺字（`Missing character: There is no 週`）。改用 `deploy/aldine/compiler.Dockerfile`（加 `fonts-noto-cjk`）後，`Noto Serif/Sans CJK TC` 缺字 0。冷編譯 2.4–2.7 s，增量 0.4 s。注意：從 API 建立的專案不會讀取 `% !TEX program = xelatex`，引擎要在專案設定裡選。 |
| c2. pdfLaTeX＋biblatex(biber)＋pgfplots＋tikz | ✅ | 冷編譯（含 biber）10–11.4 s，增量 0.4 s；`.bbl` 有 1 筆文獻，undefined 為 0。 |
| d. Overleaf ZIP 匯入 | ✅ | 多檔 ZIP（`\input{sections/intro}`、`figures/dot.png`、`refs.bib`）匯入後自動判斷 root 為 `main.tex`，編譯成功。每個專案都是 git repo（`Initial commit`、`import assets`、`autosave`）。上限：ZIP 60 MB，request 81 MB。 |
| e. 編譯沙箱 | ⚠️ | ✅ 斷網：compiler 只接在 `internal: true` 網路，`curl example.com` 連 DNS 都解析不到。✅ shell-escape 為 restricted：`\write18{curl …}` → `disabled (restricted)`。✅ `cap_drop: ALL`（CapEff=0）、no-new-privileges、mem 2g、pids 256、單次編譯 120 s timeout、最多 2 個同時編譯。❌ **跨專案讀取**：所有專案都放在同一個 `/data` volume，TeX 可以用絕對路徑讀取。Bob 的專案 `\verbatiminput{/data/projects/<Admin 的私人專案>/main.tex}` 成功，內容直接出現在回傳給 Bob 的編譯錯誤訊息裡。另外，compiler 內部以 root（uid 0）執行，只是沒有任何 capability。 |
| f. 子路徑或獨立網域 | ✅ 兩種都可以 | 設 `ALDINE_PUBLIC_URL=http://host/latex`（或 `ALDINE_BASE_PATH`）。nginx 用 `location /latex/ { proxy_pass http://app:3000; }`，不可 rewrite 路徑。實測登入、編輯、`ws://…/latex/collab`、編譯都正常，cookie 的 `Path=/latex`。**仍建議用獨立網域**，原因見風險 4。 |
| g. OIDC | ✅（之後做 SSO） | 設定 `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`（使用 PKCE S256）、`OIDC_SCOPES`、`OIDC_ALLOWED_GROUPS`、`OIDC_GROUPS_CLAIM`、`OIDC_EMAIL_VERIFIED`。callback 為 `<ALDINE_PUBLIC_URL>/api/auth/oauth/oidc/callback`，每個 instance 只能接一個 OIDC provider。搭配 `ALDINE_SSO_ONLY=1` 就沒有密碼註冊這條路。 |
| h. 資源與持久化 | ✅ | 閒置：app 約 40–50 MB、compiler 約 21–28 MB。pgfplots＋biber 編譯尖峰約 1.2 CPU、約 85 MB。資料存在兩個 volume：`/data`（各專案的 git repo、worktrees、編譯輸出），以及 `/secrets`（users、sessions、meta、comments、yjs、簽章 secret，皆為 JSON）。預設是 JSON 檔案；Postgres（`DATABASE_URL`）是給多節點用的，我們用不到。上游有 `deploy/backup.sh`（兩個 volume 打包成 tar）。唯讀根目錄需要設 `CACHE_DIR=/tmp/...`，已驗證：不設定會因 `mkdir /srv/.cache` 失敗而無法啟動。 |

## 風險與緩解

1. **公開註冊**
   - 第一階段：nginx 在 `/api/auth/register` 加 Basic Auth，只有 Owner 能建帳號（片段見 `deploy/aldine/nginx-latex.conf.template`）。
   - 第二階段：Hub 後端實作 OIDC provider，Aldine 設 `ALDINE_SSO_ONLY=1`，由 Hub 決定誰能進來。
2. **無法停用帳號**
   - 第一階段只能手動編輯 `/secrets/users.json` 和 `sessions.json`。
   - 第二階段改 SSO 後，在 Hub 停用的人下次登入就會被擋，但現有 session 最多還能用 30 天（要靠 OIDC 文件中的撤銷步驟處理）。
3. **跨專案讀取**：上游的架構限制。所有 Aldine 帳號持有人都能讀到其他人的專案。只發帳號給實驗室成員；機密內容（例如審稿中的稿件、產學合約）不要放在 Aldine。建議向上游回報（依其 SECURITY.md 流程）。
4. **為什麼要用獨立網域**：如果掛在 Hub 的同源子路徑，Aldine 的前端程式和 Hub 同源。它的 JS 可以帶著使用者的 Hub cookie 呼叫 `/api/*`，而且會通過我們的 Origin 檢查；反過來也一樣。用獨立網域（例如 `latex.<domain>`）可以靠瀏覽器的同源政策把兩邊隔開，代價是需要多一筆 DNS 和憑證 SAN。
   **2026-10-20 決議：正式站（speech-ai-hub.gugulu.tw）改用子路徑 `/latex`（`LATEX_PATH`），使用者接受此風險**，以省去額外的 DNS 與反向代理設定。緩解措施：nginx 轉送給 Aldine 時移除 `hub_session` cookie、建立帳號仍需 Basic Auth、只開放實驗室成員。之後若有子網域，改設 `LATEX_HOSTNAME` 即可恢復隔離。
5. **專案很年輕**（3 個月、單一主要作者）：鎖定版本 tag；升級前先看 CHANGELOG，並依上述「備份方式」完成兩個 volume 的備份。如果專案停擺，資料都是標準 git repo 加 JSON，可以匯出到 Overleaf 或 GitHub。
6. **image 體積**：compiler 約 8 GB，加中文字型後再多約 0.3–0.5 GB。主機磁碟要預留空間。
7. **對外連線**：app 需要對外網路做 DOI、arXiv、Zotero 查詢（放在 `edge` 網路）；compiler 完全斷網。AI 修錯與 MCP 預設關閉，不要設任何 API key。

## 整合方式（建議）

- 檔案：`deploy/aldine/compose.aldine.yaml`（profile `latex`）、`compiler.Dockerfile`、`nginx-latex.conf.template`。
- 啟動：`docker compose -f compose.yaml -f deploy/aldine/compose.aldine.yaml --profile latex up -d`。兩個服務都不開 port。
- `.env` 新增：
  - `LATEX_HOSTNAME`（例如 `latex.localhost`）
  - `LATEX_ORIGIN`（例如 `http://latex.localhost`；設成 https 會自動加上 Secure cookie）
  - `LATEX_ADMIN_EMAILS`
  - 第二階段才需要：`LATEX_SSO_ONLY`、`LATEX_OIDC_ISSUER`、`LATEX_OIDC_CLIENT_ID`、`LATEX_OIDC_CLIENT_SECRET`
- nginx 需要：
  - 新增 `${LATEX_HOSTNAME}` 的 server block（HTTP 與 HTTPS 模板都要）。
  - `client_max_body_size 81m`，並轉送 WebSocket Upgrade（`/collab`）。
  - 用 resolver 加變數 upstream，讓 nginx 在沒啟用 `latex` profile 時也能啟動。
  - `/api/auth/register` 加 Basic Auth，並掛入 `latex-register.htpasswd`。
  - HTTPS 憑證的 SAN 要包含 `LATEX_HOSTNAME`。
- 前端：側欄的「LaTeX」連結開新分頁到 `LATEX_ORIGIN`，網址由 `/api/config` 提供（`OVERLEAF_URL` 可以改名為 `LATEX_URL`）。
- 備份：`scripts/backup.sh` 要加上 `latex_data` 和 `latex_secrets` 兩個 volume 的 tar。
