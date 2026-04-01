# Harness Engineering 審計修復設計

> 日期：2026-04-01
> 範圍：OwnMind 鐵律執行引擎的 6 項架構問題修復
> 版本影響：MCP v1.14.0 → v1.15.0

## 背景

對 `~/.ownmind/` 的 harness engineering 審計發現 6 項問題：
1. 周邊邏輯重複 4 處（readComplianceEvents 等）
2. Compliance 日誌格式不一致 + 檔案分散
3. 快取無同步機制（save/update 鐵律後快取不更新）
4. fail-open 設計（verification 不可用時靜默放行）
5. L2 對 commit 不攔截 + L6 lazy load 可能跳過
6. 觸發正則不精準（substring match 誤判）

另外 hooks 有 ESM/CJS 混用，統一為 ESM。

## 決策記錄

| 決策 | 選項 | 理由 |
|------|------|------|
| Module system | 全部 ESM | pre-commit/post-commit 已是 ESM，Windows Node 18+ 支援 |
| Fail policy | L1 fail-closed，其餘 fail-open | 平衡安全與流暢度 |
| L2 commit blocking | 啟用 | 防止 --no-verify 繞過 L1 |

---

## S1: shared/helpers.js — 消除周邊邏輯重複

### 問題

以下函式在 4 個檔案中重複實作：

| 函式 | 出現位置 |
|------|---------|
| `readComplianceEvents()` | pre-commit.js, post-commit.js, iron-rule-check.js, verify-trigger.js |
| `readJsonSafe()` | pre-commit.js, post-commit.js |
| `SOURCE_PATTERNS` + `getChangedSourceFiles()` | pre-commit.js, post-commit.js |
| VERSION 讀取 | pre-commit.js, post-commit.js, iron-rule-check.js |

### 設計

新增 `shared/helpers.js`，純函式、零外部依賴、ESM export：

```
export const SOURCE_PATTERNS = [/^src\//, /^mcp\//, /^hooks\//, /^shared\//];

export function readJsonSafe(filePath) → object | null
export function getChangedSourceFiles(files, patterns?) → string[]
export function getClientVersion() → string
```

`readComplianceEvents` 移到 `shared/compliance.js`（見 S2）。

### 受影響檔案

- `hooks/ownmind-git-pre-commit.js` — 刪除重複函式，改 import
- `hooks/ownmind-git-post-commit.js` — 同上
- `hooks/ownmind-iron-rule-check.js` — 刪除 VERSION 邏輯，改 import
- `hooks/ownmind-verify-trigger.js` — 刪除重複函式，改 import

---

## S2: shared/compliance.js — Compliance 格式統一

### 問題

三個問題：
1. **格式不一致**：MCP 用 `{event, action, rule_code, rule_title, ts, session_id}`，post-commit 用 `{event: 'post_commit_violation', ..., commit_hash, failures}`，欄位名不統一
2. **檔案分散**：MCP 寫 `compliance.jsonl`，PreToolUse hook 寫 `{date}.jsonl`
3. **event 值不匹配**：`deriveEvent()` 可能回傳自訂 compliance_event 值，但 `recent_event_exists` checker 期望匹配的是不同的值，導致驗證靜默失敗

### 設計

新增 `shared/compliance.js`，統一 schema 和讀寫：

#### 統一 Schema

```js
{
  ts: string,           // ISO 8601
  event: string,        // 一律用 rule_code（如 'IR-008'），砍掉 deriveEvent()
  action: 'comply' | 'skip' | 'violate',
  rule_code: string,
  rule_title: string,
  source: 'mcp' | 'pre_commit' | 'post_commit' | 'session_audit' | 'hook',
  session_id?: string,
  commit_hash?: string,
  failures?: string[],
}
```

#### 導出函式

```js
export function appendCompliance(entry) → void
// 寫入 ~/.ownmind/logs/compliance.jsonl，自動補 ts

export function readComplianceEvents(cutoffMs = 24h) → ComplianceEntry[]
// 讀 compliance.jsonl，過濾近 N 毫秒事件
```

#### 關鍵修復

1. **砍掉 `deriveEvent()`**（mcp/index.js:34-41）：`event` 欄位一律用 `rule_code`
2. **MCP in-memory `complianceEvents`**：`rule` field 改名為 `rule_title`，和 JSONL 一致
3. **PreToolUse hook** 的 compliance log 也走 `appendCompliance()`，不再寫到 `{date}.jsonl`
4. **所有寫入方**統一用 `appendCompliance()`：MCP report_compliance、post-commit、session audit

### 受影響檔案

