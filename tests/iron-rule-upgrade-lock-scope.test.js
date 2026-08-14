import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/app-server.js';
import { startRealDb } from './helpers/real-db.js';
import { shouldRetryForSyncToken } from '../mcp/lib/sync-token-retry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 5 fix round 2 (gate-message-i18n) — the two things `sync_token` was being asked to
 * mean, told apart.
 *
 * Round 1 made the account's locale part of `generateSyncToken`, which is exactly right for
 * the question the client cache asks ("has anything I cached changed?") — a locale write
 * touches `users.settings` and nothing in `memories`, so without it no machine ever learns
 * the preference changed. But `src/routes/admin-iron-rule-upgrade.js` was reusing that same
 * hash as an optimistic lock for a completely different question ("did iron-rule state move
 * under this editor?"). One hash, two semantics: a user switching their own language while
 * an upgrade edit was open got `409 Iron-rule state has changed` with no iron rule changed.
 *
 * Only a real database can settle this. The two tokens are built from SQL over two different
 * row sets, and the whole claim under test is that a write to one row set moves one token and
 * not the other — a fixture that hands each function a canned row proves the hashing, and
 * nothing at all about which rows each query actually reads.
 */

const VALID_RULE_CONTENT =
  '什麼時候適用：要修改任何檔案之前。\n'
  + '規則：必須先讀完整個檔案再動手，禁止只讀片段就編輯。\n'
  + '理由：只讀片段會漏掉呼叫端，改完才發現壞掉。';

const UPGRADED_RULE_CONTENT =
  '觸發情境：要修改任何檔案之前，以及送出前的自我檢查。\n'
  + '規則：必須先讀完整個檔案再動手，禁止只讀片段就編輯，改完必須跑一次測試。\n'
  + '理由：只讀片段會漏掉呼叫端，改完才發現壞掉。';

test('sync_token scopes: a locale write moves the cache token and leaves the iron-rule lock alone', async (t) => {
  const db = await startRealDb();
  if (!db) {
    t.skip('docker is not available on this machine, so the database seam was NOT exercised');
    return;
  }

  let server;
  let pool;
  try {
    const skipped = db.applyMigrations(path.join(repoRoot, 'db'));
    const missingCore = skipped.some((s) => /^00[125]_/.test(s));
    assert.equal(missingCore, false, `core migrations failed to apply: ${skipped.join('; ')}`);

    // Read at module load by the pool in src/utils/db.js, so they have to be set before the
    // first import of anything that pulls it in.
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = String(db.port);
    process.env.DB_NAME = 'ownmind';
    process.env.DB_USER = 'ownmind';
    process.env.DB_PASSWORD = 'test';

    const memoryRoutes = (await import('../src/routes/memory.js')).default;
    const ironRuleUpgradeRoutes = (await import('../src/routes/admin-iron-rule-upgrade.js')).default;
    pool = (await import('../src/utils/db.js')).default ?? null;

    const app = express();
    app.use(express.json());
    // Both routers behind their real auth middleware, mounted where app.js mounts them, so
    // the request path under test is the production one.
    app.use('/api/memory', memoryRoutes);
    app.use('/api/admin/iron-rules', ironRuleUpgradeRoutes);

    server = await startServer(app);

    db.psql(`
      INSERT INTO users (id, email, name, api_key, role, settings) VALUES
        (1, 'iru-admin@example.com', 'IRU Admin', 'key-iru-admin', 'admin', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
      SELECT setval(pg_get_serial_sequence('users','id'), 10);

      INSERT INTO memories (user_id, type, title, content, tags, status) VALUES
        (1, 'iron_rule', '改檔案之前要先讀完整個檔案',
         ${quote(VALID_RULE_CONTENT)}, ARRAY['trigger:edit'], 'active'),
        (1, 'iron_rule', '部署之前要先問過再動手',
         ${quote(VALID_RULE_CONTENT)}, ARRAY['trigger:deploy'], 'active'),
        (1, 'project', '一個跟鐵律無關的專案記憶',
         '這條記憶存在只為了證明它的變動不會影響鐵律編輯鎖。', ARRAY['x'], 'active');
    `);

    const auth = { Authorization: 'Bearer key-iru-admin' };
    const jsonHeaders = { ...auth, 'content-type': 'application/json' };

    const upgradeStatus = async () => {
      const res = await fetch(`${server.url}/api/admin/iron-rules/upgrade-status`, { headers: auth });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const putUpgrade = async (ruleId, content, syncToken) => {
      const res = await fetch(`${server.url}/api/admin/iron-rules/${ruleId}/upgrade`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ content, sync_token: syncToken }),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const putLocale = async (locale) => {
      const res = await fetch(`${server.url}/api/memory/locale`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ locale }),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const cacheToken = async () => {
      const res = await fetch(`${server.url}/api/memory/sync-token`, { headers: auth });
      return (await res.json()).sync_token;
    };
    const initToken = async () => {
      const res = await fetch(`${server.url}/api/memory/init?compact=true`, { headers: auth });
      return (await res.json()).sync_token;
    };

    // --- 0. The editor takes its snapshot: the rule list plus the token it must echo back. ---
    const opened = await upgradeStatus();
    assert.equal(opened.status, 200, `expected 200, got ${opened.status}: ${JSON.stringify(opened.json)}`);
    assert.equal(opened.json.rules.length, 2, 'fixture should expose exactly the two iron rules');
    const ruleId = opened.json.rules.find((r) => r.title.startsWith('改檔案')).id;
    const editorToken = opened.json.sync_token;
    assert.match(editorToken, /^[0-9a-f]{12}$/);

    // --- 1. The regression this branch fixed, still pinned: a locale write MUST move the
    //     cache-freshness token, on both endpoints that serve it. `GET /sync-token` is what
    //     hooks/lib/conditional-sync.js polls; `GET /init` is what it writes into the cache
    //     file it later compares. If the two ever disagreed, every session would either
    //     re-init forever or never notice a change at all. ---
    const cacheBefore = await cacheToken();
    const initBefore = await initToken();
    assert.equal(initBefore, cacheBefore, 'GET /init and GET /sync-token must serve the same token');

    const localeWrite = await putLocale('ja');
    assert.equal(localeWrite.status, 200, `locale write failed: ${JSON.stringify(localeWrite.json)}`);

    const cacheAfter = await cacheToken();
    const initAfter = await initToken();
    assert.notEqual(cacheAfter, cacheBefore,
      'a locale write must move GET /sync-token, or no machine ever re-inits and the preference stays invisible');
    assert.notEqual(initAfter, initBefore,
      'a locale write must move the token embedded in GET /init too');
    assert.equal(initAfter, cacheAfter, 'the two endpoints must still agree after the write');

    // --- 2. The defect: that same locale write must NOT invalidate the in-flight edit. The
    //     editor is still holding the token from step 0, and nothing about any iron rule has
    //     changed, so the upgrade has to go through. Before the split this returned 409
    //     "Iron-rule state has changed (sync_token mismatch)". ---
    const inFlight = await putUpgrade(ruleId, UPGRADED_RULE_CONTENT, editorToken);
    assert.equal(inFlight.status, 200,
      `changing the account language must not break an open iron-rule edit; got ${inFlight.status}: ${JSON.stringify(inFlight.json)}`);
    assert.equal(inFlight.json.ok, true);
    assert.match(inFlight.json.sync_token, /^[0-9a-f]{12}$/, 'the response hands the editor a fresh lock token');
    assert.notEqual(inFlight.json.sync_token, editorToken,
      'the edit itself changed iron-rule state, so the refreshed lock token must differ');

    // --- 3. The lock still locks: a genuine iron-rule change under the editor is caught. A
    //     background write (what ownmind_save does while the modal sits open) bumps the rule's
    //     updated_at; the editor's now-stale token must be refused, not silently allowed to
    //     overwrite previous_content with the older snapshot. ---
    const staleEditorToken = inFlight.json.sync_token;
    db.psql(`UPDATE memories SET content = content || '\n(背景寫入)', updated_at = NOW() + interval '1 second'
             WHERE id = ${ruleId};`);

    const raced = await putUpgrade(ruleId, VALID_RULE_CONTENT, staleEditorToken);
    assert.equal(raced.status, 409,
      `a real iron-rule change under the editor must still 409; got ${raced.status}: ${JSON.stringify(raced.json)}`);
    assert.match(raced.json.new_token, /^[0-9a-f]{12}$/, '409 must hand back a usable fresh token');
    assert.notEqual(raced.json.new_token, staleEditorToken);

    // This 409 must not look like a stale *cache* token to the MCP client's generic write
    // retry, which recovers by fetching GET /api/memory/sync-token — a value that since the
    // split can never satisfy this lock, so the retry would fail every time. Nothing routes
    // admin calls through that wrapper today; asserted against the real response body so the
    // wording cannot drift back into the trap.
    assert.equal(
      shouldRetryForSyncToken({
        method: 'PUT', status: raced.status, errorMessage: raced.json.error, body: raced.json,
      }),
      false,
      'the iron-rule lock 409 must not be mistaken for a cache-token 409',
    );

    // Recovering with the token the 409 handed back must work first try.
    const retried = await putUpgrade(ruleId, UPGRADED_RULE_CONTENT, raced.json.new_token);
    assert.equal(retried.status, 200,
      `the 409's new_token must be immediately usable; got ${retried.status}: ${JSON.stringify(retried.json)}`);

    // --- 4. Scope, stated positively: the lock covers exactly the rows the snapshot showed.
    //     A write to an unrelated memory type cannot change any iron rule, so it must not
    //     evict the editor either — the same class of false 409 as the locale one. ---
    const freshToken = retried.json.sync_token;
    db.psql(`UPDATE memories SET content = content || '無關的修改', updated_at = NOW() + interval '2 seconds'
             WHERE user_id = 1 AND type = 'project';`);

    const unrelated = await putUpgrade(ruleId, VALID_RULE_CONTENT, freshToken);
    assert.equal(unrelated.status, 200,
      `an unrelated memory write must not evict the iron-rule editor; got ${unrelated.status}: ${JSON.stringify(unrelated.json)}`);

    // --- 5. COUNT(*) earns its place. Disabling a rule that is NOT the most recently touched
    //     one, by raw SQL that deliberately leaves updated_at alone, changes the list the
    //     editor is holding while MAX(updated_at) stays exactly where it was. Asserted here
    //     rather than assumed: the MAX either side of the disable is compared, so this case
    //     can only pass because of the count. Drop COUNT(*) from the lock query and this is
    //     the assertion that goes red. ---
    const activeMax = () => db.psql(
      `SELECT COALESCE(MAX(updated_at)::text, '') FROM memories
       WHERE user_id = 1 AND type = 'iron_rule' AND status = 'active';`,
    ).trim();

    const tokenBeforeDisable = unrelated.json.sync_token;
    const maxBeforeDisable = activeMax();
    db.psql(`UPDATE memories SET status = 'disabled'
             WHERE user_id = 1 AND type = 'iron_rule' AND title LIKE '部署%';`);
    assert.equal(activeMax(), maxBeforeDisable,
      'fixture precondition: the disabled rule must not be the MAX, or this proves nothing about COUNT');

    const afterDisable = await putUpgrade(ruleId, VALID_RULE_CONTENT, tokenBeforeDisable);
    assert.equal(afterDisable.status, 409,
      `a rule leaving the active set must invalidate the snapshot even with MAX unmoved; got ${afterDisable.status}`);

    // Put it back so the closing assertions run against the list the earlier steps built.
    db.psql(`UPDATE memories SET status = 'active'
             WHERE user_id = 1 AND type = 'iron_rule' AND title LIKE '部署%';`);

    // --- 6. And the write really happened — the 200s above are not a lock that stopped
    //     checking anything. ---
    const stored = db.psql(`SELECT content FROM memories WHERE id = ${ruleId};`);
    assert.ok(stored.includes('什麼時候適用'),
      'the content the last accepted upgrade sent must be the content now stored');
    assert.ok(!stored.includes('背景寫入'),
      'the background write was superseded by an accepted upgrade, so it must not survive');
    const backup = db.psql(`SELECT previous_content IS NOT NULL FROM memories WHERE id = ${ruleId};`).trim();
    assert.equal(backup, 't', 'previous_content must still be backed up on every accepted upgrade');
  } finally {
    if (server) await server.close();
    if (pool?.end) await pool.end().catch(() => {});
    db.stop();
  }
});

/** Single-quote a literal for psql, doubling any embedded quote. */
function quote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}
