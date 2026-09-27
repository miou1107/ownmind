import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/app-server.js';
import { startRealDb } from './helpers/real-db.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Issue #139, the server half: an iron rule records the skills it tells the AI to use in
 * `metadata.required_skills`, and `GET /init` sends them so each machine can say which it
 * lacks (tests/missing-skills.test.js covers the machine).
 *
 * Against a real database, because the parts that can go wrong are SQL: the background
 * backfill's jsonb merge, its guard against overwriting a list written in between, a row whose
 * metadata is not an object, and `updated_at` staying put. A fixture handing the route canned
 * rows would agree with whatever the route asked for.
 */

/** Passes the iron-rule quality check, names two skills, and says "技能" so they are read. */
const SKILL_RULE =
  '什麼時候適用：要寫任何給人讀的中文之前。\n'
  + '規則：必須先用技能 `zh-tw-doc-copy` 起稿，寫完之後再叫 `humanizer-tw` 檢查，禁止直接寫。\n'
  + '理由：直接寫出來的中文太像翻譯稿，讀的人會看不懂。';

const PLAIN_RULE =
  '什麼時候適用：要修改任何檔案之前。\n'
  + '規則：必須先讀完整個檔案再動手，禁止只讀片段就編輯，改完跑 `npm test`。\n'
  + '理由：只讀片段會漏掉呼叫端，改完才發現壞掉。';

function quote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

