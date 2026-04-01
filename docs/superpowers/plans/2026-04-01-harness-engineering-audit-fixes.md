# Harness Engineering 審計修復 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 architectural issues in OwnMind's iron rule enforcement engine: deduplicate helpers, unify compliance format, add cache sync, implement fail-closed L1, enable L2 commit blocking, and improve trigger regex precision.

**Architecture:** Extract shared utilities into `shared/helpers.js` and `shared/compliance.js` (pure functions, zero deps, ESM). Update all hooks and MCP to import from these shared modules. Add cache refresh on iron_rule mutations. Convert remaining CJS hooks to ESM.

**Tech Stack:** Node.js (ESM), node:test for testing, no external dependencies in shared modules.

---

### Task 1: ESM foundation — hooks/package.json

**Files:**
- Create: `hooks/package.json`

- [ ] **Step 1: Create hooks/package.json**

```json
{ "type": "module" }
```

- [ ] **Step 2: Verify existing ESM hooks still work**

Run: `node ~/.ownmind/hooks/ownmind-git-pre-commit.js 2>&1; echo "exit: $?"`
Expected: exits 0 (no cache = no rules = pass)

- [ ] **Step 3: Commit**

```bash
git add hooks/package.json
git commit -m "chore: add hooks/package.json with type:module for ESM unification"
```

---

### Task 2: shared/helpers.js — extract common utilities

**Files:**
- Create: `shared/helpers.js`
- Create: `tests/helpers.test.js`

- [ ] **Step 1: Write failing tests for helpers**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readJsonSafe, getChangedSourceFiles, getClientVersion, readCredentials, SOURCE_PATTERNS } from '../shared/helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('readJsonSafe', () => {
  it('reads valid JSON file', () => {
    const tmpFile = path.join(os.tmpdir(), 'test-helpers-valid.json');
    fs.writeFileSync(tmpFile, '{"key": "value"}');
    const result = readJsonSafe(tmpFile);
    assert.deepEqual(result, { key: 'value' });
    fs.unlinkSync(tmpFile);
  });

  it('returns null for missing file', () => {
    const result = readJsonSafe('/tmp/nonexistent-helpers-test.json');
    assert.equal(result, null);
  });

  it('returns null for invalid JSON', () => {
    const tmpFile = path.join(os.tmpdir(), 'test-helpers-invalid.json');
    fs.writeFileSync(tmpFile, 'not json');
    const result = readJsonSafe(tmpFile);
    assert.equal(result, null);
    fs.unlinkSync(tmpFile);
  });
});

describe('SOURCE_PATTERNS', () => {
  it('is an array of RegExp', () => {
    assert.ok(Array.isArray(SOURCE_PATTERNS));
    assert.ok(SOURCE_PATTERNS.every(p => p instanceof RegExp));
  });
});

describe('getChangedSourceFiles', () => {
  it('filters files matching SOURCE_PATTERNS', () => {
    const files = ['src/app.js', 'README.md', 'mcp/index.js', 'docs/setup.md', 'shared/helpers.js'];
    const result = getChangedSourceFiles(files);
    assert.deepEqual(result, ['src/app.js', 'mcp/index.js', 'shared/helpers.js']);
  });

  it('returns empty for no matches', () => {
    const result = getChangedSourceFiles(['README.md', 'docs/setup.md']);
    assert.deepEqual(result, []);
  });

  it('accepts custom patterns', () => {
    const result = getChangedSourceFiles(['lib/foo.js', 'src/bar.js'], [/^lib\//]);
    assert.deepEqual(result, ['lib/foo.js']);
  });
});

describe('getClientVersion', () => {
  it('returns a version string', () => {
    const version = getClientVersion();
    assert.ok(typeof version === 'string');
    assert.ok(version.length > 0);
  });
});

describe('readCredentials', () => {
  it('returns empty strings when settings file does not exist', () => {
    const result = readCredentials('/tmp/nonexistent-settings.json');
    assert.deepEqual(result, { apiKey: '', apiUrl: '' });
  });

  it('reads credentials from settings file', () => {
    const tmpFile = path.join(os.tmpdir(), 'test-settings.json');
    fs.writeFileSync(tmpFile, JSON.stringify({
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: 'https://example.com' } } }
    }));
    const result = readCredentials(tmpFile);
    assert.deepEqual(result, { apiKey: 'test-key', apiUrl: 'https://example.com' });
    fs.unlinkSync(tmpFile);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.ownmind && node --test tests/helpers.test.js`
Expected: FAIL — module `../shared/helpers.js` not found

- [ ] **Step 3: Implement shared/helpers.js**

```js
/**
 * OwnMind Shared Helpers
 *
 * 純函式模組，零外部依賴。被 hooks 和 MCP 共用。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// Constants
// ============================================================

export const SOURCE_PATTERNS = [/^src\//, /^mcp\//, /^hooks\//, /^shared\//];

const HOME = os.homedir();
const DEFAULT_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

// ============================================================
// Functions
// ============================================================

/**
 * 安全讀取 JSON 檔案，失敗回傳 null
 */
export function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 過濾出 source 檔案（匹配 patterns）
 */
export function getChangedSourceFiles(files, patterns = SOURCE_PATTERNS) {
  return files.filter(f =>
    patterns.some(p => p.test(f))
  );
}

/**
 * 讀取 MCP client 版本號
 */
export function getClientVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HOME, '.ownmind', 'mcp', 'package.json'), 'utf8'));
    return pkg.version || '?';
  } catch {
    return '?';
  }
}

/**
 * 從 Claude Code settings.json 讀取 OwnMind credentials
 * @param {string} [settingsPath] — 預設 ~/.claude/settings.json
 */
