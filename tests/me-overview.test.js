// v1.32.2 — 總覽 (openspec v1.32.0-console-rebuild, Phase 2).
//
// One endpoint composes what the page shows from queries the console already runs. The
// claims worth a test: the lights say what the reader should do and never go green on no
// data; the inbox rows are the inbox's own rows; a number the server does not have is
// 「沒有資料」, never 0; and an admin gets the team tile while a member gets their own
// last activity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { startServer } from './helpers/app-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { buildOverview, complianceRate, parseRange, createOverviewRouter } =
  await import('../src/routes/me-overview.js');
const { lightsVm, pendingVm, tilesVm, dailyVm, numberOrNoData } =
  await import('../client/src/pages/Home/overview-vm.js');

const zh = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client/src/i18n/zh.json'), 'utf8'));
const t = (k) => zh[k] ?? k;

// A fake database: answers each query by a word that identifies it.
function fakeQuery(answers) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    for (const [needle, rows] of answers) {
      if (sql.includes(needle)) return { rows: typeof rows === 'function' ? rows(params) : rows };
    }
    return { rows: [] };
  };
  return { query, calls };
}

const EMPTY = [];
const baseAnswers = () => [
  ['AS inits_24h', [{ last_init_at: '2026-10-08T01:00:00Z', inits_24h: 3, inits_7d: 20 }]],
  ['GROUP BY machine', [{ machine: 'TANK', api_host: 'fapa.welcometw.com', last_reported_at: '2026-10-08T00:00:00Z' }]],
  ['LEFT JOIN hb ON', EMPTY],
  ["event = 'iron_rule_compliance'", [
    { rule_code: 'IR-004', current: true, comply: 8, skip: 1, violate: 1, observed: 0 },
    { rule_code: 'IR-004', current: false, comply: 5, skip: 0, violate: 5, observed: 0 },
  ]],
  ['AS orphan_count', [{ orphan_count: 0 }]],
  ['AS current,', [{ current: 12, previous: 9 }]],
  ['WITH p AS', [{ project: 'idaytour', sessions: 7, turns: 40, handoffs: 1 }]],
  ['ORDER BY ts DESC', [{ ts: '2026-10-08T02:46:00Z', tool: 'claude-code', project: 'ownmind' }]],
  ['generate_series', [{ date: '2026-10-07', count: 2 }, { date: '2026-10-08', count: 3 }]],
  ["FROM handoffs WHERE user_id = $1 AND status = 'pending'", [{ id: 1, project: 'idaytour', from_tool: 'codex', from_machine: 'Vin-win', created_at: '2026-10-08T01:12:00Z' }]],
  ['FROM session_lessons', [{ id: 1, project: 'ownmind' }, { id: 2, project: 'idaytour' }]],
  ["FROM tasks", [{ id: 3, title: '重錄 6 張截圖', project: 'idaytour' }]],
  ['FROM bug_reports', [{ id: 9, title: '收工面板讀不到日誌', reporter_name: 'Eric' }]],
  ['AS visible', [{ name: 'Vin', visible: true }, { name: 'Judy', visible: false }]],
  ["FROM memories WHERE type = 'iron_rule'", [{ title: '回我話要用白話中文' }]],
];

const user = { id: 7, role: 'user' };
const adminUser = { id: 1, role: 'admin' };
const NOW = new Date('2026-10-08T03:00:00Z');

describe('parseRange', () => {
  it('accepts 7, 14, 30 and falls back to 7', () => {
    assert.equal(parseRange('14'), 14);
    assert.equal(parseRange('30'), 30);
    assert.equal(parseRange('9'), 7);
    assert.equal(parseRange(undefined), 7);
    assert.equal(parseRange('30d'), 30, 'a trailing d is tolerated, as /api/me/report does');
  });
});

