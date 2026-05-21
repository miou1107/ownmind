# v1.20 — Critical 鐵律卡控 任務清單

> 依 IR-003（TDD）：每個實作 task 前面先寫測試。
> 依 IR-012（品管三步驟）：驗證 → 請評審 → 處理回饋。
> 依 IR-008（commit 同步更新 README/FILELIST/CHANGELOG）。
> 估時：5~6 週、分 9 個階段。

---

## 階段 A：共用 Enforcer 核心（純函式）

> 三種 hook（pre-commit / PreToolUse / reply-lint）共用的判定核心。
> 先做這個讓 hook 層只需要組合、不重複寫偵測邏輯。

- [ ] A1. 寫測試 `tests/rule-enforcer-core.test.js`（預估 25 case）
  - `evaluateRule(ruleCode, context): { action, message, detected_by }` 各鐵律分支
  - 10 條 critical 都有對應測試（含通過 + 違反兩端）
  - context 缺欄位的 fallback 行為（fail-open）
- [ ] A2. 新檔 `hooks/lib/rule-enforcer.js`（純函式）
  - 主入口 `evaluateRule(ruleCode, context)`
  - 各鐵律一個檢查函式（`checkIR002`、`checkIR005`、...）
  - 共用 `shared/secret-detect.js`（v1.19.1 引入）
  - 不依賴任何 hook 框架、可在 node 直接 require

---

## 階段 B：Bypass 機制與 Audit log

- [ ] B1. 寫測試 `tests/bypass-handler.test.js`（預估 10 case）
  - `OWNMIND_BYPASS=IR-008` 跳過單條
  - `OWNMIND_BYPASS=IR-008,IR-024` 跳過多條
  - `OWNMIND_BYPASS=all` 跳過所有
  - bypass scope 是 process（不污染全域）
  - bypass 寫 audit event 結構正確
- [ ] B2. 新檔 `hooks/lib/bypass-handler.js`
  - `parseBypass(env): Set<string>` 解析環境變數
  - `isBypassed(ruleCode, bypassSet): boolean`
  - `logBypass(ruleCode, context)` 寫 audit
- [ ] B3. 改 `shared/compliance.js`
  - `appendCompliance` 接受 `action='bypass'`、`action='block'`、`action='hook_internal_error'` 新值
  - 補對應測試 5 case 到 `tests/compliance.test.js`
- [ ] B4. 改 `src/routes/compliance.js`
  - 新 API `GET /api/compliance/bypass?from=&to=&rule_code=` 查 bypass 紀錄
  - 新 API `PUT /api/compliance/:id/review` 標記已 review（不可刪）
  - 寫測試 `tests/compliance-bypass-api.test.js`（5 case）

---

## 階段 C：Git pre-commit hook（最大塊）

- [ ] C1. 寫測試 `tests/git-pre-commit-integration.test.js`（預估 18 case）
  - 涵蓋場景 1~10（規格中 git pre-commit 場景）
  - 用 `child_process.spawn` 跑 hook 腳本、檢查 exit code 與 stderr
  - fixtures：每個違反情境一個 staged diff snapshot
- [ ] C2. 新檔 `hooks/ownmind-git-pre-commit.js`
  - 讀 staged diff（`git diff --cached --name-only` + `git diff --cached`）
  - 並行跑 6 條 critical 檢查（Promise.all）
  - 任一違反 → exit 1（除非有 bypass）
  - 所有通過 → exit 0 + 寫 comply audit
  - SLA：< 100ms p95（含 detector）
- [ ] C3. 新檔 `hooks/ownmind-git-commit-msg.js`
  - 專責檢查 commit message（IR-024 Co-Authored-By）
  - 比 pre-commit 更小更快、< 20ms
- [ ] C4. 新檔 `hooks/ownmind-git-pre-tag.js`
  - 專責 IR-031 三處版號同步
  - 解析 package.json / src/SERVER_VERSION / 即將打的 tag
