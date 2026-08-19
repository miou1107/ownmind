# 規範強制執行機制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 OwnMind 在 AI 違反任何一條規範／鐵律／原則時當場察覺並回饋，而不是收工後才寫進稽核報告。

**Architecture:** 三層。(1) 伺服器端「查核服務」：由帳號開關決定是否啟用，挑出當下相關規範全文，交給獨立模型判斷 AI 剛剛那一輪有無違反，結果寫進查核紀錄表。(2) 用戶端 Stop hook 把每輪輸出送去查核，違規時以 `exit 2` 退回給 AI 更正。(3) 用戶端 PreToolUse 硬擋：對可機械判斷的規範（禁區路徑）在動作發生前直接擋下。

**Tech Stack:** Node.js 20 ESM、Express 5、PostgreSQL（pgvector 映像）、`node --test`、Claude Code hooks（PreToolUse / Stop / UserPromptSubmit）、既有 `callLLMSwitch`（OpenAI 相容端點）。

**Spec:** `docs/superpowers/specs/2026-08-13-standard-enforcement-design.md`

## Global Constraints

- **語言**：所有新程式碼的註解、log、錯誤訊息、變數名一律英文（本 repo CLAUDE.md「軌道 B」）。設計文件與本計畫保持中文。
- **失敗一律 fail-open**：查核服務不通、逾時、模型出錯 → 放行，**但必須留痕**（終端機一行 ＋ 紀錄）。靜默放行是本專案最嚴重的失敗形態。
- **帳號開關預設 off**：`users.enforcement_mode` 預設 `'off'`。伺服器在呼叫模型之前先檢查，`off` 直接回空。名單外的人零成本、零延遲。
- **不得宣稱「強制遵守」**：README／CHANGELOG 只能寫「動作層強制、回話層即時查核」。
- **每次 commit 同步更新** `README.md`、`docs/README.zh-TW.md`、`docs/README.ja.md`、`FILELIST.md`、`CHANGELOG.md`（IR-008 / IR-026 / IR-032）。
- **Server + Client 兩端都要檢查**（IR-022）。
- **測試指令**：`npm test`（＝ `node --test` ＋ `lint:zh-only`）。單檔：`node --test tests/<name>.test.js`。
- **新 migration 編號從 `025_` 起**（現有最大為 `024_`）。
- **突變測試**：spec §7.1 的每一列都要有一個對應測試，且必須親眼看它紅過一次（IR-134）。
- 🔴 **接縫不准兩端都造假**（IR-128，本計畫第一版每一個致命缺陷的共同形狀）：每一個接縫至少一條測試接到真的對手 —— 真的 `auth` 中介層、真的 `callLLMSwitch` 打 stub HTTP server、真的 Postgres 容器、由真的同步程式寫出來的快取、真的 `.sh` hook。清單與工具見 Task 0。
- **執行順序**：0 → 0.5 → 1 → 2 → 3 → 4 → 5 → 7 → 8 → 6 → 9 → 10 → 11 → 12 → 13。Task 6 依賴 Task 0.5 與 8 的產出，故排在其後。

---

## File Structure

**新增（伺服器）**
- `db/025_enforcement.sql` — `users.enforcement_mode` 欄位 ＋ `compliance_checks` 紀錄表
- `src/lib/enforcement/select-rules.js` — 挑出本輪要查的規範（純函式，可單測）
- `src/lib/enforcement/judge-prompt.js` — 組出給模型的提示（純函式）
- `src/lib/enforcement/judge.js` — 呼叫模型、解析結果
- `src/routes/compliance.js` — `POST /api/compliance/check`、`POST /api/compliance/feedback`

**新增（用戶端）**
- `hooks/lib/compliance-client.js` — 送查核請求、逾時退避、留痕
- `hooks/lib/path-guard.js` — 禁區路徑硬擋的判斷（純函式 ＋ repo 解析）
- `hooks/ownmind-prompt-inject.js` — UserPromptSubmit hook

**修改**
- `src/app.js:154` 附近 — 掛載 compliance 路由
- `src/routes/memory.js` — 擋下會抹掉 `enforcement` 的 metadata 更新
- `hooks/ownmind-reply-lint.js` — 接上查核、規範違規不走共用門檻
- `hooks/ownmind-edit-reminder.js` — 加入硬擋出口
- `hooks/lib/conditional-sync.js` — 空回應不得覆蓋既有快取
- `scripts/install-helpers/ensure-pretooluse-hooks.cjs` — 註冊 UserPromptSubmit
- `install.sh` / `install.ps1` — 同上

---

## Task 0: 接縫防偽測試骨架（第一件事，不准跳過）

**Files:**
- Create: `tests/helpers/real-seams.mjs`
- Create: `tests/enforcement-seams.test.js`

**為什麼這是第一個任務：** 前一版計畫的每一個致命缺陷都長在同一個形狀上 —— **測試把介面兩端都換成假的**（IR-128）。假的模型回字串、假的資料列自己注入、假的快取自己餵進去，所以測試全綠而產線全死。本任務先把「真的對手」準備好，後面每一個任務都必須至少有一條測試接到真的那一端。

**規則（寫進本計畫的 Global Constraints，違反即不得合併）：**
每一個接縫至少一條測試用真的對手。清單：

| 接縫 | 真的對手 |
|---|---|
| 用戶端 → 伺服器認證 | 真的 `auth` 中介層（不是注入 `req.user`） |
| 伺服器 → 模型 | 真的 `callLLMSwitch` 打一個本機 stub HTTP server |
| 伺服器 → 資料庫 | 真的 Postgres 容器 ＋ 本 repo 全部 migration |
| 用戶端 → 快取 | 由**真的同步程式**寫出來的檔案，不是測試自己寫的 JSON |
| Claude Code → hook | 真的 `ownmind-iron-rule-check.sh`，HOME 指向暫存安裝目錄 |

- [ ] **Step 1: 寫 helper**

```javascript
// tests/helpers/real-seams.mjs
/**
 * The real counterparts, so no test in this feature fakes both ends of a seam.
 *
 * Every critical defect found in the two adversarial reviews of this plan had the same
 * shape: a test that injected its own data on one side and its own stub on the other, so
 * the seam between them was never exercised and a wrong assumption about the real
 * counterpart survived all the way to production while the suite stayed green.
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A stub OpenAI-compatible endpoint. Returns whatever `reply` produces, as the model would. */
export async function startStubLlm(reply) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const content = typeof reply === 'function' ? reply(JSON.parse(body)) : reply;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** A real Postgres with this repo's migrations applied. Skips (returns null) when docker is absent. */
export async function startRealDb({ image = 'pgvector/pgvector:pg16', port = 55433 } = {}) {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const name = `enforcement-test-db-${port}`;
  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* none */ }
  execFileSync('docker', ['run', '-d', '--name', name,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_USER=ownmind', '-e', 'POSTGRES_DB=ownmind',
    '-p', `${port}:5432`, image], { stdio: 'ignore' });
  for (let i = 0; i < 40; i += 1) {
    try {
      execFileSync('docker', ['exec', name, 'pg_isready', '-U', 'ownmind', '-d', 'ownmind'], { stdio: 'ignore' });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return {
    name,
    connectionString: `postgres://ownmind:test@127.0.0.1:${port}/ownmind`,
    stop: () => { try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* gone */ } },
  };
}

/** A throwaway ~/.ownmind so the .sh hook can be exercised without touching the real one. */
export function makeFakeHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'om-home-'));
  return { home: dir, hooksDir: path.join(dir, '.ownmind', 'hooks') };
}
```

- [ ] **Step 2: 用 helper 證明三個接縫（這三條測試現在就要綠）**

```javascript
// tests/enforcement-seams.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLLMSwitch } from '../src/lib/llm-narrative.js';
import { startStubLlm } from './helpers/real-seams.mjs';

test('callLLMSwitch hands back a parsed object, not a string', async () => {
  // The single assumption whose being wrong would have made the judge report nothing,
  // forever, with a green suite. Asserted against the real function.
  const stub = await startStubLlm(JSON.stringify({ verdicts: [{ ruleId: 1, violated: false }] }));
  const result = await callLLMSwitch({
    apiKey: 'k', apiBase: stub.base, messages: [{ role: 'user', content: 'x' }],
    retries: 0, timeoutMs: 5000, overallTimeoutMs: 5000,
  });
  assert.equal(typeof result, 'object');
  assert.ok(Array.isArray(result.verdicts));
  assert.equal(result.content, undefined);
  stub.close();
});

test('prose from the model throws rather than arriving as text', async () => {
  const stub = await startStubLlm('I think it is fine');
  await assert.rejects(
    () => callLLMSwitch({
      apiKey: 'k', apiBase: stub.base, messages: [{ role: 'user', content: 'x' }],
      retries: 0, timeoutMs: 5000, overallTimeoutMs: 5000,
    }),
    /parse failed/i,
  );
  stub.close();
});

test('the request body the helper sends is the one we think it is', async () => {
  let seen = null;
  const stub = await startStubLlm((body) => { seen = body; return JSON.stringify({ verdicts: [] }); });
  await callLLMSwitch({
    apiKey: 'k', apiBase: stub.base, messages: [{ role: 'user', content: 'x' }],
    retries: 0, timeoutMs: 5000, overallTimeoutMs: 5000,
  });
  assert.equal(seen.response_format.type, 'json_object');
  assert.ok(seen.max_tokens >= 1000, 'a verdict list must fit in the output budget');
  stub.close();
});
```

- [ ] **Step 3: 跑**

Run: `node --test tests/enforcement-seams.test.js`
Expected: PASS（3 tests）。這三條已於 2026-08-13 用同樣的手法實跑驗證過，結果即本計畫其餘部分的依據。

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/real-seams.mjs tests/enforcement-seams.test.js
git commit -m "test(enforcement): real counterparts for every seam this feature crosses"
```

---

## Task 0.5: 規範配送路徑（沒有這個，後面的硬擋全是空的）

**Files:**
- Create: `src/routes/enforcement-bundle.js`
- Create: `hooks/lib/enforcement-cache.js`（讀取端，Task 8 會用）
- Modify: `src/app.js`
- Modify: `hooks/ownmind-session-start.js`（同步時順便抓 bundle）
- Test: `tests/enforcement-bundle.test.js`

**Interfaces:**
- Produces: `GET /api/memory/enforcement-bundle` → `{ selectors: [{id, type, tags, keywords, always_check}], guards: [{id, title, repo_match, paths, owner}] }`
- Produces: `readEnforcementBundle(cachePath)` → `{selectors, guards, injectables, present}`（唯一的讀取入口，呼叫端自己挑清單）

**背景（實測，非推論）：** 讀 Vin 本機的 `~/.ownmind/cache/memories.json`，裡面**沒有任何團隊規範的內容** —— 只有 digest 字串與 5 筆 `{id,title,hint}`。`shared/init-cache.js` 也明寫 compact init「no team_standards at all」。因此**今天沒有任何機制把規範送到用戶端**，硬擋沒有資料可讀。

**設計要點：** bundle **不含規範內文**。內文留在伺服器，判官直接查資料庫（所以「全部規範都做」不受用戶端涵蓋率限制）。實測每條規範的 enforcement metadata 只有 39～171 位元組，150 條約 20KB。

- [ ] **Step 1: 寫失敗測試（含真資料庫接縫）**

```javascript
// tests/enforcement-bundle.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle } from '../src/routes/enforcement-bundle.js';

const rows = [
  { id: 412, type: 'team_standard', title: 'ci ownership', tags: ['trigger:ci'],
    metadata: { enforcement: { keywords: ['FAPA'], guard: { repo_match: 'fapa-repo', paths: ['ci/**'], owner: 'Eric' } } } },
  { id: 125, type: 'iron_rule', title: 'conclusion first', tags: ['trigger:always'],
    metadata: { enforcement: { always_check: true } } },
  { id: 7, type: 'iron_rule', title: 'no enforcement block', tags: ['trigger:edit'], metadata: {} },
];

test('selectors carry every rule, including ones with no enforcement block', () => {
  // Selection has to be able to consider a rule the user never annotated - Vin's
  // instruction was "all rules", and an annotate-first design would silently cover two.
  const { selectors } = buildBundle(rows);
  assert.deepEqual(selectors.map((s) => s.id).sort(), [7, 125, 412]);
});

test('selectors carry no rule text', () => {
  const { selectors } = buildBundle(rows);
  for (const s of selectors) {
    assert.equal(s.content, undefined);
    assert.ok(JSON.stringify(s).length < 400, 'a selector must stay small');
  }
});

test('guards carry only the rules with a guard block', () => {
  const { guards } = buildBundle(rows);
  assert.deepEqual(guards.map((g) => g.id), [412]);
  assert.deepEqual(guards[0].paths, ['ci/**']);
  assert.equal(guards[0].owner, 'Eric');
});

test('tags survive, because selection uses them for un-annotated rules', () => {
  const { selectors } = buildBundle(rows);
  assert.deepEqual(selectors.find((s) => s.id === 7).tags, ['trigger:edit']);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/enforcement-bundle.test.js`
Expected: FAIL — `Cannot find module ... enforcement-bundle.js`

- [ ] **Step 3: 實作**

```javascript
// src/routes/enforcement-bundle.js
/**
 * What the client needs in order to decide two things locally: is anything relevant this
 * turn, and is this file off limits. Deliberately carries no rule text.
 *
 * Rule text stays on the server, where the judge already is. That keeps the payload at
 * roughly 20KB for 150 rules (measured: 39-171 bytes of enforcement metadata per rule),
 * avoids scattering every standard across every machine, and - the part that matters -
 * means the judge's coverage is bounded by the database rather than by whatever the client
 * managed to cache.
 */

import { Router } from 'express';
import { query as defaultQuery } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { buildReadableWhere } from '../utils/memory-visibility.js';

const BUNDLE_TYPES = ['iron_rule', 'team_standard', 'principle', 'coding_standard'];

/**
 * Three lists, because three consumers need three different things.
 *
 *   selectors   every rule, no text        - the client's "is anything relevant" pre-filter
 *   guards      path rules, no text        - the hard block
 *   injectables annotated rules, WITH text - what gets put in front of the AI at prompt time
 *
 * The first draft of this bundle had only the first two and stripped text everywhere, which
 * quietly broke injection: its whole job is to put the rule's words in front of the AI, and
 * it had been left with nothing but a title. Text is bounded here by how many rules carry an
 * enforcement block, not by how many rules exist.
 *
 * All three are FLAT. `metadata.enforcement.guard.paths` does not survive this function, so
 * no client-side consumer may reach for it - an earlier draft of the client had every match
 * function reading the nested shape, which meant every one of them returned false in
 * production while its tests, fed hand-built database rows, stayed green.
 *
 * @param {Array<object>} rows
 * @returns {{selectors: Array<object>, guards: Array<object>, injectables: Array<object>}}
 */
export function buildBundle(rows) {
  const selectors = [];
  const guards = [];
  const injectables = [];
  for (const row of rows || []) {
    const e = row?.metadata?.enforcement || {};
    const keywords = Array.isArray(e.keywords) ? e.keywords : [];
    const alwaysCheck = e.always_check === true;
    const g = e.guard;
    const hasGuard = !!(g && Array.isArray(g.paths) && g.paths.length > 0);

    selectors.push({
      id: row.id,
      type: row.type,
      tags: Array.isArray(row.tags) ? row.tags : [],
      keywords,
      always_check: alwaysCheck,
      repo_match: hasGuard ? (g.repo_match || '') : '',
    });

    if (hasGuard) {
      guards.push({
        id: row.id,
        title: row.title || '',
        repo_match: g.repo_match || '',
        paths: g.paths,
        owner: g.owner || '',
      });
    }

    // Only annotated rules carry their text to the client. An unannotated rule is still
    // judged - the judge reads the database - it simply is not injected up front.
    if (keywords.length > 0 || alwaysCheck || hasGuard) {
      injectables.push({
        id: row.id,
        title: row.title || '',
        content: row.judge_text || row.content || '',
        keywords,
        always_check: alwaysCheck,
        repo_match: hasGuard ? (g.repo_match || '') : '',
        paths: hasGuard ? g.paths : [],
        owner: hasGuard ? (g.owner || '') : '',
      });
    }
  }
  return { selectors, guards, injectables };
}

export function createEnforcementBundleRouter({ queryFn = defaultQuery } = {}) {
  const router = Router();
  router.get('/', async (req, res) => {
    try {
      // buildReadableWhere, not an owner filter: a team standard uploaded by a colleague is
      // exactly the case this feature exists for, and an owner-scoped query cannot see one.
      const r = await queryFn(
        `SELECT m.id, m.type, m.title, m.tags, m.metadata
           FROM memories m
          WHERE m.status = 'active'
            AND m.type IN (${BUNDLE_TYPES.map((_, i) => `$${i + 2}`).join(', ')})
            AND ${buildReadableWhere({ alias: 'm', userParam: '$1' })}`,
        [req.user?.id, ...BUNDLE_TYPES],
      );
      return res.json(buildBundle(r.rows));
    } catch (err) {
      logger.warn?.('enforcement-bundle failed', { err: err.message });
      return res.status(500).json({ error: 'failed to build bundle' });
    }
  });
  return router;
}

const router = Router();
router.use(auth);
router.use(createEnforcementBundleRouter());
export default router;
```

**掛載位置：註冊在 `memory.js` 的 router 裡，且必須在 `router.get('/:id')` 之上。**

🔴 不可以在 `src/app.js` 用 `app.use('/api/memory/enforcement-bundle', ...)`。`src/app.js:166` 已經掛了 `app.use('/api/memory', memoryRoutes)`，而 `src/routes/memory.js:1020` 有 `router.get('/:id')` —— 請求會先被它接走，拿 `id='enforcement-bundle'` 去跑 `WHERE m.id = $1`，整數轉型失敗、catch 回 500，新路由永遠到不了。用戶端只會看到「同步失敗」，而空回應保護會讓快取永遠是空的：靜默失效。

在 `src/routes/memory.js` 的 `router.get('/:id')` **之前**加入：

```javascript
import { createEnforcementBundleRouter } from './enforcement-bundle.js';

// Before `/:id`, or Express hands `enforcement-bundle` to it as an id and the integer cast
// fails into a 500 that the client can only read as "the server is broken".
router.use('/enforcement-bundle', createEnforcementBundleRouter());
```

