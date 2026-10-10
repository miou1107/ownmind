// 總覽 (GET /api/me/overview and the page's view-model).
//
// v1.32.2 built the page from queries the console already runs; the home redesign turned it
// into the two things the owner opens it for: is the AI keeping the rules, and how is the
// team using it. The claims worth a test:
//   - 「我的 AI 守規矩」 names the three rules missed most, by title, and compares with the
//     period before; a number the server does not have is 「沒有資料」, never 0 or 100%;
//   - 「團隊的 AI 守規矩」 is admin-only: everyone's checks pooled under the same formula,
//     the team's three most-forgotten rules, and the per-person table with problems first;
//   - 要你決定的事 lists only what moved in the last 7 days, at most five, one sentence each,
//     and says how many it left off (it hides, it never deletes);
//   - the footer is green only when it should be, and the copy avoids the words members
//     do not use.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { startServer } from './helpers/app-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { buildOverview, complianceRate, parseRange, createOverviewRouter, RECENT_DECISION_DAYS } =
  await import('../src/routes/me-overview.js');
const { headlineVm, rulesVm, teamRulesVm, teamVm, decisionsVm, footerVm, periodWords, numberOrNoData, MAX_DECISIONS } =
  await import('../client/src/pages/Home/overview-vm.js');

const zh = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client/src/i18n/zh.json'), 'utf8'));
const t = (k) => zh[k] ?? k;

// A fake database: answers each query by a word that identifies it. First match wins.
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
  ["WHERE user_id = $1 AND event = 'iron_rule_compliance'", [
    { rule_code: 'IR-004', current: true, comply: 80, skip: 1, violate: 3 },
    { rule_code: 'IR-007', current: true, comply: 10, skip: 0, violate: 5 },
    { rule_code: 'IR-009', current: true, comply: 3, skip: 2, violate: 0 },
    { rule_code: 'IR-010', current: true, comply: 7, skip: 0, violate: 1 },
    { rule_code: null, current: true, comply: 0, skip: 0, violate: 2 },
    { rule_code: 'IR-004', current: false, comply: 100, skip: 0, violate: 0 },
  ]],
  ['AS orphan_count', [{ orphan_count: 2 }]],
  ['AS last_active_at', [
    { user_id: 1, name: 'Vin', last_active_at: '2026-10-08T02:00:00Z', sessions: 40, comply: 95, skip: 0, violate: 5 },
    { user_id: 2, name: 'Eric', last_active_at: '2026-10-07T02:00:00Z', sessions: 12, comply: 6, skip: 2, violate: 2 },
    { user_id: 3, name: 'Michelle', last_active_at: '2026-09-10T02:00:00Z', sessions: 0, comply: 0, skip: 0, violate: 0 },
    { user_id: 4, name: 'Judy', last_active_at: '2026-10-06T02:00:00Z', sessions: 9, comply: 50, skip: 0, violate: 0 },
  ]],
  // the whole team pooled, two windows: this week 161 comply, 13 missed; last week 198 / 2
  ['every member pooled', [
    { rule_code: 'IR-007', current: true, comply: 90, skip: 1, violate: 6 },
    { rule_code: 'IR-004', current: true, comply: 60, skip: 0, violate: 3 },
    { rule_code: 'IR-001', current: true, comply: 11, skip: 2, violate: 0 },
    { rule_code: null, current: true, comply: 0, skip: 0, violate: 1 },
    { rule_code: 'IR-007', current: false, comply: 100, skip: 0, violate: 0 },
    { rule_code: 'IR-004', current: false, comply: 98, skip: 2, violate: 0 },
  ]],
  ['AS n FROM handoffs', [{ n: 67 }]],
  ['AS n FROM session_lessons', [{ n: 52 }]],
  ['AS n FROM tasks', [{ n: 2 }]],
  ['AS n FROM bug_reports', [{ n: 4 }]],
  ['GROUP BY LOWER(TRIM(COALESCE(project', [
    { project: 'idaytour', count: 1, latest_at: '2026-10-07T01:00:00Z' },
    { project: 'ownmind', count: 3, latest_at: '2026-10-05T01:00:00Z' },
  ]],
  ['FROM session_lessons', [{ count: 5, latest_at: '2026-10-08T01:00:00Z' }]],
  ['AS recent_tasks', [{ recent_tasks: 1, recent_bugs: 1 }]],
  ['FROM tasks', [{ id: 3, title: '重錄 6 張截圖', project: 'idaytour', done_at: '2026-10-06T01:00:00Z' }]],
  ['FROM bug_reports', [{ id: 9, title: '收工面板讀不到日誌', reporter_name: 'Eric', updated_at: '2026-10-08T02:00:00Z' }]],
  ['FROM memories', [
    { code: 'IR-007', title: '回我話要用白話中文' },
    { code: 'IR-004', title: '開工先同步遠端' },
  ]],
];