describe('complianceRate', () => {
  it('is comply over comply+skip+violate, and null when nothing was reported', () => {
    assert.equal(complianceRate([{ comply: 8, skip: 1, violate: 1 }]), 0.8);
    assert.equal(complianceRate([]), null);
    assert.equal(complianceRate([{ comply: 0, skip: 0, violate: 0, observed: 4 }]), null,
      'observed-only rows are not a rate');
  });
});

describe('buildOverview — lights', () => {
  it('is green on fresh memory loads, reporting machines and reported checks', async () => {
    const { query } = fakeQuery(baseAnswers());
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: 'fapa.welcometw.com', now: NOW });
    assert.equal(o.lights.memory.state, 'good');
    assert.equal(o.lights.reporting.state, 'good');
    assert.equal(o.lights.rules.state, 'good');
    assert.equal(o.lights.rules.checks, 10);
  });

  it('turns 用量回報 red when a machine posts to another host (issue #152)', async () => {
    const a = baseAnswers();
    a[1] = ['GROUP BY machine', [
      { machine: 'LAPTOP-G95HIQ3V', api_host: 'kkvin.com', last_reported_at: '2026-10-08T00:00:00Z' },
      { machine: 'TANK', api_host: 'fapa.welcometw.com', last_reported_at: '2026-10-08T00:00:00Z' },
    ]];
    const { query } = fakeQuery(a);
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: 'fapa.welcometw.com', now: NOW });
    assert.equal(o.lights.reporting.state, 'bad');
    assert.deepEqual(o.lights.reporting.machines.map((m) => [m.machine, m.on_old_host]),
      [['LAPTOP-G95HIQ3V', true], ['TANK', false]]);
  });

  it('turns 用量回報 yellow when a tool used this week has a silent collector', async () => {
    const a = baseAnswers();
    a[2] = ['LEFT JOIN hb ON', [{ tool: 'codex' }]];
    const { query } = fakeQuery(a);
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: 'fapa.welcometw.com', now: NOW });
    assert.equal(o.lights.reporting.state, 'warn');
    assert.deepEqual(o.lights.reporting.stale_tools, ['codex']);
  });

  it('says "none", not green, when there is nothing to judge', async () => {
    const a = baseAnswers();
    a[0] = ['AS inits_24h', [{ last_init_at: null, inits_24h: 0, inits_7d: 0 }]];
    a[1] = ['GROUP BY machine', EMPTY];
    a[3] = ["event = 'iron_rule_compliance'", EMPTY];
    const { query } = fakeQuery(a);
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: 'fapa.welcometw.com', now: NOW });
    assert.equal(o.lights.memory.state, 'none');
    assert.equal(o.lights.reporting.state, 'none');
    assert.equal(o.lights.rules.state, 'none');
  });

  it('turns 規矩檢查 yellow when sessions went unreported', async () => {
    const a = baseAnswers();
    a[4] = ['AS orphan_count', [{ orphan_count: 4 }]];
    const { query } = fakeQuery(a);
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: 'fapa.welcometw.com', now: NOW });
    assert.equal(o.lights.rules.state, 'warn');
    assert.equal(o.lights.rules.unverified, 4);
  });

  it('flags nobody as on an old host when the server has no canonical host', async () => {
    const a = baseAnswers();
    a[1] = ['GROUP BY machine', [{ machine: 'X', api_host: 'kkvin.com', last_reported_at: '2026-10-08T00:00:00Z' }]];
    const { query } = fakeQuery(a);
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    assert.equal(o.lights.reporting.state, 'good');
  });
});