**驗收**：一個真正掛載整個 app 的測試打 `GET /api/memory/enforcement-bundle`，斷言拿到 200 與 `{selectors, guards, injectables}`，不是 500。只測 `buildBundle` 這支純函式**不算數**。

- [ ] **Step 4: 用戶端讀取端（`hooks/lib/enforcement-cache.js`）**

見 Task 8 Step 4 的完整內容 —— 該檔在此建立，Task 8 只是使用者。

- [ ] **Step 5: 同步端 —— 寫在兩個平台都會跑的那支，不是 `.js`**

🔴 **這裡差點重演同一個錯誤。** 上一版把同步寫進 `hooks/ownmind-session-start.js`，但 `scripts/install-helpers/session-hook-command.cjs:38` 寫著 `const UNIX_COMMAND = 'bash ~/.claude/hooks/ownmind-session-start.sh'`，第 49 行 `if (platform !== 'win32') return UNIX_COMMAND` —— **`.js` 只有 Windows 會跑**。Vin 的 Mac 是唯一啟用的帳號，照上一版寫，他的機器永遠不會有這份快取，三層全部靜靜失效。

**改為寫在 `hooks/lib/conditional-sync-cli.js`**（兩個平台的 SessionStart 都會呼叫它），流程：

1. `GET /api/memory/enforcement-bundle`，Bearer 認證；
2. 寫入 `~/.ownmind/cache/enforcement.json`；
3. **空回應不得覆蓋**：`selectors` 為空但既有快取非空 → 不寫；
4. 抓取失敗 → 保留舊快取，並在終端機留一行「規範清單未更新」，不得靜默。

**驗收（Task 0 的規則：不准兩端都造假）**：測試必須跑**真的** `conditional-sync-cli.js`（HOME 指向暫存目錄、伺服器用 stub），再由 `readEnforcementBundle()` 讀那支程式**真正寫出來的檔案**。測試自己寫一份 JSON 不算數。

**突變列**：把 Unix 路徑的抓取拿掉 → 上述端到端測試必須轉紅。

- [ ] **Step 6: 真資料庫接縫測試**

用 Task 0 的 `startRealDb()` 起容器、套 migration、插入「規範 412 屬於 user 2、fragment 413 帶禁止清單、user 1 是查詢者」的 fixture，斷言：

1. `buildReadableWhere` 版本的查詢**撈得到 412**；
2. 換成 `WHERE user_id = $1` 的版本**撈不到**（這條是反證，確認測試真的在測那件事）；
3. `attachStandardFragments` 把 413 的禁止清單併進來。

docker 不可用時 `test.skip` 並印出原因，不得靜默跳過。

（此三項已於 2026-08-13 用真容器實跑驗證，結果見 spec「伺服器查詢」一節。）

- [ ] **Step 7: Commit**

```bash
git add src/routes/enforcement-bundle.js hooks/lib/enforcement-cache.js src/app.js \
        hooks/ownmind-session-start.js tests/enforcement-bundle.test.js
git commit -m "feat(enforcement): ship selection keys and guard rules to the client"
```

---

## Task 1: 資料庫骨架（帳號開關 ＋ 查核紀錄表）

**Files:**
- Create: `db/025_enforcement.sql`
- Test: `tests/enforcement-migration.test.js`

**Interfaces:**
- Produces: `users.enforcement_mode`（`'off' | 'check'`，預設 `'off'`）；`compliance_checks` 表供 Task 4、10 寫入與查詢。

- [ ] **Step 1: 寫失敗測試**

```javascript
// tests/enforcement-migration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Comments stripped before asserting. Otherwise every assertion below is satisfied by a
// commented-out statement, and the migration "passes" while creating nothing.
const raw = readFileSync(new URL('../db/025_enforcement.sql', import.meta.url), 'utf8');
const sql = raw.replace(/--[^\n]*/g, '');

test('adds enforcement_mode to users, defaulting to off', () => {
  assert.match(sql, /ALTER TABLE users\s+ADD COLUMN IF NOT EXISTS enforcement_mode/i);
  assert.match(sql, /DEFAULT 'off'/i);
  assert.match(sql, /CHECK \(enforcement_mode IN \('off', 'check'\)\)/i);
});

test('creates compliance_checks with the columns the metrics in spec section 9 need', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compliance_checks/i);
  for (const col of [
    'user_id', 'session_id', 'turn_index', 'rules_considered',
    'verdicts', 'latency_ms', 'outcome', 'user_feedback', 'created_at',
  ]) {
    assert.match(sql, new RegExp(`\\b${col}\\b`), `missing column ${col}`);
  }
});

test('outcome distinguishes a check that did not run from a clean check', () => {
  // "not run" must never look like "ran and found nothing" - spec section 4.2.
  assert.match(sql, /CHECK \(outcome IN \('clean', 'violation', 'skipped', 'failed'\)\)/i);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-migration.test.js`
Expected: FAIL — `ENOENT: no such file or directory ... db/025_enforcement.sql`

- [ ] **Step 3: 寫 migration**

```sql
-- db/025_enforcement.sql
-- Migration 025: standard enforcement.
--
-- Two things: a per-account switch, and the record every check writes.
--
-- The switch lives on the account, not on the machine: the owner works from several
-- machines and several AI tools, and a per-machine flag would leave whichever machine
-- nobody remembered to configure unprotected. It also means widening the rollout to the
-- team is an UPDATE, not a release.
--
-- Default 'off' is what makes this safe to ship to everyone at once: the server returns
-- an empty result before it reaches the model, so accounts outside the pilot pay no
-- latency and no tokens.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS enforcement_mode VARCHAR(10) NOT NULL DEFAULT 'off';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_enforcement_mode_check;
ALTER TABLE users ADD CONSTRAINT users_enforcement_mode_check
  CHECK (enforcement_mode IN ('off', 'check'));

-- One row per check attempt.
--
-- `outcome` separates 'skipped'/'failed' from 'clean' on purpose. A check that never ran
-- and a check that ran and found nothing are the same shape to a naive schema, and
-- collapsing them would make the "did not run" rate in the pilot's exit criteria
-- unmeasurable - the precise way a broken guard comes to look like a working one.
--
-- `rules_considered` is stored even when the verdict is clean, because "the rule was
-- never selected" and "the rule was selected and the judge got it wrong" need different
-- fixes, and telling them apart afterwards is impossible without this column.
CREATE TABLE IF NOT EXISTS compliance_checks (
    id                SERIAL PRIMARY KEY,
    user_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id        VARCHAR(128) NOT NULL,
    turn_index        INT,
    rules_considered  JSONB NOT NULL DEFAULT '[]',
    verdicts          JSONB NOT NULL DEFAULT '[]',
    latency_ms        INT,
    outcome           VARCHAR(20) NOT NULL,
    user_feedback     VARCHAR(20),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE compliance_checks DROP CONSTRAINT IF EXISTS compliance_checks_outcome_check;
ALTER TABLE compliance_checks ADD CONSTRAINT compliance_checks_outcome_check
  CHECK (outcome IN ('clean', 'violation', 'skipped', 'failed'));

ALTER TABLE compliance_checks DROP CONSTRAINT IF EXISTS compliance_checks_feedback_check;
ALTER TABLE compliance_checks ADD CONSTRAINT compliance_checks_feedback_check
  CHECK (user_feedback IS NULL OR user_feedback IN ('correct', 'false_positive'));

CREATE INDEX IF NOT EXISTS idx_compliance_checks_user_created
  ON compliance_checks (user_id, created_at DESC);
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/enforcement-migration.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add db/025_enforcement.sql tests/enforcement-migration.test.js
git commit -m "feat(enforcement): add per-account switch and check record table"
```

---

## Task 2: 挑規範（純函式）

**Files:**
- Create: `src/lib/enforcement/select-rules.js`
- Test: `tests/enforcement-select-rules.test.js`

**Interfaces:**
- Produces: `selectRules(memories, context, opts) → { selected: Array<Memory>, budgetExceeded: boolean }`
  - `memories`：使用者的規範陣列（`{ id, type, code, title, content, tags, metadata, fragments }`）
  - `context`：`{ assistantText: string, userPrompts: string[], repoRemote: string|null, toolsUsed: string[] }`
  - `opts`：`{ maxRules = 10, maxChars = 40000 }`
- Consumes: 無（純函式，Task 4 呼叫）

**設計要點（來自 spec §4.2）：** 寧可多挑不可少挑；`always_check` 的規範永遠在場；team_standard 要把 `fragments` 併進 content 一起送（禁止清單常住在 fragment 裡）。

- [ ] **Step 1: 寫失敗測試**

```javascript
// tests/enforcement-select-rules.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRules } from '../src/lib/enforcement/select-rules.js';

const alwaysRule = {
  id: 1, type: 'iron_rule', code: 'IR-125', title: 'first line is the conclusion',
  content: 'talk to the owner conclusion-first', tags: ['trigger:always'],
  metadata: { enforcement: { always_check: true } },
};
const keywordRule = {
  id: 2, type: 'team_standard', title: 'FAPA onboarding',
  content: 'do not edit ci/projects.yml', tags: [],
  metadata: { enforcement: { keywords: ['FAPA', 'onboarding'] } },
};
const repoRule = {
  id: 3, type: 'team_standard', title: 'ci ownership',
  content: 'ci/ belongs to Eric', tags: [],
  metadata: { enforcement: { guard: { repo_match: 'fontrip-agentic-process-automation' } } },
};
const unrelated = {
  id: 4, type: 'iron_rule', code: 'IR-999', title: 'unrelated',
  content: 'nothing to do with anything', tags: ['trigger:deploy'], metadata: {},
};

const baseCtx = { assistantText: '', userPrompts: [], repoRemote: null, toolsUsed: [] };

test('always_check rules are selected even with no contextual match', () => {
  const { selected } = selectRules([alwaysRule, unrelated], baseCtx);
  assert.deepEqual(selected.map((r) => r.id), [1]);
});

test('a keyword in the user prompt selects the rule', () => {
  const { selected } = selectRules([keywordRule], { ...baseCtx, userPrompts: ['把 ownmind 搬到 FAPA'] });
  assert.deepEqual(selected.map((r) => r.id), [2]);
});

test('a keyword only in the assistant text also selects the rule', () => {
  // The 2026-08-13 incident: the violation was in what the AI said, not what the user asked.
  const { selected } = selectRules([keywordRule], { ...baseCtx, assistantText: 'I will edit ci/projects.yml' });
  assert.deepEqual(selected.map((r) => r.id), [2]);
});

test('repo_match selects the rule when the session repo matches', () => {
  const ctx = { ...baseCtx, repoRemote: 'https://git.fontrip.com/fontrip/fontrip-agentic-process-automation.git' };
  const { selected } = selectRules([repoRule], ctx);
  assert.deepEqual(selected.map((r) => r.id), [3]);
});

test('keyword matching is case-insensitive', () => {
  const { selected } = selectRules([keywordRule], { ...baseCtx, userPrompts: ['fapa migration'] });
  assert.deepEqual(selected.map((r) => r.id), [2]);
});

test('fragments are merged into the content that will be judged', () => {
  const fragmented = {
    id: 5, type: 'team_standard', title: 'with fragments', content: 'summary only', tags: [],
    metadata: { enforcement: { always_check: true } },
    fragments: [{ title: 'forbidden list', content: 'never edit ci/projects.yml' }],
  };
  const { selected } = selectRules([fragmented], baseCtx);
  assert.match(selected[0].judgeText, /summary only/);
  assert.match(selected[0].judgeText, /never edit ci\/projects\.yml/);
});

test('the budget caps the count and reports that it was exceeded', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    ...alwaysRule, id: 100 + i,
  }));
  const { selected, budgetExceeded } = selectRules(many, baseCtx, { maxRules: 6 });
  assert.equal(selected.length, 6);
  assert.equal(budgetExceeded, true);
});

test('the default budget is 6 rules, not an unbounded send', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ...alwaysRule, id: 200 + i }));
  const { selected } = selectRules(many, baseCtx);
  assert.equal(selected.length, 6);
});

test('an empty rule list yields an empty selection, not a crash', () => {
  const { selected, budgetExceeded } = selectRules([], baseCtx);
  assert.deepEqual(selected, []);
  assert.equal(budgetExceeded, false);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-select-rules.test.js`
Expected: FAIL — `Cannot find module ... select-rules.js`

- [ ] **Step 3: 實作**

```javascript
// src/lib/enforcement/select-rules.js
/**
 * Pick the rules worth judging this turn.
 *
 * This is the most fragile part of the whole feature: a rule that is not selected is a
 * rule that is not enforced, and it fails silently. So the bias is deliberately towards
 * over-selection, with a token budget - not a relevance threshold - as the only limit.
 * What was considered is recorded by the caller, because "never selected" and "selected
 * and misjudged" need different fixes and are indistinguishable afterwards otherwise.
 */

// 6 rules / 20k characters, not 10 / 40k. The judge runs on every matching turn, so the
// budget is what the user pays per turn in both latency and tokens. The client's local
// pre-filter means most turns send nothing at all; this caps the ones that do.
const DEFAULT_MAX_RULES = 6;
const DEFAULT_MAX_CHARS = 20_000;

/** Summary layer plus every fragment. A prohibition list often lives in a fragment. */
function buildJudgeText(rule) {
  const parts = [rule.content || ''];
  if (Array.isArray(rule.fragments)) {
    for (const f of rule.fragments) {
      if (!f) continue;
      const heading = f.title ? `\n\n## ${f.title}\n` : '\n\n';
      parts.push(heading + (f.content || ''));
    }
  }
  return parts.join('').trim();
}

function haystack(context) {
  return [
    context.assistantText || '',
    ...(Array.isArray(context.userPrompts) ? context.userPrompts : []),
  ].join('\n').toLowerCase();
}

function matchesKeyword(rule, hay) {
  const kws = rule?.metadata?.enforcement?.keywords;
  if (!Array.isArray(kws)) return false;
  return kws.some((k) => typeof k === 'string' && k && hay.includes(k.toLowerCase()));
}

function matchesRepo(rule, repoRemote) {
  const rm = rule?.metadata?.enforcement?.guard?.repo_match;
  if (!rm || typeof repoRemote !== 'string' || !repoRemote) return false;
  return repoRemote.includes(rm);
}

function isAlwaysCheck(rule) {
  return rule?.metadata?.enforcement?.always_check === true;
}

/**
 * @param {Array<object>} memories
 * @param {{assistantText?: string, userPrompts?: string[], repoRemote?: string|null, toolsUsed?: string[]}} context
 * @param {{maxRules?: number, maxChars?: number}} [opts]
 * @returns {{selected: Array<object>, budgetExceeded: boolean}}
 */
export function selectRules(memories, context = {}, opts = {}) {
  const maxRules = opts.maxRules ?? DEFAULT_MAX_RULES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Array.isArray(memories) || memories.length === 0) {
    return { selected: [], budgetExceeded: false };
  }

  const hay = haystack(context);
  const repoRemote = context.repoRemote || null;

  // Rank rather than filter: always_check first, then contextual matches. Everything that
  // matches at all is a candidate; only the budget removes anything.
  const candidates = [];
  for (const rule of memories) {
    if (!rule) continue;
    let rank = null;
    if (isAlwaysCheck(rule)) rank = 0;
    else if (matchesRepo(rule, repoRemote)) rank = 1;
    else if (matchesKeyword(rule, hay)) rank = 2;
    if (rank === null) continue;
    candidates.push({ rank, rule });
  }

  candidates.sort((a, b) => a.rank - b.rank || (a.rule.id || 0) - (b.rule.id || 0));

  const selected = [];
  let chars = 0;
  let budgetExceeded = false;
  for (const { rule } of candidates) {
    const judgeText = buildJudgeText(rule);
    if (selected.length >= maxRules || chars + judgeText.length > maxChars) {
      budgetExceeded = true;
      break;
    }
    chars += judgeText.length;
    selected.push({ ...rule, judgeText });
  }

  return { selected, budgetExceeded };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/enforcement-select-rules.test.js`
Expected: PASS（8 tests）

- [ ] **Step 5: Commit**

```bash
git add src/lib/enforcement/select-rules.js tests/enforcement-select-rules.test.js
git commit -m "feat(enforcement): select the rules to judge for a turn"
```

---

## Task 3: 查核提示與結果解析（純函式）

**Files:**
- Create: `src/lib/enforcement/judge-prompt.js`
- Test: `tests/enforcement-judge-prompt.test.js`

**Interfaces:**
- Produces:
  - `buildJudgeMessages({ rules, assistantText, userPrompts }) → Array<{role, content}>`
  - `normaliseVerdicts(judged: object) → { verdicts: Array<{ruleId:number, violated:boolean, evidence:string, fix:string}>, parseFailed: boolean }`
- Consumes: Task 2 的 `selected`（每筆含 `judgeText`）

- [ ] **Step 1: 寫失敗測試**

```javascript
// tests/enforcement-judge-prompt.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJudgeMessages, normaliseVerdicts } from '../src/lib/enforcement/judge-prompt.js';

const rules = [
  { id: 412, title: 'ci ownership', judgeText: 'Only Eric may edit ci/. No engineer may.' },
];

test('the prompt carries the rule id, title and full text', () => {
  const msgs = buildJudgeMessages({ rules, assistantText: 'I will edit ci/projects.yml', userPrompts: [] });
  const all = msgs.map((m) => m.content).join('\n');
  assert.match(all, /412/);
  assert.match(all, /ci ownership/);
  assert.match(all, /Only Eric may edit/);
  assert.match(all, /I will edit ci\/projects\.yml/);
});

test('the prompt tells the judge to quote evidence and to default to not-violated', () => {
  const msgs = buildJudgeMessages({ rules, assistantText: 'hello', userPrompts: [] });
  const all = msgs.map((m) => m.content).join('\n').toLowerCase();
  assert.match(all, /quote/);
  assert.match(all, /uncertain/);
});

test('accepts the parsed object callLLMSwitch actually returns', () => {
  const judged = {
    verdicts: [{ ruleId: 412, violated: true, evidence: 'I will edit ci/projects.yml', fix: 'open an issue for Eric' }],
  };
  const { verdicts, parseFailed } = normaliseVerdicts(judged);
  assert.equal(parseFailed, false);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].violated, true);
});

test('a bare string is a failure, not a clean result', () => {
  // Guards the exact mistake the first draft made: treating the return value as text.
  const { verdicts, parseFailed } = normaliseVerdicts('{"verdicts":[]}');
  assert.equal(parseFailed, true);
  assert.deepEqual(verdicts, []);
});

