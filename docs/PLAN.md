# 實作計畫

規格見 `docs/SPEC.md`。任務依序編號；「依賴」為前置任務。Tier 依 savvy-flow 分級（Light / Medium / Careful / Heavy / Fable）。每個任務完成後由 orchestrator 審查、更新本檔狀態並 commit。

狀態：`[ ]` 待做、`[~]` 進行中、`[x]` 已接受。

## T1 Scaffold（Medium）— 依賴：無

- [x] 狀態（2026-10-29 接受）

建立 npm 專案（ESM、TypeScript 5、Node 22）：`package.json` scripts `dev`（tsx watch）、`build`（tsc）、`start`、`test`（vitest）、`lint`、`format`、`format:check`、`export:suggestions`、`list-users`。安裝 hono、@hono/node-server、@line/bot-sdk、@anthropic-ai/sdk、better-sqlite3、zod、pino、pino-pretty（dev）、vitest、tsx、eslint + typescript-eslint、prettier。`src/config.ts` 以 zod 讀 env（SPEC 3.1 全部變數與預設值）。`src/logger.ts` pino 含 redact。`src/server.ts` Hono app 提供 `GET /health`（回 `{status:"ok", uptime, version}`）與 `POST /webhook` 佔位（回 200）。多階段 `Dockerfile`（builder → production，非 root uid 1000，`HEALTHCHECK`）、`docker-compose.yml`（port 8090、`./data:/data`、env_file）、`docker-compose.pi.yml`（SPEC 3.3：external network `bfx-multi_default`、alias `linebot`、mem_limit 256m、`8090:8090`）、`.dockerignore`、`.env.example`（所有變數加註解）、`.editorconfig`、`eslint.config.js`、`.prettierrc`、`tsconfig.json`、`vitest.config.ts`。一個 smoke test 打 `/health`。更新 `filemap.md`。

驗證：`npm install && npm run lint && npm test && npm run build` 通過；`docker compose up -d --build` 後 `curl localhost:8090/health` 回 200。

## T2 資料層與 jobs 佇列（Careful）— 依賴：T1

- [x] 狀態（2026-10-29 接受）

`src/db/index.ts` 開啟 `${DATA_DIR}/linebot.db`（WAL、busy_timeout 5000），`src/db/migrate.ts` 依序套用 `src/db/migrations/*.sql`（`schema_migrations` 表記錄）。`001_init.sql` 建 SPEC 第 7 節全部表與索引（`messages(user_id, created_at)`、`jobs(status, run_after)`、`push_log(created_at)`）。Repository 模組：`events.ts`（`insertIfNew` 回 boolean）、`users.ts`（upsert、handoff 欄位、low_conf_streak）、`messages.ts`（insert、`recent(userId, n)`）、`classifications.ts`、`incidents.ts`（insert、`recentByStatus(status, withinMs)`）、`suggestions.ts`（insert、update summary、list）、`pushLog.ts`（insert、`countMonth()`）、`jobs.ts`。`src/jobs/queue.ts`：`enqueue(type, payload, runAfter?)`、`startWorker(handlers)` 單迴圈每 2 秒撈一筆 pending、最多 5 次、退避 `2^attempts * 5s`、啟動時 `running → pending`、`stop()` 等當前任務結束。全部 repository 以 prepared statements；型別用 zod schema 推導。

驗證：vitest 以臨時目錄建 DB 測 migrations 可重複執行、`insertIfNew` 去重、jobs 重試與退避、`countMonth`。

## T3 LINE webhook 與 Replier（Careful）— 依賴：T2

- [x] 狀態（2026-10-29 接受）