describe('buildOverview — pending, tiles, daily', () => {
  it('a member gets handoffs, lessons, tasks and no bug list', async () => {
    const { query, calls } = fakeQuery(baseAnswers());
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: 'fapa.welcometw.com', now: NOW });
    assert.equal(o.pending.handoffs.length, 1);
    assert.equal(o.pending.handoffs[0].from_tool, 'codex');
    assert.equal(o.pending.lessons.length, 2);
    assert.equal(o.pending.tasks[0].title, '重錄 6 張截圖');
    assert.equal(o.pending.bugs, null, 'bugs are not a member\'s to handle');
    assert.ok(!calls.some((c) => c.sql.includes('FROM bug_reports')), 'and the bug query is not even run');
    assert.equal(o.tiles.team_visible, null);
  });

  it('an admin gets the bug list and the team tile', async () => {
    const { query } = fakeQuery(baseAnswers());
    const o = await buildOverview({ query, user: adminUser, rangeDays: 7, canonicalHost: 'fapa.welcometw.com', now: NOW });
    assert.equal(o.pending.bugs.length, 1);
    assert.equal(o.pending.bugs[0].reporter_name, 'Eric');
    assert.deepEqual(o.tiles.team_visible, { visible: 1, total: 2, invisible_names: ['Judy'] });
  });

  it('tiles compare this range with the one before and name the worst rule', async () => {
    const { query } = fakeQuery(baseAnswers());
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: 'fapa.welcometw.com', now: NOW });
    assert.deepEqual(o.tiles.sessions, { current: 12, previous: 9 });
    assert.equal(o.tiles.compliance.rate, 0.8);
    assert.equal(o.tiles.compliance.previous_rate, 0.5);
    assert.equal(o.tiles.compliance.worst_rule.title, '回我話要用白話中文');
    assert.deepEqual(o.tiles.top_project, { project: 'idaytour', sessions: 7, turns: 40, handoffs: 1 });
    assert.equal(o.tiles.last_activity.tool, 'claude-code');
    assert.deepEqual(o.daily, [{ date: '2026-10-07', count: 2 }, { date: '2026-10-08', count: 3 }]);
    assert.equal(o.range_days, 7);
  });

  it('every per-user query is scoped to the caller', async () => {
    const { query, calls } = fakeQuery(baseAnswers());
    await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    const perUser = calls.filter((c) => /user_id = \$1/.test(c.sql));
    assert.ok(perUser.length >= 9);
    for (const c of perUser) assert.equal(c.params[0], 7, c.sql.slice(0, 60));
  });

  it('the range is one of three fixed windows, interpolated only after parsing', async () => {
    const { query, calls } = fakeQuery(baseAnswers());
    await buildOverview({ query, user, rangeDays: parseRange("7'; DROP TABLE users; --"), canonicalHost: null, now: NOW });
    assert.ok(calls.every((c) => !c.sql.includes('DROP TABLE')));
    assert.ok(calls.some((c) => c.sql.includes("INTERVAL '7 days'")));
  });
});

describe('the route', () => {
  it('answers a signed-in member with the overview, under the range they asked for', async () => {
    const { query } = fakeQuery(baseAnswers());
    const router = createOverviewRouter({
      query,
      auth: (req, _res, next) => { req.user = { id: 7, role: 'user' }; next(); },
      canonicalUrl: () => 'https://fapa.welcometw.com/ownmind',
      now: () => NOW,
    });
    const app = express();
    app.use('/api/me/overview', router);
    const server = await startServer(app);
    try {
      const res = await fetch(`${server.url}/api/me/overview?range=14`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.range_days, 14);
      assert.equal(body.lights.reporting.state, 'good');
      assert.equal(body.generated_at, NOW.toISOString());
    } finally {
      await server.close();
    }
  });

  it('is mounted before /api/me so meRoutes does not swallow it', () => {
    const app = fs.readFileSync(path.join(repoRoot, 'src/app.js'), 'utf8');
    const overview = app.indexOf("app.use('/api/me/overview'");
    const me = app.indexOf("app.use('/api/me', meRoutes)");
    assert.ok(overview > 0, 'the overview router must be mounted');
    assert.ok(overview < me, '/api/me/overview must be mounted before /api/me');
  });
});

// ────────────────────────────────────────────────────────────
// The page's sentences
// ────────────────────────────────────────────────────────────

