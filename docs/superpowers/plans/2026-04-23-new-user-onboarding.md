# 新用戶自動 Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 偵測到新用戶（profile+principles+iron_rules 全空）時，自動啟動 AI 引導流程，詢問名字/工作後建立 profile 記憶。

**Architecture:** 四層聯動：MCP 發送 `x-ownmind-tool` header → server 偵測新用戶並回傳 `_onboarding` → MCP handler 注入 `_onboarding_instruction` 強制指令 → configs/CLAUDE.md 定義 AI 行為規則。純函式 `buildOnboarding` 抽離到 `src/utils/onboarding.js` 供 route 使用並可獨立測試。

**Tech Stack:** Node.js ESM, node:test, Express route, no new deps.

---

### Task 1：新增 `buildOnboarding` 純函式 + 測試

**Files:**
- Create: `src/utils/onboarding.js`
- Create: `tests/onboarding.test.js`

- [ ] **Step 1：寫失敗測試**

建立 `tests/onboarding.test.js`：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnboarding } from '../src/utils/onboarding.js';

describe('buildOnboarding', () => {
  it('三項全空 → 回傳 onboarding 物件', () => {
    const result = buildOnboarding(null, [], [], 'claude-code');
    assert.ok(result);
    assert.strictEqual(result.is_new_user, true);
    assert.strictEqual(result.detected_tool, 'claude-code');
    assert.ok(typeof result.question === 'string' && result.question.length > 0);
  });

  it('有 profile → 回傳 null', () => {
    const result = buildOnboarding({ id: 1 }, [], [], 'claude-code');
    assert.strictEqual(result, null);
  });

  it('有 principles → 回傳 null', () => {
    const result = buildOnboarding(null, [{ id: 1 }], [], 'claude-code');
    assert.strictEqual(result, null);
  });

  it('有 iron_rules → 回傳 null', () => {
    const result = buildOnboarding(null, [], [{ id: 1 }], 'claude-code');
    assert.strictEqual(result, null);
  });

  it('tool 未傳入 → detected_tool 為 "AI 工具"', () => {
    const result = buildOnboarding(null, [], []);
    assert.strictEqual(result.detected_tool, 'AI 工具');
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
node --test tests/onboarding.test.js 2>&1 | tail -10
```

預期：`Cannot find module '../src/utils/onboarding.js'` 或 5 個 FAIL。

- [ ] **Step 3：建立 `src/utils/onboarding.js`**

```js
export function buildOnboarding(profile, principles, ironRules, tool = 'AI 工具') {
  const isNew = !profile && principles.length === 0 && ironRules.length === 0;
  if (!isNew) return null;
  return {
    is_new_user: true,
    detected_tool: tool,
    question: '你好！我是 OwnMind，你的個人 AI 記憶系統。請問你叫什麼名字，主要做什麼工作？',
  };
}
```

- [ ] **Step 4：執行測試確認全部通過**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
node --test tests/onboarding.test.js 2>&1 | tail -10
```

預期：`pass 5`, `fail 0`, exit code 0。

- [ ] **Step 5：Commit**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
git add src/utils/onboarding.js tests/onboarding.test.js
git commit -m "feat: add buildOnboarding pure function with tests"
```

---

### Task 2：Server route 整合 `buildOnboarding` + `x-ownmind-tool`

**Files:**
- Modify: `src/routes/memory.js`

- [ ] **Step 1：在 `res.json(...)` 之前加入 onboarding 偵測（line ~631）**

在 `src/routes/memory.js` 找到 `res.json({` 之前（line 632），插入：

```js
    // New user onboarding detection
    const detectedTool = req.headers['x-ownmind-tool'] || 'AI 工具';
    const { buildOnboarding } = await import('../utils/onboarding.js');
    const onboarding = buildOnboarding(profile, principles, ironRules, detectedTool);
```

**注意：** `buildOnboarding` 的 import 放在文件頂部更合適。改為在 `src/routes/memory.js` 頂部的 import 區塊加入：

```js
import { buildOnboarding } from '../utils/onboarding.js';
```

然後在 `res.json({` 之前（line ~631）加入：

```js
    const detectedTool = req.headers['x-ownmind-tool'] || 'AI 工具';
    const onboarding = buildOnboarding(profile, principles, ironRules, detectedTool);
```

- [ ] **Step 2：在 `res.json(...)` 內加入 `_onboarding` 欄位**

在 `res.json({...})` 的最後一個欄位（`enforcement_alerts` 之後）加入：

```js
      _onboarding: onboarding,
```

完整 `res.json` 結尾看起來像：

```js
    res.json({
      sync_token: syncToken,
      server_version: SERVER_VERSION,
      // ... 其他欄位不變 ...
      enforcement_alerts: enforcementAlerts,
      _onboarding: onboarding,
    });
```

- [ ] **Step 3：執行全套測試確認無回歸**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
node --test tests/onboarding.test.js tests/session-start-render.test.js 2>&1 | tail -10
```

預期：所有測試 PASS，`fail 0`。

- [ ] **Step 4：Commit**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
git add src/routes/memory.js
git commit -m "feat: return _onboarding flag for new users in /api/memory/init"
```

---

### Task 3：MCP callApi 加入 `x-ownmind-tool` header

**Files:**
- Modify: `mcp/index.js`

- [ ] **Step 1：在 `callApi` 的 headers 物件加入 tool header（line ~293）**

找到 `mcp/index.js` 的 `callApi` 函式（line 291），在 `headers` 物件加入：

```js
async function callApi(method, path, body) {
  const url = `${API_URL}${path}`;
  const headers = {
    "Content-Type": "application/json",
    "x-ownmind-tool": "claude-code",   // ← 新增這行
  };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }
  // ... 其餘不變
```

- [ ] **Step 2：在 `ownmind_init` handler 加入 `_onboarding_instruction`（在 `return data` 之前，約 line 623）**

在 `logEvent(...)` 之後、`return data` 之前加入：

```js
      if (data._onboarding?.is_new_user) {
        data._onboarding_instruction =
          `【OwnMind 新用戶初始化】偵測到這是全新帳號，尚無任何記憶。` +
          `使用工具：${data._onboarding.detected_tool}（已自動記錄）。` +
          `請立即向使用者提問：「${data._onboarding.question}」` +
          `收到回答後，呼叫 ownmind_save 建立 type=profile 記憶，` +
          `content 包含：名字、工作、使用工具。完成後告知用戶記憶已建立。`;
      }
```

- [ ] **Step 3：確認 offline.test.js 不受影響**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
node --test tests/offline.test.js 2>&1 | tail -10
```

預期：所有 PASS，`fail 0`。

- [ ] **Step 4：Commit**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
git add mcp/index.js
git commit -m "feat: inject _onboarding_instruction for new users in ownmind_init"
```

---

### Task 4：更新 configs/CLAUDE.md

**Files:**
- Modify: `configs/CLAUDE.md`

- [ ] **Step 1：在 CLAUDE.md 末尾加入 onboarding 規則**

在 `configs/CLAUDE.md` 末尾（廣播通知處理規則區塊之後）加入：

```markdown

## 新用戶 Onboarding 規則

當 ownmind_init 回傳包含 `_onboarding_instruction` 時，必須：
1. 立即向使用者提出問題（問題文字在 `_onboarding_instruction` 中）
2. 收到回答後呼叫 `ownmind_save` 建立 type=profile 記憶，content 包含：名字、工作、使用工具
3. 完成後告知用戶「已建立你的 OwnMind 個人記憶」

不可跳過、不可等使用者主動詢問。
```

- [ ] **Step 2：Commit**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
git add configs/CLAUDE.md
git commit -m "docs: add new user onboarding rules to CLAUDE.md"
```