const user = { id: 7, role: 'user' };
const adminUser = { id: 1, role: 'admin' };
const NOW = new Date('2026-10-08T03:00:00Z');
const build = (u = user, answers = baseAnswers(), over = {}) => {
  const fq = fakeQuery(answers);
  return buildOverview({ query: fq.query, user: u, rangeDays: 7, canonicalHost: 'fapa.welcometw.com', now: NOW, ...over })
    .then((o) => ({ o, calls: fq.calls }));
};

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

describe('buildOverview — AI 守規矩', () => {
  it('rate, previous rate, counts and the unreported sessions', async () => {
    const { o } = await build();
    // current: comply 100, missed 1+3 + 5 + 2 + 1 + 2 (no code) = 14
    assert.equal(o.rules.comply, 100);
    assert.equal(o.rules.missed, 14);
    assert.equal(o.rules.total, 114);
    assert.ok(Math.abs(o.rules.rate - 100 / 114) < 1e-9);
    assert.equal(o.rules.previous_rate, 1);
    assert.equal(o.rules.unreported, 2);
  });

  it('names the three rules missed most (skip + violate), worst first, by title', async () => {
    const { o } = await build();
    assert.deepEqual(o.rules.top_missed.map((r) => [r.code, r.missed]),
      [['IR-007', 5], ['IR-004', 4], ['IR-009', 2]]);
    assert.equal(o.rules.top_missed[0].title, '回我話要用白話中文');
    assert.equal(o.rules.top_missed[2].title, null, 'a code with no memory has no title, not a made-up one');
  });

  it('a miss without a rule code counts against the rate but is never named', async () => {
    const { o } = await build();
    assert.ok(o.rules.top_missed.every((r) => r.code));
  });

  it('looks titles up once, by every code, preferring the caller\'s own rule', async () => {
    const { calls } = await build();
    const q = calls.filter((c) => c.sql.includes('FROM memories'));
    assert.equal(q.length, 1);
    assert.deepEqual(q[0].params[0], ['IR-007', 'IR-004', 'IR-009']);
    assert.equal(q[0].params[1], 7);
    assert.match(q[0].sql, /\(user_id = \$2\) DESC/);
  });

  it('nothing reported: no rate, no lookup', async () => {
    const a = baseAnswers();
    a[3] = ["WHERE user_id = $1 AND event = 'iron_rule_compliance'", EMPTY];
    const { o, calls } = await build(user, a);
    assert.equal(o.rules.rate, null);
    assert.equal(o.rules.previous_rate, null);
    assert.deepEqual(o.rules.top_missed, []);
    assert.ok(!calls.some((c) => c.sql.includes('FROM memories')));
  });
});

