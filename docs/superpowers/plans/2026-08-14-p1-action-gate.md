# P1 Action Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a risky command runs, the gate checks that the relevant rules were actually read and actually followed — blocking the command otherwise — with rules carried as data, a forgery-resistant read receipt, and a stop-and-ask path that never auto-executes.

**Architecture:** A pure decision library (`hooks/lib/action-gate.js`) evaluated from the already-registered PreToolUse hook — zero new hook registrations. Rules arrive as `guards` in the enforcement bundle the client already syncs; three of Vin's real rules are backfilled with gate metadata as pure data. Blocking uses the PreToolUse JSON contract (`decision:"block"` + reason for the model) plus `systemMessage` for the human. The ask-first path shows a one-shot approval code to the human ONLY (systemMessage), so the model cannot approve itself.

**Tech Stack:** Node ESM (hooks/lib style), node:test, node:crypto HMAC-SHA256. No new dependencies.

## Global Constraints

- All new code, comments, tests, and doc files in English (repo CLAUDE.md 軌道 B).
- User-facing strings in English for now; they join the Track A translation batch later (Vin, 2026-08-14).
- The gate NEVER auto-executes a non-compliant action: the retry limit resolves to stop-and-ask, not release (Vin's decision, 2026-08-14).
- Gate internal failure = fail-open + loud: the command runs, and a `systemMessage` says the gate did not run. Silent fail-open is forbidden (product principle: switched off must never look like passed).
- Reuse `detectCommandTrigger` from `shared/helpers.js` — it is the single classifier; do not write a second one.
- Wrong blocks are the expensive error: every matcher must pass the 30-command zero-false-block pack (Task 9) before merge.
- Evidence base: `docs/superpowers/specs/2026-08-14-action-gate-prototype/` (Task 0 archives it). Measured there: 0/36 wrong blocks, 1.5ms decision, 5/5 forgery attempts rejected.
- IR-008: README ×3 / FILELIST / CHANGELOG in the release commit. IR-003: every behavior lands red-test-first.
- Known residual risk to state in docs, not to hide: the HMAC key lives under the same UID as the assistant, so a deliberate key-read forgery is possible and auditable, not impossible. True privilege separation (root-owned key / daemon) is a later change. The approval code is NOT readable by the model at all (it exists only in `systemMessage` and as a sha256 hash on disk), so ask-first consent is real even in v1.

## File Structure

- `hooks/lib/action-gate.js` — pure decision core: guard matching, check evaluation, receipt gate, limit counter, ask-first. No I/O side effects beyond injected state dir.
- `hooks/lib/gate-receipt.js` — key/nonce/receipt primitives (HMAC), symlink-safe reads.
- `hooks/lib/approve-action.js` — CLI the model runs with the code the USER pasted; one-shot approval marker.
- `hooks/ownmind-iron-rule-check.js` — integration: call the gate after trigger detection; emit block JSON + systemMessage. (`.sh` twin shells out to a small runner, same as it already does for `ownmind-detect-trigger.js`.)
- `hooks/lib/action-gate-cli.js` — stdin→stdout runner so the `.sh` twin can call the same core.
- `hooks/ownmind-session-start.js` + `.sh` — provision key (once) and per-session nonce.
- `src/routes/enforcement-bundle.js` — ship `metadata.enforcement.gate` rules as `guards`.
- Tests: `tests/action-gate.test.js`, `tests/gate-receipt.test.js`, `tests/enforcement-bundle.test.js` (extend), `tests/action-gate-e2e.test.js`.

---

### Task 0: Archive the prototype evidence into the repo

**Files:**
- Create: `docs/superpowers/specs/2026-08-14-action-gate-prototype/` (copied from session scratchpad `gate/`)

**Interfaces:**
- Produces: reference implementation + `evidence.md` (transcripts, wrong-block table, forgery outcomes) later tasks and reviewers cite.

- [ ] **Step 1: Copy the prototype (code + evidence only — no user data is in these files)**

```bash
SRC="$CLAUDE_SCRATCHPAD/gate"   # the session scratchpad this prototype was built in
DST=docs/superpowers/specs/2026-08-14-action-gate-prototype
mkdir -p "$DST" && cp "$SRC"/gate.js "$SRC"/gatelib.js "$SRC"/fetch-rules.js "$SRC"/setup.js "$SRC"/rules.json "$SRC"/prove.js "$SRC"/evidence.md "$DST"/
```

- [ ] **Step 2: Sanity-check no personal content rode along**

Run: `grep -rn "taipeifunpass\|idaytour\|EasyCard" docs/superpowers/specs/2026-08-14-action-gate-prototype/ | wc -l`
Expected: `0`

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-14-action-gate-prototype
git commit -m "docs: archive the action-gate prototype and its evidence"
```

---

### Task 1: The bundle ships gate rules as data

**Files:**
- Modify: `src/routes/enforcement-bundle.js` (where `guards` is assembled)
- Test: `tests/enforcement-bundle.test.js` (extend)

**Interfaces:**
- Consumes: rule rows with `metadata.enforcement.gate`.
- Produces: bundle `guards` entries of shape `{ id, title, kind: 'action', triggers: string[], checks: [{type: 'must_match'|'must_not_match', pattern: string, reason: string}], read_required: boolean, ask_first: boolean, rule_text: string, rules_hash: string }`. `rules_hash` = sha256 hex of `rule_text`; the receipt binds to it so editing a rule invalidates old receipts.

- [ ] **Step 1: Write the failing test**

```js
test('a rule carrying gate metadata ships as an action guard', async () => {
  const rule = {
    id: 918, type: 'iron_rule', title: 'compose only, no cache',
    content: 'Deploys must use docker compose build --no-cache.',
    metadata: { enforcement: { gate: {
      triggers: ['deploy'],
      checks: [
        { type: 'must_not_match', pattern: '(^|\\s)docker\\s+build(\\s|$)', reason: 'use docker compose build, never bare docker build (IR-023)' },
        { type: 'must_match', pattern: '--no-cache', reason: 'docker builds must carry --no-cache (IR-018)' },
      ],
      read_required: true, ask_first: false,
    } } },
  };
  const { guards } = buildBundle([rule]);
  assert.equal(guards.length, 1);
  const g = guards[0];
  assert.equal(g.kind, 'action');
  assert.deepEqual(g.triggers, ['deploy']);
  assert.equal(g.checks.length, 2);
  assert.equal(g.read_required, true);
  assert.match(g.rule_text, /docker compose build/);
  assert.equal(g.rules_hash, createHash('sha256').update(g.rule_text).digest('hex'));
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/enforcement-bundle.test.js`
Expected: FAIL (no `kind:'action'` guard emitted today).

- [ ] **Step 3: Implement — in the guards assembly, alongside the existing path-guard emission**

```js
const gate = rule?.metadata?.enforcement?.gate;
if (gate && Array.isArray(gate.triggers) && gate.triggers.length) {
  const ruleText = buildJudgeTextLikeConcat(rule); // content + fragments, same as selectors
  guards.push({
    id: rule.id,
    title: rule.title || '',
    kind: 'action',
    triggers: gate.triggers.filter((t) => typeof t === 'string' && t),
    checks: (Array.isArray(gate.checks) ? gate.checks : [])
      .filter((c) => c && (c.type === 'must_match' || c.type === 'must_not_match')
        && typeof c.pattern === 'string' && c.pattern)
      .map((c) => ({ type: c.type, pattern: c.pattern, reason: String(c.reason || rule.title || '') })),
    read_required: gate.read_required !== false,
    ask_first: gate.ask_first === true,
    rule_text: ruleText,
    rules_hash: createHash('sha256').update(ruleText).digest('hex'),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes** — `node --test tests/enforcement-bundle.test.js` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(gate): the bundle ships action-gate rules as data"`

---

### Task 2: Guard matching against a real command line

**Files:**
- Create: `hooks/lib/action-gate.js` (start with matching)
- Test: `tests/action-gate.test.js`

**Interfaces:**
- Consumes: `detectCommandTrigger(command)` from `shared/helpers.js` (returns e.g. `'deploy' | 'commit' | 'delete' | null`).
- Produces: `matchGuards(command, guards) -> guard[]` — every action guard whose `triggers` include the detected trigger, PLUS tag-push special-casing: commands matching `/git\s+push\b.*\s(v\d|ima-v|ima-rc)/` count as trigger `deploy` even when the classifier says otherwise (the prototype's measured miss: Vin's real deploys are tag pushes).

- [ ] **Step 1: Failing tests**

```js
import { matchGuards } from '../hooks/lib/action-gate.js';
const DEPLOY_GUARD = { id: 918, kind: 'action', triggers: ['deploy'], checks: [], read_required: true, ask_first: false, rule_text: 'x', rules_hash: 'h' };

test('a compose build command matches a deploy guard', () => {
  assert.equal(matchGuards('docker compose build --no-cache api', [DEPLOY_GUARD]).length, 1);
});
test('a version-tag push is a deploy even though the classifier calls it git', () => {
  assert.equal(matchGuards('git push origin ima-v1.2.9', [DEPLOY_GUARD]).length, 1);
  assert.equal(matchGuards('git push origin v0.35.13', [DEPLOY_GUARD]).length, 1);
});
test('everyday commands match nothing', () => {
  for (const cmd of ['ls -la', 'git status', 'git push origin main', 'git grep "docker build"', 'npm test']) {
    assert.equal(matchGuards(cmd, [DEPLOY_GUARD]).length, 0, cmd);
  }
});
```

- [ ] **Step 2: Run to fail** — `node --test tests/action-gate.test.js` → FAIL (module missing)
- [ ] **Step 3: Implement**

```js
import { detectCommandTrigger } from '../shared/helpers.js';

const TAG_PUSH = /git\s+push\b.*\s(?:refs\/tags\/)?(?:v\d|ima-v|ima-rc)/;

export function matchGuards(command, guards) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const triggers = new Set();
  const detected = detectCommandTrigger(command);
  if (detected) triggers.add(detected);
  if (TAG_PUSH.test(command)) triggers.add('deploy');
  if (!triggers.size) return [];
  return (guards || []).filter((g) => g && g.kind === 'action'
    && Array.isArray(g.triggers) && g.triggers.some((t) => triggers.has(t)));
}
```

- [ ] **Step 4: Run to pass**, **Step 5: Commit** — `git commit -m "feat(gate): guard matching incl. tag-push deploys"`

---

### Task 3: Receipt primitives (key, nonce, HMAC)

**Files:**
- Create: `hooks/lib/gate-receipt.js`
- Test: `tests/gate-receipt.test.js`

**Interfaces:**
- Produces:
  - `ensureKey(stateDir) -> void` (32 random bytes hex at `<stateDir>/gate.key`, mode 0o400, create-once)
  - `ensureNonce(stateDir, sessionId) -> string` (per-session random hex at `<stateDir>/gate-nonce-<sessionId>`, create-once per session)
  - `writeReceipt(stateDir, sessionId, guard) -> void`
  - `verifyReceipt(stateDir, sessionId, guard) -> boolean` — false when missing, tampered, from another session, for a different `rules_hash`, or when the receipt path is a symlink (lstat).

- [ ] **Step 1: Failing tests**

```js
test('a receipt written by the gate verifies, and binds to the rule content', () => {
  const dir = tempDir('gate-r-'); ensureKey(dir); ensureNonce(dir, 's1');
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };
  writeReceipt(dir, 's1', guard);
  assert.equal(verifyReceipt(dir, 's1', guard), true);
  assert.equal(verifyReceipt(dir, 's1', { ...guard, rules_hash: 'bbb' }), false, 'edited rule invalidates the receipt');
  assert.equal(verifyReceipt(dir, 's2', guard), false, 'another session cannot replay it');
});
test('a hand-written receipt is rejected', () => {
  const dir = tempDir('gate-f-'); ensureKey(dir); ensureNonce(dir, 's1');
  const guard = { id: 918, rule_text: 'text', rules_hash: 'aaa' };
  fs.writeFileSync(path.join(dir, 'gate-receipt-s1-918.json'),
    JSON.stringify({ ruleId: 918, rulesHash: 'aaa', hmac: 'deadbeef' }));
  assert.equal(verifyReceipt(dir, 's1', guard), false);
});
```

- [ ] **Step 2: Run to fail** → FAIL
- [ ] **Step 3: Implement**

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

const keyPath = (d) => path.join(d, 'gate.key');
const noncePath = (d, sid) => path.join(d, `gate-nonce-${sid}`);
const receiptPath = (d, sid, id) => path.join(d, `gate-receipt-${sid}-${id}.json`);

export function ensureKey(stateDir) {
  const p = keyPath(stateDir);
  if (fs.existsSync(p)) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(p, randomBytes(32).toString('hex'), { mode: 0o400 });
}

export function ensureNonce(stateDir, sessionId) {
  const p = noncePath(stateDir, sessionId);
  try { return fs.readFileSync(p, 'utf8'); } catch { /* create below */ }
  const nonce = randomBytes(16).toString('hex');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(p, nonce);
  return nonce;
}

function sign(stateDir, sessionId, guard) {
  const key = fs.readFileSync(keyPath(stateDir), 'utf8');
  const nonce = fs.readFileSync(noncePath(stateDir, sessionId), 'utf8');
  return createHmac('sha256', key)
    .update(`${sessionId}:${guard.id}:${guard.rules_hash}:${nonce}`)
    .digest('hex');
}

export function writeReceipt(stateDir, sessionId, guard) {
  fs.writeFileSync(receiptPath(stateDir, sessionId, guard.id), JSON.stringify({
    ruleId: guard.id, rulesHash: guard.rules_hash, hmac: sign(stateDir, sessionId, guard),
  }));
}

export function verifyReceipt(stateDir, sessionId, guard) {
  const p = receiptPath(stateDir, sessionId, guard.id);
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return false;
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (rec.rulesHash !== guard.rules_hash) return false;
    return rec.hmac === sign(stateDir, sessionId, guard);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run to pass**, **Step 5: Commit** — `git commit -m "feat(gate): HMAC read receipts bound to session and rule content"`

---

### Task 4: The decision core — read gate, compliance gate, limit, ask-first

**Files:**
- Modify: `hooks/lib/action-gate.js`
- Test: `tests/action-gate.test.js` (extend)

**Interfaces:**
- Consumes: Task 2 `matchGuards`, Task 3 receipt primitives.
- Produces: `evaluateGate({ command, guards, stateDir, sessionId }) -> { action: 'allow' } | { action: 'block', kind: 'read'|'check'|'ask'|'limit', reason: string, userLine: string, guardId: number }`. Also appends every decision to `<stateDir>/gate-log.jsonl`.
- Decision order per matched guard: (1) `read_required` and no valid receipt → block kind `read`, embed the FULL `rule_text` in `reason`, and write the receipt (delivery IS the read — the retry then passes gate 1); (2) run `checks` against the command → first failure blocks with kind `check` and that check's `reason`; (3) `ask_first` and no unused approval marker → block kind `ask`, generate a 6-digit code, store `sha256(code)` at `<stateDir>/gate-ask-<sessionId>-<guardId>.json`, put the PLAINTEXT code ONLY in `userLine`; (4) 3 consecutive blocks of the same guard+kind → kind `limit`, which behaves like `ask` (stop and ask the human) — never allow.

- [ ] **Step 1: Failing tests**

```js
function mkGuard(over = {}) {
  return { id: 918, kind: 'action', title: 'compose no-cache', triggers: ['deploy'],
    checks: [
      { type: 'must_not_match', pattern: '(^|\\s)docker\\s+build(\\s|$)', reason: 'use docker compose build (IR-023)' },
      { type: 'must_match', pattern: '--no-cache', reason: 'add --no-cache (IR-018)' },
    ],
    read_required: true, ask_first: false,
    rule_text: 'Deploys use docker compose build --no-cache.',
    rules_hash: createHash('sha256').update('Deploys use docker compose build --no-cache.').digest('hex'),
    ...over };
}

test('unread rule blocks with the rule text, and the retry passes gate 1', () => {
  const dir = prepStateDir(); const g = mkGuard();
  const first = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(first.action, 'block'); assert.equal(first.kind, 'read');
  assert.match(first.reason, /docker compose build --no-cache/);
  const second = evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(second.action, 'allow');
});

test('a read but non-compliant command blocks with the specific reason', () => {
  const dir = prepStateDir(); const g = mkGuard();
  evaluateGate({ command: 'docker compose build --no-cache api', guards: [g], stateDir: dir, sessionId: 's1' });
  const r = evaluateGate({ command: 'docker compose build api', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(r.action, 'block'); assert.equal(r.kind, 'check');
  assert.match(r.reason, /--no-cache/);
});

test('the third consecutive block becomes stop-and-ask, never an allow', () => {
  const dir = prepStateDir(); const g = mkGuard();
  evaluateGate({ command: 'docker compose build --no-cache x', guards: [g], stateDir: dir, sessionId: 's1' }); // read
  for (let i = 0; i < 2; i += 1) {
    assert.equal(evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' }).kind, 'check');
  }
  const third = evaluateGate({ command: 'docker build .', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(third.kind, 'limit');
  assert.match(third.userLine, /\d{6}/, 'the user line carries the approval code');
  assert.ok(!third.reason.match(/\d{6}/), 'the model-facing reason must NOT contain the code');
});

test('ask_first blocks until the code is approved, then allows exactly once', () => {
  const dir = prepStateDir(); const g = mkGuard({ ask_first: true, checks: [], read_required: false });
  const ask = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(ask.kind, 'ask');
  const code = ask.userLine.match(/(\d{6})/)[1];
  assert.equal(approveAction(dir, 's1', g.id, code), true);
  assert.equal(evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' }).action, 'allow');
  const again = evaluateGate({ command: 'git push origin ima-v9.9.9', guards: [g], stateDir: dir, sessionId: 's1' });
  assert.equal(again.kind, 'ask', 'approval is one-shot');
});
```

- [ ] **Step 2: Run to fail** → FAIL
- [ ] **Step 3: Implement** (in `hooks/lib/action-gate.js`; `approveAction` lives here too and Task 5 wraps it as a CLI)

```js
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeReceipt, verifyReceipt } from './gate-receipt.js';

const askPath = (d, sid, gid) => path.join(d, `gate-ask-${sid}-${gid}.json`);
const limitPath = (d, sid, gid) => path.join(d, `gate-limit-${sid}-${gid}.json`);
const logPath = (d) => path.join(d, 'gate-log.jsonl');

function log(stateDir, entry) {
  try { fs.appendFileSync(logPath(stateDir), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); }
  catch { /* the log must never take the gate down */ }
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function bumpLimit(stateDir, sid, gid, kind) {
  const p = limitPath(stateDir, sid, gid);
  const prev = readJson(p) || { kind: null, count: 0 };
  const count = prev.kind === kind ? prev.count + 1 : 1;
  try { fs.writeFileSync(p, JSON.stringify({ kind, count })); } catch { /* over-asks, never under */ }
  return count;
}
function clearLimit(stateDir, sid, gid) { try { fs.unlinkSync(limitPath(stateDir, sid, gid)); } catch { /* absent is fine */ } }

function issueAsk(stateDir, sid, guard, kindLabel) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    fs.writeFileSync(askPath(stateDir, sid, guard.id),
      JSON.stringify({ codeHash: createHash('sha256').update(code).digest('hex'), approved: false }));
  } catch { /* without the file the approve step fails closed */ }
  return {
    action: 'block', kind: kindLabel, guardId: guard.id,
    reason: `[OwnMind gate] "${guard.title}" needs the user's explicit go for this action. `
      + 'Ask the user for the 6-digit approval code shown on their screen, then run: '
      + `node ~/.ownmind/hooks/lib/approve-action.js ${guard.id} <code> — and retry the command.`,
    userLine: `[OwnMind] ⛔ "${guard.title}" wants your approval for: ${kindLabel === 'limit' ? 'a command blocked 3 times in a row' : 'this action'}. Approval code: ${code} (paste it to the AI to allow it once)`,
  };
}

export function approveAction(stateDir, sessionId, guardId, code) {
  const p = askPath(stateDir, sessionId, guardId);
  const rec = readJson(p);
  if (!rec || rec.approved) return false;
  if (createHash('sha256').update(String(code)).digest('hex') !== rec.codeHash) return false;
  try { fs.writeFileSync(p, JSON.stringify({ ...rec, approved: true })); } catch { return false; }
  return true;
}

function consumeApproval(stateDir, sessionId, guardId) {
  const p = askPath(stateDir, sessionId, guardId);
  const rec = readJson(p);
  if (!rec || rec.approved !== true) return false;
  try { fs.unlinkSync(p); } catch { /* worst case: one extra allowed retry this session */ }
  return true;
}

export function evaluateGate({ command, guards, stateDir, sessionId }) {
  const matched = matchGuards(command, guards);
  for (const guard of matched) {
    const decide = (d) => { log(stateDir, { sessionId, guardId: guard.id, command, ...d }); return d; };

    if (guard.read_required && !verifyReceipt(stateDir, sessionId, guard)) {
      writeReceipt(stateDir, sessionId, guard); // delivering the text below IS the read
      const count = bumpLimit(stateDir, sessionId, guard.id, 'read');
      if (count >= 3) return decide(issueAsk(stateDir, sessionId, guard, 'limit'));
      return decide({
        action: 'block', kind: 'read', guardId: guard.id,
        reason: `[OwnMind gate] Read this rule before acting, then retry the command:\n--- RULE ${guard.id}: ${guard.title} ---\n${guard.rule_text}`,
        userLine: `[OwnMind] ⛔ blocked until the rule "${guard.title}" is read (auto-unblocks on retry)`,
      });
    }

    for (const c of guard.checks || []) {
      let re; try { re = new RegExp(c.pattern); } catch { continue; } // a broken pattern must not brick the shell
      const hit = re.test(command);
      if ((c.type === 'must_match' && !hit) || (c.type === 'must_not_match' && hit)) {
        const count = bumpLimit(stateDir, sessionId, guard.id, 'check');
        if (count >= 3) return decide(issueAsk(stateDir, sessionId, guard, 'limit'));
        return decide({
          action: 'block', kind: 'check', guardId: guard.id,
          reason: `[OwnMind gate] The command violates "${guard.title}": ${c.reason}. Fix the command and retry.`,
          userLine: `[OwnMind] ⛔ blocked: ${c.reason}`,
        });
      }
    }

    if (guard.ask_first && !consumeApproval(stateDir, sessionId, guard.id)) {
      return decide(issueAsk(stateDir, sessionId, guard, 'ask'));
    }

    clearLimit(stateDir, sessionId, guard.id);
    log(stateDir, { sessionId, guardId: guard.id, command, action: 'allow' });
  }
  return { action: 'allow' };
}
```

- [ ] **Step 4: Run to pass**, **Step 5: Commit** — `git commit -m "feat(gate): read gate, compliance gate, stop-and-ask limit"`

---

### Task 5: The approval CLI

**Files:**
- Create: `hooks/lib/approve-action.js`
- Test: `tests/action-gate.test.js` (extend)

**Interfaces:**
- Consumes: `approveAction` from Task 4; session id from `~/.ownmind/state/gate-current-session` (written by the SessionStart provisioning in Task 7).
- Produces: CLI `node approve-action.js <guardId> <code>` → prints `APPROVED` (exit 0) or `REJECTED` (exit 1).

- [ ] **Step 1: Failing test** (spawn the CLI against a staged state dir with a known code hash; assert `APPROVED` then `REJECTED` on reuse)

```js
test('the approval CLI approves a valid code once', () => {
  const dir = prepStateDir();
  fs.writeFileSync(path.join(dir, 'gate-current-session'), 's1');
  fs.writeFileSync(path.join(dir, 'gate-ask-s1-918.json'),
    JSON.stringify({ codeHash: createHash('sha256').update('123456').digest('hex'), approved: false }));
  const env = { ...process.env, OWNMIND_GATE_STATE_DIR: dir };
  const ok = spawnSync('node', ['hooks/lib/approve-action.js', '918', '123456'], { encoding: 'utf8', env });
  assert.equal(ok.status, 0); assert.match(ok.stdout, /APPROVED/);
  const again = spawnSync('node', ['hooks/lib/approve-action.js', '918', '123456'], { encoding: 'utf8', env });
  assert.equal(again.status, 1);
});
```

- [ ] **Step 2: Run to fail** → FAIL
- [ ] **Step 3: Implement**

```js
#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approveAction } from './action-gate.js';

const stateDir = process.env.OWNMIND_GATE_STATE_DIR
  || path.join(os.homedir(), '.ownmind', 'state');
const [, , guardId, code] = process.argv;
let sessionId = '';
try { sessionId = fs.readFileSync(path.join(stateDir, 'gate-current-session'), 'utf8').trim(); } catch { /* falls through to REJECTED */ }
if (sessionId && guardId && code && approveAction(stateDir, sessionId, Number(guardId), code)) {
  process.stdout.write('APPROVED\n');
  process.exit(0);
}
process.stdout.write('REJECTED\n');
process.exit(1);
```

- [ ] **Step 4: Run to pass**, **Step 5: Commit** — `git commit -m "feat(gate): one-shot approval CLI keyed to a code only the user sees"`

---

### Task 6: Wire the gate into the registered PreToolUse hook

**Files:**
- Modify: `hooks/ownmind-iron-rule-check.js` (after trigger detection, before the reminder output)
- Create: `hooks/lib/action-gate-cli.js` (stdin payload → stdout JSON, so the `.sh` twin can call the same core)
- Modify: `hooks/ownmind-iron-rule-check.sh` (call the CLI the same way it already calls `ownmind-detect-trigger.js`; pass its output through when it decides)
- Test: `tests/action-gate-e2e.test.js`

**Interfaces:**
- Consumes: `evaluateGate` (Task 4), `readEnforcementBundle()` from `hooks/lib/enforcement-cache.js` (guards field), payload `tool_input.command` + `session_id` from PreToolUse stdin.
- Produces, on block (stdout JSON, exit 0 — the same contract the hook already uses for `decision:'block'`):

```json
{"decision":"block","reason":"<model-facing reason>","systemMessage":"<user-facing line>","hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":""}}
```

- Fail-open-loud: any thrown error inside the gate path → allow the command AND emit `{"systemMessage":"[OwnMind] the action gate could not run - this command was NOT gated"}`.

- [ ] **Step 1: Failing e2e test** (spawn `hooks/lib/action-gate-cli.js` with a staged HOME carrying an `enforcement.json` whose guards include the Task 1 shape; assert block JSON on first deploy attempt, allow after retry, and assert the 30-command pack below produces zero blocks)

```js
const EVERYDAY = ['ls -la', 'git status', 'git diff', 'git push origin feature-x', 'npm test',
  'node script.js', 'grep -rn docker src/', 'echo "docker build ."', 'docker compose ps',
  'git grep "docker build"', 'cat README.md', 'rg pattern', 'pwd', 'whoami', 'df -h',
  'git log --oneline', 'npm run lint', 'node --test tests/x.test.js', 'git fetch --tags',
  'curl -s https://example.com', 'tail -f log.txt', 'mkdir -p tmp', 'cp a b', 'mv a b',
  'git checkout -b feat/x', 'git add -A', 'sed -n 1,10p file', 'wc -l file', 'ls docs', 'git stash list'];

test('the everyday pack crosses the gate untouched', () => {
  const { home } = stageGateHome();
  for (const command of EVERYDAY) {
    const r = runGateCli({ home, command });
    assert.equal(r.stdout.trim(), '', `wrongly gated: ${command}`);
  }
});
```

- [ ] **Step 2: Run to fail** → FAIL (CLI missing)
- [ ] **Step 3: Implement the CLI**

```js
#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no payload, no gate */ }
  const command = payload?.tool_input?.command;
  const sessionId = (typeof payload.session_id === 'string' && payload.session_id) || 'unknown';
  if (typeof command !== 'string' || !command.trim()) { process.exit(0); }
  try {
    const { evaluateGate } = await import('./action-gate.js');
    const { readEnforcementBundle } = await import('./enforcement-cache.js');
    const bundle = readEnforcementBundle();
    const stateDir = path.join(os.homedir(), '.ownmind', 'state');
    const d = evaluateGate({ command, guards: bundle?.guards || [], stateDir, sessionId });
    if (d.action === 'block') {
      process.stdout.write(JSON.stringify({
        decision: 'block', reason: d.reason, systemMessage: d.userLine,
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '' },
      }));
    }
  } catch {
    process.stdout.write(JSON.stringify({
      systemMessage: '[OwnMind] the action gate could not run - this command was NOT gated',
    }));
  }
  process.exit(0);
}
main();
```

- [ ] **Step 4: Wire `.sh`** — next to the existing `ownmind-detect-trigger.js` call: run the CLI with the hook's stdin payload; if it prints anything, echo that JSON and `exit 0` (the block short-circuits the reminder output, which a blocked command does not need).
- [ ] **Step 5: Wire `.js`** — import `evaluateGate` + `readEnforcementBundle` directly after its own trigger detection; same output shape; wrap in the same fail-open-loud try/catch.
- [ ] **Step 6: Run e2e to pass** — `node --test tests/action-gate-e2e.test.js` → PASS
- [ ] **Step 7: Commit** — `git commit -m "feat(gate): wired into the registered PreToolUse hook, fail-open-loud"`

---

### Task 7: Key and session provisioning

**Files:**
- Modify: `hooks/ownmind-session-start.js` and `.sh`
- Test: extend `tests/gate-receipt.test.js`

**Interfaces:**
- Produces: at every session start — `ensureKey(stateDir)`; `ensureNonce(stateDir, sessionId)`; write `<stateDir>/gate-current-session` = sessionId (the approval CLI reads it); sweep `gate-*-<sid>-*` state older than 30 days.

- [ ] **Step 1: Failing test** — spawn the session-start hook with a staged HOME; assert `gate.key` exists with mode 0400, `gate-nonce-<sid>` exists, `gate-current-session` holds the sid.
- [ ] **Step 2: Run to fail** → FAIL
- [ ] **Step 3: Implement** — call the Task 3 primitives from both session-start variants (the `.js` inline; the `.sh` via `node -e "import('./lib/gate-receipt.js').then(...)"` in the same pattern it uses for other lib calls).
- [ ] **Step 4: Run to pass**, **Step 5: Commit** — `git commit -m "feat(gate): session provisioning for key, nonce and current-session"`

---

### Task 8: Backfill the first three real rules (pure data, no code)

**Files:** none (MCP `ownmind_update` calls against the live account, then one `conditional-sync-cli.js` run to refresh the cache)

**Interfaces:**
- Produces: `metadata.enforcement.gate` on three of Vin's rules:

1. **IR-023 + IR-018 (deploy build discipline)** on rule id 121 (IR-023):

```json
{ "triggers": ["deploy"], "read_required": true, "ask_first": false,
  "checks": [
    { "type": "must_not_match", "pattern": "(^|\\s)docker\\s+build(\\s|$)", "reason": "use docker compose build, never bare docker build (IR-023)" },
    { "type": "must_match", "pattern": "--no-cache", "reason": "docker builds must carry --no-cache (IR-018)" } ] }
```

   Scope note: the checks fire only when the guard matches (trigger `deploy`), so `docker compose ps` and quoted mentions stay untouched — proven by the Task 6 everyday pack.

2. **IR-136 (deploys ask first)** on rule id 819 (IR-136): `{ "triggers": ["deploy"], "read_required": true, "ask_first": true, "checks": [] }` — every deploy-classified command (including tag pushes) stops for the approval code.

3. **Generalization witness — one rule unlike the others** (the plan's own proof that rules are data): IR-002 (never commit .env) on its rule id: `{ "triggers": ["commit"], "read_required": false, "ask_first": false, "checks": [{ "type": "must_not_match", "pattern": "git\\s+add\\s+(-A|--all|\\.env)", "reason": "stage files explicitly - a blanket add sweeps .env and secrets (IR-002)" }] }` — NOTE to implementer: confirm the exact wording with Vin before backfilling this one; blanket `git add -A` is common in his flow, so this check may be too aggressive. If he declines, backfill only rules 1–2; the generalization proof then uses a test fixture instead.

- [ ] **Step 1: Apply via `ownmind_update`** (read each rule in full first; metadata merge, content untouched; update_reason: "P1 gate backfill")
- [ ] **Step 2: Refresh the local cache** — `node hooks/lib/conditional-sync-cli.js` and confirm `~/.ownmind/cache/enforcement.json` now carries `kind:"action"` guards.
- [ ] **Step 3: Live fire drill (with Vin watching):** ask the AI in a scratch session to run a deploy-shaped command without reading rules → observe block → read → retry → compliant pass; then a `docker build .` → check block; then a tag push → approval code flow end to end.

---

### Task 9: Red-team and regression evidence

**Files:**
- Test: `tests/action-gate.test.js` (extend)

- [ ] **Step 1: Port the prototype's five forgery cases as tests** — hand-written receipt (Task 3 has it), replayed receipt from another session, rule-content tamper, symlinked receipt, guessed-key HMAC — each must verify false.
- [ ] **Step 2: Add the two consent attacks** — the model-facing `reason` never contains the 6-digit code (Task 4 has it); `approveAction` with 6 wrong codes never approves (no retry-until-hit: after 5 failed attempts on one ask file, mark it burned and require a fresh ask).

```js
test('code guessing burns the ask instead of yielding', () => {
  const dir = prepStateDir();
  fs.writeFileSync(path.join(dir, 'gate-ask-s1-918.json'),
    JSON.stringify({ codeHash: createHash('sha256').update('123456').digest('hex'), approved: false, misses: 0 }));
  for (let i = 0; i < 5; i += 1) assert.equal(approveAction(dir, 's1', 918, '000000'), false);
  assert.equal(approveAction(dir, 's1', 918, '123456'), false, 'a burned ask never approves');
});
```

  (Implementation: `approveAction` increments `misses` on mismatch and refuses everything once `misses >= 5`.)
- [ ] **Step 3: Run the full suite** — `npm test` → 0 fail
- [ ] **Step 4: Commit** — `git commit -m "test(gate): forgery and consent red-team cases"`

---

### Task 10: Docs, version, QA, release

- [ ] **Step 1:** CHANGELOG entry (what the gate does, in the repo's incident-story voice), FILELIST additions, README ×3 version line, `npm version 1.26.<next> --no-git-tag-version`.
- [ ] **Step 2:** `superpowers:verification-before-completion` — full suite fresh run, red-green spot check on Task 4 (`git stash` the core, watch the suite go red, restore).
- [ ] **Step 3:** `superpowers:requesting-code-review` → fix → `superpowers:receiving-code-review`.
- [ ] **Step 4:** Commit on a feature branch, PR. **No tag, no deploy, no client rollout without Vin's word (IR-136).**

---

## Amendment 1 (2026-08-14, during execution)

`detectCommandTrigger` classifies every `git push` as `deploy` (built for reminders,
where over-trigger is cheap). To keep zero false blocks WITHOUT a second classifier:
guards may carry an optional `applies_pattern` (regex, rule data). Routing stays with
the shared classifier; when `applies_pattern` is present the guard fires only if the
command matches it; absent or invalid pattern = guard fires. Bundle passes it through;
`matchGuards` enforces it; Task 8 data for IR-136 carries
`"applies_pattern": "git\\s+push\\b.*\\s(refs/tags/)?(v\\d|ima-v|ima-rc)|docker\\s+compose|deploy"`.

## Amendment 2 (2026-08-14, from Task 4 adversarial review — plan pseudo-code defects)

1. The decision log NEVER records `userLine` or the approval code (log kind/guardId/
   `code_issued: true` only). The code exists in systemMessage and as a sha256 hash — nowhere else.
2. Receipt-subsystem failure (missing key/nonce, unwritable state) degrades the READ gate
   open-and-loud for that turn (`degraded` flag → "NOT gated" systemMessage); regex checks
   still enforce (stateless); ask-first fails CLOSED (a deploy waits for provisioning).
3. A limit-issued approval is redeemable: on the next evaluation, a valid consumed approval
   bypasses that guard's failing state once and clears its counter — "allow it once" must be true.
4. Approvals are consumed ONLY when the whole command ends in allow: evaluate every matched
   guard's verdict first; if any other guard blocks, no approval is spent.
5. matchGuards' DOCKER_BUILD addition is ratified (the shared classifier misses bare
   `docker build`); it needs dedicated tests, and prefix/newline bypass forms go to Task 9.
6. approveAction sanitizes sessionId AND guardId exactly as evaluateGate does.

## Amendment 3 (2026-08-14, Vin's call — verbal approval mode)

Vin chose verbal "go" over pasting a 6-digit code for ask_first guards. Honest
consequence, stated to him and accepted: this is a STOP-and-confirm gate, not an
unforgeable-consent gate — the AI relays the block, Vin says go, the AI records and proceeds,
so the AI *could* in principle self-attest the go. Vin accepted the reduced guarantee for the
lower friction; his IR-136 remains the enforced STOP, only the consent proof is downgraded.

Implementation (small code addition before Task 8 backfill): gate config gains
`ask_mode: 'verbal' | 'code'` (default 'code'). A `verbal` ask still BLOCKS and surfaces the
rule + a "reply go to approve, or no to cancel" userLine; approve-action.js gains a
`--verbal <guardId>` path that marks the ask approved WITHOUT a code (the honesty boundary is
explicit in the log: `approval_mode: 'verbal'`). Every other property (one-shot, consume-only-
on-allow, checks still run for non-limit approvals, limit path unchanged) is identical to code
mode. IR-136 backfills with `ask_first: true, ask_mode: 'verbal'`.

## Out of scope for this plan (each gets its own plan when this lands)

- **Save-time rule classification + the 151-rule backfill** (the "rules translate themselves into specs" flow, and honestly telling the user which tier each rule landed in). This plan proves the data path with three hand-backfilled rules first.
- **Wrap-up rules at the Stop hook point** (the 收工 checklist — wrong hook event for this gate).
- **P2 speech track** (background subscription-sibling judge, notice-first graduation ladder).
- **Track A translation** of all gate-facing strings — batched after P1 per Vin's 2026-08-14 call.
- **Windows behavior** of the `.sh`/`.ps1` twins — the capability matrix stays honest: macOS is verified by this plan's tests; Windows verification is its own pass.

## Self-review notes

- Spec coverage: every P1 item from the approved change list maps to a task (gate body → 2/4/6, key layer → 3/7, rules-as-data → 1/8, stop-and-ask → 4/5, records → 4's gate-log; save-time classification and 收工 explicitly deferred with their own plans).
- The prototype's `deploy-approved` marker became the approval-code flow because the marker was forgeable by the party it gates; the code lives only in `systemMessage`, which the model never receives.
- Type consistency: `guards[].kind === 'action'` distinguishes gate guards from the existing path-guards, so `path-guard.js` consumers are untouched; `evaluateGate` and `approveAction` signatures match across Tasks 4/5/9.
