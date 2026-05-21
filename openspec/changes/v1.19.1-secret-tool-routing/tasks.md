# v1.19.1 — 密碼/Token 不寫進記憶 任務清單

> 依 IR-003（TDD）：每個實作 task 前面先寫測試。
> 依 IR-012（品管三步驟）：驗證 → 請評審 → 處理回饋。
> 依 IR-008（commit 同步更新 README/FILELIST/CHANGELOG）。

---

## 階段 A：Detector 純函式 + 單元測試 ✅

- [x] A1. 寫測試 `tests/secret-detect-unit.test.js`（實際 26 case，含偵測順序、邊界輸入、回傳結構額外覆蓋）
  - WP Application Password 格式命中（場景 1）
  - JWT 格式命中（場景 2）
  - GitHub PAT 格式命中（`ghp_...`、`ghs_...`、`gho_...`、`ghu_...`）
  - AWS Access Key 格式命中（`AKIA...`）
  - OpenAI API key 格式命中（`sk-...`）
  - keyword 命中：title 含 `password`、`token`、`api_key`、`secret`（不分大小寫）
  - keyword 命中：description 含繁中關鍵字（`應用程式密碼`、`存取金鑰`）
  - 長度啟發式：純英數字 ≥20 字 → 命中
  - 長度啟發式：含中文 → 不命中
  - 長度啟發式：短字串 < 20 → 不命中
  - bypass：`{ allow_secret_like: true }` → 跳過所有偵測
  - `detectSecretLike(null)` / `undefined` → `{ detected: false }`（不丟）
  - 回傳結構：`{ detected: boolean, rule: string, reason: string }`
- [x] A2. 新檔 `src/utils/secret-detect.js`（純函式、不依賴 DB）
  - `detectSecretLike(value, { title, description, allow_bypass } = {}): DetectResult`
  - 常數區：`SECRET_REGEXES`（5 條）、`SECRET_KEYWORDS`（英中混合）
  - 偵測順序：bypass → regex → keyword → length heuristic

---

## 階段 B：Memory API 接入 detector ✅

- [x] B1. 寫測試 `tests/memory-secret-guard.test.js`（實際 24 case）
  - 偵測命中 4 case（WP / JWT / keyword:password / heuristic）
  - 正常記憶通過 4 case（含中文、iron_rule 討論密碼、principle、narrative regex 仍擋）
  - Bypass 3 case（lint_warning_entry 結構、真 JWT bypass、無 metadata 不丟）
  - 邊界 3 case（body 結構、空 content、null content）
  - narrative types 完整覆蓋 10 case（5 個 narrative type × 2 場景）
  - **設計調整**：採「helper 純函式測試」而非「全 route 整合測試」、跟 iron-rule-quality.test.js 同一個模式
- [x] B2. 新檔 `src/utils/memory-secret-guard.js`
  - `validateMemoryContent({ type, title, content, metadata })`
  - narrative 類型（iron_rule / principle / coding_standard / team_standard / session_log）跳 keyword、保留 regex
  - bypass: metadata.allow_secret_like=true → 跳過 + 回傳 lint_warning_entry
  - 命中 → `{ ok: false, status: 400, body: { error, hint, redirect_tool, detected_by } }`
- [x] B3. detector 擴充 `skip_keyword` 選項（v1.19.1 設計調整）
  - regex 改 non-anchored、用 word boundary 等抓 embedded 密鑰
  - WP password 改 `{5}` 而非 `{5,}` 限縮為恰好 6 組降低誤判
- [x] B4. 改 `src/routes/memory.js`
  - POST handler：lintIronRule 後、syncToken 前接 validateMemoryContent
  - PUT handler：merged 算出後、UPDATE 前接 validateMemoryContent（只在 contentChanged 時跑）
  - bypass：把 lint_warning_entry 合併進 metadata.lint_warnings（保留既有 warnings）
  - 命中 → 直接 res.status(400).json(body)、不寫 memory / memory_history
  - __upgrade_test__ prefix 跳過（測試用記憶不該被擋）

---

## 階段 C：500 → 4xx catch-all 改造 ✅

- [x] C1. 寫測試 `tests/memory-error-classifier.test.js`（實際 21 case）
  - PG constraint violations 4 case：23502 / 23503 / 23505 / 23514
  - PG connection / 系統錯誤 3 case：08000 / 08006 / ECONNREFUSED
  - JS 內建錯誤 2 case：SyntaxError / TypeError
  - 邊界 5 case：null / undefined / 字串 / 物件帶 status / 未分類 Error
  - 回傳結構 4 case：error 字串、logStack、logLevel
  - context 參數 3 case：create / update / 預設
- [x] C2. 新檔 `src/utils/memory-error-classifier.js`
  - `classifyMemoryError(err, { context }): { status, body, logLevel, logStack }`
  - PG SQLSTATE 分類：23xxx → 400/409、22xxx → 400、08xxx → 503
  - JS SyntaxError → 400、其他 → 500
  - null/undefined/非物件 → 500 fallback、不丟
