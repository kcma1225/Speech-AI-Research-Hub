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
| g. OIDC | ✅（2026-10-20 已接上 Hub，見下節） | 設定 `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`（使用 PKCE S256）、`OIDC_SCOPES`、`OIDC_ALLOWED_GROUPS`、`OIDC_GROUPS_CLAIM`、`OIDC_EMAIL_VERIFIED`。callback 為 `<ALDINE_PUBLIC_URL>/api/auth/oauth/oidc/callback`，每個 instance 只能接一個 OIDC provider。搭配 `ALDINE_SSO_ONLY=1` 就沒有密碼註冊這條路。 |
| h. 資源與持久化 | ✅ | 閒置：app 約 40–50 MB、compiler 約 21–28 MB。pgfplots＋biber 編譯尖峰約 1.2 CPU、約 85 MB。資料存在兩個 volume：`/data`（各專案的 git repo、worktrees、編譯輸出），以及 `/secrets`（users、sessions、meta、comments、yjs、簽章 secret，皆為 JSON）。預設是 JSON 檔案；Postgres（`DATABASE_URL`）是給多節點用的，我們用不到。上游有 `deploy/backup.sh`（兩個 volume 打包成 tar）。唯讀根目錄需要設 `CACHE_DIR=/tmp/...`，已驗證：不設定會因 `mkdir /srv/.cache` 失敗而無法啟動。 |

## 風險與緩解

1. **公開註冊**
   - 第一階段：nginx 在 `/api/auth/register` 加 Basic Auth，只有 Owner 能建帳號（片段見 `deploy/aldine/nginx-latex.conf.template`）。
   - 第二階段（2026-10-20 完成）：Hub 後端是 OIDC provider，Aldine 設 `ALDINE_SSO_ONLY=1`，由 Hub 決定誰能進來。Basic Auth 保留（無害）。
2. **無法停用帳號**
   - 第一階段只能手動編輯 `/secrets/users.json` 和 `sessions.json`。
   - 已改 SSO（見下節）：在 Hub 停用的人拿不到登入代碼，下次登入就會被擋；但 Aldine 現有 session 最多還能用 30 天，要立即踢出仍需手動從 `sessions.json` 刪除。
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

## Hub SSO（OIDC）— 2026-10-20 實作

從 `ghcr.io/trahloff/aldine-app:0.12.3` 的 `apps/server/src/oidc.ts`、`oauth.ts`、`auth.ts`、`authz.ts`、`routes.ts` 讀出 Aldine 對 IdP 的要求：

| 項目 | Aldine 0.12.3 的行為 |
|---|---|
| 探索 | 由 **app 伺服器端**抓 `<OIDC_ISSUER>/.well-known/openid-configuration`（5 s timeout、`redirect: 'error'`、快取 1 h）。`issuer` 必須與設定相同；所有 endpoint 必須是 **https**（只有 loopback 例外）。容器在 `edge` 網路，實測可連到 `https://speech-ai-hub.gugulu.tw`（經外部 OpenResty 回流），所以不需要內部網址覆寫（Aldine 也沒有這種設定）。 |
| 流程 | authorization code + **PKCE S256**（一定送）+ `state` + `nonce`。scope 預設 `openid email profile`（`OIDC_SCOPES`）。 |
| iss 參數 | 若 discovery 宣告 `authorization_response_iss_parameter_supported`，callback 必須帶 `iss`（RFC 9207）。 |
| 用戶端驗證 | 有 secret 時預設 `client_secret_basic`（兩半先 form-encode）；只有 discovery 不列 basic 但列 post 時才用 `client_secret_post`。 |
| ID token | jose 以 JWKS 驗證；只接受非對稱演算法（RS*/PS*/ES*/EdDSA），採 discovery 的 `id_token_signing_alg_values_supported`（未列時預設 RS256）。必要 claims：`iss sub aud exp iat`；`nonce` 必須相符；token 年齡 ≤ 10 分鐘；時鐘誤差 60 s；`sub` ≤ 255 字。 |
| userinfo | 只有 ID token 缺 `email` 或缺 `name`/`preferred_username` 時才呼叫（Bearer）。 |
| Email | 只採用 `email_verified: true` 的 email（`OIDC_EMAIL_VERIFIED=require` 預設）。沒有 email 也能登入（以 subject 建帳號），但 email 是 **管理員判定**（`ALDINE_ADMIN_EMAILS`）與 **邀請協作者**（專案分享以 email 或 ORCID 比對）唯一的依據。 |
| 帳號對應 | 帳號 subject = `oidc:<sha256(iss) 前 16 字>:<sub>`。先以 subject 找；找不到再以 email 找，但**只會併入同一 provider 建立的帳號**，遇到同 email 的密碼帳號會拒絕（「請改用密碼登入」），不會被接管。 |
| callback | `<ALDINE_PUBLIC_URL>/api/auth/oauth/oidc/callback`，本站為 `https://speech-ai-hub.gugulu.tw/latex/api/auth/oauth/oidc/callback`。成功後導回 `/latex/`。 |
| `ALDINE_SSO_ONLY=1` | 關閉 register、login、改密碼、忘記密碼、重設密碼（403），登入頁只剩「Continue with …」。 |
| 管理員 | `ALDINE_ADMIN_EMAILS`（逗號分隔，不分大小寫）只開放 `/admin` 統計與帳號清單，看不到專案內容。 |

