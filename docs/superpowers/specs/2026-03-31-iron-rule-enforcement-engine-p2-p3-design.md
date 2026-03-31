# OwnMind 鐵律執行引擎 — 第二階段 + 第三階段 設計文件

- 日期：2026-03-31
- 版本：v1.11.0（目標）
- 作者：Vin
- 前置：v1.10.0 Adaptive Iron Rule Reinforcement（第一階段，已上線）

---

## 四大核心理念

本設計的所有決策必須通過以下四項檢驗，違反任一項即需重新設計：

1. **永不信賴 LLM 會乖乖聽話** — 所有關鍵檢查點必須是強制性攔檢機制，在 AI 無法繞過的層級執行。能用 harness block 就不靠指令提醒。
2. **不依賴單一機制** — 使用者用各種 AI 工具（Claude Code、Cursor、Windsurf、Copilot...），防禦必須多層堆疊，每層獨立運作。能擋就擋，擋不住就記錄，記錄完下次加壓。
3. **使用者裝後即忘** — 鐵律建立後自動匹配檢查模板、git hooks 自動設定、驗證自動執行、違反自動記錄升級。使用者和 AI 都不需要額外操作。
4. **事後補救永遠存在** — 即使攔檢被繞過，系統仍有事後稽核機制自動偵測違規。違反不會消失，只會累積施壓。

---

## 背景

v1.10.0 完成了第一階段：enforcement_alerts 在 init 時分析 30 天 compliance 歷史，產生分級提醒（critical/warning/notice），注入 session 開始時的系統提示。

但第一階段只能「提醒」，不能「攔截」。AI 看到提醒後是否遵守，完全靠自律。本階段的目標是把「提醒」升級為「強制攔檢 + 自動驗證 + 事後稽核」。

---

## 範圍

### 包含

- Verification Engine：純 Node.js 模組，評估鐵律的可驗證條件
- 七層防禦架構：git hook（L1/L5）、PreToolUse hook（L2）、MCP（L3）、Init（L4）、Session 稽核（L6）、升級警告（L7）
- 規則模板庫：Server 端自動匹配，使用者建鐵律時自動填入 verification 條件
- Session compliance tracking：MCP 端記錄合規事件到本地 JSONL，git hook 讀取驗證
- 現有鐵律遷移：IR-008、IR-002、IR-012、IR-009 自動加上 verification
- 安裝腳本更新：自動設定 git hooks

### 不包含

- Server 端 session state API（YAGNI，MCP 本地夠用）
- 合規分數機制（二元 pass/fail 更清楚）
- Dashboard 模板選擇器 / verification 編輯器（裝後即忘，不需要手動編輯）
- `ownmind_list_templates` MCP tool（模板自動匹配，不暴露）
- 自訂腳本檢查（安全風險，預定義 check types 夠用）
- auto-revert commit（太危險會丟程式碼）

---

## 架構

### 七層防禦總覽

```
┌─────────────────────────────────────────────────┐
│           事前攔截（Pre-Action Block）              │
├─────────────────────────────────────────────────┤
│ L1  git pre-commit hook                         │
│     → 所有 git 工具，harness 層 block            │
│     → 讀本地快取 + JSONL 驗證合規記錄             │
│     → exit 1 = git 拒絕 commit                  │
│                                                  │
│ L2  Claude Code PreToolUse hook                  │
│     → Claude Code 限定，harness 層 block          │
│     → 涵蓋非 git 操作（deploy、delete）           │
│     → {"decision":"block"} = 工具無法執行          │
│                                                  │
│ L3  MCP report_compliance 自動驗證               │
│     → 所有 MCP 工具                              │
│     → 嵌入現有流程，不加新 tool                   │
│     → 中等強制力（靠 AI 服從回傳結果）              │
│                                                  │
│ L4  Init 指令注入（enforcement_alerts）           │
│     → 所有工具                                   │
│     → Session 開始時注入系統提示                   │
│     → 最弱（靠 AI 自律）但覆蓋最廣                │
├─────────────────────────────────────────────────┤
│           事後補救（Post-Action Audit）             │
├─────────────────────────────────────────────────┤
│ L5  git post-commit hook                         │
│     → commit 後即時稽核                           │
│     → 未合規 → 記錄 violation                     │
│     → 注意：--no-verify 會跳過 L5                 │
│                                                  │
│ L6  Session 結束稽核                              │
│     → ownmind_log_session 時自動比對              │
│     → 動作 vs 合規記錄不符 → 自動記錄 violation    │
│     → --no-verify 的最後防線                      │
│                                                  │
│ L7  下次 Init 升級警告                            │
│     → enforcement_alerts 根據歷史違反率升級         │
│     → 累積施壓，同樣的錯越來越難再犯               │
│     → 已有機制，本次擴充查詢範圍                   │
└─────────────────────────────────────────────────┘
```

