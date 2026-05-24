# v1.19.19 — requireFields helper 任務清單

## 範圍

- [x] 寫 proposal.md
- [ ] 寫 reproduction test：`tests/require-fields-session-400-format.test.js`
  - 缺所有欄位 → 回 missing=['tool','model','summary']、received={}
  - 缺部分 → 回正確的 missing + received 含已傳欄位
  - 全部給 → 通過
- [ ] 實作 `src/utils/require-fields.js`
  - [ ] 簽名：`requireFields(body, required, options)`
  - [ ] 對 undefined / null / 空字串 一律視為缺
  - [ ] 對 array required 欄位、空陣列視為缺
  - [ ] sensitive key 遮蔽（預設遮 password/token/secret/api_key/value、可 options 加）
  - [ ] body 為 null/undefined 安全處理
- [ ] 寫 `tests/require-fields.test.js`（unit test）
  - [ ] body=null
  - [ ] body={}
  - [ ] 缺部分欄位
  - [ ] 全部給
  - [ ] 敏感欄位遮蔽
  - [ ] 自訂 sensitiveKeys
  - [ ] 對陣列欄位（如 chunks）的驗證
- [ ] 移植 6 個 endpoint
  - [ ] `src/routes/session.js:44`
  - [ ] `src/routes/admin.js:147`
  - [ ] `src/routes/handoff.js:17`
  - [ ] `src/routes/memory.js:899`
  - [ ] `src/routes/memory.js:1688`
  - [ ] `src/routes/secret.js:79`（**value 必須遮蔽**）
  - [ ] `src/routes/usage/pricing.js:62`（順手統一）
- [ ] 跑 `node --test` 全綠（既有 1827 + 新增）
- [ ] 版號 1.19.18 → 1.19.19（`package.json` + `package-lock.json` 兩處）
- [ ] CHANGELOG.md 加 v1.19.19 段
- [ ] FILELIST.md 加 v1.19.19 段
- [ ] 三語系 README 版號更新（zh-TW / en / ja）
- [ ] commit（IR-009 / IR-024）
- [ ] tag v1.19.19 + push origin main + push tag
- [ ] kkvin.com 部署：
  - [ ] `git pull --rebase`
  - [ ] `docker compose build --no-cache api`（IR-018 + IR-023）
  - [ ] `docker compose up -d api`
  - [ ] 看 log 確認伺服器起來、無 error
- [ ] 部署後實測（IR-020）：
  - [ ] 用 minimal body POST 到 `/api/session`、確認回新格式
  - [ ] MCP `ownmind_log_session` 正常呼叫不受影響
  - [ ] admin 後台登入正常
- [ ] 寫 backlog 記憶（type=project）：腿 B MCP client-side schema pre-validation
- [ ] `git mv openspec/changes/v1.19.19-... openspec/changes/archive/`
- [ ] 同步 FILELIST 中的 archive 路徑
- [ ] commit archive + push

## 非任務

- ❌ 改 MCP client schema pre-validation（→ backlog 腿 B）
- ❌ 改其他 80+ 個 inline 400 validation 邏輯（範圍外）
- ❌ 改既有客戶端對錯誤訊息的解析（backward-compatible、不需動）

## 鐵律 checklist

- [x] IR-003 修 bug 先寫 reproduction test
- [x] IR-004 走 OpenSpec
- [ ] IR-005 不要 blind edit（移植每個 endpoint 前先 Read 看完整 context）
- [ ] IR-008 + IR-026 commit 前同步 README/FILELIST/CHANGELOG
- [ ] IR-009 + IR-024 commit contributor + 無 Co-Authored-By
- [ ] IR-018 + IR-023 docker compose build --no-cache
- [ ] IR-020 部署後實測
- [ ] IR-031 三處版號同步
- [ ] IR-032 三語系 README
- [ ] IR-048 部署前跑 migration（本版 0 條）
