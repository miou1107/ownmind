import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRealDb } from './helpers/real-db.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The team page's "最近一次載入記憶" column, against a real Postgres.
 *
 * The four fields are produced entirely by SQL (lateral joins, FILTER aggregates, a JSONB
 * cast), and a stubbed query would agree with whatever the statement said. Seeds one member
 * per state the column has to tell apart, runs the real list handler, and checks the planner
 * can use the (user_id, ...) indexes instead of scanning activity_logs.
 *
 * Skipped, loudly, when docker is not available.
 */
test('GET /api/admin/users last-load fields against a real database', async (t) => {
  const db = await startRealDb();
  if (!db) {
    t.skip('docker is not available on this machine, so the last-load SQL was NOT exercised');
    return;
  }

  let pool;
  try {
    const skipped = db.applyMigrations(path.join(repoRoot, 'db'));
    assert.equal(skipped.some((s) => /^0(0[135]|11)_/.test(s)), false,
      `core migrations failed to apply: ${skipped.join('; ')}`);

    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = String(db.port);
    process.env.DB_NAME = 'ownmind';
    process.env.DB_USER = 'ownmind';
    process.env.DB_PASSWORD = 'test';

    const dbModule = await import('../src/utils/db.js');
    const { query } = dbModule;
    pool = dbModule.default ?? null;
    const { LIST_USERS_SQL, createListUsersHandler } = await import('../src/routes/admin-users-list.js');

    // 1 green, 2 yellow, 3 red (failed self-check), 4 green with an older error,
    // 5 beacon only, 6 finished install with no summary at all, 7 nothing but a
    // non-hook init, 8 a machine whose clock runs three days fast, 9 error report only.
    db.psql(`
      INSERT INTO users (id, email, name, api_key, role, created_at) VALUES
        (1, 'green@example.com',  'Green',  'key-1', 'user', NOW() - INTERVAL '9 days'),
        (2, 'yellow@example.com', 'Yellow', 'key-2', 'user', NOW() - INTERVAL '8 days'),
        (3, 'red@example.com',    'Red',    'key-3', 'user', NOW() - INTERVAL '7 days'),
        (4, 'older@example.com',  'Older',  'key-4', 'user', NOW() - INTERVAL '6 days'),
        (5, 'beacon@example.com', 'Beacon', 'key-5', 'user', NOW() - INTERVAL '5 days'),
        (6, 'nosum@example.com',  'NoSum',  'key-6', 'user', NOW() - INTERVAL '4 days'),
        (7, 'none@example.com',   'None',   'key-7', 'user', NOW() - INTERVAL '3 days'),
        (8, 'fast@example.com',   'Fast',   'key-8', 'user', NOW() - INTERVAL '2 days'),
        (9, 'erronly@example.com','ErrOnly','key-9', 'user', NOW() - INTERVAL '1 days');

      INSERT INTO activity_logs (user_id, ts, event, source) VALUES
        (1, NOW() - INTERVAL '2 hours', 'init', 'hook'),
        (1, NOW() - INTERVAL '3 days',  'init', 'hook'),
        (4, NOW() - INTERVAL '1 hour',  'init', 'hook'),
        (7, NOW() - INTERVAL '1 hour',  'init', 'mcp'),
        (7, NOW() - INTERVAL '1 hour',  'save', 'hook'),
        (8, NOW() + INTERVAL '3 days',  'init', 'hook');

      INSERT INTO install_check_logs (user_id, ts, trigger_kind, machine, summary) VALUES
        (1, NOW() - INTERVAL '5 days', 'install_started', 'iMac.local', NULL),
        (1, NOW() - INTERVAL '5 days' + INTERVAL '1 minute', 'post_install', 'iMac.local', '{"pass":5,"warn":0,"fail":0}'),
        (2, NOW() - INTERVAL '2 days', 'post_install', 'DESKTOP-X', '{"pass":5,"warn":1,"fail":0}'),
        (3, NOW() - INTERVAL '3 days', 'post_install', 'DESKTOP-Y', '{"pass":3,"warn":0,"fail":2}'),
        (4, NOW() - INTERVAL '5 days', 'error_install', 'MBP', NULL),
        (4, NOW() - INTERVAL '4 days', 'post_install', 'MBP', '{"pass":5,"warn":0,"fail":0}'),
        (5, NOW() - INTERVAL '1 day',  'install_started', 'M5', NULL),
        (6, NOW() - INTERVAL '1 day',  'post_install', 'M6', NULL),
        (9, NOW() - INTERVAL '1 day',  'error_fetch', 'M9', NULL);
    `);

    const rows = await new Promise((resolve, reject) => {
      const handler = createListUsersHandler({ query, logger: { error: reject, warn() {}, info() {} } });
      const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve(b); } };
      handler({}, res);
    });
    const by = Object.fromEntries(rows.map((r) => [r.email.split('@')[0], r]));
    const ms = (v) => (v ? new Date(v).getTime() : null);
    const now = Date.now();
    const HOUR = 3_600_000;

    assert.equal(rows.length, 9);
    // The existing fields are still there and the full key still is not.
    assert.equal(by.green.api_key_prefix, 'key-1');
    assert.equal(by.green.must_change_password, false);
    assert.ok(!('api_key' in by.green) && !('password_hash' in by.green));

    // 1: the newest hook init, the machine of the newest report, install time from the finished row.
    assert.ok(Math.abs(ms(by.green.last_memory_load_at) - (now - 2 * HOUR)) < 5 * 60_000);
    assert.equal(by.green.last_machine, 'iMac.local');
    assert.ok(by.green.first_install_at);
    assert.equal(by.green.last_install_error_at, null);

    // 1: the beacon (5 days ago) is earlier than the finished row (5 days ago + 1 minute).
    assert.ok(ms(by.green.first_install_at) > now - 5 * 24 * HOUR + 30_000, 'first_install_at skips the beacon');

    // 2: installed, never loaded.
    assert.equal(by.yellow.last_memory_load_at, null);
    assert.ok(by.yellow.first_install_at);
    assert.equal(by.yellow.last_install_error_at, null);
    assert.equal(by.yellow.last_machine, 'DESKTOP-X');

    // 3: a post_install whose self-check counted failures is an install error.
    assert.ok(by.red.last_install_error_at);
    assert.equal(by.red.last_memory_load_at, null);

    // 4: an old error row is reported, and it is older than the load.
    assert.ok(ms(by.older.last_install_error_at) < ms(by.older.last_memory_load_at));

    // 5: an install that never got past its beacon is not an install.
    assert.equal(by.beacon.first_install_at, null);
    assert.equal(by.beacon.last_install_error_at, null);
    assert.equal(by.beacon.last_machine, 'M5');

    // 6: a finished install with no summary is installed, and is not an error.
    assert.ok(by.nosum.first_install_at);
    assert.equal(by.nosum.last_install_error_at, null);

    // 7: only hook-sourced init events count as a memory load.
    assert.equal(by.none.last_memory_load_at, null);
    assert.equal(by.none.first_install_at, null);
    assert.equal(by.none.last_machine, null);

    // 8: a clock three days fast cannot put a load in the future.
    assert.ok(ms(by.fast.last_memory_load_at) <= Date.now() + 1000);

    // 9: an error report with no finished install is an error and not an install.
    assert.ok(by.erronly.last_install_error_at);
    assert.equal(by.erronly.first_install_at, null);

    // Newest member first, as before.
    assert.deepEqual(rows.map((r) => r.id), [9, 8, 7, 6, 5, 4, 3, 2, 1]);

    // The planner can find a member's rows through the (user_id, ...) indexes. A table this
    // small may still get a sequential scan, so when the plain plan has one the check is
    // repeated with sequential scans switched off, to prove an index path exists.
    const plainPlan = db.psql(`EXPLAIN ${LIST_USERS_SQL}`);
    let plan = plainPlan;
    let mode = 'default planner settings';
    if (/Seq Scan on activity_logs/.test(plainPlan)) {
      plan = db.psql(`SET enable_seqscan = off; EXPLAIN ${LIST_USERS_SQL}`);
      mode = 'enable_seqscan = off (the default plan chose a seq scan on this tiny table)';
    }
    console.log(`EXPLAIN checked under ${mode}`);
    console.log(plan);
    assert.doesNotMatch(plan, /Seq Scan on activity_logs/);
    assert.doesNotMatch(plan, /Seq Scan on install_check_logs/);
  } finally {
    if (pool?.end) await pool.end().catch(() => {});
    db.stop();
  }
});
