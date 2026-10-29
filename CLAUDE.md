# linebot — LINE 客服機器人

Node 22 + TypeScript (ESM) · Hono · @line/bot-sdk v10 · @anthropic-ai/sdk · better-sqlite3 · vitest

## 指令

- `npm run dev` — tsx watch
- `npm run build` / `npm start`
- `npm test` — vitest（不打外部 API）
- `npm run lint` / `npm run format`
- `docker compose up -d --build`（本機，port 8090）；Pi 用 `docker-compose.pi.yml`

## 文件

- 規格：`docs/SPEC.md`（流程、分類規則、回覆策略、資料模型、env）
- 任務：`docs/PLAN.md`（依此順序做，完成後更新狀態）
- 檔案索引：`filemap.md`（新增或搬移檔案時同步更新）

## 慣例

- 所有 env 透過 `src/config.ts`（zod）取得，不直接讀 `process.env`。
- 使用者可見文案集中在 `src/texts.ts`，繁體中文、簡短、不用 emoji。
- webhook 先回 200，處理全部非同步；任何失敗都要有保底回覆。
- reply 失敗（400 / invalid token）一律改 push；push 必寫 `push_log`。
- 同一 reply token 只能用一次，只由 `Replier` 使用。
- Anthropic SDK 呼叫前先讀 claude-api skill 的 TypeScript README，不憑記憶寫 API 形狀；model 來自 config，system prompt 的知識庫 block 加 `cache_control`。
- 密鑰只在 `.env`；log 不得出現 token / key；`knowledge/` 不得含金鑰或內部網址。
- 測試用 mock client 與臨時 SQLite，不呼叫 LINE / Anthropic 真實 API。
- `E:\project\PetEshop Info` 含正式金鑰，不得讀取或複製進本專案。
