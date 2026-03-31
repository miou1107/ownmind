# Iron Rule Auto-Numbering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 鐵律建立時 server 自動編號，並補齊現有缺編號的鐵律。

**Architecture:** 在 POST /api/memory 的 iron_rule 建立流程中，INSERT 前查最大 code 並自動 +1。一次性 SQL 補齊既有缺編號記錄。

**Tech Stack:** Node.js, PostgreSQL

---

### Task 1: 自動編號邏輯 — 測試先行

**Files:**
- Create: `tests/auto-numbering.test.js`

- [ ] **Step 1: 寫 auto-numbering helper 的測試**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateNextIronRuleCode } from '../src/utils/auto-numbering.js';

describe('generateNextIronRuleCode', () => {
  it('no existing codes → IR-001', () => {
    assert.equal(generateNextIronRuleCode([]), 'IR-001');
  });

  it('existing IR-013 → IR-014', () => {
    assert.equal(generateNextIronRuleCode(['IR-001', 'IR-013']), 'IR-014');
  });

  it('handles gaps (IR-001, IR-005) → IR-006', () => {
    assert.equal(generateNextIronRuleCode(['IR-001', 'IR-005']), 'IR-006');
  });

  it('handles null/undefined in list', () => {
    assert.equal(generateNextIronRuleCode([null, undefined, 'IR-003']), 'IR-004');
  });

  it('3-digit padding for codes under 100', () => {
    assert.equal(generateNextIronRuleCode(['IR-099']), 'IR-100');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/auto-numbering.test.js`
Expected: FAIL — `Cannot find module '../src/utils/auto-numbering.js'`

### Task 2: 實作 auto-numbering helper

**Files:**
- Create: `src/utils/auto-numbering.js`

- [ ] **Step 1: 實作 generateNextIronRuleCode**

```javascript
/**
 * 從現有 code 列表產生下一個 IR-XXX 編號
 * @param {Array<string|null>} existingCodes - 現有的 code 值（可能含 null）
 * @returns {string} 下一個編號，如 'IR-014'
 */
export function generateNextIronRuleCode(existingCodes) {
  const nums = (existingCodes || [])
    .filter(c => c && /^IR-\d+$/.test(c))
    .map(c => parseInt(c.replace('IR-', ''), 10));

  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `IR-${String(max + 1).padStart(3, '0')}`;
}
```

- [ ] **Step 2: 跑測試確認全過**

Run: `node --test tests/auto-numbering.test.js`
Expected: 5 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/auto-numbering.test.js src/utils/auto-numbering.js
git commit --author="Vin <vincent@fontrip.com>" -m "feat: add iron rule auto-numbering helper with tests"
```

### Task 3: 整合到 POST /api/memory

**Files:**
- Modify: `src/routes/memory.js:745-776`

- [ ] **Step 1: 在檔案頂部加入 import**

在 `src/routes/memory.js` 的 import 區塊加入：

```javascript
import { generateNextIronRuleCode } from '../utils/auto-numbering.js';
```

- [ ] **Step 2: 在 INSERT 前加入自動編號邏輯**

在 `src/routes/memory.js` 的 `POST /` handler 中，在 `const result = await query(INSERT...)` 之前（約 line 770 之後），加入：

```javascript
    // iron_rule 自動編號
    let finalCode = code || null;
    if (type === 'iron_rule' && !finalCode) {
      const codeResult = await query(
        `SELECT code FROM memories WHERE user_id = $1 AND type = 'iron_rule' AND code LIKE 'IR-%'`,
        [req.user.id]
      );
      finalCode = generateNextIronRuleCode(codeResult.rows.map(r => r.code));
    }
```

- [ ] **Step 3: 把 INSERT 的參數從 `code || null` 改成 `finalCode`**

```javascript
    const result = await query(
      `INSERT INTO memories (user_id, type, title, content, code, tags, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, type, title, content, finalCode, tags || null, metadata || null]
    );
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/memory.js
git commit --author="Vin <vincent@fontrip.com>" -m "feat: integrate iron rule auto-numbering into POST /api/memory"
```

### Task 4: 補齊現有缺編號的鐵律

**Files:**
- Create: `db/backfill-iron-rule-codes.sql`

- [ ] **Step 1: 寫 backfill SQL**

```sql
-- 一次性補齊 user_id=1 的缺編號鐵律
-- 按 created_at 順序，從 IR-014 開始
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) + 13 AS new_num
  FROM memories
  WHERE user_id = 1 AND type = 'iron_rule' AND (code IS NULL OR code = '')
)
UPDATE memories m
SET code = 'IR-' || LPAD(n.new_num::text, 3, '0'),
    updated_at = NOW()
FROM numbered n
WHERE m.id = n.id;
```

- [ ] **Step 2: 確認 SQL 正確（先用 SELECT 預覽）**

把 UPDATE 改成 SELECT 先確認結果正確：

```sql
WITH numbered AS (
  SELECT id, title, ROW_NUMBER() OVER (ORDER BY created_at) + 13 AS new_num
  FROM memories
  WHERE user_id = 1 AND type = 'iron_rule' AND (code IS NULL OR code = '')
)
SELECT id, title, 'IR-' || LPAD(new_num::text, 3, '0') AS new_code
FROM numbered
ORDER BY new_num;
```

- [ ] **Step 3: 部署後在 server 執行 backfill SQL**

需要 Vin 授權部署後，SSH 到 server 執行。

- [ ] **Step 4: Commit backfill SQL**

```bash
git add db/backfill-iron-rule-codes.sql
git commit --author="Vin <vincent@fontrip.com>" -m "chore: add backfill SQL for missing iron rule codes"
```

### Task 5: 更新文件

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 CHANGELOG**

在 CHANGELOG.md 頂部加入：

```markdown
## v1.13.0 - Iron Rule Auto-Numbering

### 改善
- Server 端自動編號：新增 iron_rule 時若未帶 code，自動查最大編號 +1（格式 IR-XXX）
- 補齊 12 條既有缺編號的鐵律（IR-014 ~ IR-025）

### 新增檔案
- `src/utils/auto-numbering.js` — 自動編號 helper
- `tests/auto-numbering.test.js` — 自動編號測試
- `db/backfill-iron-rule-codes.sql` — 一次性補齊 SQL
```

- [ ] **Step 2: 檢查 README 和 FILELIST 是否需要更新**

新增了 `src/utils/auto-numbering.js`，FILELIST 需要加入此檔案。

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md FILELIST.md
git commit --author="Vin <vincent@fontrip.com>" -m "docs: update CHANGELOG and FILELIST for auto-numbering feature"
```