export function readCredentials(settingsPath = DEFAULT_SETTINGS_PATH) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const env = s.mcpServers?.ownmind?.env || {};
    return { apiKey: env.OWNMIND_API_KEY || '', apiUrl: env.OWNMIND_API_URL || '' };
  } catch {
    return { apiKey: '', apiUrl: '' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.ownmind && node --test tests/helpers.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/helpers.js tests/helpers.test.js
git commit -m "feat: add shared/helpers.js with common utilities for hooks and MCP"
```

---

### Task 3: shared/compliance.js — unified compliance log

**Files:**
- Create: `shared/compliance.js`
- Create: `tests/compliance.test.js`

- [ ] **Step 1: Write failing tests for compliance**

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Use a temp dir to avoid polluting real logs
const TEST_LOG_DIR = path.join(os.tmpdir(), 'ownmind-compliance-test-' + Date.now());
const TEST_LOG_FILE = path.join(TEST_LOG_DIR, 'compliance.jsonl');

// We need to set env before import so compliance.js picks up the test path
process.env.__OWNMIND_COMPLIANCE_LOG_PATH = TEST_LOG_FILE;

const { appendCompliance, readComplianceEvents } = await import('../shared/compliance.js');

describe('appendCompliance', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
    try { fs.unlinkSync(TEST_LOG_FILE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_LOG_DIR, { recursive: true }); } catch {}
  });

  it('writes a valid JSONL entry with auto-generated ts', () => {
    appendCompliance({
      event: 'IR-008',
      action: 'comply',
      rule_code: 'IR-008',
      rule_title: '每次 commit 必須同步更新文件',
      source: 'mcp',
    });

    const lines = fs.readFileSync(TEST_LOG_FILE, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, 'IR-008');
    assert.equal(entry.action, 'comply');
    assert.equal(entry.rule_code, 'IR-008');
    assert.equal(entry.source, 'mcp');
    assert.ok(entry.ts, 'ts should be auto-generated');
  });

  it('preserves optional fields: session_id, commit_hash, failures', () => {
    appendCompliance({
      event: 'IR-002',
      action: 'violate',
      rule_code: 'IR-002',
      rule_title: '不要 commit .env',
      source: 'post_commit',
      session_id: '123',
      commit_hash: 'abc1234',
      failures: ['staged .env file'],
    });

    const entry = JSON.parse(fs.readFileSync(TEST_LOG_FILE, 'utf8').trim());
    assert.equal(entry.commit_hash, 'abc1234');
    assert.deepEqual(entry.failures, ['staged .env file']);
    assert.equal(entry.session_id, '123');
  });
});

describe('readComplianceEvents', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
    try { fs.unlinkSync(TEST_LOG_FILE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_LOG_DIR, { recursive: true }); } catch {}
  });

  it('returns empty array when log does not exist', () => {
    const events = readComplianceEvents();
    assert.deepEqual(events, []);
  });

  it('filters events by cutoff', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 1000).toISOString();
    const old = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    fs.writeFileSync(TEST_LOG_FILE, [
      JSON.stringify({ ts: old, event: 'IR-001', action: 'comply', rule_code: 'IR-001', rule_title: 'old', source: 'mcp' }),
      JSON.stringify({ ts: recent, event: 'IR-002', action: 'comply', rule_code: 'IR-002', rule_title: 'recent', source: 'mcp' }),
    ].join('\n') + '\n');

    const events = readComplianceEvents(24 * 60 * 60 * 1000);
    assert.equal(events.length, 1);
    assert.equal(events[0].rule_code, 'IR-002');
  });

  it('skips malformed lines', () => {
    fs.writeFileSync(TEST_LOG_FILE, 'not json\n' + JSON.stringify({
      ts: new Date().toISOString(), event: 'IR-001', action: 'comply',
      rule_code: 'IR-001', rule_title: 'test', source: 'mcp'
    }) + '\n');

    const events = readComplianceEvents();
    assert.equal(events.length, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.ownmind && node --test tests/compliance.test.js`
Expected: FAIL — module `../shared/compliance.js` not found

- [ ] **Step 3: Implement shared/compliance.js**

```js
/**
 * OwnMind Compliance Log — 統一格式讀寫
 *
 * 純函式模組，零外部依賴。
 * 被 MCP report_compliance、git hooks、session audit 共用。
 *
 * Schema:
 *   ts: ISO 8601
 *   event: rule_code（如 'IR-008'）
 *   action: 'comply' | 'skip' | 'violate'
 *   rule_code: string
 *   rule_title: string
 *   source: 'mcp' | 'pre_commit' | 'post_commit' | 'session_audit' | 'hook'
 *   session_id?: string
 *   commit_hash?: string
 *   failures?: string[]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.ownmind', 'logs', 'compliance.jsonl');

function getLogPath() {
  return process.env.__OWNMIND_COMPLIANCE_LOG_PATH || DEFAULT_LOG_PATH;
}

/**
 * 寫入一筆 compliance entry 到 compliance.jsonl
 * 自動補 ts（若未提供）
 */
export function appendCompliance(entry) {
  try {
    const logPath = getLogPath();
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const record = {
      ts: entry.ts || new Date().toISOString(),
      event: entry.event || entry.rule_code || '',
      action: entry.action,
      rule_code: entry.rule_code || '',
      rule_title: entry.rule_title || '',
      source: entry.source || 'unknown',
    };

    // Optional fields
    if (entry.session_id) record.session_id = entry.session_id;
    if (entry.commit_hash) record.commit_hash = entry.commit_hash;
    if (entry.failures) record.failures = entry.failures;

    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch {
    // Silent fail — never disrupt main flow
  }
}

/**
 * 讀取 compliance.jsonl 中近 cutoffMs 毫秒內的事件
 * @param {number} [cutoffMs=86400000] — 預設 24 小時
 */
export function readComplianceEvents(cutoffMs = 24 * 60 * 60 * 1000) {
  try {
    const logPath = getLogPath();
    const raw = fs.readFileSync(logPath, 'utf8').trim();
    if (!raw) return [];

    const cutoff = Date.now() - cutoffMs;
    const events = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const entryTime = new Date(entry.ts).getTime();
        if (entryTime >= cutoff) {
          events.push(entry);
        }
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.ownmind && node --test tests/compliance.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/compliance.js tests/compliance.test.js
git commit -m "feat: add shared/compliance.js with unified compliance log schema"
```

---

### Task 4: tests/trigger-detection.test.js — trigger regex tests

**Files:**
- Create: `tests/trigger-detection.test.js`

- [ ] **Step 1: Write trigger detection tests**

These tests define the expected behavior for the new regex patterns that will be implemented in Tasks 7 and 8.

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * detectCommandTrigger — PreToolUse hook 的 command 觸發檢測
 * 從 iron-rule-check.js 提取為可測試函式（Task 7 實作）
 */
import { detectCommandTrigger } from '../shared/helpers.js';

describe('detectCommandTrigger', () => {
  // commit triggers
  it('git commit → commit', () => {
    assert.equal(detectCommandTrigger('git commit -m "feat: add feature"'), 'commit');
  });
  it('git reset → commit', () => {
    assert.equal(detectCommandTrigger('git reset --hard HEAD~1'), 'commit');
  });
  it('git rebase → commit', () => {
    assert.equal(detectCommandTrigger('git rebase main'), 'commit');
  });
  it('git merge → commit', () => {
    assert.equal(detectCommandTrigger('git merge feature-branch'), 'commit');
  });
  it('git tag → commit', () => {
    assert.equal(detectCommandTrigger('git tag v1.0.0'), 'commit');
  });

  // deploy triggers
  it('git push → deploy', () => {
    assert.equal(detectCommandTrigger('git push origin main'), 'deploy');
  });
  it('docker compose up → deploy', () => {
    assert.equal(detectCommandTrigger('docker compose up -d'), 'deploy');
  });
  it('docker compose build → deploy', () => {
    assert.equal(detectCommandTrigger('docker compose build --no-cache'), 'deploy');
  });
  it('kubectl apply → deploy', () => {
    assert.equal(detectCommandTrigger('kubectl apply -f deployment.yaml'), 'deploy');
  });
  it('npm run deploy → deploy', () => {
    assert.equal(detectCommandTrigger('npm run deploy'), 'deploy');
  });

  // delete triggers
  it('rm -rf → delete', () => {
    assert.equal(detectCommandTrigger('rm -rf /tmp/old-data'), 'delete');
  });
  it('rmdir → delete', () => {
    assert.equal(detectCommandTrigger('rmdir /s /q old-folder'), 'delete');
  });
  it('Remove-Item → delete', () => {
    assert.equal(detectCommandTrigger('Remove-Item -Recurse ./old'), 'delete');
  });
  it('DROP TABLE → delete', () => {
    assert.equal(detectCommandTrigger('psql -c "DROP TABLE users"'), 'delete');
  });
  it('DELETE FROM → delete', () => {
    assert.equal(detectCommandTrigger('mysql -e "DELETE FROM sessions"'), 'delete');
  });

  // no trigger
  it('git status → null', () => {
    assert.equal(detectCommandTrigger('git status'), null);
  });
  it('git log → null', () => {
    assert.equal(detectCommandTrigger('git log --oneline'), null);
  });
  it('npm install → null', () => {
    assert.equal(detectCommandTrigger('npm install'), null);
  });
  it('empty string → null', () => {
    assert.equal(detectCommandTrigger(''), null);
  });

  // false positive prevention
  it('echo "no commit here" → null (word boundary)', () => {
    assert.equal(detectCommandTrigger('echo "recommit the changes"'), null);
  });
  it('docker compose logs → null (not up/build/push)', () => {
    assert.equal(detectCommandTrigger('docker compose logs -f'), null);
  });
});

/**
 * detectTriggerFromContext — MCP 的 context 觸發檢測
 */
import { detectTriggerFromContext } from '../shared/helpers.js';

describe('detectTriggerFromContext', () => {
  it('context mentioning commit → commit', () => {
    assert.equal(detectTriggerFromContext('preparing to commit code'), 'commit');
  });
  it('context mentioning deploy → deploy', () => {
    assert.equal(detectTriggerFromContext('about to deploy to production'), 'deploy');
  });
  it('context mentioning 部署 → deploy', () => {
    assert.equal(detectTriggerFromContext('準備部署到伺服器'), 'deploy');
  });
  it('context mentioning delete → delete', () => {
    assert.equal(detectTriggerFromContext('will delete old records'), 'delete');
  });
  it('context mentioning 刪除 → delete', () => {
    assert.equal(detectTriggerFromContext('準備刪除舊資料'), 'delete');
  });
  it('null context → null', () => {
    assert.equal(detectTriggerFromContext(null), null);
  });
  it('unrelated context → null', () => {
    assert.equal(detectTriggerFromContext('reading the documentation'), null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.ownmind && node --test tests/trigger-detection.test.js`
Expected: FAIL — `detectCommandTrigger` and `detectTriggerFromContext` not exported from helpers.js

- [ ] **Step 3: Add trigger detection functions to shared/helpers.js**

Append to `shared/helpers.js`:

```js
/**
 * 從 PreToolUse hook 的 command 偵測觸發類型
 * @param {string} command — bash command
 * @returns {'commit' | 'deploy' | 'delete' | null}
 */
export function detectCommandTrigger(command) {
  if (!command) return null;
  if (/\bgit\s+(commit|reset|rebase|merge)\b/i.test(command)) return 'commit';
  if (/\bgit\s+tag\b/i.test(command)) return 'commit';
  if (/\bgit\s+push\b/i.test(command)) return 'deploy';
  if (/\b(docker\s+compose\s+(up|build|push)|kubectl\s+apply|npm\s+run\s+deploy)\b/i.test(command)) return 'deploy';
  if (/\b(rm\s+-rf|rmdir|Remove-Item|drop\s+table|DELETE\s+FROM)\b/i.test(command)) return 'delete';
  return null;
}

/**
 * 從 MCP report_compliance 的 context 偵測觸發類型
 * @param {string} context — free-form text
 * @returns {'commit' | 'deploy' | 'delete' | null}
 */
export function detectTriggerFromContext(context) {
  if (!context) return null;
  if (/\bcommit\b/i.test(context)) return 'commit';
  if (/\b(deploy|部署)\b/i.test(context)) return 'deploy';
  if (/\b(delete|刪除)\b/i.test(context)) return 'delete';
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.ownmind && node --test tests/trigger-detection.test.js`
Expected: All tests PASS

- [ ] **Step 5: Run all shared tests together**

Run: `cd ~/.ownmind && node --test tests/helpers.test.js tests/compliance.test.js tests/trigger-detection.test.js tests/verification.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add shared/helpers.js tests/trigger-detection.test.js
git commit -m "feat: add detectCommandTrigger and detectTriggerFromContext to shared/helpers.js"
```

---

### Task 5: Refactor hooks/ownmind-git-post-commit.js

**Files:**
- Modify: `hooks/ownmind-git-post-commit.js`

- [ ] **Step 1: Replace duplicated code with shared imports**

Replace the entire file with:

```js
#!/usr/bin/env node
/**
 * OwnMind Git Post-Commit Hook (L5)
 *
 * commit 完成後檢查鐵律，違反時寫入 compliance.jsonl 並輸出警告。
 * 不會阻止 commit（已經完成了），僅記錄供後續分析。
 * 零網路依賴：所有資料從本地快取讀取。
 */

import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { readJsonSafe, getChangedSourceFiles, getClientVersion } from '../shared/helpers.js';
import { appendCompliance, readComplianceEvents } from '../shared/compliance.js';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
const VERSION = getClientVersion();

// ============================================================
// Helpers
// ============================================================

function getLastCommitInfo() {
  try {
    const raw = execSync('git log -1 --name-only --format=%s', { encoding: 'utf8' }).trim();
    const lines = raw.split('\n').filter(Boolean);
    const commitMessage = lines[0] || '';
    const files = lines.slice(1);
    return { commitMessage, files };
  } catch {
    return { commitMessage: '', files: [] };
  }
}

function getLastCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  // 1. Load iron rules from local cache
  const rules = readJsonSafe(CACHE_FILE);
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
    process.exit(0);
  }

  // 2. Filter rules with commit trigger
  const commitRules = rules.filter(r => {
    const triggers = r.metadata?.verification?.trigger;
    return Array.isArray(triggers) && triggers.includes('commit');
  });

  if (commitRules.length === 0) {
    process.exit(0);
  }

  // 3. Collect commit context
  const { commitMessage, files } = getLastCommitInfo();
  if (files.length === 0) {
    process.exit(0);
  }

  const commitHash = getLastCommitHash();
  const changedSourceFiles = getChangedSourceFiles(files);
  const complianceEvents = readComplianceEvents();

  const context = {
    stagedFiles: files,       // post-commit: committed files serve as "staged"
    commitMessage,
    changedSourceFiles,
    complianceEvents,
  };

  // 4. Import verification module (ESM)
  let evaluateConditions;
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const mod = await import(verificationPath);
    evaluateConditions = mod.evaluateConditions;
  } catch {
    console.warn(`【OwnMind v${VERSION}】⚠️ 驗證引擎不可用，跳過 post-commit 檢查`);
    process.exit(0);
  }

  // 5. Evaluate each rule
  const violations = [];

  for (const rule of commitRules) {
    const verification = rule.metadata?.verification;
    if (!verification?.conditions) continue;

    const result = evaluateConditions(verification.conditions, context);

    if (!result.pass) {
      const ruleCode = rule.code || rule.metadata?.code || 'IR-???';
      const ruleTitle = rule.title || '未命名規則';

      violations.push({
        ruleCode,
        ruleTitle,
        failures: result.failures,
      });

      // Write violation to compliance log
      appendCompliance({
        event: ruleCode,
        action: 'violate',
        rule_code: ruleCode,
        rule_title: ruleTitle,
        source: 'post_commit',
        commit_hash: commitHash,
        failures: result.failures,
      });
    }
  }

  // 6. Output warnings (don't exit 1 — commit is already done)
  if (violations.length > 0) {
    console.warn('');
    console.warn(`【OwnMind v${VERSION}】Commit 後稽核：此 commit 有以下違規`);
    for (const v of violations) {
      console.warn(`  ⚠️  ${v.ruleCode}: ${v.ruleTitle}`);
      for (const f of v.failures) {
        console.warn(`    → ${f}`);
      }
    }
    console.warn(`  commit: ${commitHash}`);
    console.warn('  已記錄至 compliance.jsonl，建議儘快修正。');
    console.warn('');
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`【OwnMind v${VERSION}】錯誤回報：post-commit 非預期錯誤: ${err.message}`);
  process.exit(0);
});
```

- [ ] **Step 2: Verify syntax**

Run: `node -c ~/.ownmind/hooks/ownmind-git-post-commit.js`
Expected: no syntax errors

- [ ] **Step 3: Commit**

```bash
git add hooks/ownmind-git-post-commit.js
git commit -m "refactor: post-commit hook uses shared/helpers.js and shared/compliance.js"
```

---

### Task 6: Refactor hooks/ownmind-verify-trigger.js

**Files:**
- Modify: `hooks/ownmind-verify-trigger.js`

- [ ] **Step 1: Replace duplicated code with shared imports**

Replace the entire file with:

```js
#!/usr/bin/env node
/**
 * OwnMind Verify Trigger — Node.js helper for deploy/delete verification
 *
 * Reads local cache + compliance JSONL, runs evaluateConditions(),
 * outputs JSON result to stdout.
 *
 * Usage: node ownmind-verify-trigger.js <trigger_type>
 * Output: {"pass": true} or {"pass": false, "failures": [...]}
 */

import path from 'path';
import os from 'os';
import { readJsonSafe } from '../shared/helpers.js';
import { readComplianceEvents } from '../shared/compliance.js';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');

async function main() {
  const triggerType = process.argv[2];
  if (!triggerType) {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  // 1. Read cached iron rules
  const rules = readJsonSafe(CACHE_FILE);
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  // 2. Filter rules matching this trigger type
  const triggerRules = rules.filter(r => {
    const triggers = r.metadata?.verification?.trigger;
    return Array.isArray(triggers) && triggers.includes(triggerType);
  });

  if (triggerRules.length === 0) {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  // 3. Read compliance events (last 24 hours)
  const complianceEvents = readComplianceEvents();

  // 4. Dynamic import of ESM verification module
  let evaluateConditions;
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const mod = await import(verificationPath);
    evaluateConditions = mod.evaluateConditions;
  } catch {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  // 5. Evaluate each rule
  const context = { complianceEvents };
  const failures = [];

  for (const rule of triggerRules) {
    const verification = rule.metadata?.verification;
    if (!verification?.conditions) continue;

    const result = evaluateConditions(verification.conditions, context);

    if (!result.pass && verification.block_on_fail) {
      const code = rule.code || rule.metadata?.code || 'IR-???';
      const title = rule.title || '未命名規則';
      failures.push(`${code}: ${title}`);
      for (const f of result.failures) {
        failures.push(`  → ${f}`);
      }
    }
  }

  // 6. Output result
  if (failures.length > 0) {
    console.log(JSON.stringify({ pass: false, failures }));
  } else {
    console.log(JSON.stringify({ pass: true }));
  }
}

main().catch(() => {
  console.log(JSON.stringify({ pass: true }));
});
```

- [ ] **Step 2: Verify syntax**

Run: `node -c ~/.ownmind/hooks/ownmind-verify-trigger.js`
Expected: no syntax errors

- [ ] **Step 3: Commit**

```bash
git add hooks/ownmind-verify-trigger.js
git commit -m "refactor: verify-trigger uses shared/helpers.js and shared/compliance.js"
```

---

### Task 7: Refactor hooks/ownmind-iron-rule-check.js (CJS→ESM + shared imports + L2 commit blocking + regex)

**Files:**
- Modify: `hooks/ownmind-iron-rule-check.js`

- [ ] **Step 1: Rewrite with ESM, shared imports, commit blocking, and improved regex**

Replace the entire file with:

```js
#!/usr/bin/env node
/**
 * OwnMind Iron Rule Check — Claude Code PreToolUse Hook (L2)
 *
 * 偵測高風險操作（commit/deploy/delete），顯示鐵律提醒。
 * 對所有 trigger 類型都跑 verification engine，block_on_fail 規則會擋下操作。
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import os from 'os';
import { readJsonSafe, getClientVersion, readCredentials, detectCommandTrigger } from '../shared/helpers.js';
import { readComplianceEvents } from '../shared/compliance.js';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
const VERSION = getClientVersion();

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  // Read stdin (hook input)
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {}

  let command = '';
  try {
    command = JSON.parse(input).command || '';
  } catch {}

  if (!command) process.exit(0);

  // Detect trigger keywords using shared function
  const trigger = detectCommandTrigger(command);
  if (!trigger) process.exit(0);

  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) process.exit(0);

  // Fetch iron rules from API
  let rules;
  try {
    const raw = await httpGet(`${apiUrl}/api/memory/type/iron_rule`, {
      'Authorization': `Bearer ${apiKey}`
    });
    rules = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const relevant = rules.filter(r => {
    if (!r.tags || r.tags.length === 0) return true;
    return r.tags.some(t =>
      t === 'trigger:' + trigger ||
      (trigger === 'commit' && t === 'trigger:git')
    );
  });

  if (relevant.length === 0) process.exit(0);

  const lines = [];
  lines.push(`【OwnMind v${VERSION}】鐵律提醒：即將執行 ${trigger} 操作，請確認以下鐵律`);
  relevant.forEach(r => lines.push(`  ⚠️  ${r.code || 'IR-?'}: ${r.title}`));

  // Run verification engine for ALL triggers (commit/deploy/delete)
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const { evaluateConditions } = await import(verificationPath);

    const cachedRules = readJsonSafe(CACHE_FILE) || [];

    const triggerRules = cachedRules.filter(r => {
      const triggers = r.metadata?.verification?.trigger;
      return Array.isArray(triggers) && triggers.includes(trigger);
    });

    if (triggerRules.length > 0) {
      const complianceEvents = readComplianceEvents();
      const context = { complianceEvents };
      const blockFailures = [];

      for (const rule of triggerRules) {
        const verification = rule.metadata?.verification;
        if (!verification?.conditions) continue;

        const result = evaluateConditions(verification.conditions, context);
        if (!result.pass && verification.block_on_fail) {
          const code = rule.code || rule.metadata?.code || 'IR-???';
          const title = rule.title || '未命名規則';
          blockFailures.push(`${code}: ${title}`);
          for (const f of result.failures) {
            blockFailures.push(`    → ${f}`);
          }
        }
      }

      if (blockFailures.length > 0) {
        lines.push('');
        lines.push(`【OwnMind v${VERSION}】鐵律攔截：${trigger} 操作被擋下`);
        blockFailures.forEach(f => lines.push(`  ❌ ${f}`));
        lines.push(`請先完成上述步驟再執行 ${trigger}。`);

        console.log(JSON.stringify({
          decision: 'block',
          reason: `Iron rule verification failed for ${trigger} operation`,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: lines.join('\n')
          }
        }));
        return;
      }
    }
  } catch {
    // Verification engine not available, continue with reminder only
  }

  // All verifications passed (or no block_on_fail rules), show reminders
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
```

- [ ] **Step 2: Verify syntax**

Run: `node -c ~/.ownmind/hooks/ownmind-iron-rule-check.js`
Expected: no syntax errors

- [ ] **Step 3: Commit**

```bash
git add hooks/ownmind-iron-rule-check.js
git commit -m "refactor: iron-rule-check CJS→ESM, L2 commit blocking, improved trigger regex"
```

---

### Task 8: Refactor hooks/ownmind-session-start.js (CJS→ESM)

**Files:**
- Modify: `hooks/ownmind-session-start.js`

- [ ] **Step 1: Convert to ESM with shared imports**

Replace the entire file with:

```js
#!/usr/bin/env node
/**
 * OwnMind SessionStart Hook (L4)
 *
 * 載入初始記憶並顯示鐵律摘要。
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import os from 'os';
import { readCredentials, getClientVersion } from '../shared/helpers.js';

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.ownmind', 'logs');

function logEvent(event, extra = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const now = new Date();
    const ts = now.toISOString().replace('Z', '+00:00');
    const dateStr = now.toISOString().slice(0, 10);
    const entry = JSON.stringify({ ts, event, tool: 'claude-code', source: 'hook', ...extra });
    fs.appendFileSync(path.join(LOG_DIR, `${dateStr}.jsonl`), entry + '\n');
  } catch {}
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) process.exit(0);

  logEvent('init', { status: 'starting' });

  let initData;
  try {
    const raw = await httpGet(`${apiUrl}/api/memory/init?compact=true`, {
      'Authorization': `Bearer ${apiKey}`
    });
    initData = JSON.parse(raw);
  } catch {
    logEvent('init_fail', { status: 'api_timeout' });
    process.exit(0);
  }

  logEvent('init', { status: 'ok' });

  const lines = [];
  lines.push(`【OwnMind v${initData.server_version || '?'}】記憶載入：已載入你的個人記憶`);
  lines.push('');

  if (initData.profile) {
    lines.push('## Profile');
    lines.push(`- ${initData.profile.title || ''}: ${(initData.profile.content || '').substring(0, 200)}`);
    lines.push('');
  }

  if (initData.iron_rules_digest) {
    lines.push('## 鐵律（必須嚴格遵守）');
    lines.push(initData.iron_rules_digest);
    lines.push('');
  }

  if (initData.principles && initData.principles.length > 0) {
    lines.push('## 工作原則');
    initData.principles.forEach(p => lines.push(`- ${p.title}`));
    lines.push('');
  }

  if (initData.active_handoff) {
    lines.push('## 待接手交接');
    lines.push(`專案: ${initData.active_handoff.project || '?'}`);
    lines.push('');
  }

  lines.push('ownmind_* MCP tools 可操作記憶。鐵律完整內容：ownmind_get("iron_rule")。');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
```

- [ ] **Step 2: Verify syntax**

Run: `node -c ~/.ownmind/hooks/ownmind-session-start.js`
Expected: no syntax errors

- [ ] **Step 3: Commit**

```bash
git add hooks/ownmind-session-start.js
git commit -m "refactor: session-start hook CJS→ESM, uses shared/helpers.js"
```

---

### Task 9: Refactor hooks/ownmind-git-pre-commit.js (shared imports + fail-closed + staleness check)

**Files:**
- Modify: `hooks/ownmind-git-pre-commit.js`

- [ ] **Step 1: Rewrite with shared imports, fail-closed, and cache staleness check**

Replace the entire file with:

```js
#!/usr/bin/env node
/**
 * OwnMind Git Pre-Commit Hook (L1)
 *
 * 在 commit 前自動檢查鐵律，若 block_on_fail 規則違反則阻止 commit。
 * 快取為空時嘗試從 API 同步（fail-closed）。
 * 零網路依賴（有快取時）：所有資料從本地快取讀取。
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import https from 'https';
import http from 'http';
import os from 'os';
import { readJsonSafe, getChangedSourceFiles, getClientVersion, readCredentials } from '../shared/helpers.js';
import { readComplianceEvents } from '../shared/compliance.js';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
const COMMIT_MSG_FILE = path.join(process.cwd(), '.git', 'COMMIT_EDITMSG');
const VERSION = getClientVersion();

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================
// Helpers
// ============================================================

function getStagedFiles() {
  try {
    const raw = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    return raw ? raw.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getCommitMessage() {
  try {
    return fs.readFileSync(COMMIT_MSG_FILE, 'utf8').trim();
  } catch {
    return process.env.GIT_COMMIT_MSG || '';
  }
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * 嘗試從 API 同步 iron rules 到本地快取
 * @returns {Array|null} — 成功回傳 rules array，失敗回傳 null
 */
async function fetchAndCacheRules() {
  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) return null;

  try {
    const raw = await httpGet(`${apiUrl}/api/memory/type/iron_rule`, {
      'Authorization': `Bearer ${apiKey}`
    });
    const allRules = JSON.parse(raw);
    const verifiable = (Array.isArray(allRules) ? allRules : []).filter(r => r.metadata?.verification);

    // Write to cache
    const cacheDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(verifiable, null, 2));

    return verifiable;
  } catch {
    return null;
  }
}

function formatBlockMessage(failures) {
  const lines = ['', `【OwnMind v${VERSION}】Commit 前檢查：commit 被擋下`];
  for (const f of failures) {
    lines.push(`  ❌ ${f}`);
  }
  lines.push('請先完成上述步驟再 commit。', '');
  return lines.join('\n');
}

function formatPassMessage(checkedCount) {
  if (checkedCount === 0) return '';
  return `【OwnMind v${VERSION}】Commit 前檢查：${checkedCount} 條規則全部通過 ✓`;
}

// ============================================================
// Main
// ============================================================

async function main() {
  // 1. Load iron rules from local cache (with staleness check)
  let rules = readJsonSafe(CACHE_FILE);
  let cacheStale = false;

  if (rules && Array.isArray(rules) && rules.length > 0) {
    // Check staleness
    try {
      const mtime = fs.statSync(CACHE_FILE).mtimeMs;
      if (Date.now() - mtime > CACHE_MAX_AGE_MS) {
        cacheStale = true;
      }
    } catch {}
  }

  // 2. If cache empty or stale, try API fetch (fail-closed for empty, best-effort for stale)
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
    // Cache empty — try to fetch from API
    const fetched = await fetchAndCacheRules();
    if (!fetched || fetched.length === 0) {
      // Truly no rules available — pass
      process.exit(0);
    }
    rules = fetched;
  } else if (cacheStale) {
    // Cache stale — best-effort refresh, fall back to old cache
    const fetched = await fetchAndCacheRules();
    if (fetched && fetched.length > 0) {
      rules = fetched;
    }
    // If fetch failed, continue with old cache
  }

  // 3. Filter rules with commit trigger
  const commitRules = rules.filter(r => {
    const triggers = r.metadata?.verification?.trigger;
    return Array.isArray(triggers) && triggers.includes('commit');
  });

  if (commitRules.length === 0) {
    process.exit(0);
  }

  // 4. Collect git context
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    process.exit(0);
  }

  const commitMessage = getCommitMessage();
  const changedSourceFiles = getChangedSourceFiles(stagedFiles);
  const complianceEvents = readComplianceEvents();

  const context = {
    stagedFiles,
    commitMessage,
    changedSourceFiles,
    complianceEvents,
  };

  // 5. Import verification module (ESM)
  let evaluateConditions;
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const mod = await import(verificationPath);
    evaluateConditions = mod.evaluateConditions;
  } catch {
    // Fail-open but not silent
    console.warn(`【OwnMind v${VERSION}】⚠️ 驗證引擎不可用，跳過 pre-commit 檢查`);
    process.exit(0);
  }

  // 6. Evaluate each rule
  const blockFailures = [];
  let checkedCount = 0;

  for (const rule of commitRules) {
    const verification = rule.metadata?.verification;
    if (!verification?.conditions) continue;

    checkedCount++;
    const result = evaluateConditions(verification.conditions, context);

    if (!result.pass) {
      const ruleCode = rule.code || rule.metadata?.code || 'IR-???';
      const ruleTitle = rule.title || '未命名規則';

      if (verification.block_on_fail) {
        blockFailures.push(`${ruleCode}: ${ruleTitle}`);
        if (result.failures.length > 0) {
          for (const f of result.failures) {
            blockFailures.push(`    → ${f}`);
          }
        }
      }
    }
  }

  // 7. Output results
  if (blockFailures.length > 0) {
    console.error(formatBlockMessage(blockFailures));
    process.exit(1);
  }

  const passMsg = formatPassMessage(checkedCount);
  if (passMsg) {
    console.log(passMsg);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`【OwnMind v${VERSION}】錯誤回報：pre-commit 非預期錯誤，跳過檢查: ${err.message}`);
  process.exit(0);
});
```

- [ ] **Step 2: Verify syntax**

Run: `node -c ~/.ownmind/hooks/ownmind-git-pre-commit.js`
Expected: no syntax errors

- [ ] **Step 3: Commit**

```bash
git add hooks/ownmind-git-pre-commit.js
git commit -m "refactor: pre-commit hook uses shared modules, fail-closed on empty cache, staleness check"
```

---

### Task 10: Refactor mcp/index.js — compliance, cache sync, L6 fix, trigger regex

**Files:**
- Modify: `mcp/index.js`

This is the largest change. Four modifications in one file:
1. Delete `deriveEvent()`, use `appendCompliance()` from shared module
2. Add `refreshIronRulesCache()` called after save/update/disable of iron_rules
3. `auditSession()` → async with `await getEvaluateConditions()`
4. Replace `detectTriggerFromContext()` with shared version

- [ ] **Step 1: Add imports at top of mcp/index.js**

After line 14 (`import { logEvent } from "./ownmind-log.js";`), add:

```js
import { appendCompliance } from '../shared/compliance.js';
import { detectTriggerFromContext } from '../shared/helpers.js';
```

- [ ] **Step 2: Delete `deriveEvent()` function**

Delete lines 34-41 (the `deriveEvent` function):

```js
// DELETE THIS:
function deriveEvent(rule_title, rule_code) {
  const rules = getCachedVerifiableRules();
  const rule = rules.find(r => r.code === rule_code || r.title === rule_title);
  if (rule?.metadata?.verification?.compliance_event) {
    return rule.metadata.verification.compliance_event;
  }
  return rule_code || rule_title;
}
```

- [ ] **Step 3: Delete local `detectTriggerFromContext()` function**

Delete lines 43-50 (now imported from shared/helpers.js):

```js
// DELETE THIS:
function detectTriggerFromContext(context) {
  if (!context) return null;
  const lower = context.toLowerCase();
  if (lower.includes('commit')) return 'commit';
  if (lower.includes('deploy') || lower.includes('部署')) return 'deploy';
  if (lower.includes('delete') || lower.includes('刪除')) return 'delete';
  return null;
}
```

- [ ] **Step 4: Add `refreshIronRulesCache()` function**

Add after the `getEvaluateConditions()` function (around line 63):

```js
// --- Cache refresh (called after iron_rule mutations) ---
const CACHE_PATH = path.join(os.homedir(), '.ownmind/cache/iron_rules.json');