test('a shape with no verdicts array is a failure, never clean', () => {
  // Treating garbage as "no violations" is how a broken checker comes to look healthy.
  assert.equal(normaliseVerdicts({ answer: 'looks fine' }).parseFailed, true);
  assert.equal(normaliseVerdicts(null).parseFailed, true);
  assert.equal(normaliseVerdicts(undefined).parseFailed, true);
});

test('a verdict claiming a violation with no evidence is dropped', () => {
  const { verdicts } = normaliseVerdicts({ verdicts: [{ ruleId: 412, violated: true, evidence: '', fix: 'x' }] });
  assert.deepEqual(verdicts, []);
});

test('an empty verdicts array is clean, not a failure', () => {
  const { verdicts, parseFailed } = normaliseVerdicts({ verdicts: [] });
  assert.equal(parseFailed, false);
  assert.deepEqual(verdicts, []);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-judge-prompt.test.js`
Expected: FAIL — `Cannot find module ... judge-prompt.js`

- [ ] **Step 3: 實作**

```javascript
// src/lib/enforcement/judge-prompt.js
/**
 * Build the judge's prompt, and read its answer back.
 *
 * The judge is a separate model with one job. That separation is the point: the AI being
 * judged had already read these same rules and violated them anyway, so self-checking is
 * the thing that failed. Kept as pure functions so the wording and the parsing can be
 * tested without spending a token.
 */

const SYSTEM = [
  'You audit an AI assistant for compliance with its user\'s written rules.',
  'You are given the full text of each rule and the assistant\'s most recent reply.',
  'For every rule, decide whether that reply violates it.',
  '',
  'Hard requirements:',
  '- Quote the exact sentence from the reply as evidence. No quote means no violation.',
  '- If you are uncertain, answer violated=false. A false alarm costs the user more than a miss.',
  '- Judge only the reply given. Do not speculate about what the assistant might do later.',
  '- A reply that quotes a rule in order to comply with it is NOT a violation.',
  '',
  'Answer with JSON only, no prose, in exactly this shape:',
  '{"verdicts":[{"ruleId":<number>,"violated":<boolean>,"evidence":"<quote>","fix":"<one sentence>"}]}',
].join('\n');

/**
 * @param {{rules: Array<{id:number,title:string,judgeText:string}>, assistantText: string, userPrompts?: string[]}} args
 * @returns {Array<{role: string, content: string}>}
 */
export function buildJudgeMessages({ rules, assistantText, userPrompts = [] }) {
  const ruleBlock = rules.map((r) => (
    `--- RULE ${r.id}: ${r.title} ---\n${r.judgeText}`
  )).join('\n\n');

  const contextBlock = userPrompts.length
    ? `What the user asked (most recent last):\n${userPrompts.join('\n')}\n\n`
    : '';

  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${ruleBlock}\n\n=====\n\n${contextBlock}The assistant's reply to audit:\n${assistantText}`,
    },
  ];
}

/**
 * Validate the judge's answer.
 *
 * Takes the PARSED object, because that is what `callLLMSwitch` hands back - measured, not
 * assumed: it ends in `return parseLLMJson(content)` and throws on anything that is not
 * JSON. So there is no string to unwrap here, and the earlier draft's fenced-code-block
 * extraction was solving a problem this pipeline does not have. What is left is the part
 * that matters: refusing to treat a malformed answer as a clean one.
 *
 * @param {unknown} judged the object callLLMSwitch returned
 * @returns {{verdicts: Array<object>, parseFailed: boolean}}
 */
export function normaliseVerdicts(judged) {
  const parsed = judged;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.verdicts)) {
    return { verdicts: [], parseFailed: true };
  }

  // A violation without a quote is an assertion, not a finding. Dropping it here keeps the
  // false-positive rate the pilot measures from being inflated by unevidenced claims.
  const verdicts = parsed.verdicts.filter((v) => (
    v && typeof v.ruleId === 'number'
    && typeof v.violated === 'boolean'
    && (!v.violated || (typeof v.evidence === 'string' && v.evidence.trim().length > 0))
  )).map((v) => ({
    ruleId: v.ruleId,
    violated: v.violated,
    evidence: typeof v.evidence === 'string' ? v.evidence : '',
    fix: typeof v.fix === 'string' ? v.fix : '',
  }));

  return { verdicts, parseFailed: false };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/enforcement-judge-prompt.test.js`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add src/lib/enforcement/judge-prompt.js tests/enforcement-judge-prompt.test.js
git commit -m "feat(enforcement): judge prompt builder and verdict parser"
```

---

## Task 4: 查核 API

**Files:**
- Create: `src/routes/compliance.js`
- Modify: `src/app.js`（在既有 `app.use('/api/...')` 區塊加一行）
- Test: `tests/enforcement-route.test.js`

**Interfaces:**
- Consumes: `selectRules`（Task 2）、`buildJudgeMessages` / `normaliseVerdicts`（Task 3）、`callLLMSwitch`（既有 `src/lib/llm-narrative.js`）
- Produces: `POST /api/compliance/check`
  - 送：`{ session_id, turn_index, assistant_text, user_prompts, repo_remote, tools_used }`
  - 回：`{ enabled: boolean, outcome: 'clean'|'violation'|'skipped'|'failed', violations: [{ruleId, ruleTitle, evidence, fix}], check_id }`
- `createComplianceRouter({ queryFn, llmFn })` 具名匯出，供測試注入假的 DB 與模型。

- [ ] **Step 1: 寫失敗測試**

```javascript
// tests/enforcement-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createComplianceRouter } from '../src/routes/compliance.js';

function appWith({ mode = 'check', memories = [], llmFn, inserts = [] }) {
  const queryFn = async (sql, params) => {
    if (/FROM users/i.test(sql)) return { rows: [{ enforcement_mode: mode }] };
    if (/FROM memories/i.test(sql)) return { rows: memories };
    if (/INSERT INTO compliance_checks/i.test(sql)) {
      inserts.push({ sql, params });
      return { rows: [{ id: 1 }] };
    }
    return { rows: [] };
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/compliance', createComplianceRouter({ queryFn, llmFn }));
  return app;
}

async function post(app, body) {
  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/compliance/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  server.close();
  return { status: res.status, json };
}

const payload = {
  session_id: 's1', turn_index: 1,
  assistant_text: 'I will edit ci/projects.yml, you are an admin so I have permission',
  user_prompts: ['migrate ownmind to FAPA'], repo_remote: null, tools_used: [],
};

const rule412 = {
  id: 412, type: 'team_standard', title: 'ci ownership',
  content: 'Only Eric may edit ci/. No engineer including the owner may.',
  tags: [], metadata: { enforcement: { keywords: ['FAPA'] } },
};

test('an account with enforcement off never reaches the model', async () => {
  let called = false;
  const app = appWith({ mode: 'off', memories: [rule412], llmFn: async () => { called = true; return ''; } });
  const { json } = await post(app, payload);
  assert.equal(json.enabled, false);
  assert.equal(called, false, 'the model must not be called for an account that is off');
});

test('a violation comes back with the rule title, the evidence and the fix', async () => {
  const llmFn = async () => ({
    verdicts: [{ ruleId: 412, violated: true, evidence: 'I will edit ci/projects.yml', fix: 'open an issue for Eric' }],
  });
  const app = appWith({ memories: [rule412], llmFn });
  const { json } = await post(app, payload);
  assert.equal(json.outcome, 'violation');
  assert.equal(json.violations[0].ruleTitle, 'ci ownership');
  assert.match(json.violations[0].evidence, /ci\/projects\.yml/);
});

test('a model failure is reported as failed, never as clean', async () => {
  const llmFn = async () => { throw new Error('upstream down'); };
  const app = appWith({ memories: [rule412], llmFn });
  const { json } = await post(app, payload);
  assert.equal(json.outcome, 'failed');
  assert.deepEqual(json.violations, []);
});

test('unparseable model output is failed, not clean', async () => {
  const app = appWith({ memories: [rule412], llmFn: async () => { throw new Error('LLM JSON parse failed'); } });
  const { json } = await post(app, payload);
  assert.equal(json.outcome, 'failed');
});

test('no rule selected is skipped, and is recorded as such', async () => {
  const inserts = [];
  const app = appWith({ memories: [], llmFn: async () => '', inserts });
  const { json } = await post(app, payload);
  assert.equal(json.outcome, 'skipped');
  assert.equal(inserts.length, 1, 'a skipped check must still be recorded');
});

test('the rules considered are recorded even when the verdict is clean', async () => {
  const inserts = [];
  const llmFn = async () => ({ verdicts: [{ ruleId: 412, violated: false, evidence: '', fix: '' }] });
  const app = appWith({ memories: [rule412], llmFn, inserts });
  const { json } = await post(app, payload);
  assert.equal(json.outcome, 'clean');
  const recorded = JSON.stringify(inserts[0].params);
  assert.match(recorded, /412/, 'rules_considered must record what was looked at');
});

test('a missing assistant_text is rejected rather than judged', async () => {
  const app = appWith({ memories: [rule412], llmFn: async () => '' });
  const { status } = await post(app, { ...payload, assistant_text: '' });
  assert.equal(status, 400);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-route.test.js`
Expected: FAIL — `Cannot find module ... routes/compliance.js`

- [ ] **Step 3: 實作路由**

```javascript
// src/routes/compliance.js
/**
 * Per-turn compliance check.
 *
 * The client sends what the AI just said; this decides whether it broke any of the user's
 * rules and says so in time for the AI to correct itself. The account switch is read
 * first, before anything expensive: an account that is off costs one indexed lookup, no
 * tokens and no measurable latency, which is what makes it safe to ship the client half
 * to everybody while only one account is enrolled.
 */

import { Router } from 'express';
import { query as defaultQuery } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { callLLMSwitch } from '../lib/llm-narrative.js';
import { buildReadableWhere } from '../utils/memory-visibility.js';
import { attachStandardFragments } from '../utils/standard-fragments.js';
import { selectRules } from '../lib/enforcement/select-rules.js';
import { buildJudgeMessages, normaliseVerdicts } from '../lib/enforcement/judge-prompt.js';

// 4s. The client waits on this, and the user waits on the client. `retries: 0` is
// deliberate for the same reason: callLLMSwitch's retry loop is built for a page nobody is
// staring at, and a second attempt here would double a delay the user feels on every turn.
// A judge that did not answer in 4s is recorded as 'failed' and the turn goes through.
const JUDGE_TIMEOUT_MS = 4_000;

/**
 * callLLMSwitch returns the PARSED object, not the raw string.
 *
 * Measured against a stub server on 2026-08-13: `typeof result === 'object'`, `result.verdicts`
 * is the array, `result.content` is undefined, and prose from the model throws
 * ("LLM JSON parse failed") rather than coming back as text. The first draft of this
 * function did `result?.content ?? ''`, which would have produced an empty string on every
 * single call - so every check would have been recorded as `failed` and no violation could
 * ever have been reported. The route's own tests injected a string-returning llmFn and
 * stayed green throughout, which is why this is verified against the real function below.
 */
async function defaultLlm(messages) {
  return callLLMSwitch({
    apiKey: process.env.LLM_SWITCH_API_KEY,
    messages,
    timeoutMs: JUDGE_TIMEOUT_MS,
    retries: 0,
    overallTimeoutMs: JUDGE_TIMEOUT_MS,
  });
}

export function createComplianceRouter({ queryFn = defaultQuery, llmFn = defaultLlm } = {}) {
  const router = Router();

  router.post('/check', async (req, res) => {
    const startedAt = Date.now();
    const userId = req.user?.id;
    const {
      session_id: sessionId,
      turn_index: turnIndex,
      assistant_text: assistantText,
      user_prompts: userPrompts,
      repo_remote: repoRemote,
      tools_used: toolsUsed,
    } = req.body || {};

    if (!sessionId || typeof assistantText !== 'string' || assistantText.trim() === '') {
      return res.status(400).json({ error: 'session_id and assistant_text are required' });
    }

    // The switch, first and cheaply.
    let mode = 'off';
    try {
      const r = await queryFn('SELECT enforcement_mode FROM users WHERE id = $1', [userId]);
      mode = r.rows[0]?.enforcement_mode || 'off';
    } catch (err) {
      logger.warn?.('compliance: mode lookup failed', { err: err.message });
      return res.json({ enabled: false, outcome: 'failed', violations: [] });
    }
    if (mode !== 'check') return res.json({ enabled: false, outcome: 'skipped', violations: [] });

    const record = async (outcome, considered, verdicts) => {
      try {
        const r = await queryFn(
          `INSERT INTO compliance_checks
             (user_id, session_id, turn_index, rules_considered, verdicts, latency_ms, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [userId, sessionId, turnIndex ?? null, JSON.stringify(considered),
            JSON.stringify(verdicts), Date.now() - startedAt, outcome],
        );
        return r.rows[0]?.id ?? null;
      } catch (err) {
        logger.warn?.('compliance: record failed', { err: err.message });
        return null;
      }
    };

    let memories = [];
    try {
      // buildReadableWhere, not `user_id = $1`.
      //
      // Verified against a real Postgres with this repo's migrations on 2026-08-13: with a
      // plain owner filter, a team standard uploaded by a colleague does not come back at
      // all. The standard from the 2026-08-13 incident is exactly that - Eric's, not the
      // pilot user's - so the owner-scoped query left this feature blind to the one rule it
      // was built to enforce, while every route test (which injects its own rows) stayed
      // green. src/routes/memory.js:866 documents the same thing.
      const r = await queryFn(
        `SELECT m.id, m.type, m.code, m.title, m.content, m.tags, m.metadata
           FROM memories m
          WHERE m.status = 'active'
            AND m.type IN ('iron_rule', 'team_standard', 'principle', 'coding_standard')
            AND ${buildReadableWhere({ alias: 'm', userParam: '$1' })}`,
        [userId],
      );
      // Fragments carry the prohibition lists. A summary without them is the shape of the
      // incident: the AI reads the standard and the part that forbids the action is absent.
      memories = await Promise.all(
        r.rows.map((row) => attachStandardFragments(row, { query: queryFn, userId })),
      );
    } catch (err) {
      logger.warn?.('compliance: rule fetch failed', { err: err.message });
      const id = await record('failed', [], []);
      return res.json({ enabled: true, outcome: 'failed', violations: [], check_id: id });
    }

    const { selected } = selectRules(memories, {
      assistantText,
      userPrompts: Array.isArray(userPrompts) ? userPrompts : [],
      repoRemote: repoRemote || null,
      toolsUsed: Array.isArray(toolsUsed) ? toolsUsed : [],
    });
    const considered = selected.map((r) => ({ id: r.id, title: r.title }));

    if (selected.length === 0) {
      const id = await record('skipped', considered, []);
      return res.json({ enabled: true, outcome: 'skipped', violations: [], check_id: id });
    }

    let judged;
    try {
      judged = await llmFn(buildJudgeMessages({ rules: selected, assistantText, userPrompts: userPrompts || [] }));
    } catch (err) {
      // Includes the model answering with prose: callLLMSwitch throws "LLM JSON parse
      // failed" rather than handing back text. Recorded as failed, never as clean.
      logger.warn?.('compliance: judge call failed', { err: err.message });
      const id = await record('failed', considered, []);
      return res.json({ enabled: true, outcome: 'failed', violations: [], check_id: id });
    }

    const { verdicts, parseFailed } = normaliseVerdicts(judged);
    if (parseFailed) {
      const id = await record('failed', considered, []);
      return res.json({ enabled: true, outcome: 'failed', violations: [], check_id: id });
    }

    const byId = new Map(selected.map((r) => [r.id, r]));
    const violations = verdicts.filter((v) => v.violated && byId.has(v.ruleId)).map((v) => ({
      ruleId: v.ruleId,
      ruleTitle: byId.get(v.ruleId).title,
      ruleCode: byId.get(v.ruleId).code || null,
      evidence: v.evidence,
      fix: v.fix,
    }));

    const outcome = violations.length > 0 ? 'violation' : 'clean';
    const id = await record(outcome, considered, verdicts);
    return res.json({ enabled: true, outcome, violations, check_id: id });
  });

  // One click from the pilot user: was this finding right? Without it the false-positive
  // rate in the rollout criteria cannot be computed at all.
  router.post('/feedback', async (req, res) => {
    const { check_id: checkId, verdict } = req.body || {};
    if (!checkId || !['correct', 'false_positive'].includes(verdict)) {
      return res.status(400).json({ error: 'check_id and verdict (correct|false_positive) are required' });
    }
    try {
      await queryFn(
        'UPDATE compliance_checks SET user_feedback = $1 WHERE id = $2 AND user_id = $3',
        [verdict, checkId, req.user?.id],
      );
      return res.json({ ok: true });
    } catch (err) {
      logger.warn?.('compliance: feedback failed', { err: err.message });
      return res.status(500).json({ error: 'failed to record feedback' });
    }
  });

  return router;
}

const router = Router();
router.use(auth);
router.use(createComplianceRouter());
export default router;
```

- [ ] **Step 4: 掛載路由**

在 `src/app.js` 的 import 區塊（第 154 行附近，`createChangelogRouter` 之後）加入：

```javascript
import complianceRoutes from './routes/compliance.js';
```

在 `app.use('/api/memory', memoryRoutes);`（第 166 行附近）之後加入：

```javascript
app.use('/api/compliance', complianceRoutes);
```

- [ ] **Step 5: 跑測試確認通過**

Run: `node --test tests/enforcement-route.test.js`
Expected: PASS（7 tests）

- [ ] **Step 6: 突變測試 — 親眼看它紅（IR-134）**

暫時把 `src/routes/compliance.js` 裡的 `if (mode !== 'check')` 改成 `if (false)`，重跑：

Run: `node --test tests/enforcement-route.test.js`
Expected: FAIL —「an account with enforcement off never reaches the model」轉紅。看到紅之後**改回來**再繼續。

- [ ] **Step 7: Commit**

```bash
git add src/routes/compliance.js src/app.js tests/enforcement-route.test.js
git commit -m "feat(enforcement): per-turn compliance check endpoint"
```

---

## Task 5: 用戶端查核客戶端（逾時、退避、留痕）

**Files:**
- Create: `hooks/lib/compliance-client.js`
- Test: `tests/enforcement-compliance-client.test.js`

**Interfaces:**
- Produces：
  - `requestCheck({ apiUrl, apiKey, payload, fetchImpl, timeoutMs, now, stateDir }) → { outcome, violations, check_id, ranLocally: boolean }`
  - `formatViolationFeedback(violations) → string`（給 AI 讀的 stderr 內容）
  - `formatNotRunNotice(reason) → string`（給使用者看的終端機一行）
- Consumes: Task 4 的 API

**設計要點：** 逾時放行但留痕；連不上時退避，避免每輪都付逾時代價（`shared/edit-reminder-state.js` 第 38-45 行的教訓）。

- [ ] **Step 1: 寫失敗測試**

```javascript
// tests/enforcement-compliance-client.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { requestCheck, redact, formatViolationFeedback, formatNotRunNotice } from '../hooks/lib/compliance-client.js';