### 各平台覆蓋矩陣

| 平台 | L1 git | L2 PreTool | L3 MCP | L4 Init | L5 post | L6 Session | L7 升級 |
|------|:------:|:----------:|:------:|:-------:|:-------:|:----------:|:-------:|
| Claude Code | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cursor | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Windsurf | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 其他 MCP 工具 | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 無 MCP 工具 | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |

### 檔案架構

```
~/.ownmind/
  shared/
    verification.js              ← 引擎核心，純函式，三處共用
  hooks/
    ownmind-git-pre-commit.js    ← L1 git pre-commit hook
    ownmind-git-post-commit.js   ← L5 git post-commit hook
  git-hooks/
    pre-commit                   ← shell wrapper，呼叫 ownmind-git-pre-commit.js
    post-commit                  ← shell wrapper，呼叫 ownmind-git-post-commit.js
  cache/
    iron_rules.json              ← init 時從 Server 同步的可驗證鐵律
  logs/
    compliance.jsonl             ← MCP report_compliance 時寫入的合規事件

Server 端（/VinService/ownmind/）:
  src/utils/templates.js         ← 規則模板庫 + 自動匹配邏輯
  scripts/migrate-verification.js ← 一次性遷移腳本
```

---

## 詳細規格

### 1. Verification Schema

鐵律的 `metadata.verification` 結構：

```jsonc
{
  "verification": {
    "mode": "pre_action",
    "trigger": ["commit"],
    "block_on_fail": true,
    "compliance_event": "code-review",
    "conditions": {
      "operator": "AND",
      "checks": [
        {
          "type": "staged_files_include",
          "params": { "patterns": ["README.md", "CHANGELOG.md"] },
          "message": "程式碼有改但 README/CHANGELOG 未同步"
        },
        {
          "type": "recent_event_exists",
          "params": { "event": "code-review", "action": "comply" },
          "message": "還沒做 code review"
        }
      ]
    }
  }
}
```

欄位說明：

| 欄位 | 類型 | 說明 |
|------|------|------|
| `mode` | string | 固定 `"pre_action"` |
| `trigger` | string[] | 哪些觸發點要檢查：`"commit"`, `"deploy"`, `"delete"` |
| `block_on_fail` | boolean | 檢查失敗時阻擋（true）還是只警告（false） |
| `compliance_event` | string | 此鐵律的 comply 事件對應名稱，用於 `recent_event_exists` 查詢 |
| `conditions` | object | 檢查條件，支援巢狀 AND/OR |

不新增 DB 欄位。verification 存在現有 `metadata` JSONB 欄位內。

### 2. 預定義檢查類型（Check Types）

| type | 用途 | params | 執行環境 |
|------|------|--------|----------|
| `staged_files_include` | staged 檔案必須包含指定 pattern | `{ patterns: string[] }` | git context |
| `staged_files_exclude` | staged 檔案不能包含指定 pattern | `{ patterns: string[] }` | git context |
| `commit_message_contains` | commit message 必須包含 | `{ patterns: string[] }` | git context |
| `commit_message_not_contains` | commit message 不能包含 | `{ patterns: string[] }` | git context |
| `recent_event_exists` | session 內必須有某個 comply 記錄 | `{ event: string, action: string }` | JSONL |
| `source_files_changed` | 特定原始碼是否被修改 | `{ patterns: string[] }` | git context |

