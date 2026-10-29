# 第二階段：管理端 bot 規格（草稿，2026-10-30）

狀態：2026-10-30 使用者核准，實作中。第一階段（客戶端 bot）規格見 `SPEC.md`，本文件只寫差異與新增。

## 1. 目標與範圍

給店家老闆與系統管理員用的 LINE bot，用自然語言查後台資料。第一批只做**唯讀**：

1. 查訂單：依付款狀態（未付款 / 已付款）、訂單狀態、付款方式、日期區間、訂單編號或客人關鍵字。
2. 查庫存：商品庫存、低庫存清單、加價購庫存。
3. 系統狀況：pet eshop health check、今日與本月統計（`/admin/stats`）。
4. 系統異常與功能異常：描述問題後轉給 Grok bot（Cursor automation）整理，結果回到管理端。

### 非目標（第一批）

- 任何寫入：改訂單狀態、標記已付款、退款、調庫存、發券。
- 區間營收統計（後端只有今日與本月；任意區間要分頁加總，第二批再做）。
- 群組聊天。

## 2. 為什麼是兩個 LINE 官方帳號

| | 客戶端 bot（既有） | 管理端 bot（新） |
|---|---|---|
| 使用者 | 任何加好友的人，輸入不可信 | 白名單 userId（管理員、店家老闆） |
| 能力 | 知識庫回答、health check、存建議 | 呼叫後台 API 查資料 |
| 憑證 | 無後台憑證 | 後台 admin JWT（有寫入權，見第 5 節） |
| 失誤代價 | 答錯一句 | 洩漏個資或誤操作 |

同一個帳號用 userId 分角色，一個判斷錯誤就讓客戶拿到後台資料。拆成兩個帳號後，管理端帳號可在 LINE 後台設為不公開、加好友需審核。

## 3. 架構

同一個 repo，新增 `BOT_PROFILE=enduser | admin`。共用：webhook 驗簽與去重、Replier、SQLite、jobs、Grok gateway、health check。依 profile 載入不同的訊息處理器與 prompt。

```
LINE（管理端帳號）→ Cloudflare → Pi 容器 linebot-admin:8091
                                   │ 白名單檢查（ADMIN_USER_IDS）
                                   ▼
                        Claude tool use（claude-opus-5-5）
                          tools: list_orders / get_order / list_products /
                                 low_stock / stats / health / report_issue
                                   │
                                   ▼
                        EshopClient（只允許 GET 白名單，自動登入換 token）
                                   │
                                   ▼
                        pet eshop /api/v1（Render）
```

Pi 上兩個容器：`linebot`（8090，客戶端）與 `linebot-admin`（8091）。Cloudflare 多一個 hostname `linebot-admin.yuzen.tw`，WAF Skip 規則同樣放行 `/webhook`（ASN 38631）與 `/grok/callback`。

## 4. 對話流程（管理端）

1. webhook 驗簽、去重、回 200（同第一階段）。
2. `source.userId` 不在 `ADMIN_USER_IDS` → 回「此帳號僅供內部使用」，記 log，結束。
3. 取最近 `CONTEXT_MESSAGES` 則對話。
4. 呼叫 Claude（tool use，`output_config.effort: "medium"`，system prompt 含後台術語對照與回覆格式規範），讓模型決定要呼叫哪些工具。工具結果回給模型，最多 4 輪。
5. 模型產生最終回覆（繁中、精簡、數字為主、必要時條列），走 reply → push fallback。
6. 全程寫 `admin_queries`（userId、原文、呼叫了哪些工具與參數、回覆摘要、延遲）。

工具定義（全部唯讀）：

| 工具 | 後端端點 | 參數 |
|------|----------|------|
| `list_orders` | `GET /orders` | status, paymentStatus, paymentMethod, orderType, dateFrom, dateTo, q, page, limit≤20 |
| `get_order` | `GET /orders/:orderId` | orderId（自動補 `#`，路徑編碼 `%23`） |
| `list_products` | `GET /admin/products` | 選填 name 關鍵字（本地過濾）、只看上架 |
| `low_stock` | `GET /admin/stock/low` | 無 |
| `stats` | `GET /admin/stats` | 無 |
| `health` | `GET /health`（既有 health checker） | 無 |
| `report_issue` | Grok gateway `incident_triage` | 問題描述；附上 health 與 stats 摘要 |