function tmpState() {
  return mkdtempSync(path.join(os.tmpdir(), 'om-compliance-'));
}

const payload = { session_id: 's1', assistant_text: 'hello' };

test('a violation response is passed through', async () => {
  const stateDir = tmpState();
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ enabled: true, outcome: 'violation', violations: [{ ruleId: 1, ruleTitle: 't', evidence: 'e', fix: 'f' }], check_id: 9 }),
  });
  const r = await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload, fetchImpl, stateDir });
  assert.equal(r.outcome, 'violation');
  assert.equal(r.violations.length, 1);
  rmSync(stateDir, { recursive: true, force: true });
});

test('a network failure yields outcome failed, not clean', async () => {
  const stateDir = tmpState();
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload, fetchImpl, stateDir });
  assert.equal(r.outcome, 'failed');
  assert.deepEqual(r.violations, []);
  rmSync(stateDir, { recursive: true, force: true });
});

test('after a failure the next call backs off instead of paying the timeout again', async () => {
  const stateDir = tmpState();
  let calls = 0;
  const failing = async () => { calls += 1; throw new Error('down'); };
  let now = 1_000_000;
  const clock = () => now;
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload, fetchImpl: failing, stateDir, now: clock });
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload, fetchImpl: failing, stateDir, now: clock });
  assert.equal(calls, 1, 'the second call inside the backoff window must not hit the network');
  rmSync(stateDir, { recursive: true, force: true });
});

test('the backoff expires', async () => {
  const stateDir = tmpState();
  let calls = 0;
  const failing = async () => { calls += 1; throw new Error('down'); };
  let now = 1_000_000;
  const clock = () => now;
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload, fetchImpl: failing, stateDir, now: clock });
  now += 10 * 60 * 1000;
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload, fetchImpl: failing, stateDir, now: clock });
  assert.equal(calls, 2);
  rmSync(stateDir, { recursive: true, force: true });
});

test('the feedback text names the rule, quotes the evidence and says what to do', () => {
  const text = formatViolationFeedback([{ ruleId: 412, ruleTitle: 'ci ownership', evidence: 'I will edit ci/projects.yml', fix: 'open an issue for Eric' }]);
  assert.match(text, /412/);
  assert.match(text, /ci ownership/);
  assert.match(text, /I will edit ci\/projects\.yml/);
  assert.match(text, /open an issue for Eric/);
});

test('the not-run notice says plainly that no check happened', () => {
  const text = formatNotRunNotice('timeout');
  assert.match(text, /not run|未執行/i);
  assert.match(text, /timeout/);
});

test('credential-shaped text is redacted before it leaves the machine', async () => {
  const stateDir = tmpState();
  let sentBody = null;
  const fetchImpl = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ enabled: true, outcome: 'clean', violations: [] }) };
  };
  await requestCheck({
    apiUrl: 'http://x', apiKey: 'k', fetchImpl, stateDir,
    payload: {
      session_id: 's1',
      assistant_text: 'run it with api_key=sk-live-abcdef and Bearer tok_9999',
      user_prompts: ['my password: hunter2'],
    },
  });
  assert.doesNotMatch(sentBody.assistant_text, /sk-live-abcdef/);
  assert.doesNotMatch(sentBody.assistant_text, /tok_9999/);
  assert.doesNotMatch(sentBody.user_prompts[0], /hunter2/);
  rmSync(stateDir, { recursive: true, force: true });
});

test('the auth header is the scheme the server accepts', async () => {
  // src/middleware/auth.js rejects anything that is not "Bearer ..." - an x-api-key header
  // would 401 every check, and this client would file that away as a server problem.
  const stateDir = tmpState();
  let headers = null;
  const fetchImpl = async (_url, opts) => {
    headers = opts.headers;
    return { ok: true, json: async () => ({ enabled: true, outcome: 'clean', violations: [] }) };
  };
  await requestCheck({ apiUrl: 'http://x', apiKey: 'k', payload, fetchImpl, stateDir });
  assert.match(headers.Authorization, /^Bearer /);
  rmSync(stateDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-compliance-client.test.js`
Expected: FAIL — `Cannot find module ... compliance-client.js`

- [ ] **Step 3: 實作**

```javascript
// hooks/lib/compliance-client.js
/**
 * Client half of the per-turn compliance check.
 *
 * Two rules govern everything here. Never block the user's work when the server is
 * unavailable - and never let that silence look like a clean check. An outcome of
 * 'failed' is therefore distinct from 'clean' all the way through, and the caller is
 * expected to say so on the terminal.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 5s, not 8s. This sits on the critical path of every AI turn that matches a standard: the
// user cannot type their next prompt until it returns. The server's own judge budget is 4s,
// so a healthy check finishes well inside this and an unhealthy one is cut off fast.
const DEFAULT_TIMEOUT_MS = 5_000;
const BACKOFF_MS = 5 * 60 * 1000;
const STATE_FILE = 'compliance-backoff.json';

function stateFilePath(stateDir) {
  const dir = stateDir || path.join(os.homedir(), '.ownmind', 'state');
  return path.join(dir, STATE_FILE);
}

function readBackoffUntil(stateDir) {
  try {
    const raw = fs.readFileSync(stateFilePath(stateDir), 'utf8');
    const parsed = JSON.parse(raw);
    return Number.isFinite(parsed?.until_ms) ? parsed.until_ms : 0;
  } catch {
    return 0;
  }
}

function writeBackoffUntil(stateDir, untilMs) {
  try {
    const file = stateFilePath(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ until_ms: untilMs }), 'utf8');
  } catch { /* a state file we cannot write only costs an extra attempt */ }
}

/**
 * Strip credential-shaped text before anything leaves the machine.
 *
 * The reply and the recent prompts go to the user's own server and on to the configured
 * LLM endpoint. That is a new egress path for conversation text, so it gets the same
 * redaction the session route already applies (src/routes/session.js) rather than a fresh
 * one - a second, subtly different sanitiser is how one of them ends up weaker.
 */
export function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, (m) => {
      const sep = m.includes('=') ? '=' : ':';
      return `${m.split(/[:=]/)[0]}${sep}[REDACTED]`;
    })
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

/**
 * @returns {Promise<{outcome: string, violations: Array<object>, check_id: number|null, reason?: string}>}
 */