- [x] C3. 改 `src/routes/memory.js` POST + PUT catch
  - POST handler line 1114 catch 接 classifyMemoryError({ context: 'create' })
  - PUT handler line 1326 catch 接 classifyMemoryError({ context: 'update' })
  - log 含 error.message + code，500/503 額外含 stack
  - 改用 classified.logLevel（warn for 4xx、error for 5xx）避免 4xx noisy log

---

## 階段 D：MCP 工具描述警語 ✅

- [x] D1. 寫測試 `tests/mcp-tool-description-secret-warning.test.js`（實際 10 case、source-level regex 驗證）
  - ownmind_save：找到描述 / 含「敏感資料／密碼」/ 含「ownmind_set_secret」/ 警語在前 80 字
  - ownmind_update：同上 4 case
  - ownmind_set_secret：找到描述 / 不含「請改用 ownmind_set_secret」（避免循環）
- [x] D2. 改 `mcp/index.js`
  - `ownmind_save` description 開頭加：「⚠️ 含密碼／token／API key／credential 等敏感資料請改用 ownmind_set_secret、不要寫進記憶（記憶 API 會偵測並擋下、回 400）」
  - `ownmind_update` description 同上
  - 不動 inputSchema
  - `ownmind_set_secret` description 維持原樣（不加自我循環警語）

---

## 階段 E：新增鐵律 ✅

- [x] E1. 透過 ownmind_save MCP 工具建立 **IR-047**（id=436）：
  - 標題：「敏感資料一律走密鑰管理工具、不寫進記憶／對話／程式碼提交」
  - type: `iron_rule`
  - tier: `critical`（直接設定、不需 admin UI 手動升級）
  - tags: `trigger:credential`, `trigger:password`, `trigger:secret`, `trigger:api_key`, `trigger:token`
  - 5 段結構（依 IR-039 / IR-040）：
    - 何時觸發（含 4 類敏感資料分類）
    - 規則（3 個正規通道 + 4 條不可做的事）
    - 為什麼（2026-05-18 真實事件 + 三層防護說明）
    - 自我檢查（被洩漏要立刻改 = 密鑰）
    - 相關鐵律（IR-002、IR-041）
  - origin_context 自動附進 metadata（時間、信心、專案、git 分支、user 原話、related_rules）
  - related_rules: `["IR-002", "IR-041"]`
  - **設計調整**：原本規劃透過 admin UI 建（有 audit log）、但 ownmind_save 已支援 tier 參數 + origin_context 自動紀錄、改用 MCP 工具一次完成、效果等同
- [x] E2. SessionStart 載入驗證待做 — 下次新 session 開啟時驗證鐵律出現在 critical 分組（手動驗收項、留階段 F 發版後跑）

---

## 階段 F：文件與發版

- [ ] F1. 更新 `README.md`「Memory vs Secret」段（新建段落）
  - 何時用哪個工具的決策樹（白話）
  - 偵測規則摘要
  - bypass 機制說明
- [ ] F2. 同步 `docs/README.zh-TW.md` 與 `docs/README.ja.md`
- [ ] F3. `CHANGELOG.md` 加 v1.19.1 條目
- [ ] F4. `FILELIST.md` 加新檔：
  - `src/utils/secret-detect.js`
  - `tests/secret-detect-unit.test.js`
  - `tests/memory-api-secret-detect.test.js`
  - `tests/memory-api-error-codes.test.js`
  - `tests/mcp-tool-description-secret-warning.test.js`
- [ ] F5. 三處版號同步（IR-031）：`package.json`、`SERVER_VERSION`、git tag `v1.19.1`
- [ ] F6. 跑全測試（`npm test`）、確認 0 failure
- [ ] F7. 品管三步驟（IR-012）：
  - verification-before-completion（跑驗證命令、貼輸出）
  - requesting-code-review（請 review）
  - receiving-code-review（嚴謹處理回饋）
- [ ] F8. Vin 拍板 → push → 部署 prod
- [ ] F9. browser 實測（IR-020）：admin UI 看新鐵律、實際呼叫 `ownmind_save` 帶密碼確認被擋

---

## 驗收條件

- [ ] 重現本提案 1.1 真實事件（用 `ownmind_save` 寫含密碼的記憶）→ 收到 400 + hint「請改用 ownmind_set_secret」
- [ ] 正常記憶（含中文 content）寫入無誤
- [ ] 新鐵律出現在 SessionStart Critical 分組
- [ ] `ownmind_save` / `ownmind_update` tool description 含警語
- [ ] DB 錯誤仍回 500（不誤判 400）
- [ ] 全測試通過、無 regression

---

## 非任務（v1.19.2 處理）

- ❌ 既有 memory DB 中存在的密碼掃描 + redaction
- ❌ Hook 端 reply-lint 偵測 AI 回應含密碼
- ❌ Detector 擴增到更多 regex（Slack、Stripe、Discord 等）
