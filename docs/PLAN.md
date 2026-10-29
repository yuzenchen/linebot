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