條件支援 AND/OR 巢狀組合：

```jsonc
{
  "operator": "AND",
  "checks": [
    { "type": "...", "params": {} },
    {
      "operator": "OR",
      "checks": [
        { "type": "...", "params": {} },
        { "type": "...", "params": {} }
      ]
    }
  ]
}
```

條件支援 `when/then`（條件式觸發）：

```jsonc
{
  "when": {
    "type": "source_files_changed",
    "params": { "patterns": ["src/**"] }
  },
  "then": {
    "type": "staged_files_include",
    "params": { "patterns": ["README.md"] },
    "message": "程式碼有改但 README 未同步"
  }
}
```

語意：`when` 為 false → 整體 pass（條件不適用）。`when` 為 true → 評估 `then`。
用途：表達「如果 A 發生，那 B 必須滿足」，例如 IR-008「如果原始碼有改，文件必須同步」。

### 3. Verification Engine

位置：`shared/verification.js`

純函式模組，零外部依賴，不綁定任何執行環境。被 git hook、PreToolUse hook、MCP 三處共用。

**核心 API：**

```javascript
evaluateConditions(conditions, context) → { pass: boolean, failures: string[] }

// when/then 支援：
// 遇到 conditions.when → 先評估 when
//   when 為 false → { pass: true, failures: [] }（條件不適用）
//   when 為 true → 評估 conditions.then
```

**context 物件：**

```javascript
{
  stagedFiles: string[],          // git context
  changedSourceFiles: string[],   // git context
  commitMessage: string,          // git context
  complianceEvents: Array<{       // 從 JSONL 讀取
    event: string,
    action: string,
    ts: string
  }>
}
```

**context 缺失行為：**
- 大多數 handler：context 欄位缺失時 `return true`（跳過檢查）
- `source_files_changed`：context 缺失時 `return false`（語義為「有原始碼被改嗎？」，不確定時不觸發後續 AND）
- 設計目的：git hook 有 git context 但不一定有 complianceEvents，MCP 有 complianceEvents 但不一定有 git context，**兩層互補不誤擋**

### 4. git pre-commit hook（L1）

位置：`~/.ownmind/hooks/ownmind-git-pre-commit.js`

流程：
1. 收集 git context：`git diff --cached --name-only`、commit message、changed source files
2. 讀取本地 JSONL（`~/.ownmind/logs/compliance.jsonl`）取得 session compliance events
3. 讀取本地快取（`~/.ownmind/cache/iron_rules.json`）取得可驗證鐵律
4. 篩選 `trigger` 包含 `"commit"` 的鐵律
5. 對每條跑 `evaluateConditions()`
6. 任一 `block_on_fail: true` 的鐵律未通過 → `exit 1`（git 拒絕 commit）
7. 全部通過 → `exit 0`

失敗輸出格式：
```
【OwnMind 鐵律檢查】commit 被擋下：
  ❌ IR-008: 程式碼有改但 CHANGELOG 未同步
  ❌ IR-012: 還沒做 code review
請先完成上述步驟再 commit。
```

零網路依賴：所有資料從本地檔案讀取。

### 5. git post-commit hook（L5）

位置：`~/.ownmind/hooks/ownmind-git-post-commit.js`

流程：
1. 讀取剛完成的 commit 資訊（`git log -1 --name-only`）
2. 跑同樣的 verification 檢查
3. 違規 → 寫入 JSONL（`event: 'post_commit_violation', action: 'violate'`）
4. 輸出警告訊息（不回滾）

注意：`--no-verify` 會跳過所有 git hooks（包含 post-commit），此場景由 L6 補救。

### 6. Claude Code PreToolUse hook（L2）

位置：`hooks/ownmind-iron-rule-check.js`（現有檔案改造）

改動：
1. 移除 IR-008 硬編碼邏輯（已遷移到 verification engine）
2. commit 操作：不重複 block（由 L1 負責），僅輸出提醒文字
3. deploy/delete 操作：讀本地快取 + JSONL → 跑 verification engine → block/allow