`src/line/client.ts` 建 `MessagingApiClient`。`src/line/webhook.ts`：Hono route 讀 raw body，`validateSignature(body, secret, header)` 失敗回 401；解析 events，逐一 `events.insertIfNew`，新事件交 `dispatcher.dispatch(event)`（`setImmediate`，catch 全部例外記 error）；立刻回 200。`src/line/replier.ts`：`reply(replyToken, messages[])`、`push(userId, messages[], reason)`、`showLoading(userId, seconds)`、`replyOrPush(replyToken, userId, messages, reason)`；reply 遇 HTTP 400 或錯誤訊息含 `Invalid reply token` 改 push；同一 replyToken 只用一次（記憶體 Set）；push 成功後寫 `push_log`；訊息陣列最多 5 則、文字最長 5000 字截斷。`src/handlers/dispatcher.ts`：只處理 `source.type === 'user'`；`message/text` → `handleTextMessage`（T5 實作，此處先呼叫佔位）；其他 message type → SPEC 5.8 固定回覆；`follow` → 歡迎詞（讀 `knowledge/welcome.md`，T4 會建，此處先有 fallback 文案）；`unfollow` → `users.followed = 0`；群組事件只 log。所有進出訊息寫 `messages`。

驗證：vitest 整合測試用真實 channel secret 字串算 HMAC 打 `/webhook`，驗證 401 / 200、重送同 body 第二次不觸發 handler（mock dispatcher）；Replier 單元測試 mock client 驗證 400 fallback 與 push_log。

## T4 分類器與知識庫（Medium）— 依賴：T2

- [x] 狀態（2026-10-29 接受）

`knowledge/` 建 SPEC 第 8 節全部檔案，內容依 `E:\website\README.md` 與 `E:\website\wama-house-backend\README.md` 的功能描述整理成 FAQ 口吻（商品分類、組合包、加價購、免運 NT$500、LINE Pay / 銀行轉帳 / 超商代碼、超商取貨、會員與經銷）；不確定的事實寫「請洽客服確認」而非編造；絕不放金鑰、網址、帳號。`src/classifier/knowledge.ts` 載入並串接。`src/classifier/types.ts` zod schema（SPEC 5.3）。`src/classifier/anthropic.ts`：使用 `@anthropic-ai/sdk` 的 `client.messages.parse()` 配 zod schema（實作前先讀 claude-api skill 的 `typescript/claude-api/README.md` 與 `tool-use.md` 結構化輸出段落，不憑記憶寫 SDK 呼叫），model 來自 config，`output_config.effort: "low"`，system 為陣列：`[固定規則 block, 知識庫 block (cache_control ephemeral)]`，messages 為最近脈絡（in→user、out→assistant）+ 本則；`max_tokens` 1024；逾時 20 秒；任何錯誤丟出讓上層退回規則式。`src/classifier/rule.ts` 關鍵字規則。`src/classifier/index.ts` `createClassifier(config)`：有 key → Anthropic 包一層 fallback 到 Rule；無 key → Rule。信心度降級規則（SPEC 5.3）放在 `normalize()`。

驗證：vitest 測 Rule 分類、normalize 降級、knowledge 載入順序；Anthropic 以 mock client 測 parse 結果映射與錯誤 fallback。另提供 `npm run classify -- "文字"` 手動腳本打真 API（需 key，不進 CI）。

## T5 訊息主流程、回覆策略、health check、異常與需求建議（Careful）— 依賴：T3、T4

- [x] 狀態（2026-10-29 接受）

`src/health/check.ts`（SPEC 5.4 步驟 1–2，快取與重試，回 `{status:'healthy'|'degraded'|'down', httpStatus?, body?, latencyMs}`）。`src/handlers/message.ts` 實作 SPEC 5.2 全部步驟：脈絡、loading、分類與期限 race、依類別分派、reply→push、保底回覆、寫 classifications。`src/handlers/incident.ts` 實作 SPEC 5.4（含 10 分鐘合併、管理員 push 文案含 health 原始回應摘要、enqueue `incident_triage`）。`src/handlers/feature.ts` 實作 SPEC 5.5 步驟 1–4（enqueue `summarize_suggestion`）。`service_related`：reply「已轉交專人查詢」，enqueue `service_question`。`off_topic`：固定拒答文案。所有使用者可見文案集中在 `src/texts.ts`。

驗證：vitest 以 fake clock、mock replier / classifier / fetch 測：期限內 reply、逾期 reply+push、reply 400 → push、分類例外 → 保底、health 三種狀態的分支、incident 合併、feature 不 push。

## T6 Grok gateway 與 jobs handlers（Medium）— 依賴：T5

- [x] 狀態（2026-10-29 接受，webhook 契約待依 Cursor Automations 調整）

