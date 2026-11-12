# 員工打卡 bot 每日備份到 Google 試算表

規格：`docs/SPEC-STAFF.md` 第 16 節。出勤與薪資資料要保存 5 年，平常只在 Pi 的 SD 卡上。設定完成後：

- 每天 `STAFF_BACKUP_HOUR`（預設 01:00 台北時間），bot 自動把整個員工資料庫寫進這份試算表（每次完整覆寫七個分頁）；容器當時沒開就當天稍後補跑，不補前幾天。成功不發 LINE；失敗時私訊每位管理員「11/13 每日備份失敗：原因」，之後每小時重試到當天成功為止。連續失敗（含跨日）只通知第一次，恢復成功時再私訊「備份已恢復」。
- 管理員隨時可以私訊 bot `備份` 立即備份，回覆「備份完成：員工 3、時薪 3、打卡 120…」。
- 任何分頁的筆數比試算表現有的少時，Apps Script 拒絕寫入（回「筆數減少（打卡）」），整份試算表不動。確定要覆寫（例如清掉測試資料後）就私訊 `備份 強制`。

試算表含員工 LINE userId 與薪資，**只給自己看，不要分享給任何人**。網址與 token 視同密碼，只放 Pi 的 `.env.staff`。

## 1. 建立試算表

1. 到 Google 雲端硬碟 → 新增 → Google 試算表，命名例如「員工打卡備份」。
2. 不用自己建分頁，第一次備份時 Apps Script 會建立「員工、時薪、打卡、補卡、結算、操作紀錄、備份資訊」七個分頁（原本的「工作表1」可以留著或刪掉）。

## 2. 貼上 Apps Script

1. 在試算表上方選單：擴充功能 → Apps Script。
2. 刪掉編輯器裡預設的 `function myFunction() {}`，貼上第 6 節的完整程式碼。
3. 按儲存（磁碟圖示），專案名稱可填「員工打卡備份」。

