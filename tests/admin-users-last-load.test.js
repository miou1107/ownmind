/**
 * The team page's "最近一次載入記憶" column: GET /api/admin/users must say, per member, when
 * their OwnMind last loaded memories, which computer that was, when it was installed, and
 * when the install last reported an error.
 *
 * The four fields come from one query (lateral joins), not one query per member, so a team
 * of 40 still costs one round trip. There is no database in the test environment, so the
 * stub plays the database's part (returns the rows it would) and the SQL text is checked
 * for the rules the console's colours depend on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_USERS_SQL, createListUsersHandler } from '../src/routes/admin-users-list.js';

const noopLogger = { info() {}, warn() {}, error() {} };

function call(rowsFromDb, { fail = false } = {}) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (fail) throw new Error('db down');
    return { rows: rowsFromDb };
  };
  const handler = createListUsersHandler({ query, logger: noopLogger });
  return new Promise((resolve) => {
    const res = {
      code: 200,
      status(c) { this.code = c; return this; },
      json(body) { resolve({ code: this.code, body, calls }); return this; },
    };
    handler({}, res);
  });
}

const BASE = {
  name: 'Emily', role: 'user', api_key_prefix: 'om_3f8a1', must_change_password: false,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', deactivated_at: null,
};

describe('GET /users last-load fields', () => {
  it('passes the four fields through for a member who has loaded memories', async () => {
    const seeded = [{
      ...BASE, id: 1, email: 'emily@x',
      last_memory_load_at: '2026-10-23T01:12:00Z', last_machine: 'iMac.local',
      first_install_at: '2026-10-22T05:00:00Z', last_install_error_at: null,
    }];
    const out = await call(seeded);
    assert.equal(out.code, 200);
    assert.equal(out.body[0].last_memory_load_at, '2026-10-23T01:12:00Z');
    assert.equal(out.body[0].last_machine, 'iMac.local');
    assert.equal(out.body[0].first_install_at, '2026-10-22T05:00:00Z');
    assert.equal(out.body[0].last_install_error_at, null);
    // Fields the page already relied on are untouched.
    assert.equal(out.body[0].api_key_prefix, 'om_3f8a1');
    assert.equal(out.body[0].must_change_password, false);
  });

  it('gives a member with no rows four nulls, not missing keys and not 0', async () => {
    const seeded = [{
      ...BASE, id: 2, email: 'new@x',
      last_memory_load_at: null, last_machine: null, first_install_at: null, last_install_error_at: null,
    }];
    const out = await call(seeded);
    for (const k of ['last_memory_load_at', 'last_machine', 'first_install_at', 'last_install_error_at']) {
      assert.ok(k in out.body[0], `${k} must be present`);
      assert.equal(out.body[0][k], null);
    }
  });

  it('asks the database once for the whole team (no per-member loop)', async () => {
    const seeded = [1, 2, 3].map((id) => ({ ...BASE, id, email: `u${id}@x` }));
    const out = await call(seeded);
    assert.equal(out.calls.length, 1);
    assert.equal(out.body.length, 3);
    assert.deepEqual(out.calls[0].params ?? [], []);
  });

  it('answers 500 when the query fails', async () => {
    const out = await call([], { fail: true });
    assert.equal(out.code, 500);
  });
});

describe('LIST_USERS_SQL rules behind the column', () => {
  const sql = LIST_USERS_SQL.replace(/\s+/g, ' ');

  it('reads memory loads from hook-sourced init events only', () => {
    assert.match(sql, /FROM activity_logs/);
    assert.match(sql, /event = 'init'/);
    assert.match(sql, /source = 'hook'/);
  });

  it('joins per user with lateral subqueries in a single statement', () => {
    assert.ok((sql.match(/LEFT JOIN LATERAL/g) || []).length >= 2);
    assert.match(sql, /user_id = u\.id/);
  });

  it('counts both error_* reports and a post_install report with failures as install errors', () => {
    assert.match(sql, /LEFT\(c\.trigger_kind, 6\) = 'error_'/);
    assert.match(sql, /c\.trigger_kind = 'post_install'/);
    assert.match(sql, /c\.summary->'fail'/);
  });

  it('counts an install as finished only once its self-check has reported, not at the install_started beacon', () => {
    assert.match(sql, /MIN\(c\.ts\) FILTER \(WHERE c\.trigger_kind IN \('post_install', 'post_upgrade', 'manual'\)\)/);
    assert.doesNotMatch(sql, /MIN\(c\.ts\)(?! FILTER)/);
  });

  it('never shows a load later than now, and walks the indexes newest-first', () => {
    assert.match(sql, /LEAST\(a\.ts, NOW\(\)\)/);
    assert.match(sql, /ORDER BY a\.ts DESC LIMIT 1/);
    assert.match(sql, /c\.machine IS NOT NULL ORDER BY c\.ts DESC LIMIT 1/);
    assert.doesNotMatch(sql, /ARRAY_AGG/);
  });

  it('still never returns the password hash or the full key', () => {
    assert.doesNotMatch(sql, /password_hash/);
    assert.doesNotMatch(sql, /SELECT \*/);
    assert.match(sql, /LEFT\(u\.api_key, 8\) AS api_key_prefix/);
    assert.match(sql, /must_change_password/);
    assert.match(sql, /deactivated_at/);
  });
});