`src/grok/gateway.ts` 介面（SPEC 5.6）、`NullGrokGateway`、`WebhookGrokGateway` 骨架（POST + HMAC，回應解析留 TODO 並以 config 判斷是否啟用）。`src/jobs/handlers.ts`：`service_question`（結果 push 給使用者；Null 時 push 固定文案 + 通知管理員）、`incident_triage`（結果 push 管理員；Null 時 skipped）、`summarize_suggestion`（更新 suggestions；Null 時 skipped）。`POST /grok/callback` 路由骨架（驗 HMAC，回 501 直到介面確定）。

驗證：vitest 測三種 handler 在 Null gateway 下的行為與 jobs 狀態轉移。

## T6b Cursor Automations 非同步 callback（Careful）— 依賴：T6

- [x] 狀態（2026-10-29 接受）

Grok bot 確認為 Cursor Automations webhook：Bearer 認證、派送後由 agent 多次回呼 `/grok/callback`（received/processing/done/failed）。新增 `grok_tasks` 表、callback 路由、逾時 sweeper、`PUBLIC_BASE_URL`/`GROK_CALLBACK_TOKEN`/`GROK_TASK_TIMEOUT_MS`。見 SPEC 5.6 與 docs/CURSOR-AUTOMATION.md。

## T7 人工轉接與管理員指令（Medium）— 依賴：T5

- [x] 狀態（2026-10-29 接受）

`src/handlers/handoff.ts` 實作 SPEC 5.7：進入條件、24h 到期、期間轉發、`/resume`、`/handoff`、`/status`（今日訊息數、當月 push 數、pending jobs 數）。管理員指令僅接受 `ADMIN_LINE_USER_ID`；未設定時指令無效並 log。`message.ts` 在分類前接入 handoff 檢查。

驗證：vitest 測進入條件（關鍵字、連續低信心）、期間不分類、到期自動解除、非管理員指令被忽略。

## T8 CLI 與維運（Light）— 依賴：T2、T5

- [x] 狀態（2026-10-29 接受）

`src/cli/export-suggestions.ts`（Markdown 表格到 `${DATA_DIR}/exports/`）、`src/cli/list-users.ts`（userId、display_name、最後訊息時間，供查管理員 id）。README：本機啟動、cloudflared quick tunnel 步驟、LINE Developers 設定清單、Pi 部署步驟（SPEC 3.3）、備份、常見錯誤。

驗證：兩支 CLI 對測試 DB 執行成功；README 步驟與 compose 檔一致。

## T9 整體驗證（Light）— 依賴：T1–T8

- [x] 狀態（2026-10-29 接受，見 docs/VERIFY.md）

執行 `npm run lint && npm test && npm run build`，`docker compose up -d --build` 後跑 MVP 完成定義（SPEC 第 10 節）中不需要真實 LINE 帳號的項目：`/health`、簽章測試、重送去重、無 key 規則式回覆（以 curl 模擬 webhook body）。輸出一份檢查結果到 `docs/VERIFY.md`。需要真實 LINE 帳號與 Pi 的項目留給使用者，README 提供步驟。

## 並行關係

```
T1 ─▶ T2 ─┬─▶ T3 ─┐
          └─▶ T4 ─┴─▶ T5 ─┬─▶ T6 ─┐
                          ├─▶ T7 ─┼─▶ T9
                          └─▶ T8 ─┘
```

T3 與 T4 可並行；T6、T7、T8 可並行。

---

# 第二階段：管理端 bot（規格見 `docs/SPEC-ADMIN.md`，尚未核准、未實作）

## T10 Profile 拆分（Careful）— 依賴：第一階段全部

- [x] 狀態（2026-10-30 接受）

新增 `BOT_PROFILE` 設定；`server.ts` 依 profile 組裝不同的訊息處理器與 prompt，共用 webhook、Replier、DB、jobs、Grok、health。`docker-compose.pi.yml` 加第二個服務 `linebot-admin`（8091、獨立 `.env.admin`、獨立 `data-admin/`、同樣加入 tunnel 網路並以 `linebot-admin` 為別名）。既有測試全部維持通過；enduser profile 行為不變。

驗證：兩個 profile 各自啟動，`/health` 回應含 `profile` 欄位；enduser 的 156 個測試不變。

## T11 EshopClient 唯讀客戶端（Careful）— 依賴：T10