> 也可以改用獨立專案（[script.google.com](https://script.google.com) →「新專案」），這時把程式碼裡的 `SpreadsheetApp.getActiveSpreadsheet()` 換成 `SpreadsheetApp.openById('試算表 ID')`（網址 `/spreadsheets/d/` 與 `/edit` 之間那段）。正式環境（2026-11-12）用的是這種做法：試算表與 Apps Script 專案都叫「Wama 員工出勤備份」。

## 3. 設定 token

1. 產生一組隨機字串當 token，例如在 Pi 上執行：

   ```bash
   openssl rand -hex 24
   ```

2. Apps Script 左側齒輪「專案設定」→ 最下面「指令碼屬性」→ 新增指令碼屬性：
   - 屬性：`TOKEN`
   - 值：剛剛產生的字串
3. 按「儲存指令碼屬性」。

## 4. 部署成網頁應用程式

1. 右上角「部署」→「新增部署作業」→ 左邊齒輪選「網頁應用程式」。
2. 說明隨意填；「執行身分」選「我」；「誰可以存取」選「所有人」。
   （bot 沒有 Google 帳號，必須選「所有人」；沒有正確 token 的請求一律被拒絕。）
3. 按「部署」，第一次會要求授權：選自己的帳號 →「進階」→「前往（專案名稱）」→「允許」。
4. 複製「網頁應用程式」網址（`https://script.google.com/macros/s/…/exec`）。

## 5. 設定 bot 並測試

1. 在 Pi 的 `~/linebot/.env.staff` 加上（換成自己的值）：

   ```
   STAFF_BACKUP_SHEET_URL=https://script.google.com/macros/s/……/exec
   STAFF_BACKUP_TOKEN=第 3 步產生的字串
   ```

   兩個都填才會啟用；只填一個時 bot 會在 log 提醒並維持關閉。要改每天備份的時間就再加 `STAFF_BACKUP_HOUR=3`（0–23，預設 1）。

2. 重建容器：

   ```bash
   docker compose -f docker-compose.pi.yml --profile staff up -d --force-recreate linebot-staff
   ```

3. 用管理員帳號私訊員工 bot：`備份`。應回「備份完成：員工 …」，打開試算表可看到七個分頁。

## 常見錯誤

| bot 回覆 | 原因與處理 |
|------|------|
| 尚未設定備份試算表 | `.env.staff` 沒有同時填網址與 token，或改完沒重建容器 |
| 驗證碼不符 | `.env.staff` 的 `STAFF_BACKUP_TOKEN` 和指令碼屬性 `TOKEN` 不一樣 |
| 筆數減少（打卡） | 該分頁新資料比試算表現有的少。先確認資料庫沒出問題；確定要覆寫就輸入 `備份 強制` |
| 試算表回應異常 | 網址錯誤，或部署時「誰可以存取」不是「所有人」（Google 回登入頁） |
| 試算表忙碌中 | 另一個備份正在寫入，稍後再輸入 `備份` |
| 網路錯誤、連線逾時 | Pi 連不到 Google；排程會每小時自動重試 |

## 還原與修改

- **還原舊備份**：試算表「檔案 → 版本記錄 → 查看版本記錄」可回到之前任何一次備份。
- **修改 Apps Script 後**：要「部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選『新版本』→ 部署」，網址不變。只按儲存不會生效。
- **換 token**：改指令碼屬性 `TOKEN` 與 `.env.staff`，然後重建容器。

## 6. Apps Script 原始碼

bot 送來的 JSON：`{ token, force, generatedAt, tables: [{ name, header, rows }] }`。回覆 `{ ok: true, counts }`，或 `{ ok: false, error, table? }`（`error`：`unauthorized`、`shrink`、`busy`、`bad_request`，或例外訊息）。

```javascript
// 員工打卡 bot 備份接收端（SPEC-STAFF 第 16 節）
function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'bad_request' });
  }
  var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || data.token !== token) return reply({ ok: false, error: 'unauthorized' });
  if (!Array.isArray(data.tables)) return reply({ ok: false, error: 'bad_request' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return reply({ ok: false, error: 'busy' });
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 先檢查全部分頁：任何一個筆數減少就整批不寫（備份 強制 時略過）
    if (!data.force) {
      for (var i = 0; i < data.tables.length; i++) {
        var t = data.tables[i];
        var existing = ss.getSheetByName(t.name);
        var oldRows = existing ? Math.max(existing.getLastRow() - 1, 0) : 0;
        if (t.rows.length < oldRows) return reply({ ok: false, error: 'shrink', table: t.name });
      }
    }

    // 再逐一清空並寫入（分頁不存在就建立）
    var counts = {};
    data.tables.forEach(function (t) {
      var sheet = ss.getSheetByName(t.name) || ss.insertSheet(t.name);
      sheet.clear();
      // 以 = 開頭的文字（例如員工名字）加 ' 前綴，避免被當成公式執行
      var values = [t.header].concat(t.rows).map(function (row) {
        return row.map(function (v) {
          return typeof v === 'string' && v.charAt(0) === '=' ? "'" + v : v;
        });
      });
      // 文字一律設成純文字格式（'@'），日期、月份、編號不會被自動轉換；數字保留數字
      var formats = values.map(function (row) {
        return row.map(function (v) {
          if (typeof v !== 'number') return '@';
          return Number.isInteger(v) ? '0' : '0.00';
        });
      });
      var range = sheet.getRange(1, 1, values.length, t.header.length);
      range.setNumberFormats(formats);
      range.setValues(values);
      sheet.setFrozenRows(1);
      counts[t.name] = t.rows.length;
    });
    SpreadsheetApp.flush();
    return reply({ ok: true, counts: counts });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
```

說明：

- Google 對網頁應用程式的 POST 會先回 302 轉址到 `script.googleusercontent.com` 再給結果，bot 會自動跟隨轉址取得 JSON。
- `LockService` 讓同時進來的兩次備份排隊，不會互相覆蓋；等 30 秒拿不到鎖就回 `busy`。
- 「備份資訊」分頁記錄備份時間、觸發者（排程或管理員 userId）、資料庫版本與各分頁筆數。