L1 和 L2 分工：

| 操作 | L1 git hook | L2 PreToolUse |
|------|:-----------:|:-------------:|
| git commit | ✅ 負責 block | 提醒，不重複 block |
| git push（deploy） | ❌ 無 hook | ✅ 負責 block |
| docker deploy | ❌ 非 git | ✅ 負責 block |
| rm -rf（delete） | ❌ 非 git | ✅ 負責 block |

### 7. MCP 層（L3）

位置：`mcp/index.js`（現有檔案改動）

#### 7a. report_compliance 自動驗證

在 `ownmind_report_compliance` handler 內新增邏輯：記錄合規事件後，如果 `context` 參數包含已定義的觸發關鍵字（`"commit"`、`"deploy"`、`"delete"`），自動跑 verification engine 檢查該觸發類型的所有可驗證鐵律。例如 `context: "準備 commit"` 命中 `"commit"` 關鍵字。

回傳結構新增：
```javascript
{
  status: 'blocked',        // 新增狀態
  verification_failures: [{ rule: 'IR-012', messages: ['還沒做 code review'] }],
  message: '以下前置條件未滿足...'
}
```

強制力為中等：靠 AI 服從回傳結果。真正的 block 由 L1/L2 負責。

#### 7b. compliance JSONL 寫入

`report_compliance` 每次呼叫時同步寫入 `~/.ownmind/logs/compliance.jsonl`：

```jsonc
{
  "event": "code-review",      // 自動推導（見 7c）
  "action": "comply",
  "rule_code": "IR-012",
  "rule_title": "軟體開發品管三步驟",
  "ts": "2026-03-31T10:00:00.000Z",
  "session_id": "abc123"
}
```

此 JSONL 是 L1 git hook 驗證前置依賴的資料來源。

#### 7c. event 自動推導

不靠自然語言解析 rule_title。優先使用鐵律 `metadata.verification.compliance_event`，Server 模板匹配時自動填好。fallback 用 `rule_code`。

```javascript
function deriveEvent(rule_title, rule_code) {
  const rule = getCachedRule(rule_code);
  if (rule?.metadata?.verification?.compliance_event) {
    return rule.metadata.verification.compliance_event;
  }
  return rule_code || rule_title;
}
```

#### 7d. init 時同步本地快取

`ownmind_init` handler 末尾新增：把有 verification 的鐵律寫入 `~/.ownmind/cache/iron_rules.json`，供 git hook 讀取。

### 8. Session 結束稽核（L6）

位置：`mcp/index.js`（ownmind_log_session handler）

流程：
1. 從 git log 取得本 session 時間範圍內的 commits
2. 從 complianceEvents 取得本 session 的合規記錄
3. 對每個 commit 檢查 `recent_event_exists` 類型的前置依賴
4. 違規 → 自動寫入 compliance JSONL + activity_logs，不需要 AI 回報

場景覆蓋：

| 場景 | L1 | L6 |
|------|:--:|:--:|
| 正常 commit | L1 通過 | L6 通過 |
| `--no-verify` commit，沒做 review | L1 跳過 | **L6 抓到** |
| AI 完全沒呼叫 report_compliance | L1 擋住 | L6 也會抓 |
| AI 謊報 comply | L1 通過 | L6 通過（無法區分真假，已知限制） |

稽核結果自動寫入 session log 的 details：
```jsonc
{
  "session_audit": {
    "commits_checked": 3,
    "violations_found": 1,
    "violations": [{ "rule_code": "IR-012", "commit_hash": "abc123", "failures": ["還沒做 code review"] }]
  }
}
```

### 9. Init 升級警告擴充（L7）

現有 `computeEnforcementAlerts` 查 `event = 'iron_rule_compliance'`。

擴充：同時查 `event = 'session_audit_violation'`，讓 L6 的稽核結果也納入升級計算。

```sql
WHERE event IN ('iron_rule_compliance', 'session_audit_violation')
  AND details->>'action' = 'violate'
```

### 10. 規則模板庫

位置：`src/utils/templates.js`（Server 端）