export async function requestCheck({
  apiUrl, apiKey, payload,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  stateDir,
}) {
  if (!apiUrl || !apiKey) return { outcome: 'failed', violations: [], check_id: null, reason: 'no credentials' };

  if (now() < readBackoffUntil(stateDir)) {
    return { outcome: 'failed', violations: [], check_id: null, reason: 'backoff' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Authorization: Bearer, not x-api-key. src/middleware/auth.js line 68-70 rejects
    // anything that does not start with "Bearer ", and the first draft of this client sent
    // the wrong header - every check would have come back 401, which this client would have
    // recorded as 'failed' and shrugged off as a server problem.
    const res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/api/compliance/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        ...payload,
        assistant_text: redact(payload.assistant_text),
        user_prompts: (payload.user_prompts || []).map(redact),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      writeBackoffUntil(stateDir, now() + BACKOFF_MS);
      return { outcome: 'failed', violations: [], check_id: null, reason: `http ${res.status}` };
    }
    const json = await res.json();
    return {
      outcome: json.outcome || 'failed',
      violations: Array.isArray(json.violations) ? json.violations : [],
      check_id: json.check_id ?? null,
    };
  } catch (err) {
    writeBackoffUntil(stateDir, now() + BACKOFF_MS);
    const reason = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'error');
    return { outcome: 'failed', violations: [], check_id: null, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** What the AI reads on stderr. Names the rule, quotes the evidence, states the fix. */
export function formatViolationFeedback(violations) {
  const lines = ['[OwnMind] This reply violates rules you are required to follow:'];
  for (const v of violations) {
    lines.push(`  - Rule ${v.ruleId}${v.ruleCode ? ` (${v.ruleCode})` : ''}: ${v.ruleTitle}`);
    lines.push(`    Your words: "${v.evidence}"`);
    if (v.fix) lines.push(`    Do this instead: ${v.fix}`);
  }
  lines.push('Rewrite the reply so it complies. Do not argue with the rule.');
  return lines.join('\n');
}

/** What the user sees when no check happened. Silence here would be the worst failure. */
export function formatNotRunNotice(reason) {
  return `[OwnMind] compliance check not run (${reason}) - this turn was not checked`;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/enforcement-compliance-client.test.js`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/compliance-client.js tests/enforcement-compliance-client.test.js
git commit -m "feat(enforcement): compliance check client with backoff and visible failure"
```

---

## Task 6: 接進 Stop hook（本身可測的決策模組 ＋ 三個致命修正）

**Files:**
- Create: `hooks/lib/compliance-step.js`
- Modify: `hooks/ownmind-reply-lint.js`
- Test: `tests/enforcement-compliance-step.test.js`

**Interfaces:**
- Consumes: `requestCheck` / `formatViolationFeedback` / `formatNotRunNotice`（Task 5）、`readEnforcementBundle`（Task 0.5 建立）的 `selectors` 與 `present`
- Produces: `runComplianceStep(ctx) → { action: 'exit2'|'notice'|'none', stderr?: string, banner?: string }`

### 本任務修掉對抗審查抓到的三個致命問題

| # | 問題 | 修法 |
|---|---|---|
| 1 | 原計畫用 `LINT_DISABLED`，但該檔第 76 行的變數叫 **`DISABLED`**。未定義的識別字會丟 `ReferenceError`，而原本的 `catch {}` 是空的 → **整段查核靜靜地永遠不執行**，正是本功能存在要消滅的失敗形態 | 用正確的 `DISABLED`；並把邏輯搬進可單測的模組，不靠貼進大檔案時的眼力 |
| 2 | 該檔第 170 行 `if (payload.stop_hook_active === true) { process.exit(0); return; }` 早於任何插入點 → **AI 被退回後重寫的那一版完全不會被查**，等於退回一次就開了永久後門 | 查核移到該早退**之前**，並用自己的計數器設硬上限，避免無限退回 |
| 3 | 原計畫客戶端送 `x-api-key`，但伺服器 `src/middleware/auth.js` 第 68-70 行只認 `Authorization: Bearer` → **每次查核都 401** | 改用 `Authorization: Bearer`（與該檔第 861 行既有寫法一致） |

另外兩項成本修正：

- **本機先篩，沒命中就不連網**：用 Task 8 的同一份本機快取先跑一次比對，零規範命中就完全不送請求。多數輪次因此零延遲、零 token。
- **逾時收緊**：客戶端 5 秒、伺服器端判斷 4 秒（原本 8／12 秒會讓使用者每輪多等十幾秒）。

- [ ] **Step 1: 寫失敗測試（行為測試，不是對原始碼做正則比對）**

```javascript
// tests/enforcement-compliance-step.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runComplianceStep } from '../hooks/lib/compliance-step.js';

// A flat selector, the shape the bundle actually ships - not a database row.
const standard = { id: 412, type: 'team_standard', tags: [], keywords: ['FAPA'], always_check: false, repo_match: '' };

const base = {
  disabled: false, mode: 'block', apiKey: 'k', apiUrl: 'http://x',
  sessionId: 's1', assistantText: 'I will edit ci/projects.yml for FAPA',
  userPrompts: [], repoRemote: null, selectors: [standard], bundlePresent: true,
  blockCount: 0,
  requestCheckImpl: async () => ({ outcome: 'clean', violations: [], check_id: 1 }),
};

test('a violation asks the caller to exit 2 and hands it the stderr text', async () => {
  const r = await runComplianceStep({
    ...base,
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 7,
      violations: [{ ruleId: 412, ruleTitle: 'ci ownership', evidence: 'I will edit ci/projects.yml', fix: 'open an issue' }],
    }),
  });
  assert.equal(r.action, 'exit2');
  assert.match(r.stderr, /412/);
  assert.match(r.stderr, /open an issue/);
});

test('no standard matches locally, so no request is made at all', async () => {
  let called = false;
  const r = await runComplianceStep({
    ...base,
    assistantText: 'the weather is fine',
    requestCheckImpl: async () => { called = true; return { outcome: 'clean', violations: [] }; },
  });
  assert.equal(called, false, 'a turn that matches nothing must not touch the network');
  assert.equal(r.action, 'none');
});

test('a disabled session says so instead of staying silent', async () => {
  const r = await runComplianceStep({ ...base, disabled: true });
  assert.equal(r.action, 'notice');
  assert.match(r.banner, /off|disabled/i);
});

test('warn mode also says so', async () => {
  const r = await runComplianceStep({ ...base, mode: 'warn' });
  assert.equal(r.action, 'notice');
});

test('a failed check produces a visible notice, never silence', async () => {
  const r = await runComplianceStep({
    ...base,
    requestCheckImpl: async () => ({ outcome: 'failed', violations: [], reason: 'timeout' }),
  });
  assert.equal(r.action, 'notice');
  assert.match(r.banner, /timeout/);
});

test('the rewrite is checked too - being a rewrite is not an exemption', async () => {
  // The hook exits early when stop_hook_active is true. If the compliance step sat behind
  // that, one violation would buy a permanently unchecked reply.
  const r = await runComplianceStep({
    ...base, isRewrite: true,
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 8,
      violations: [{ ruleId: 412, ruleTitle: 't', evidence: 'e', fix: 'f' }],
    }),
  });
  assert.equal(r.action, 'exit2');
});

test('after the cap is reached the AI is not pushed round again', async () => {
  // Two rejections is the budget. Beyond it the finding is shown to the user and the turn
  // is allowed to stand, because an AI that cannot satisfy the judge would otherwise loop.
  const r = await runComplianceStep({
    ...base, blockCount: 2,
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 9,
      violations: [{ ruleId: 412, ruleTitle: 't', evidence: 'e', fix: 'f' }],
    }),
  });
  assert.equal(r.action, 'notice');
  assert.match(r.banner, /still violates|仍然違反/i);
});

test('the banner carries the check id so a false alarm can be reported', async () => {
  const r = await runComplianceStep({
    ...base,
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 4242,
      violations: [{ ruleId: 412, ruleTitle: 't', evidence: 'e', fix: 'f' }],
    }),
  });
  assert.match(r.banner, /4242/);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-compliance-step.test.js`
Expected: FAIL — `Cannot find module ... compliance-step.js`

- [ ] **Step 3: 實作決策模組**

```javascript
// hooks/lib/compliance-step.js
/**
 * The compliance step, as a decision function.
 *
 * It lives here rather than inline in the stop hook for one reason: pasted-in code cannot
 * be unit tested, and the first draft of this feature referenced a variable that did not
 * exist (`LINT_DISABLED`; the hook's is `DISABLED`) inside a try/catch that swallowed the
 * ReferenceError. The check would have shipped, passed review, and never once run. A guard
 * that silently does nothing is worse than no guard, so the decision is a pure-ish function
 * with the network injected, and the hook only carries out what it returns.
 */

import { requestCheck as defaultRequestCheck, formatViolationFeedback, formatNotRunNotice } from './compliance-client.js';

/** Rejections allowed per session before the finding is shown to the user instead. */
export const MAX_COMPLIANCE_BLOCKS = 2;

/**
 * Same matching the server does, run locally first so a turn that matches nothing is free.
 *
 * Reads the FLAT selector shape the bundle actually ships (`s.keywords`, `s.always_check`,
 * `s.repo_match`). It must not reach for `s.metadata.enforcement.*`: that nesting exists
 * only in the database row, and a client function written against it returns false on every
 * real machine while passing every test that hands it a hand-built row.
 */
function anyStandardMatches(selectors, assistantText, userPrompts, repoRemote) {
  const hay = [assistantText || '', ...(userPrompts || [])].join('\n').toLowerCase();
  return (selectors || []).some((s) => {
    if (!s) return false;
    if (s.always_check === true) return true;
    if (s.repo_match && typeof repoRemote === 'string' && repoRemote.includes(s.repo_match)) return true;
    return Array.isArray(s.keywords)
      && s.keywords.some((k) => typeof k === 'string' && k && hay.includes(k.toLowerCase()));
  });
}

/**
 * @param {object} ctx
 * @returns {Promise<{action: 'exit2'|'notice'|'none', stderr?: string, banner?: string}>}
 */
export async function runComplianceStep(ctx) {
  const {
    disabled, mode, apiKey, apiUrl, sessionId,
    assistantText, userPrompts, repoRemote,
    selectors, bundlePresent = true,
    blockCount = 0,
    requestCheckImpl = defaultRequestCheck,
  } = ctx;

  // Degraded is fine. Silent is not: a check that is switched off must never be
  // indistinguishable from a check that passed.
  if (disabled || mode === 'warn') {
    return {
      action: 'notice',
      banner: '[OwnMind] compliance check is off for this session (lint disabled or warn mode)',
    };
  }
  if (!apiKey || !apiUrl) return { action: 'none' };

  // A bundle that has never synced must not read as "nothing matched". Fresh install,
  // offline first run, a failed sync - all three would otherwise silently disable every
  // check on that machine, with a green suite and a quiet terminal. Fail towards asking the
  // server, and say so.
  if (!bundlePresent) {
    return {
      action: 'notice',
      banner: '[OwnMind] rule list not synced yet on this machine - checking with the server anyway',
      forceCheck: true,
    };
  }

  // Local pre-filter. Most turns match nothing, and those cost neither latency nor tokens.
  if (!anyStandardMatches(selectors, assistantText, userPrompts, repoRemote)) {
    return { action: 'none' };
  }

  const check = await requestCheckImpl({
    apiUrl,
    apiKey,
    payload: {
      session_id: sessionId,
      assistant_text: assistantText,
      user_prompts: userPrompts || [],
      repo_remote: repoRemote || null,
      tools_used: [],
    },
  });

  if (check.outcome === 'failed') {
    return { action: 'notice', banner: formatNotRunNotice(check.reason || 'unknown') };
  }
  if (check.outcome !== 'violation' || !check.violations?.length) {
    return { action: 'none' };
  }

  const idNote = check.check_id ? ` [check ${check.check_id}]` : '';

  // The AI has already been pushed back this many times. Pushing again risks a loop
  // between an AI that cannot satisfy the judge and a judge that will not yield, so the
  // finding goes to the user instead and the turn is allowed to stand.
  if (blockCount >= MAX_COMPLIANCE_BLOCKS) {
    return {
      action: 'notice',
      banner: `[OwnMind] the reply still violates ${check.violations.length} rule(s) after `
        + `${blockCount} rewrites - showing you instead of asking again${idNote}`,
    };
  }

  return {
    action: 'exit2',
    stderr: formatViolationFeedback(check.violations),
    banner: `[OwnMind] compliance: ${check.violations.length} rule violation(s) sent back to the AI${idNote}`,
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/enforcement-compliance-step.test.js`
Expected: PASS（8 tests）

- [ ] **Step 5: 接進 hook —— 位置在 `stop_hook_active` 早退之前**

在 `hooks/ownmind-reply-lint.js` 的 import 區塊加入：

```javascript
import { execSync } from 'node:child_process';
import { runComplianceStep, MAX_COMPLIANCE_BLOCKS } from './lib/compliance-step.js';
import { readEnforcementBundle } from './lib/enforcement-cache.js';
```

在 `main()` 內，**緊接在讀出 `payload` 之後、第 170 行的 `if (payload.stop_hook_active === true)` 之前**插入：

```javascript
  // === Standard enforcement (v1.27) ===
  //
  // Ahead of the stop_hook_active early return on purpose. That return exists to stop the
  // string validators looping, but it also means a reply produced *because* the AI was
  // pushed back is never examined - so one rejection would buy a permanently unchecked
  // turn. The loop is bounded here instead, by MAX_COMPLIANCE_BLOCKS, which is a counter of
  // this path's own and shares nothing with BLOCK_THRESHOLD or incrementCounter: a rule
  // violation must reach the AI on the first offence, not the fourth.
  {
    const complianceSessionId = (typeof payload.session_id === 'string' && payload.session_id) || 'unknown';
    const transcriptForCompliance = sanitizeTranscriptPath(payload.transcript_path);
    if (transcriptForCompliance) {
      const tail = readTranscriptTail(transcriptForCompliance);
      if (tail.lastAssistantText) {
        let step = { action: 'none' };
        try {
          const { apiKey, apiUrl } = readCredentials();
          step = await runComplianceStep({
            disabled: DISABLED,                 // NOTE: the constant is DISABLED (line 76)
            mode: MODE,
            apiKey,
            apiUrl,
            sessionId: complianceSessionId,
            assistantText: tail.lastAssistantText,
            userPrompts: tail.recentUserPrompts,
            repoRemote: readRepoRemote(),
            selectors: readEnforcementBundle().selectors,
            bundlePresent: readEnforcementBundle().present,
            blockCount: readComplianceBlockCount(complianceSessionId),
          });
        } catch (err) {
          // Never swallowed. The first draft of this feature hid a ReferenceError here and
          // the whole check would have been dead on arrival with nobody the wiser.
          step = {
            action: 'notice',
            banner: `[OwnMind] compliance check errored: ${err && err.message ? err.message : 'unknown'}`,
          };
        }

        if (step.banner) {
          if (!FORCE_FALLBACK) writeToTty(step.banner); else writeFallback(step.banner);
        }
        if (step.action === 'exit2') {
          incrementComplianceBlockCount(complianceSessionId);
          try { process.stderr.write(step.stderr + '\n'); } catch { /* ignore */ }
          process.exit(2);
          return;
        }
      }
    }
  }
```

在輔助函式區加入（計數器獨立於既有 `incrementCounter`）：

```javascript
/** The remote of the repo this session is in. Absent outside a repo, which is normal. */
function readRepoRemote() {
  try {
    return execSync('git remote get-url origin', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * How many times this session's replies have been pushed back for a rule violation.
 *
 * Its own file, deliberately. The lint counter is shared across every validator and
 * accumulates to a threshold of four; a rule violation that had to wait its turn behind
 * three others would arrive after the damage.
 */
function complianceBlockFile(sessionId) {
  return path.join(os.homedir(), '.ownmind', 'state', `compliance-blocks-${sessionId}.json`);
}

function readComplianceBlockCount(sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(complianceBlockFile(sessionId), 'utf8'));
    return Number.isFinite(parsed?.count) ? parsed.count : 0;
  } catch {
    return 0;
  }
}

function incrementComplianceBlockCount(sessionId) {
  try {
    const file = complianceBlockFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ count: readComplianceBlockCount(sessionId) + 1 }), 'utf8');
  } catch { /* a counter we cannot persist only costs one extra round */ }
}
```

⚠️ 貼進去之後**逐一確認這些識別字在該檔真的存在**：`DISABLED`（第 76 行）、`MODE`、`FORCE_FALLBACK`、`writeToTty`、`writeFallback`、`readCredentials`、`sanitizeTranscriptPath`、`readTranscriptTail`、`fs`、`path`、`os`。缺任何一個就補 import 或改用正確名稱 —— 這正是第一版栽的地方。

- [ ] **Step 6: 用真的 hook 跑一次，確認沒有 ReferenceError**

```bash
printf '{"session_id":"t1","transcript_path":"/nonexistent","hook_event_name":"Stop","stop_hook_active":false}' \
  | node hooks/ownmind-reply-lint.js; echo "exit=$?"
```

Expected: `exit=0`，且 stderr 沒有 `ReferenceError`。（逐字稿不存在 → 查核不執行，屬正常路徑。）

- [ ] **Step 7: 跑整組回話檢查測試**

Run: `node --test tests/enforcement-compliance-step.test.js tests/reply-lint*.test.js`
Expected: 全數 PASS

- [ ] **Step 8: 突變測試 — 親眼看它紅（IR-134）**

暫時把 `compliance-step.js` 的 `if (blockCount >= MAX_COMPLIANCE_BLOCKS)` 改成 `if (false)`，重跑：
Expected: 「after the cap is reached」轉紅。看到紅之後**用備份還原**（IR-140，不可用 `git checkout`）。

- [ ] **Step 9: Commit**

```bash
git add hooks/lib/compliance-step.js hooks/ownmind-reply-lint.js tests/enforcement-compliance-step.test.js
git commit -m "feat(enforcement): run the per-turn check from the stop hook, rewrites included"
```

> **執行順序註記：** 本任務 import `hooks/lib/enforcement-cache.js`，該檔在 Task 8 Step 4 建立。**請先完成 Task 7、8，再回頭做 Task 6。** 任務編號保留原順序以對應 spec，執行順序為 1 → 2 → 3 → 4 → 5 → 7 → 8 → 6 → 9 → 10 → 11 → 12 → 13。

---

## Task 7: 禁區路徑硬擋（判斷函式）

**Files:**
- Create: `hooks/lib/path-guard.js`
- Test: `tests/enforcement-path-guard.test.js`

**Interfaces:**
- Produces:
  - `resolveRepoRemote(filePath, { execImpl }) → string|null` — **由被編輯檔案所在目錄**往上找，不是 cwd
  - `findGuardViolation(filePath, standards, { execImpl }) → { standard, matchedPath }|null`
  - `formatGuardBlock(violation) → string`
- Consumes: `memories.json` 快取內的 team_standard（Task 8 讀取）

**致命點（spec §4.1）：** repo 一定要由 `path.dirname(file_path)` 解析。事故當時 cwd 在 OwnMind repo、目標檔在 FAPA repo，用 cwd 會直接放行。

- [ ] **Step 1: 寫失敗測試**

```javascript
// tests/enforcement-path-guard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRepoRemote, findGuardViolation, findContentMention, formatGuardBlock } from '../hooks/lib/path-guard.js';

// A flat guard entry, exactly what buildBundle emits.
const standard = {
  id: 412, title: 'ci ownership',
  repo_match: 'fontrip-agentic-process-automation',
  paths: ['ci/**', '.gitlab-ci.yml'],
  owner: 'Eric',
};

// Fake git: answers according to the directory it is asked about, which is the whole point.
function fakeExec(map) {
  return (cmd) => {
    const m = cmd.match(/-C\s+"([^"]+)"/);
    const dir = m ? m[1] : '';
    for (const [prefix, out] of Object.entries(map)) {
      if (dir.startsWith(prefix)) return out;
    }
    throw new Error('not a repo');
  };
}

const execImpl = fakeExec({
  '/work/fapa': 'https://git.fontrip.com/fontrip/fontrip-agentic-process-automation.git\n/work/fapa\n',
  '/work/ownmind': 'https://github.com/miou1107/ownmind.git\n/work/ownmind\n',
});

test('the repo is resolved from the edited file, not the working directory', () => {
  const remote = resolveRepoRemote('/work/fapa/ci/projects.yml', { execImpl });
  assert.match(remote.remote, /fontrip-agentic-process-automation/);
});

test('a forbidden path in the guarded repo is caught even when the session is in another repo', () => {
  // The 2026-08-13 topology exactly: cwd was the OwnMind checkout, the target was FAPA.
  const v = findGuardViolation('/work/fapa/ci/projects.yml', [standard], { execImpl });
  assert.ok(v, 'must be caught');
  assert.equal(v.standard.id, 412);
});

test('the same relative path in a different repo is not caught', () => {
  const v = findGuardViolation('/work/ownmind/ci/projects.yml', [standard], { execImpl });
  assert.equal(v, null);
});

test('a non-forbidden path in the guarded repo is not caught', () => {
  const v = findGuardViolation('/work/fapa/Projects/ownmind/src/index.js', [standard], { execImpl });
  assert.equal(v, null);
});

test('the root config file pattern matches exactly, not as a prefix', () => {
  assert.ok(findGuardViolation('/work/fapa/.gitlab-ci.yml', [standard], { execImpl }));
  assert.equal(findGuardViolation('/work/fapa/docs/.gitlab-ci.yml.md', [standard], { execImpl }), null);
});

test('a file outside any repo is not caught and does not throw', () => {
  assert.equal(findGuardViolation('/tmp/scratch.txt', [standard], { execImpl }), null);
});

test('a standard with no guard block is ignored', () => {
  const v = findGuardViolation('/work/fapa/ci/projects.yml', [{ id: 1, metadata: {} }], { execImpl });
  assert.equal(v, null);
});

test('running twice gives the same answer', () => {
  // IR-135: an operation that will be applied repeatedly must be tested twice.
  const a = findGuardViolation('/work/fapa/ci/projects.yml', [standard], { execImpl });
  const b = findGuardViolation('/work/fapa/ci/projects.yml', [standard], { execImpl });
  assert.deepEqual(a.standard.id, b.standard.id);
});

test('the block message names the standard, the owner and the correct action', () => {
  const v = findGuardViolation('/work/fapa/ci/projects.yml', [standard], { execImpl });
  const msg = formatGuardBlock(v);
  assert.match(msg, /412/);
  assert.match(msg, /Eric/);
  assert.match(msg, /issue/i);
});

test('a document that proposes the forbidden edit is caught by content, not by path', () => {
  // The incident's actual artifact: a plan file at a legal path whose text proposed the
  // forbidden change. Path matching alone waves it through.
  const hit = findContentMention('Stage 0: I will add an entry to ci/projects.yml', [standard]);
  assert.ok(hit);
  assert.equal(hit.standard.id, 412);
});

test('content with no forbidden path is not flagged', () => {
  assert.equal(findContentMention('just some ordinary prose about deployment', [standard]), null);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-path-guard.test.js`
Expected: FAIL — `Cannot find module ... path-guard.js`

- [ ] **Step 3: 實作**

```javascript
// hooks/lib/path-guard.js
/**
 * The one hard guarantee in this feature: an edit to a forbidden path does not happen.
 *
 * The repo is resolved from the directory of the file being edited, never from the
 * process's working directory. On 2026-08-13 the session was running inside the OwnMind
 * checkout while the file at issue lived in another repo entirely; a cwd-based check would
 * have waved that edit straight through, which is the incident this exists to stop.
 */

import path from 'node:path';
import { execSync } from 'node:child_process';

function defaultExec(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
}

/**
 * @param {string} filePath absolute path of the file about to be written
 * @returns {{remote: string, root: string}|null}
 */
export function resolveRepoRemote(filePath, { execImpl = defaultExec } = {}) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const dir = path.dirname(path.resolve(filePath));
  try {
    // One call, two answers: `remote get-url` then `rev-parse --show-toplevel`, so the
    // relative path below is taken against the right root.
    const out = execImpl(`git -C "${dir}" remote get-url origin && git -C "${dir}" rev-parse --show-toplevel`);
    const [remote, root] = String(out).split('\n').map((s) => s.trim()).filter(Boolean);
    if (!remote || !root) return null;
    return { remote, root };
  } catch {
    return null;
  }
}

/** Minimal glob: `**` spans separators, `*` does not. Anchored at both ends. */
function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i += 1; } else { out += '[^/]*'; }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * @param {string} filePath
 * @param {Array<object>} standards team standards from the local cache
 * @returns {{standard: object, matchedPath: string, relPath: string}|null}
 */
export function findGuardViolation(filePath, standards, { execImpl = defaultExec } = {}) {
  if (!Array.isArray(standards) || standards.length === 0) return null;
  const repo = resolveRepoRemote(filePath, { execImpl });
  if (!repo) return null;

  const relPath = path.relative(repo.root, path.resolve(filePath)).split(path.sep).join('/');
  // A path that climbs out of the root is not in this repo.
  if (relPath.startsWith('..')) return null;

  // `guards` entries are FLAT: {id, title, repo_match, paths, owner}. Reaching for
  // `standard.metadata.enforcement.guard` here would be reading the database's shape from
  // the client, where it does not exist - false on every real machine, green in every test
  // that hands this function a hand-built row.
  for (const guard of standards) {
    if (!guard || !Array.isArray(guard.paths)) continue;
    if (guard.repo_match && !repo.remote.includes(guard.repo_match)) continue;
    for (const pattern of guard.paths) {
      if (typeof pattern !== 'string' || !pattern) continue;
      if (globToRegExp(pattern).test(relPath)) {
        return { standard: guard, matchedPath: pattern, relPath };
      }
    }
  }
  return null;
}

/**
 * The content going into a file, checked against the same forbidden paths.
 *
 * The 2026-08-13 incident produced a plan document at a perfectly legal path whose text
 * proposed the forbidden edit. A guard that only looks at file_path waves that through, so
 * this looks at what is being written as well. Deliberately narrow - a literal mention of a
 * forbidden path - because anything broader would fire on documents that quote the standard
 * in order to obey it.
 *
 * @returns {{standard: object, matchedPath: string}|null}
 */
export function findContentMention(content, standards) {
  if (typeof content !== 'string' || !content) return null;
  for (const guard of standards || []) {
    if (!guard || !Array.isArray(guard.paths)) continue;
    for (const pattern of guard.paths) {
      // Only literal path segments are worth matching; a glob like `ci/**` becomes `ci/`.
      const literal = String(pattern).replace(/\*+/g, '').replace(/\/+$/, '');
      if (literal.length >= 3 && content.includes(literal)) {
        return { standard: guard, matchedPath: pattern };
      }
    }
  }
  return null;
}

/** The message the AI gets when it is blocked. Always says what to do instead. */
export function formatGuardBlock(violation) {
  const owner = violation.standard?.owner || 'the owner of this path';
  return [
    `[OwnMind] Blocked by standard ${violation.standard.id}: ${violation.standard.title || ''}`,
    `  ${violation.relPath} is off limits (pattern: ${violation.matchedPath}).`,
    `  This path belongs to ${owner}. No engineer may edit it directly, including admins.`,
    `  Correct action: open an issue for ${owner} describing the change you need.`,
  ].join('\n');
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/enforcement-path-guard.test.js`
Expected: PASS（9 tests）

- [ ] **Step 5: 突變測試 — 親眼看它紅（IR-134）**

暫時把 `resolveRepoRemote` 裡的 `const dir = path.dirname(path.resolve(filePath));` 改成 `const dir = process.cwd();`，重跑：

Run: `node --test tests/enforcement-path-guard.test.js`
Expected: FAIL —「the repo is resolved from the edited file」與「caught even when the session is in another repo」轉紅。看到紅之後**改回來**。

- [ ] **Step 6: Commit**

```bash
git add hooks/lib/path-guard.js tests/enforcement-path-guard.test.js
git commit -m "feat(enforcement): forbidden-path guard resolved from the edited file's repo"
```

---

## Task 8: 把硬擋接進真正會被呼叫的那支 hook

**Files:**
- Modify: `hooks/ownmind-edit-reminder.js`（`editReminder()` 開頭）
- Modify: `hooks/lib/conditional-sync.js`（空回應不得覆蓋既有快取）
- Test: `tests/enforcement-edit-guard.test.js`

**Interfaces:**
- Consumes: `findGuardViolation` / `formatGuardBlock`（Task 7）
- Produces: `editReminder()` 在命中禁區時回傳 `decision: block` 的信封

**致命點（spec §4.1）：** mac／Linux 註冊的是 `ownmind-iron-rule-check.sh`（`install.sh:564` 以 `--bash`、`ensure-pretooluse-hooks.cjs:58-59`），該 `.sh` 第 136-157 行把編輯類工具轉交 `ownmind-edit-reminder.js` 後 `exit 0`，**永遠不會進入 `.js` 的 edit 路徑**。因此閘門必須寫在 `ownmind-edit-reminder.js`。這同時反轉該檔第 10-13 行「The edit trigger never blocks」的既有決定。

- [ ] **Step 1: 寫失敗測試**

```javascript
// tests/enforcement-edit-guard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editReminder } from '../hooks/ownmind-edit-reminder.js';

const standard = {
  id: 412, title: 'ci ownership',
  repo_match: 'enforcement-guard-fixture', paths: ['ci/**'], owner: 'Eric',
};

/** A real git repo, because the guard shells out to real git. */
function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'enforcement-guard-fixture-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.com/enforcement-guard-fixture.git']);
  mkdirSync(path.join(dir, 'ci'), { recursive: true });
  writeFileSync(path.join(dir, 'ci', 'projects.yml'), 'projects: {}\n');
  return dir;
}

test('editing a forbidden path returns a block envelope', async () => {
  const repo = makeRepo();
  const out = await editReminder({
    version: 'test', apiKey: '', apiUrl: '', now: Date.now(), sessionId: 's1',
    filePath: path.join(repo, 'ci', 'projects.yml'),
    standards: [standard],
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason || JSON.stringify(parsed), /412/);
  rmSync(repo, { recursive: true, force: true });
});

test('editing an allowed path in the same repo is not blocked', async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, 'README.md'), '# x\n');
  const out = await editReminder({
    version: 'test', apiKey: '', apiUrl: '', now: Date.now(), sessionId: 's1',
    filePath: path.join(repo, 'README.md'),
    standards: [standard],
  });
  const parsed = out ? JSON.parse(out) : {};
  assert.notEqual(parsed.decision, 'block');
  rmSync(repo, { recursive: true, force: true });
});

