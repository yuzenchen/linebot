# T9 整體驗證紀錄

- 日期：2026-10-29
- Commit：`4e16a51`（feat: T6b Cursor Automations 非同步 callback…）
- 環境：Windows 10、Node 22、Docker Desktop

## SPEC §10 MVP 完成定義

| 項目 | 結果 | 依據 |
| --- | --- | --- |
| 本機 Docker 起服務，`/health` 回 200 | ✅ | `docker compose ps` healthy；`curl :8090/health` → `{"status":"ok"}` |
| LINE 測試帳號加好友收到歡迎詞 | ⏳ | 需真實 LINE 帳號，留給使用者 |
| 五類訊息 10 秒內回覆；SQLite 有 messages / classifications | ⏳ / ✅ | 本機 smoke：messages、classifications 皆寫入（規則式）；實際收到回覆需真實 LINE |
| `HEALTH_CHECK_URL` 指向不存在網址 → incidents 紀錄 | ✅（push ⏳） | incidents 一筆 `health_status=down`；管理員 push 因假 token 401，需真實 LINE 驗證 |
| 需求建議存入 `suggestions`，`export:suggestions` 產出 Markdown | ✅ | suggestions 一筆；export exit 0 產出 `.md` |
| 重送同一 webhook body 不重複回覆 | ✅ | 重送 → 200，messages 不增加 |
| 拔掉 `ANTHROPIC_API_KEY` 仍能回覆（規則式） | ✅ | 無 key 下 classifier=`rule`，流程完整走完 |
| `npm test` / `lint` / `build` 通過 | ✅ | 見下方 |
| `docker-compose.pi.yml` 在 Pi + Cloudflare Tunnel 收到 webhook | ⏳ | 需 Pi，留給使用者 |

## 1. Git 狀態

```
$ git status --short        # （無輸出，乾淨）
$ git log --oneline -3
4e16a51 feat: T6b Cursor Automations 非同步 callback、grok_tasks、逾時 sweeper；SPEC 5.6 與 automation 設定文件
b94367a style: handoff 關鍵字陣列排版
608813c feat: T7 人工轉接、低信心連續觸發、管理員指令 /status /resume /handoff
```

## 2. 靜態檢查與測試（皆 exit 0）

```
$ npm run lint           → eslint .（無錯誤）
$ npm run format:check   → All matched files use Prettier code style!
$ npm test               → Test Files 25 passed (25) / Tests 156 passed (156)
$ npm run build          → tsc -p tsconfig.json（無錯誤）
```

## 3. 由已提交樹建置映像 ✅

```
$ git archive --format=tar HEAD | docker build -q -t linebot-verify -
sha256:b6e54ccf25c5…
$ docker run --rm linebot-verify ls knowledge dist/db/migrations
dist/db/migrations: index.js index.js.map
knowledge: 00-about.md 10-products.md 20-ordering.md 30-payment.md 40-shipping.md 50-account.md 90-tone.md welcome.md
$ docker rmi linebot-verify   → Deleted
```

## 4. 使用者容器（唯讀檢查）✅

```
$ docker compose ps
linebot-linebot-1   linebot-linebot   Up 44 seconds (healthy)   0.0.0.0:8090->8090/tcp
$ curl -s http://localhost:8090/health
{"status":"ok","uptime":44,"version":"0.1.0"}
```

## 5. 本機 smoke（port 8099，無 Anthropic / Grok 設定）

環境：`PORT=8099 LINE_CHANNEL_SECRET=test-secret LINE_CHANNEL_ACCESS_TOKEN=x DATA_DIR=./tmp-verify ADMIN_LINE_USER_ID=Uadmin HEALTH_CHECK_URL=http://127.0.0.1:1/health node dist/server.js`；以 HMAC-SHA256 簽章腳本送 webhook（userId `Uverify1`，每次新 `webhookEventId`）。

| 案例 | 結果 |
| --- | --- |
| a. 無簽章 | ✅ 401 |
| b. 有貓咪的零食嗎 | ✅ 200，classification `service_related`（rule） |
| c. 網站打不開 | ✅ 200，`incident_report`；incidents `health_status=down`（health check：`fetch failed (bad port)`） |
| d. 希望可以用信用卡 | ✅ 200，`feature_request`；suggestions 一筆；job `summarize_suggestion` → `skipped`（`grok_not_configured`），5 秒內 |
| e. 今天天氣如何 | ✅ 200，`service_related`（rule） |
| f. 我要找真人 → 還在嗎 | ✅ `users.handoff_until=2026-10-30T15:39:58Z`；兩則訊息皆無 classification（轉接中直接轉發） |
| g. 重送 (b) 原始 body | ✅ 200，messages 未增加 |
| h. `/status`（Uadmin） | ✅ log 出現 `admin command` |
| i. `POST /grok/callback` 無 token | ✅ 503 |

全部案例後 `/health` → `{"status":"ok","uptime":36}`，程序未中斷。LINE API 因假 token 回 401（`HTTPFetchError: 401 - Unauthorized`），屬預期。

資料表筆數（`tmp-verify/linebot.db`）：

```
events 7   messages 7   classifications 5   incidents 1   suggestions 1   push_log 0   grok_tasks 0
jobs: service_question pending ×3 (last_error "401 - Unauthorized")；summarize_suggestion skipped ×1 (grok_not_configured)
```

備註：events / messages 為 7 筆是因 `/status` 第一次被 Git Bash 路徑轉換成 `E:/Git/status` 送出（被歸為 service_related），之後以 `MSYS_NO_PATHCONV=1` 重送正確的 `/status`；計數取於重送前。push_log 為 0 是因 push 以假 token 失敗。結束後已停止伺服器並刪除 `tmp-verify`。

## 6. CLI（`DATA_DIR=./tmp-verify2`，空資料庫）✅

```
$ npm run list-users -- --json   → []            exit 0
$ npm run export:suggestions     → 已匯出 0 筆 → tmp-verify2\exports\suggestions-2026-10-29.md   exit 0
```

已刪除 `tmp-verify2`。

## 尚未驗證

- 以正式 channel token 的真實 LINE 來回（歡迎詞、五類回覆、10 秒內、管理員 push）。
- Cursor Automations（Grok）端到端：任務建立 → callback → 結果回寫。
- Pi 部署（`docker-compose.pi.yml` + Cloudflare Tunnel 收 webhook）。
- Anthropic classifier 實際呼叫真實 API 的分類品質與延遲。


## 補記（2026-10-30）

- 正式環境（Pi + Cloudflare Tunnel，`https://linebot.yuzen.tw`）已收到 LINE webhook 並正確回覆：「運費多少」→ `kb_answer` 0.95。
- 曾被 Cloudflare 自訂規則（台灣以外封鎖）擋成 403，已加 Skip 規則放行 `/webhook`（ASN 38631）與 `/grok/callback`。
- 本機開發容器與 cloudflared 已停止。