- [x] 狀態（2026-10-30 接受）

`src/eshop/client.ts`：登入換 token（快取、到期前重登、401 重登一次、失敗退避）、只實作 SPEC-ADMIN 第 4 節的 5 個 GET、回應以 zod 驗證並轉成內部型別、個資遮罩函式（第 6 節）、每次呼叫記 log（不含 token）。以 mock fetch 測試：登入流程、401 重登、鎖定退避、遮罩規則、端點白名單外的呼叫在型別層就不可能發生。

## T12 管理端對話處理器（Heavy 設計 → Careful 實作）— 依賴：T11

- [x] 狀態（2026-10-30 接受；真實模型 tool use 來回驗證通過，單次查詢約 25 秒）

Heavy：設計 system prompt、工具 schema、回覆格式規範、多輪工具呼叫的終止條件與錯誤處理，產出精確的實作 brief。Careful：`src/handlers/admin.ts` 以 Anthropic SDK tool use 實作（先讀 claude-api skill 的 tool-use 文件）、白名單檢查、`admin_queries` 記錄、`report_issue` 接既有 Grok `incident_triage`。測試用 fake client 回放工具呼叫序列。

## T13 管理通知搬家（Medium）— 依賴：T10

- [x] 狀態（2026-10-30 接受）

客戶端 bot 的異常確認、人工轉接、Grok 待回覆通知改送管理端帳號；決定共用資料夾或直接 push 的方式（SPEC-ADMIN 第 7 節）；`/status` 等管理指令移到管理端。

## T14 部署與驗證（Light）— 依賴：T11–T13

- [x] 狀態（2026-10-30 接受：Pi 上 linebot-admin 容器、linebot-admin.yuzen.tw、WAF 例外、LINE Verify 與實際查詢皆通過）

Pi 上啟動第二個容器、Cloudflare hostname 與 WAF 例外、LINE 管理端 channel 設定（文件化到 LINE-SETUP.md）、SPEC-ADMIN 第 10 節逐項驗證並寫入 VERIFY.md。

---

# 第二批：工單與專人回覆（規格見 `docs/SPEC-ADMIN.md` 第 12 節，未核准、未實作）

## T15 客戶端工單（Careful）— 依賴：T13

- [x] 狀態（2026-10-30 接受；orchestrator 調整為先開工單再 push 客戶）

migration 004 `tickets`；repo；開單點（jobs/handlers Null 與非暫時性失敗、callback failed、sweeper 逾時、handoff 進入）改為「開單或附加 + 通知」；`message.ts` 在分類後對 `service_related` 檢查 open 工單 → `ticketPending` 並通知追問；`POST /internal/reply`（token、zod、push、工單 answered、messages out）；24 小時自動關單（併入 sweeper 迴圈）；callback 7 天內事後 `done` 的處理（12.4）。測試涵蓋 12.6 前三項與第五、六、七項的客戶端部分。

## T16 管理端回覆流程（Careful）— 依賴：T15

- [x] 狀態（2026-10-30 接受）

`pending_confirmations` 表（或記憶體 + 到期）；`handlers/admin.ts` 在模型前加正則攔截：「回覆 T<id> <內容>」、`Y`、「待回覆」、「工單 T<id>」、「關閉 T<id>」；工具 `reply_customer` 只建立待確認項；送出呼叫客戶端 `/internal/reply`；結果回管理員；`admin_queries` 記錄；`ENDUSER_INTERNAL_URL` 設定。測試：確認/取消/到期、兩位管理員各自的待確認項互不干擾、送出失敗訊息。

## T17 部署與驗證（Light）— 依賴：T15、T16

- [ ] 狀態

Pi 兩個容器更新、`.env.admin` 加 `ENDUSER_INTERNAL_URL`、CURSOR-AUTOMATION.md 補事後補充段落、SPEC-ADMIN 12.6 逐項驗證寫入 VERIFY.md。

---

# 第三批：群組查詢（規格見 `docs/SPEC-ADMIN.md` 第 14 節，2026-11-04 定案）

## T18 群組 tag 查詢與 `/bug` 分流（Careful）— 依賴：T16、§13 群組 bug 回報

- [ ] 狀態

