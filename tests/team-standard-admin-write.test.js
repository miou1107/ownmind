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

import { resolveWritableMemory } from '../src/utils/memory-write-access.js';
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
    assert.doesNotMatch(flat(calls[0].sql), /user_id/);
    assert.deepEqual(calls[0].params, [869]);
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
      const found = handlerBody(marker).match(/await query\(\s*`UPDATE memories[\s\S]*?^ {4}\);/m);
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
  it('still refuses a non-admin editing a team standard they own', () => {
    assert.match(
      handlerBody("router.put('/:id', async"),
      /isSharedMemoryType\([\s\S]*?\) && !isAtLeast\(req\.user\.role, 'admin'\)/,
    );
  });

  it('now covers enable and revert, which never had it', () => {
    // Disable was admin-only while enable was not: a member could put back a standard an
    // admin had retired. Revert rewrites content, so it is an edit under another name.
    for (const marker of ["router.put('/:id/enable', async", "router.put('/:id/revert', async"]) {
      assert.match(
        handlerBody(marker),
        /isSharedMemoryType\([\s\S]*?\) && !isAtLeast\(req\.user\.role, 'admin'\)/,
        `${marker} must gate shared types on admin`,
      );
    }
  });
});

describe('an admin write is recorded as one', () => {
  it('edit and revert name the acting admin in history metadata', () => {
    for (const marker of ["router.put('/:id', async", "router.put('/:id/revert', async"]) {
      assert.match(handlerBody(marker), /admin_write/, `${marker} must audit the admin write`);
    }
  });

  it('disable and enable do too — retiring someone else’s standard is the loudest case', () => {
    for (const marker of ["router.put('/:id/disable', async", "router.put('/:id/enable', async"]) {
      assert.match(handlerBody(marker), /admin_write/, `${marker} must audit the admin write`);
    }
  });
});
