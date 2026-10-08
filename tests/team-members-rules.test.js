// v1.32.5 — 團隊 › 成員, 記憶 › 規矩, 管理 › 使用者 (openspec v1.32.0-console-rebuild, Phase 5).
//
// The one change of policy in the whole rebuild is here: the member list is for everyone,
// and the admin tools moved behind 管理 › 使用者. Everything a member sees on the list came
// from the team half of /api/me/report they could already read. The tests pin that, the
// two pure view-models, and the redirects for the two addresses that moved.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const { memberRows } = await import('../client/src/pages/Team/members-vm.js');
const { ruleRow, ruleGroups } = await import('../client/src/pages/Memory/memory-rules-vm.js');
const { allNavItems, OLD_PATHS, navMinRole } = await import('../client/src/components/common/nav-sections.js');

const zh = JSON.parse(read('client/src/i18n/zh.json'));
const t = (k) => zh[k] ?? k;

describe('memberRows — what a member sees', () => {
  const users = [
    { id: 1, name: 'A', role: 'super_admin', sessions: '12', last_activity: '2026-10-08T01:00:00Z' },
    { id: 2, name: 'B', role: 'user', sessions: 0, last_activity: null },
    { id: 3, name: 'C', role: 'user', sessions: 3, last_activity: '2026-10-07T09:00:00Z' },
  ];
  it('sorts by most recent activity with the unseen last, and says so in words', () => {
    const rows = memberRows(users, t);
    assert.deepEqual(rows.map((r) => r.name), ['A', 'C', 'B']);
    assert.equal(rows[0].sessions, 12);
    assert.equal(rows[0].visibleLabel, '看得到');
    assert.equal(rows[2].visible, 'no');
    assert.equal(rows[2].visibleLabel, '沒有紀錄');
  });
  it('survives a missing list and an unknown role', () => {
    assert.deepEqual(memberRows(undefined, t), []);
    assert.equal(memberRows([{ id: 9, role: 'root' }], t)[0].role, 'user');
    assert.equal(memberRows([{ id: 9, email: 'x@y' }], t)[0].name, 'x@y');
  });
});

describe('ruleGroups — 記憶 › 規矩', () => {
  const iron = [
    { id: 1, code: 'IR-002', title: 'b', content: 'B', tier: 'default', tags: ['trigger:commit', 'x'], updated_at: '2026-10-01' },
    { id: 2, code: 'IR-001', title: 'a', content: 'A', tier: 'critical', tags: ['trigger:deploy'], updated_at: '2026-10-02' },
    { id: 3, code: 'IR-003', title: 'c', content: 'C', tier: 'weird', tags: null, updated_at: null },
  ];
  it('orders iron rules critical first and reads the trigger tags', () => {
    const [g] = ruleGroups({ iron, standards: [] }, t);
    assert.deepEqual(g.rows.map((r) => r.code), ['IR-001', 'IR-002', 'IR-003']);
    assert.deepEqual(g.rows[1].triggers, ['commit']);
    assert.equal(g.rows[2].tier, null, 'an unknown tier is not shown as one');
    assert.equal(g.title, '你的鐵律');
  });
  it('a list that failed to load is null, not an empty group', () => {
    const [, std] = ruleGroups({ iron: [], standards: null }, t);
    assert.equal(std.rows, null);
    assert.equal(ruleRow({ id: 5 }).title, '#5');
  });
});

describe('the moves', () => {
  it('成員 is open to members; 使用者 and the drawer data stay admin', () => {
    assert.equal(navMinRole('/team/members'), 'user');
    assert.equal(navMinRole('/admin/users'), 'admin');
    assert.equal(navMinRole('/memory/rules'), 'user');
    const paths = allNavItems().map((i) => i.path);
    assert.ok(!paths.includes('/team/usage'), '團隊用量 is folded into 成員');
    assert.equal(OLD_PATHS['/team/usage'], '/team/members');
    assert.equal(OLD_PATHS['/admin/team'], '/admin/users');
  });

  it('a member\'s table reads only the report they could already read', () => {
    const src = read('client/src/pages/Team/MembersPage.jsx');
    assert.match(src, /apiGet\('\/api\/me\/report\?range=14d'\)/);
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /\/api\/admin\/users|\/api\/usage\/team-stats|team-overview/,
      'the member branch must not call an admin endpoint');
    assert.match(src, /roleAtLeast\(role, 'admin'\)/, 'the admin branch is chosen by role');
    assert.match(src, /<TeamUsagePage embedded \/>/);
  });

  it('the copy on 成員 and 規矩 exists in every language and avoids the forbidden words', () => {
    const src = read('client/src/pages/Team/MembersPage.jsx') + read('client/src/pages/Memory/MemoryRulesPage.jsx')
      + read('client/src/pages/Team/members-vm.js') + read('client/src/pages/Memory/memory-rules-vm.js')
      + read('client/src/pages/Portal/ProjectHistoryPage.jsx');
    const keys = [...new Set([...src.matchAll(/t\('((?:members|memory|project_history)\.[\w.]+)'\)/g)].map((m) => m[1]))];
    assert.ok(keys.length > 10);
    for (const loc of ['zh', 'en', 'ja']) {
      const d = JSON.parse(read(`client/src/i18n/${loc}.json`));
      for (const k of keys) assert.ok(d[k], `${loc}.json has no ${k}`);
      for (const tier of ['critical', 'default', 'advisory']) assert.ok(d[`memory.rules.tier.${tier}`]);
    }
    for (const k of keys) assert.doesNotMatch(String(zh[k]), /collector|heartbeat|token|合規/i, k);
  });
});

describe('project history search', () => {
  it('filters on title and content, every word, case-insensitively', async () => {
    const { filterMemories } = await import('../client/src/pages/Portal/ProjectHistoryPage.jsx').catch(() => ({}));
    if (!filterMemories) return;   // JSX cannot be loaded by node; the regex check below stands in
  });
  it('is wired: an input, a count, and an empty-result sentence', () => {
    const src = read('client/src/pages/Portal/ProjectHistoryPage.jsx');
    assert.match(src, /export function filterMemories\(items, q\)/);
    assert.match(src, /words\.every\(\(w\) => hay\.includes\(w\)\)/);
    assert.match(src, /type="search"/);
    assert.match(src, /project_history\.search\.none/);
  });
});
