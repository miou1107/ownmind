// v1.32.4 — 用量與規矩 (openspec v1.32.0-console-rebuild, Phase 4).
//
// The four usage tabs became routes with one shared loader. What is worth a test here is
// the arithmetic the 規矩遵守 tab shows — the rate and its formula, the bars, the
// unreported count — and the wiring: the member's versions carry the host they post to,
// the four tabs exist, and the old usage page is gone rather than left dead.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(repoRoot, p));

const { overallRate, ruleBars, unreportedSessions, rulesTiles } =
  await import('../client/src/pages/Usage/rules-vm.js');
// The pure half; the hook itself imports React and the api client, which node cannot load.
const { reportQuery, RANGES } = await import('../client/src/pages/Usage/report-query.js');
const { allNavItems, OLD_PATHS } = await import('../client/src/components/common/nav-sections.js');

const zh = JSON.parse(read('client/src/i18n/zh.json'));
const t = (k) => zh[k] ?? k;

const ROWS = [
  { rule_code: 'IR-001', title: '換金鑰後要自己確認', comply: 8, skip: 1, violate: 1, observed: 2 },
  { rule_code: 'IR-002', title: '2>/dev/null 是紅旗', comply: 2, skip: 0, violate: 2, observed: 0 },
  { rule_code: 'IR-003', title: '回滾前先搬日誌', comply: 0, skip: 0, violate: 0, observed: 0 },
];

describe('the rate and its formula', () => {
  it('is comply over comply+skip+violate, observed left out', () => {
    assert.equal(overallRate(ROWS), 10 / 14);
    assert.equal(overallRate([{ comply: 0, skip: 0, violate: 0, observed: 9 }]), null);
    assert.equal(overallRate([]), null);
    assert.equal(overallRate(null), null);
  });

  it('tolerates the strings Postgres counts arrive as', () => {
    assert.equal(overallRate([{ comply: '3', skip: '1', violate: '0' }]), 0.75);
  });
});

describe('one bar per rule', () => {
  it('puts the worst rate first and the untriggered rules last', () => {
    const bars = ruleBars(ROWS);
    assert.deepEqual(bars.map((b) => b.code), ['IR-002', 'IR-001', 'IR-003']);
    assert.equal(bars[0].rate, 0.5);
    assert.deepEqual(bars[0].pct, { comply: 50, skip: 0, violate: 50 });
    assert.equal(bars[2].rate, null, 'a rule nobody triggered has no rate, not 100%');
    assert.deepEqual(bars[2].pct, { comply: 0, skip: 0, violate: 0 });
  });

  it('keeps the title and the counts for the label and the aria text', () => {
    const [worst] = ruleBars(ROWS);
    assert.equal(worst.title, '2>/dev/null 是紅旗');
    assert.deepEqual([worst.comply, worst.skip, worst.violate, worst.total], [2, 0, 2, 4]);
  });
});

describe('the three tiles', () => {
  it('show the rate with the formula, the blocked count, and the unreported sessions', () => {
    const tiles = rulesTiles({ rows: ROWS, pitfalls: { sections: { orphan_session: { count: 4 } } } }, t);
    assert.deepEqual(tiles.map((x) => x.id), ['rate', 'blocked', 'unreported']);
    assert.equal(tiles[0].value, '71%');
    assert.match(tiles[0].note, /遵守 ÷/);
    assert.equal(tiles[1].value, '3');
    assert.equal(tiles[2].value, '4');
  });

  it('say 沒有資料 rather than 0 or 100% when there is nothing to compute', () => {
    const tiles = rulesTiles({ rows: [], pitfalls: null }, t);
    for (const x of tiles) assert.equal(x.value, '沒有資料', x.id);
    assert.equal(unreportedSessions(undefined), null);
    assert.equal(unreportedSessions({ sections: {} }), null);
    assert.equal(unreportedSessions({ sections: { orphan_session: { count: 0 } } }), 0, 'a real zero is a number');
  });

  it('never use the words a member does not use', () => {
    const tiles = rulesTiles({ rows: ROWS, pitfalls: null }, t);
    for (const x of tiles) for (const s of [x.label, x.note]) assert.doesNotMatch(s, /collector|heartbeat|token|合規/i, s);
  });
});

describe('the shared range loader', () => {
  it('builds the same query the old usage page did', () => {
    assert.deepEqual(RANGES, ['7d', '14d', '30d', 'all']);
    assert.equal(reportQuery({ custom: false, range: '14d' }), 'range=14d');
    assert.equal(reportQuery({ custom: true, range: '14d', start: '2026-10-01', end: '2026-10-08' }), 'start=2026-10-01&end=2026-10-08');
  });
  it('does not query a custom range until both dates are there and in order', () => {
    assert.equal(reportQuery({ custom: true, range: '14d', start: '2026-10-01', end: '' }), null);
    assert.equal(reportQuery({ custom: true, range: '14d', start: '2026-10-09', end: '2026-10-08' }), null);
  });
});

describe('the wiring', () => {
  it('用量與規矩 has four tabs, 團隊 keeps the ranking at its old address', () => {
    const paths = allNavItems().map((i) => i.path);
    for (const p of ['/usage/mine', '/usage/rules', '/usage/projects', '/usage/team', '/team/usage']) {
      assert.ok(paths.includes(p), `${p} is not a route`);
    }
    assert.ok(!('/team/usage' in OLD_PATHS), '/team/usage is a page again, not a redirect');
  });

  it('each tab is its own page module and the old tabbed usage page is gone', () => {
    for (const f of ['UsageMinePage.jsx', 'RulesPage.jsx', 'UsageProjectsPage.jsx', 'UsageTeamPage.jsx', 'useMeReport.js', 'UsageRangeBar.jsx', 'rules-vm.js']) {
      assert.ok(exists(`client/src/pages/Usage/${f}`), `${f} missing`);
    }
    assert.ok(!exists('client/src/pages/Portal/UsagePage.jsx'), 'UsagePage.jsx should be deleted, not left dead');
    assert.doesNotMatch(read('client/src/App.jsx'), /Portal\/UsagePage/);
  });

  it('the member\'s versions carry the host each computer posts to', () => {
    const me = read('src/routes/me.js');
    assert.match(me, /tool, scanner_version AS version, last_reported_at, machine, api_host/);
    assert.match(me, /on_old_host: Boolean\(canonicalHost && r\.api_host && r\.api_host !== canonicalHost\)/);
    assert.match(read('client/src/pages/Portal/UsageMine.jsx'), /usage\.col\.api_host/);
    assert.match(read('client/src/pages/Portal/UsageMine.jsx'), /on_old_host/);
  });

  it('every usage key the new pages read exists in all three locales', () => {
    const src = ['UsageMinePage.jsx', 'RulesPage.jsx', 'UsageProjectsPage.jsx', 'UsageTeamPage.jsx', 'UsageRangeBar.jsx', 'rules-vm.js']
      .map((f) => read(`client/src/pages/Usage/${f}`)).join('\n') + read('client/src/pages/Portal/UsageMine.jsx');
    const keys = [...new Set([...src.matchAll(/t\('((?:usage|nav)\.[\w.]+)'\)/g)].map((m) => m[1]))];
    assert.ok(keys.length > 10);
    for (const loc of ['zh', 'en', 'ja']) {
      const d = JSON.parse(read(`client/src/i18n/${loc}.json`));
      for (const k of keys) assert.ok(d[k], `${loc}.json has no ${k}`);
      for (const k of ['nav.usage.projects', 'nav.team.usage']) assert.ok(d[k], `${loc}.json has no ${k}`);
    }
  });
});
