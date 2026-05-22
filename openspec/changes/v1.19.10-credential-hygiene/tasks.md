# v1.19.10 — Hotfix 任務清單

## 範圍

### Code 修正
- [ ] `.mcp.json`：`OWNMIND_API_KEY` 改成 `__SET_ME_VIA_LOCAL_OVERRIDE__` 佔位符 + 加註解
- [ ] `src/routes/admin.js`：把 `DEFAULT_USER_PASSWORD` 固定值移除、改用 `generateTempPassword`（從 v1.19.9 抽到 `shared/random-password.js`）
- [ ] `src/jobs/seed-default-passwords.js`：每個 user 各別產隨機密碼、不再共用固定值
- [ ] 新增 `shared/random-password.js`：把 v1.19.9 `generateTempPassword` 從 `admin-password-reset.js` 抽出來、給多處共用
- [ ] `.gitignore`：補 `.mcp.json` 跟 `.env*` 跟 `credentials*` 跟 `*.pem`

### Detector 強化
- [ ] `src/utils/secret-detect.js`：加 `vin-ownmind-*` 跟 `Password\d{8,}` 兩條 regex
- [ ] `tests/secret-detect-unit.test.js`：補新樣式測試

### 文件同步
- [ ] package.json 1.19.9 → 1.19.10
- [ ] CHANGELOG 加 v1.19.10 段（中性的安全強化描述）
- [ ] FILELIST
- [ ] 三語系 README 版本資訊更新（不另開使用者面向 FAQ、屬內部最佳實踐強化）

### 驗證
- [ ] `npm test` 全套綠
- [ ] 走 `superpowers:requesting-code-review`
- [ ] commit

## 風險檢查點

- [ ] DB 端 SQL（Vin 手動）跑完後、新 api_key 已更新到本機 `.mcp.json` 跟 `~/.ownmind/credentials`
- [ ] `seedDefaultPasswords` 改完後、server 啟動時若有 `password_hash IS NULL` user、會印出每人個別隨機密碼到 server log（一次性）
- [ ] admin 建 user 時若沒指定密碼、回應的 `default_password` 是該 user 專屬隨機值
- [ ] IR-002 pre-commit hook 偵測到下次又有人 commit 包含 `vin-ownmind-` 或 `Password\d{8,}` 字串會被擋

## 非任務

- ❌ git history 清理（金鑰已輪換、舊歷史可保留作為事件紀錄）
- ❌ 換 git provider
- ❌ OAuth / SSO（v1.21+）
