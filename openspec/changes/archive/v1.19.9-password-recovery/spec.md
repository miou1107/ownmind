# v1.19.9 — 忘記密碼救援規格（GIVEN / WHEN / THEN）

---

## 一、方案 3：後台他人重設密碼

### 場景 1：super_admin 重設另一個 admin 密碼 → 成功

**GIVEN**
- 系統有 super_admin A 跟 admin B
- A 已登入

**WHEN**
- `POST /api/admin/users/<B.id>/reset-password`

**THEN**
- HTTP 200
- Body：`{ id, email, temporary_password: '<12 字隨機>', must_change_password: true }`
- DB：B.password_hash 更新、B.must_change_password = TRUE
- audit_log 寫一筆：actor=A, action='reset_password_by_admin', target=B

---

### 場景 2：admin 重設 user 密碼 → 成功

**GIVEN**
- 系統有 admin C 跟 user D

**WHEN**
- C 呼叫 `POST /api/admin/users/<D.id>/reset-password`

**THEN**
- HTTP 200、temporary_password 回傳
- audit_log 寫入

---

### 場景 3：admin 試圖重設其他 admin 密碼 → 拒絕

**GIVEN**
- 系統有 admin C 跟 admin E

**WHEN**
- C 呼叫 `POST /api/admin/users/<E.id>/reset-password`

**THEN**
- HTTP 403
- 訊息：`admin 只能重設 user 角色帳號`
- DB 不變、audit_log 不寫

---

### 場景 4：使用者試圖重設自己密碼 → 拒絕、引導去 me/change-password

**GIVEN**
- A 已登入

**WHEN**
- `POST /api/admin/users/<A.id>/reset-password`

**THEN**
- HTTP 400
- 訊息：`不能重設自己的密碼、請走 /api/me/change-password`

---

### 場景 5：重設不存在的 user → 404

**GIVEN**
- super_admin A 已登入

**WHEN**
- `POST /api/admin/users/99999/reset-password`

**THEN**
- HTTP 404
- 訊息：`找不到指定使用者`

---

### 場景 6：未登入 → 401

**GIVEN**
- 無 auth token

**WHEN**
- `POST /api/admin/users/1/reset-password`

**THEN**
- HTTP 401（標準 adminAuth 行為）

---

### 場景 7：user 角色登入後試圖呼叫 → 403

**GIVEN**
- 一般 user F 已登入

**WHEN**
- F 呼叫 `POST /api/admin/users/<other-user.id>/reset-password`

**THEN**
- HTTP 403（adminAuth 擋下）

---

### 場景 8：臨時密碼具備足夠強度

**GIVEN**
- super_admin A 重設 user 密碼

**WHEN**
- 觀察 temporary_password

**THEN**
- 長度 = 12
- 包含大小寫英數字（不含可混淆字 0/O/I/l）
- 每次呼叫都不同（隨機產生）

---

## 二、方案 2：CLI 救援腳本

### 場景 9：腳本互動式列出 super_admin

**GIVEN**
- DB 中有 2 位 super_admin、3 位 admin、1 位 user

**WHEN**
- 跑 `node scripts/reset-admin-password.js`

**THEN**
- 終端機印出 2 位 super_admin 的清單（編號、email、最後登入時間）
- 不列 admin / user（只能重設 super_admin、避免被當後門用）
- 提示使用者輸入編號選擇

---

### 場景 10：腳本要求雙重確認

**GIVEN**
- 使用者輸入編號 1

**WHEN**
- 腳本繼續

**THEN**
- 印出「即將把 admin@example.com 的密碼設為 NULL、確定要繼續？輸入 'yes' 確認」
- 輸入 yes 才執行、其他輸入取消

---

### 場景 11：執行成功印出新 SETUP_TOKEN

**GIVEN**
- 使用者確認 yes

**WHEN**
- 腳本執行

**THEN**
- UPDATE users SET password_hash = NULL WHERE id = ...
- 產隨機 SETUP_TOKEN（32 字 hex）
- 印出：
  - 「✅ 密碼已清除」
  - 「請執行：export SETUP_TOKEN=<token>」
  - 「然後重啟 server、開 /admin/setup 重設密碼」
- 寫 audit_log：actor_id=被重設的 user, action='cli_reset_password', source='cli'

---

### 場景 12：DB 連不上時報錯

**GIVEN**
- DB 連線失敗（環境變數錯）

**WHEN**
- 跑腳本

**THEN**
- exit code != 0
- 印出「DB 連線失敗、請確認 DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD」
- 不會誤改任何 user

---

## 三、方案 1：UI 強制引導

### 場景 13：setup wizard 完成頁加強建議

**GIVEN**
- 使用者剛建好第一個 super_admin

**WHEN**
- 看到成功頁

**THEN**
- 除了原本的 api_key + 安裝指令、額外顯示警告框：
  ```
  ⚠️ 建議馬上建立第二位 admin
  否則你忘記密碼時、會需要 SSH 進伺服器跑救援腳本。
  進後台後第一件事：到「使用者管理」新增第二位 super_admin。
  ```

---

### 場景 14：後台單 admin 警告 banner

**GIVEN**
- 已登入後台、admin + super_admin 角色合計只有 1 位

**WHEN**
- 開後台任何頁

**THEN**
- 頂部顯示橘色 banner：
  ```
  ⚠️ 你是唯一的管理員、忘記密碼將難以救援。建議到「使用者管理」新增第二位 admin。
  [新增第二位 admin →]
  ```
- 點按鈕跳到 /admin/users 並開啟「新增使用者」對話框

---

### 場景 15：有兩位以上 admin 時 banner 自動消失

**GIVEN**
- 已有 2 位以上 admin/super_admin

**WHEN**
- 開後台任何頁

**THEN**
- 不顯示 banner
