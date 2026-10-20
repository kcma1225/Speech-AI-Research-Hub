# Speech-AI Research Hub

研究專案協作網站。Next.js、PostgreSQL、Nginx、Quarto slides，以 Docker Compose 部署。

## 本機啟動

1. 初始化設定。新環境複製 `.env.example` 並填入四項 secret；既有環境保留目前 `.env`，不要重產 PostgreSQL 密碼：

   ```bash
   cp .env.example .env # Only on a new installation
   chmod 600 .env
   ```

   `.env` 為唯一設定來源；請勿提交或分享。Compose 將 secret 傳入容器環境變數；有 Docker 管理權限者可透過 `docker inspect` 讀取。

2. 建置並啟動。Quarto renderer 是獨立、無網路容器；上傳 ZIP 後由 App 排入編譯工作，無須在主機預先 render：

   ```bash
   docker compose up --build -d
   ```

3. 開啟：

   - App：<http://localhost/>
   - Slides：<http://localhost/slides>（首次部署可在管理頁上傳簡報 ZIP）
   - Overleaf 入口：<http://localhost/overleaf>；使用獨立分頁 <http://overleaf.localhost/> 登入。`localhost` 與 `overleaf.localhost` 不屬同站，iframe 會使 `SameSite=Lax` session cookie 被瀏覽器阻擋；因此 HTTP 開發環境不嵌入登入頁。正式環境若需嵌入，須先配置同站 HTTPS 子網域、cookie 與 CSP 並完整驗證。

4. 停止：

   ```bash
   docker compose down
   ```

資料保留於 Docker volumes。若要連資料一併刪除，才使用 `docker compose down -v`；此操作不可復原。

## Secret 規則

- `.env`：本機明文來源，權限 `600`，必須排除版本控制與備份分享；`.env.example` 不含真實密碼。
- 修改 `.env` 後執行 `docker compose up --build -d --force-recreate`。
- `OWNER_PASSWORD`：啟動時與上次設定值比較；變更後重設 Owner 密碼並撤銷其 sessions。Owner 在 Profile 更改的密碼可跨重啟保留，除非再次更改此環境設定。其他成員密碼不受影響。
- `POSTGRES_PASSWORD`：每次資料庫啟動同步既有 role 密碼，完成前健康檢查不通過；不要刪除 volumes。
- `AUTH_SECRET`：簽章簡報檢視 token（變更後已開啟的簡報需重新載入）；session 使用資料庫 token hash，改此值不撤銷 sessions。
- `OVERLEAF_INVITE_SECRET`：Overleaf 邀請 secret；變更可能讓既有邀請失效。
- `APP_HTTP_PORT`、`APP_HTTPS_PORT`、`APP_HOSTNAME`、`OVERLEAF_HOSTNAME`、`APP_ORIGIN`、`OVERLEAF_SITE_URL`、`OVERLEAF_URL` 可在 `.env` 修改。更新 hostname 後需同步 DNS／hosts 與 WebAuthn RP ID。
- HTTPS：把有效且涵蓋兩個 hostname 的 `fullchain.pem`、`privkey.pem` 放入 `nginx/certs/`，設定 `HTTPS_ENABLED=true`、`OVERLEAF_SECURE_COOKIE=true`，並將 `APP_ORIGIN`、`OVERLEAF_SITE_URL`、`OVERLEAF_URL` 改為 `https://`。憑證不入 Git；若 HTTPS 經 Cloudflare 等反向代理終止，維持 `HTTPS_ENABLED=false`，另行確認 forwarded protocol、cookie 與 CSP 設定。
- Secret 存於容器環境變數，非 Docker Secrets；限制 Docker socket 存取、主機檔案與部署日誌權限。

## 目前功能

- Owner 初始化與密碼登入；使用者可在設定獨立視窗更改名稱及密碼，需驗證目前密碼。
- 裝置記住非敏感 account hint，回訪只需輸入密碼。
- Owner／Admin／Member／Professor 角色；Professor 對筆記、標籤、媒體唯讀，可對簡報新增多次審閱；Owner 可回覆。
- 影音上傳後由 App 背景轉碼，進度與階段存於 PostgreSQL；可離開頁面、查看進度與取消。轉碼完成在 App 內提示；不是系統推播。取消會清除暫存與輸出檔。處理中重啟 App 時工作標為中斷並清理檔案；需重新上傳。單一 App 容器使用；多副本部署需獨立工作佇列。
- Admin 建立邀請連結，可選角色、期限（含永久）與使用次數（1 次或無限次）。
- 邀請 token 雜湊保存，建立帳號時以 transaction 單次消耗。
- 研究筆記（`/notes`）：唯一 Markdown 文件入口；每份筆記有獨立頁面（`/items/[id]`），可編輯內容、名稱、日期、標籤、錄音與逐字稿。`/records` 永久轉址 `/notes`。
- 標籤：可自由新增、改名、刪除（名稱 1–40 字，不分大小寫唯一）；新筆記預設無標籤；刪除標籤不刪筆記。
- 篩選與搜尋：標籤篩選含「全部」「無標籤」，預設全選；搜尋比對名稱與內容。URL 省略 `tags` 代表全選，`tags=` 代表全不選，`none` 代表無標籤。
- 自製 accessible dialog，沒有原生 `alert`、`confirm`、`prompt`。
- 亮色、暗色、跟隨系統 icon control。
- 簡報（`/slides`）：ZIP 匯入 QMD、CSS、圖片，隔離 Quarto renderer 編譯；每份簡報獨立路徑、版本、標籤、參考資料（PDF／連結）。有參考資料時必有一筆預設；未附資料可留空。內建 deck 也用相同匯入流程，不走 nginx alias。
- Member 等非 Professor 角色可設定每份簡報是否讓所有人檢視；公開與分享連結可看簡報、參考資料、審閱，但訪客不能評論。分享連結是 capability URL，勿張貼於公開位置。
- 簡報 iframe 以 `sandbox`（無 `allow-same-origin`）與 CSP 隔離：iframe 為 opaque origin，不帶 cookie，因此播放頁會為每個版本產生 12 小時有效、以 `AUTH_SECRET` 簽章的路徑 token（`/slides/view/<slug>/t.<到期>.<簽章>/<versionId>/…`）。更換 `AUTH_SECRET` 會讓所有已開啟的簡報 token 失效。Web Storage 由記憶體替代，annotate 筆跡重新載入即消失。

## 尚未完成

見 [`TODO.md`](TODO.md)。Passkey、2FA、完整 session 管理及 Cloudflare 正式網域設定仍需完成，不能視為 production-ready authentication。

## Notifications, Web Push

- Media processing completion creates in-app notification and Web Push.
- Header message icon opens notification panel (unread highlighted, read on click). Push settings live in profile settings.
- Push needs `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in `.env` (generate: `npx web-push generate-vapid-keys`).
- Phone push requires HTTPS (localhost exempt). iPhone/iPad: only works after "Add to Home Screen" (iOS 16.4+).
- Browsers cannot open OS notification settings from web page; denied state shows platform steps and a copyable `chrome://settings` link.

## Transcripts

- Recording item: Edit data dialog accepts `.srt` (max 5 MB). Parsed cues are stored in `items.transcript`.
- Player shows transcript toggle only when cues exist; current cue highlighted and auto-scrolled; click cue seeks.
