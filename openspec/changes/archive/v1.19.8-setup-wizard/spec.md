# v1.19.8 — Setup Wizard spec (GIVEN / WHEN / THEN)

> BDD three-part description, matching the OpenSpec CONVENTIONS.

---

## 1. First-run detection scenarios

### Scenario 1: DB is empty + open browser to /admin → auto-enter wizard

**GIVEN**
- The v1.19.8 server is deployed and started for the first time
- The `users` table has no admin / super_admin records at all

**WHEN**
- The browser does GET `/admin/login` (or any `/admin/*` path)

**THEN**
- HTTP 302 redirect to `/setup`
- Not blocked / no error returned

---

### Scenario 2: DB already has an admin → /setup permanently closed

**GIVEN**
- The setup wizard has already been run once successfully, the `users` table has one super_admin

**WHEN**
- The browser does GET `/setup`

**THEN**
- HTTP 302 redirect to `/admin/login` (setup is done, the wizard should not be seen again)
- Directly POST `/api/setup/init` → HTTP 403, message "setup wizard 已完成、請走 /admin/login"

---

### Scenario 3: DB already has an admin → /admin/login shows the login page normally

**GIVEN**
- A super_admin already exists

**WHEN**
- GET `/admin/login`

**THEN**
- HTTP 200, the login page shows normally, **not** redirected

---

## 2. Setup wizard endpoint scenarios

### Scenario 4: GET /api/setup/status returns first_run

**GIVEN**
- The `users` table is empty

**WHEN**
- `GET /api/setup/status`

**THEN**
- HTTP 200
- Body: `{ "first_run": true, "users_count": 0 }`

---

### Scenario 5: POST /api/setup/init successfully creates the first super_admin

**GIVEN**
- The `users` table is empty
- The `OWNMIND_BYPASS` env var is unset

**WHEN**
- `POST /api/setup/init`
  ```json
  { "email": "admin@example.com", "password": "secure123" }
  ```

**THEN**
- HTTP 201 (Created)
- Body:
  ```json
  {
    "id": 1,
    "email": "admin@example.com",
    "role": "super_admin",
    "api_key": "<uuid>",
    "name": "admin"
  }
  ```
  (`id` is a PostgreSQL SERIAL integer, `api_key` is a UUID v4 string)
- The `users` table gets one new super_admin, `password_hash` is hashed, `api_key` is a UUID
- The `audit_log` table writes one row with `event='setup_init'`, `actor_user_id=<new user id>`

---

### Scenario 6: POST /api/setup/init when the DB already has an admin → reject

**GIVEN**
- Setup has already been run successfully (users table is non-empty)

**WHEN**
- `POST /api/setup/init` again

**THEN**
- HTTP 403
- Body: `{ "error": "setup wizard 已完成、請走 /admin/login" }`
- The `users` table is unchanged

---

### Scenario 7: Password too short → reject

**GIVEN**
- The `users` table is empty

**WHEN**
- `POST /api/setup/init`
  ```json
  { "email": "admin@example.com", "password": "short" }
  ```

**THEN**
- HTTP 400
- Body: `{ "error": "密碼至少 8 個字元" }`
- The `users` table is unchanged

---

### Scenario 8: Bad email format → reject

**GIVEN**
- The `users` table is empty

**WHEN**
- `POST /api/setup/init`
  ```json
  { "email": "not-an-email", "password": "secure123" }
  ```

**THEN**
- HTTP 400
- Message contains an "email" format error

---

### Scenario 9: Missing field → reject

**GIVEN**
- The `users` table is empty

**WHEN**
- `POST /api/setup/init` body missing password

**THEN**
- HTTP 400
- Message indicates the missing field

---

## 3. Race condition scenarios

### Scenario 10: Two concurrent init requests, only one succeeds

**GIVEN**
- The `users` table is empty
- Two requests arrive at `POST /api/setup/init` at the same time

**WHEN**
- The two requests carry different emails and are sent in parallel

**THEN**
- One request gets HTTP 201, the users table gets that admin added
- The other request gets HTTP 403 or 409, no second admin is created
- The `users` table ends up with only one admin, not two

---

## 4. Setup HTML page scenarios

### Scenario 11: Opening /setup shows the wizard form

**GIVEN**
- The `users` table is empty

**WHEN**
- The browser does GET `/setup`

**THEN**
- HTTP 200, returns HTML
- The page contains an email input, a password input, a password confirmation input, and a "建立管理員" button
- Contains `<meta name="robots" content="noindex">` (not crawled by search engines)

---

### Scenario 12: After the wizard form succeeds, show api_key + guidance

**GIVEN**
- The user has filled in the form and clicked create

**WHEN**
- The frontend JS calls `POST /api/setup/init` successfully and receives the response

**THEN**
- The page switches to show:
  - "✅ 管理員建立成功"
  - Display the api_key (one-click copy)
  - Display the client install.sh sample command (containing the api_key and the current host URL)
  - A "前往登入" button linking to `/admin/login`

---

## 5. Coexistence scenarios with the old `/admin/setup`

### Scenario 13: The old SETUP_TOKEN path is not broken

**GIVEN**
- The `users` table has one super_admin, but `password_hash IS NULL` (externally imported account)
- The env var `SETUP_TOKEN=foo` is set

**WHEN**
- `POST /admin/setup` with `{ setup_token: 'foo', email, password }`

**THEN**
- HTTP 200, password set successfully (same as the existing v1.19.7 behavior)
- The new wizard does not interfere with this path

---

### Scenario 14: First-run check looks at the admin/super_admin role, not at `password_hash IS NULL`

**GIVEN**
- The `users` table has one super_admin, but `password_hash IS NULL`

**WHEN**
- `GET /api/setup/status`

**THEN**
- Returns `{ "first_run": false, "users_count": 1 }`
- No longer enters the wizard; goes through the old SETUP_TOKEN recovery path
- `/admin/login` is not redirected to `/setup`

---

## 6. Security scenarios

### Scenario 15: The /setup page contains the noindex meta

**GIVEN**
- The `users` table is empty

**WHEN**
- GET `/setup`

**THEN**
- Returns HTML containing `<meta name="robots" content="noindex">`

---

### Scenario 16: Rate limit does not block /setup (first use)

**GIVEN**
- The `users` table is empty
- The user opened the wizard and tried 3 passwords that were all too short

**WHEN**
- The 4th POST `/api/setup/init` (still too short)

**THEN**
- Still returns 400 "password too short" normally, not blocked by rate limit
- Because during the first-run phase the user inherently needs several tries at the password format

> Note: after creation succeeds (first_run=false), if someone wanders into this endpoint by mistake, it should go through the standard rate limit