test('the block survives a second identical call', async () => {
  const repo = makeRepo();
  const args = {
    version: 'test', apiKey: '', apiUrl: '', now: Date.now(), sessionId: 's1',
    filePath: path.join(repo, 'ci', 'projects.yml'), standards: [standard],
  };
  const first = JSON.parse(await editReminder(args));
  const second = JSON.parse(await editReminder(args));
  assert.equal(first.decision, 'block');
  assert.equal(second.decision, 'block', 'the guard must not be a once-per-session reminder');
  rmSync(repo, { recursive: true, force: true });
});

test('the shell hook routes edit tools into this module', () => {
  // The registered hook on macOS/Linux is the .sh, and it hands edit tools to this file.
  // If that ever stops being true, the guard silently stops running on those platforms.
  const sh = readFileSync(new URL('../hooks/ownmind-iron-rule-check.sh', import.meta.url), 'utf8');
  assert.match(sh, /Edit\|Write\|MultiEdit\|NotebookEdit/);
  assert.match(sh, /ownmind-edit-reminder\.js/);
});

test('an empty sync response never overwrites a populated cache', async () => {
  // Behavioural: a regex over the source would be satisfied by a comment, and this exact
  // guard once failed for real - one empty response disarmed every iron rule at once.
  const { mayReplaceCache } = await import('../hooks/lib/conditional-sync.js');
  assert.equal(mayReplaceCache({ team_standard: [] }, { team_standard: [{ id: 1 }] }), false);
  assert.equal(mayReplaceCache({ team_standard: [{ id: 1 }] }, { team_standard: [] }), true);
  assert.equal(mayReplaceCache({ team_standard: [] }, { team_standard: [] }), true);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-edit-guard.test.js`
Expected: FAIL — 前三項紅（`editReminder` 尚不接受 `filePath` / `standards`，也不回 block）

- [ ] **Step 3: 改 `ownmind-edit-reminder.js`**

修改檔頭註解（第 10-13 行），把「never blocks」改為：

```javascript
 * The edit trigger blocks in exactly one case: a file whose path a team standard marks as
 * off limits. Everything else on this path is still a reminder. The guard lives here, not
 * in ownmind-iron-rule-check.js, because on macOS and Linux the registered hook is the .sh
 * twin (install.sh passes --bash), and that twin hands every edit tool to this file and
 * exits - so a guard written in the .js hook would never run on those platforms at all.
```

在 import 區塊加入：

```javascript
import path from 'node:path';
import { findGuardViolation, findContentMention, formatGuardBlock } from './lib/path-guard.js';
import { readEnforcementBundle } from './lib/enforcement-cache.js';
```

在 `editReminder()` 函式簽名加入兩個選填參數並在**最開頭**插入閘門：

```javascript
export async function editReminder({
  version, apiKey, apiUrl, now, sessionId,
  filePath,                                   // injected by the caller from tool_input
  content = '',                               // the text about to be written, when present
  standards = null,                           // injected by tests; read from cache otherwise
}) {
  // The guard runs before the throttle. A reminder may be shown once an hour; a block must
  // fire every single time, or it is not a guarantee.
  if (filePath || content) {
    try {
      const cached = standards || readEnforcementBundle().guards;
      // Path first: that is the hard case, an actual edit to an owned file.
      const violation = filePath ? findGuardViolation(filePath, cached) : null;
      if (violation) {
        const reason = formatGuardBlock(violation);
        return JSON.stringify({
          decision: 'block',
          reason,
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason },
        });
      }
      // Then content: a document at a legal path that proposes the forbidden change. This
      // is what the 2026-08-13 incident actually produced, and path matching alone misses
      // it entirely.
      const mention = findContentMention(content, cached);
      if (mention) {
        const note = `[OwnMind] standard ${mention.standard.id} covers ${mention.matchedPath}. `
          + 'This text proposes changes there. Re-read the standard before continuing: '
          + 'those paths are not yours to edit, whatever a permissions list in the repo says.';
        return JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note },
        });
      }
    } catch { /* fail open: a broken guard must not stop the user editing files */ }
  }
```

（其餘函式主體不變。）

- [ ] **Step 4: 建立快取讀取模組**

```javascript
// hooks/lib/enforcement-cache.js
/**
 * The enforcement bundle: selection keys and guard rules, with no rule text.
 *
 * Its own file, and this is not a preference. `memories.json` is written from the compact
 * init response, whose documented contract (shared/init-cache.js) is that it carries NO
 * team standards at all - verified by reading the real cache on a working machine, where
 * the only standard-shaped things present are a digest string and five {id, title, hint}
 * entries. And `holdsInitPayload` (conditional-sync.js:93-99) actively REJECTS a payload
 * that contains type-keyed arrays, so the bundle could not be folded in there even if the
 * server started sending it.
 *
 * An earlier draft of this plan claimed team standards were already cached and had the
 * guard read `memories.json.team_standard`. That key has never existed. The guard would
 * have read [] on every machine, blocked nothing ever, and passed every test - which is
 * the failure this whole feature exists to prevent, reproduced inside its own guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ENFORCEMENT_CACHE_FILE = 'enforcement.json';

/**
 * The whole bundle. Callers pick the list they need - and they must pick, because handing
 * the wrong list to the wrong consumer is silent: an earlier draft returned only `guards`
 * from the function all three hooks called, so every rule that had no path guard (which is
 * most of them, including every communication rule) was dropped before anything looked at
 * it, and nothing anywhere reported a problem.
 *
 * `present` distinguishes "synced and there is nothing" from "never synced". Without it a
 * fresh install looks identical to a user with no rules, and the feature would fail closed
 * and quiet - the failure this product exists to prevent.
 *
 * @returns {{selectors: Array<object>, guards: Array<object>, injectables: Array<object>, present: boolean}}
 */
export function readEnforcementBundle(cachePath) {
  const file = cachePath || path.join(os.homedir(), '.ownmind', 'cache', ENFORCEMENT_CACHE_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      selectors: Array.isArray(parsed?.selectors) ? parsed.selectors : [],
      guards: Array.isArray(parsed?.guards) ? parsed.guards : [],
      injectables: Array.isArray(parsed?.injectables) ? parsed.injectables : [],
      present: true,
    };
  } catch {
    return { selectors: [], guards: [], injectables: [], present: false };
  }
}
```

⚠️ **不要再提供一支「回傳單一清單」的便利函式。** 上一版的 `readEnforcementCache()` 只回 `guards`，而三支 hook 都呼叫它，結果沒有路徑禁區的規範（也就是絕大多數，包含所有溝通類規範）在第一步就被丟掉，而且沒有任何地方會報錯。呼叫端一律明寫要哪一份：

| 呼叫端 | 用哪一份 |
|---|---|
| 硬擋（Task 8） | `guards` |
| 本機先篩（Task 6） | `selectors` |
| 注入（Task 9） | `injectables` |

- [ ] **Step 5: 讓兩支呼叫端把 `file_path` 傳進來**

在 `hooks/ownmind-edit-reminder.js` 的 `main()` 內，`readSessionId()` 旁加入讀取並傳入：

```javascript
/** The path the edit tool is about to write, when the payload carries one. */
function readFilePath() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return '';
    const p = JSON.parse(raw);
    return typeof p?.tool_input?.file_path === 'string' ? p.tool_input.file_path : '';
  } catch {
    return '';
  }
}
```

⚠️ stdin 只能讀一次，因此把 `readSessionId()` 與 `readFilePath()` 合併成單次讀取：

```javascript
/**
 * Read the hook payload from stdin - but only when something is actually piping.
 *
 * `readFileSync(0)` on an interactive terminal blocks forever waiting for input, which
 * turns "run this file by hand to see what it does" into a hung shell. The .sh twin always
 * pipes, so the guarded read costs nothing in the path that matters.
 */
function readPayload() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

async function main() {
  const { apiKey, apiUrl } = readCredentials();
  const payload = readPayload();
  const ti = payload?.tool_input || {};
  const out = await editReminder({
    version: getClientVersion(),
    apiKey,
    apiUrl,
    now: Date.now(),
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : '',
    filePath: typeof ti.file_path === 'string' ? ti.file_path : '',
    // Write carries `content`, Edit carries `new_string`. Both are the text about to land.
    content: [ti.content, ti.new_string].filter((s) => typeof s === 'string').join('\n'),
  });
  if (out) console.log(out);
}
```

同時在 `hooks/ownmind-iron-rule-check.js` 的 edit 路徑（第 105-109 行）把 `filePath` 一併傳入：

```javascript
  if (trigger === 'edit') {
    // `input` was already read at the top of main(); parsed again here rather than piping
    // stdin a second time, which would block - fd 0 is spent.
    let filePath = '';
    let content = '';
    try {
      const ti = JSON.parse(input)?.tool_input || {};
      filePath = typeof ti.file_path === 'string' ? ti.file_path : '';
      content = [ti.content, ti.new_string].filter((s) => typeof s === 'string').join('\n');
    } catch { /* no path in payload */ }
    const out = await editReminder({
      version: VERSION, apiKey, apiUrl, now: Date.now(), sessionId, filePath, content,
    });
    if (out) console.log(out);
    process.exit(0);
  }
```

- [ ] **Step 6: 補上「空回應不得覆蓋快取」**

在 `hooks/lib/conditional-sync.js` 寫入快取之前加入守門（沿用 `iron-rule-sync.js` 第 45-52 行的判準）：

```javascript
/**
 * An empty fetch never replaces a populated cache.
 *
 * Emptiness is far more often a broken request than a user who deleted every rule, and a
 * stale cache still enforces something while an empty one enforces nothing. This is the
 * same rule iron-rule-sync.js applies, for the same reason: one empty response once
 * disarmed every iron rule at once.
 */
export function mayReplaceCache(fetched, existing) {
  const fetchedCount = Object.values(fetched || {}).reduce(
    (n, v) => n + (Array.isArray(v) ? v.length : 0), 0,
  );
  const existingCount = Object.values(existing || {}).reduce(
    (n, v) => n + (Array.isArray(v) ? v.length : 0), 0,
  );
  if (fetchedCount === 0 && existingCount > 0) return false;
  return true;
}
```

並在實際寫檔處以 `if (!mayReplaceCache(next, current)) return current;` 擋下。

- [ ] **Step 7: 跑測試確認通過**

Run: `node --test tests/enforcement-edit-guard.test.js`
Expected: PASS（5 tests）

- [ ] **Step 8: 端到端 — 經 `.sh` 入口跑一次（spec §7.1 第一列）**

```bash
REPO=$(mktemp -d /tmp/enforcement-guard-fixture-XXXX)
git init -q "$REPO" && git -C "$REPO" remote add origin https://example.com/enforcement-guard-fixture.git
mkdir -p "$REPO/ci" && echo 'projects: {}' > "$REPO/ci/projects.yml"
printf '{"tool_name":"Edit","session_id":"s1","tool_input":{"file_path":"%s/ci/projects.yml"}}' "$REPO" \
  | bash hooks/ownmind-iron-rule-check.sh
```

Expected: stdout 是含 `"decision":"block"` 的 JSON。**這一步是本任務的真正驗收**：直接呼叫 `.js` 通過不代表 mac 上會擋。

- [ ] **Step 9: 跑整組 hook 測試**

Run: `node --test tests/edit-reminder*.test.js tests/conditional-sync*.test.js`
Expected: 全數 PASS

- [ ] **Step 10: Commit**

```bash
git add hooks/ownmind-edit-reminder.js hooks/ownmind-iron-rule-check.js \
        hooks/lib/enforcement-cache.js hooks/lib/conditional-sync.js \
        tests/enforcement-edit-guard.test.js
git commit -m "feat(enforcement): block forbidden-path edits from the hook that actually runs"
```

---

## Task 9: 規範注入（UserPromptSubmit）與註冊

**Files:**
- Create: `hooks/ownmind-prompt-inject.js`
- Modify: `scripts/install-helpers/ensure-pretooluse-hooks.cjs`
- Modify: `install.sh`、`install.ps1`
- Test: `tests/enforcement-prompt-inject.test.js`

**Interfaces:**
- Consumes: `readEnforcementBundle`（Task 0.5）的 `injectables` —— 唯一帶規範內文的那份
- Produces: `buildInjection(standards, userPrompt, repoRemote, alreadyInjectedIds) → { text: string, injectedIds: number[] }`

**致命點（spec §4.3）：** 全 repo 目前**零處註冊 UserPromptSubmit**。hook 檔存在但沒註冊＝測試全綠、永不執行。

- [ ] **Step 1: 寫失敗測試**

```javascript
// tests/enforcement-prompt-inject.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInjection } from '../hooks/ownmind-prompt-inject.js';

// A flat injectable, exactly what buildBundle emits and the sync writes to disk. A test
// that fed this function a database row would pass while the real hook matched nothing.
const standard = {
  id: 412, title: 'ci ownership',
  content: 'Only Eric may edit ci/.',
  keywords: ['FAPA'],
  always_check: false,
  repo_match: 'fapa-repo',
  paths: ['ci/**'],
  owner: 'Eric',
};

test('a keyword match injects the standard', () => {
  const { text, injectedIds } = buildInjection([standard], 'migrate ownmind to FAPA', null, []);
  assert.deepEqual(injectedIds, [412]);
  assert.match(text, /Only Eric may edit/);
});

test('the injection leads with the precedence declaration, before the full text', () => {
  // The incident was not a delivery failure - the AI had the text and trusted a repo file
  // over it. The precedence sentence is the part that addresses that, so it goes first.
  const { text } = buildInjection([standard], 'FAPA', null, []);
  const precedenceAt = text.search(/優先於|takes precedence/);
  const bodyAt = text.indexOf('Only Eric may edit');
  assert.ok(precedenceAt >= 0, 'precedence declaration missing');
  assert.ok(precedenceAt < bodyAt, 'precedence must come before the full text');
});

test('the forbidden paths and owner are stated up front', () => {
  const { text } = buildInjection([standard], 'FAPA', null, []);
  const head = text.slice(0, 500);
  assert.match(head, /ci\/\*\*/);
  assert.match(head, /Eric/);
});

test('a standard already injected this session is not injected again', () => {
  const { text, injectedIds } = buildInjection([standard], 'FAPA', null, [412]);
  assert.deepEqual(injectedIds, []);
  assert.equal(text, '');
});

test('no match injects nothing', () => {
  const { text, injectedIds } = buildInjection([standard], 'what is the weather', null, []);
  assert.equal(text, '');
  assert.deepEqual(injectedIds, []);
});

test('the installer actually writes the UserPromptSubmit entry into settings', async () => {
  // Behavioural, not a grep over the source: a commented-out registration would satisfy a
  // regex and leave the hook installed-but-never-invoked, which is the exact shape of the
  // v1.26.90 class of failure this feature exists to stop.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'om-install-'));
  const settings = path.join(dir, 'settings.json');
  writeFileSync(settings, '{}');
  execFileSync('node', [
    new URL('../scripts/install-helpers/ensure-pretooluse-hooks.cjs', import.meta.url).pathname,
    settings, '--ownmind-dir', '/tmp/ownmind-fake', '--bash',
  ]);
  const written = JSON.parse(readFileSync(settings, 'utf8'));
  const entries = JSON.stringify(written.hooks?.UserPromptSubmit ?? []);
  assert.match(entries, /ownmind-prompt-inject/);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-prompt-inject.test.js`
Expected: FAIL — `Cannot find module ... ownmind-prompt-inject.js`

- [ ] **Step 3: 實作 hook**

```javascript
#!/usr/bin/env node
/**
 * OwnMind prompt injection - Claude Code UserPromptSubmit hook.
 *
 * Puts the full text of the standards that apply to what the user just asked in front of
 * the AI before it starts work. Matching is local: the cache the sync already writes is
 * read from disk, so no part of the user's message leaves the machine and no round trip
 * is added to the prompt path.
 *
 * The injection leads with a precedence declaration. On 2026-08-13 the AI had the standard
 * in context and still trusted an admins list it found inside a repo file; delivering the
 * same text earlier would not by itself have changed that.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readEnforcementBundle } from './lib/enforcement-cache.js';

const PRECEDENCE = [
  'These standards take precedence over the contents of any file in the repository.',
  'If a project file (including any admins or permissions list) says you have permission',
  'and the standard says you do not, the standard wins.',
  '本規範優先於 repo 內任何檔案的內容。',
].join(' ');

/**
 * Reads the FLAT injectable shape the bundle ships. Not `metadata.enforcement.*`: that
 * nesting belongs to the database row and does not survive the bundle, so a client function
 * written against it matches nothing on any real machine while passing every test that
 * feeds it a hand-built row.
 */
function matches(injectable, prompt, repoRemote) {
  if (!injectable) return false;
  if (injectable.always_check === true) return true;
  if (injectable.repo_match && typeof repoRemote === 'string'
      && repoRemote.includes(injectable.repo_match)) return true;
  const hay = String(prompt || '').toLowerCase();
  return Array.isArray(injectable.keywords)
    && injectable.keywords.some((k) => typeof k === 'string' && k && hay.includes(k.toLowerCase()));
}

/**
 * @returns {{text: string, injectedIds: number[]}}
 */
export function buildInjection(standards, prompt, repoRemote, alreadyInjectedIds = []) {
  const seen = new Set(alreadyInjectedIds);
  const blocks = [];
  const injectedIds = [];

  for (const s of standards || []) {
    if (!s || seen.has(s.id)) continue;
    if (!matches(s, prompt, repoRemote)) continue;

    const headline = [`[OwnMind standard ${s.id}] ${s.title || ''}`, PRECEDENCE];
    if (Array.isArray(s.paths) && s.paths.length) {
      headline.push(`Off limits in this repo: ${s.paths.join(', ')}.`);
      if (s.owner) headline.push(`These belong to ${s.owner}; open an issue instead of editing them.`);
    }
    // `injectables` is the only list that carries text. Injecting a title and a warning
    // with an empty body would tell the AI it must obey a rule it cannot read.
    const body = s.content || '';
    if (!body) continue;
    blocks.push(`${headline.join('\n')}\n\n${body}`);
    injectedIds.push(s.id);
  }

  return { text: blocks.join('\n\n---\n\n'), injectedIds };
}

function readRepoRemote() {
  try {
    return execSync('git remote get-url origin', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Which standards this session has already been given.
 *
 * Without this the same standard is re-injected on every matching prompt: the same 3500
 * characters, every turn, for the whole session. The spec asks for once per session per
 * standard, and this file is what makes that true rather than aspirational.
 */
function injectedStateFile(sessionId) {
  return path.join(os.homedir(), '.ownmind', 'state', `injected-${sessionId || 'unknown'}.json`);
}

function readInjectedIds(sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(injectedStateFile(sessionId), 'utf8'));
    return Array.isArray(parsed?.ids) ? parsed.ids : [];
  } catch {
    return [];
  }
}

function recordInjectedIds(sessionId, ids) {
  if (!ids.length) return;
  try {
    const file = injectedStateFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const merged = Array.from(new Set([...readInjectedIds(sessionId), ...ids]));
    fs.writeFileSync(file, JSON.stringify({ ids: merged }), 'utf8');
  } catch { /* at worst the standard is injected twice */ }
}

async function main() {
  if (process.stdin.isTTY) process.exit(0);
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch { /* no payload */ }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt) process.exit(0);

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const { text, injectedIds } = buildInjection(
    readEnforcementBundle().injectables, prompt, readRepoRemote(), readInjectedIds(sessionId),
  );
  if (!text) process.exit(0);
  recordInjectedIds(sessionId, injectedIds);

  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
  }));
}

