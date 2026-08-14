import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/app-server.js';
import { startRealDb } from './helpers/real-db.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `PUT /api/admin/iron-rules/:id/upgrade` used to read two columns its own SELECT never
 * asked for.
 *
 * The handler fetched `id, type, title, content, tags` and then read `oldRule.metadata` and
 * `oldRule.code`. Both were `undefined` on every request, and neither read failed loudly:
 *
 *   - the write path. `updatedMetadata` started as `oldRule.metadata || null`, so an upgrade
 *     carrying `origin_event` built `{ origin_context }` from an empty base and the UPDATE's
 *     `metadata = COALESCE($5, metadata)` wrote that object over the whole jsonb column. The
 *     casualty is `metadata.stats` — the enforced/missed/triggered counters that
 *     `src/routes/memory.js` accumulates for every iron rule — plus anything else stored
 *     there. Silent, irreversible, and invisible until someone looked at the counters.
 *
 *   - the lint path. v1.18.3 deliberately fed metadata into `lintIronRule` so
 *     `checkOriginContext` could see an origin_context that was already recorded. With
 *     `undefined` arriving instead, every upgrade of every rule was told to "consider adding
 *     metadata.origin_context" — including rules that had one.
 *
 *   - the audit trail. `writeAuditLog(... { code: oldRule.code ... })` recorded the rule's
 *     code as absent on every upgrade since v1.26.60.
 *
 * `POST /:id/suggest-skill-md` one handler above selected no metadata either, and
 * `suggestSkillMdFormat` round-trips its proposal through the same lint — so it is covered
 * here too, or the two endpoints of one router would disagree about the same rule.
 *
 * Section 6 guards a risk the fix itself introduces rather than one it inherited: patching the
 * column with `jsonb_set` means a metadata that is not a jsonb object now reaches an operator
 * that rejects one. Both non-object shapes are seeded and both must still take the write.
 *
 * Only a real database can settle this. The whole defect is the gap between the columns the
 * SQL selects and the properties the JavaScript reads — a fixture that hands the handler a
 * canned row simply defines that gap away, and would have passed against the broken code.
 */

const VALID_RULE_CONTENT =
  '什麼時候適用：要修改任何檔案之前。\n'
  + '規則：必須先讀完整個檔案再動手，禁止只讀片段就編輯。\n'
  + '理由：只讀片段會漏掉呼叫端，改完才發現壞掉。';

const UPGRADED_RULE_CONTENT =
  '觸發情境：要修改任何檔案之前，以及送出前的自我檢查。\n'
  + '規則：必須先讀完整個檔案再動手，禁止只讀片段就編輯，改完必須跑一次測試。\n'
  + '理由：只讀片段會漏掉呼叫端，改完才發現壞掉。';

/** The counters `src/routes/memory.js` merges into metadata.stats, seeded as already earned. */
const SEEDED_STATS = { enforced: 7, missed: 2, triggered: 9 };

/** A valid origin_context, so the lint assertions below distinguish "seen" from "not seen". */
const SEEDED_ORIGIN_CONTEXT = {
  captured_at: '2026-08-01T09:30:00.000Z',
  confidence: 'user_direct',
  event: '2026-08-01 因為只讀片段就改檔案，漏掉呼叫端',
};

const NAG = 'Consider adding metadata.origin_context';