const overview = (over = {}) => ({
  range_days: 7,
  lights: {
    memory: { state: 'good' },
    reporting: { state: 'bad', machines: [{ machine: 'LAPTOP-1', on_old_host: true }, { machine: 'TANK', on_old_host: false }], stale_tools: [] },
    rules: { state: 'warn', checks: 10, unverified: 4 },
  },
  pending: {
    handoffs: [{ id: 1, project: 'idaytour', from_tool: 'codex', from_machine: 'Vin-win' }],
    lessons: [{ id: 1, project: 'ownmind' }, { id: 2, project: 'ownmind' }, { id: 3, project: 'idaytour' }],
    tasks: [{ id: 3, title: '重錄截圖' }],
    bugs: null,
  },
  tiles: {
    sessions: { current: 12, previous: 9 },
    compliance: { rate: 0.8, previous_rate: 0.5, worst_rule: { title: '回我話要用白話中文' } },
    top_project: { project: 'idaytour', sessions: 7, handoffs: 1 },
    last_activity: { ts: '2026-10-08T02:46:00Z', tool: 'claude-code', project: 'ownmind' },
    team_visible: null,
  },
  daily: [{ date: '2026-10-08', count: 3 }],
  ...over,
});

describe('lightsVm — every light says what to do', () => {
  it('names the machine on the old host and points at the fix', () => {
    const [, rep] = lightsVm(overview(), t);
    assert.equal(rep.state, 'bad');
    assert.match(rep.text, /LAPTOP-1/);
    assert.doesNotMatch(rep.text, /TANK/);
    assert.match(rep.text, /升級 OwnMind/);
    assert.equal(rep.action.to, '/usage/mine');
  });

  it('a green light carries no button and says nothing is needed', () => {
    const [mem] = lightsVm(overview(), t);
    assert.equal(mem.state, 'good');
    assert.equal(mem.action, null);
    assert.match(mem.text, /不用做/);
  });

  it('規矩檢查 counts the unreported sessions and links to them', () => {
    const [, , rules] = lightsVm(overview(), t);
    assert.match(rules.text, /4 場/);
    assert.equal(rules.action.to, '/usage/rules');
  });

  it('an unknown or missing state renders as "none", never as green', () => {
    const o = overview({ lights: { memory: { state: 'purple' }, reporting: {}, rules: {} } });
    for (const l of lightsVm(o, t)) assert.equal(l.state, 'none');
    for (const l of lightsVm(null, t)) assert.equal(l.state, 'none');
  });

  it('the copy never uses the words a member does not use', () => {
    // The prototype's rule: collector / heartbeat / token / 合規 are not shown.
    const texts = lightsVm(overview(), t).flatMap((l) => [l.title, l.text, l.action?.label ?? '']);
    for (const s of texts) assert.doesNotMatch(s, /collector|heartbeat|token|合規/i, s);
  });
});

describe('pendingVm — one row per kind, one button each', () => {
  it('lists handoffs, lessons and tasks for a member, no bugs', () => {
    const rows = pendingVm(overview(), t);
    assert.deepEqual(rows.map((r) => r.id), ['handoffs', 'lessons', 'tasks']);
    assert.match(rows[0].text, /1 份交接/);
    assert.match(rows[0].detail, /idaytour/);
    assert.match(rows[0].detail, /codex/);
    assert.equal(rows[0].to, '/inbox/handoffs');
    assert.match(rows[1].text, /3 條/);
    assert.equal(rows[1].detail, 'ownmind、idaytour', 'projects are named once each');
    assert.equal(rows[2].to, '/inbox/tasks');
  });

  it('adds the bug row for an admin and nothing when all is empty', () => {
    const o = overview({ pending: { handoffs: [], lessons: [], tasks: [], bugs: [{ id: 9, title: '面板讀不到日誌', reporter_name: 'Eric' }] } });
    const rows = pendingVm(o, t);
    assert.deepEqual(rows.map((r) => r.id), ['bugs']);
    assert.match(rows[0].detail, /Eric：面板讀不到日誌/);
    assert.deepEqual(pendingVm(overview({ pending: { handoffs: [], lessons: [], tasks: [], bugs: [] } }), t), []);
    assert.deepEqual(pendingVm(null, t), []);
  });
});