if (process.argv[1] && process.argv[1].endsWith('ownmind-prompt-inject.js')) {
  main().catch(() => process.exit(0));
}
```

- [ ] **Step 4: 在安裝工具註冊**

在 `scripts/install-helpers/ensure-pretooluse-hooks.cjs` 的 `ensureHooks()` 內，PreToolUse 處理之後加入 UserPromptSubmit 區塊（沿用同一份既有的「找到既有項目就更新、否則新增」邏輯，比對字串為 `ownmind-prompt-inject`）：

```javascript
// UserPromptSubmit: puts the standards that apply to the request in front of the AI
// before it starts. Registered here rather than in install.sh so that the upgrade path
// picks it up too - a hook file that ships without a settings entry is a hook that never
// runs, and every unit test still passes.
const INJECT_IDENTIFIER_SUBSTR = 'ownmind-prompt-inject';
function buildInjectCmd(ownmindDir) {
  return `node ${path.join(ownmindDir, 'hooks', 'ownmind-prompt-inject.js').replace(/\\/g, '/')}`;
}
```

並在 `settings.hooks.UserPromptSubmit` 陣列上套用與 PreToolUse 相同的新增／更新處理。

- [ ] **Step 5: 跑測試確認通過**

Run: `node --test tests/enforcement-prompt-inject.test.js`
Expected: PASS（6 tests）

- [ ] **Step 6: 端到端 — 確認註冊真的寫進 settings**

```bash
TMP=$(mktemp -d) && echo '{}' > "$TMP/settings.json"
node scripts/install-helpers/ensure-pretooluse-hooks.cjs "$TMP/settings.json" --ownmind-dir "$HOME/.ownmind" --bash
grep -c "ownmind-prompt-inject" "$TMP/settings.json"
```

Expected: 輸出 `1` 以上。

- [ ] **Step 7: Commit**

```bash
git add hooks/ownmind-prompt-inject.js scripts/install-helpers/ensure-pretooluse-hooks.cjs \
        install.sh install.ps1 tests/enforcement-prompt-inject.test.js
git commit -m "feat(enforcement): inject applicable standards at prompt time"
```

---

## Task 10: 防止規範被靜靜繳械

**Files:**
- Modify: `src/routes/memory.js`（`ownmind_update` 對應的更新處理）
- Test: `tests/enforcement-metadata-guard.test.js`

**Interfaces:**
- Produces: 更新記憶時若既有 metadata 有 `enforcement` 而新的沒有 → 回 `409`，除非帶 `allow_enforcement_removal: true`

**背景（spec §5）：** `mcp/index.js` 第 561 行明載 metadata 是**整包取代不是合併**。AI 只要為了改一個 `invocation_hint` 更新規範，就會把 `enforcement` 一起抹掉，三道機制同時失效、測試全綠、沒有人會發現。

- [ ] **Step 1: 寫失敗測試**

```javascript
// tests/enforcement-metadata-guard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEnforcementRemoval } from '../src/lib/enforcement/metadata-guard.js';

test('dropping an existing enforcement block is refused', () => {
  const existing = { enforcement: { guard: { paths: ['ci/**'] } }, invocation_hint: 'x' };
  const incoming = { invocation_hint: 'y' };
  const r = checkEnforcementRemoval(existing, incoming);
  assert.equal(r.blocked, true);
  assert.match(r.message, /enforcement/i);
});

test('keeping it is fine', () => {
  const existing = { enforcement: { guard: { paths: ['ci/**'] } } };
  const incoming = { enforcement: { guard: { paths: ['ci/**'] } }, invocation_hint: 'y' };
  assert.equal(checkEnforcementRemoval(existing, incoming).blocked, false);
});

test('a memory that never had one is unaffected', () => {
  assert.equal(checkEnforcementRemoval({ a: 1 }, { b: 2 }).blocked, false);
});

test('an explicit removal flag is honoured', () => {
  const existing = { enforcement: { guard: {} } };
  assert.equal(checkEnforcementRemoval(existing, {}, { allowRemoval: true }).blocked, false);
});

test('an empty enforcement object is a removal, not a keep', () => {
  // The cheapest way to disarm a rule while looking compliant.
  const existing = { enforcement: { guard: { paths: ['ci/**'] } } };
  assert.equal(checkEnforcementRemoval(existing, { enforcement: {} }).blocked, true);
});

test('dropping the guard while keeping keywords is still a removal', () => {
  // Turns a hard block into a suggestion, silently.
  const existing = { enforcement: { guard: { paths: ['ci/**'] }, keywords: ['FAPA'] } };
  const r = checkEnforcementRemoval(existing, { enforcement: { keywords: ['FAPA'] } });
  assert.equal(r.blocked, true);
  assert.match(r.message, /guard/);
});