`handlers/groupBug.ts` 改名 `handlers/group.ts`（`createGroupHandler`）：去掉 tag 後空白回 `groupHelp`；開頭 `/bug`（含全形「／」、不分大小寫）走 §13 回報流程且不呼叫模型，描述存 `/bug` 之後的文字、空描述回新的 `groupBugHelp`；其他交給 `runAdminQuery`，只給唯讀工具子集（`GROUP_TOOL_DEFS`，executor 以 `allowedTools` 再擋一次）並在 system prompt 規則 block 之後加群組段落，私訊快捷指令不生效；上下文用 migration 007 `group_context`（每個群組的查詢與回覆，不含 `/bug`，與私訊分開）；逾時先回 `adminAckPending` 再 push 群組；每次 tag 寫 `admin_queries`，含個資存佔位文字；例外回 `groupBugError`（新文案）。測試：`/bug` 各種寫法與不在開頭、空 tag / 空 `/bug`、bug 不呼叫模型、工具子集與拒絕 `reply_customer`、上下文隔離、deadline、個資佔位、非白名單、快捷指令交給模型。

## T19 任意區間營收工具 `revenue`（Medium）— 依賴：T18

- [ ] 狀態

規格見 `docs/SPEC-ADMIN.md` 第 15 節。`admin/tools.ts` 新增唯讀工具 `revenue`（`dateFrom`、`dateTo` 必填含 +08:00、`orderType` 可 null）：`listOrders` 帶 `paymentStatus=paid`、每頁 100 筆逐頁抓到底，排除已取消、缺金額另計，回 `revenue`、`orders`、`byPaymentMethod`、`excludedCancelled`、`missingAmount`、`basis`；區間超過 366 天或超過 20 頁回「區間太長或訂單太多，請縮小區間」，不回部分加總；私訊與群組子集都提供。prompt：今天、本月營收仍用 `stats`，其他區間用 `revenue`，回覆附口徑說明。測試：多頁加總、排除已取消、缺金額、付款方式分組、orderType 與 paymentStatus 參數、超過 20 頁 / 366 天 / 起訖顛倒 / 格式錯誤、eshop 錯誤、群組可用。上線前依 §15.4 比對本月口徑並記入 `docs/VERIFY.md`。

---

# 第四批：員工打卡與薪資 bot（規格見 `docs/SPEC-STAFF.md`，2026-11-12 定案）

## T20 staff 資料層與薪資計算（Careful）— 依賴：無

- [x] 狀態（2026-11-12 部署 Pi `linebot-staff`，正式環境驗證見 VERIFY.md）

`config.ts` 加 `BOT_PROFILE=staff` 與 SPEC-STAFF §12 的變數（staff 時 `STAFF_ADMIN_USER_IDS` 必填、不需要 eshop / Anthropic 金鑰）；migration 008 建 §10 的表；`src/staff/` 下的 repo 與純函式：員工編號 E001 / 補卡 R001 / 班 S0001、打卡狀態機（§5，含 16 小時上限與 60 秒重送）、補卡套用與重疊檢查（§6）、時薪生效日查詢、月結計算（§7–8：分鐘、整月四捨五入、8 小時與週 40 小時標註、未下班列待處理）、指令解析（§4–6、§9 的全部指令格式與日期解析）。全部附單元測試，不接 LINE。

## T21 staff bot 指令、月結排程與部署設定（Careful）— 依賴：T20

- [x] 狀態（2026-11-12 部署 Pi `linebot-staff`，正式環境驗證見 VERIFY.md）

`src/profiles/staff.ts` 與 handler：群組（只在 `STAFF_GROUP_IDS`，未列群組記 groupId）處理註冊、上班、下班、補卡；私訊處理員工與管理員指令（§9）、管理員通知、核准結果通知；文案集中 `texts.ts`；每月 1 日 `STAFF_PAYROLL_CRON_HOUR` 自動月結與 `結算` 指令（§8，寫 `payroll_runs`、管理員總表、員工私訊、未加好友標註）；`audit_log`。`docker-compose.pi.yml` 加 `linebot-staff`（profile `staff`、8092、`./data-staff`、`.env.staff`）、`.env.example`、`docs/LINE-SETUP.md` 員工帳號段落、README、filemap。整合測試用 mock LINE client 與臨時 SQLite。

