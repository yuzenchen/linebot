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

## 10. 完成定義（第一批）

- [ ] 非白名單 userId 傳訊息得到拒絕文案，log 有紀錄。
- [ ] 「今天有幾筆未付款」「訂單 #20261030-XXXXXXXX 狀態」「哪些商品快沒貨」「本月營收」四句都在 10 秒內得到正確數字（與後台頁面比對）。
- [ ] 回覆不含電話全碼、email、地址，除非明確要求。
- [ ] 抓包或 log 證明 bot 只發出 GET。
- [ ] token 過期自動重新登入，登入失敗不重試超過 2 次。
- [ ] 「LINE Pay 付完款訂單沒更新」送到 Cursor，callback 結果推回管理端帳號。
- [ ] Pi 上第二個容器啟動，`linebot-admin.yuzen.tw/health` 回 200，LINE Verify 通過。

## 11. 使用者決定（2026-10-30）

- [x] 管理端 LINE 官方帳號：**新建一個**（使用者稍後建立，程式先寫）。
- [ ] 店家老闆的 LINE userId：之後提供。
- [x] 已向 wa'mahouse 後端提出：建立 bot 專用 admin 帳號、新增 viewer 唯讀角色。
- [x] 第一階段的管理通知**全部搬到管理端帳號**。

### 管理通知的傳遞方式（T13 定案）

客戶端容器不持有管理端 channel token。客戶端 bot 把通知 `POST http://linebot-admin:8091/internal/notify`（同一個 docker network），header `x-internal-token`（兩個容器共用的 `INTERNAL_NOTIFY_TOKEN`），body `{ kind, text, meta }`；管理端收到後 push 給 `ADMIN_USER_IDS` 全部成員並記 `push_log`。管理端未啟動或回非 2xx 時，客戶端退回原本的 `ADMIN_LINE_USER_ID` push（若有設）並記 warn。`/internal/notify` 不經 tunnel 對外（Cloudflare 只路由 `/webhook` 與 `/grok/callback` 到管理端；其餘路徑仍被 WAF 擋），且 token 不符回 401。
