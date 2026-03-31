# OwnMind 鐵律執行引擎 P2+P3 — 工作清單

- 日期：2026-03-31
- Spec：`docs/superpowers/specs/2026-03-31-iron-rule-enforcement-engine-p2-p3-design.md`
- 目標版本：v1.11.0

---

## 階段總覽

```
Phase A: Verification Engine 核心        （獨立模組，可先寫 + 測試）
Phase B: 規則模板庫 + 自動匹配           （Server 端）
Phase C: git hooks（L1 + L5）            （Client 端，核心攔截點）
Phase D: PreToolUse hook 改造（L2）       （Claude Code 限定）
Phase E: MCP 改動（L3 + L6）             （跨平台）
Phase F: 安裝流程 + 現有鐵律遷移         （收尾）
Phase G: Dashboard + 文件更新             （收尾）
```

---

## Phase A：Verification Engine 核心

**產出：** `shared/verification.js`

### A1. 建立 shared/ 目錄結構
- 新建 `shared/verification.js`
- 設定 package.json exports 或直接 require 路徑

### A2. 實作 CHECK_HANDLERS
- `staged_files_include(params, ctx)` — minimatch 比對
- `staged_files_exclude(params, ctx)` — minimatch 比對
- `commit_message_contains(params, ctx)` — string includes
- `commit_message_not_contains(params, ctx)` — string includes
- `recent_event_exists(params, ctx)` — complianceEvents 查詢
- `source_files_changed(params, ctx)` — minimatch 比對
- 每個 handler 處理 context 缺失情況

### A3. 實作 evaluateConditions
- 葉節點：查 CHECK_HANDLERS，未知類型 return true
- AND 節點：所有 checks 通過才 pass
- OR 節點：任一 check 通過就 pass
- when/then 節點：when 為 false → pass（條件不適用），when 為 true → 評估 then
- 遞迴支援巢狀
- 回傳 `{ pass: boolean, failures: string[] }`

### A4. 寫 unit tests
- 見 `tests/verification.test.js`（測試腳本）

**驗收：** 所有 verification tests pass。

---

## Phase B：規則模板庫 + 自動匹配

**產出：** `src/utils/templates.js`、`scripts/migrate-verification.js`

### B1. 實作模板定義
- 5 個模板：`commit_sync_docs`、`commit_no_secrets`、`qa_three_steps`、`deploy_requires_test`、`commit_contributor`
- 每個模板含 `match`（triggers + keywords）和 `verification`（完整條件結構）

### B2. 實作自動匹配函式
- `matchTemplate(rule)` — 根據 rule.tags 和 rule.content 匹配模板
- 匹配邏輯：trigger tags 必須符合 + content 關鍵字命中
- 回傳匹配到的模板或 null

### B3. 整合到 ownmind_save API
- `src/routes/memory.js` 的 save handler
- 當 `type === 'iron_rule'` 且有 trigger tags 時呼叫 `matchTemplate()`
- 命中 → 自動填入 `metadata.verification`
- 回傳含 `matched_template` 欄位

### B4. 實作遷移腳本
- `scripts/migrate-verification.js`
- 撈所有 `type=iron_rule` 且無 `metadata.verification` 的記憶
- 對每條跑 `matchTemplate()`
- 命中 → UPDATE metadata
- 冪等設計（跳過已有 verification 的）
- 結果寫入 activity_logs

### B5. 寫 unit tests
- 見 `tests/templates.test.js`（測試腳本）

**驗收：** 模板匹配 tests pass + 遷移腳本 dry run 確認結果正確。

---

## Phase C：git hooks（L1 + L5）

**產出：** `hooks/ownmind-git-pre-commit.js`、`hooks/ownmind-git-post-commit.js`

### C1. 實作 git pre-commit hook（L1）
- 收集 git context：staged files、commit message、changed source files
- 讀取 `~/.ownmind/cache/iron_rules.json`
- 讀取 `~/.ownmind/logs/compliance.jsonl`
- 篩選 trigger 含 commit 的鐵律
- 跑 evaluateConditions()
- block_on_fail 失敗 → exit 1 + 輸出失敗原因
- 全部通過 → exit 0

### C2. 實作 git post-commit hook（L5）
- 讀取最近 commit 資訊
- 跑 verification 檢查
- 違規 → 寫入 JSONL（post_commit_violation）
- 輸出警告（不回滾）

### C3. 建立 shell wrapper
- `~/.ownmind/git-hooks/pre-commit` — 呼叫 Node.js + chain 原有 hook
- `~/.ownmind/git-hooks/post-commit` — 同上