- 新增 `shared/compliance.js`
- `mcp/index.js` — 刪除 `deriveEvent()`，report_compliance 改用 `appendCompliance()`，`complianceEvents` field rename
- `hooks/ownmind-git-post-commit.js` — `appendComplianceLog()` 改用 `appendCompliance()`
- `hooks/ownmind-git-pre-commit.js` — `readComplianceEvents()` 改 import
- `hooks/ownmind-iron-rule-check.js` — compliance log 改走 `appendCompliance()`
- `hooks/ownmind-verify-trigger.js` — `readComplianceEvents()` 改 import

---

## S3: 快取同步機制

### 問題

`iron_rules.json` 快取只在 `ownmind_init` 時寫入。save/update/disable 鐵律後，hooks 讀到的快取是過時的。

### 設計

#### MCP 側：save/update/disable 後刷新快取

```js
async function refreshIronRulesCache() {
  const rules = await callApi('GET', '/api/memory/type/iron_rule');
  const verifiable = rules.filter(r => r.metadata?.verification);
  cachedVerifiableRules = verifiable;
  fs.writeFileSync(CACHE_PATH, JSON.stringify(verifiable, null, 2));
}
```

觸發時機：
- `ownmind_save` — 當 `args.type === 'iron_rule'` 時
- `ownmind_update` — 回傳的資料若 type 為 iron_rule 時
- `ownmind_disable` — 同上
- `ownmind_init` — 維持現有邏輯（從 init response 取）

#### Hook 側：快取 staleness 檢查

`pre-commit.js` 在讀快取時加 mtime 檢查：

```
GIVEN 快取檔案 mtime 超過 24 小時
AND credentials 可用
WHEN pre-commit hook 執行
THEN 嘗試 HTTP GET /api/memory/type/iron_rule（3s timeout）
  成功 → 寫入快取，用新規則繼續
  失敗 → 用舊快取繼續（不 block）
```

### 受影響檔案

- `mcp/index.js` — 新增 `refreshIronRulesCache()`，在 save/update/disable handler 呼叫
- `hooks/ownmind-git-pre-commit.js` — 加 mtime 檢查 + best-effort refresh

---

## S4: L1 fail-closed + L2 commit blocking + L6 修復

### S4a: L1 pre-commit fail-closed

#### 問題

快取為空或 verification.js import 失敗時，直接 `process.exit(0)` 靜默放行。

#### 設計

```
GIVEN 快取為空或不存在
WHEN pre-commit hook 執行
THEN
  1. 嘗試讀 credentials（~/.claude/settings.json 的 mcpServers.ownmind.env）
  2. 有 credentials → HTTP GET iron_rules（3s timeout）
     成功 → 寫入快取，繼續檢查
     失敗 → 放行（真的沒辦法）
  3. 無 credentials → 放行

GIVEN verification.js import 失敗
WHEN pre-commit hook 執行
THEN 輸出警告訊息「⚠️ 驗證引擎不可用，跳過檢查」，放行
（不再靜默）
```

注意：credentials 讀取邏輯從 iron-rule-check.js 抽取到 `shared/helpers.js` 的 `readCredentials()` 共用。

### S4b: L2 PreToolUse commit blocking

#### 問題

`iron-rule-check.js:187` 對 commit trigger 只提醒不攔。

#### 設計

移除 commit 的特殊放行邏輯。所有 trigger（commit/deploy/delete）都走同一套：

```
GIVEN PreToolUse hook 偵測到 git commit
WHEN 快取中有 block_on_fail 規則
THEN 跑 verification engine
  有 blocking failure → { decision: 'block' }
  全部通過 → 只顯示提醒
```

具體修改：刪除 `if (trigger === 'deploy' || trigger === 'delete')` 的條件判斷，讓 commit 也進入 verification 分支。

### S4c: L6 session audit lazy load 修復

#### 問題

`auditSession()` 在 `mcp/index.js:92` 檢查 `if (!evaluateConditions)` — 如果 lazy load 未完成，直接回 0 violations。

#### 設計

`auditSession()` 改為 async，開頭先 `await getEvaluateConditions()`：

```js
async function auditSession() {
  const evalFn = await getEvaluateConditions();
  if (!evalFn) return { commits_checked: 0, violations_found: 0, violations: [], error: 'verification engine unavailable' };
  // ... 後續邏輯用 evalFn 取代 evaluateConditions
}
```

呼叫方 `ownmind_log_session` 已經是 async context，不需改。

### 受影響檔案

- `hooks/ownmind-git-pre-commit.js` — 快取為空時嘗試 API fetch + import 失敗時輸出警告
- `hooks/ownmind-iron-rule-check.js` — commit trigger 也走 verification blocking
- `mcp/index.js` — `auditSession()` 改 async + await getEvaluateConditions()
- `shared/helpers.js` — 新增 `readCredentials()`