test('PUT /:id/upgrade preserves the rest of metadata and audits the real rule code', async (t) => {
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

    const ironRuleUpgradeRoutes = (await import('../src/routes/admin-iron-rule-upgrade.js')).default;
    pool = (await import('../src/utils/db.js')).default ?? null;

    const app = express();
    app.use(express.json());
    // Behind its real adminAuth middleware, mounted where app.js mounts it, so the request
    // path under test is the production one.
    app.use('/api/admin/iron-rules', ironRuleUpgradeRoutes);

    server = await startServer(app);

    db.psql(`
      INSERT INTO users (id, email, name, api_key, role, settings) VALUES
        (1, 'iru-meta@example.com', 'IRU Admin', 'key-iru-meta', 'admin', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
      SELECT setval(pg_get_serial_sequence('users','id'), 10);

      INSERT INTO memories (user_id, type, code, title, content, tags, status, metadata) VALUES
        (1, 'iron_rule', 'IR-901', '改檔案之前要先讀完整個檔案',
         ${quote(VALID_RULE_CONTENT)}, ARRAY['trigger:edit'], 'active',
         ${quote(JSON.stringify({ stats: SEEDED_STATS, tier: 'critical' }))}::jsonb),
        (1, 'iron_rule', 'IR-902', '部署之前要先問過再動手',
         ${quote(VALID_RULE_CONTENT)}, ARRAY['trigger:deploy'], 'active',
         ${quote(JSON.stringify({ stats: SEEDED_STATS, origin_context: SEEDED_ORIGIN_CONTEXT }))}::jsonb),
        -- No origin_context, so it is the positive control for the suggest-endpoint nag.
        (1, 'iron_rule', 'IR-903', '跑測試之前要先把服務起起來',
         ${quote(VALID_RULE_CONTENT)}, ARRAY['trigger:test'], 'active', '{}'::jsonb),
        -- The two metadata shapes that are not objects; they fail differently, and section 6
        -- says which is which.
        (1, 'iron_rule', 'IR-904', '寫死的路徑要換成設定檔',
         ${quote(VALID_RULE_CONTENT)}, ARRAY['trigger:edit'], 'active', NULL),
        (1, 'iron_rule', 'IR-905', '刪檔案之前要先看一眼裡面是什麼',
         ${quote(VALID_RULE_CONTENT)}, ARRAY['trigger:edit'], 'active', '7'::jsonb);
    `);

    const auth = { Authorization: 'Bearer key-iru-meta' };
    const jsonHeaders = { ...auth, 'content-type': 'application/json' };

    const upgradeStatus = async () => {
      const res = await fetch(`${server.url}/api/admin/iron-rules/upgrade-status`, { headers: auth });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const putUpgrade = async (ruleId, body) => {
      const res = await fetch(`${server.url}/api/admin/iron-rules/${ruleId}/upgrade`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const metadataOf = (code) => {
      const raw = db.psql(
        `SELECT metadata FROM memories WHERE user_id = 1 AND code = ${quote(code)};`,
      ).trim();
      // psql prints SQL NULL as the empty string, and JSON.parse('') throws
      // `Unexpected end of JSON input` — naming neither the rule nor the fact that the
      // column is null. Two of the regressions this file guards land exactly there.
      if (!raw) throw new Error(`${code}: metadata is SQL NULL`);
      return JSON.parse(raw);
    };

    const opened = await upgradeStatus();
    assert.equal(opened.status, 200, `expected 200, got ${opened.status}: ${JSON.stringify(opened.json)}`);
    const idOf = (code) => opened.json.rules.find((r) => r.code === code).id;

    // --- 1. The data loss. An upgrade carrying origin_event has to add one key, not become
    //     the whole column. `stats` is the one that matters — nothing recomputes those
    //     counters, so an overwrite is permanent — and `tier` is here to show the damage was
    //     never limited to the key this test happens to name. ---
    const withOrigin = await putUpgrade(idOf('IR-901'), {
      content: UPGRADED_RULE_CONTENT,
      sync_token: opened.json.sync_token,
      origin_event: '2026-08-14 上線前沒讀完檔案就改，漏掉呼叫端',
      user_quote: '你先讀完整個檔案再動手',
    });
    assert.equal(withOrigin.status, 200,
      `upgrade failed: ${withOrigin.status} ${JSON.stringify(withOrigin.json)}`);

    const afterOrigin = metadataOf('IR-901');
    assert.deepEqual(afterOrigin.stats, SEEDED_STATS,
      'metadata.stats must survive an upgrade — nothing recomputes those counters, so losing them is permanent');
    assert.equal(afterOrigin.tier, 'critical',
      'every other metadata key must survive too; the defect replaced the whole jsonb column');
    assert.equal(afterOrigin.origin_context.event, '2026-08-14 上線前沒讀完檔案就改，漏掉呼叫端',
      'the supplied origin_event must still be written — preserving the rest cannot mean writing nothing');
    assert.equal(afterOrigin.origin_context.user_quote, '你先讀完整個檔案再動手');
    assert.equal(afterOrigin.origin_context.confidence, 'user_direct');

    // --- 2. The audit trail. Before the fix this row recorded the code as absent, on every
    //     upgrade, which is precisely the field that makes the trace worth keeping. ---
    const auditCode = db.psql(
      `SELECT details->>'code' FROM audit_logs
       WHERE action = 'iron_rule_upgrade' AND target_id = ${idOf('IR-901')}
       ORDER BY id DESC LIMIT 1;`,
    ).trim();
    assert.equal(auditCode, 'IR-901',
      'the audit row must carry the rule code, not the undefined the handler used to read');

    // --- 3. The lint path. IR-902 already records a valid origin_context, so v1.18.3's
    //     whole point is that it is not nagged about adding one. That warning can only be
    //     absent if the stored metadata actually reached lintIronRule. ---
    const reopened = await upgradeStatus();
    const noOrigin = await putUpgrade(idOf('IR-902'), {
      content: UPGRADED_RULE_CONTENT,
      sync_token: reopened.json.sync_token,
    });
    assert.equal(noOrigin.status, 200,
      `upgrade failed: ${noOrigin.status} ${JSON.stringify(noOrigin.json)}`);
    assert.equal(
      (noOrigin.json.lint_warnings || []).some((w) => w.includes(NAG)),
      false,
      `a rule that already records an origin_context must not be told to add one; got ${JSON.stringify(noOrigin.json.lint_warnings)}`,
    );

    // ...and an upgrade that supplies no origin_event must leave metadata exactly as it was.
    assert.deepEqual(metadataOf('IR-902'), { stats: SEEDED_STATS, origin_context: SEEDED_ORIGIN_CONTEXT },
      'an upgrade with no origin_event has no business touching metadata at all');

    // --- 4. The nag is still raised when it should be, so assertion 3 is measuring the
    //     stored metadata and not a warning that has quietly stopped existing. IR-901's
    //     origin_context was only written in step 1, so its own lint ran without one. ---
    assert.equal(
      (withOrigin.json.lint_warnings || []).some((w) => w.includes(NAG)),
      true,
      'a rule with no stored origin_context must still be nagged, or step 3 proves nothing',
    );

    // --- 5. The sibling endpoint agrees about the same rule. POST /:id/suggest-skill-md
    //     round-trips its own proposal through the same lint, and it too selected no
    //     metadata — so without this it would keep telling IR-902 to add the origin_context
    //     the PUT above just stopped nagging about, from the same router, about the same
    //     rule. IR-903 records none, and is here so the assertion is about the metadata and
    //     not about a note that quietly stopped being emitted. ---
    const suggest = async (ruleId) => {
      const res = await fetch(`${server.url}/api/admin/iron-rules/${ruleId}/suggest-skill-md`, {
        method: 'POST', headers: jsonHeaders, body: '{}',
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    const suggestWithOrigin = await suggest(idOf('IR-902'));
    assert.equal(suggestWithOrigin.status, 200,
      `suggest failed: ${suggestWithOrigin.status} ${JSON.stringify(suggestWithOrigin.json)}`);
    // suggestSkillMdFormat returns early for a rule that is already SKILL.md, and that early
    // return emits no notes at all — so the absent-nag assertion below would pass without the
    // lint ever running. Pinned rather than assumed, because the constant this rule's content
    // comes from is a plausible thing to convert to SKILL.md one day.
    assert.equal(suggestWithOrigin.json.already_skill_md, false,
      'the fixture must still reach the lint, or the next assertion is vacuous');
    assert.equal(
      suggestWithOrigin.json.notes.some((n) => n.includes(NAG)), false,
      `suggest must not nag a rule that already records an origin_context; got ${JSON.stringify(suggestWithOrigin.json.notes)}`,
    );

    const suggestWithout = await suggest(idOf('IR-903'));
    assert.equal(
      suggestWithout.json.notes.some((n) => n.includes(NAG)), true,
      'a rule with no origin_context must still be nagged by suggest, or the assertion above proves nothing',
    );

    // --- 6. The two metadata shapes that are not objects. COALESCE covers a SQL NULL column
    //     but not a jsonb scalar, and jsonb_set on a scalar raises `cannot set path in
    //     scalar` — a 500 where the old code silently replaced the value. Both must land the
    //     origin_context instead. ---
    for (const code of ['IR-904', 'IR-905']) {
      const token = (await upgradeStatus()).json.sync_token;
      const res = await putUpgrade(idOf(code), {
        content: UPGRADED_RULE_CONTENT,
        sync_token: token,
        origin_event: `2026-08-14 ${code} 的 metadata 不是物件`,
      });
      assert.equal(res.status, 200,
        `${code} has a non-object metadata and must still upgrade; got ${res.status}: ${JSON.stringify(res.json)}`);
      assert.deepEqual(Object.keys(metadataOf(code)), ['origin_context'],
        `${code} must end up with exactly the origin_context this upgrade wrote`);
      assert.equal(metadataOf(code).origin_context.event, `2026-08-14 ${code} 的 metadata 不是物件`);
    }

    // --- 7. And the upgrade itself still did its job. ---
    const stored = db.psql(`SELECT content FROM memories WHERE user_id = 1 AND code = 'IR-901';`);
    assert.ok(stored.includes('觸發情境'), 'the upgraded content must be the content now stored');
    assert.ok(stored.includes('## 起源'), 'origin_event must still inject the rendered 起源 section');
    const backup = db.psql(
      `SELECT previous_content IS NOT NULL FROM memories WHERE user_id = 1 AND code = 'IR-901';`,
    ).trim();
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