回覆格式規範（放 system prompt）：訂單列表最多 10 筆，每筆一行「編號｜時間｜狀態｜付款｜金額」；單筆訂單列品項與配送方式；金額加 NT$；日期用台北時區；超過 10 筆提示「還有 N 筆，可加條件縮小」。

## 5. 憑證與唯讀保證

後端現況（wa'mahouse 2026-10-30）：**viewer 唯讀角色已上線**（commit abb5973，Render 已部署）。viewer 只能呼叫 7 個 GET：`/orders`、`/orders/:orderId`、`/admin/products`、`/admin/stock/low`、`/admin/stats`、`/admin/addons`、`/admin/bundles`；其他路由一律 403，路徑必須完全相同（尾斜線也會 403）。登入 `POST /auth/login`，body `{ identifier, password }`，回傳 `user.role = viewer`；JWT HS256、7 天、無 refresh。登入失敗 5 次（15 分鐘內）鎖 IP；全站每 IP 每分鐘 100 次。

- bot 帳號 `linebot_viewer`（帳號只能小寫英數與底線）由使用者在後端目錄用 `src/scripts/manage-account.js` 建立，密碼只放管理端 `.env.admin`。
- 雙重保險：bot 這邊的 `EshopClient` 仍只實作 5 個 GET、無通用 request 方法；登入連續失敗 2 次即退避 15 分鐘。
- 日期參數帶 `+08:00` 時 `+` 必須編碼成 `%2B`（client 用 `URLSearchParams`，已處理）；只寫日期會被當 UTC 午夜。

## 6. 個資處理

API 回傳完整 `customer`（姓名、電話、email、IG、地址）。bot 回覆前遮罩：

- 預設只顯示姓名與 IG；電話顯示前 4 後 2 碼（0912****78）；email、地址、備註不顯示。
- 管理員明確要求「完整電話」「地址」時才顯示，且該次查詢記入 `admin_queries.pii_revealed = 1`。
- 對話脈絡存進 SQLite 的是遮罩後的回覆，不存原始 API 回應。

## 7. 異常與 Grok

- 「系統壞了嗎」類問題：先 `health` + `stats`，直接回結果，不經 Grok。
- 管理員描述功能異常（例如「客人說 LINE Pay 付完款訂單沒更新」）：bot 先用 `list_orders` / `get_order` 查相關資料，再呼叫 `report_issue` 把描述、查到的資料摘要、health 結果送 Cursor automation（既有 `incident_triage` 流程），callback 結果 push 回管理端帳號。
- 第一階段客戶端 bot 的管理通知（異常確認、人工轉接、Grok 待回覆）改推到管理端帳號；客戶端 bot 的 `ADMIN_LINE_USER_ID` 改成「管理端 bot 的通知入口」（實作方式：客戶端容器寫一筆 `admin_notices` 到共用資料夾，或直接以管理端 channel token push；待定）。

## 8. 環境變數（管理端新增）

| 變數 | 說明 |
|------|------|
| `BOT_PROFILE` | `admin` |
| `ADMIN_USER_IDS` | 逗號分隔的 LINE userId 白名單（你、店家老闆） |
| `ESHOP_API_BASE` | `https://petsnack-backend.onrender.com/api/v1` |
| `ESHOP_BOT_USERNAME` / `ESHOP_BOT_PASSWORD` | bot 專用 admin 帳號 |
| `ADMIN_MODEL` | 預設 `claude-opus-5-5` |
| `ADMIN_MAX_TOOL_ROUNDS` | 預設 4 |

## 9. 資料表（管理端新增）

- `admin_queries`：id、user_id、text、tools JSON、reply、pii_revealed、latency_ms、created_at。
- 其餘沿用第一階段的表（events、messages、users、jobs、grok_tasks）。

## 10. 完成定義（第一批）— 2026-10-30 驗證

