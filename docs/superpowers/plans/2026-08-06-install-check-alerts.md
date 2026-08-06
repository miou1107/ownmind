# Install-check alerts (v1.26.87) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a self-check fails on any machine, the super admin is told once, at the start of his next conversation, with enough detail to act on — instead of the failure sitting unread in `install_check_logs`.

**Architecture:** Two pure modules (evaluate, render) with no I/O, one job module that does all the SQL and creates the broadcast, and two call sites: after a report is stored, and once at server startup. State lives in a new `install_check_alert_state` table keyed by `(user_id, machine, check_name)`, which is what makes "announce once" possible.

**Tech Stack:** Node 22 ESM, Express 5, PostgreSQL (`pg`), `node:test` + `node:assert/strict`. No new dependencies.

**Spec:** `openspec/changes/v1.26.87-install-check-alerts/spec.md`

## Global Constraints

- New comments, log messages, identifiers and JSDoc in **English** (`CLAUDE.md`, track B). Broadcast text shown to the reader stays **Chinese**, matching `src/jobs/nightly-upgrade-reminder.js`.
- No new npm dependencies.
- Broadcast body hard limit: **2000 characters** (`validateBroadcastPayload`, `src/routes/broadcast.js`).
- Broadcast title hard limit: **200 characters**.
- The broadcast must be `severity='warning'` — `hooks/lib/render-session-context.js` only injects its action-required block for `warning`/`error` or `type='upgrade_reminder'`. An `info` broadcast renders passively and gets skimmed past.
- Target user: the **oldest** `super_admin` by `id`. On production that is id 1 (Vincent Kao); id 4 (Eric) is also `super_admin`, so "any super_admin" would be wrong.
- Run the full suite with `npm test`. A single file: `node --test tests/<file>.test.js`.
- Never write a literal control byte into a source file (that is Task 6's whole subject).

---

### Task 1: State table

**Files:**
- Create: `db/021_install_check_alert_state.sql`
- Test: `tests/install-check-alert-migration.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: table `install_check_alert_state (id, user_id, machine, check_name, detail, first_seen_at, announced_at, resolved_at)` with `UNIQUE (user_id, machine, check_name)`.

Migrations are applied automatically at boot by `runMigrations()` in `src/index.js`, so there is no manual apply step — but the file must be numbered `021` to run after `020_activity_source_width.sql`.

- [ ] **Step 1: Write the failing test**

```js
// tests/install-check-alert-migration.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('021_install_check_alert_state migration', () => {
  const sql = readFileSync(new URL('../db/021_install_check_alert_state.sql', import.meta.url), 'utf8');

  it('creates the table idempotently', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS install_check_alert_state/);
  });

  it('keys a failure by user, machine and check name', () => {
    assert.match(sql, /UNIQUE\s*\(\s*user_id\s*,\s*machine\s*,\s*check_name\s*\)/);
  });

  it('cascades when a user is deleted, like install_check_logs does', () => {
    assert.match(sql, /REFERENCES\s+users\s*\(\s*id\s*\)\s+ON DELETE CASCADE/);
  });

  it('carries the three timestamps the evaluator reads', () => {
    for (const col of ['first_seen_at', 'announced_at', 'resolved_at']) {
      assert.match(sql, new RegExp(`\\b${col}\\b`), `${col} missing`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/install-check-alert-migration.test.js`
Expected: FAIL with `ENOENT` — `db/021_install_check_alert_state.sql` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- db/021_install_check_alert_state.sql
-- v1.26.87: which install-check failures have already been announced.
--
-- A failure is identified by (user_id, machine, check_name) — not by report.
-- One upgrade uploads several reports (install_started / post_install /
-- upgrade_complete), so keying on the report would announce one problem three
-- times.

CREATE TABLE IF NOT EXISTS install_check_alert_state (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine       TEXT        NOT NULL,
  check_name    TEXT        NOT NULL,
  detail        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  announced_at  TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  UNIQUE (user_id, machine, check_name)
);

CREATE INDEX IF NOT EXISTS idx_install_check_alert_state_open
  ON install_check_alert_state (user_id, machine)
  WHERE resolved_at IS NULL;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/install-check-alert-migration.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add db/021_install_check_alert_state.sql tests/install-check-alert-migration.test.js
git commit -m "feat(v1.26.87): 記住哪些檢測失敗已經通知過"
```

---

### Task 2: The evaluator (pure)

**Files:**
- Create: `src/lib/install-check-alerts.js`
- Test: `tests/install-check-alerts.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `stateKey(userId: number, machine: string, checkName: string) => string`
  - `evaluateFailures({ reports: MachineReport[], knownState: AlertStateRow[] }) => { newFailures: NewFailure[], resolved: StateRef[], detailChanges: DetailChange[] }`
  - `MachineReport = { user_id, user_name, machine, client_version, checks: Array<{name, status, detail?, fix?}> }`
  - `NewFailure = { user_id, user_name, machine, check_name, detail, fix, client_version }`
  - `StateRef = { user_id, machine, check_name }`
  - `DetailChange = { user_id, machine, check_name, detail }`

The fixtures below are the real shape of production rows: `checks[]` entries are `{name, status, detail, fix?, evidence?}`, and Adam's `memory_load` failure is copied from the row uploaded on 2026-08-06.

- [ ] **Step 1: Write the failing test**

```js
// tests/install-check-alerts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateFailures, stateKey } from '../src/lib/install-check-alerts.js';

// Real payload from production, machine LAPTOP-MBGGLV2J, client 1.26.84.
const ADAM_MEMORY_LOAD_FAIL = {
  name: 'memory_load',
  status: 'fail',
  detail: 'memories have never loaded automatically on this account (`bash` on this machine is the WSL launcher, whose home directory is not this one)',
  fix: 'Re-run the installer, then fully restart your AI tool and open a new conversation',
};

function adamReport(checks) {
  return {
    user_id: 3,
    user_name: 'Adam',
    machine: 'LAPTOP-MBGGLV2J',
    client_version: '1.26.84',
    checks,
  };
}

function announced(overrides = {}) {
  return {
    user_id: 3,
    machine: 'LAPTOP-MBGGLV2J',
    check_name: 'memory_load',
    detail: ADAM_MEMORY_LOAD_FAIL.detail,
    announced_at: new Date('2026-08-06T00:00:00Z'),
    resolved_at: null,
    ...overrides,
  };
}

describe('evaluateFailures — first sighting', () => {
  it('a failure nobody has announced is new', () => {
    const { newFailures } = evaluateFailures({
      reports: [adamReport([{ name: 'scheduler', status: 'pass', detail: 'ok' }, ADAM_MEMORY_LOAD_FAIL])],
      knownState: [],
    });
    assert.equal(newFailures.length, 1);
    assert.deepEqual(newFailures[0], {
      user_id: 3,
      user_name: 'Adam',
      machine: 'LAPTOP-MBGGLV2J',
      check_name: 'memory_load',
      detail: ADAM_MEMORY_LOAD_FAIL.detail,
      fix: ADAM_MEMORY_LOAD_FAIL.fix,
      client_version: '1.26.84',
    });
  });

  it('an all-green report produces nothing', () => {
    const { newFailures, resolved } = evaluateFailures({
      reports: [adamReport([{ name: 'scheduler', status: 'pass', detail: 'ok' }])],
      knownState: [],
    });
    assert.equal(newFailures.length, 0);
    assert.equal(resolved.length, 0);
  });

  it('warn is not a failure', () => {
    const { newFailures } = evaluateFailures({
      reports: [adamReport([{ name: 'api_key_source', status: 'warn', detail: 'key only in env' }])],
      knownState: [],
    });
    assert.equal(newFailures.length, 0);
  });
});

describe('evaluateFailures — announce once', () => {
  it('the same failure already announced is not new again', () => {
    const { newFailures } = evaluateFailures({
      reports: [adamReport([ADAM_MEMORY_LOAD_FAIL])],
      knownState: [announced()],
    });
    assert.equal(newFailures.length, 0);
  });

  it('running twice over the same input announces nothing the second time', () => {
    const reports = [adamReport([ADAM_MEMORY_LOAD_FAIL])];
    const first = evaluateFailures({ reports, knownState: [] });
    assert.equal(first.newFailures.length, 1);

    // what the job would have written after the first run
    const stateAfterFirst = first.newFailures.map((f) => ({
      user_id: f.user_id,
      machine: f.machine,
      check_name: f.check_name,
      detail: f.detail,
      announced_at: new Date('2026-08-06T10:00:00Z'),
      resolved_at: null,
    }));

    const second = evaluateFailures({ reports, knownState: stateAfterFirst });
    assert.equal(second.newFailures.length, 0, 'second run must be silent');
  });

  it('a reworded detail updates the record but does not re-announce', () => {
    const reworded = { ...ADAM_MEMORY_LOAD_FAIL, detail: 'memories never load: bash here is the WSL launcher' };
    const { newFailures, detailChanges } = evaluateFailures({
      reports: [adamReport([reworded])],
      knownState: [announced()],
    });
    assert.equal(newFailures.length, 0);
    assert.deepEqual(detailChanges, [{
      user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load', detail: reworded.detail,
    }]);
  });
});

describe('evaluateFailures — resolution re-arms', () => {
  it('a previously announced check that now passes is resolved', () => {
    const { resolved, newFailures } = evaluateFailures({
      reports: [adamReport([{ name: 'memory_load', status: 'pass', detail: 'loaded 3 memories' }])],
      knownState: [announced()],
    });
    assert.deepEqual(resolved, [{ user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load' }]);
    assert.equal(newFailures.length, 0);
  });

  it('failing again after being resolved is announced again', () => {
    const { newFailures } = evaluateFailures({
      reports: [adamReport([ADAM_MEMORY_LOAD_FAIL])],
      knownState: [announced({ resolved_at: new Date('2026-08-06T09:00:00Z') })],
    });
    assert.equal(newFailures.length, 1);
  });
});

describe('evaluateFailures — a report without checks decides nothing', () => {
  it('a beacon row does not resolve a live failure', () => {
    const { resolved, newFailures } = evaluateFailures({
      reports: [adamReport([])],
      knownState: [announced()],
    });
    assert.equal(resolved.length, 0, 'an empty report must not read as "fixed"');
    assert.equal(newFailures.length, 0);
  });

  it('a check absent from the report is left alone, not resolved', () => {
    const { resolved } = evaluateFailures({
      reports: [adamReport([{ name: 'scheduler', status: 'pass', detail: 'ok' }])],
      knownState: [announced()],
    });
    assert.equal(resolved.length, 0);
  });
});

describe('stateKey', () => {
  it('distinguishes machines that share a check name', () => {
    assert.notEqual(stateKey(3, 'A', 'memory_load'), stateKey(3, 'B', 'memory_load'));
  });

  it('distinguishes users that share a machine name', () => {
    assert.notEqual(stateKey(3, 'TANK', 'memory_load'), stateKey(11, 'TANK', 'memory_load'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/install-check-alerts.test.js`
Expected: FAIL — `Cannot find module '../src/lib/install-check-alerts.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/install-check-alerts.js
/**
 * install-check-alerts — decide which self-check failures are worth announcing.
 *
 * Pure: no database, no clock, no logging. Everything it needs arrives as
 * arguments so the run-twice behaviour (the point of the whole feature) can be
 * asserted directly rather than inferred from a live table.
 *
 * A failure is identified by (user_id, machine, check_name). One upgrade uploads
 * several reports, and the same red light appears in each of them; keying on the
 * report would announce one problem three times.
 */

/**
 * @typedef {{name: string, status: string, detail?: string, fix?: string}} Check
 * @typedef {{user_id: number, user_name: string, machine: string, client_version: string|null, checks: Check[]}} MachineReport
 * @typedef {{user_id: number, machine: string, check_name: string, detail: string|null, announced_at: Date|null, resolved_at: Date|null}} AlertStateRow
 */

/** Stable identity for one failure. JSON so no separator can collide with a value. */
export function stateKey(userId, machine, checkName) {
  return JSON.stringify([userId, machine, checkName]);
}

/**
 * @param {{reports: MachineReport[], knownState: AlertStateRow[]}} input
 */
export function evaluateFailures({ reports = [], knownState = [] } = {}) {
  const byKey = new Map(
    knownState.map((row) => [stateKey(row.user_id, row.machine, row.check_name), row])
  );

  const newFailures = [];
  const resolved = [];
  const detailChanges = [];

  for (const report of reports) {
    const checks = Array.isArray(report?.checks) ? report.checks : [];

    for (const check of checks) {
      if (!check || typeof check.name !== 'string') continue;

      const key = stateKey(report.user_id, report.machine, check.name);
      const prev = byKey.get(key);
      const detail = typeof check.detail === 'string' ? check.detail : '';

      if (check.status === 'fail') {
        // Never announced, or announced and since resolved -> this is news.
        if (!prev || !prev.announced_at || prev.resolved_at) {
          newFailures.push({
            user_id: report.user_id,
            user_name: report.user_name,
            machine: report.machine,
            check_name: check.name,
            detail,
            fix: typeof check.fix === 'string' ? check.fix : '',
            client_version: report.client_version || '',
          });
        } else if ((prev.detail || '') !== detail) {
          // Same problem, new wording. Keep the record current, stay quiet.
          detailChanges.push({
            user_id: report.user_id,
            machine: report.machine,
            check_name: check.name,
            detail,
          });
        }
        continue;
      }

      // Not failing. Only a check that is present and no longer failing counts
      // as resolved; a check missing from the report says nothing either way.
      if (prev && prev.announced_at && !prev.resolved_at) {
        resolved.push({
          user_id: report.user_id,
          machine: report.machine,
          check_name: check.name,
        });
      }
    }
  }

  return { newFailures, resolved, detailChanges };
}

export default evaluateFailures;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/install-check-alerts.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/install-check-alerts.js tests/install-check-alerts.test.js
git commit -m "feat(v1.26.87): 判斷哪些檢測失敗是「新的」，同一件事只算一次"
```

---

### Task 3: The message (pure)

**Files:**
- Create: `src/lib/install-check-alert-message.js`
- Test: `tests/install-check-alert-message.test.js`

**Interfaces:**
- Consumes: `NewFailure[]` from Task 2.
- Produces:
  - `BROADCAST_BODY_LIMIT = 2000`
  - `renderAlertMessage(newFailures: NewFailure[], opts?: {limit?: number}) => { title: string, body: string, omitted: number }`

- [ ] **Step 1: Write the failing test**

```js
// tests/install-check-alert-message.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderAlertMessage, BROADCAST_BODY_LIMIT } from '../src/lib/install-check-alert-message.js';

const WSL_DETAIL = 'memories have never loaded automatically on this account (`bash` on this machine is the WSL launcher, whose home directory is not this one)';
const WSL_FIX = 'Re-run the installer, then fully restart your AI tool and open a new conversation';

function failure(overrides = {}) {
  return {
    user_id: 3,
    user_name: 'Adam',
    machine: 'LAPTOP-MBGGLV2J',
    check_name: 'memory_load',
    detail: WSL_DETAIL,
    fix: WSL_FIX,
    client_version: '1.26.84',
    ...overrides,
  };
}

describe('renderAlertMessage — one entry carries everything needed to act', () => {
  const { title, body, omitted } = renderAlertMessage([failure()]);

  it('names the check, the person and the machine', () => {
    assert.match(body, /memory_load/);
    assert.match(body, /Adam/);
    assert.match(body, /LAPTOP-MBGGLV2J/);
  });

  it('carries the reason and the fix verbatim', () => {
    assert.ok(body.includes(WSL_DETAIL));
    assert.ok(body.includes(WSL_FIX));
  });

  it('carries the client version', () => {
    assert.match(body, /1\.26\.84/);
  });

  it('counts the problem in the title', () => {
    assert.match(title, /1/);
    assert.ok(title.length <= 200);
  });

  it('omits nothing', () => {
    assert.equal(omitted, 0);
  });
});

describe('renderAlertMessage — rollup', () => {
  it('six machines with one cause read as one entry', () => {
    const machines = ['LAPTOP-MBGGLV2J', 'TANK', 'after', 'LAPTOP-G95HIQ3V', 'LAPTOP-RGE2HCSQ', 'Fontrip-Joanna'];
    const failures = machines.map((m, i) => failure({ machine: m, user_name: `U${i}`, user_id: 100 + i }));
    const { body } = renderAlertMessage(failures);

    assert.equal(body.split('memory_load').length - 1, 1, 'the check name should appear once');
    for (const m of machines) assert.ok(body.includes(m), `${m} missing`);
  });

  it('the same check with different causes stays two entries', () => {
    const { body } = renderAlertMessage([
      failure({ check_name: 'scheduler', detail: 'launchd not registered' }),
      failure({ check_name: 'scheduler', detail: 'Task Scheduler state=Disabled', machine: 'TANK' }),
    ]);
    assert.equal(body.split('scheduler').length - 1, 2);
  });
});

describe('renderAlertMessage — truncation says so', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    failure({ machine: `M${i}`, user_id: 200 + i, detail: `${WSL_DETAIL} #${i}` }));
  const { body, omitted } = renderAlertMessage(many);

  it('respects the broadcast body limit', () => {
    assert.ok(body.length <= BROADCAST_BODY_LIMIT, `body was ${body.length}`);
  });

  it('reports how many entries were left out', () => {
    assert.ok(omitted > 0, 'this fixture is meant to overflow');
    assert.match(body, new RegExp(String(omitted)));
  });

  it('the stated count plus the shown count equals the total', () => {
    const shown = body.split('memory_load').length - 1;
    assert.equal(shown + omitted, 60);
  });

  it('a single oversized entry is still delivered, marked as cut', () => {
    const huge = failure({ detail: 'x'.repeat(5000) });
    const out = renderAlertMessage([huge, failure({ machine: 'TANK' })]);
    assert.ok(out.body.length <= BROADCAST_BODY_LIMIT);
    assert.ok(out.body.length > 0);
    assert.equal(out.omitted, 1);
  });
});

describe('renderAlertMessage — nothing to say', () => {
  it('returns an empty body for an empty list', () => {
    const { body, omitted } = renderAlertMessage([]);
    assert.equal(body, '');
    assert.equal(omitted, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/install-check-alert-message.test.js`
Expected: FAIL — `Cannot find module '../src/lib/install-check-alert-message.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/install-check-alert-message.js
/**
 * Render new install-check failures as a broadcast title and body.
 *
 * Pure. The reader-facing strings are Chinese on purpose: this text is shown to
 * the super admin by the session-start hook, and every other broadcast the
 * server writes (see src/jobs/nightly-upgrade-reminder.js) reads the same way.
 *
 * Two rules earn their code here:
 *   - identical failures across machines collapse into one entry, so "six
 *     machines, same WSL bash" reads as one row rather than six;
 *   - a body that does not fit says how many entries were dropped. A silent cut
 *     reads as "that was everything", which is the defect this feature exists
 *     to remove.
 */

/** validateBroadcastPayload in src/routes/broadcast.js rejects anything longer. */
export const BROADCAST_BODY_LIMIT = 2000;

const SEPARATOR = '\n\n';

function groupKey(failure) {
  return JSON.stringify([failure.check_name, failure.detail]);
}

function footerFor(omitted, total) {
  return `${SEPARATOR}（另有 ${omitted} 項未列出，總共 ${total} 項）`;
}

function buildEntries(newFailures) {
  const groups = new Map();

  for (const failure of newFailures) {
    const key = groupKey(failure);
    if (!groups.has(key)) {
      groups.set(key, {
        check_name: failure.check_name,
        detail: failure.detail,
        fix: failure.fix,
        machines: [],
        versions: new Set(),
      });
    }
    const group = groups.get(key);
    group.machines.push(`${failure.user_name}（${failure.machine}）`);
    if (failure.client_version) group.versions.add(failure.client_version);
    if (!group.fix && failure.fix) group.fix = failure.fix;
  }

  return [...groups.values()].map((group) => {
    const lines = [`${group.check_name} 失敗 — ${group.machines.join('、')}`];
    if (group.detail) lines.push(`  ${group.detail}`);
    if (group.fix) lines.push(`  修法：${group.fix}`);
    if (group.versions.size > 0) lines.push(`  版本 ${[...group.versions].join('、')}`);
    return lines.join('\n');
  });
}

/**
 * @param {Array<Object>} newFailures
 * @param {{limit?: number}} [opts]
 * @returns {{title: string, body: string, omitted: number}}
 */
export function renderAlertMessage(newFailures = [], { limit = BROADCAST_BODY_LIMIT } = {}) {
  const entries = buildEntries(newFailures);
  const total = entries.length;
  const title = `檢測出現 ${total} 個新問題`;

  if (total === 0) return { title, body: '', omitted: 0 };

  const kept = [];
  for (let i = 0; i < total; i += 1) {
    const remainingAfterThis = total - i - 1;
    const footer = remainingAfterThis > 0 ? footerFor(remainingAfterThis, total) : '';
    const candidate = [...kept, entries[i]].join(SEPARATOR);

    if (candidate.length + footer.length <= limit) {
      kept.push(entries[i]);
      continue;
    }

    const omitted = total - i;
    if (kept.length === 0) {
      // Even the first entry does not fit. Deliver a cut version rather than
      // nothing — an empty body is rejected by the broadcast validator.
      const cutFooter = footerFor(omitted - 1 > 0 ? omitted - 1 : 0, total);
      const room = Math.max(1, limit - cutFooter.length);
      return { title, body: entries[0].slice(0, room) + cutFooter, omitted: omitted - 1 };
    }
    return { title, body: kept.join(SEPARATOR) + footerFor(omitted, total), omitted };
  }

  return { title, body: kept.join(SEPARATOR), omitted: 0 };
}

export default renderAlertMessage;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/install-check-alert-message.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/install-check-alert-message.js tests/install-check-alert-message.test.js
git commit -m "feat(v1.26.87): 把新的檢測失敗寫成一則看得懂的通知，多台同因合併一行"
```

---

### Task 4: The job — SQL, state writes, broadcast

**Files:**
- Create: `src/jobs/install-check-alerts.js`
- Test: `tests/install-check-alerts-job.test.js`

**Interfaces:**
- Consumes: `evaluateFailures` (Task 2), `renderAlertMessage` (Task 3).
- Produces: `runInstallCheckAlerts({ query? }) => Promise<{announced: number, omitted: number, broadcast_id: number|null}>`

The test drives a fake `query` that dispatches on the SQL text, the same way `tests/broadcast.test.js` fakes the database.

- [ ] **Step 1: Write the failing test**

```js
// tests/install-check-alerts-job.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runInstallCheckAlerts } from '../src/jobs/install-check-alerts.js';

const ADAM_ROW = {
  user_id: 3,
  user_name: 'Adam',
  machine: 'LAPTOP-MBGGLV2J',
  client_version: '1.26.84',
  checks: [
    { name: 'scheduler', status: 'pass', detail: 'Task Scheduler state=Ready' },
    { name: 'memory_load', status: 'fail', detail: 'bash here is the WSL launcher', fix: 'Re-run the installer' },
  ],
};

/** Fake db: dispatches on the SQL text, records every write. */
function makeQuery({ reports = [ADAM_ROW], state = [], admins = [{ id: 1 }] } = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM install_check_logs')) return { rows: reports, rowCount: reports.length };
    if (sql.includes('FROM install_check_alert_state')) return { rows: state, rowCount: state.length };
    if (sql.includes("role='super_admin'") || sql.includes("role = 'super_admin'")) {
      return { rows: admins, rowCount: admins.length };
    }
    if (sql.includes('INSERT INTO broadcast_messages')) return { rows: [{ id: 99 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { query, calls };
}

const broadcastInsert = (calls) => calls.find((c) => c.sql.includes('INSERT INTO broadcast_messages'));

describe('runInstallCheckAlerts', () => {
  it('announces a new failure and returns the broadcast id', async () => {
    const { query, calls } = makeQuery();
    const result = await runInstallCheckAlerts({ query });

    assert.equal(result.announced, 1);
    assert.equal(result.broadcast_id, 99);
    assert.ok(broadcastInsert(calls), 'no broadcast was written');
  });

  it('writes the broadcast as a warning targeted at the oldest super_admin only', async () => {
    const { query, calls } = makeQuery({ admins: [{ id: 1 }] });
    await runInstallCheckAlerts({ query });

    const insert = broadcastInsert(calls);
    assert.match(insert.sql, /'warning'/);
    assert.match(insert.sql, /FALSE/); // allow_snooze
    assert.ok(insert.params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === 1),
      'target_users should be exactly [1]');
  });

  it('records state so a second run is silent', async () => {
    const { query, calls } = makeQuery();
    await runInstallCheckAlerts({ query });
    const upsert = calls.find((c) => c.sql.includes('INSERT INTO install_check_alert_state'));
    assert.ok(upsert, 'state was not recorded');
    assert.match(upsert.sql, /ON CONFLICT/);
  });

  it('says nothing when every failure is already announced', async () => {
    const { query, calls } = makeQuery({
      state: [{
        user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load',
        detail: 'bash here is the WSL launcher',
        announced_at: new Date('2026-08-06T00:00:00Z'), resolved_at: null,
      }],
    });
    const result = await runInstallCheckAlerts({ query });

    assert.equal(result.announced, 0);
    assert.equal(broadcastInsert(calls), undefined);
  });

  it('marks a fixed check resolved without announcing anything', async () => {
    const green = { ...ADAM_ROW, checks: [{ name: 'memory_load', status: 'pass', detail: 'loaded' }] };
    const { query, calls } = makeQuery({
      reports: [green],
      state: [{
        user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load', detail: 'x',
        announced_at: new Date('2026-08-06T00:00:00Z'), resolved_at: null,
      }],
    });
    const result = await runInstallCheckAlerts({ query });

    assert.equal(result.announced, 0);
    assert.ok(calls.some((c) => c.sql.includes('SET resolved_at')), 'resolution was not recorded');
    assert.equal(broadcastInsert(calls), undefined);
  });

  it('records state but writes no broadcast when there is no super_admin', async () => {
    const { query, calls } = makeQuery({ admins: [] });
    const result = await runInstallCheckAlerts({ query });

    assert.equal(result.broadcast_id, null);
    assert.equal(broadcastInsert(calls), undefined);
    assert.ok(calls.some((c) => c.sql.includes('INSERT INTO install_check_alert_state')));
  });

  it('only reads reports that actually carry checks', async () => {
    const { query, calls } = makeQuery();
    await runInstallCheckAlerts({ query });
    const read = calls.find((c) => c.sql.includes('FROM install_check_logs'));
    assert.match(read.sql, /jsonb_array_length/);
    assert.match(read.sql, /DISTINCT ON/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/install-check-alerts-job.test.js`
Expected: FAIL — `Cannot find module '../src/jobs/install-check-alerts.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/jobs/install-check-alerts.js
/**
 * Announce new install-check failures to the super admin.
 *
 * Runs after a self-check report is stored, and once at server startup so the
 * reports already in the table are evaluated rather than waiting for each
 * machine to check in again. The state table makes both paths idempotent.
 *
 * There is deliberately no cron: the set of failing checks changes only when a
 * new report arrives, so a nightly pass would add up to 24 hours of delay and a
 * second code path for no gain.
 */

import { query as defaultQuery } from '../utils/db.js';
import logger from '../utils/logger.js';
import { evaluateFailures } from '../lib/install-check-alerts.js';
import { renderAlertMessage } from '../lib/install-check-alert-message.js';

// One row per (user, machine): the newest report that carries a checks array.
// Beacon rows (install_started and friends) are emitted before the checks run
// and carry none; letting one win would mark every open problem resolved at the
// start of the next upgrade.
const LATEST_REPORTS_SQL = `
  SELECT DISTINCT ON (l.user_id, l.machine)
         l.user_id,
         COALESCE(u.name, u.email) AS user_name,
         l.machine,
         l.client_version,
         l.full_log->'checks'      AS checks
  FROM install_check_logs l
  JOIN users u ON u.id = l.user_id
  WHERE l.machine IS NOT NULL
    AND jsonb_typeof(l.full_log->'checks') = 'array'
    AND jsonb_array_length(l.full_log->'checks') > 0
  ORDER BY l.user_id, l.machine, l.ts DESC
`;

const KNOWN_STATE_SQL = `
  SELECT user_id, machine, check_name, detail, announced_at, resolved_at
  FROM install_check_alert_state
`;

const RESOLVE_SQL = `
  UPDATE install_check_alert_state
  SET resolved_at = NOW()
  WHERE user_id = $1 AND machine = $2 AND check_name = $3
`;

const UPDATE_DETAIL_SQL = `
  UPDATE install_check_alert_state
  SET detail = $4
  WHERE user_id = $1 AND machine = $2 AND check_name = $3
`;

const ANNOUNCE_SQL = `
  INSERT INTO install_check_alert_state
    (user_id, machine, check_name, detail, announced_at, resolved_at)
  VALUES ($1, $2, $3, $4, NOW(), NULL)
  ON CONFLICT (user_id, machine, check_name)
  DO UPDATE SET detail = EXCLUDED.detail, announced_at = NOW(), resolved_at = NULL
`;

// Oldest super_admin, matching src/jobs/nightly-upgrade-reminder.js. Not "any
// super_admin": production has two, and only id 1 is the person who acts on this.
const SUPER_ADMIN_SQL = `SELECT id FROM users WHERE role = 'super_admin' ORDER BY id ASC LIMIT 1`;

const BROADCAST_SQL = `
  INSERT INTO broadcast_messages
    (type, severity, title, body, target_users,
     allow_snooze, snooze_hours, cooldown_minutes, ends_at, is_auto, created_by)
  VALUES ('announcement', 'warning', $1, $2, $3,
          FALSE, 24, 1440, NOW() + INTERVAL '7 days', TRUE, $4)
  RETURNING id
`;

export async function runInstallCheckAlerts({ query = defaultQuery } = {}) {
  const [reportsResult, stateResult] = await Promise.all([
    query(LATEST_REPORTS_SQL),
    query(KNOWN_STATE_SQL),
  ]);

  const { newFailures, resolved, detailChanges } = evaluateFailures({
    reports: reportsResult.rows,
    knownState: stateResult.rows,
  });

  for (const row of resolved) {
    await query(RESOLVE_SQL, [row.user_id, row.machine, row.check_name]);
  }
  for (const row of detailChanges) {
    await query(UPDATE_DETAIL_SQL, [row.user_id, row.machine, row.check_name, row.detail]);
  }

  if (newFailures.length === 0) {
    return { announced: 0, omitted: 0, broadcast_id: null };
  }

  for (const failure of newFailures) {
    await query(ANNOUNCE_SQL, [
      failure.user_id, failure.machine, failure.check_name, failure.detail,
    ]);
  }

  const admin = await query(SUPER_ADMIN_SQL);
  if (admin.rowCount === 0) {
    logger.warn('install-check-alerts: no super_admin, state recorded but nothing announced', {
      count: newFailures.length,
    });
    return { announced: newFailures.length, omitted: 0, broadcast_id: null };
  }

  const adminId = admin.rows[0].id;
  const { title, body, omitted } = renderAlertMessage(newFailures);
  const inserted = await query(BROADCAST_SQL, [title, body, [adminId], adminId]);

  logger.info('install-check-alerts announced', {
    count: newFailures.length,
    omitted,
    broadcast_id: inserted.rows[0].id,
  });

  return { announced: newFailures.length, omitted, broadcast_id: inserted.rows[0].id };
}

export default runInstallCheckAlerts;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/install-check-alerts-job.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/install-check-alerts.js tests/install-check-alerts-job.test.js
git commit -m "feat(v1.26.87): 新的檢測失敗開一則只給管理員的廣播"
```

---

### Task 5: Wiring — after a report, and once at startup

**Files:**
- Modify: `src/routes/debug.js` (the `createDebugRouter` signature and the success path around line 118)
- Modify: `src/index.js` (inside the `app.listen` callback, alongside the other job starts)
- Test: `tests/install-check-alerts-wiring.test.js`

**Interfaces:**
- Consumes: `runInstallCheckAlerts` (Task 4).
- Produces: `createDebugRouter({ query, auth, onReportStored? })` — `onReportStored` defaults to the real runner and exists so the wiring can be asserted without a database.

Evaluation runs **before** `res.json` so the test is deterministic, and inside a `try/catch` so it can never change the response. The work is two SELECTs and a handful of writes; the upload path can afford it.

- [ ] **Step 1: Write the failing test**

```js
// tests/install-check-alerts-wiring.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDebugRouter } from '../src/routes/debug.js';

function callRoute(deps, body, user = { id: 3 }) {
  return new Promise((resolve) => {
    const req = {
      method: 'POST', url: '/install-check', path: '/install-check',
      originalUrl: '/api/debug/install-check', baseUrl: '/api/debug',
      headers: {}, body,
    };
    const res = {
      statusCode: 200,
      setHeader() {}, getHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    const auth = (r, _res, next) => { r.user = user; next(); };
    createDebugRouter({ ...deps, auth })(req, res, () => resolve({ status: 500, body: null }));
  });
}

const VALID_BODY = {
  ts: '2026-08-06T10:00:00+08:00',
  trigger: 'post_upgrade',
  client_version: '1.26.86',
  platform: 'win32',
  machine: 'LAPTOP-MBGGLV2J',
  checks: [{ name: 'memory_load', status: 'fail', detail: 'WSL launcher', fix: 'Re-run the installer' }],
  summary: { pass: 9, warn: 0, fail: 1 },
};

describe('install-check alerting is wired to the upload', () => {
  it('evaluates alerts after a report is stored', async () => {
    let called = 0;
    const inserts = [];
    const res = await callRoute({
      query: async (sql, params) => { inserts.push({ sql, params }); return { rows: [], rowCount: 0 }; },
      onReportStored: async () => { called += 1; },
    }, VALID_BODY);

    assert.equal(res.status, 200);
    assert.equal(called, 1);
    assert.ok(inserts.some((c) => c.sql.includes('INSERT INTO install_check_logs')));
  });

  it('a failing evaluator does not cost the report', async () => {
    const inserts = [];
    const res = await callRoute({
      query: async (sql, params) => { inserts.push({ sql, params }); return { rows: [], rowCount: 0 }; },
      onReportStored: async () => { throw new Error('alerting is broken'); },
    }, VALID_BODY);

    assert.equal(res.status, 200, 'the upload must survive a broken alerter');
    assert.deepEqual(res.body, { ok: true });
    assert.ok(inserts.some((c) => c.sql.includes('INSERT INTO install_check_logs')),
      'the row must still be stored');
  });

  it('a rejected report does not trigger evaluation', async () => {
    let called = 0;
    const res = await callRoute({
      query: async () => ({ rows: [], rowCount: 0 }),
      onReportStored: async () => { called += 1; },
    }, { trigger: 'post_upgrade' }); // no ts -> 400

    assert.equal(res.status, 400);
    assert.equal(called, 0);
  });
});

describe('startup sweep', () => {
  it('src/index.js runs the sweep and swallows its failure', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(src, /runInstallCheckAlerts/);
    assert.match(src, /runInstallCheckAlerts\(\)[\s\S]{0,80}catch/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/install-check-alerts-wiring.test.js`
Expected: FAIL — `onReportStored` is ignored, so `called` stays 0.

- [ ] **Step 3: Wire the route**

In `src/routes/debug.js`, add the import at the top:

```js
import { runInstallCheckAlerts } from '../jobs/install-check-alerts.js';
```

Change the factory signature:

```js
export function createDebugRouter({ query, auth, onReportStored }) {
  const router = Router();
  // Injected so the wiring is testable without a database. In production this is
  // the real evaluator, reading the same pool the route writes through.
  const evaluateAlerts = onReportStored || (() => runInstallCheckAlerts({ query }));
```

And replace the success path (currently `res.json({ ok: true });`) with:

```js
      // Alerting must never cost a report: the row is already committed, and a
      // failure here is logged rather than returned.
      try {
        await evaluateAlerts();
      } catch (err) {
        logger.error?.('install-check alert evaluation failed', { error: err?.message });
      }

      res.json({ ok: true });
```

- [ ] **Step 4: Wire the startup sweep**

In `src/index.js`, add the import beside the other job imports:

```js
import { runInstallCheckAlerts } from './jobs/install-check-alerts.js';
```

and inside the `app.listen` callback, after `seedDefaultPasswords();`:

```js
    // Evaluate the reports already in the table once per boot, so failures that
    // predate this release surface instead of waiting for each machine to check
    // in again. Idempotent via install_check_alert_state.
    runInstallCheckAlerts().catch((err) =>
      logger.error('install-check startup sweep failed', { error: err.message }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/install-check-alerts-wiring.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the neighbouring suites that touch this route**

Run: `node --test tests/debug-route.test.js tests/debug-route-beacon-version.test.js tests/install-check-null-byte-sanitize.test.js`
Expected: PASS — the added parameter is optional, so these must be unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/routes/debug.js src/index.js tests/install-check-alerts-wiring.test.js
git commit -m "feat(v1.26.87): 收到報告當下就評估，開機時補跑一次歷史資料"
```

---

### Task 6: The NUL bytes that hide the file from grep

**Files:**
- Modify: `src/routes/debug.js` (lines 73 and 81, inside comments)
- Test: `tests/source-files-are-text.test.js`

`src/routes/debug.js` contains two raw NUL bytes. `file` reports the source as `data`, and `grep` skips it as binary — so searching `src/` for `install-check` returns nothing and reads as "this route does not exist".

- [ ] **Step 1: Write the failing test**

```js
// tests/source-files-are-text.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Control bytes that make grep treat a source file as binary and skip it
// silently. Tab (09), LF (0a), CR (0d) are legitimate; the rest are not.
const FORBIDDEN = /[\x00-\x08\x0e-\x1f]/; // escapes, never a literal byte

function jsFilesUnder(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) jsFilesUnder(full, found);
    else if (entry.endsWith('.js') || entry.endsWith('.cjs')) found.push(full);
  }
  return found;
}

describe('source files stay searchable', () => {
  it('no file under src/ contains a control byte', () => {
    const root = new URL('../src', import.meta.url).pathname;
    const offenders = jsFilesUnder(root)
      .filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')));
    assert.deepEqual(offenders, [], `control bytes make grep skip these files: ${offenders.join(', ')}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/source-files-are-text.test.js`
Expected: FAIL, naming `src/routes/debug.js`.

- [ ] **Step 3: Strip the bytes**

The two comment lines currently read (with a literal NUL where the escape should be):

```
      // v1.17.83 — Postgres JSONB strictly rejects  ; client-side
```

Rewrite both so the byte is described rather than embedded:

```js
      // v1.17.83 - Postgres JSONB strictly rejects the NUL character (U+0000);
      // client-side mojibake / dirty env vars introduce them. Strip NUL bytes
      // before insert; other control characters are JSON-spec-allowed and do
      // not need changing.
```

Apply the same treatment at the second site. Verify with:

```bash
/usr/bin/perl -ne 'print "line $.\n" if /[\x00-\x08\x0e-\x1f]/' src/routes/debug.js
```

Expected: no output.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/source-files-are-text.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm the file is text again**

Run: `file src/routes/debug.js && grep -c install-check src/routes/debug.js`
Expected: `ASCII text` (or `Unicode text`), and a non-zero count.

- [ ] **Step 6: Commit**

```bash
git add src/routes/debug.js tests/source-files-are-text.test.js
git commit -m "fix(v1.26.87): 兩個 NUL 位元組害整個檔案被 grep 當二進位跳過"
```

---

### Task 7: Prove the guards actually guard

**Files:**
- No production changes. Temporary edits, reverted from a backup copy.

Adding a check is not the same as the check running. Each guard below is broken on purpose once, and the test that should catch it must go red.

**Restore from a copy, not from git** — these edits sit in an uncommitted working tree during development, and `git checkout` would take other work with it.

- [ ] **Step 1: Back up the two files**

```bash
cp src/lib/install-check-alerts.js /tmp/ica.bak
cp src/lib/install-check-alert-message.js /tmp/icam.bak
```

- [ ] **Step 2: Break the announce-once guard**

In `src/lib/install-check-alerts.js`, change the new-failure condition to always fire:

```js
        if (true) {
```

- [ ] **Step 3: Confirm the run-twice test goes red**

Run: `node --test tests/install-check-alerts.test.js`
Expected: FAIL on "running twice over the same input announces nothing the second time".
If it passes, the test is not exercising the guard and must be fixed before continuing.

- [ ] **Step 4: Restore**

```bash
cp /tmp/ica.bak src/lib/install-check-alerts.js
node --test tests/install-check-alerts.test.js   # expect PASS again
```

- [ ] **Step 5: Break the truncation notice**

In `src/lib/install-check-alert-message.js`, make the overflow branch cut silently:

```js
    return { title, body: kept.join(SEPARATOR), omitted: 0 };
```

- [ ] **Step 6: Confirm the truncation test goes red**

Run: `node --test tests/install-check-alert-message.test.js`
Expected: FAIL on "reports how many entries were left out".

- [ ] **Step 7: Restore**

```bash
cp /tmp/icam.bak src/lib/install-check-alert-message.js
node --test tests/install-check-alert-message.test.js   # expect PASS again
```

- [ ] **Step 8: Positive control against real data**

Copy production's rows into a scratch file and run the evaluator over them, to confirm it finds the failures already known to be there rather than reporting a comfortable zero:

```bash
ssh root@kkvin.com 'cd /VinService/ownmind && docker compose exec -T db psql -U ownmind -d ownmind -At -c "
  SELECT json_agg(t) FROM (
    SELECT DISTINCT ON (l.user_id, l.machine)
           l.user_id, COALESCE(u.name,u.email) AS user_name, l.machine,
           l.client_version, l.full_log->'"'"'checks'"'"' AS checks
    FROM install_check_logs l JOIN users u ON u.id=l.user_id
    WHERE l.machine IS NOT NULL
      AND jsonb_typeof(l.full_log->'"'"'checks'"'"')='"'"'array'"'"'
      AND jsonb_array_length(l.full_log->'"'"'checks'"'"')>0
    ORDER BY l.user_id, l.machine, l.ts DESC
  ) t"' > /tmp/real-reports.json

node -e "
  const reports = JSON.parse(require('fs').readFileSync('/tmp/real-reports.json','utf8'));
  import('./src/lib/install-check-alerts.js').then(async (m) => {
    const { newFailures } = m.evaluateFailures({ reports, knownState: [] });
    const r = await import('./src/lib/install-check-alert-message.js');
    const msg = r.renderAlertMessage(newFailures);
    console.log('machines:', reports.length, 'new failures:', newFailures.length, 'omitted:', msg.omitted);
    console.log(msg.title); console.log(msg.body);
  });
"
```

Expected: a non-zero failure count including the known `memory_load` failures, and a body at or under 2000 characters. A zero here means the query or the evaluator is wrong, not that the estate is healthy.

- [ ] **Step 9: Record the output**

Paste the message the positive control produced into `openspec/changes/v1.26.87-install-check-alerts/tasks.md` under Phase 5. This is the evidence that the first broadcast will be readable; it is also what Vin sees before it is sent.

---

### Task 8: Documentation, backlog, release gates

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `docs/README.zh-TW.md`, `docs/README.ja.md`, `FILELIST.md`, `package.json`
- Modify: `openspec/BACKLOG.md` (item 27)
- Modify: `openspec/changes/v1.26.87-install-check-alerts/tasks.md`

- [ ] **Step 1: Bump the version to 1.26.87**

Only `package.json`. `SERVER_VERSION` reads from it, and the git tag comes later — the three stay in step by construction.

- [ ] **Step 2: Write the CHANGELOG entry**

Follow the existing shape: what was broken, the evidence, the change, the verification. Name the concrete evidence — 393 unread reports, the WSL failure visible since May.

- [ ] **Step 3: Update README (three languages) and FILELIST**

Three new files under `src/lib/`, `src/jobs/` and `db/`, plus four new test files.

- [ ] **Step 4: Update backlog item 27**

Mark the push shipped; leave the admin page open, with a line saying it was deliberately deferred until the push proves whether a page is still wanted. Do not close the item on "the data is uploaded" — the item's own words.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 0 failures. Paste the tail of the output into the commit or the task file; a claim of "passing" without the numbers is not a verification.

- [ ] **Step 6: Quality gates**

Invoke `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`, then `superpowers:receiving-code-review` on whatever comes back.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs(v1.26.87): 檢測失敗會主動找上門（backlog 27 推播部分完成）"
```

- [ ] **Step 8: Stop**

Do not tag, do not push, do not deploy. Ask Vin. A previous release is not standing authorisation for the next one.
