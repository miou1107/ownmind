// v1.26.147 — issue #85 blocker: a team standard could only ever be changed by the account
// that created it.
//
// `PUT /api/memory/:id` opened with `WHERE id = $1 AND user_id = $2`, so a standard belonging
// to someone else answered 404 — before the admin-only check below it could run. That check
// ("Team standards and their details may only be edited by admins") was therefore unreachable
// for every row it was written for: it only ever gated a non-admin editing their own standard.
// Measured on production 2026-08-12: 6 user-invocable standards split across two accounts, so
// no single person could edit them all, and a standard whose creator leaves is frozen forever
// — it cannot even be disabled.
//
// Two layers of test, matching the convention in tests/memory-visibility.test.js:
//
//   - the decision itself is a unit under an injected query, so who-may-write is checkable
//     without Postgres;
//   - the wiring is asserted against the route source, because the handlers need a live DB.
//     A fake proves which parameters were bound, never that the SQL means what it says; the
//     predicate is verified against a live database before release.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWritableMemory, WRITE_ACCESS_COLUMNS } from '../src/utils/memory-write-access.js';
import { isAtLeast } from '../src/utils/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'memory.js'), 'utf8');

/** Collapse whitespace so assertions do not depend on SQL formatting. */
const flat = (sql) => sql.replace(/\s+/g, ' ').trim();

/**
 * Slice one route handler out of the source, ending at the next top-level `router.`
 * declaration rather than the first `});` — handlers contain nested calls that would
 * truncate the body early.
 */
const handlerBody = (marker) => {
  const start = ROUTE_SOURCE.indexOf(marker);
  assert.notEqual(start, -1, `handler not found: ${marker}`);
  const rest = ROUTE_SOURCE.slice(start + marker.length);
  const end = rest.indexOf('\nrouter.');
  return rest.slice(0, end === -1 ? rest.length : end);
};

/** A one-row table keyed by id, plus a log of every statement it was asked to run. */
function fakeDb(rows) {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    const wanted = String(params[0]);
    return { rows: rows.filter((r) => String(r.id) === wanted) };
  };
  return { queryFn, calls };
}

const standard = { id: 869, type: 'team_standard', user_id: 1, title: 'pages' };
const fragment = { id: 870, type: 'standard_detail', user_id: 4, title: 'pages §1' };
const privateRule = { id: 100, type: 'iron_rule', user_id: 4, title: 'no blind edit' };

const ADMIN = { id: 9, role: 'admin' };
const SUPER = { id: 9, role: 'super_admin' };
const MEMBER = { id: 9, role: 'user' };

describe('resolveWritableMemory — the owner', () => {
  it('may write to their own row, whatever its type', async () => {
    for (const row of [standard, fragment, privateRule]) {
      const { queryFn } = fakeDb([row]);
      const access = await resolveWritableMemory({
        id: row.id, user: { id: row.user_id, role: 'user' }, queryFn,
      });
      assert.equal(access.ok, true, `${row.type} owner was refused`);
      assert.equal(access.viaAdmin, false);
      assert.equal(access.memory.id, row.id);
    }
  });

  it('is matched across the string/number gap Postgres ids arrive in', async () => {
    // req.user.id is a number; a row id read back through some drivers is a string.
    const { queryFn } = fakeDb([{ ...standard, user_id: '1' }]);
    const access = await resolveWritableMemory({ id: 869, user: { id: 1, role: 'user' }, queryFn });
    assert.equal(access.ok, true);
    assert.equal(access.viaAdmin, false, 'the owner must not be reported as acting as an admin');
  });
});

