# Speech-AI Research Hub — 待辦事項

## 上線前必要項目

- [ ] 購買或指定正式網域。
- [ ] 將網域 DNS 接至 Cloudflare。
- [ ] 決定 Cloudflare TLS 模式；正式環境建議 `Full (strict)`。
- [ ] 為來源伺服器設定可信任 TLS 憑證或 Cloudflare Origin Certificate。
- [ ] 設定正式 `APP_ORIGIN`，例如 `https://research.example.com`。
- [ ] 設定正式 WebAuthn RP ID，必須是固定網域，例如 `research.example.com`。
- [ ] 設定正式 WebAuthn RP Name。
- [ ] 在正式網域驗證 Passkey 註冊、登入及 2FA 流程。
- [ ] 啟用 Cloudflare HTTPS redirect、HSTS 與基本 WAF／rate-limit 規則。
- [ ] 確認 Nginx 僅信任 Cloudflare 傳入的真實 client IP headers。
- [ ] 建立 PostgreSQL 定期備份與還原演練。
- [ ] 排程 `scripts/backup.sh`（PostgreSQL＋RustFS＋Aldine volumes）並做異地備份與容量監控。

## 目前開發模式

- 本機 origin：`http://localhost`（`APP_HTTP_PORT` 預設 80）；Aldine：`http://latex.localhost`
- 本機 WebAuthn RP ID：`localhost`
- Passkey 在 `localhost` 可測試；IP 位址或一般 HTTP 網域不可作正式 Passkey 環境。
- `.env`（chmod 600，`scripts/gen-env.sh` 產生）保存所有 secret；Compose 以環境變數傳入容器，非 Docker Secrets。

## 尚待確認

- [ ] 正式 LaTeX 子網域（`LATEX_HOSTNAME`），並讓 Hub 作為 Aldine 的 OIDC 登入來源（之後可關閉 Aldine 密碼註冊）。
- [ ] Linux VM 的 CPU、RAM、磁碟容量與備份位置。
- [ ] 決定媒體單檔大小上限及保存期限；目前接受 FFmpeg 可解析的影音格式並轉為 24 kHz mono 48 kbps AAC/M4A。
- [x] 邀請連結有效時間選項：5／30 分鐘、1／2／5 小時、1／3／5／7 天。
- [ ] 登入失敗鎖定門檻與管理通知方式。
- [ ] 是否需要 SMTP，以寄送邀請或安全通知。
