# LINE 官方帳號與 Messaging API 設定（使用者操作）

這些步驟只有帳號擁有者能做，與程式開發互不阻塞。完成後把兩個值填進 `.env`：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`。

> 注意：`PetEshop Info` 裡既有的 LINE channel 是 LINE Pay / LINE Login 用的，**不能**拿來當客服機器人。Messaging API 需要獨立的 channel。

## 1. 建立 LINE 官方帳號並啟用 Messaging API

LINE 自 2024 年起已不能直接在 Developers Console 新建 Messaging API channel，要從官方帳號後台啟用。

1. 到 <https://manager.line.biz/> 登入（用你平常的 LINE 帳號）。
2. 若還沒有官方帳號：「建立帳號」→ 帳號名稱填品牌名（例如「王媽媽寵物手工零食 客服」）→ 業種選「購物、零售」→ 建立。建議先建一個**測試用**帳號開發，正式帳號之後再切。
3. 進入該帳號 → 右上「設定」→ 左側「Messaging API」→「啟用 Messaging API」。
4. 系統會要求選擇或建立一個 **Provider**（Developers Console 的專案容器）。若已有 pet eshop 用的 Provider 可沿用，否則新建一個叫 `wama-house`。
5. 同意條款後完成。頁面會顯示 **Channel ID** 與 **Channel secret**。

## 2. 在 LINE Developers Console 取得金鑰

1. 到 <https://developers.line.biz/console/> → 選剛才的 Provider → 點進該 Messaging API channel。
2. 「Basic settings」分頁：
   - 複製 **Channel secret** → `.env` 的 `LINE_CHANNEL_SECRET`。
   - 往下找 **Your user ID**（`U` 開頭 33 碼）→ 這就是你的 LINE userId，之後填 `ADMIN_LINE_USER_ID`。
3. 「Messaging API」分頁：
   - **Channel access token (long-lived)** → 按「Issue」→ 複製 → `.env` 的 `LINE_CHANNEL_ACCESS_TOKEN`。這個值只顯示一次，遺失就重新 Issue（舊的會失效）。
   - 同一頁有 **QR code**，用手機 LINE 掃描把機器人加為好友。

## 3. 關閉自動回應、開啟 Webhook

### 3a. LINE Official Account Manager（<https://manager.line.biz/>）

該帳號 → 「設定」→「回應設定」：

| 項目 | 設定 | 原因 |
|------|------|------|
| 聊天 | **開** | 保留人工在後台回覆的能力（人工轉接用） |
| Webhook | **開** | 讓訊息送到機器人 |
| 回應方法 → 自動回應訊息 | **關** | 否則 LINE 內建罐頭訊息會和機器人搶著回 |
| 加入好友的歡迎訊息 | **關** | 歡迎詞由機器人送（`knowledge/welcome.md`） |
| 回應時間 | 不設定或全天 | 避免非營業時間觸發 LINE 的「非回應時間訊息」 |

### 3b. LINE Developers Console

該 channel → 「Messaging API」分頁：

| 項目 | 設定 |
|------|------|
| Webhook URL | 開發期：`https://<cloudflared 給的隨機網址>/webhook`；正式：`https://linebot.<你的網域>/webhook` |
| Use webhook | **開** |
| Webhook redelivery | **開**（LINE 會重送失敗的事件，程式已做去重） |
| Error statistics aggregation | 開（方便看錯誤率） |
| Auto-reply messages | 「Edit」會跳回 3a，確認是關的 |
| Greeting messages | 同上，確認是關的 |
| Allow bot to join group chats | **關**（規格不支援群組） |

Webhook URL 填好後按 **Verify**：伺服器跑起來時應顯示 Success。T1 完成後 `/webhook` 已會回 200，可以先驗證通過。

## 4. 開發期的公開網址（cloudflared quick tunnel）

不需要帳號，每次啟動網址會變，變了就回 3b 更新 Webhook URL。

```bash
winget install Cloudflare.cloudflared
```

```bash
cloudflared tunnel --url http://localhost:8090
```

終端機會印出一行 `https://xxxx-xxxx.trycloudflare.com`，Webhook URL 填 `https://xxxx-xxxx.trycloudflare.com/webhook`。

## 5. 正式環境（Pi + Cloudflare Tunnel）

到 Cloudflare Zero Trust → Networks → Tunnels → 選 Pi 上既有的 tunnel（`bfx-cloudflared`）→ Public Hostname → Add：

| 欄位 | 值 |
|------|----|
| Subdomain | `linebot` |
| Domain | 你的網域（例如 `yuzen.tw`） |
| Service Type | HTTP |
| URL | `linebot:8090` |

這個 hostname **不要**加 Zero Trust Access 政策，因為 LINE 伺服器要能直接 POST 進來；安全性靠 webhook 簽章驗證。

## 6. 完成後交給我的東西

- 兩個值已填進 `E:\linebot\.env`（不要貼在對話裡）。
- 你的 LINE userId（`U` 開頭）可以直接告訴我，這不是密鑰。
- 測試帳號加好友的 QR code 自己掃即可，不用給我。

## 常見問題

- **Verify 失敗 404 / 502**：服務沒起來或 tunnel 網址過期。先 `curl https://<網址>/health`。
- **Verify 成功但傳訊息沒反應**：3a 的「回應方法」還在自動回應，或 Webhook 開關沒開。
- **收到兩則回覆**：自動回應訊息沒關。
- **Channel access token 400 Authentication failed**：token 複製不完整或已被重新 Issue。
