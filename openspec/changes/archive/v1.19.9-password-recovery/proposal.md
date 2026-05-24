# v1.19.9 — 忘記密碼救援機制提案

## 背景：v1.19.8 的盲點

v1.19.8 把首次安裝體驗修好了、但「admin 忘記密碼」的災難情境沒解。目前流程：

1. admin 忘記密碼 → `/admin/login` 失敗、沒有「忘記密碼」連結
2. 只能 SSH 進伺服器跑 `UPDATE users SET password_hash = NULL WHERE email = ...`
3. 然後設 `SETUP_TOKEN` 環境變數重啟、走舊 `/admin/setup` 重設密碼

對技術人是麻煩、對非技術 admin 是「公司資料庫鎖死」。

## 三條救援組合（v1.19.9 全部做）

### 方案 1：UI 強制引導（預防勝於治療）

- **setup wizard 完成頁加強提示**：建好第一個 admin 後、強烈建議「請立即建立第二位 admin、否則忘記密碼會需要 SSH 救援」
- **後台單 admin 警告 banner**：當 `admin + super_admin` 角色合計只有 1 位時、後台 dashboard 頂部顯示警告條、提示建立第二位

### 方案 2：CLI 救援腳本（最後一道防線）

- 新增 `scripts/reset-admin-password.js`
- 互動式：列出所有 super_admin、選擇要重設誰、確認、執行
- 動作：把指定 user 的 `password_hash` 設為 NULL、產隨機 SETUP_TOKEN、印出
- 引導使用者：「請設環境變數 `SETUP_TOKEN=<新 token>` 重啟 server、然後開 `/admin/setup` 重設密碼」
- 寫 audit log（action='cli_reset_password'）

**為什麼這算救援而非後門**：能 SSH 進伺服器的人本來就有最高物理權限、能直接讀 DB 看金鑰。CLI 腳本只是把這個動作從「需要記 SQL 語法」降為「跑一行指令」、不降低安全等級。

### 方案 3：後台他人重設密碼（常態救援）

- 新增 `POST /api/admin/users/:id/reset-password`
- 權限：super_admin 可重設任何人（admin / user）；admin 可重設 user（不可重設其他 admin / super_admin）
- 不可重設自己（用既有 `POST /api/me/change-password`）
- 動作：產隨機臨時密碼（12 位英數）、把 user 的 `password_hash` 設新值、`must_change_password=TRUE`
- 回傳臨時密碼一次（讓重設者轉告對方、下次登入會強制改）
- 寫 audit log（action='reset_password_by_admin'）

## 三條的協同覆蓋

| 情境 | 走哪條 |
|---|---|
| 還沒忘密碼、但只有一個 admin | 方案 1 banner 提醒、引導建第二位 |
| Admin A 忘密碼、Admin B 還在 | 方案 3 後台他人重設 |
| 只有一位 admin、且忘記密碼 | 方案 2 SSH + CLI 腳本 |
| 全部 admin 都忘記 | 方案 2 SSH + CLI 腳本 |
| 完全無 SSH 權限的雲端 SaaS 場景 | v1.20+ email 重設流程（不在 v1.19.9 範圍） |

## 安全性考量

| 風險 | 防護機制 |
|---|---|
| Admin A 用方案 3 偷其他 admin 密碼 | 限 super_admin 對 admin / user、admin 只能對 user；audit log 記 actor + target + 時間 |
| CLI 腳本被誤跑 / 惡意跑 | 要互動式雙重確認、印出目標 email 等使用者打 yes 才執行；audit log 留紀錄 |
| 臨時密碼洩漏 | 強制 `must_change_password=TRUE`、首次登入必改；臨時密碼只回傳一次、不存其他地方 |
| 暴力破解臨時密碼 | 12 位英數隨機 = 約 71 位元熵、配合 authLimiter 已足夠 |

## 不做的事

- ❌ Email 重設流程（依賴 SMTP、留 v1.20+）
- ❌ Recovery code（一次性救援碼）— UX 微差、使用者經常忘記保存
- ❌ 2FA / TOTP（多因子認證）— 範圍外
- ❌ 自助式忘記密碼網頁 — 沒 email 整合就只能走 admin 或 SSH

## 工作量估計

| 項目 | 行數估計 |
|---|---|
| `src/routes/admin.js` 加 reset-password endpoint | 60-80 |
| `scripts/reset-admin-password.js` | 100-150 |
| `src/public/setup.html` 完成頁強化 | 20-30 |
| `src/public/index.html` 加 banner | 30-50 |
| `tests/admin-reset-password.test.js` | 150-200 |
| `tests/cli-reset-script.test.js` | 80-120 |
| openspec / CHANGELOG / FILELIST / 三語系 README | 300-400 行 markdown |
| **總計** | 約 1100 行（一半是測試 + 文件） |

工程時間：約 3-4 小時。

## 風險檢查點

- [ ] 跑端到端：建 A、B 兩個 super_admin、A 重設 B 密碼、B 用臨時密碼登入並強制改
- [ ] 跑端到端：CLI 腳本對 super_admin A 重設、走 SETUP_TOKEN 流程重新設密碼
- [ ] 確認 admin 不能用方案 3 重設其他 admin（403）
- [ ] 確認 reset-password 不能改自己（要求走 me/change-password）
- [ ] 確認 audit log 三個動作（reset_password_by_admin / cli_reset_password / setup_password）都寫對
- [ ] 既有 `/admin/setup` + SETUP_TOKEN 路徑不被破壞
- [ ] `npm test` 全套綠