- [ ] C5. Benchmark 測試 `tests/hook-performance.test.js`
  - 50 staged 檔案的 commit、跑 100 次、p95 < 100ms

---

## 階段 D：PreToolUse hook（Claude Code + Codex）

- [ ] D1. 寫測試 `tests/pre-tool-use-hook.test.js`（預估 12 case）
  - IR-005 Read state 追蹤（涵蓋場景 11、12）
  - IR-002 工具層 `rm .env` 攔截（場景 13）
  - bypass 機制（場景 18~20 部分）
- [ ] D2. 新檔 `hooks/ownmind-pre-tool-use.js`
  - 入口接收 Claude Code / Codex 的 PreToolUse payload（JSON via stdin）
  - 區分 tool name：Edit/Write 走 IR-005 check、Bash 走 IR-002 pattern check
  - exit 2 = block + 訊息給 AI（Claude Code 慣例）
- [ ] D3. 新檔 `hooks/lib/session-read-tracker.js`
  - 維護本 session 的 read-files 狀態
  - 路徑：`~/.ownmind/state/session-<id>/read-files.json`
  - PostToolUse Read 時更新（需配套寫 `hooks/ownmind-post-tool-use.js`）
- [ ] D4. 新檔 `hooks/ownmind-post-tool-use.js`
  - 偵測 Read 工具呼叫完成、更新 session-read-tracker
  - 必須跟 D2 共用 session-id 取得邏輯

---

## 階段 E：Reply-lint 升級為硬擋

- [ ] E1. 寫測試 `tests/reply-lint-block-mode.test.js`（預估 8 case）
  - IR-037 中英混雜 → exit 2（場景 14）
  - IR-036 行話無白話 → exit 2（場景 15）
  - 連續擋 3 次 → 第 4 次降為 warning（場景 16）
  - IR-041 user 自己 prompt 含同樣字串 → 不擋（場景 17 例外）
- [ ] E2. 改 `hooks/ownmind-reply-lint.js`
  - 既有偵測邏輯不變、退出碼從 0 改 2（違反時）
  - 加 `~/.ownmind/state/session-<id>/reply-block-count.json` 追蹤連續擋次數
  - 加 user prompt 比對邏輯（IR-041 例外）
- [ ] E3. 改 `hooks/lib/reply-lint-rules.js`（若既有）
  - 確保 IR-036 / IR-037 / IR-041 規則邏輯共用 rule-enforcer.js

---

## 階段 F：跨工具相容

- [ ] F1. 寫測試 `tests/cross-tool-hooks.test.js`（預估 5 case）
  - Claude Code settings.json hook 註冊測試
  - Codex 對應 hook 點測試
  - Cursor 用戶純走 git pre-commit 的整合測試
- [ ] F2. 改 `install.sh` / `install.ps1`
  - 新增 `--install-hooks` 旗標
  - 安裝對應工具的 hook 設定（Claude Code settings.json / Codex 對應檔）
  - git hooks 用 symlink 不覆蓋既有
- [ ] F3. 新檔 `scripts/migrate-hooks.sh` / `migrate-hooks.ps1`
  - 既有 user 升級到 v1.20 跑這個
  - 偵測 git repo、symlink hook
  - 若 `.git/hooks/pre-commit` 已存在 → 不覆蓋、提示手動處理

---

## 階段 G：Admin UI Bypass 紀錄

- [ ] G1. 寫測試 `tests/admin-bypass-page.test.js`（預估 4 case）
  - 列表頁渲染
  - 篩選功能（依規則、依日期）
  - review 標記
  - 嘗試刪除 → 沒按鈕、API 也擋
- [ ] G2. 改 `src/public/index.html`
  - 新增「Bypass 紀錄」分頁
  - 表格欄位：時間、規則、commit sha、訊息、review 狀態
  - 篩選器：rule_code dropdown + 日期 picker
- [ ] G3. 改 `src/public/index.html` 樣式
  - bypass_all 紅字警示
  - 一週內 bypass 次數小卡片

---

## 階段 H：SessionStart 升級引導

