# Speech-AI Research Hub

研究室協作網站：管理每週組會簡報（Quarto）、研究筆記、錄音與逐字稿，並提供自架協作 LaTeX（Aldine）。

架構（詳見 [`docs/architecture.md`](docs/architecture.md)）：

```
nginx（唯一對外 port）─┬─ /        SvelteKit 靜態前端
                      ├─ /api/*   backend（Node 22 + Fastify）── PostgreSQL、RustFS（S3）
                      └─ /latex 或 LATEX_HOSTNAME → Aldine（選用，profile latex）
worker（Quarto + Chrome + ffmpeg）從 PostgreSQL 取工作、讀寫 RustFS，無對外網路
```

## 啟動

```bash
scripts/gen-env.sh                # 產生 .env（隨機 secret，chmod 600；已存在時不覆寫）
docker compose up -d --build      # 主系統：http://localhost/
docker compose --profile latex up -d --build   # 連同 Aldine：http://latex.localhost/
docker compose down               # 停止；資料保留在 volumes
```

- 初始管理員帳號名稱為 `ADMIN_NAME`（預設 `admin`），密碼見 `.env` 的 `ADMIN_PASSWORD`。管理員帳號只管理系統（帳號、邀請、模型、系統設定），不能使用研究工作區；學生與教授請用邀請連結加入。
- 修改 `.env` 後：`docker compose up -d --build --force-recreate`。
- `docker compose down -v` 會刪除所有資料，不可復原。
- 健康檢查：`/api/health`（存活）、`/api/health/ready`（DB 與 S3 可用）。

## v3 staging（`v3-study` 分支）

v3 在獨立的 compose project `hubv3` 測試，只綁 `127.0.0.1:18090`，有自己的 volumes（`hubv3_*`）與 `.env.staging`，不會動到正式站（`hubv2`）。

```bash
scripts/staging.sh up      # 第一次會產生 .env.staging（管理員帳號 admin，密碼隨機產生，存在 .env.staging 的 ADMIN_PASSWORD），建置並啟動
scripts/staging.sh ps      # 狀態；logs [service…] 看紀錄
scripts/staging.sh down    # 停止（資料保留）
scripts/staging.sh reset   # 停止並刪除 staging 資料（會再確認一次）
```

開啟 http://127.0.0.1:18090 ，以 `admin` 和 `.env.staging` 裡的 `ADMIN_PASSWORD` 登入。

## 設定重點（`.env`）

- `APP_ORIGIN`：瀏覽器使用的網址。寫入請求的 `Origin` 必須一致，否則回 403（CSRF 防護）。
- `ADMIN_PASSWORD`：變更後下次啟動會重設初始管理員密碼並登出；在「設定」改的密碼在 env 未變時保留。舊的 `OWNER_NAME` / `OWNER_PASSWORD` 在 `ADMIN_*` 留空時仍會讀取。
- `POSTGRES_PASSWORD`、`WORKER_DB_PASSWORD`：每次 db 啟動會重新套用到既有 role。worker 使用最小權限的 `hub_worker`（只能讀寫 `jobs` 表）。
- `AUTH_SECRET`：簽章簡報檢視 token；更換後已開啟的簡報需重新整理。Session 不受影響。
- `S3_ACCESS_KEY`、`S3_SECRET_KEY`：RustFS 帳密，backend 與 worker 共用。
- 前面有反向代理（如 OpenResty、Cloudflare）時：在代理終止 TLS，`HTTPS_ENABLED=false`、`APP_ORIGIN=https://<網域>`，並把代理的 IP 填入 `TRUSTED_PROXIES`，否則所有人共用代理 IP 的登入頻率限制。
- HTTPS：把涵蓋 `APP_HOSTNAME`（與 `LATEX_HOSTNAME`）的 `fullchain.pem`、`privkey.pem` 放進 `nginx/certs/`，設 `HTTPS_ENABLED=true` 並把 origin 改成 `https://`。若 TLS 在 Cloudflare 等前端終止，維持 `false`。
- Web Push：`VAPID_*`（`npx web-push generate-vapid-keys`）。手機推播需要 HTTPS，iOS 需先加入主畫面。

## Aldine（協作 LaTeX）

- 兩種掛法（擇一）：
  - 獨立主機名（建議，與 Hub 隔離）：`LATEX_HOSTNAME=latex.<網域>`、`LATEX_ORIGIN=https://latex.<網域>`。只有 IP 時可用 `latex.<IP>.nip.io`；`latex.localhost` 只在伺服器本機有效。
  - Hub 網址下的路徑（目前正式站的做法，不需額外 DNS）：`LATEX_PATH=/latex`、`LATEX_ORIGIN=https://<網域>/latex`。Aldine 與 Hub 同源，若 Aldine 有 XSS 漏洞可冒用登入中的 Hub 使用者（已接受的風險）；nginx 會移除轉給 Aldine 的 `hub_session` cookie。
- 反向代理需轉送 WebSocket（`Upgrade`／`Connection` 標頭），否則即時協作無法同步。
- Aldine 沒有邀請制：建立帳號的網址受 nginx Basic Auth 保護（帳號 `owner`，密碼 `LATEX_REGISTER_PASSWORD`）。
- 帳號只開給實驗室成員：Aldine 使用者之間可以讀到彼此的專案檔案（上游限制，已接受）。不要放保密稿件。
- 編譯 image 約 8 GB（TeX Live＋Noto CJK），請預留磁碟。評估細節見 [`docs/aldine-evaluation.md`](docs/aldine-evaluation.md)。

## 簡報

把單份 deck 的 QMD、CSS、圖片打包成 ZIP 上傳；系統自動加入 annotate 標註插件，由隔離的 worker 編譯成 reveal.js 與 PDF。含多個 QMD 時需指定入口，除非根目錄有 `index.qmd`。macOS Finder 壓縮的 ZIP 可直接上傳（`__MACOSX`、`.DS_Store` 會略過）。`slides/` 保留範例 deck 原始碼與標註插件說明（[`slides/README.md`](slides/README.md)）。

## 備份與 v1 資料

- `scripts/backup.sh [compose 專案名]`：PostgreSQL dump＋RustFS bucket 鏡像＋Aldine volumes，寫到 `backups/<時間>/`。
- `scripts/export-legacy.sh <v1 專案名>`：在執行 v1 的主機上把舊資料（DB dump、每則筆記一個 Markdown、錄音、簡報）匯出到 `legacy-export/<時間>/`。v2 不匯入舊資料。

## 開發

各服務的指令見 [`CLAUDE.md`](CLAUDE.md)。尚未完成的上線項目見 [`TODO.md`](TODO.md)（Passkey／2FA 尚未實作）。