**Hub 的實作**（契約見 `docs/architecture.md`「OIDC provider」）：issuer `https://speech-ai-hub.gugulu.tw/api/oidc`，ES256 簽章，`sub` = Hub user id，`name` = Hub 名稱，email 為合成地址 `<Hub user id>@users.speech-ai-hub.invalid` 並標 `email_verified: true`：
- 為什麼要 email：沒有 email 就無法設定管理員，也無法邀請協作者。
- 為什麼用合成地址：Hub 帳號沒有 email；`.invalid` 是保留 TLD（RFC 6761），收不到信也不屬於任何人；用 id 而非名稱，改名不會改變 email。
- 為什麼可以標 verified：Aldine 不會把 SSO 身分併入同 email 的密碼帳號；SSO-only 後也無法再用密碼註冊搶先佔用該地址。
- 代價：邀請協作者時要輸入對方的合成 email（`<id>@users.speech-ai-hub.invalid`，id 可在 Aldine `/admin` 帳號清單看到）。之後若 Hub 加上選填且已驗證的 email，可改發真實 email（尚未實作）。

**本站設定**（`.env`）：`LATEX_OIDC_ISSUER`、`LATEX_OIDC_CLIENT_ID=aldine`、`LATEX_OIDC_CLIENT_SECRET`（48 字隨機）、`LATEX_OIDC_LABEL=Speech-AI Hub`、`LATEX_ADMIN_EMAILS=<Owner id>@users.speech-ai-hub.invalid`、`LATEX_SSO_ONLY=1`。

**實測（2026-10-20，經正式網域）**：未登入 Hub → 按「Continue with Speech-AI Hub」→ Hub 登入頁 → 登入後回到 Aldine 已登入；建立專案並編譯成功（pdfLaTeX 1.5 s）；第二位使用者得到獨立的 Aldine 帳號，看不到也打不開第一位的私人專案（403）；已登入 Hub 的人直接通過，不會看到登入頁；合成 email 列入 `LATEX_ADMIN_EMAILS` 即成為 Aldine 管理員；開啟 SSO-only 後密碼登入回 403，SSO 仍正常。

**已知限制**
- 登出不連動：登出 Hub 不會登出 Aldine，反之亦然（Aldine 不支援 RP-initiated／back-channel logout）。
- 停用不即時：Hub 停用帳號只擋下一次 SSO 登入；Aldine session 最長 30 天，需手動刪除。
- 角色不同步：Hub 角色不會帶到 Aldine（Aldine 只有「管理員 email 清單」）；教授（professor）也可使用 Aldine（審閱、共筆論文是合理用途），與其他帳號權限相同。
- 先前用密碼建立的測試帳號（`e2e-latex@lab.test`、`path-latex@lab.test`）在 SSO-only 下無法再登入，屬可刪除的測試資料。