test('keeping every enforcing key is allowed even when other metadata changes', () => {
  const existing = { enforcement: { guard: { paths: ['ci/**'] } }, invocation_hint: 'x' };
  const incoming = { enforcement: { guard: { paths: ['ci/**'] } }, invocation_hint: 'y' };
  assert.equal(checkEnforcementRemoval(existing, incoming).blocked, false);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-metadata-guard.test.js`
Expected: FAIL — `Cannot find module ... metadata-guard.js`

- [ ] **Step 3: 實作**

```javascript
// src/lib/enforcement/metadata-guard.js
/**
 * Refuse the update that silently disarms a standard.
 *
 * Memory metadata is replaced wholesale, not merged (see the tool description in
 * mcp/index.js). So an assistant updating one unrelated field - an invocation hint, a tag -
 * erases the enforcement block in the same call, and with it the injection, the guard and
 * the semantic check for that standard. Every test still passes and nobody is told. That
 * makes this the cheapest path to a rule that has quietly stopped being enforced, which is
 * the failure this whole feature exists to prevent.
 */

/**
 * @param {object|null} existingMetadata
 * @param {object|null} incomingMetadata
 * @param {{allowRemoval?: boolean}} [opts]
 * @returns {{blocked: boolean, message?: string}}
 */
export function checkEnforcementRemoval(existingMetadata, incomingMetadata, opts = {}) {
  if (opts.allowRemoval === true) return { blocked: false };
  const before = existingMetadata?.enforcement;
  if (!before || typeof before !== 'object') return { blocked: false };
  const after = incomingMetadata?.enforcement;

  // Not just "is there still an enforcement object". An empty {} satisfies that and
  // disarms the rule just as completely as deleting the key, and an update that keeps
  // `keywords` while dropping `guard` silently turns a hard block into a suggestion. Every
  // key that was doing work has to survive.
  const ENFORCING_KEYS = ['guard', 'keywords', 'always_check'];
  if (after && typeof after === 'object') {
    const lost = ENFORCING_KEYS.filter((k) => before[k] !== undefined && after[k] === undefined);
    if (lost.length === 0) return { blocked: false };
    return {
      blocked: true,
      message: `This update drops ${lost.join(', ')} from a standard that is being enforced. `
        + 'Metadata is replaced, not merged: read the memory first and send those keys back. '
        + 'To remove them deliberately, resend with allow_enforcement_removal: true.',
    };
  }

  return {
    blocked: true,
    message: 'This update would remove the enforcement block from a standard that is being enforced. '
      + 'Metadata is replaced, not merged: read the memory first and send the enforcement block back. '
      + 'To remove it deliberately, resend with allow_enforcement_removal: true.',
  };
}
```

- [ ] **Step 4: 接進更新路徑**

在 `src/routes/memory.js` 的更新處理中，取得既有記憶之後、寫入之前：

```javascript
import { checkEnforcementRemoval } from '../lib/enforcement/metadata-guard.js';

// ... inside the update handler, after the memory is loaded. The variable there is
// `oldMemory` (src/routes/memory.js:1412), not `existing`; the wrong name here would throw
// a ReferenceError and 500 every metadata-carrying update.
if (metadata !== undefined) {
  const guardResult = checkEnforcementRemoval(
    oldMemory.metadata, metadata,
    { allowRemoval: req.body.allow_enforcement_removal === true },
  );
  if (guardResult.blocked) {
    return res.status(409).json({ error: guardResult.message });
  }
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `node --test tests/enforcement-metadata-guard.test.js`
Expected: PASS（4 tests）

- [ ] **Step 6: Commit**

```bash
git add src/lib/enforcement/metadata-guard.js src/routes/memory.js tests/enforcement-metadata-guard.test.js
git commit -m "fix(enforcement): refuse metadata updates that silently drop enforcement"
```

---

## Task 11: 白老鼠階段的度量與誤判標記

**Files:**
- Modify: `src/routes/compliance.js`（加 `GET /api/compliance/stats`）
- Test: `tests/enforcement-stats.test.js`

**Interfaces:**
- Produces: `GET /api/compliance/stats?days=7` → `{ total, by_outcome: {clean,violation,skipped,failed}, false_positive_rate, not_run_rate, p95_latency_ms }`

**背景（spec §9）：** 擴大到團隊的四個門檻（誤判率 < 10%、p95 延遲 < 5 秒、未執行率 < 5%、漏抓逐案檢討）都要從這裡算得出來，否則「感覺還行」就會變成擴大的依據。

- [ ] **Step 1: 寫失敗測試**

```javascript
// tests/enforcement-stats.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../src/lib/enforcement/stats.js';

const rows = [
  { outcome: 'violation', latency_ms: 1000, user_feedback: 'false_positive' },
  { outcome: 'violation', latency_ms: 2000, user_feedback: 'correct' },
  { outcome: 'clean', latency_ms: 900, user_feedback: null },
  { outcome: 'failed', latency_ms: 8000, user_feedback: null },
  { outcome: 'skipped', latency_ms: 50, user_feedback: null },
];

test('the false positive rate counts only judged findings', () => {
  // 2 findings, 1 marked wrong. Unreviewed findings must not be counted as correct.
  const s = computeStats(rows);
  assert.equal(s.false_positive_rate, 0.5);
});

test('findings with no feedback are reported separately, not assumed correct', () => {
  const s = computeStats([{ outcome: 'violation', latency_ms: 10, user_feedback: null }]);
  assert.equal(s.false_positive_rate, null, 'no reviewed findings means no rate, not zero');
  assert.equal(s.unreviewed_findings, 1);
});

test('the not-run rate covers failed and skipped', () => {
  const s = computeStats(rows);
  assert.equal(s.not_run_rate, 2 / 5);
});

test('p95 latency is reported', () => {
  const s = computeStats(rows);
  assert.equal(typeof s.p95_latency_ms, 'number');
  assert.ok(s.p95_latency_ms >= 2000);
});

test('an empty set does not divide by zero', () => {
  const s = computeStats([]);
  assert.equal(s.total, 0);
  assert.equal(s.false_positive_rate, null);
  assert.equal(s.not_run_rate, null);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `node --test tests/enforcement-stats.test.js`
Expected: FAIL — `Cannot find module ... stats.js`

- [ ] **Step 3: 實作**

```javascript
// src/lib/enforcement/stats.js
/**
 * The four numbers the pilot has to clear before the rollout widens.
 *
 * `false_positive_rate` is null rather than zero when nothing has been reviewed. Reporting
 * zero would let an unreviewed pilot read as a perfect one, and the whole point of the
 * pilot is to find out whether this is usable before anyone else is exposed to it.
 */

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function computeStats(rows) {
  const total = rows.length;
  const byOutcome = { clean: 0, violation: 0, skipped: 0, failed: 0 };
  for (const r of rows) {
    if (byOutcome[r.outcome] !== undefined) byOutcome[r.outcome] += 1;
  }

  const findings = rows.filter((r) => r.outcome === 'violation');
  const reviewed = findings.filter((r) => r.user_feedback === 'correct' || r.user_feedback === 'false_positive');
  const falsePositives = reviewed.filter((r) => r.user_feedback === 'false_positive');

  const notRun = byOutcome.failed + byOutcome.skipped;

  return {
    total,
    by_outcome: byOutcome,
    findings: findings.length,
    unreviewed_findings: findings.length - reviewed.length,
    false_positive_rate: reviewed.length > 0 ? falsePositives.length / reviewed.length : null,
    not_run_rate: total > 0 ? notRun / total : null,
    p95_latency_ms: percentile(rows.map((r) => r.latency_ms).filter((n) => Number.isFinite(n)), 95),
  };
}
```

- [ ] **Step 4: 加上路由**

在 `src/routes/compliance.js` 的 `createComplianceRouter` 內加入：

```javascript
  router.get('/stats', async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    try {
      const r = await queryFn(
        `SELECT outcome, latency_ms, user_feedback
           FROM compliance_checks
          WHERE user_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
        [req.user?.id, String(days)],
      );
      return res.json({ days, ...computeStats(r.rows) });
    } catch (err) {
      logger.warn?.('compliance: stats failed', { err: err.message });
      return res.status(500).json({ error: 'failed to compute stats' });
    }
  });
```

並在檔頭加入 `import { computeStats } from '../lib/enforcement/stats.js';`

- [ ] **Step 5: 跑測試確認通過**

Run: `node --test tests/enforcement-stats.test.js`
Expected: PASS（5 tests）

- [ ] **Step 6: Commit**

```bash
git add src/lib/enforcement/stats.js src/routes/compliance.js tests/enforcement-stats.test.js
git commit -m "feat(enforcement): pilot metrics for the rollout criteria"
```

---

## Task 12: 端到端重演事故 ＋ 文件同步

**Files:**
- Create: `tests/enforcement-e2e-incident.test.js`
- Modify: `README.md`、`docs/README.zh-TW.md`、`docs/README.ja.md`、`FILELIST.md`、`CHANGELOG.md`
- Modify: `package.json`（版號）

**Interfaces:**
- Consumes: Task 1-11 全部

- [ ] **Step 1: 寫端到端測試**

```javascript
// tests/enforcement-e2e-incident.test.js
/**
 * Replay of the 2026-08-13 incident.
 *
 * The AI was asked to migrate a project into a monorepo, read the standard that forbids
 * editing ci/projects.yml, and then proposed editing it anyway while telling the user they
 * had permission. Each layer is asserted separately, because each one fails differently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInjection } from '../hooks/ownmind-prompt-inject.js';
import { findGuardViolation } from '../hooks/lib/path-guard.js';
import { buildBundle } from '../src/routes/enforcement-bundle.js';
import { selectRules } from '../src/lib/enforcement/select-rules.js';
import { buildJudgeMessages, normaliseVerdicts } from '../src/lib/enforcement/judge-prompt.js';

const std412 = {
  id: 412, type: 'team_standard', title: 'ci ownership belongs to Eric',
  content: 'The /ci directory and the root .gitlab-ci.yml are maintained by Eric. '
    + 'No other engineer, including admins listed in ci/projects.yml, may modify them. '
    + 'Open an issue for Eric instead.',
  tags: [],
  metadata: { enforcement: {
    keywords: ['FAPA', 'onboarding', 'ci/projects.yml'],
    guard: { repo_match: 'incident-fixture-fapa', paths: ['ci/**', '.gitlab-ci.yml'], owner: 'Eric' },
  } },
};

// The client sees what buildBundle produced, never the row above. Deriving the client
// fixtures from the row - through the real function - is what stops the two drifting: if
// buildBundle ever stops emitting a field the client reads, these tests go red.
const { guards: BUNDLE_GUARDS, injectables: BUNDLE_INJECTABLES } = buildBundle([std412]);

const THE_BAD_REPLY = 'Stage 0: I will add an entry to ci/projects.yml and write '
  + 'ci/ownmind/.gitlab-ci.yml. You are listed as an admin so I have permission.';

test('layer 1: the standard is injected when the user mentions FAPA', () => {
  const { text, injectedIds } = buildInjection(BUNDLE_INJECTABLES, 'ownmind 專案要遷移到 FAPA', null, []);
  assert.deepEqual(injectedIds, [412]);
  assert.match(text, /No other engineer, including admins/);
  assert.ok(text.indexOf('takes precedence') < text.indexOf('The /ci directory'),
    'the precedence declaration must precede the body');
});

test('layer 2: the bad reply selects the standard for judging', () => {
  const { selected } = selectRules([std412], {
    assistantText: THE_BAD_REPLY, userPrompts: ['migrate to FAPA'], repoRemote: null, toolsUsed: [],
  });
  assert.deepEqual(selected.map((s) => s.id), [412]);
  const msgs = buildJudgeMessages({ rules: selected, assistantText: THE_BAD_REPLY, userPrompts: [] });
  assert.match(msgs.map((m) => m.content).join('\n'), /I will add an entry to ci\/projects\.yml/);
});

test('layer 2: a judge verdict on that reply becomes a reported violation', () => {
  // The object callLLMSwitch hands back, not a string - verified against the real function.
  const judged = { verdicts: [{
    ruleId: 412, violated: true,
    evidence: 'I will add an entry to ci/projects.yml',
    fix: 'open an issue for Eric',
  }] };
  const { verdicts, parseFailed } = normaliseVerdicts(judged);
  assert.equal(parseFailed, false);
  assert.equal(verdicts[0].violated, true);
});

test('layer 3: the edit itself is blocked, from a session running in a different repo', () => {
  const fapa = mkdtempSync(path.join(os.tmpdir(), 'incident-fixture-fapa-'));
  execFileSync('git', ['init', '-q', fapa]);
  execFileSync('git', ['-C', fapa, 'remote', 'add', 'origin', 'https://example.com/incident-fixture-fapa.git']);
  mkdirSync(path.join(fapa, 'ci'), { recursive: true });
  writeFileSync(path.join(fapa, 'ci', 'projects.yml'), 'projects: {}\n');

  const v = findGuardViolation(path.join(fapa, 'ci', 'projects.yml'), BUNDLE_GUARDS);
  assert.ok(v, 'the edit must be blocked regardless of where the session started');
  assert.equal(v.standard.id, 412);
  rmSync(fapa, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑測試確認通過**

Run: `node --test tests/enforcement-e2e-incident.test.js`
Expected: PASS（4 tests）

- [ ] **Step 3: 跑全部測試**

Run: `npm test`
Expected: 全數 PASS（含既有 316 個測試檔）

- [ ] **Step 4: 更新文件**

- `CHANGELOG.md`：新增版本段落。措辭必須符合 Global Constraints：**只能寫**「動作層強制、回話層即時查核；目前僅 Claude Code、且僅對啟用的帳號生效」，**不得寫**「OwnMind 會強制 AI 遵守規範」。
- `README.md` / `docs/README.zh-TW.md` / `docs/README.ja.md`：三語系同步（IR-032）。
- `FILELIST.md`：新增 11 個檔案（`db/025_enforcement.sql`、`src/lib/enforcement/*` 四支、`src/routes/compliance.js`、`hooks/lib/compliance-client.js`、`hooks/lib/path-guard.js`、`hooks/lib/enforcement-cache.js`、`hooks/ownmind-prompt-inject.js`）。
- `package.json`：版號 +1。

- [ ] **Step 5: 突變測試總驗收（spec §7.1）**

逐列執行，每一列都要**親眼看到紅**再改回來。建議寫成一份可重跑的腳本 `scripts/enforcement-mutation-check.sh`，內容為：套用突變 → 跑對應測試 → 斷言 exit code 非 0 → 還原。

⚠️ 還原一律用備份檔，**不可用 `git checkout`**（IR-140：工作樹尚未 commit 時會連帶清掉別的改動）。

| 突變 | 對應測試 |
|---|---|
| 硬擋出口改 `process.exit(0)` | `enforcement-edit-guard.test.js` |
| repo 判斷改回 cwd | `enforcement-path-guard.test.js` |
| 查核固定回「無違規」 | `enforcement-route.test.js` |
| 挑規範固定回空陣列 | `enforcement-route.test.js`（skipped 案例） |
| 帳號開關判斷改成永遠通過 | `enforcement-route.test.js` |
| 移除 UserPromptSubmit 註冊 | `enforcement-prompt-inject.test.js` |
| `enforcement` 被抹掉不擋 | `enforcement-metadata-guard.test.js` |
| 空回應覆蓋快取 | `enforcement-edit-guard.test.js` |
| fragment 不併入 judgeText | `enforcement-select-rules.test.js` |

- [ ] **Step 6: Commit**

```bash
git add tests/enforcement-e2e-incident.test.js scripts/enforcement-mutation-check.sh \
        README.md docs/README.zh-TW.md docs/README.ja.md FILELIST.md CHANGELOG.md package.json
git commit -m "test(enforcement): replay the 2026-08-13 incident end to end"
```

---

## Task 13: 白老鼠上線

**Files:** 無程式碼變更。

- [ ] **Step 1: 部署**（依 IR-136，發版與部署一律先問 Vin；此步驟需他明確同意才執行）

- [ ] **Step 2: 只開 Vin 的帳號**

```sql
UPDATE users SET enforcement_mode = 'check' WHERE email = 'fontripdata@gmail.com';
```

- [ ] **Step 3: 確認別人沒被影響**

```sql
SELECT enforcement_mode, COUNT(*) FROM users GROUP BY enforcement_mode;
```

Expected: `check` 一人，其餘皆 `off`。

- [ ] **Step 4: 為 412 / 422 填上 enforcement 欄位**

用 `ownmind_update`，**且必須把既有 metadata 一併回填**（Task 10 的守門會擋下抹除，但正確做法是先讀再寫）。

- [ ] **Step 5: 觀察一週**

每日看 `GET /api/compliance/stats?days=7`，對照 spec §9 的四個門檻。發現誤判當下用 `POST /api/compliance/feedback` 標記，否則誤判率算不出來。

- [ ] **Step 6: 一週後回報 Vin，由他決定是否擴大**

擴大只是把別人的 `enforcement_mode` 改成 `check`，不需改程式、不需再發版。

---

## Self-Review

**1. Spec 覆蓋檢查**

| Spec 章節 | 對應 Task |
|---|---|
| §3 帳號層開關 | Task 1、4 |
| §4.0 優先權宣告 | Task 9 |
| §4.1 動作硬擋（實作位置、repo 解析、快取、涵蓋範圍） | Task 7、8 |
| §4.2 每輪語意查核（挑規範、提示、成本控制、留痕、門檻三改） | Task 2、3、4、5、6 |
| §4.3 注入與註冊 | Task 9 |
| §5 資料模型與 `ownmind_update` 守門 | Task 2、10 |
| §6 事故重演 | Task 12 |
| §7 測試與 §7.1 突變表 | 各 Task 的突變步驟 ＋ Task 12 Step 5 |
| §8.1 對外措辭限制 | Task 12 Step 4 |
| §9 白老鼠門檻與誤判標記 | Task 11、13 |

**2. Placeholder 掃描**：無 TBD／TODO；每個程式步驟都有可直接貼上的完整程式碼。

**3. 型別一致性**：`selectRules` 回傳 `{selected, budgetExceeded}`，Task 4 只取 `selected` 並在其上讀 `judgeText`／`id`／`title`／`code` —— 皆由 Task 2 的展開 `{...rule, judgeText}` 提供。`requestCheck` 回傳 `{outcome, violations, check_id, reason}`，Task 6 用到 `outcome`／`violations`／`reason`，一致。`findGuardViolation` 回傳 `{standard, matchedPath, relPath}`，`formatGuardBlock` 三者皆用，一致。

**4. 已知偏離 spec 之處（刻意）**：spec §4.2 提到「跳過空轉輪次」，本計畫改以 Task 6 的**本機先篩**達成同一目的（零規範命中就完全不送請求），比「輪次是否空轉」的啟發式更準確也更省。此偏離已註明，不視為遺漏。

---

## 對抗審查紀錄（本計畫）

### 第一輪：agy／Gemini 3.1 Pro (High)

四項回原始碼查證屬實，全數採納。

| # | 發現 | 查證 | 處置 |
|---|---|---|---|
| 1 | Task 6 貼進去的程式用 `LINT_DISABLED`，但該檔的常數叫 `DISABLED`；未定義識別字丟 `ReferenceError`，被空的 `catch {}` 吞掉 → **整段查核靜靜地永不執行** | 屬實：`hooks/ownmind-reply-lint.js:76` `const DISABLED = ...` | Task 6 整段重寫：邏輯抽成可單測的 `compliance-step.js`，`catch` 改為產生可見通知而非吞掉，並在步驟裡列出所有必須逐一核對的識別字 |
| 2 | 該檔 `stop_hook_active === true` 在第 170 行就 `exit 0`，早於原插入點（第 239 行）→ **AI 被退回後重寫的那一版永遠不會被檢查**，退回一次等於開一個永久後門 | 屬實 | 查核移到該早退之前；用自己的計數器 `MAX_COMPLIANCE_BLOCKS = 2` 設上限避免無限退回 |
| 3 | 客戶端送 `x-api-key`，伺服器只認 `Authorization: Bearer` → **每次查核 401** | 屬實：`src/middleware/auth.js:68-70`；同檔第 861 行既有寫法就是 Bearer | 改為 Bearer，並補一個會驗標頭格式的測試 |
| 4 | 大量測試用正則比對原始碼，把整段程式註解掉照樣綠 | 屬實 | Task 1 先剝掉 SQL 註解再斷言；Task 6 改為對決策模組做行為測試；Task 8 的快取守門改為呼叫 `mayReplaceCache` 實測；Task 9 的安裝註冊改為真的跑一次安裝工具再讀 `settings.json` |

另四項「計畫漏掉 spec 要求」也已補：注入的 session 去重（原本硬寫 `[]`）、編輯內容比對（`findContentMention`）、誤判標記的可用路徑（banner 帶上 check id）、成本與延遲收緊（規範上限 10→6、字元 40k→20k、客戶端逾時 8→5 秒、判斷逾時 12→4 秒，並加上本機先篩讓多數輪次完全不連網）。

隱私：新增 `redact()`，沿用 `src/routes/session.js` 既有的遮蔽規則，在任何文字離開機器之前先蓋掉密碼／權杖形狀的字串。

### 第二輪：Fable 5 —— 結論是「照這份計畫做會出一個全綠但完全無效的功能」

八項 Critical，逐條回原始碼查證，**全部屬實**。其中三項是致命的「兩端都造假」（IR-128）：測試把介面兩邊都換成假的，所以測試永遠綠，產線永遠死。

| # | 發現 | 查證 | 後果 |
|---|---|---|---|
| C4 | `defaultLlm` 誤解 `callLLMSwitch` 的回傳型別 | 屬實：`src/lib/llm-narrative.js:224` `return parseLLMJson(content)` —— 回傳的是**已解析的物件**，不是字串。原計畫 `result?.content ?? ''` 會得到 `''` | 每一次查核都判定 `failed`，永遠抓不到任何違規。路由測試注入的假 `llmFn` 回字串，所以全綠 |
| C5 | 硬擋讀的快取根本不存在 | 屬實且比審查說的更糟：`hooks/lib/conditional-sync.js:96` 是**拒收判斷**（資料裡有 `team_standard` 陣列就 return false，代表不是這個消費者的），我在 spec §4.1 把它讀成「同步型別已含 team_standard」，那是我的誤讀；而 `shared/init-cache.js:4-7` 明寫 compact init 回應**完全沒有 team_standards** | `readEnforcementCache()` 在任何真實機器上都回 `[]`，硬擋永遠不觸發。所有 guard 測試都注入 standards，所以全綠 |
| C6 | 伺服器撈規範用 `WHERE user_id = $1`，撈不到共享的團隊規範，也沒撈 fragment | 屬實：`src/routes/memory.js:866` 明寫「`buildReadableWhere` is what makes team_standard — shared across accounts — come back for a caller who does not own it」 | **事故當事的 412 是別人上傳的，這個查詢看不到它**；fragment 沒撈，判官拿到的是沒有禁止清單的摘要，正是事故的形狀 |
| C1 | Task 6 用不存在的 `LINT_DISABLED` | 已於本輪前修正 | — |
| C2 | Task 6 的整合測試**數學上不可能通過**：`indexOf('requestCheck')` 命中的是 import 那行，`BLOCK_THRESHOLD` 落在其後 3000 位元組內、`process.exit(2)` 落在之外 | 屬實 | 已於本輪前把該測試整組換成行為測試 |
| C3 | 認證標頭錯 | 已於本輪前修正 | — |
| C7 | 沒有 `enforcement` 欄位的規範完全不會被查；`selectRules` 從不讀 tags | 屬實 | Vin 的指示是「全部規範都做」，照原計畫上線第一天幾乎每輪都是 `skipped`，而 `skipped` 在指標上看起來很正常 |
| C8 | 用戶端在伺服器判斷帳號開關**之前**就把回覆全文送出去了 | 屬實 | 「開關 off ＝零成本零延遲」在用戶端是假的：所有人每輪都付一次來回並送出對話文字 |

另有 11 項 Important，其中影響最大的四項：`src/routes/memory.js:1412` 的變數叫 `oldMemory` 不是 `existing`（Task 10 貼上去會 500）；Task 6 用靜態 import 違反該 hook 自己的載入安全契約（`reply-lint.js:59-60`），壞一支 lib 會讓三個既有檢查一起死；Task 8 Step 8 跑的是 `~/.ownmind` 裡**已安裝的舊副本**、不是剛寫的程式；`check_id` 從沒出現在任何使用者看得到的地方，誤判率因此收集不到。

### 第三輪：agy ＋ Fable 5 同時審修正後的計畫（2026-08-13）

**結論仍是「不得開工」。** 兩邊獨立指向同一個根因，而且**其中三項是我上一輪的修正自己製造出來的**：

| # | 發現 | 查證 | 誰造成的 |
|---|---|---|---|
| 1 | bundle 送出去的是扁平結構，但三個用戶端函式全都在讀 `metadata.enforcement.*`（資料庫的形狀）。產線上一律讀到 undefined，三層全部靜靜失效 | 屬實 | **我上一輪的修正** |
| 2 | `readEnforcementCache()` 只回 `guards`，但三支 hook 都用它挑規範 → 沒有路徑禁區的規範（絕大多數，含所有溝通類）在第一步就被丟掉 | 屬實 | **我上一輪的修正** |
| 3 | 注入需要規範內文，但 bundle 為了省頻寬把內文砍了 → 注入只會送出標題和一句警告，內文是空字串 | 屬實 | **我上一輪的修正** |
| 4 | 同步寫在 `ownmind-session-start.js`，但 `session-hook-command.cjs:38` 寫明 mac／Linux 跑的是 `.sh`，`.js` 只有 Windows → **Vin 的 Mac 永遠不會有這份快取** | 屬實 | **我上一輪的修正，而且是我剛修好的同一個錯** |
| 5 | 新端點被 `src/routes/memory.js:1020` 的 `router.get('/:id')` 吃掉 → 每次同步都 500，快取永遠空的 | 屬實 | 新增 |
| 6 | Task 4／12 的假模型仍回字串，與「回傳已解析物件」的修正互相矛盾 → 測試會紅，執行者最省事的修法就是把修正改回去 | 屬實 | 新增 |
| 7 | Task 10 的貼上片段缺了 `const guardResult = checkEnforcementRemoval(` 那一行，是語法錯誤 | 屬實 | **我上一輪用 perl 批次改字時砍掉的** |
| 8 | metadata 守門只檢查 `enforcement` 是不是物件，傳一個空的 `{}` 就過關 | 屬實 | 新增 |

以上八項已全部修正：bundle 改成 `{selectors, guards, injectables}` 三份、扁平且明確；注入用 `injectables`（**帶內文**，只含被標註的規範，數量有界）；`readEnforcementBundle` 是唯一入口且回 `present` 旗標，快取沒同步過時不准當成「沒有規範」；同步改寫進 `conditional-sync-cli.js`；端點改註冊在 `memory.js` 的 `/:id` 之前；假模型改回物件；語法補回；metadata 守門改深度比對。

**這一輪最重要的發現不是那八條，是它們的分布：一半是修正自己造成的，而且其中一個是我剛修好的同一種錯誤。** 這正是要蓋的這套系統存在的理由 —— 靠人（或靠 AI 自己）逐輪檢查，同一類錯誤會一直長回來。

### 修正後的狀態（2026-08-13，實測而非推論）

三件必補的事已補完，且四項關鍵假設全部用**真的東西**跑過一次，不是讀程式碼推論：

| 驗的東西 | 怎麼驗的 | 結果 |
|---|---|---|
| `callLLMSwitch` 回傳型別 | stub HTTP server ＋ 真的 `callLLMSwitch` | 回**已解析物件**，`.verdicts` 直接可取，`.content` 是 undefined；散文會 throw。原寫法必得空字串 → 已改為直接取 `result.verdicts` |
| 共享團隊規範撈不撈得到 | 真 Postgres 容器 ＋ 本 repo 全部 migration ＋ 事故形狀 fixture（412 屬於 Eric、禁止清單在 fragment 413、查詢者是 Vin） | `WHERE user_id = $1` **只回 125，看不到 412**；換 `buildReadableWhere` 回 125 ＋ 412；fragment 413 撈得到。已改為 `buildReadableWhere` ＋ `attachStandardFragments` |
| 用戶端到底有沒有團隊規範 | 直接讀 Vin 本機 `~/.ownmind/cache/memories.json` | **完全沒有** —— 只有 digest 字串與 5 筆 `{id,title,hint}`。已新增 Task 0.5 建立配送路徑 |
| 硬擋走不走得通 | 真的 `ownmind-iron-rule-check.sh` ＋ 拋棄式 HOME ＋ 樁模組 | `{"decision":"block"}` 原封不動出現在 stdout，exit 0；完整 payload（含 `content`）確實灌進來；Edit／Write／MultiEdit／NotebookEdit 四種都會走到。**設計成立，原本只是寫在錯的檔案裡** |

配送設計改為：bundle 只送「選擇鍵 ＋ 禁區規則」，**不送規範內文**（實測每條 39～171 位元組，150 條約 20KB）；內文留伺服器，判官直接查資料庫，因此「全部規範都做」不受用戶端涵蓋率限制。

### 原始結論（供對照）：本計畫在補完下列三件事之前不得開工

1. **先做一個「介面兩端不准都造假」的前置任務**：每一個接縫至少一個整合測試用真的對手 —— 真的 `auth` 中介層、真的 `callLLMSwitch` 打一個 stub HTTP server、由**真的同步程式**寫出來的快取檔、以及指向暫存安裝目錄的 `.sh` 入口。
2. **先設計規範的配送路徑**：團隊規範 ＋ `enforcement` 欄位 ＋ fragment 要怎麼到用戶端（今天的 compact init 完全沒帶），並把伺服器查詢改用 `buildReadableWhere` ＋ 組裝 fragment。這件事不做，Task 7、8、9 全部是空的。
3. **Task 6 依該檔的真實契約重寫**：正確識別字、動態 import、通知放在真正的早退點、查核前先確認本帳號已啟用、`check_id` 要露出來、測試要真的 spawn 那支 hook。

第 2 點是**新的設計缺口，不是計畫的筆誤** —— spec 也要跟著補。