- [x] 非白名單 userId 傳訊息得到拒絕文案（單元測試與本機 smoke）。
- [x] 「今天有幾筆未付款」等查詢在正式環境 5 到 8 秒內回覆，viewer 帳號登入與 `/orders` 皆 200（使用者在 LINE 上確認正常）。
- [x] 回覆不含電話全碼、email、地址（`piiRevealed:false`，遮罩有單元測試）。
- [x] bot 只發出 GET：客戶端只實作 5 個 GET，且後端 viewer 角色對寫入回 403。
- [x] token 過期自動重新登入、連續失敗退避（單元測試）。
- [ ] 「LINE Pay 付完款訂單沒更新」送到 Cursor 並回推管理端：程式已接，尚未在正式環境實測。
- [x] Pi 上第二個容器啟動，`linebot-admin.yuzen.tw/health` 回 200，LINE Verify 通過。
- [ ] 店家老闆的 userId 加入 `ADMIN_USER_IDS`（待提供）。

## 11. 使用者決定（2026-10-30）

- [x] 管理端 LINE 官方帳號：**新建一個**（使用者稍後建立，程式先寫）。
- [ ] 店家老闆的 LINE userId：之後提供。
- [x] 已向 wa'mahouse 後端提出：建立 bot 專用 admin 帳號、新增 viewer 唯讀角色。
- [x] 第一階段的管理通知**全部搬到管理端帳號**。

### 管理通知的傳遞方式（T13 定案）

客戶端容器不持有管理端 channel token。客戶端 bot 把通知 `POST http://linebot-admin:8090/internal/notify`（容器內 port 8090，host 映射才是 8091）（同一個 docker network），header `x-internal-token`（兩個容器共用的 `INTERNAL_NOTIFY_TOKEN`），body `{ kind, text, meta }`；管理端收到後 push 給 `ADMIN_USER_IDS` 全部成員並記 `push_log`。管理端未啟動或回非 2xx 時，客戶端退回原本的 `ADMIN_LINE_USER_ID` push（若有設）並記 warn。`/internal/notify` 不經 tunnel 對外（Cloudflare 只路由 `/webhook` 與 `/grok/callback` 到管理端；其餘路徑仍被 WAF 擋），且 token 不符回 401。

## 12. 工單與專人回覆客戶（第二批，2026-10-30 討論定案，未實作）

### 12.1 問題

Grok（Cursor）答不出、逾時或未設定時，客戶收到「改由人工處理」，管理員收到通知，但之後查到的答案沒有路回到那位客戶，也沒有人記得「這個問題對應哪個 LINE 使用者」。

### 12.2 工單（tickets，客戶端 bot 擁有）

| 欄位 | 說明 |
|------|------|
| `id` | 整數，顯示為 `T042` |
| `user_id` | 客戶 LINE userId |
| `source` | `grok_failed` / `grok_timeout` / `grok_unconfigured` / `handoff` |
| `question` | 客戶原文 |
| `context` | 最近 3 則客戶訊息（JSON，遮罩後） |
| `order_ids` | 原文或 Grok 任務中辨識到的訂單編號（JSON，可空） |
| `grok_task_id` | 對應的 grok_tasks.id（可空） |
| `status` | `open` / `answered` / `closed` |
| `answered_by` / `answer` / `answered_at` | 回覆者 userId、內容、時間 |
| `created_at` / `updated_at` | |

開單時機（每位客戶同時只有一張 `open` 工單；已有就附加 question 到既有工單並更新時間）：

- `service_question` 的 Grok 回 `failed`、任務逾時（sweeper）、Grok 未設定（Null gateway）。
- 人工轉接進入時（`source=handoff`）。
- `incident_triage` 不開工單（異常走既有通知）。

通知文字（經 AdminNotifier 送到管理端）：

```
[待回覆 T042] 客戶 U6037873…
問：我的訂單什麼時候出貨
最近對話：
- 昨天訂的
- 我的訂單什麼時候出貨
訂單：#20261029-VXJG7AZY
回覆方式：在這裡打「回覆 T042 <內容>」
```

客戶端行為：