describe('buildOverview — 團隊的 AI 守規矩', () => {
  it('a member gets no team numbers, and the pooled query is not run', async () => {
    const { o, calls } = await build(user);
    assert.equal(o.team_rules, null);
    assert.ok(!calls.some((c) => c.sql.includes('every member pooled')));
  });

  it('an admin gets everyone\'s checks pooled, this period and the one before', async () => {
    const { o, calls } = await build(adminUser);
    const T = o.team_rules;
    assert.equal(T.comply, 161);
    assert.equal(T.missed, 13);
    assert.equal(T.total, 174);
    assert.ok(Math.abs(T.rate - 161 / 174) < 1e-9);
    assert.ok(Math.abs(T.previous_rate - 198 / 200) < 1e-9);
    assert.equal(T.unreported, undefined, 'the team card has no unreported footnote');
    const sql = calls.find((c) => c.sql.includes('every member pooled')).sql;
    assert.doesNotMatch(sql, /user_id/, 'pooled over every member, not scoped to the caller');
    assert.match(sql, /NOT LIKE 'system_%'/);
    assert.match(sql, /INTERVAL '14 days'/, 'two windows of the range');
  });

  it('names the team\'s three most-forgotten rules, by title; the caller\'s own card is unchanged', async () => {
    const { o } = await build(adminUser);
    assert.deepEqual(o.team_rules.top_missed.map((r) => [r.code, r.title, r.missed]), [
      ['IR-007', '回我話要用白話中文', 7],
      ['IR-004', '開工先同步遠端', 3],
      ['IR-001', null, 2],
    ]);
    assert.deepEqual(o.rules.top_missed.map((r) => [r.code, r.missed]),
      [['IR-007', 5], ['IR-004', 4], ['IR-009', 2]]);
  });

  it('looks titles up once for both cards, by every code', async () => {
    const { calls } = await build(adminUser);
    const q = calls.filter((c) => c.sql.includes('FROM memories'));
    assert.equal(q.length, 1);
    assert.deepEqual([...q[0].params[0]].sort(), ['IR-001', 'IR-004', 'IR-007', 'IR-009']);
  });

  it('nothing reported by anyone: no team rate, no made-up number', async () => {
    const a = baseAnswers();
    a[a.findIndex(([k]) => k === 'every member pooled')] = ['every member pooled', EMPTY];
    const { o } = await build(adminUser, a);
    assert.equal(o.team_rules.rate, null);
    assert.equal(o.team_rules.previous_rate, null);
    assert.deepEqual(o.team_rules.top_missed, []);
  });
});

describe('buildOverview — 每個人用得怎樣', () => {
  it('a member gets no team, and the team query is not run', async () => {
    const { o, calls } = await build(user);
    assert.equal(o.team, null);
    assert.ok(!calls.some((c) => c.sql.includes('AS last_active_at')));
  });

  it('an admin gets everyone, with the card\'s formula and counted-once sessions', async () => {
    const { o, calls } = await build(adminUser);
    assert.equal(o.team.length, 4);
    const eric = o.team.find((p) => p.name === 'Eric');
    assert.equal(eric.rate, 0.6);
    assert.equal(eric.missed, 4);
    assert.equal(eric.sessions, 12);
    assert.equal(o.team.find((p) => p.name === 'Vin').is_me, true);
    assert.equal(o.team.find((p) => p.name === 'Michelle').inactive_14d, true);
    assert.equal(o.team.find((p) => p.name === 'Judy').inactive_14d, false);
    const sql = calls.find((c) => c.sql.includes('AS last_active_at')).sql;
    assert.match(sql, /COUNT\(DISTINCT COALESCE\(a\.details->>'session_id', a\.id::text\)\)/);
    assert.match(sql, /NOT LIKE 'system_%'/, 'system-observed rows are not the AI\'s answer');
  });

  it('nobody with no activity at all reads as active', async () => {
    const a = baseAnswers();
    a[5] = ['AS last_active_at', [{ user_id: 5, name: 'New', last_active_at: null, sessions: 0, comply: 0, skip: 0, violate: 0 }]];
    const { o } = await build(adminUser, a);
    assert.equal(o.team[0].inactive_14d, true);
    assert.equal(o.team[0].rate, null);
  });
});

describe('buildOverview — 要你決定的事', () => {
  it('only the last 7 days, grouped handoffs, and how many it left off', async () => {
    const { o, calls } = await build(adminUser);
    const d = o.decisions;
    assert.equal(d.recent_days, RECENT_DECISION_DAYS);
    assert.deepEqual(d.handoffs.map((h) => [h.project, h.count]), [['idaytour', 1], ['ownmind', 3]]);
    assert.equal(d.lessons.count, 5);
    assert.equal(d.tasks[0].title, '重錄 6 張截圖');
    assert.equal(d.bugs[0].reporter_name, 'Eric');
    // waiting: 67 + 52 + 2 + 4 = 125; recent: 4 + 5 + 1 + 1 = 11
    assert.equal(d.hidden, 114);
    for (const needle of ['GROUP BY LOWER(TRIM(COALESCE(project', 'FROM session_lessons\n', 'AS recent_tasks']) {
      const c = calls.find((x) => x.sql.includes(needle));
      assert.ok(c, needle);
      assert.match(c.sql, /INTERVAL '7 days'/, needle);
    }
  });

  it('reads, never writes', async () => {
    const { calls } = await build(adminUser);
    for (const c of calls) assert.doesNotMatch(c.sql, /\b(UPDATE|DELETE|INSERT)\b/i, c.sql.slice(0, 60));
  });

  it('a member gets no bugs, and no bug query', async () => {
    const { o, calls } = await build(user);
    assert.equal(o.decisions.bugs, null);
    assert.equal(o.decisions.bugs_count, null);
    assert.ok(!calls.some((c) => c.sql.includes('bug_reports')));
  });
});

