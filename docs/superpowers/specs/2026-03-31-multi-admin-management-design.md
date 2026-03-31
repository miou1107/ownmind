# OwnMind Dashboard 多管理者管理介面 — Design Spec

**Date:** 2026-03-31
**Author:** Vin
**Status:** Approved

---

## 1. 背景與目標

OwnMind Dashboard 目前只有單一 admin 帳號（Vin）。本功能讓 Vin 可以建立其他管理員帳號，讓多人共同查看 Dashboard，並透過角色分級限制各人的操作權限。

---

## 2. 角色階層

```
super_admin (Vin)
  └── admin (被邀請的管理員)
        └── user (一般使用者，無法登入 Dashboard)
```

| 操作 | super_admin | admin | user |
|------|:-----------:|:-----:|:----:|
| 登入 Dashboard | ✓ | ✓ | ✗ |
| 新增 user 帳號 | ✓ | ✓ | ✗ |
| 新增 admin/super_admin 帳號 | ✓ | ✗ | ✗ |
| 刪除帳號 | ✓ | ✗ | ✗ |
| 修改他人角色 | ✓ | ✗ | ✗ |
| 修改自己密碼 | ✓ | ✓ | ✗ |
| 修改他人密碼 | ✓ (限 admin) | ✗ | ✗ |

---

## 3. 資料庫變更

**Migration: `db/005_admin_roles_password.sql`**

```sql
-- 1. 新增 password_hash 欄位
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- 2. 擴展 role CHECK（支援 super_admin）
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'admin', 'user'));

-- 3. Vin 自動升級為 super_admin
UPDATE users SET role = 'super_admin' WHERE id = 1;

-- 4. 稽核追蹤欄位
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id);

-- 5. 操作稽核表
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id INT REFERENCES users(id),
  action VARCHAR(50) NOT NULL,          -- login, create_user, update_user, delete_user, change_password
  target_type VARCHAR(50),              -- user
  target_id INT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 4. Middleware

**`src/middleware/adminAuth.js`**

```js
const ROLE_RANK = { user: 0, admin: 1, super_admin: 2 };

function isAtLeast(userRole, required) {
  return (ROLE_RANK[userRole] ?? -1) >= (ROLE_RANK[required] ?? 99);
}

// adminAuth: 允許 admin + super_admin
// superAdminAuth: 只允許 super_admin
```

---

## 5. API 變更

### 5a. `POST /admin/login`
- WHERE 條件：`role IN ('admin', 'super_admin')`
- 回傳增加 `role` 欄位
- 若 `password_hash IS NULL` → 回傳 `{ requiresSetup: true }` 而非 token

### 5b. `POST /admin/setup`（新，無需 auth）
- 首次設定 super_admin 密碼
- 條件：找到 `role='super_admin' AND password_hash IS NULL`
- 設定後即失效（不可重觸發）

### 5c. `POST /admin/users`（修改）
- 接受 `password` 參數，bcrypt hash 後存入
- admin 只能建 `role='user'`；super_admin 可建任何角色
- 記錄 `created_by` + 寫 audit_log

### 5d. `PUT /admin/users/:id`（新增）
- 更新 name / email / role
- 角色變更：只有 super_admin 能做
- 不能改自己的角色
- 降級 super_admin 前確認至少還有一個 super_admin
- 寫 audit_log

### 5e. `DELETE /admin/users/:id`（修改）
- 只有 super_admin 能刪
- 不能刪自己、不能刪 ID=1（Vin）
- 刪前寫 audit_log

### 5f. `POST /admin/users/:id/password`（新）
- super_admin：可改任何 admin 的密碼（不需舊密碼）
- admin：只能改自己的（需要 `oldPassword` 驗證）

---

## 6. UI 變更 (`src/public/admin.html`)

### 6a. 登入後儲存角色
```js
let currentUserRole = '';   // 'super_admin' | 'admin'
let currentUserId = null;
```

### 6b. 使用者列表（角色感知）
- super_admin badge：金色樣式 `.role-super_admin { background: #fef3c7; color: #d97706; }`
- **刪除按鈕**：只有 super_admin 看到
- **改密碼按鈕**：super_admin 看所有 admin 的 + 自己；admin 只看自己的

### 6c. 新增使用者表單
- 加入密碼欄位（admin/super_admin 必填）
- 角色選單：super_admin 看到三個選項；admin 只看到 `user`

### 6d. 改密碼 Modal
- 欄位：舊密碼（改自己時顯示）、新密碼、確認新密碼
- 呼叫 `POST /admin/users/:id/password`

### 6e. 首次設定密碼流程
- login 回傳 `requiresSetup: true` → 顯示「設定密碼」表單
- 送出後呼叫 `POST /admin/setup` → 自動登入

---

## 7. 安全考量

- 密碼以 bcrypt(rounds=10) hash 儲存，永不傳輸明文
- JWT 中加入 `role` 欄位，每次 request 在 middleware 驗證
- ID=1（Vin）不可被刪除，確保系統不失去 super_admin
- 降級操作前確認 super_admin 數量 ≥ 2

---

## 8. 驗證清單

- [ ] super_admin 登入成功，回傳 role
- [ ] admin 登入成功
- [ ] user 角色無法登入 Dashboard（403）
- [ ] admin 不能刪使用者（403）
- [ ] admin 不能改角色（403）
- [ ] admin 只能建 user 角色帳號
- [ ] super_admin 能建 admin 帳號（含密碼）
- [ ] super_admin 能刪使用者（除自己和 ID=1）
- [ ] 改密碼：自己改需要舊密碼
- [ ] 改密碼：super_admin 改他人不需舊密碼
- [ ] 首次設定密碼流程正常
- [ ] audit_logs 正確記錄所有操作
- [ ] 現有 API key 認證不受影響

---

## 9. 部署順序

1. 跑 DB migration（`db/005_admin_roles_password.sql`）
2. `docker compose build --no-cache api && docker compose up -d --force-recreate api`
3. Vin 打開 Dashboard → 首次設定密碼流程
4. 瀏覽器實測