- [ ] H1. 寫測試 `tests/session-start-migrate-prompt.test.js`（預估 3 case）
  - server 版本 v1.20、本機 hook 未安裝 → 顯示引導
  - server v1.20、本機 hook 已安裝 → 不顯示
  - server < v1.20 → 完全不提
- [ ] H2. 改 `hooks/ownmind-session-start.js`
  - 偵測 `.git/hooks/pre-commit` 是否 symlink 到 `~/.ownmind/hooks/`
  - 缺少時插入引導訊息（一次性、寫 flag 避免每次跳）

---

## 階段 I：文件與發版

- [ ] I1. 改 `README.md`
  - 「Iron Rule Enforcement Engine」段大幅擴充
  - 加 v1.20 三層卡控示意圖
  - bypass 機制說明 + 範例
- [ ] I2. 改 `docs/README.zh-TW.md` / `docs/README.ja.md`（IR-131 三語系同步）
- [ ] I3. 改 `CHANGELOG.md`
  - 加 v1.20.0 完整條目
- [ ] I4. 改 `FILELIST.md`
  - 加所有新檔（hook 5 個、lib 3 個、scripts 2 個、tests 8 個）
- [ ] I5. 三處版號同步（IR-031）
  - `package.json` → 1.20.0
  - `src/SERVER_VERSION` → 1.20.0
  - 預備打 tag `v1.20.0`
- [ ] I6. 跑全測試（`npm test`）、確認 0 failure
- [ ] I7. 品管三步驟（IR-012）
  - verification-before-completion（跑驗證、貼輸出）
  - requesting-code-review（請評審）
  - receiving-code-review（嚴謹處理回饋）
- [ ] I8. Browser 實測（IR-020）
  - Admin UI Bypass 紀錄分頁
  - 實際跑一次故意違反每條 critical 確認都被擋
- [ ] I9. Vin 拍板 → push → 部署 prod
- [ ] I10. 跑兩週觀察期、收集 bypass 紀錄 + 誤判通報

---

## 驗收條件

- [ ] 故意 commit `.env` 檔案 → 被 IR-002 擋（場景 1）
- [ ] 故意 commit src/ 改動不同步 README → 被 IR-008 擋（場景 3）
- [ ] 故意 commit message 加 Co-Authored-By → 被 IR-024 擋（場景 6）
- [ ] AI 直接 Edit 沒讀過的檔案 → 被 IR-005 擋（場景 11）
- [ ] AI 回應中英混雜 > 15% → 被 IR-037 擋（場景 14）
- [ ] `OWNMIND_BYPASS=IR-008 git commit ...` → 跳過 + 寫 audit（場景 18）
- [ ] hook 內部錯誤 → fail-open + 寫 error log（場景 26）
- [ ] 100 次 commit benchmark p95 < 100ms（場景 23）
- [ ] Admin UI Bypass 紀錄正常顯示、不可刪除（場景 24、25）
- [ ] 升級流程：v1.19 → v1.20 跑 migrate-hooks 一切正常（場景 22）
- [ ] 全測試通過、無 regression
- [ ] README 三語系同步、CHANGELOG 完整、FILELIST 不缺檔

---

## 非任務（v1.21+ 處理）

- ❌ Advisory tier 邏輯（只寫紀錄、不跳警告）
- ❌ Default tier 違反次數自動升 critical
- ❌ AI 輔助分類（LLM 建議 tier）
- ❌ per-user 客製分級
- ❌ Cursor PreToolUse 卡控（等 Cursor 推出 hook）

---

## 風險檢查點（每階段結束時 review）

- [ ] 階段 C 結束：跑一次 dogfood、用 v1.20 hook 自己 commit v1.20 程式碼、確認沒卡死
- [ ] 階段 E 結束：跑一次 reply-lint 硬擋、確認 AI 能正確重做
- [ ] 階段 F 結束：在另一台機器跑 migrate-hooks、驗證升級流程
- [ ] 階段 I 結束：發版前再跑一次完整 e2e（自己違反每條 critical、確認都被擋）