模板是 Server 內部邏輯，不暴露給 AI 或使用者。

**預定義模板：**

| 模板 ID | 名稱 | 匹配條件 | verification 效果 |
|---------|------|---------|-------------------|
| `commit_sync_docs` | Commit 前同步文件 | triggers 含 commit + 內容含「同步/README/CHANGELOG/FILELIST/文件」 | source_files_changed AND staged_files_include |
| `commit_no_secrets` | Commit 不含敏感檔案 | triggers 含 commit + 內容含「.env/密碼/secret/credential」 | staged_files_exclude |
| `qa_three_steps` | 品管三步驟 | triggers 含 commit + 內容含「品管/三步驟/review/verification」 | recent_event_exists(verification) AND recent_event_exists(code-review) |
| `deploy_requires_test` | 部署前跑測試 | triggers 含 deploy + 內容含「測試/test」 | recent_event_exists(test-pass) |
| `commit_contributor` | Git contributor 控制 | triggers 含 commit + 內容含「contributor/Co-Authored/author」 | commit_message_not_contains(Co-Authored-By) |

**自動匹配流程：**

GIVEN 使用者建立鐵律（ownmind_save, type=iron_rule）
WHEN Server 收到請求且鐵律有 trigger tags
THEN Server 掃描 RULE_TEMPLATES，用 triggers + keywords 匹配
AND 命中 → 自動填入 metadata.verification
AND 回傳含 matched_template 欄位
AND AI 告知使用者套了什麼模板

GIVEN 模板匹配不到
WHEN 鐵律的 tags/content 不符合任何模板
THEN 鐵律正常建立，無 verification → 純提醒型

### 11. 現有鐵律遷移

一次性 migration script（`scripts/migrate-verification.js`）：

| 鐵律 | 匹配模板 | verification 效果 |
|------|---------|-------------------|
| IR-008 同步文件 | `commit_sync_docs` | source_files_changed → staged_files_include |
| IR-002 不 commit .env | `commit_no_secrets` | staged_files_exclude(.env, *.pem, *.key) |
| IR-012 品管三步驟 | `qa_three_steps` | recent_event_exists(verification) AND recent_event_exists(code-review) |
| IR-009 contributor | `commit_contributor` | commit_message_not_contains(Co-Authored-By) |

冪等設計：重複跑不覆蓋已有 verification。結果寫入 activity_logs 供稽核。

### 12. 安裝流程更新

install.sh / install.ps1 新增：

1. 建立目錄：`~/.ownmind/shared/`、`~/.ownmind/cache/`、`~/.ownmind/logs/`、`~/.ownmind/git-hooks/`
2. 部署 verification engine：`shared/verification.js`
3. 部署 git hooks：`ownmind-git-pre-commit.js`、`ownmind-git-post-commit.js` + shell wrapper
4. 設定 global git hooks path：`git config --global core.hooksPath ~/.ownmind/git-hooks`
5. Shell wrapper chain 原有 hook：如果 `.git/hooks/pre-commit` 存在，OwnMind 檢查完後接著執行

### 13. Dashboard 改動

鐵律列表新增標記：
- 有 `metadata.verification` → 顯示 `[自動驗證]` 標籤 + 觸發類型
- 無 → 維持現狀（純提醒型）

不做模板選擇器 UI、不做 verification 編輯器。

---

## GIVEN/WHEN/THEN 場景

### S1：正常 commit，前置依賴都滿足

```
GIVEN IR-012（品管三步驟）已設定 verification
  AND AI 已呼叫 report_compliance(verification, comply)
  AND AI 已呼叫 report_compliance(code-review, comply)
WHEN AI 執行 git commit
THEN L1 git pre-commit hook 讀取 JSONL
  AND 找到 verification comply + code-review comply
  AND evaluateConditions 回傳 pass
  AND commit 正常執行
```

### S2：commit 但沒做 code review

