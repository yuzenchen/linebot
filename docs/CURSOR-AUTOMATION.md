# Cursor Automation（Grok bot）端的設定

linebot 會把需要後援的任務 POST 到你的 Cursor Automations webhook，agent 再把狀態與答案 POST 回 linebot。這份文件說明 automation 那一側要怎麼設定。

## 1. linebot 送過去的東西

- `POST https://api2.cursor.sh/automations/webhook/<id>`，header `Authorization: Bearer <你在 Automation 頁面產生的 token>`。
- Body 是 JSON，Cursor 會把它接在 automation prompt 後面給 agent 看。欄位：

| 欄位 | 說明 |
|------|------|
| `id` | 任務 UUID，callback 一定要帶回 |
| `type` | `service_question`（使用者問題）、`incident_triage`（異常分析）、`summarize_suggestion`（需求建議整理） |
| `userMessage` | 使用者原文 |
| `context` | 最近幾則對話 `[{role, text}]` |
| `health` | 只有 incident_triage 有：linebot 打 pet eshop `/health` 的結果 |
| `existingSuggestions` | 只有 summarize_suggestion 有：既有建議的 `{id, title}` 清單，用來判斷要不要合併 |
| `callback` | 回報用的網址、header 名稱、token、body 格式 |
| `instructions` | 繁中說明：要做什麼、何時回報、回答格式 |

## 2. agent 要怎麼回報

對 `callback.url` 發 `POST`，header `x-linebot-token: <callback.token>`，body：

```json
{ "taskId": "<收到的 id>", "status": "received | processing | done | failed", "text": "給人看的繁體中文", "structured": { "title": "...", "summary": "...", "category": "...", "mergedInto": null } }
```

- 收到任務先回 `received`（linebot 會告訴使用者「已送出處理中」）。
- 處理中可以回 `processing`，`text` 可選。
- 完成回 `done`：`service_question` 的 `text` 必填，就是要給使用者看的答案；`summarize_suggestion` 的 `structured` 必填。
- 做不到回 `failed`，`text` 寫原因。
- 15 分鐘內沒有 `done` 或 `failed`，linebot 會自己把任務標成逾時並改走人工。

## 3. automation prompt 建議寫法

把下面這段放進 automation 的 prompt（payload 本身已含詳細 `instructions`，prompt 只要交代流程）：

```
你是 LINE 客服的後援系統。每次被 webhook 觸發時，訊息最後會附上一段 JSON 任務。
1. 先依 JSON 裡 callback 的說明，POST 一次 status=received。
2. 依 type 與 instructions 處理任務（需要時把問題交給 Claude Code session 處理）。
3. 處理完成後 POST status=done 並附上 text（繁體中文、口語、1 到 4 句、不用 emoji、不透露內部系統或程式細節）。
4. 無法處理時 POST status=failed 並附簡短原因。
callback 的網址與 token 以 JSON 內的 callback 欄位為準，不要寫死。
```

## 4. linebot 這邊要填的環境變數

| 變數 | 值 |
|------|----|
| `GROK_WEBHOOK_URL` | Automation 頁面給的 webhook URL |
| `GROK_WEBHOOK_SECRET` | 「Generate auth header」產生的 token（有沒有帶 `Bearer ` 前綴都可以） |
| `PUBLIC_BASE_URL` | linebot 對外網址。開發期是 cloudflared 的臨時網址，正式是 `https://linebot.<網域>`。換網址後改這一行並 `docker compose up -d --force-recreate` |
| `GROK_CALLBACK_TOKEN` | 任意亂數字串，agent 回呼時要帶一樣的值 |
| `GROK_TASK_TIMEOUT_MS` | 預設 900000（15 分鐘） |

## 5. 測試方式

1. 在 LINE 傳一句知識庫答不了的服務問題，例如「我的訂單什麼時候出貨」。
2. linebot log 應出現 `grok task dispatched`，Cursor 那邊應出現一次 run。
3. agent 回 `received` 後，LINE 會收到「問題已送出給專人系統，處理中」。
4. agent 回 `done` 後，LINE 會收到答案。
5. 管理員可用 `/status` 看目前等待中的 Grok 任務數。

手動模擬 callback（把 `<token>`、`<taskId>` 換掉）：

```bash
curl -X POST https://<PUBLIC_BASE_URL>/grok/callback -H "x-linebot-token: <token>" -H "content-type: application/json" -d "{\"taskId\":\"<taskId>\",\"status\":\"done\",\"text\":\"測試回答\"}"
```