test('iron rules carry the skills they need, and init sends them', async (t) => {
  const db = await startRealDb();
  if (!db) {
    t.skip('docker is not available on this machine, so the database seam was NOT exercised');
    return;
  }

  let server;
  let pool;
  try {
    const skipped = db.applyMigrations(path.join(repoRoot, 'db'));
    assert.equal(skipped.some((s) => /^00[125]_/.test(s)), false,
      `core migrations failed to apply: ${skipped.join('; ')}`);

    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = String(db.port);
    process.env.DB_NAME = 'ownmind';
    process.env.DB_USER = 'ownmind';
    process.env.DB_PASSWORD = 'test';

    const memoryRoutes = (await import('../src/routes/memory.js')).default;
    pool = (await import('../src/utils/db.js')).default ?? null;

    const app = express();
    app.use(express.json());
    app.use('/api/memory', memoryRoutes);
    server = await startServer(app);

    // Three rules saved before the field existed: one naming skills, one naming none, and one
    // whose metadata is a bare number — the shape `||` would turn into an array.
    db.psql(`
      INSERT INTO users (id, email, name, api_key, role, settings) VALUES
        (1, 'skills@example.com', 'Skills', 'key-skills', 'user', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
      SELECT setval(pg_get_serial_sequence('users','id'), 10);

      INSERT INTO memories (user_id, type, code, title, content, tags, status, metadata, updated_at) VALUES
        (1, 'iron_rule', 'IR-801', '寫中文前後要過兩道工具', ${quote(SKILL_RULE)},
         ARRAY['trigger:write'], 'active', '{"stats":{"enforced":3}}'::jsonb, '2026-01-01T00:00:00Z'),
        (1, 'iron_rule', 'IR-802', '改檔案之前要先讀完整個檔案', ${quote(PLAIN_RULE)},
         ARRAY['trigger:edit'], 'active', NULL, '2026-01-01T00:00:00Z'),
        (1, 'iron_rule', 'IR-803', '寫中文前後要過兩道工具（壞資料）', ${quote(SKILL_RULE)},
         ARRAY['trigger:write'], 'active', '7'::jsonb, '2026-01-01T00:00:00Z');
    `);

    const headers = { Authorization: 'Bearer key-skills', 'content-type': 'application/json' };
    // Writes must carry the current sync_token, as the MCP tools do: taken from init, then
    // from each write's answer, since every write moves it.
    let syncToken = null;
    const call = async (method, url, body) => {
      const payload = body && { ...body, sync_token: syncToken };
      const res = await fetch(`${server.url}${url}`, { method, headers, body: payload && JSON.stringify(payload) });
      const json = await res.json().catch(() => null);
      if (json && typeof json.sync_token === 'string') syncToken = json.sync_token;
      return { status: res.status, json };
    };
    const metadataOf = (code) => db.psql(`SELECT metadata::text FROM memories WHERE code = '${code}' AND user_id = 1`).trim();
    const skillsInInit = async () => {
      const { status, json } = await call('GET', '/api/memory/init?compact=true');
      assert.equal(status, 200, JSON.stringify(json));
      return json.iron_rule_skills;
    };

    // ── 1. A rule saved before the field existed is read from its text ──────────────
    const first = await skillsInInit();
    assert.deepEqual(
      first.find((r) => r.code === 'IR-801'),
      { code: 'IR-801', title: '寫中文前後要過兩道工具', skills: ['zh-tw-doc-copy', 'humanizer-tw'] },
    );
    assert.equal(first.some((r) => r.code === 'IR-802'), false, 'a rule naming no skill is not sent');
    assert.ok(first.some((r) => r.code === 'IR-803'), 'malformed metadata still gets checked from the text');

    // ── 2. …and the guess is written back, without touching the rest ────────────────
    // Wait for both rows the backfill writes: they share a created_at, so which lands first
    // is not fixed, and reading one as soon as the other is done would race it.
    const filled = (code) => Array.isArray(JSON.parse(metadataOf(code) || 'null')?.required_skills);
    for (let i = 0; i < 50 && !(filled('IR-801') && filled('IR-802')); i += 1) {
      await new Promise((r) => { setTimeout(r, 100); });
    }
    assert.ok(filled('IR-801') && filled('IR-802'), 'the background backfill never wrote required_skills');
    const backfilled = JSON.parse(metadataOf('IR-801'));
    assert.deepEqual(backfilled.required_skills, ['zh-tw-doc-copy', 'humanizer-tw']);
    assert.equal(backfilled.required_skills_source, 'auto');
    assert.deepEqual(backfilled.stats, { enforced: 3 }, 'the backfill replaced metadata instead of merging');
    assert.deepEqual(JSON.parse(metadataOf('IR-802')).required_skills, [], 'NULL metadata gets the empty answer');
    assert.equal(metadataOf('IR-803'), '7', 'a scalar metadata was rewritten');
    assert.match(
      db.psql("SELECT updated_at::text FROM memories WHERE code = 'IR-801' AND user_id = 1"),
      /^2026-01-01/, 'the backfill made an unedited rule look edited',
    );

    // ── 3. A new rule gets the guess, and the author is told ─────────────────────────
    const created = await call('POST', '/api/memory', {
      type: 'iron_rule', title: '寫中文前後要過兩道工具（新）', content: SKILL_RULE, tags: ['trigger:write'],
      metadata: { tool: 'test' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.deepEqual(created.json.metadata.required_skills, ['zh-tw-doc-copy', 'humanizer-tw']);
    assert.equal(created.json.metadata.required_skills_source, 'auto');
    assert.equal(created.json.metadata.tool, 'test', 'the caller\'s metadata was dropped');
    assert.match(created.json.required_skills_note, /zh-tw-doc-copy, humanizer-tw/);
    const id = created.json.id;

    // ── 4. A bad list is refused, and nothing is written ────────────────────────────
    const before = db.psql('SELECT count(*) FROM memories').trim();
    const refused = await call('POST', '/api/memory', {
      type: 'iron_rule', title: '不會存進去的規矩', content: SKILL_RULE, tags: ['trigger:write'],
      metadata: { required_skills: ['Not A Skill'] },
    });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /required_skills/);
    assert.equal(db.psql('SELECT count(*) FROM memories').trim(), before);

    // ── 5. A person's correction sticks ─────────────────────────────────────────────
    const corrected = await call('PUT', `/api/memory/${id}`, {
      metadata: { tool: 'test', required_skills: ['zh-tw-doc-copy'] }, update_reason: 'humanizer is optional',
    });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.json));
    assert.deepEqual(corrected.json.metadata.required_skills, ['zh-tw-doc-copy']);
    assert.equal(corrected.json.metadata.required_skills_source, 'manual');

    // …through an edit to the text,
    const edited = await call('PUT', `/api/memory/${id}`, {
      content: SKILL_RULE.replace('humanizer-tw', 'other-skill'), update_reason: 'wording',
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.deepEqual(edited.json.metadata.required_skills, ['zh-tw-doc-copy']);
    assert.equal(edited.json.required_skills_note, undefined, 'a person\'s list is not second-guessed');

    assert.equal(edited.json.metadata.tool, 'test', 'an edit that sent no metadata rewrote the rest of it');

    // …and through metadata sent without it, which replaces the stored object.
    const replaced = await call('PUT', `/api/memory/${id}`, {
      metadata: { tool: 'other' }, update_reason: 'tool',
    });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    assert.deepEqual(replaced.json.metadata.required_skills, ['zh-tw-doc-copy']);
    assert.equal(replaced.json.metadata.tool, 'other');

    // ── 6. A guess sent back untouched is still a guess ─────────────────────────────
    const ir801 = db.psql("SELECT id FROM memories WHERE code = 'IR-801' AND user_id = 1").trim();
    const echoed = await call('PUT', `/api/memory/${ir801}`, {
      metadata: { ...backfilled, origin_note: 'added' }, update_reason: 'add a note',
    });
    assert.equal(echoed.status, 200, JSON.stringify(echoed.json));
    assert.equal(echoed.json.metadata.required_skills_source, 'auto',
      'sending the stored metadata back froze the guess as a decision');
    assert.deepEqual(echoed.json.metadata.stats, { enforced: 3 });

    // ── 7. init sends the corrected list ────────────────────────────────────────────
    const after = await skillsInInit();
    assert.deepEqual(after.find((r) => r.title === '寫中文前後要過兩道工具（新）').skills, ['zh-tw-doc-copy']);
  } finally {
    if (server) await server.close();
    if (pool?.end) await pool.end().catch(() => {});
    db.stop();
  }
});
