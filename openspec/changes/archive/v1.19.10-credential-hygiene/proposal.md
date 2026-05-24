# v1.19.10 — 安全強化：預設密碼隨機化 + 設定檔最佳實踐

## 背景

OwnMind 在 v1.19.9 之前有幾處跟敏感資料相關的程式碼模式可以改善：

1. `.mcp.json` 包含 `OWNMIND_API_KEY` 字面值 — 對外公開的設定檔不應包含可登入的金鑰
2. `src/routes/admin.js` 跟 `src/jobs/seed-default-passwords.js` 都用一個固定字串當所有 user 的預設密碼 — 即使有 `must_change_password=TRUE` 旗標強制下次登入改、仍違反「不要共用憑證」的最佳實踐

這次同時把這層保護寫進 IR-002 偵測器、預防將來再不小心 commit 進類似字面字串。

## 改善範圍

### 1. 預設密碼改成「每 user 隨機產生」

- 新增 `shared/random-password.js` 提供 `generateRandomPassword(len)` 純函式
  - 規則沿用 v1.19.9 `generateTempPassword`：12 字、含大小寫+數字、避開混淆字 0/O/I/l/1、`crypto.randomBytes` 隨機性
- `src/routes/admin.js` 建立 user 時改用此函式（取代固定字串）
- `src/jobs/seed-default-passwords.js` 啟動補密碼時改成每筆各別產隨機、寫進 server log 一次性顯示
- 對齊 v1.19.9 後台 reset-password 行為、邏輯統一

### 2. `.mcp.json` 改為佔位符 + `.gitignore` 強化

- `OWNMIND_API_KEY` 字面值改成 `__SET_VIA_LOCAL_CREDENTIALS_OR_ENV__`
- 加註解說明：本機跑時走 `~/.ownmind/credentials` 取金鑰、或自建 `.mcp.local.json`（已加進 `.gitignore`）
- `.gitignore` 補規則：`.mcp.local.json` / `credentials*` / `*.pem` / `*.key` / `.env.local` / `.env.production`

### 3. Secret detector 偵測新樣式

- `src/utils/secret-detect.js`（v1.19.7 引入、給 IR-002 pre-commit hook 用）加兩條 regex：
  - `ownmind_predefined_key`：抓 `(vin-)?ownmind-(admin|super|user|api)-*` 預定金鑰格式
  - `default_password_literal`：抓 `Password\d{8,}` 通用預設密碼樣式
- 9 個新單元測試（含命中跟邊界、避免誤判一般 `password` 單字）

## 安全性考量

| 項目 | 防護機制 |
|---|---|
| admin 看到的臨時密碼日誌外流風險 | server log 是 sensitive 資訊、部署環境的 log 收集器要留意（建議只在 stdout、不另送雲端） |
| 升級前的舊部署仍跑著固定密碼 | 升上 v1.19.10 後重啟、`seedDefaultPasswords` 不會動已有 `password_hash` 的 user；新建的 user 都會走新邏輯 |
| 既有部署的 admin 是不是要重設密碼 | 屬於部署方判斷、v1.19.9 後台 reset-password 跟 CLI 救援腳本都支援、可選擇性執行 |

## 不做的事

- ❌ 動 DB schema（沿用既有 `users.must_change_password` 跟 `password_hash`）
- ❌ git history 重寫（force-push 會破壞所有已 clone repo 者的本機狀態、代價高於收益）
- ❌ 換 git provider 或 secret 管理服務（範圍外）

## 工作量估計

| 項目 | 行數 |
|---|---|
| `shared/random-password.js`（從 v1.19.9 抽出） | 50-70 |
| `.mcp.json` 改佔位符 | 5 行 |
| `admin.js` 改用 shared module | 15 行修改 |
| `seed-default-passwords.js` 改每 user 隨機 | 30-40 |
| `.gitignore` 補規則 | 12 行 |
| `secret-detect.js` 加 2 條 regex | 12 行 |
| `secret-detect-unit.test.js` 補 9 case | 50 行 |
| 三語系 README + CHANGELOG + FILELIST | 200 行 |
| openspec | 150 行 |
| **總計** | 約 500 行 |

工程時間：約 1.5-2 小時。

## 風險檢查點

- [ ] `npm test` 全套綠（含 9 個新加 case）
- [ ] `seedDefaultPasswords` 啟動行為向後相容（仍能補 `password_hash IS NULL` 的 user、只是每人密碼不同）
- [ ] admin 建 user 時若沒指定密碼、回應的 `default_password` 是該 user 專屬隨機值
- [ ] IR-002 pre-commit hook 偵測到 commit 包含 `ownmind-admin-*` 或 `Password\d{8,}` 字串會擋下
- [ ] 既有功能（admin / setup / password-reset / seed job）都跑得起來