describe('resolveWritableMemory — an admin on someone else’s row', () => {
  it('may write to a team standard', async () => {
    const { queryFn } = fakeDb([standard]);
    const access = await resolveWritableMemory({ id: 869, user: ADMIN, queryFn });
    assert.equal(access.ok, true);
    assert.equal(access.viaAdmin, true);
  });

  it('may write to a standard detail fragment', async () => {
    const { queryFn } = fakeDb([fragment]);
    const access = await resolveWritableMemory({ id: 870, user: ADMIN, queryFn });
    assert.equal(access.ok, true);
    assert.equal(access.viaAdmin, true);
  });

  it('may not touch a private type — being an admin is not being everyone', async () => {
    const { queryFn } = fakeDb([privateRule]);
    const access = await resolveWritableMemory({ id: 100, user: ADMIN, queryFn });
    assert.equal(access.ok, false);
    assert.equal(access.status, 404);
  });

  it('answers a private row the same way it answers a missing one', async () => {
    // Anything but 404 tells an admin that user 4 has a memory with this id.
    const { queryFn } = fakeDb([privateRule]);
    const present = await resolveWritableMemory({ id: 100, user: ADMIN, queryFn });
    const absent = await resolveWritableMemory({ id: 101, user: ADMIN, queryFn });
    assert.deepEqual(
      { status: present.status, error: present.error },
      { status: absent.status, error: absent.error },
    );
  });

  it('extends to super_admin, which outranks admin', async () => {
    const { queryFn } = fakeDb([standard]);
    const access = await resolveWritableMemory({ id: 869, user: SUPER, queryFn });
    assert.equal(access.ok, true);
    assert.equal(access.viaAdmin, true);
    assert.equal(isAtLeast('super_admin', 'admin'), true);
  });
});

describe('resolveWritableMemory — an ordinary member on someone else’s row', () => {
  it('may read a team standard but may not write to it', async () => {
    const { queryFn } = fakeDb([standard]);
    const access = await resolveWritableMemory({ id: 869, user: MEMBER, queryFn });
    assert.equal(access.ok, false);
    assert.equal(access.status, 404);
  });

  it('is refused a fragment too', async () => {
    const { queryFn } = fakeDb([fragment]);
    const access = await resolveWritableMemory({ id: 870, user: MEMBER, queryFn });
    assert.equal(access.ok, false);
  });

  it('is refused when the role is missing entirely', async () => {
    const { queryFn } = fakeDb([standard]);
    const access = await resolveWritableMemory({ id: 869, user: { id: 9 }, queryFn });
    assert.equal(access.ok, false);
  });
});

describe('resolveWritableMemory — the lookup', () => {
  it('looks the row up by id alone, or another account’s row is invisible to it', async () => {
    const { queryFn, calls } = fakeDb([standard]);
    await resolveWritableMemory({ id: 869, user: ADMIN, queryFn });
    assert.equal(calls.length, 1);
    assert.match(flat(calls[0].sql), /WHERE id = \$1$/);
    assert.doesNotMatch(flat(calls[0].sql).replace(/^SELECT.*?FROM/, 'SELECT FROM'), /user_id/);
    assert.deepEqual(calls[0].params, [869]);
  });

  it('selects every column the handlers read, and not the two that cost', () => {
    // Named columns rather than `*`, for the reason src/routes/memory.js:92 records: `*`
    // drags previous_content and the embedding into a lookup four routes did not use to run.
    // Dropping one of these from the list is a silent undefined at runtime, not an error.
    for (const column of ['id', 'user_id', 'type', 'title', 'content', 'tags', 'metadata', 'tier', 'status']) {
      assert.match(WRITE_ACCESS_COLUMNS, new RegExp(`\\b${column}\\b`), `${column} is read by a handler`);
    }
    assert.doesNotMatch(WRITE_ACCESS_COLUMNS, /previous_content|embedding|\*/);
  });

  it('reports a missing row as 404 without inspecting anything', async () => {
    const { queryFn } = fakeDb([]);
    const access = await resolveWritableMemory({ id: 12345, user: SUPER, queryFn });
    assert.equal(access.ok, false);
    assert.equal(access.status, 404);
    assert.equal(access.error, 'Memory not found');
  });
});

