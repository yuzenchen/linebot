# linebot

LINE 官方帳號的客服機器人。收到訊息後用 Claude（或無 API key 時的規則式）分類，回答常見問題、檢查服務狀態回報異常、記錄需求建議，必要時轉交人工並通知管理員。資料存在 SQLite，以 Docker 部署在樹莓派。

- 規格：[docs/SPEC.md](docs/SPEC.md)
- 任務清單：[docs/PLAN.md](docs/PLAN.md)
- LINE 官方帳號 / Messaging API 設定：[docs/LINE-SETUP.md](docs/LINE-SETUP.md)

## 需求

- Node 22
- Docker Desktop
- cloudflared（開發期取得公開 webhook 網址）

## 本機啟動

方式一：直接跑（tsx watch）

```sh
npm install && npm run dev
```

方式二：Docker

```sh
cp .env.example .env      # 填入 LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN 等
mkdir -p data
docker compose up -d --build
curl localhost:8090/health
```

## 開發期 webhook

```sh
cloudflared tunnel --url http://localhost:8090
```

Windows 以 winget 安裝後的路徑為 `C:\Program Files (x86)\cloudflared\cloudflared.exe`。把印出的 `https://<隨機網址>/webhook` 貼到 LINE Developers 的 Webhook URL，步驟見 [LINE-SETUP.md 第 3b 節](docs/LINE-SETUP.md#3b-line-developers-console)。quick tunnel 網址每次重啟都會變。

## 環境變數

對應 `.env.example`；啟動時以 zod 驗證，必填缺少會直接結束。

| 變數                        | 預設                                           | 說明                                                        |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| `PORT`                      | `8090`                                         | 對外 port（Pi 上 80/443/3000-3002/3100/8080/8088 已被占用） |
| `DATA_DIR`                  | `./data`                                       | SQLite 與匯出檔位置（容器內固定 `/data`）                   |
| `LOG_LEVEL`                 | `info`                                         | fatal / error / warn / info / debug / trace / silent        |
| `LINE_CHANNEL_SECRET`       | （必填）                                       | Messaging API channel secret                                |
| `LINE_CHANNEL_ACCESS_TOKEN` | （必填）                                       | 長期 channel access token                                   |
| `ANTHROPIC_API_KEY`         | 空                                             | 留空時分類器改用規則式                                      |
| `CLASSIFIER_MODEL`          | `claude-opus-5-5`                              | 分類用模型                                                  |
| `HEALTH_CHECK_URL`          | `https://petsnack-backend.onrender.com/health` | 服務狀態檢查網址（正常 200、資料庫斷線 503）                |
| `HEALTH_CHECK_TIMEOUT_MS`   | `8000`                                         | 逾時重試一次後才判定異常                                    |
| `HEALTH_CACHE_MS`           | `30000`                                        | 狀態檢查結果快取時間                                        |
| `REPLY_DEADLINE_MS`         | `10000`                                        | 超過則先回「已收到」再 push                                 |
| `CONTEXT_MESSAGES`          | `6`                                            | 每位使用者帶入分類的最近訊息數                              |
| `ADMIN_LINE_USER_ID`        | 空                                             | 管理員 LINE userId；留空時管理通知只寫 log                  |
| `GROK_WEBHOOK_URL`          | 空                                             | Grok webhook 網址；留空時不轉送                             |
| `GROK_WEBHOOK_SECRET`       | 空                                             | Grok webhook 密鑰（介面待確認）                             |
| `TZ`                        | `Asia/Taipei`                                  | 時區                                                        |

## 指令

| 指令                             | 說明                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| `npm run dev`                    | tsx watch 啟動伺服器                                           |
| `npm run build`                  | 編譯到 `dist/`                                                 |
| `npm run start`                  | 執行 `dist/server.js`                                          |
| `npm run test`                   | vitest                                                         |
| `npm run lint`                   | eslint                                                         |
| `npm run format`                 | prettier 改寫（`format:check` 只檢查）                         |
| `npm run classify -- "文字"`     | 打真 API 測一句話的分類（需 `ANTHROPIC_API_KEY`）              |
| `npm run export:suggestions`     | 匯出需求建議到 `${DATA_DIR}/exports/suggestions-YYYY-MM-DD.md` |
| `npm run list-users [-- --json]` | 列出使用者、最後訊息時間與訊息數（可用來查管理員 userId）      |

CLI 讀 `.env`（若存在）與 `DATA_DIR`，不需要 LINE 金鑰。容器內可用 `docker compose exec linebot node dist/cli/list-users.js`（Pi 用 `-f docker-compose.pi.yml`）。

## 樹莓派部署

1. `git clone` 到 Pi，進入專案資料夾。
2. `cp .env.example .env` 並填值。
3. `mkdir -p data`（讓資料夾屬於 uid 1000；由 Docker 自動建立會是 root 所有，容器無法寫入）。
4. `docker compose -f docker-compose.pi.yml up -d --build`
5. 區網檢查：`curl http://<Pi 的 IP>:8090/health`
6. Cloudflare Zero Trust 新增 Public Hostname `linebot.<網域>`，Service 填 `http://linebot:8090`（容器透過外部 network `bfx-multi_default` 與 `bfx-cloudflared` 相連；該 network 不存在時 compose 會報錯）。
7. LINE Developers 的 Webhook URL 改成 `https://linebot.<網域>/webhook` 並 Verify（見 [LINE-SETUP.md 第 5 節](docs/LINE-SETUP.md#5-正式環境pi--cloudflare-tunnel)）。

- 更新：`git pull` 後重跑第 4 步。
- 改 `.env` 後：`docker compose -f docker-compose.pi.yml up -d --force-recreate linebot`
- 備份：複製整個 `data/`（含 `linebot.db-wal`、`-shm`），建議先 stop 再複製。
- 看 log：`docker logs -f linebot`

## 常見問題

- **Verify 失敗**：服務沒起來或 tunnel 網址過期。先 `curl https://<網址>/health`，確認網址結尾是 `/webhook`。
- **收不到回覆**：LINE Official Account Manager 的自動回應沒關或 Webhook 沒開（LINE-SETUP.md 第 3a 節）。
- **401 bad signature**：`LINE_CHANNEL_SECRET` 填錯（或改 `.env` 後沒重建容器）。
- **容器一直重啟**：`docker compose logs` 看原因，常見是 `.env` 缺必填變數。
- **Grok 未設定**：`GROK_WEBHOOK_URL` 留空時，服務相關問題會 push「此問題已轉交人工，會再回覆你」並通知管理員（`ADMIN_LINE_USER_ID` 也空則只寫 log）。

## 管理端 bot（第二階段）

同一套程式以 `BOT_PROFILE=admin` 跑第二個容器 `linebot-admin`，給管理員與店家老闆用自然語言查訂單、庫存與系統狀況（唯讀，後台 viewer 角色）。設定檔 `.env.admin`、資料夾 `data-admin/`，啟動加 `--profile admin`。規格見 `docs/SPEC-ADMIN.md`，LINE 帳號與 Cloudflare 設定見 `docs/LINE-SETUP.md` 第 8 節。