describe('buildOverview — footer lights', () => {
  it('is green on fresh memory loads and reporting machines', async () => {
    const { o } = await build();
    assert.equal(o.lights.memory.state, 'good');
    assert.equal(o.lights.reporting.state, 'good');
    assert.equal(o.lights.rules, undefined, 'the old 規矩檢查 light became the card\'s footnote');
  });

  it('turns red when a machine posts to another host (issue #152)', async () => {
    const a = baseAnswers();
    a[1] = ['GROUP BY machine', [
      { machine: 'LAPTOP-G95HIQ3V', api_host: 'kkvin.com', last_reported_at: '2026-10-08T00:00:00Z' },
      { machine: 'TANK', api_host: 'fapa.welcometw.com', last_reported_at: '2026-10-08T00:00:00Z' },
    ]];
    const { o } = await build(user, a);
    assert.equal(o.lights.reporting.state, 'bad');
    assert.deepEqual(o.lights.reporting.machines.map((m) => [m.machine, m.on_old_host]),
      [['LAPTOP-G95HIQ3V', true], ['TANK', false]]);
  });

  it('turns yellow when a tool used this week has a silent collector', async () => {
    const a = baseAnswers();
    a[2] = ['LEFT JOIN hb ON', [{ tool: 'codex' }]];
    const { o } = await build(user, a);
    assert.equal(o.lights.reporting.state, 'warn');
  });

  it('says "none", not green, when there is nothing to judge', async () => {
    const a = baseAnswers();
    a[0] = ['AS inits_24h', [{ last_init_at: null, inits_24h: 0, inits_7d: 0 }]];
    a[1] = ['GROUP BY machine', EMPTY];
    const { o } = await build(user, a);
    assert.equal(o.lights.memory.state, 'none');
    assert.equal(o.lights.reporting.state, 'none');
  });

  it('flags nobody as on an old host when the server has no canonical host', async () => {
    const a = baseAnswers();
    a[1] = ['GROUP BY machine', [{ machine: 'X', api_host: 'kkvin.com', last_reported_at: '2026-10-08T00:00:00Z' }]];
    const { o } = await build(user, a, { canonicalHost: null });
    assert.equal(o.lights.reporting.state, 'good');
  });
});

