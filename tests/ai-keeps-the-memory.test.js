import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/app-server.js';
import { startRealDb } from './helpers/real-db.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * v1.33.0 — the AI keeps the memory; the server side.
 *
 * Against a real database, because every behaviour here is SQL: trigram similarity, the
 * three memory states and what each list shows, the history rows the console reads, the
 * month arithmetic of the report, the handoff grace window. A fake query would agree with
 * whatever the route asked for.
 *
 * See openspec/changes/v1.33.0-ai-keeps-the-memory/spec.md — "Contracts" and "Scenarios".
 */

function quote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

const PROD_CHECKLIST = 'ssh 到 203.0.113.10，cd /srv/ownmind，git pull，docker compose build --no-cache，'
  + 'docker compose up -d api，看 docker logs 有沒有 migration 失敗，正式機要先備份資料庫';
const STAGING_CHECKLIST = PROD_CHECKLIST.replace('203.0.113.10', '198.51.100.7').replace('正式機', '測試機');
// Shaped like an OpenAI key; the same guard every memory write runs refuses it.
// Assembled at run time so the repository never holds a string shaped like a real key; the
// secret guard under test sees the joined value, the pre-commit scanner sees only pieces.
const TOKEN = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP'].join('-');

test('the AI keeps the memory: states, duplicates, consolidation, lessons, tasks, handoffs', async (t) => {
  const db = await startRealDb();
  if (!db) {
    t.skip('docker is not available on this machine, so the database seam was NOT exercised');
    return;
  }

  let server;
  let pool;
  try {
    const skipped = db.applyMigrations(path.join(repoRoot, 'db'));
    assert.equal(skipped.some((s) => /^0(0[125]|27|30|34)_/.test(s)), false,
      `core migrations failed to apply: ${skipped.join('; ')}`);

    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = String(db.port);
    process.env.DB_NAME = 'ownmind';
    process.env.DB_USER = 'ownmind';
    process.env.DB_PASSWORD = 'test';

    const memoryRoutes = (await import('../src/routes/memory.js')).default;
    const sessionRoutes = (await import('../src/routes/session.js')).default;
    const handoffRoutes = (await import('../src/routes/handoff.js')).default;
    const { createMemoryConsolidationRouter } = await import('../src/routes/memory-consolidation.js');
    const { createSessionLessonsRouter } = await import('../src/routes/session-lessons.js');
    const { createTasksRouter } = await import('../src/routes/tasks.js');
    const { runMemoryConsolidation } = await import('../src/jobs/memory-consolidation.js');
    const auth = (await import('../src/middleware/auth.js')).default;
    const dbModule = await import('../src/utils/db.js');
    const { query } = dbModule;
    pool = dbModule.default ?? null;
    const logger = { error() {}, warn() {}, info() {} };

    const app = express();
    app.use(express.json());
    // The same order as src/app.js: the consolidation router first, so `/:id` never eats it.
    app.use('/api/memory/consolidation', createMemoryConsolidationRouter({ query, auth, logger }));
    app.use('/api/memory', memoryRoutes);
    app.use('/api/session/lessons', createSessionLessonsRouter({ query, auth, logger }));
    app.use('/api/session', sessionRoutes);
    app.use('/api/handoff', handoffRoutes);
    app.use('/api/tasks', createTasksRouter({ query, auth, logger }));
    server = await startServer(app);

    db.psql(`
      INSERT INTO users (id, email, name, api_key, role, settings) VALUES
        (1, 'vin@example.com', 'Vin', 'key-vin', 'user', '{}'::jsonb),
        (2, 'eric@example.com', 'Eric', 'key-eric', 'admin', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
      SELECT setval(pg_get_serial_sequence('users','id'), 10);
    `);

    const headers = { Authorization: 'Bearer key-vin', 'content-type': 'application/json' };
    let syncToken = null;
    const call = async (method, url, body, extra = {}) => {
      const payload = body && { ...body, sync_token: syncToken };
      const res = await fetch(`${server.url}${url}`, {
        method, headers: { ...headers, ...extra }, body: payload && JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (json && typeof json.sync_token === 'string') syncToken = json.sync_token;
      return { status: res.status, json };
    };
    const init = async () => {
      const r = await call('GET', '/api/memory/init?compact=true');
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return r.json;
    };
    const count = (sql) => Number(db.psql(sql).trim());
    const save = (body) => call('POST', '/api/memory', { type: 'project', ...body });
    const ok201 = async (body) => {
      const r = await save(body);
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json;
    };
    const historyOf = (id) => db.psql(`SELECT string_agg(change_type, ',' ORDER BY id) FROM memory_history WHERE memory_id = ${id}`).trim();

    await init();

    // ── 1. Save-time duplicate check ────────────────────────────────────────────────
    const prod = await ok201({ title: '正式機部署步驟', content: PROD_CHECKLIST });

    const again = await save({ title: '正式機部署步驟', content: PROD_CHECKLIST });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.saved, false);
    assert.equal(again.json.duplicate_of.id, prod.id);
    assert.equal(typeof again.json.sync_token, 'string');
    assert.equal(count("SELECT count(*) FROM memories WHERE title = '正式機部署步驟'"), 1, 'the duplicate was inserted');

    const staging = await save({ title: '測試機部署步驟', content: STAGING_CHECKLIST });
    assert.equal(staging.status, 200, JSON.stringify(staging.json));
    assert.equal(staging.json.saved, false);
    assert.equal(staging.json.duplicate_of, undefined, 'two checklists that differ in one host are NOT the same memory');
    assert.equal(staging.json.similar[0].id, prod.id);
    assert.ok(staging.json.similar[0].similarity >= 0.45 && staging.json.similar[0].similarity < 0.98,
      `worst case lands in similar: ${staging.json.similar[0].similarity}`);
    assert.ok(staging.json.similar[0].excerpt.length > 0);
    assert.equal(count("SELECT count(*) FROM memories WHERE title = '測試機部署步驟'"), 0);

    const forced = await save({ title: '測試機部署步驟', content: STAGING_CHECKLIST, force: true });
    assert.equal(forced.status, 201, JSON.stringify(forced.json));
    assert.equal(count("SELECT count(*) FROM memories WHERE title LIKE '%部署步驟'"), 2);

    const unrelated = await ok201({ title: '好好玩 Ad Manager 每月廣告收入', content: '每月 1 號從 Google Ad Manager 後台抓上個月的收入，寫進試算表「廣告收入」分頁' });
    assert.ok(unrelated.id > forced.json.id);

    // ── 2. Archive, what each list shows, restore ───────────────────────────────────
    const before = new Date().toISOString();
    await new Promise((r) => { setTimeout(r, 20); });

    const archived = await call('POST', `/api/memory/${unrelated.id}/archive`, { reason: '收入改由財務部抓' });
    assert.equal(archived.status, 200, JSON.stringify(archived.json));
    assert.equal(archived.json.status, 'archived');
    assert.equal(archived.json.archived_reason, '收入改由財務部抓');
    assert.ok(archived.json.archived_at);
    assert.equal(historyOf(unrelated.id), 'create,archive');

    const syncAll = await call('GET', '/api/memory/sync?types=project');
    assert.ok(!syncAll.json.memories.some((m) => m.id === unrelated.id), 'an archived row left the full sync');
    const syncSince = await call('GET', `/api/memory/sync?types=project&since=${encodeURIComponent(before)}`);
    const tombstone = syncSince.json.memories.find((m) => m.id === unrelated.id);
    assert.ok(tombstone, 'an archived row is sent as a tombstone to clients that already have it');
    assert.equal(tombstone.status, 'archived');

    const searchDefault = await call('GET', '/api/memory/search?q=Ad%20Manager');
    assert.equal(searchDefault.json.data.some((m) => m.id === unrelated.id), false, 'archived rows are out of the default search');
    const searchWide = await call('GET', '/api/memory/search?q=Ad%20Manager&include_archived=1');
    const found = searchWide.json.data.find((m) => m.id === unrelated.id);
    assert.ok(found, 'include_archived=1 finds it');
    assert.equal(found.status, 'archived');

    const archivedList = await call('GET', '/api/memory/archived');
    assert.equal(archivedList.status, 200);
    assert.deepEqual(archivedList.json.map((m) => [m.id, m.archived_reason, m.project]), [[unrelated.id, '收入改由財務部抓', null]]);
    for (const col of ['id', 'title', 'content', 'project', 'archived_reason', 'archived_at']) {
      assert.ok(col in archivedList.json[0], `archived rows carry ${col}`);
    }

    const ironRule = await call('POST', '/api/memory', {
      type: 'iron_rule', title: '部署前要先備份資料庫',
      content: '什麼時候適用：要部署到正式機之前。\n規則：必須先備份資料庫，禁止沒有備份就部署。\n理由：2026-03 一次 migration 失敗把資料弄壞，沒有備份可以還原。',
      tags: ['trigger:deploy'],
    });
    assert.equal(ironRule.status, 201, JSON.stringify(ironRule.json));
    const refusedArchive = await call('POST', `/api/memory/${ironRule.json.id}/archive`, { reason: 'x' });
    assert.equal(refusedArchive.status, 409);
    assert.equal(refusedArchive.json.error, 'Only project memories can be archived');
    assert.equal(db.psql(`SELECT status FROM memories WHERE id = ${ironRule.json.id}`).trim(), 'active');

    const restored = await call('POST', `/api/memory/${unrelated.id}/restore`, {});
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    assert.equal(restored.json.status, 'active');
    assert.equal(restored.json.archived_at, null);
    assert.equal(historyOf(unrelated.id), 'create,archive,restore');
    assert.equal((await call('POST', `/api/memory/${unrelated.id}/restore`, {})).status, 409, 'restoring an active row is refused');
    const tagged = await ok201({ title: 'Vinutes 舊的發版腳本', content: '用 scripts/release.sh', tags: ['project:vinutes'] });
    await call('POST', `/api/memory/${tagged.id}/archive`, { reason: '改用 GitHub Actions' });
    assert.deepEqual((await call('GET', '/api/memory/archived')).json.map((m) => [m.id, m.project]), [[tagged.id, 'vinutes']]);
    await call('POST', `/api/memory/${tagged.id}/restore`, {});

    // ── 3. Merge ────────────────────────────────────────────────────────────────────
    const mergeBefore = new Date().toISOString();
    await new Promise((r) => { setTimeout(r, 20); });
    const merged = await call('POST', '/api/memory/merge', { keep: prod.id, drop: forced.json.id });
    assert.equal(merged.status, 200, JSON.stringify(merged.json));
    assert.equal(merged.json.drop.status, 'disabled');
    assert.equal(merged.json.drop.disabled_reason, `merged into #${prod.id}`);
    assert.deepEqual(merged.json.keep.metadata.merged_from, [forced.json.id]);
    assert.equal(merged.json.keep.status, 'active');
    assert.equal(historyOf(forced.json.id), 'create,merge');
    assert.equal(historyOf(prod.id), 'create,merge');
    assert.equal(db.psql(`SELECT metadata->>'keep' FROM memory_history WHERE memory_id = ${forced.json.id} AND change_type = 'merge'`).trim(), String(prod.id));
    const syncAfterMerge = await call('GET', `/api/memory/sync?types=project&since=${encodeURIComponent(mergeBefore)}`);
    assert.ok(syncAfterMerge.json.memories.some((m) => m.id === forced.json.id && m.status === 'disabled'), 'the dropped row is sent so clients remove it');
    assert.equal((await call('POST', '/api/memory/merge', { keep: prod.id, drop: forced.json.id })).status, 409, 'a disabled row cannot be merged again');
    assert.equal((await call('POST', '/api/memory/merge', { keep: prod.id, drop: ironRule.json.id })).status, 409, 'different types never merge');

    // ── 4. Decide ───────────────────────────────────────────────────────────────────
    const older = await ok201({ title: '待決定：Ad Manager 要不要續約', content: '合約 11 月到期，續約要 Vin 決定' });
    const newer = await ok201({ title: 'Ad Manager 續約的決定', content: 'Vin 10/20 在群組說續約一年，條件不變' });
    db.psql(`UPDATE memories SET created_at = '2026-10-01T00:00:00Z' WHERE id = ${older.id};
             UPDATE memories SET created_at = '2026-10-05T00:00:00Z' WHERE id = ${newer.id};`);
    const wrongWay = await call('POST', `/api/memory/${newer.id}/decide`, { decision: 'x', source_id: older.id });
    assert.equal(wrongWay.status, 409);
    assert.equal(wrongWay.json.error, 'source must be newer');
    const decided = await call('POST', `/api/memory/${older.id}/decide`, { decision: '續約一年，條件不變', source_id: newer.id });
    assert.equal(decided.status, 200, JSON.stringify(decided.json));
    assert.match(decided.json.content, new RegExp(`^決定（\\d{4}-\\d{2}-\\d{2}，依據 #${newer.id}）：續約一年，條件不變\\n\\n合約 11 月到期`));
    assert.equal(historyOf(older.id), 'create,decide');
    assert.equal(db.psql(`SELECT content FROM memory_history WHERE memory_id = ${older.id} AND change_type = 'decide'`).trim(), '合約 11 月到期，續約要 Vin 決定');
    // A decision that quotes a key is refused the way PUT /:id refuses it, and nothing moves.
    const leakyDecision = await call('POST', `/api/memory/${older.id}/decide`, { decision: `金鑰換成 ${TOKEN}`, source_id: newer.id });
    assert.equal(leakyDecision.status, 400, JSON.stringify(leakyDecision.json));
    assert.equal(leakyDecision.json.redirect_tool, 'ownmind_set_secret');
    assert.match(leakyDecision.json.detected_by, /^regex:/);
    assert.equal(historyOf(older.id), 'create,decide');
    assert.ok(!db.psql(`SELECT content FROM memories WHERE id = ${older.id}`).includes(TOKEN.slice(0, 7)), 'the key never reached the row');

    // ── 5. Candidates ───────────────────────────────────────────────────────────────
    const dupA = await ok201({ title: 'Vinutes 發版流程', content: 'git tag v0.4.x，推上去之後 GitHub Actions 會自動打包 dmg，等 10 分鐘再去 Releases 頁檢查' });
    const dupB = await ok201({ title: 'Vinutes 發版怎麼做', content: 'git tag v0.4.x 推上去之後 GitHub Actions 自動打包 dmg，大約 10 分鐘，再到 Releases 頁檢查', force: true });
    const concluded = await ok201({ title: '【已過時】idaytour 兩台的 Gemini 金鑰', content: '10/15 已換成 ft-idaytour 專案的金鑰' });
    const stale = await ok201({ title: '南投旅遊網最新消息讀不出來', content: '2026-06 的修法，等上線' });
    db.psql(`UPDATE memories SET updated_at = NOW() - INTERVAL '100 days' WHERE id = ${stale.id}`);
    await init(); // the row above was the newest; moving its updated_at moved the sync token
    const waiting = await ok201({ title: 'Taiwan PASS API', content: '等 Adam 回覆開通日期\n其他內容', tags: ['project:taiwan-pass'] });
    db.psql(`
      INSERT INTO session_lessons (user_id, project, stuck, fix, status, created_at)
      VALUES (1, 'om', '舊教訓', '舊修法', 'new', NOW() - INTERVAL '10 days'),
             (1, 'om', '新教訓', '新修法', 'new', NOW() - INTERVAL '1 day');
      INSERT INTO tasks (user_id, project, title, status, done_at, evidence)
      VALUES (1, 'vinutes', '本月關掉的卡', 'done', NOW(), 'node --test → pass 3, fail 0'),
             (1, 'vinutes', '上個月關掉的卡', 'done', NOW() - INTERVAL '45 days', 'node --test → pass 3, fail 0');
    `);
    const cand = await call('GET', '/api/memory/consolidation/candidates');
    assert.equal(cand.status, 200, JSON.stringify(cand.json));
    const pair = cand.json.duplicates.find((p) => p.a.id === dupA.id && p.b.id === dupB.id);
    assert.ok(pair, `the Vinutes pair is a duplicate candidate: ${JSON.stringify(cand.json.duplicates)}`);
    assert.ok(pair.similarity >= 0.6);
    assert.equal(pair.a.type, 'project');
    assert.ok(!cand.json.duplicates.some((p) => p.a.id === forced.json.id || p.b.id === forced.json.id), 'a disabled row is not a candidate');
    assert.deepEqual(cand.json.concluded.map((c) => [c.id, c.marker]), [[concluded.id, '已過時']]);
    assert.deepEqual(cand.json.stale.map((c) => c.id), [stale.id]);
    assert.ok(cand.json.stale[0].days >= 99);
    assert.deepEqual(cand.json.waiting.map((c) => [c.id, c.project]).sort((x, y) => x[0] - y[0]),
      [[older.id, null], [waiting.id, 'taiwan-pass']].sort((x, y) => x[0] - y[0]));
    assert.deepEqual(cand.json.lessons.map((l) => l.stuck), ['舊教訓']);
    assert.deepEqual(cand.json.closed_tasks.map((c) => c.title), ['本月關掉的卡']);

    // ── 6. Questions ────────────────────────────────────────────────────────────────
    const q1 = await call('POST', '/api/memory/consolidation/questions', { memory_id: waiting.id, question: 'Adam 開 API 了嗎？' });
    assert.equal(q1.status, 201, JSON.stringify(q1.json));
    assert.equal(q1.json.project, 'taiwan-pass');
    const q2 = await call('POST', '/api/memory/consolidation/questions', { memory_id: waiting.id, question: 'Adam 說什麼時候開 API？' });
    assert.equal(q2.json.id, q1.json.id, 'one open question per memory; the second call updates the text');
    assert.equal(q2.json.question, 'Adam 說什麼時候開 API？');
    const leakyQuestion = await call('POST', '/api/memory/consolidation/questions', { memory_id: waiting.id, question: `${TOKEN} 還要用嗎？` });
    assert.equal(leakyQuestion.status, 400, JSON.stringify(leakyQuestion.json));
    assert.equal(leakyQuestion.json.redirect_tool, 'ownmind_set_secret');
    assert.equal(db.psql(`SELECT question FROM consolidation_questions WHERE id = ${q1.json.id}`).trim(), 'Adam 說什麼時候開 API？', 'the open question kept its text');
    const asked = await call('POST', '/api/memory/consolidation/questions/asked', { ids: [q1.json.id] });
    assert.deepEqual(asked.json, { updated: 1 });
    assert.equal(count(`SELECT asked_count FROM consolidation_questions WHERE id = ${q1.json.id}`), 1);
    // The hook reports a showing on every session start, /compact and resume included. A
    // question counts as asked once per calendar day, or two restarts would expire it.
    const askedAgain = await call('POST', '/api/memory/consolidation/questions/asked', { ids: [q1.json.id] });
    assert.deepEqual(askedAgain.json, { updated: 1 }, 'the row is still touched (last_asked_at moves)');
    assert.equal(count(`SELECT asked_count FROM consolidation_questions WHERE id = ${q1.json.id}`), 1, 'a second showing the same day is not a second ask');

    // ── 7. The card, the report, the expiry ─────────────────────────────────────────
    const now = new Date();
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit' }).format(now);
    // Two runs at once (the start-up run and the cron, or two servers): both pass the
    // check, the unique index lets only one insert through.
    const [run1, run1b] = await Promise.all([
      runMemoryConsolidation({ query, now }),
      runMemoryConsolidation({ query, now }),
    ]);
    assert.deepEqual([...run1.created, ...run1b.created], [1], 'one card for the one user with active memories');
    const run2 = await runMemoryConsolidation({ query, now });
    assert.deepEqual(run2.created, []);
    assert.equal(count(`SELECT count(*) FROM tasks WHERE project = 'ownmind' AND title = '整理記憶 ${month}'`), 1);
    assert.throws(
      () => db.psql(`INSERT INTO tasks (user_id, project, title) VALUES (1, 'ownmind', '整理記憶 ${month}')`),
      /tasks_consolidation_card_uidx|duplicate key/,
      'the index, not only the job, keeps the month to one card',
    );
    db.psql(`INSERT INTO tasks (user_id, project, title) VALUES (1, 'ownmind', '整理記憶 的事（不是月卡）')`);
    db.psql(`DELETE FROM tasks WHERE title = '整理記憶 的事（不是月卡）'`);
    const card = JSON.parse(db.psql(`SELECT row_to_json(t) FROM tasks t WHERE project = 'ownmind' AND title = '整理記憶 ${month}'`));
    assert.equal(card.status, 'open');
    assert.equal(card.auto, true);
    assert.equal(card.is_private, true);
    assert.match(card.body, /規則照 ownmind-consolidate 這個 skill 做/);
    assert.match(card.body, /先呼叫 ownmind_consolidation_candidates/);

    let state = await init();
    assert.equal(state.consolidation.card.id, card.id);
    assert.equal(state.consolidation.card.title, `整理記憶 ${month}`);
    assert.equal(state.consolidation.report, null);
    assert.deepEqual(state.consolidation.questions, [{ id: q1.json.id, memory_id: waiting.id, project: 'taiwan-pass', question: 'Adam 說什麼時候開 API？' }]);
    db.psql(`UPDATE consolidation_questions SET last_asked_at = NOW() - INTERVAL '1 day' WHERE id = ${q1.json.id}`);
    await call('POST', '/api/memory/consolidation/questions/asked', { ids: [q1.json.id] });
    assert.equal(count(`SELECT asked_count FROM consolidation_questions WHERE id = ${q1.json.id}`), 2, 'a showing on another day counts');
    assert.ok(db.psql(`SELECT last_asked_at > NOW() - INTERVAL '1 minute' FROM consolidation_questions WHERE id = ${q1.json.id}`).trim() === 't');

    db.psql(`UPDATE tasks SET status = 'done', done_at = NOW(), evidence = 'ran the card' WHERE id = ${card.id}`);
    state = await init();
    assert.equal(state.consolidation.card, null);
    assert.equal(state.consolidation.report.task_id, card.id);
    assert.equal(state.consolidation.report.month, month);
    assert.match(state.consolidation.report.month, /^\d{4}-\d{2}$/, 'rendered verbatim by the hook');
    const liveReport = await call('GET', '/api/memory/sync-token');
    assert.deepEqual(liveReport.json.consolidation.report, state.consolidation.report, '/sync-token carries the same report');
    assert.equal(state.consolidation.report.merged, 1);
    assert.equal(state.consolidation.report.archived, 2, 'the Ad Manager archive and the tagged one; restores do not subtract');
    assert.equal(state.consolidation.report.decided, 1);
    assert.equal(state.consolidation.report.lessons_kept, 0);
    assert.equal(state.consolidation.report.closed_tasks, 2, 'the test card and the seeded one');
    const shown = await call('PUT', '/api/memory/consolidation/report-shown', { task_id: card.id });
    assert.deepEqual(shown.json, { ok: true });
    state = await init();
    assert.equal(state.consolidation.report, null, 'the report is shown once');

    // A question asked twice, unanswered for 14 days: the memory is archived by the job.
    db.psql(`UPDATE consolidation_questions SET asked_count = 2, last_asked_at = NOW() - INTERVAL '15 days' WHERE id = ${q1.json.id}`);
    const run3 = await runMemoryConsolidation({ query, now });
    assert.deepEqual(run3.expired, [waiting.id]);
    assert.equal(db.psql(`SELECT status || '|' || archived_reason FROM memories WHERE id = ${waiting.id}`).trim(), 'archived|兩次未確認，自動歸檔');
    assert.ok(db.psql(`SELECT answered_at FROM consolidation_questions WHERE id = ${q1.json.id}`).trim());
    assert.equal(historyOf(waiting.id), 'create,archive');
    // An archive from a route answers the open question too.
    const q3 = await call('POST', '/api/memory/consolidation/questions', { memory_id: stale.id, question: '還在等上線嗎？' });
    await init(); // the job's archive moved the sync token
    const staleArchived = await call('POST', `/api/memory/${stale.id}/archive`, { reason: '已上線' });
    assert.equal(staleArchived.status, 200, JSON.stringify(staleArchived.json));
    assert.ok(db.psql(`SELECT answered_at FROM consolidation_questions WHERE id = ${q3.json.id}`).trim());

    // ── 8. Handoffs: pending, accepted within 30 minutes, reopened ──────────────────
    const handoff = await call('POST', '/api/handoff', { project: 'nantou-funbus', content: '下一步：把 KOL 名單貼進群組', from_tool: 'claude-code', from_machine: 'TANK' });
    assert.equal(handoff.status, 201, JSON.stringify(handoff.json));
    state = await init();
    assert.equal(state.active_handoff.id, handoff.json.id, 'older hooks still get active_handoff');
    assert.deepEqual(state.handoffs.map((h) => [h.id, h.project, h.status, h.from_machine]), [[handoff.json.id, 'nantou-funbus', 'pending', 'TANK']]);
    const accepted = await call('PUT', `/api/handoff/${handoff.json.id}/accept`, { accepted_by: 'claude-code@TANK' });
    assert.equal(accepted.status, 200);
    // A second window arriving a moment later must not overwrite who took it.
    const acceptedTwice = await call('PUT', `/api/handoff/${handoff.json.id}/accept`, { accepted_by: 'claude-code@MAC' });
    assert.equal(acceptedTwice.status, 409, JSON.stringify(acceptedTwice.json));
    assert.equal(acceptedTwice.json.error, 'Handoff already accepted');
    assert.equal(acceptedTwice.json.status, 'accepted');
    assert.equal(acceptedTwice.json.accepted_by, 'claude-code@TANK');
    assert.ok(acceptedTwice.json.accepted_at);
    assert.equal(db.psql(`SELECT accepted_by FROM handoffs WHERE id = ${handoff.json.id}`).trim(), 'claude-code@TANK');
    assert.equal((await call('PUT', '/api/handoff/999999/accept', { accepted_by: 'x' })).status, 404);
    state = await init();
    assert.equal(state.active_handoff, null);
    assert.equal(state.handoffs[0].status, 'accepted');
    // The hook overlays the live fields from /sync-token on a cached init: same shapes.
    const live = await call('GET', '/api/memory/sync-token');
    assert.equal(live.status, 200, JSON.stringify(live.json));
    assert.deepEqual(live.json.handoffs, state.handoffs);
    assert.deepEqual(live.json.consolidation, state.consolidation);
    assert.equal(typeof live.json.lessons_waiting, 'number');
    assert.equal(state.handoffs[0].accepted_by, 'claude-code@TANK');
    assert.ok(state.handoffs[0].accepted_at);
    db.psql(`UPDATE handoffs SET accepted_at = NOW() - INTERVAL '31 minutes' WHERE id = ${handoff.json.id}`);
    state = await init();
    assert.deepEqual(state.handoffs, [], 'after 30 minutes an accepted handoff is gone');
    const pendingOnly = await call('GET', '/api/handoff/pending');
    assert.deepEqual(pendingOnly.json, [], 'the hook\'s list stays pending-only');
    const withAccepted = await call('GET', '/api/handoff/pending?with_accepted=7');
    assert.deepEqual(withAccepted.json.map((h) => [h.id, h.status, h.accepted_by]), [[handoff.json.id, 'accepted', 'claude-code@TANK']]);
    assert.ok(withAccepted.json[0].accepted_at);
    db.psql(`UPDATE handoffs SET accepted_at = NOW() - INTERVAL '8 days' WHERE id = ${handoff.json.id}`);
    assert.deepEqual((await call('GET', '/api/handoff/pending?with_accepted=7')).json, [], 'older than the window is out');
    const reopened = await call('PUT', `/api/handoff/${handoff.json.id}/reopen`, {});
    assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
    assert.equal(reopened.json.status, 'pending');
    assert.equal(reopened.json.accepted_by, null);
    assert.equal((await call('PUT', `/api/handoff/${handoff.json.id}/reopen`, {})).status, 404, 'only an accepted handoff reopens');

    // ── 9. Lessons: the second time, both become one memory ─────────────────────────
    const first = await call('POST', '/api/session', {
      summary: 'built the dmg', details: { project: 'vinutes' },
      lessons: [{ stuck: 'docker build 沒加 --no-cache，吃到舊的層，部署後畫面還是舊的', fix: '加 --no-cache 重 build', next_time: '部署指令一律帶 --no-cache' }],
    });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.deepEqual(first.json.lessons_promoted, []);
    const second = await call('POST', '/api/session', {
      summary: 'built the dmg again', details: { project: 'vinutes' },
      // Measured on 2026-10-21 against the preview stack: stuck+fix alone scores 0.542, all three fields 0.615.
      lessons: [{ stuck: 'docker build 沒加 --no-cache 又吃到舊的層，正式機畫面沒更新', fix: '加 --no-cache 重新 build', next_time: '部署指令一律帶 --no-cache' }],
    });
    assert.equal(second.status, 201, JSON.stringify(second.json));
    assert.equal(second.json.lessons_promoted.length, 1, JSON.stringify(second.json));
    const memId = second.json.lessons_promoted[0].memory_id;
    const promotedRows = db.psql(`SELECT status || '|' || promoted_by || '|' || memory_id FROM session_lessons WHERE memory_id = ${memId} ORDER BY id`).trim().split('\n');
    assert.deepEqual(promotedRows, [`promoted|ai_repeat|${memId}`, `promoted|ai_repeat|${memId}`]);
    const memRow = JSON.parse(db.psql(`SELECT row_to_json(m) FROM memories m WHERE id = ${memId}`));
    assert.equal(memRow.type, 'project');
    assert.match(memRow.content, /Next time: 部署指令一律帶 --no-cache/);
    assert.match(memRow.content, /（同一件事發生第二次）/);
    assert.equal(memRow.metadata.promoted_by, 'ai_repeat');
    const lessonsAll = await call('GET', '/api/session/lessons?status=all');
    assert.ok(lessonsAll.json.every((l) => 'reason' in l && 'promoted_by' in l && 'memory_id' in l));
    state = await init();
    assert.equal(state.consolidation.report?.lessons_kept, undefined, 'no unshown report now');

    // The monthly verdicts through /set, signed by who called.
    const oldLesson = Number(db.psql("SELECT id FROM session_lessons WHERE stuck = '舊教訓'").trim());
    const dismissed = await call('PUT', `/api/session/lessons/${oldLesson}/set`, { status: 'dismissed', reason: '已寫進 CLAUDE.md' }, { 'x-ownmind-tool': 'claude-code' });
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.json));
    assert.equal(dismissed.json.reason, '已寫進 CLAUDE.md');
    const kept = await call('PUT', `/api/session/lessons/${oldLesson}/set`, { status: 'promoted' }, { 'x-ownmind-tool': 'claude-code' });
    assert.equal(kept.status, 200, JSON.stringify(kept.json));
    assert.equal(db.psql(`SELECT promoted_by FROM session_lessons WHERE id = ${oldLesson}`).trim(), 'ai_monthly');
    const keptMemory = kept.json.memory.id;
    const noReason = await call('PUT', `/api/session/lessons/${oldLesson}/set`, { status: 'dismissed' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.json.error, 'reason is required when dismissing a lesson');
    assert.equal(db.psql(`SELECT status FROM session_lessons WHERE id = ${oldLesson}`).trim(), 'promoted');
    // The console's 收回: archive the memory, dismiss the lesson. Then 還是留 brings the same
    // memory back instead of writing a second one next to the archived copy.
    await init();
    const pulled = await call('POST', `/api/memory/${keptMemory}/archive`, { reason: '從教訓頁收回' });
    assert.equal(pulled.status, 200, JSON.stringify(pulled.json));
    const pulledLesson = await call('PUT', `/api/session/lessons/${oldLesson}/set`, { status: 'dismissed', reason: '從教訓頁收回' });
    assert.equal(pulledLesson.status, 200);
    assert.equal(pulledLesson.json.memory_id, keptMemory);
    const memoriesBefore = count('SELECT count(*) FROM memories');
    const keptAgain = await call('PUT', `/api/session/lessons/${oldLesson}/set`, { status: 'promoted' });
    assert.equal(keptAgain.status, 200, JSON.stringify(keptAgain.json));
    assert.equal(keptAgain.json.memory.id, keptMemory, 'the archived memory is the one that comes back');
    assert.equal(keptAgain.json.lesson.memory_id, keptMemory);
    assert.equal(keptAgain.json.lesson.status, 'promoted');
    assert.equal(keptAgain.json.lesson.promoted_by, 'console');
    assert.equal(typeof keptAgain.json.sync_token, 'string');
    assert.equal(count('SELECT count(*) FROM memories'), memoriesBefore, 'no second memory');
    assert.equal(db.psql(`SELECT status || '|' || coalesce(archived_reason, 'NULL') FROM memories WHERE id = ${keptMemory}`).trim(), 'active|NULL');
    assert.equal(historyOf(keptMemory), 'create,archive,restore');
    assert.equal(db.psql(`SELECT status || '|' || promoted_by FROM session_lessons WHERE id = ${oldLesson}`).trim(), 'promoted|console');
    const archivedNow = await call('GET', '/api/memory/archived');
    assert.ok(!archivedNow.json.some((m) => m.id === keptMemory), 'it left the archived tab');

    // ── 10. Tasks: evidence closes the card, reopen undoes ──────────────────────────
    const created = await call('POST', '/api/tasks', { project: 'vinutes', title: '修講者誤判' });
    assert.equal(created.status, 201);
    assert.equal((await call('PUT', `/api/tasks/${created.json.id}/claim`, { tool: 'claude-code' })).status, 200);
    const noEvidence = await call('PUT', `/api/tasks/${created.json.id}/done`, { result: '修好了' });
    assert.equal(noEvidence.status, 400);
    assert.equal(db.psql(`SELECT status FROM tasks WHERE id = ${created.json.id}`).trim(), 'claimed');
    const done = await call('PUT', `/api/tasks/${created.json.id}/done`, { result: '修好了', evidence: 'node --test tests/speakers.test.js → pass 9, fail 0' });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.evidence, 'node --test tests/speakers.test.js → pass 9, fail 0');
    const mine = await call('GET', '/api/tasks?mine=true');
    assert.ok(!mine.json.some((c) => c.id === created.json.id), 'a done card is closed, not waiting');
    const closed = await call('GET', '/api/tasks?mine=true&full=true&closed=month');
    const closedCard = closed.json.find((c) => c.id === created.json.id);
    assert.ok(closedCard, 'closed=month lists the card I closed this month');
    assert.equal(closedCard.evidence, 'node --test tests/speakers.test.js → pass 9, fail 0');
    assert.ok(!closed.json.some((c) => c.title === '上個月關掉的卡'));
    const back = await call('PUT', `/api/tasks/${created.json.id}/reopen`, { note: '講者還是錯' });
    assert.equal(back.status, 200, JSON.stringify(back.json));
    assert.equal(back.json.status, 'open');
    assert.match(back.json.body, /\[reopened .* by Vin\] 講者還是錯/);
    assert.equal(db.psql(`SELECT coalesce(evidence, 'NULL') FROM tasks WHERE id = ${created.json.id}`).trim(), 'NULL');
  } finally {
    if (server) await server.close();
    if (pool?.end) await pool.end().catch(() => {});
    db.stop();
  }
});