describe('the write handlers ask the helper instead of matching on user_id', () => {
  const handlers = [
    ["router.put('/:id', async", 'edit'],
    ["router.put('/:id/disable', async", 'disable'],
    ["router.put('/:id/enable', async", 'enable'],
    ["router.put('/:id/revert', async", 'revert'],
    ["router.get('/:id/history', async", 'history'],
  ];

  for (const [marker, name] of handlers) {
    it(`${name} resolves access through resolveWritableMemory`, () => {
      assert.match(handlerBody(marker), /resolveWritableMemory\(/);
    });

    it(`${name} no longer opens with an owner-only lookup`, () => {
      const body = flat(handlerBody(marker));
      assert.doesNotMatch(
        body,
        /SELECT [^;]*FROM memories WHERE id = \$1 AND user_id = \$2/,
        'the ownership match is what made an admin 404 before the admin check could run',
      );
    });
  }

  it('the write itself stays scoped to the row’s owner, not to the caller', () => {
    // The UPDATE must not re-apply `user_id = req.user.id`: that is the same 404 one
    // statement later, except silent — it writes nothing and returns no row.
    for (const [marker, name] of handlers.slice(0, 4)) {
      // Sliced to the end of the call, not to a fixed indentation: wrapping a handler in a
      // transaction would re-indent it and fail this on layout rather than on behaviour.
      const found = handlerBody(marker).match(/await query\(\s*`UPDATE memories[\s\S]*?RETURNING \*`,[\s\S]*?\n\s*\);/);
      assert.ok(found, `${name} has no UPDATE to check`);
      // Comments are stripped: one of them explains why req.user.id is not bound here, and
      // an assertion that reads prose cannot tell an explanation from the code it describes.
      const call = [found[0].replace(/^\s*\/\/.*$/gm, '')];
      assert.match(
        call[0],
        /(access\.memory|oldMemory)\.user_id/,
        `${name} must bind the owner's id to its UPDATE`,
      );
      assert.doesNotMatch(
        call[0],
        /req\.user\.id/,
        `${name} still scopes its write to the caller`,
      );
    }
  });
});

describe('the admin-only gate that was unreachable', () => {
  // Disable was admin-only while enable was not: a member could put back a standard an
  // admin had retired. Revert rewrites content, so it is an edit under another name.
  const gated = [
    ["router.put('/:id', async", 'edit'],
    ["router.put('/:id/disable', async", 'disable'],
    ["router.put('/:id/enable', async", 'enable'],
    ["router.put('/:id/revert', async", 'revert'],
  ];

  for (const [marker, name] of gated) {
    it(`${name} refuses a non-admin on a shared type`, () => {
      // The negation is part of the assertion: dropping the `!` inverts the gate — members
      // through, admins refused — and a pattern that only looked for isAtLeast would pass.
      assert.match(
        handlerBody(marker),
        /isSharedMemoryType\([\s\S]{0,40}?\) && !isAtLeast\(req\.user\.role, 'admin'\)/,
        `${name} must gate shared types on admin`,
      );
    });

    it(`${name} runs that gate before it writes`, () => {
      // This whole change exists because a check sat below the thing that made it
      // unreachable. A gate that runs after the UPDATE returns 403 on a write that landed.
      const body = handlerBody(marker);
      const gate = body.indexOf('!isAtLeast');
      const write = body.indexOf('UPDATE memories');
      assert.ok(gate !== -1 && write !== -1, `${name} is missing the gate or the write`);
      assert.ok(gate < write, `${name} gates the write after making it`);
    });
  }
});

describe('an admin write is recorded as one', () => {
  const verbs = [
    ["router.put('/:id', async", 'update'],
    ["router.put('/:id/disable', async", 'disable'],
    ["router.put('/:id/enable', async", 'enable'],
    ["router.put('/:id/revert', async", 'revert'],
  ];

  for (const [marker, action] of verbs) {
    it(`${action} records the admin write, and only when it is one`, () => {
      // `access.viaAdmin &&` is the assertion, not `admin_write` on its own: mutating the
      // guard to a constant — always stamping it, or never — leaves the literal in place.
      const body = handlerBody(marker);
      assert.match(
        body,
        /access\.viaAdmin[\s\S]{0,20}?\{[\s\S]{0,120}?admin_write:/,
        `${action} must condition the audit on the write being an admin's`,
      );
      assert.match(body, new RegExp(`admin_write: \\{ action: '${action}'`), `${action} must name its own action`);
      assert.match(
        body,
        /by_user_id: req\.user\.id, owner_user_id: (access\.memory|oldMemory)\.user_id/,
        `${action} must record who acted and whose row it was, not the same id twice`,
      );
    });
  }

  it('an inherited admin_write cannot ride into history', () => {
    // memories.metadata is written from the request body, so an owner can put an admin_write
    // of their choosing on their own row. An audit record the audited party can write is not
    // one. The update handler is the only path that spreads the row's metadata into history.
    const body = handlerBody("router.put('/:id', async");
    assert.match(body, /admin_write: _forgeableAdminWrite, \.\.\.inheritedMetadata/);
    assert.doesNotMatch(
      body,
      /const historyMetadata = \{\s*\.\.\.oldMemory\.metadata/,
      'history must not inherit the caller-written metadata wholesale',
    );
  });
});
