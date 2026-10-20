# Speech-AI Research Hub

研究室協作網站：管理每週組會簡報（Quarto）、研究筆記、錄音與逐字稿，並提供自架協作 LaTeX（Aldine）。

架構（詳見 [`docs/architecture.md`](docs/architecture.md)）：

```
nginx（唯一對外 port）─┬─ /        SvelteKit 靜態前端
                      ├─ /api/*   backend（Node 22 + Fastify）── PostgreSQL、RustFS（S3）
                      └─ LATEX_HOSTNAME → Aldine（選用，profile latex）
worker（Quarto + Chrome + ffmpeg）從 PostgreSQL 取工作、讀寫 RustFS，無對外網路
```

## 啟動

```bash
scripts/gen-env.sh                # 產生 .env（隨機 secret，chmod 600；已存在時不覆寫）
docker compose up -d --build      # 主系統：http://localhost/
docker compose --profile latex up -d --build   # 連同 Aldine：http://latex.localhost/
docker compose down               # 停止；資料保留在 volumes
```

- Owner 帳號名稱為 `OWNER_NAME`，密碼見 `.env` 的 `OWNER_PASSWORD`。之後在 App 內邀請成員。
- 修改 `.env` 後：`docker compose up -d --build --force-recreate`。
- `docker compose down -v` 會刪除所有資料，不可復原。
- 健康檢查：`/api/health`（存活）、`/api/health/ready`（DB 與 S3 可用）。

## 設定重點（`.env`）

- `APP_ORIGIN`：瀏覽器使用的網址。寫入請求的 `Origin` 必須一致，否則回 403（CSRF 防護）。
- `OWNER_PASSWORD`：變更後下次啟動會重設 Owner 密碼並登出 Owner；在 Profile 改的密碼在 env 未變時保留。
- `POSTGRES_PASSWORD`、`WORKER_DB_PASSWORD`：每次 db 啟動會重新套用到既有 role。worker 使用最小權限的 `hub_worker`（只能讀寫 `jobs` 表）。
- `AUTH_SECRET`：簽章簡報檢視 token；更換後已開啟的簡報需重新整理。Session 不受影響。
- `S3_ACCESS_KEY`、`S3_SECRET_KEY`：RustFS 帳密，backend 與 worker 共用。
- HTTPS：把涵蓋 `APP_HOSTNAME`（與 `LATEX_HOSTNAME`）的 `fullchain.pem`、`privkey.pem` 放進 `nginx/certs/`，設 `HTTPS_ENABLED=true` 並把 origin 改成 `https://`。若 TLS 在 Cloudflare 等前端終止，維持 `false`。
- Web Push：`VAPID_*`（`npx web-push generate-vapid-keys`）。手機推播需要 HTTPS，iOS 需先加入主畫面。

## Aldine（協作 LaTeX）

- 必須使用獨立主機名（`LATEX_HOSTNAME`、`LATEX_ORIGIN`），不可掛在 Hub 網址的子路徑下。
- 只有 IP、沒有網域時：用 `latex.<IP>.nip.io`（公共 DNS 會解析回該 IP），例如 `LATEX_HOSTNAME=latex.162.38.3.177.nip.io`、`LATEX_ORIGIN=http://latex.162.38.3.177.nip.io:18080`。`latex.localhost` 只在伺服器本機有效，其他裝置連不到。
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
