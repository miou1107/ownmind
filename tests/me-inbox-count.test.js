// v1.32.3 — the number on 待你處理 (openspec v1.32.0-console-rebuild, Phase 3).
//
// Four counts the rail and the tab strip read. The claims: a member is never shown the
// bug count (and the query is not run for them); the total is the sum of what they may
// handle; a missing or failed answer shows nothing rather than 0; and every inbox page
// tells the rail when it handled something, so the number drops with the row.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { startServer } from './helpers/app-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const { buildPendingCount, createOverviewRouter } = await import('../src/routes/me-overview.js');
// The pure half; the hook itself imports React and the api client, which node cannot load.
const { inboxBadges } = await import('../client/src/hooks/inbox-badges.js');

function fakeQuery(rows) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    for (const [needle, n] of rows) if (sql.includes(needle)) return { rows: [{ n }] };
    return { rows: [] };
  };
  return { query, calls };
}
const ROWS = [['FROM handoffs', 2], ['FROM session_lessons', 3], ['FROM tasks', 1], ['FROM bug_reports', 5]];

describe('buildPendingCount', () => {
  it('counts what a member may handle and leaves bugs null, unqueried', async () => {
    const { query, calls } = fakeQuery(ROWS);
    const c = await buildPendingCount({ query, user: { id: 7, role: 'user' } });
    assert.deepEqual(c, { handoffs: 2, lessons: 3, tasks: 1, bugs: null, total: 6 });
    assert.ok(!calls.some((x) => x.sql.includes('bug_reports')));
    for (const x of calls) assert.equal(x.params[0], 7, 'every count is the caller\'s own');
  });

  it('adds the open bug reports for an admin', async () => {
    const { query } = fakeQuery(ROWS);
    const c = await buildPendingCount({ query, user: { id: 1, role: 'admin' } });
    assert.deepEqual(c, { handoffs: 2, lessons: 3, tasks: 1, bugs: 5, total: 11 });
  });

  it('is served under /api/me/overview/pending-count', async () => {
    const { query } = fakeQuery(ROWS);
    const router = createOverviewRouter({ query, auth: (req, _res, next) => { req.user = { id: 7, role: 'user' }; next(); } });
    const app = express();
    app.use('/api/me/overview', router);
    const server = await startServer(app);
    try {
      const res = await fetch(`${server.url}/api/me/overview/pending-count`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).total, 6);
    } finally {
      await server.close();
    }
  });
});

describe('inboxBadges — what the rail shows', () => {
  it('passes real numbers through, by tab and in total', () => {
    assert.deepEqual(inboxBadges({ handoffs: 2, lessons: 0, tasks: 1, bugs: null, total: 3 }),
      { total: 3, byTab: { handoffs: 2, lessons: 0, tasks: 1, bugs: null } });
  });
  it('shows nothing, not 0, before the first answer or after a failure', () => {
    assert.deepEqual(inboxBadges(null), { total: null, byTab: {} });
    assert.deepEqual(inboxBadges(undefined), { total: null, byTab: {} });
    assert.equal(inboxBadges({ total: 'many' }).total, null);
  });
});

describe('the rail and the tabs only render a positive number', () => {
  it('Sidebar guards the badge on typeof number and > 0', () => {
    const src = read('client/src/components/common/Sidebar.jsx');
    assert.match(src, /typeof badges\[entry\.id\] === 'number' && badges\[entry\.id\] > 0/);
  });
  it('Layout puts per-tab counts only on the inbox entry', () => {
    const src = read('client/src/components/common/Layout.jsx');
    assert.match(src, /entry\.id === 'inbox' && typeof inbox\.byTab\[tab\.id\] === 'number' && inbox\.byTab\[tab\.id\] > 0/);
    assert.match(src, /useInboxCount\(\)/);
  });
});

describe('every inbox page tells the rail when it handled something', () => {
  for (const file of [
    'client/src/pages/Portal/HandoffsPage.jsx',
    'client/src/pages/Portal/LessonsPage.jsx',
    'client/src/pages/Portal/TasksPage.jsx',
    'client/src/pages/Admin/BugReportsPage.jsx',
  ]) {
    it(`${path.basename(file)} calls notifyInboxChanged after the server accepted`, () => {
      const src = read(file);
      assert.match(src, /notifyInboxChanged\(\)/, `${file} never tells the rail`);
      assert.match(src, /import \{[^}]*notifyInboxChanged[^}]*\} from ['"][./]*hooks\/useInboxCount/);
    });
  }
  it('the event name is one constant, shared by the hook and the pages', () => {
    assert.match(read('client/src/api/events.js'), /export const INBOX_CHANGED = 'ownmind:inbox-changed'/);
    assert.match(read('client/src/hooks/useInboxCount.js'), /INBOX_CHANGED/);
  });
});

describe('the badge label exists in every language', () => {
  it('nav.badge.pending', () => {
    for (const loc of ['zh', 'en', 'ja']) {
      const d = JSON.parse(read(`client/src/i18n/${loc}.json`));
      assert.ok(d['nav.badge.pending'], `${loc}.json has no nav.badge.pending`);
      assert.match(d['nav.badge.pending'], /\{n\}/);
    }
  });
});
