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


## 第二階段補記（2026-10-30）

- 管理端 bot（yuzenadmin）部署於 Pi 容器 `linebot-admin`，對外 `https://linebot-admin.yuzen.tw`，WAF Skip 規則已涵蓋兩個 host。
- 正式環境 log：viewer 登入 200、`GET /orders` 200，四次自然語言查詢 outcome `answered`、latency 4.6 到 7.7 秒、`piiRevealed:false`、第二次起 `cache_read_input_tokens` > 4000。
- 客戶端 → 管理端的 `/internal/notify` 轉送已啟用，內網連通與 401 保護已驗證。
- 尚未在正式環境實測：report_issue 經 Cursor 回推、店家老闆帳號。


## 群組查詢與區間營收（2026-11-04）

- `a4da43d`（SPEC-ADMIN §14 群組查詢、`/bug`）與 `534b55e`（§15 `revenue`）已部署 Pi `linebot-admin`，migration 007 已套用。群組查詢與 `/bug` 尚未在正式環境實測。
- §15.4 口徑比對（11-04 18:4x）：`stats.month.revenue` = 4,259；同區間（11-01 ~ 11-04，已付款、未取消、依下單時間）逐頁加總 = 4,259，3 筆，一致。樣本小，跨月付款的差異尚未出現過。
- 私訊實測：「上個月營收多少」→ `revenue` 10-01 ~ 10-31，NT$123,673、71 筆（LINE Pay 58 筆 NT$101,133、轉帳 13 筆 NT$22,540），7.1 秒。10-29 時 `stats` 本月為 NT$122,363，與月底加總趨勢相符。
- 「本月營收多少」走 `stats`，但模型多附了 revenue 的口徑句；prompt 已改為只有 `revenue` 才附。
- 店家老闆 userId 已加入 Pi `.env.admin` 的 `GROUP_COMMAND_USER_IDS`（只開群組，未加 `ADMIN_USER_IDS`）；備份 `.env.admin.bak-20261104`。


## 員工打卡與薪資 bot（2026-11-12）

- `8eba38e`（T20、T21）已部署 Pi 容器 `linebot-staff`（profile `staff`、host 8092、`./data-staff`），對外 `https://linebot-staff.yuzen.tw`；migration 001–008 套用，`/health` 200，未簽章 webhook 401，`/grok/callback` 404。
- 員工 channel 掛在 Wama 公司的 LINE provider 底下，userId 與客服、管理端 bot 不同；`STAFF_ADMIN_USER_IDS`（使用者、店家老闆）與 `STAFF_GROUP_IDS` 都是從員工 bot 自己的 `events` 取得。`.env.staff` 本機與 Pi 各一份且一致；Pi 備份 `.env.staff.bak-20261112`。
- 啟動時排程補跑 2026-10（無員工、無資料，未發送任何訊息）；重啟後未重跑，冪等正常。
- 正式環境實測（使用者與老闆）：2 名員工群組註冊 → 管理員核准並設定時薪 → 群組上班、下班打卡各 1 班 → 管理員手動「結算 2026-11」。`audit_log` 有 `approve_registration` 2 筆、`payroll_run` 2 筆，log 無錯誤。
- 尚未在正式環境實測：補卡申請與核准、時薪中途調整、刪除打卡、超過 16 小時與重複打卡的回覆、每月 1 日自動結算（第一次在 2026-12-01 09:00）、員工未加好友時的總表標註。


## 管理端傳圖片查詢（2026-11-12）

- `e847efb`（T22、SPEC-ADMIN §16）已部署 Pi `linebot-admin`，migration 009 套用；容器內 `sharp` 把 3000×1500 縮成 1280×640 正常。
- 私訊實測：連傳 2 張截圖只回一次「已收到圖片」；接著問「為什麼這位客人網站不能存取」→ 2 張都附上（`failed` 0），模型呼叫 `health` 後依截圖判斷為客人被網站安全防護擋下，17.9 秒。
- 用量（`admin_queries` id 40）：第 1 輪 cache write 9,132（距上次查詢超過快取時效，system 也重寫）；第 2 輪 cache read 9,132、write 292，**含圖片的前綴命中快取**。全次 output 1,136。依 Opus 5.5 價格約 US$0.07（約 NT$2.3），其中模型輸出約三分之一。
- 群組貼圖後 tag 查詢、10 分鐘過期、非白名單與他人圖片不帶入：使用者決定暫不實測（單元測試已涵蓋）。T22 標為完成。


## 員工 bot 補卡改進與正式上線準備（2026-11-12）

- `7a1372d`（T23、SPEC-STAFF §15）已部署 Pi `linebot-staff`；部署前備份 `data-staff/linebot.db.bak-20261112-pre010`。migration 009、010 套用，`correction_requests` 含 `cancelled`、`staff_reminders` 已建；`/health` 200，未簽章 webhook 401。
- migration 010 部署前先以正式資料庫複本試跑：3 筆補卡、id 與 AUTOINCREMENT 保留，`foreign_key_check` 空、`integrity_check` ok。
- 提醒排程啟動後寫入 2026-11-12 一筆（無符合項目，未發送）。
- 清理測試資料（使用者授權，先備份 `data-staff/linebot.db.bak-20261112-cleanup`）：刪除 E001、E002 的員工、時薪、打卡與 2026-11 測試結算（`payroll_runs` id 2）；刪除 E003 的 3 班打卡與 R001–R003；相關 `audit_log` 6 筆一併刪除；`shifts`、`correction_requests` 編號歸零。保留 E003 帳號與 2026-10 排程結算紀錄。
- 正式群組加入 `STAFF_GROUP_IDS`（測試群組保留），本機與 Pi `.env.staff` 一致；Pi 備份 `.env.staff.bak-20261112b`。
- 尚未在正式環境實測：整班補卡、取消、修改打卡、核准失敗通知、待審提醒實際發送。


## 補卡範圍與每日備份（2026-11-12）

- `b866001`（補卡、代補、修改範圍改為上個月 1 日起）與 `77dd673`（T24、SPEC-STAFF §16）已部署 Pi `linebot-staff`；部署前備份 `data-staff/linebot.db.bak-20261112-pre011`，migration 011 套用。
- 備份試算表「Wama 員工出勤備份」與 Apps Script 獨立專案（同名、`openById`）建在使用者 Google 帳號；網頁應用程式執行身分為使用者、存取「所有人」，指令碼屬性 `TOKEN` 由使用者填入。網址與 token 只在本機與 Pi `.env.staff`（Pi 備份 `.env.staff.bak-20261112c`）。
- 錯誤 token POST → `{"ok":false,"error":"unauthorized"}`。
- 容器啟動後當天排程備份立即執行成功（`staff_backups` id 1）：員工 1、時薪 1、打卡 0、補卡 0、結算 0、操作紀錄 2；試算表各分頁內容與資料庫一致，備份資訊分頁記錄資料庫版本 11。
- 尚未實測：管理員 `備份`、`備份 強制`、筆數減少拒絕、失敗通知與恢復通知；補卡範圍新規則的實際回覆。
