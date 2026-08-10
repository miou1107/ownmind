// A path segment that is not an id must read as "no such thing", not as a server failure.
//
// These drive the real server on a real Postgres, because the defect was never in the
// digit parsing — `tests/row-id.test.js` covers that, and it stayed green throughout. The
// defect was route registration order: `/:id` is declared after every literal path, so
// `/api/memory/stats` arrived as an id and went to an INT column, and the cast error came
// back as 500 "Query failed". Measured on production 2026-08-10.
//
// So the assertion that matters is about wiring, and only a request can make it. Delete
// the `router.param('id', …)` block and every one of these goes red while the unit tests
// stay green.

import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './harness.mjs';

const base = () => process.env.E2E_BASE_URL;
const KEY = `e2e-key-${ACCOUNTS.superAdmin.role}`;
const auth = { Authorization: `Bearer ${KEY}` };

/** Paths whose last segment cannot be an id, and why each one is worth naming. */
const NOT_IDS = [
  ['/api/memory/stats', 'a route that never existed — the shape that 500d in production'],
  ['/api/memory/recent', 'the second one found in the same sweep'],
  ['/api/memory/abc', 'a plain word'],
  ['/api/memory/abc/history', 'a nested route reached through the same parameter'],
  ['/api/memory/12abc', 'digits with something attached — parseInt would have read row 12'],
  ['/api/memory/0', 'ids start at 1'],
  ['/api/memory/2147483648', 'one past the INT ceiling of the column'],
];

test.describe('a path segment that is not an id', () => {
  for (const [path, why] of NOT_IDS) {
    test(`${path} answers 404, not 500 — ${why}`, async ({ request }) => {
      const res = await request.get(base() + path, { headers: auth });
      expect(res.status(), await res.text()).toBe(404);
    });
  }

  test('a well-formed id that is absent still answers 404, as it always did', async ({ request }) => {
    const res = await request.get(base() + '/api/memory/999999', { headers: auth });
    expect(res.status()).toBe(404);
  });

  test('a real id is still served — the guard must not swallow working requests', async ({ request }) => {
    // Create one rather than assuming a fixture id exists, so this cannot pass vacuously.
    const token = (await (await request.get(base() + '/api/memory/sync-token', { headers: auth })).json()).sync_token;
    const created = await request.post(base() + '/api/memory', {
      headers: auth,
      data: {
        type: 'project',
        title: '__upgrade_test__route-id-guard',
        content: 'created by the route-id spec',
        is_test: true,
        sync_token: token,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const id = (await created.json()).id;

    const got = await request.get(`${base()}/api/memory/${id}`, { headers: auth });
    expect(got.status()).toBe(200);
    expect((await got.json()).title).toBe('__upgrade_test__route-id-guard');

    await request.delete(base() + '/api/memory/test-cleanup?name_prefix=__upgrade_test__', { headers: auth });
  });

  test('the guard runs after auth, so it cannot be used to probe without a credential', async ({ request }) => {
    // If the parameter check ran first it would answer 404 to anonymous callers, turning a
    // 401 into a softer answer. Registration order alone does not decide this — auth is a
    // stack layer and param handling is not — so it is asserted rather than assumed.
    const res = await request.get(base() + '/api/memory/abc');
    expect(res.status()).toBe(401);
  });

  test('the handoff router has the same guard', async ({ request }) => {
    const res = await request.put(base() + '/api/handoff/abc/accept', {
      headers: auth,
      data: { accepted_by: 'route-id spec' },
    });
    expect(res.status(), await res.text()).toBe(404);
  });
});

test.describe('a body field that is an id', () => {
  test('revert with a history_id that is not an id answers 404, not 500', async ({ request }) => {
    // One layer in from the path parameter, and the same defect: `history_id` goes to an
    // INT column, so a word came back as 500 "Failed to restore memory".
    const token = (await (await request.get(base() + '/api/memory/sync-token', { headers: auth })).json()).sync_token;
    const created = await request.post(base() + '/api/memory', {
      headers: auth,
      data: {
        type: 'project',
        title: '__upgrade_test__revert-id-guard',
        content: 'v1',
        is_test: true,
        sync_token: token,
      },
    });
    const id = (await created.json()).id;

    for (const bad of ['abc', 99999999999, '12abc']) {
      const token2 = (await (await request.get(base() + '/api/memory/sync-token', { headers: auth })).json()).sync_token;
      const res = await request.put(`${base()}/api/memory/${id}/revert`, {
        headers: auth,
        data: { history_id: bad, sync_token: token2 },
      });
      expect(res.status(), `history_id=${bad}: ${await res.text()}`).toBe(404);
    }

    await request.delete(base() + '/api/memory/test-cleanup?name_prefix=__upgrade_test__', { headers: auth });
  });
});