```
GIVEN IR-012 已設定 verification
  AND AI 已呼叫 report_compliance(verification, comply)
  AND AI 未呼叫 report_compliance(code-review, comply)
WHEN AI 執行 git commit
THEN L1 git pre-commit hook 讀取 JSONL
  AND 找不到 code-review comply
  AND evaluateConditions 回傳 fail
  AND hook exit 1
  AND git 拒絕 commit
  AND 輸出「❌ IR-012: 還沒做 code review」
```

### S3：AI 用 --no-verify 繞過

```
GIVEN AI 執行 git commit --no-verify
THEN L1 和 L5 都被跳過
WHEN Session 結束，AI 呼叫 ownmind_log_session
THEN L6 比對 git log 和 complianceEvents
  AND 發現 commit 但沒有 code-review comply
  AND 自動記錄 violation 到 JSONL + activity_logs
WHEN 下次 session init
THEN L7 enforcement_alerts 升級此鐵律的嚴重等級
```

### S4：deploy 操作被 L2 攔截

```
GIVEN 有鐵律「部署前跑測試」，trigger 含 deploy
  AND AI 未呼叫 report_compliance(test-pass, comply)
WHEN AI 在 Claude Code 執行 docker compose up
THEN L2 PreToolUse hook 偵測到 deploy 觸發
  AND 讀取快取 + JSONL
  AND evaluateConditions 回傳 fail
  AND 回傳 {"decision": "block"}
  AND Claude Code 阻止工具執行
```

### S5：Cursor 使用者建鐵律

```
GIVEN 使用者在 Cursor 說「記起來：commit 前要跑測試和 code review」
WHEN AI 呼叫 ownmind_save(type: iron_rule, tags: [trigger:commit])
THEN Server 自動匹配 qa_three_steps 模板
  AND 填入 metadata.verification
  AND 回傳 matched_template: "qa_three_steps"
  AND AI 告知使用者「已套用品管三步驟檢查模板」
  AND 後續 commit 由 L1 git hook 自動攔檢
```

### S6：IR-008 遷移後行為

```
GIVEN IR-008 已遷移，verification 條件為 when/then：
  WHEN source_files_changed(["src/**", "mcp/**", "hooks/**"])
  THEN staged_files_include(["README.md", "CHANGELOG.md", "FILELIST.md"])
WHEN AI 修改 src/routes/memory.js 並 staged
  AND 未 stage README.md
THEN L1 evaluateConditions:
  when: source_files_changed → true（有 src/** 檔案被改）
  then: staged_files_include → false（README.md 未 staged）
  → fail
THEN git 拒絕 commit，輸出「❌ IR-008: 程式碼有改但 README 未同步」
```

### S6b：IR-008 只改文件不改程式碼

```
GIVEN IR-008 條件同 S6
WHEN AI 只修改 docs/guide.md 並 staged（沒有改 src/**/mcp/**/hooks/**）
THEN L1 evaluateConditions:
  when: source_files_changed → false（沒有原始碼被改）
  → 整體 pass（條件不適用）
THEN commit 正常執行
```

### S7：鐵律匹配不到模板

```
GIVEN 使用者建立鐵律「SSH 不要頻繁登入登出」，tags: [trigger:ssh]
WHEN Server 掃描模板
  AND 沒有模板的 match.triggers 含 ssh
THEN 鐵律正常建立，無 verification
  AND 此鐵律維持純提醒型
```

---

## 已知限制

1. **AI 可以謊報 comply** — `report_compliance(action: "comply")` 不保證 AI 真的做了對應動作。系統無法驗證「code review 是否真的發生」。透過稽核軌跡事後追查是唯一補救。
2. **`--no-verify` 繞過 L1 和 L5** — git 的設計限制。L6 session 結束稽核是最後防線，但如果 AI 也不呼叫 `ownmind_log_session`（例如進程被強制終止），則只剩 MCP emergency recovery 機制（已有）。
3. **模板匹配可能不精確** — 基於 trigger tags + keywords 的匹配有誤判風險。透過回傳 `matched_template` 讓 AI 告知使用者來緩解。
4. **非 git 操作只有 L2 能擋** — deploy、delete 等操作沒有 git hook 可用。非 Claude Code 平台只剩 L3（MCP）和 L4（Init），強制力較弱。
