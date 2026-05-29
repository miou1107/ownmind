# v1.19.9 — Forgot-password recovery spec (GIVEN / WHEN / THEN)

---

## 1. Option 3: admin reset of others' passwords

### Scenario 1: super_admin resets another admin's password → success

**GIVEN**
- The system has super_admin A and admin B
- A is logged in

**WHEN**
- `POST /api/admin/users/<B.id>/reset-password`

**THEN**
- HTTP 200
- Body: `{ id, email, temporary_password: '<12 random chars>', must_change_password: true }`
- DB: B.password_hash updated, B.must_change_password = TRUE
- audit_log writes one row: actor=A, action='reset_password_by_admin', target=B

---

### Scenario 2: admin resets a user's password → success

**GIVEN**
- The system has admin C and user D

**WHEN**
- C calls `POST /api/admin/users/<D.id>/reset-password`

**THEN**
- HTTP 200, temporary_password returned
- audit_log written

---

### Scenario 3: admin tries to reset another admin's password → rejected

**GIVEN**
- The system has admin C and admin E

**WHEN**
- C calls `POST /api/admin/users/<E.id>/reset-password`

**THEN**
- HTTP 403
- Message: `admin 只能重設 user 角色帳號`
- DB unchanged, audit_log not written

---

### Scenario 4: a user tries to reset their own password → rejected, guided to me/change-password

**GIVEN**
- A is logged in

**WHEN**
- `POST /api/admin/users/<A.id>/reset-password`

**THEN**
- HTTP 400
- Message: `不能重設自己的密碼、請走 /api/me/change-password`

---

### Scenario 5: reset a nonexistent user → 404

**GIVEN**
- super_admin A is logged in

**WHEN**
- `POST /api/admin/users/99999/reset-password`

**THEN**
- HTTP 404
- Message: `找不到指定使用者`

---

### Scenario 6: not logged in → 401

**GIVEN**
- No auth token

**WHEN**
- `POST /api/admin/users/1/reset-password`

**THEN**
- HTTP 401 (standard adminAuth behavior)

---

### Scenario 7: a user-role account tries to call after logging in → 403

**GIVEN**
- An ordinary user F is logged in

**WHEN**
- F calls `POST /api/admin/users/<other-user.id>/reset-password`

**THEN**
- HTTP 403 (blocked by adminAuth)

---

### Scenario 8: the temporary password has sufficient strength

**GIVEN**
- super_admin A resets a user's password

**WHEN**
- Observe temporary_password

**THEN**
- Length = 12
- Contains upper/lowercase letters and digits (no confusable characters 0/O/I/l)
- Different on every call (randomly generated)

---

## 2. Option 2: CLI recovery script

### Scenario 9: the script interactively lists super_admins

**GIVEN**
- The DB has 2 super_admins, 3 admins, 1 user

**WHEN**
- Run `node scripts/reset-admin-password.js`

**THEN**
- The terminal prints a list of the 2 super_admins (number, email, last login time)
- Doesn't list admin / user (can only reset super_admin, to avoid being used as a backdoor)
- Prompts the user to enter a number to choose

---

### Scenario 10: the script requires double confirmation

**GIVEN**
- The user enters number 1

**WHEN**
- The script continues

**THEN**
- Prints "即將把 admin@example.com 的密碼設為 NULL、確定要繼續？輸入 'yes' 確認"
- Only runs if yes is entered, any other input cancels

---

### Scenario 11: on success it prints the new SETUP_TOKEN

**GIVEN**
- The user confirms yes

**WHEN**
- The script runs

**THEN**
- UPDATE users SET password_hash = NULL WHERE id = ...
- Generate a random SETUP_TOKEN (32-char hex)
- Print:
  - "✅ 密碼已清除"
  - "請執行：export SETUP_TOKEN=<token>"
  - "然後重啟 server、開 /admin/setup 重設密碼"
- Write audit_log: actor_id=the reset user, action='cli_reset_password', source='cli'

---

### Scenario 12: errors out when the DB is unreachable

**GIVEN**
- DB connection fails (wrong environment variables)

**WHEN**
- Run the script

**THEN**
- exit code != 0
- Prints "DB 連線失敗、請確認 DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD"
- Doesn't mistakenly change any user

---

## 3. Option 1: UI mandatory guidance

### Scenario 13: the setup wizard completion page strengthens the recommendation

**GIVEN**
- The user just created the first super_admin

**WHEN**
- They see the success page

**THEN**
- Besides the original api_key + install command, an additional warning box is shown:
  ```
  ⚠️ 建議馬上建立第二位 admin
  否則你忘記密碼時、會需要 SSH 進伺服器跑救援腳本。
  進後台後第一件事：到「使用者管理」新增第二位 super_admin。
  ```

---

### Scenario 14: single-admin warning banner in the admin

**GIVEN**
- Logged into the admin, the admin + super_admin roles total only 1

**WHEN**
- Open any admin page

**THEN**
- An orange banner is shown at the top:
  ```
  ⚠️ 你是唯一的管理員、忘記密碼將難以救援。建議到「使用者管理」新增第二位 admin。
  [新增第二位 admin →]
  ```
- Clicking the button jumps to /admin/users and opens the "add user" dialog

---

### Scenario 15: the banner auto-disappears when there are two or more admins

**GIVEN**
- There are already 2 or more admin/super_admin

**WHEN**
- Open any admin page

**THEN**
- The banner is not shown