## T22 管理端傳圖片查詢（Careful）— 依賴：T18、SPEC-ADMIN §16

- [x] 狀態（2026-11-12 部署 Pi `linebot-admin`，私訊實測通過；群組暫不實測，見 VERIFY.md）

SPEC-ADMIN §16：私訊（`ADMIN_USER_IDS`）與群組（`GROUP_COMMAND_USER_IDS`）的圖片記為待用（只存 LINE 訊息 ID，migration 009 `pending_images`，10 分鐘、最多 3 張、同人同對話），私訊回 `texts.adminImageReceived`、群組不回應；下一則送模型的文字（群組需 tag）才下載、用 `sharp` 縮到長邊 1280px JPEG，以 base64 image block 放進 user 訊息；快捷指令與 `/bug` 不消耗。prompt 加圖片規則；`admin_queries` 加 `image_count`、token 加總與 `model`（migration 009）。圖片內容不落地、不進 log / `admin_queries` / `messages` / `group_context`。測試用 mock blob client、mock model、臨時 SQLite。

## T23 補卡改進與待審提醒（Careful）— 依賴：T21、SPEC-STAFF §15

- [x] 狀態（2026-11-12 部署 Pi `linebot-staff`，新指令尚未實測，見 VERIFY.md）

SPEC-STAFF §15：migration 010 重建 `correction_requests`（`kind` 加 `shift`、新增 `end_at`、`status` 加 `cancelled`，保留 id 與資料）並建 `staff_reminders`；指令解析加 `補卡 11/12 09:00-18:00`（含管理員代補）、`取消 R001`、`修改 S0123 上班|下班 [M/D] HH:MM`；`corrections.ts` 加整班套用（重疊即失敗）；service 加取消、修改（31 天、不超時、不重疊、不晚於現在，`audit_log` 前後值）；核准失敗通知申請人（管道同核准通知，「下班」等待配對另用文案）；已結算月份的修改、代補、刪除回覆加重新結算提示；`scheduler.ts` 每天 `STAFF_PAYROLL_CRON_HOUR` 檢查超過 3 天待審與發薪日前一天的上月待審，合併一則私訊管理員，`staff_reminders` 先寫後發；`texts.ts`、`說明`、§9 表格同步。測試用 mock LINE client 與臨時 SQLite，含 migration 010 既有資料保留。

## T24 每日備份到 Google 試算表（Medium）— 依賴：T23、SPEC-STAFF §16

- [x] 狀態（2026-11-12 部署 Pi `linebot-staff`，排程備份實測成功，見 VERIFY.md）

SPEC-STAFF §16：`config.ts` 加 `STAFF_BACKUP_SHEET_URL`、`STAFF_BACKUP_TOKEN`（選填，兩者都有才啟用）、`STAFF_BACKUP_HOUR`（預設 1）；migration 011 建 `staff_backups`；`src/staff/backup.ts` 把七個分頁組成 JSON（台北時間、`payroll_runs` 快照展開）POST 到 Apps Script，帶 token 與 `force`；排程每天 `STAFF_BACKUP_HOUR` 跑一次、重啟不重跑、失敗每小時重試，連續失敗只通知一次、恢復時通知；管理員指令 `備份`、`備份 強制`；`docs/STAFF-BACKUP.md` 含 Apps Script（token 比對、筆數減少拒絕、覆寫分頁）與設定步驟；`.env.example`、README、filemap、`說明`、§9、§12 同步。測試用 mock fetch 與臨時 SQLite。

## T25 批次補卡與批次核准（Medium）— 依賴：T23、SPEC-STAFF §17

- [ ] 狀態

SPEC-STAFF §17：指令解析支援多行補卡（員工與管理員代補，最多 12 行，任一行格式錯或超過上限整則不處理）與 `核准|駁回 R… R…`（空白、逗號、頓號，去重，最多 12）、`核准全部`（最早 12 筆）；service 批次申請逐行檢查、代補依行序套用、批次核准依補卡時間排序；管理員通知合併一則、申請人結果依人（與群組）合併一則；回覆一行一筆；`說明`、§9 同步。單筆行為不變。測試用 mock LINE client 與臨時 SQLite。