describe('buildOverview — scope', () => {
  it('every per-user query is scoped to the caller', async () => {
    const { calls } = await build(user);
    const perUser = calls.filter((c) => /user_id = \$1/.test(c.sql));
    assert.ok(perUser.length >= 9);
    for (const c of perUser) assert.equal(c.params[0], 7, c.sql.slice(0, 60));
  });

  it('the range is one of three fixed windows, interpolated only after parsing', async () => {
    const { calls } = await build(user, baseAnswers(), { rangeDays: parseRange("7'; DROP TABLE users; --") });
    assert.ok(calls.every((c) => !c.sql.includes('DROP TABLE')));
    assert.ok(calls.some((c) => c.sql.includes("INTERVAL '7 days'")));
  });

  it('the stat tiles and the daily chart are gone', async () => {
    const { o, calls } = await build(adminUser);
    assert.equal(o.tiles, undefined);
    assert.equal(o.daily, undefined);
    assert.ok(!calls.some((c) => c.sql.includes('generate_series')));
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
      assert.equal(body.team, null);
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
    reporting: { state: 'good', machines: [{ machine: 'TANK', on_old_host: false }], stale_tools: [] },
  },
  rules: {
    rate: 0.95, previous_rate: 1, comply: 95, missed: 5, total: 100, unreported: 3,
    top_missed: [
      { code: 'IR-007', title: '回我話要用白話中文', missed: 3 },
      { code: 'IR-004', title: '開工先同步遠端', missed: 1 },
      { code: 'IR-009', title: null, missed: 1 },
    ],
  },
  team: null,
  decisions: {
    recent_days: 7,
    handoffs: [{ project: 'idaytour', count: 1, latest_at: '2026-10-07T01:00:00Z' }],
    lessons: { count: 5, latest_at: '2026-10-08T01:00:00Z' },
    tasks: [], tasks_count: 0,
    bugs: null, bugs_count: null,
    hidden: 0,
  },
  ...over,
});

const teamRules = {
  rate: 0.9, previous_rate: 0.95, comply: 180, missed: 20, total: 200,
  top_missed: [
    { code: 'IR-007', title: '回我話要用白話中文', missed: 12 },
    { code: 'IR-001', title: null, missed: 5 },
  ],
};

const team = [
  { user_id: 1, name: 'Vin', is_me: true, sessions: 40, rate: 0.95, last_active_at: '2026-10-08T02:00:00Z', inactive_14d: false },
  { user_id: 2, name: 'Eric', is_me: false, sessions: 12, rate: 0.6, last_active_at: '2026-10-07T02:00:00Z', inactive_14d: false },
  { user_id: 3, name: 'Michelle', is_me: false, sessions: 0, rate: null, last_active_at: '2026-09-10T02:00:00Z', inactive_14d: true },
  { user_id: 4, name: 'Judy', is_me: false, sessions: 9, rate: 1, last_active_at: '2026-10-06T02:00:00Z', inactive_14d: false },
  { user_id: 5, name: 'Kevin', is_me: false, sessions: 3, rate: null, last_active_at: '2026-10-06T02:00:00Z', inactive_14d: false },
  { user_id: 6, name: 'Amy', is_me: false, sessions: 5, rate: 0.85, last_active_at: '2026-10-06T02:00:00Z', inactive_14d: false },
];

describe('periodWords', () => {
  it('7 days is 這週／上週, other ranges count days', () => {
    assert.deepEqual(periodWords(7, t), { cur: '這週', prev: '上週' });
    assert.deepEqual(periodWords(14, t), { cur: '這 14 天', prev: '前 14 天' });
  });
});

describe('headlineVm — one sentence about the period', () => {
  it('names a falling rate and the teammates worth a word', () => {
    const h = headlineVm(overview({ team }), t);
    assert.equal(h.title, '這週有 3 件事要你看');
    assert.equal(h.detail, 'AI 守規矩比上週差；Michelle 兩週沒用了；Eric 常忘規矩');
  });

  it('an admin reads the team\'s numbers, not their own', () => {
    // Own rate fell (95 < 100) but the team's did not: nothing about rules.
    const same = headlineVm(overview({ team, team_rules: { ...teamRules, previous_rate: 0.9 } }), t);
    assert.doesNotMatch(same.detail, /守規矩/);
    // The team's fell: the sentence says whose.
    const worse = headlineVm(overview({ team, team_rules: teamRules }), t);
    assert.match(worse.detail, /^團隊的 AI 守規矩比上週差；/);
    assert.doesNotMatch(worse.detail, /；AI 守規矩比/);
  });

  it('one or two things read as "mostly normal"', () => {
    const h = headlineVm(overview(), t);
    assert.equal(h.title, '這週大致正常，有 1 件事要你看');
    assert.equal(h.detail, 'AI 守規矩比上週差');
  });

  it('nothing to look at says so, and says there is nothing to do', () => {
    const h = headlineVm(overview({ rules: { rate: 1, previous_rate: 1 } }), t);
    assert.equal(h.title, '這週一切正常，你不用做什麼。');
    assert.equal(h.detail, '');
  });

  it('nothing arrived is not "all normal"', () => {
    const o = overview({ rules: { rate: null }, lights: { memory: { state: 'none' }, reporting: { state: 'none' } } });
    const h = headlineVm(o, t);
    assert.doesNotMatch(h.title, /一切正常/);
    assert.match(h.title, /還沒有你的 AI 的紀錄/);
  });

  it('a 14-day range says 這 14 天 and 前 14 天', () => {
    const h = headlineVm(overview({ range_days: 14 }), t);
    assert.match(h.title, /^這 14 天大致正常/);
    assert.equal(h.detail, 'AI 守規矩比前 14 天差');
  });

  it('someone who never started is not "two weeks without it"', () => {
    const o = overview({ rules: {}, team: [
      { user_id: 3, name: 'Michelle', sessions: 0, rate: null, inactive_14d: true, last_active_at: '2026-09-10T02:00:00Z' },
      { user_id: 8, name: 'New', sessions: 0, rate: null, inactive_14d: true, last_active_at: null },
    ] });
    assert.equal(headlineVm(o, t).detail, 'Michelle 兩週沒用了；New 還沒開始用');
  });

  it('a computer on the old host is named in the headline too', () => {
    const o = overview({ rules: {}, lights: { memory: { state: 'good' }, reporting: { state: 'bad', machines: [] } } });
    assert.equal(headlineVm(o, t).detail, '有電腦沒把用量傳回來');
  });
});

describe('rulesVm — the card', () => {
  it('big number, last week, badge, one sentence, three rules', () => {
    const r = rulesVm(overview(), t);
    assert.equal(r.value, '95%');
    assert.equal(r.compare, '上週是 100%');
    assert.deepEqual(r.badge, { kind: 'worse', text: '比上週差' });
    assert.equal(r.sentence, '100 次裡有 5 次 AI 沒照規矩做');
    assert.deepEqual(r.top.map((x) => [x.title, x.text]), [
      ['回我話要用白話中文', '忘了 3 次'],
      ['開工先同步遠端', '忘了 1 次'],
      ['沒有標題的規矩 IR-009', '忘了 1 次'],
    ]);
    assert.equal(r.footnote, '另外有 3 場對話 AI 沒交成績，所以沒算進去。');
  });

  it('better, same, and nothing to compare with', () => {
    assert.equal(rulesVm(overview({ rules: { rate: 0.9, previous_rate: 0.8, total: 10, missed: 1 } }), t).badge.text, '比上週好');
    assert.equal(rulesVm(overview({ rules: { rate: 0.9, previous_rate: 0.9, total: 10, missed: 1 } }), t).badge.text, '跟上週一樣');
    const none = rulesVm(overview({ rules: { rate: 0.9, previous_rate: null, total: 10, missed: 1 } }), t);
    assert.equal(none.badge, null);
    assert.equal(none.compare, '上週沒有資料可以比');
  });

  it('no misses: says so, and says there is nothing to do', () => {
    const r = rulesVm(overview({ rules: { rate: 1, previous_rate: 1, total: 20, missed: 0, top_missed: [] } }), t);
    assert.match(r.sentence, /20 次 AI 都有照規矩做/);
    assert.equal(r.empty, '每一條 AI 都有照做。');
    assert.equal(r.footnote, null);
  });

  it('no rate is 沒有資料, never 0% or 100%', () => {
    const r = rulesVm(overview({ rules: { rate: null, unreported: 4 } }), t);
    assert.equal(r.value, '沒有資料');
    assert.equal(r.hasData, false);
    assert.deepEqual(r.top, []);
    assert.match(r.footnote, /4 場/);
    assert.equal(rulesVm(null, t).value, '沒有資料');
    assert.equal(numberOrNoData(undefined, t), '沒有資料');
    assert.equal(numberOrNoData(0, t), '0', 'a real zero is a number');
  });
});

describe('teamRulesVm — the team card', () => {
  it('a member has no team card', () => {
    assert.equal(teamRulesVm(overview(), t), null);
    assert.equal(teamRulesVm(overview({ team_rules: null }), t), null);
  });

  it('big number, last week, badge, the sentence without "AI", the team\'s rules', () => {
    const r = teamRulesVm(overview({ team, team_rules: teamRules }), t);
    assert.equal(r.value, '90%');
    assert.equal(r.compare, '上週是 95%');
    assert.deepEqual(r.badge, { kind: 'worse', text: '比上週差' });
    assert.equal(r.sentence, '200 次裡有 20 次沒照規矩做');
    assert.deepEqual(r.top.map((x) => [x.title, x.text]), [
      ['回我話要用白話中文', '忘了 12 次'],
      ['沒有標題的規矩 IR-001', '忘了 5 次'],
    ]);
    assert.equal(r.footnote, null, 'unreported sessions are the owner\'s own footnote');
  });

  it('no misses, and no rate, say so in the team\'s words', () => {
    const all = teamRulesVm(overview({ team_rules: { rate: 1, previous_rate: 1, total: 30, missed: 0, top_missed: [] } }), t);
    assert.equal(all.sentence, '30 次都有照規矩做，你不用做什麼');
    assert.equal(all.empty, '每一條大家的 AI 都有照做。');
    const none = teamRulesVm(overview({ team_rules: { rate: null } }), t);
    assert.equal(none.value, '沒有資料');
    assert.match(none.sentence, /團隊的 AI 沒有回報/);
  });
});

describe('teamVm — who uses it well, who does not', () => {
  it('a member has no table', () => {
    assert.equal(teamVm(overview(), t), null);
  });

  it('one plain verdict each, problems first', () => {
    const rows = teamVm(overview({ team }), t);
    assert.deepEqual(rows.map((r) => [r.rawName, r.verdict, r.tone]), [
      ['Michelle', '兩週沒用，要問一下', 'danger'],
      ['Eric', '常忘規矩，可以聊聊', 'warning'],
      ['Vin', '用最多，表現好', 'success'],
      ['Judy', '守最好', 'success'],
      ['Amy', '正常', 'muted'],
      ['Kevin', 'AI 沒交成績，看不出來', 'muted'],
    ]);
    const vin = rows.find((r) => r.rawName === 'Vin');
    assert.equal(vin.name, 'Vin（你）');
    assert.equal(vin.rate, '95%');
    assert.equal(vin.sessions, '40 次');
    assert.equal(rows.find((r) => r.rawName === 'Kevin').rate, '沒有資料');
  });

  it('the busiest person is not praised when they often forget', () => {
    const rows = teamVm(overview({ team: [
      { user_id: 1, name: 'A', sessions: 50, rate: 0.5, inactive_14d: false, last_active_at: 'x' },
      { user_id: 2, name: 'B', sessions: 2, rate: 0.95, inactive_14d: false, last_active_at: 'x' },
    ] }), t);
    assert.deepEqual(rows.map((r) => r.verdict), ['常忘規矩，可以聊聊', '守最好']);
  });

  it('someone who never used it, and someone idle this week', () => {
    const rows = teamVm(overview({ team: [
      { user_id: 1, name: 'New', sessions: 0, rate: null, inactive_14d: true, last_active_at: null },
      { user_id: 2, name: 'Quiet', sessions: 0, rate: null, inactive_14d: false, last_active_at: '2026-10-01T00:00:00Z' },
    ] }), t);
    assert.deepEqual(rows.map((r) => r.verdict), ['還沒用過，要問一下', '這週沒用']);
  });
});

describe('decisionsVm — at most five, one sentence each', () => {
  it('lessons, handoffs, tasks, bugs read as what he must decide', () => {
    const o = overview({ decisions: {
      recent_days: 7,
      handoffs: [
        { project: 'idaytour', count: 1, latest_at: '2026-10-07T01:00:00Z' },
        { project: 'ownmind', count: 3, latest_at: '2026-10-03T01:00:00Z' },
      ],
      lessons: { count: 5, latest_at: '2026-10-08T01:00:00Z' },
      tasks: [{ id: 3, title: '重錄截圖', done_at: '2026-10-06T01:00:00Z' }], tasks_count: 1,
      bugs: [{ id: 9, title: '收工面板讀不到日誌', reporter_name: 'Eric', updated_at: '2026-10-08T02:00:00Z' }], bugs_count: 1,
      hidden: 114,
    } });
    const d = decisionsVm(o, t);
    assert.equal(d.count, 5);
    assert.deepEqual(d.items.map((x) => [x.text, x.to]), [
      ['Eric 回報一個問題：收工面板讀不到日誌', '/inbox/bugs'],
      ['AI 學到 5 件新事，要不要記住？', '/inbox/lessons'],
      ['idaytour 有一份沒做完的工作，要接著做嗎？', '/inbox/handoffs'],
      ['AI 做完了「重錄截圖」，要你看一下做得對不對', '/inbox/tasks'],
      ['ownmind 有 3 份沒做完的工作，要接著做嗎？', '/inbox/handoffs'],
    ]);
    assert.equal(d.more, null);
    assert.equal(d.note, '另外 114 件超過 7 天沒動，這裡先收起來，在「待你處理」還找得到。');
  });

  it('never more than five, and says how many more there are', () => {
    const handoffs = Array.from({ length: 8 }, (_, i) => ({ project: `p${i}`, count: 1, latest_at: `2026-10-0${i + 1}T00:00:00Z` }));
    const d = decisionsVm(overview({ decisions: { recent_days: 7, handoffs, lessons: { count: 0 }, tasks: [], tasks_count: 2, bugs: null, hidden: 0 } }), t);
    assert.equal(d.items.length, MAX_DECISIONS);
    assert.equal(d.count, 10, 'tasks beyond the listed ones still count');
    assert.equal(d.more, '還有 5 件，去「待你處理」看');
    assert.equal(d.items[0].text, 'p7 有一份沒做完的工作，要接著做嗎？', 'newest first');
    assert.match(d.note, /超過 7 天沒動的事/);
  });

  it('empty says there is nothing to do', () => {
    const d = decisionsVm(overview({ decisions: { recent_days: 7, handoffs: [], lessons: { count: 0 }, tasks: [], bugs: null, hidden: 0 } }), t);
    assert.equal(d.count, 0);
    assert.deepEqual(d.items, []);
    assert.equal(d.empty, '最近 7 天沒有要你決定的事，你不用做什麼。');
    assert.equal(decisionsVm(null, t).count, 0);
  });
});

describe('footerVm — small, and red or yellow only when something is off', () => {
  it('two short green lines with no buttons', () => {
    const f = footerVm(overview(), t);
    assert.deepEqual(f.map((x) => [x.state, x.text, x.action]), [
      ['good', '記憶正常', null],
      ['good', '每台電腦都有連上', null],
    ]);
  });

  it('names the machine on the old host and points at the fix', () => {
    const o = overview({ lights: { memory: { state: 'warn' }, reporting: { state: 'bad', machines: [{ machine: 'LAPTOP-1', on_old_host: true }, { machine: 'TANK', on_old_host: false }] } } });
    const [mem, rep] = footerVm(o, t);
    assert.equal(mem.state, 'warn');
    assert.equal(mem.action.to, '/usage/mine');
    assert.equal(rep.state, 'bad');
    assert.match(rep.text, /LAPTOP-1/);
    assert.doesNotMatch(rep.text, /TANK/);
    assert.match(rep.text, /升級 OwnMind/);
  });

  it('an unknown or missing state renders as "none", never as green', () => {
    for (const l of footerVm(overview({ lights: { memory: { state: 'purple' }, reporting: {} } }), t)) assert.equal(l.state, 'none');
    for (const l of footerVm(null, t)) assert.equal(l.state, 'none');
  });
});

describe('the copy', () => {
  const homeKeys = Object.keys(zh).filter((k) => k.startsWith('home.'));

  it('never uses the words a member does not use', () => {
    // CLAUDE.md check 4, plus the prototype's list. Table headers and labels count too.
    for (const k of homeKeys) {
      assert.doesNotMatch(zh[k], /collector|heartbeat|token|合規|回執|同步|模式|遵守率|把關|unknown|timeout/i, `${k}: ${zh[k]}`);
    }
  });

  it('every key the page reads exists in all three languages, and no stale home key is left', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'client/src/pages/Home/overview-vm.js'), 'utf8')
      + fs.readFileSync(path.join(repoRoot, 'client/src/pages/Home/HomePage.jsx'), 'utf8');
    const used = new Set([...src.matchAll(/'(home\.[\w.]+)'/g)].map((m) => m[1]));
    assert.ok(used.size > 40);
    for (const loc of ['zh', 'en', 'ja']) {
      const d = JSON.parse(fs.readFileSync(path.join(repoRoot, `client/src/i18n/${loc}.json`), 'utf8'));
      for (const k of used) assert.ok(d[k], `${loc}.json has no ${k}`);
      assert.deepEqual(Object.keys(d).filter((k) => k.startsWith('home.')).sort(), [...homeKeys].sort(), `${loc}.json home keys differ from zh`);
    }
    // home.no_data and home.tiles are also read by other pages; everything else must be in use.
    const elsewhere = new Set(['home.tiles']);
    for (const k of homeKeys) assert.ok(used.has(k) || elsewhere.has(k), `${k} is not used any more`);
  });

  it('placeholders match across the three languages', () => {
    const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const loc of ['en', 'ja']) {
      const d = JSON.parse(fs.readFileSync(path.join(repoRoot, `client/src/i18n/${loc}.json`), 'utf8'));
      for (const k of homeKeys) assert.equal(ph(d[k]), ph(zh[k]), `${loc} ${k}`);
    }
  });
});