describe('tilesVm — numbers with one comparison sentence, 沒有資料 when absent', () => {
  it('four tiles for a member: sessions, compliance, project, last activity', () => {
    const tiles = tilesVm(overview(), t, { role: 'user' });
    assert.deepEqual(tiles.map((x) => x.id), ['sessions', 'compliance', 'project', 'last']);
    assert.equal(tiles[0].value, '12');
    assert.match(tiles[0].note, /多 3 場/);
    assert.equal(tiles[0].tone, 'up');
    assert.equal(tiles[1].value, '80%');
    assert.match(tiles[1].note, /高 30 個百分點/);
    assert.match(tiles[1].note, /回我話要用白話中文/);
    assert.equal(tiles[2].value, 'idaytour');
    assert.match(tiles[2].note, /7 場對話、1 份交接/);
    assert.equal(tiles[3].isTime, true);
  });

  it('an admin gets the team tile in the fourth slot', () => {
    const o = overview({ tiles: { ...overview().tiles, team_visible: { visible: 7, total: 9, invisible_names: ['Judy', 'Kevin'] } } });
    const tiles = tilesVm(o, t, { role: 'admin' });
    assert.equal(tiles[3].id, 'team');
    assert.equal(tiles[3].value, '7／9');
    assert.match(tiles[3].note, /Judy、Kevin/);
    assert.equal(tiles[3].tone, 'down');
  });

  it('a number the server does not have is 沒有資料, not 0', () => {
    const o = overview({ tiles: { sessions: {}, compliance: { rate: null }, top_project: null, last_activity: null, team_visible: null } });
    const tiles = tilesVm(o, t, { role: 'user' });
    for (const x of tiles) {
      assert.equal(x.value, '沒有資料', x.id);
      assert.notEqual(x.value, '0');
      assert.ok(x.note.length > 0, `${x.id} still says what the blank means`);
    }
    assert.equal(numberOrNoData(undefined, t), '沒有資料');
    assert.equal(numberOrNoData(0, t), '0', 'a real zero is a number');
  });

  it('a fall in sessions reads as fewer, not as an error', () => {
    const o = overview({ tiles: { ...overview().tiles, sessions: { current: 4, previous: 9 } } });
    const [s] = tilesVm(o, t, { role: 'user' });
    assert.match(s.note, /少 5 場/);
    assert.equal(s.tone, 'down');
  });
});

describe('dailyVm', () => {
  it('passes the server rows through as date/count and survives a missing list', () => {
    assert.deepEqual(dailyVm(overview()), [{ date: '2026-10-08', count: 3 }]);
    assert.deepEqual(dailyVm(null), []);
    assert.deepEqual(dailyVm({ daily: [{ date: '2026-10-01', count: '2' }] }), [{ date: '2026-10-01', count: 2 }]);
  });
});

describe('the locale carries every key the page reads', () => {
  it('in all three languages', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'client/src/pages/Home/overview-vm.js'), 'utf8')
      + fs.readFileSync(path.join(repoRoot, 'client/src/pages/Home/HomePage.jsx'), 'utf8');
    const keys = [...src.matchAll(/t\('(home\.[\w.]+)'\)|'(home\.[\w.]+)'/g)].map((m) => m[1] ?? m[2]);
    assert.ok(keys.length > 20);
    for (const loc of ['zh', 'en', 'ja']) {
      const d = JSON.parse(fs.readFileSync(path.join(repoRoot, `client/src/i18n/${loc}.json`), 'utf8'));
      for (const k of keys) assert.ok(d[k], `${loc}.json has no ${k}`);
    }
  });
});