### C4. 寫整合測試
- 見 `tests/git-hooks.test.js`（測試腳本）

**驗收：** mock 環境下 pre-commit 正確 block/allow + post-commit 正確記錄 violation。

---

## Phase D：PreToolUse hook 改造（L2）

**產出：** 修改 `hooks/ownmind-iron-rule-check.js`

### D1. 移除 IR-008 硬編碼邏輯
- 刪除 bash/js 中的 staged files 硬編碼檢查
- IR-008 改由 verification engine 處理

### D2. commit 操作：不重複 block
- commit 觸發時只輸出提醒文字，不 block（L1 負責）

### D3. deploy/delete 操作：新增 verification
- 讀本地快取 + JSONL
- 跑 evaluateConditions()
- 失敗 → `{"decision": "block"}`

### D4. 同步更新 bash 版
- `hooks/ownmind-iron-rule-check.sh` 同步改動

**驗收：** deploy 操作正確 block + commit 操作不重複 block。

---

## Phase E：MCP 改動（L3 + L6）

**產出：** 修改 `mcp/index.js`

### E1. report_compliance 寫入 JSONL
- 每次呼叫寫入 `~/.ownmind/logs/compliance.jsonl`
- 含 event（自動推導）、action、rule_code、ts、session_id

### E2. event 自動推導
- 優先用 `metadata.verification.compliance_event`
- fallback 用 rule_code
- 不靠自然語言解析

### E3. report_compliance 自動驗證（L3）
- 偵測 context 是否表明即將執行觸發操作
- 是 → 跑 evaluateConditions()
- 失敗 → 回傳 `status: 'blocked'` + failures

### E4. init 時同步本地快取
- 把有 verification 的鐵律寫入 `~/.ownmind/cache/iron_rules.json`

### E5. session 結束稽核（L6）
- ownmind_log_session handler 新增 auditSession()
- 比對 git log 和 complianceEvents
- 違規 → 自動記錄到 JSONL + activity_logs
- 稽核結果寫入 session log details

### E6. enforcement_alerts 查詢擴充（L7）
- `src/routes/memory.js` init endpoint
- WHERE 條件加入 `session_audit_violation` event

**驗收：** JSONL 正確寫入 + 自動驗證回傳 blocked + session 稽核正確偵測違規 + enforcement_alerts 含 L6 違規。

---

## Phase F：安裝流程 + 遷移

**產出：** 修改 `install.sh`、`install.ps1`

### F1. install.sh 更新
- 建目錄：shared/、cache/、logs/、git-hooks/
- 複製 verification.js 到 shared/
- 複製 git hook js 到 hooks/
- 生成 shell wrapper 到 git-hooks/
- `git config --global core.hooksPath ~/.ownmind/git-hooks`
- Chain 原有 hook 機制

### F2. install.ps1 更新
- Windows 版同樣邏輯
- git hooks 用 Node.js 執行

### F3. 執行遷移腳本
- 部署後跑 `scripts/migrate-verification.js`
- 確認 IR-008、IR-002、IR-012、IR-009 正確遷移

**驗收：** 全新環境安裝後 git hooks 正確運作 + 現有鐵律遷移完成。

---

## Phase G：Dashboard + 文件更新

### G1. Dashboard 鐵律標記
- admin.html 鐵律列表：有 verification → `[自動驗證]` 標籤 + 觸發類型

### G2. Skill 更新
- `skills/ownmind-memory.md` 新增 enforcement engine 行為指示

### G3. README / CHANGELOG / FILELIST 更新
- IR-008 規定必須同步

### G4. 版本號更新
- package.json → 1.11.0
- SERVER_VERSION → 1.11.0

**驗收：** Dashboard 正確顯示 + 文件同步 + 版本號一致。

---

## 依賴關係

```
A（Engine）→ B（模板）→ F3（遷移）
A（Engine）→ C（git hooks）→ F1/F2（安裝）
A（Engine）→ D（PreToolUse）
A（Engine）→ E（MCP）
所有 → G（文件）
```

Phase A 必須先完成。B/C/D/E 可平行進行（都依賴 A 但互不依賴）。F 和 G 最後。

---

## 部署計畫

1. 本地開發 + 測試全 pass
2. `docker compose build --no-cache api && docker compose up -d --force-recreate api`
3. 跑遷移腳本：`docker exec -it ownmind-api node scripts/migrate-verification.js`
4. 確認 init API 回傳已遷移鐵律的 verification
5. 部署後瀏覽器實測 Dashboard
6. 本地重新安裝測試 git hooks