- 有 `open` 工單的客戶再傳服務相關問題 → 直接 reply `texts.ticketPending`「專人處理中，有結果會在這裡回覆你」，把訊息附加到工單並通知管理端「[T042 追問] …」，不再送 Grok。知識庫能答、無關、建議、異常仍照常處理。
- 收到專人回覆後 push 給客戶，並以 `direction=out` 寫入 messages，之後的分類脈絡看得到這則回覆。

### 12.3 管理端回覆（`reply_customer`）

- 管理員（`ADMIN_USER_IDS`，含店家老闆）在管理端 bot 打：「回覆 T042 訂單已收到款項，正在備貨」。
- 處理順序在模型之前：正則 `^回覆\s*T?(\d+)\s*(.+)$`s 命中 → 不呼叫模型，直接進確認流程；也提供工具 `reply_customer({ticketId, text})` 讓模型在自然語言（「幫我跟 T042 說已經出貨了」）時呼叫，工具本身只建立待確認項，不送出。
- **確認**：bot 複述「將送給 T042 的客戶：『…』 回 Y 送出，其他內容取消」，把待確認項存進 `pending_confirmations`（管理員 userId、ticket、text、10 分鐘到期）。管理員回 `Y` / `y` / `是` → 送出；回其他 → 取消並正常處理該訊息。
- 送出 = 管理端 bot `POST ${ENDUSER_INTERNAL_URL}/internal/reply`（客戶端新端點，`x-internal-token` 同一把）body `{ ticketId, text, by }` → 客戶端 push 客戶、工單 `answered`、記錄；回 `{ok, pushed}`。失敗（客戶已封鎖、push 失敗）回管理員「送出失敗：…」，工單維持 open。
- 限制：純文字、≤ 1000 字、一次一張工單；同一工單可多次回覆；`admin_queries` 記錄 `reply_customer` 呼叫與結果。
- 關單：回覆後工單為 `answered`；客戶 24 小時內沒再追問自動 `closed`；管理員可打「關閉 T042」。
- 管理端新指令（正則，不經模型）：「待回覆」列出 open 工單（最多 10 張）；「工單 T042」看單張明細與對話。

### 12.4 Cursor 事後補充回答

- `/grok/callback` 對已關閉（`done` / `failed` / `expired`）的 `service_question` 任務，在 **7 天內**再收到 `status=done` 且帶 `text` 時，不再回 `ignored`，改為：有對應 open 工單 → 視同專人回覆（`answered_by = grok`），push 客戶並關單；沒有工單 → 直接 push 客戶（reason `grok_followup`），同一任務最多 3 次。
- `incident_triage` / `summarize_suggestion` 維持現狀。
- `docs/CURSOR-AUTOMATION.md` 補充：任務結束後若人工補上答案，可再 POST 一次 `done`。

### 12.5 環境變數

| 變數 | 端 | 說明 |
|------|----|------|
| `ENDUSER_INTERNAL_URL` | 管理端 | 客戶端容器內部網址，Pi 上 `http://linebot:8090` |
| `INTERNAL_NOTIFY_TOKEN` | 兩端 | 既有，雙向共用 |
| `TICKET_AUTO_CLOSE_MS` | 客戶端 | 預設 86400000（24 小時） |
| `GROK_FOLLOWUP_WINDOW_MS` | 客戶端 | 預設 604800000（7 天） |

### 12.6 完成定義

- [ ] Grok 回 failed 後客戶端開工單，管理端收到含 `T` 編號與最近對話的通知。
- [ ] 管理員打「回覆 T042 …」→ 複述 → 回 Y → 客戶在 LINE 收到訊息，工單變 `answered`，`admin_queries` 有紀錄。
- [ ] 回非 Y → 取消，該訊息照常處理。
- [ ] 店家老闆（第二個白名單 userId）同樣可回覆。
- [ ] 客戶在 open 工單期間追問 → 收到「專人處理中」，管理端收到追問通知，不送 Grok。
- [ ] Cursor 對已關閉任務再 POST done → 客戶收到補充答案。
- [ ] 10 分鐘未確認的待確認項自動失效。
