# v1.19.8 — Setup Wizard 規格（GIVEN / WHEN / THEN）

> BDD 三段式描述、對應 OpenSpec CONVENTIONS。

---

## 一、First-run 偵測場景

### 場景 1：DB 為空 + 開瀏覽器到 /admin → 自動進 wizard

**GIVEN（前提）**
- v1.19.8 server 已部署、首次啟動
- `users` 表完全沒有任何 admin / super_admin 紀錄

**WHEN（動作）**
- 瀏覽器 GET `/admin/login`（或任何 `/admin/*` 路徑）

**THEN（預期結果）**
- HTTP 302 redirect 到 `/setup`
- 沒被擋 / 沒回錯誤

---

### 場景 2：DB 已有 admin → /setup 永久關閉

**GIVEN**
- 已成功跑過一次 setup wizard、`users` 表有一筆 super_admin

**WHEN**
- 瀏覽器 GET `/setup`

**THEN**
- HTTP 302 redirect 到 `/admin/login`（已設定完、不該再看到 wizard）
- 直接 POST `/api/setup/init` → HTTP 403、訊息「setup wizard 已完成、請走 /admin/login」

---

### 場景 3：DB 已有 admin → /admin/login 正常顯示登入頁

**GIVEN**
- 已有 super_admin

**WHEN**
- GET `/admin/login`

**THEN**
- HTTP 200、正常顯示登入頁、**不**被 redirect

---

## 二、Setup wizard endpoint 場景

### 場景 4：GET /api/setup/status 回 first_run

**GIVEN**
- `users` 表為空

**WHEN**
- `GET /api/setup/status`

**THEN**
- HTTP 200
- Body：`{ "first_run": true, "users_count": 0 }`

---

### 場景 5：POST /api/setup/init 成功建第一個 super_admin

**GIVEN**
- `users` 表為空
- `OWNMIND_BYPASS` 環境變數未設

**WHEN**
- `POST /api/setup/init`
  ```json
  { "email": "admin@example.com", "password": "secure123" }
  ```

**THEN**
- HTTP 201（Created）
- Body：
  ```json
  {
    "id": 1,
    "email": "admin@example.com",
    "role": "super_admin",
    "api_key": "<uuid>",
    "name": "admin"
  }
  ```
  （`id` 是 PostgreSQL SERIAL 整數、`api_key` 是 UUID v4 字串）
- `users` 表新增一筆 super_admin、`password_hash` 已 hash、`api_key` 為 UUID
- `audit_log` 表寫一筆 `event='setup_init'`、`actor_user_id=<新建 user id>`

---

### 場景 6：POST /api/setup/init 在 DB 已有 admin 時 → 拒絕

**GIVEN**
- 已成功跑過 setup（users 表非空）

**WHEN**
- 再次 `POST /api/setup/init`

**THEN**
- HTTP 403
- Body：`{ "error": "setup wizard 已完成、請走 /admin/login" }`
- `users` 表不變

---

### 場景 7：密碼太短 → 拒絕

**GIVEN**
- `users` 表為空

**WHEN**
- `POST /api/setup/init`
  ```json
  { "email": "admin@example.com", "password": "short" }
  ```

**THEN**
- HTTP 400
- Body：`{ "error": "密碼至少 8 個字元" }`
- `users` 表不變

---

### 場景 8：email 格式不對 → 拒絕

**GIVEN**
- `users` 表為空

**WHEN**
- `POST /api/setup/init`
  ```json
  { "email": "not-an-email", "password": "secure123" }
  ```

**THEN**
- HTTP 400
- 訊息含 "email" 格式錯誤

---

### 場景 9：缺欄位 → 拒絕

**GIVEN**
- `users` 表為空

**WHEN**
- `POST /api/setup/init` body 缺 password

**THEN**
- HTTP 400
- 訊息提示缺欄位

---

## 三、Race condition 場景

### 場景 10：併發兩個 init 請求、只有一個成功

**GIVEN**
- `users` 表為空
- 兩個請求同時到 `POST /api/setup/init`

**WHEN**
- 兩個請求帶不同 email、parallel 送出

**THEN**
- 一個請求拿到 HTTP 201、users 表新增該 admin
- 另一個請求拿到 HTTP 403 或 409、不會建出第二個 admin
- `users` 表最終只有一筆 admin、不會建出兩筆

---

## 四、Setup HTML 頁面場景

### 場景 11：開 /setup 顯示 wizard 表單

**GIVEN**
- `users` 表為空

**WHEN**
- 瀏覽器 GET `/setup`

**THEN**
- HTTP 200、回傳 HTML
- 頁面含 email 輸入欄、password 輸入欄、password 確認欄、「建立管理員」按鈕
- 含 `<meta name="robots" content="noindex">`（不被搜尋引擎爬）

---

### 場景 12：wizard 表單成功建立後、顯示 api_key + 引導

**GIVEN**
- 使用者填完表單、點建立

**WHEN**
- 前端 JS 呼叫 `POST /api/setup/init` 成功、收到回應

**THEN**
- 頁面切換顯示：
  - 「✅ 管理員建立成功」
  - 顯示 api_key（可一鍵複製）
  - 顯示 client install.sh 範例指令（含 api_key 跟當前 host URL）
  - 「前往登入」按鈕、連到 `/admin/login`

---

## 五、跟舊 `/admin/setup` 並存場景

### 場景 13：舊 SETUP_TOKEN 路徑不被破壞

**GIVEN**
- `users` 表有一筆 super_admin、但 `password_hash IS NULL`（外部匯入帳號）
- 環境變數 `SETUP_TOKEN=foo` 已設

**WHEN**
- `POST /admin/setup` 帶 `{ setup_token: 'foo', email, password }`

**THEN**
- HTTP 200、密碼成功設定（同 v1.19.7 既有行為）
- 新 wizard 不干擾這條路徑

---

### 場景 14：first-run check 看 admin/super_admin 角色、不看 `password_hash IS NULL`

**GIVEN**
- `users` 表有一筆 super_admin、但 `password_hash IS NULL`

**WHEN**
- `GET /api/setup/status`

**THEN**
- 回 `{ "first_run": false, "users_count": 1 }`
- 不再進 wizard、走舊 SETUP_TOKEN 路徑救援
- `/admin/login` 不被 redirect 到 `/setup`

---

## 六、安全性場景

### 場景 15：/setup 頁面含 noindex meta

**GIVEN**
- `users` 表為空

**WHEN**
- GET `/setup`

**THEN**
- 回傳 HTML 含 `<meta name="robots" content="noindex">`

---

### 場景 16：rate limit 不擋 /setup（首次使用）

**GIVEN**
- `users` 表為空
- 使用者開 wizard 試了 3 次密碼但都太短

**WHEN**
- 第 4 次 POST `/api/setup/init`（仍然太短）

**THEN**
- 仍正常回 400「密碼太短」、不被 rate limit 擋
- 因為 first-run 階段使用者本來就需要多試幾次密碼格式

> 註：建立成功後（first_run=false）若有誤入此 endpoint、應走標準 rate limit