---

## S5: 觸發檢測精準度

### 問題

1. PreToolUse hook 用 substring match，`docker.*up` 會誤觸 local dev
2. MCP `detectTriggerFromContext` 用 `includes()`，context 含「沒有 commit 問題」也會觸發
3. 缺少 `git tag`、`Remove-Item` 覆蓋

### 設計

#### PreToolUse hook 正則（iron-rule-check.js）

```js
if (/\bgit\s+(commit|reset|rebase|merge)\b/i.test(command)) trigger = 'commit';
else if (/\bgit\s+push\b/i.test(command)) trigger = 'deploy';
else if (/\bgit\s+tag\b/i.test(command)) trigger = 'commit';
else if (/\b(docker\s+compose\s+(up|build|push)|kubectl\s+apply|npm\s+run\s+deploy)\b/i.test(command)) trigger = 'deploy';
else if (/\b(rm\s+-rf|rmdir|Remove-Item|drop\s+table|DELETE\s+FROM)\b/i.test(command)) trigger = 'delete';
```

變更摘要：
- 全部加 `\b` word boundary
- `git tag` → commit trigger
- `docker.*up` → 明確 `docker compose up`
- 加 `Remove-Item`（PowerShell）
- 移除 `del `（太容易誤判）

#### MCP detectTriggerFromContext（mcp/index.js）

```js
function detectTriggerFromContext(context) {
  if (!context) return null;
  if (/\bcommit\b/i.test(context)) return 'commit';
  if (/\b(deploy|部署)\b/i.test(context)) return 'deploy';
  if (/\b(delete|刪除)\b/i.test(context)) return 'delete';
  return null;
}
```

### 受影響檔案

- `hooks/ownmind-iron-rule-check.js` — 正則替換
- `mcp/index.js` — `detectTriggerFromContext()` 替換

---

## S6: Hooks ESM 統一

### 問題

`iron-rule-check.js` 和 `session-start.js` 用 CJS（require），其餘 hooks 用 ESM（import）。

### 設計

兩個檔案改為 ESM：
- `const fs = require('fs')` → `import fs from 'fs'`
- `const path = require('path')` → `import path from 'path'`
- `const https = require('https')` → `import https from 'https'`
- `const http = require('http')` → `import http from 'http'`
- 內部的 `const os = require('os')` 移到頂層 import

注意：這兩個檔案由 Claude Code hooks 機制執行（settings.json 中的 command），Claude Code hooks 用 `node` 執行 `.js` 檔案，需要確認 hooks 目錄下有 `package.json` 帶 `"type": "module"` 或者檔案改為 `.mjs`。

最簡方案：在 `hooks/` 目錄下新增 `package.json`：
```json
{ "type": "module" }
```

### 受影響檔案

- `hooks/ownmind-iron-rule-check.js` — CJS → ESM
- `hooks/ownmind-session-start.js` — CJS → ESM
- 新增 `hooks/package.json` — `{ "type": "module" }`

---

## 檔案變更總覽

| 檔案 | 動作 | Section |
|------|------|---------|
| `shared/helpers.js` | 新增 | S1, S4a |
| `shared/compliance.js` | 新增 | S2 |
| `hooks/package.json` | 新增 | S6 |
| `shared/verification.js` | 不動 | — |
| `mcp/index.js` | 修改 | S2, S3, S4c, S5 |
| `hooks/ownmind-git-pre-commit.js` | 修改 | S1, S2, S3, S4a |
| `hooks/ownmind-git-post-commit.js` | 修改 | S1, S2 |
| `hooks/ownmind-iron-rule-check.js` | 修改 | S1, S2, S4b, S5, S6 |
| `hooks/ownmind-verify-trigger.js` | 修改 | S1, S2 |
| `hooks/ownmind-session-start.js` | 修改 | S6 |
| `mcp/ownmind-log.js` | 不動 | —（activity log 維持獨立） |

## 測試策略

1. **shared/helpers.js** — 新增 `tests/helpers.test.js`，測試 readJsonSafe、getChangedSourceFiles、getClientVersion
2. **shared/compliance.js** — 新增 `tests/compliance.test.js`，測試 appendCompliance schema 驗證、readComplianceEvents 過濾
3. **verification.js** — 既有測試不動，確保 `recent_event_exists` 和新 compliance event format 匹配
4. **觸發正則** — 新增 `tests/trigger-detection.test.js`，測試正則精準度（word boundary、誤判場景）
5. **整合測試** — 手動測試 pre-commit hook 快取為空 → API fetch → 檢查通過/失敗的完整流程

## 版本

MCP `mcp/package.json` 版本從 1.14.0 bump 到 1.15.0。