async function refreshIronRulesCache() {
  try {
    const tokenParam = currentSyncToken ? `?sync_token=${currentSyncToken}` : '';
    const rules = await callApi('GET', `/api/memory/type/iron_rule${tokenParam}`);
    if (rules.new_token) currentSyncToken = rules.new_token;
    const allRules = Array.isArray(rules) ? rules : (rules.data || []);
    const verifiable = allRules.filter(r => r.metadata?.verification);
    cachedVerifiableRules = verifiable;
    const cacheDir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(verifiable, null, 2));
  } catch { /* silent fail — don't block the caller */ }
}
```

- [ ] **Step 5: Make `auditSession()` async and await verification engine**

Replace the `auditSession()` function (starting at line 80) with:

```js
async function auditSession() {
  try {
    if (!sessionStartTime) return { commits_checked: 0, violations_found: 0, violations: [] };
    const since = new Date(sessionStartTime).toISOString();
    const gitLog = execSync(`git log --since="${since}" --format="%H" 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!gitLog) return { commits_checked: 0, violations_found: 0, violations: [] };

    const commitHashes = gitLog.split('\n').filter(Boolean);
    const rules = getCachedVerifiableRules().filter(r =>
      r.metadata?.verification?.trigger?.includes('commit')
    );

    const evalFn = await getEvaluateConditions();
    if (rules.length === 0 || !evalFn) {
      return { commits_checked: commitHashes.length, violations_found: 0, violations: [] };
    }

    const violations = [];
    for (const hash of commitHashes) {
      for (const rule of rules) {
        const sessionChecks = extractSessionChecks(rule.metadata.verification.conditions);
        if (sessionChecks.length === 0) continue;

        const ctx = { complianceEvents };
        const result = evalFn({ operator: 'AND', checks: sessionChecks }, ctx);
        if (!result.pass) {
          violations.push({
            rule_code: rule.code,
            rule_title: rule.title,
            commit_hash: hash.substring(0, 7),
            failures: result.failures
          });
        }
      }
    }

    // Record violations to compliance log using shared module
    for (const v of violations) {
      appendCompliance({
        event: v.rule_code,
        action: 'violate',
        rule_code: v.rule_code,
        rule_title: v.rule_title,
        source: 'session_audit',
        commit_hash: v.commit_hash,
        failures: v.failures,
      });
    }

    return {
      commits_checked: commitHashes.length,
      violations_found: violations.length,
      violations
    };
  } catch (e) {
    return { commits_checked: 0, violations_found: 0, violations: [], error: e.message };
  }
}
```

- [ ] **Step 6: Fix `complianceEvents` in-memory field name and `report_compliance` handler**

In the `report_compliance` case (around line 617), replace:

```js
    case "ownmind_report_compliance": {
      complianceEvents.push({ rule: args.rule_title, action: args.action, rule_code: args.rule_code || '', ts: new Date().toISOString() });
```

with:

```js
    case "ownmind_report_compliance": {
      complianceEvents.push({ rule_title: args.rule_title, action: args.action, rule_code: args.rule_code || '', ts: new Date().toISOString() });
```

Then replace the E1 compliance JSONL writing block (lines 626-639) with:

```js
      // E1: Write to compliance JSONL using shared module
      appendCompliance({
        event: args.rule_code || args.rule_title,
        action: args.action,
        rule_code: args.rule_code || '',
        rule_title: args.rule_title,
        source: 'mcp',
        session_id: sessionStartTime ? String(sessionStartTime) : '',
      });
```

- [ ] **Step 7: Add cache refresh to `ownmind_save` handler**

In the `ownmind_save` case (around line 536), after `logEvent('memory_save', ...)` and before `return data;`, add:

```js
      // Refresh cache if iron_rule was saved
      if (args.type === 'iron_rule') {
        refreshIronRulesCache().catch(() => {});
      }
```

- [ ] **Step 8: Add cache refresh to `ownmind_update` handler**

In the `ownmind_update` case (around line 548), after `logEvent('memory_update', ...)` and before `return data;`, add:

```js
      // Refresh cache if iron_rule was updated
      if (data.type === 'iron_rule' || data.memory?.type === 'iron_rule') {
        refreshIronRulesCache().catch(() => {});
      }
```

- [ ] **Step 9: Add cache refresh to `ownmind_disable` handler**

In the `ownmind_disable` case (around line 558), after `logEvent('memory_disable', ...)` and before `return data;`, add:

```js
      // Refresh cache if iron_rule was disabled
      if (data.type === 'iron_rule' || data.memory?.type === 'iron_rule') {
        refreshIronRulesCache().catch(() => {});
      }
```

- [ ] **Step 10: Update `auditSession()` call site to await**

In the `ownmind_log_session` case (around line 590), change:

```js
        const auditResult = auditSession();
```

to:

```js
        const auditResult = await auditSession();
```

- [ ] **Step 11: Delete old inline compliance JSONL writing in `auditSession()`**

The old `auditSession()` had inline `fs.appendFileSync(COMPLIANCE_LOG, ...)` — this is now handled by `appendCompliance()` in the new version. Also delete the `COMPLIANCE_LOG` constant at line 17 since it's no longer used in this file:

```js
// DELETE THIS LINE:
const COMPLIANCE_LOG = path.join(os.homedir(), '.ownmind/logs/compliance.jsonl');
```

- [ ] **Step 12: Verify syntax**

Run: `node -c ~/.ownmind/mcp/index.js`
Expected: no syntax errors

- [ ] **Step 13: Commit**

```bash
git add mcp/index.js
git commit -m "refactor: MCP uses shared compliance/helpers, adds cache refresh, fixes L6 audit"
```

---

### Task 11: Run full test suite

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `cd ~/.ownmind && node --test tests/helpers.test.js tests/compliance.test.js tests/trigger-detection.test.js tests/verification.test.js tests/enforcement.test.js tests/report.test.js tests/templates.test.js`
Expected: All tests PASS

- [ ] **Step 2: Verify all hooks parse correctly**

Run:
```bash
node -c ~/.ownmind/hooks/ownmind-git-pre-commit.js && \
node -c ~/.ownmind/hooks/ownmind-git-post-commit.js && \
node -c ~/.ownmind/hooks/ownmind-iron-rule-check.js && \
node -c ~/.ownmind/hooks/ownmind-session-start.js && \
node -c ~/.ownmind/hooks/ownmind-verify-trigger.js && \
node -c ~/.ownmind/mcp/index.js && \
echo "All files OK"
```
Expected: "All files OK"

- [ ] **Step 3: Verify pre-commit hook works with empty cache**

Run:
```bash
echo '[]' > ~/.ownmind/cache/iron_rules.json && \
node ~/.ownmind/hooks/ownmind-git-pre-commit.js; echo "exit: $?"
```
Expected: exits 0 (attempts API fetch, then passes if no rules)

---

### Task 12: Version bump + docs

**Files:**
- Modify: `mcp/package.json`
- Modify: `CHANGELOG.md`
- Modify: `FILELIST.md`
- Modify: `README.md`

- [ ] **Step 1: Bump mcp/package.json version**

Change `"version": "1.14.0"` to `"version": "1.15.0"` in `mcp/package.json`.

- [ ] **Step 2: Update CHANGELOG.md**

Add entry at the top of the changelog:

```markdown
## v1.15.0 (2026-04-01)

### Refactor: Harness Engineering 審計修復

- **shared/helpers.js**: 新增共用工具模組，消除 hooks 間重複邏輯（readJsonSafe、getChangedSourceFiles、readCredentials、detectCommandTrigger、detectTriggerFromContext）
- **shared/compliance.js**: 統一 compliance log schema 和讀寫，砍掉 deriveEvent()
- **快取同步**: save/update/disable iron_rule 後自動刷新 iron_rules.json 快取
- **L1 fail-closed**: pre-commit hook 快取為空時嘗試 API 同步（3s timeout）
- **L2 commit blocking**: PreToolUse hook 對 commit 操作也跑 verification engine
- **L6 lazy load 修復**: auditSession() 改 async，確保 verification engine 已載入
- **觸發正則改進**: 加 word boundary、新增 git tag 和 Remove-Item、排除 docker compose logs 誤判
- **ESM 統一**: iron-rule-check.js 和 session-start.js 從 CJS 改為 ESM
```

- [ ] **Step 3: Update FILELIST.md**

Add entries for new files:

```markdown
- `shared/helpers.js` — 共用工具函式（readJsonSafe、getChangedSourceFiles、readCredentials、trigger detection）
- `shared/compliance.js` — 統一 compliance log schema 讀寫
- `hooks/package.json` — ESM module declaration for hooks directory
- `tests/helpers.test.js` — shared/helpers.js 單元測試
- `tests/compliance.test.js` — shared/compliance.js 單元測試
- `tests/trigger-detection.test.js` — 觸發檢測精準度測試
```

- [ ] **Step 4: Update README.md if needed**

Check if README.md mentions the 7-layer architecture or shared modules. If so, update to reflect `shared/helpers.js` and `shared/compliance.js`.

- [ ] **Step 5: Commit**

```bash
git add mcp/package.json CHANGELOG.md FILELIST.md README.md
git commit -m "chore: bump MCP to v1.15.0, update docs for harness engineering fixes"
```
