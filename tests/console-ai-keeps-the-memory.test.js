// v1.33.0 — the console only shows and undoes (openspec v1.33.0-ai-keeps-the-memory,
// workstream D).
//
// Three pages used to wait for a person to press a button (留下, 審過, 接手); the AI now
// does those things and each page shows what it did with one undo per row. A fourth tab,
// 記憶 › 已歸檔, lists what the AI archived with 還原. What is worth a test: the row logic
// in the view-model files (node can load them), the wiring the JSX must carry (read as
// source), and the copy existing in all three languages.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const {
  LESSONS_PATH, RETRACT_REASON, lessonRow, applyLessonAction, lessonErrorKey,
} = await import('../client/src/pages/Portal/lessons-vm.js');
const {
  TASKS_MINE_PATH, TASKS_CLOSED_PATH, canReopen, splitTasks, teamTaskGroups, reopenedCard, moveReopened, reopenErrorKey,
} = await import('../client/src/pages/Portal/tasks-vm.js');
const { HANDOFFS_PATH, handoffGroups, reopenedHandoff } = await import('../client/src/pages/Portal/handoffs-vm.js');
const { archivedRows, archivedPayloadRows } = await import('../client/src/pages/Memory/memory-archived-vm.js');
const { navMinRole, navLabelKey } = await import('../client/src/components/common/nav-sections.js');
const { postMemoryWrite, SYNC_TOKEN_PATH, syncTokenOf } = await import('../client/src/lib/memory-write.js');

const LOCALES = ['zh', 'en', 'ja'];
const dicts = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`client/src/i18n/${l}.json`))]));

// ─────────────────────────────────────────────────────────────────────────────
// Lessons
// ─────────────────────────────────────────────────────────────────────────────

describe('lessons — the AI decided, the row shows what and offers one undo', () => {
  it('lists every state of the last 60 days', () => {
    assert.equal(LESSONS_PATH, '/api/session/lessons?status=all&days=60');
  });

  it('a kept lesson reads 「AI 留下了」 and its one action is 收回', () => {
    const row = lessonRow({ id: 1, status: 'promoted', memory_id: 42 });
    assert.equal(row.stateKey, 'lessons.state.promoted');
    assert.equal(dicts.zh[row.stateKey], 'AI 留下了');
    assert.equal(row.action, 'retract');
    assert.equal(dicts.zh[row.actionKey], '收回');
    assert.equal(row.memoryId, 42);
  });

  it('a dismissed lesson carries the reason the AI gave, and 還是留 brings it back', () => {
    const row = lessonRow({ id: 2, status: 'dismissed', reason: ' 已經修在 CLAUDE.md ' });
    assert.equal(row.stateKey, 'lessons.state.dismissed');
    assert.equal(dicts.zh[row.stateKey], 'AI 沒留：{reason}');
    assert.equal(row.reason, '已經修在 CLAUDE.md');
    assert.equal(row.action, 'keep');
    assert.equal(dicts.zh[row.actionKey], '還是留');
    // Without a reason the colon would dangle, so a second key carries the bare state.
    assert.equal(lessonRow({ id: 3, status: 'dismissed' }).stateKey, 'lessons.state.dismissed_no_reason');
  });

  it('a new lesson waits for the monthly pass; an unknown status is treated as new', () => {
    assert.equal(dicts.zh[lessonRow({ id: 4, status: 'new' }).stateKey], '等月底整理');
    assert.equal(lessonRow({ id: 5, status: 'weird' }).action, 'keep');
  });

  it('the retract reason is the sentence the spec fixed', () => {
    assert.equal(RETRACT_REASON, '從教訓頁收回');
  });

  it('after 收回 the row reads as let go with that reason; after 還是留 it reads as kept', () => {
    const items = [{ id: 1, status: 'promoted', memory_id: 42 }, { id: 2, status: 'new' }];
    const afterRetract = applyLessonAction(items, 1, 'retract');
    assert.deepEqual(afterRetract[0], { id: 1, status: 'dismissed', reason: RETRACT_REASON, memory_id: null });
    assert.deepEqual(afterRetract[1], items[1], 'other rows untouched');
    const afterKeep = applyLessonAction(items, 2, 'keep', { memory_id: 77 });
    assert.equal(afterKeep[1].status, 'promoted');
    assert.equal(afterKeep[1].memory_id, 77);
    assert.equal(applyLessonAction(items, 2, 'keep', {})[1].memory_id, null);
  });

  it('maps a refusal to a sentence key, never a raw status', () => {
    assert.equal(lessonErrorKey({ status: 409 }), 'lessons.already_resolved');
    assert.equal(lessonErrorKey({ status: 404 }), 'lessons.gone');
    assert.equal(lessonErrorKey({ status: 400, data: { rule: 'secret' } }), 'lessons.secret_refused');
    assert.equal(lessonErrorKey({ status: 500 }), 'lessons.action_error');
  });

  it('the page calls set and archive, and no longer promote or dismiss', () => {
    const src = read('client/src/pages/Portal/LessonsPage.jsx');
    assert.match(src, /\/api\/session\/lessons\/\$\{id\}\/set/);
    assert.match(src, /\/api\/memory\/\$\{memoryId\}\/archive/);
    assert.match(src, /status: 'promoted'/);
    assert.doesNotMatch(src, /\/promote|\/dismiss/);
    assert.doesNotMatch(src, /lessons\.promote'|lessons\.dismiss'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

describe('tasks — done with evidence closes the card; the page can only send it back', () => {
  const cards = [
    { id: 1, status: 'claimed' }, { id: 2, status: 'open' }, { id: 3, status: 'done', evidence: 'npm test → 212 passed' },
    { id: 4, status: 'reviewed' }, { id: 5, status: 'dropped' },
  ];

  it('only a closed card can be sent back', () => {
    assert.equal(canReopen({ status: 'done' }), true);
    assert.equal(canReopen({ status: 'reviewed' }), true);
    for (const s of ['open', 'claimed', 'dropped', undefined]) assert.equal(canReopen({ status: s }), false, String(s));
  });

  it('the personal page splits moving cards from closed ones', () => {
    const { active, closed } = splitTasks(cards);
    assert.deepEqual(active.map((c) => c.id), [1, 2, 5]);
    assert.deepEqual(closed.map((c) => c.id), [3, 4]);
    assert.deepEqual(splitTasks(null), { active: [], closed: [] });
  });

  it('the team page groups closed cards under 本月結案 and drops empty sections', () => {
    const groups = teamTaskGroups(cards);
    assert.deepEqual(groups.map((g) => g.id), ['claimed', 'open', 'closed', 'dropped']);
    assert.equal(groups[2].labelKey, 'tasks.closed_section');
    assert.equal(dicts.zh['tasks.closed_section'], '本月結案');
    assert.deepEqual(groups[2].cards.map((c) => c.id), [3, 4]);
    assert.deepEqual(teamTaskGroups([{ id: 9, status: 'open' }]).map((g) => g.id), ['open']);
  });

  it('a sent-back card is open again with its result and evidence cleared', () => {
    const c = reopenedCard({ id: 3, status: 'done', result: 'r', evidence: 'e', done_at: 'x', claimed_by: 7, holder_name: 'A', held_by_me: true });
    assert.equal(c.status, 'open');
    for (const k of ['result', 'evidence', 'done_at', 'claimed_by', 'holder_name']) assert.equal(c[k], null, k);
    assert.equal(c.held_by_me, false);
  });

  it('the personal page reads two lists: moving cards, and this month\'s closed ones', () => {
    assert.equal(TASKS_MINE_PATH, '/api/tasks?mine=true&full=true');
    assert.equal(TASKS_CLOSED_PATH, '/api/tasks?mine=true&full=true&closed=month');
    const src = read('client/src/pages/Portal/TasksPage.jsx');
    assert.match(src, /useTaskList\(TASKS_MINE_PATH\)/);
    assert.match(src, /useTaskList\(TASKS_CLOSED_PATH\)/);
  });

  it('after 退回 the card leaves 本月結案 and tops the active list as open', () => {
    const lists = { active: [{ id: 1, status: 'open' }], closed: [{ id: 3, status: 'done', evidence: 'e' }, { id: 4, status: 'reviewed' }] };
    const next = moveReopened(lists, 3);
    assert.deepEqual(next.active.map((c) => [c.id, c.status, c.evidence]), [[3, 'open', null], [1, 'open', undefined]]);
    assert.deepEqual(next.closed.map((c) => c.id), [4]);
    assert.deepEqual(moveReopened(lists, 99), lists, 'an unknown id changes nothing');
    assert.deepEqual(moveReopened({}, 1), { active: [], closed: [] });
  });

  it('maps a refusal to a sentence key', () => {
    assert.equal(reopenErrorKey({ status: 409 }), 'tasks.reopen_not_closed');
    assert.equal(reopenErrorKey({ status: 403 }), 'tasks.reopen_not_yours');
    assert.equal(reopenErrorKey({ status: 500 }), 'tasks.action_error');
  });

  it('neither task page calls review any more, both call reopen and show the evidence', () => {
    const mine = read('client/src/pages/Portal/TasksPage.jsx');
    const team = read('client/src/pages/Team/TeamTasksPage.jsx');
    assert.doesNotMatch(mine + team, /\/review|tasks\.review/);
    assert.match(mine, /\/api\/tasks\/\$\{id\}\/reopen/);
    assert.match(mine, /card\.evidence/);
    assert.match(mine, /tasks\.evidence_label/);
    assert.match(mine, /tasks\.closed_section/);
    assert.match(team, /useReopen/);
    assert.match(team, /teamTaskGroups/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handoffs
// ─────────────────────────────────────────────────────────────────────────────

describe('handoffs — the matching project accepts; the page shows and reopens', () => {
  const now = Date.parse('2026-10-21T10:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const rows = [
    { id: 1, status: 'pending', created_at: '2026-10-20T00:00:00Z' },
    { id: 2, created_at: '2026-10-21T00:00:00Z' },
    { id: 3, status: 'accepted', accepted_at: new Date(now - 2 * day).toISOString() },
    { id: 4, status: 'accepted', accepted_at: new Date(now - 8 * day).toISOString() },
    { id: 5, status: 'accepted', accepted_at: new Date(now - 1 * day).toISOString() },
  ];

  it('asks the pending route for the accepted rows of the last week too', () => {
    assert.equal(HANDOFFS_PATH, '/api/handoff/pending?with_accepted=7');
    assert.match(read('client/src/pages/Portal/HandoffsPage.jsx'), /apiGet\(HANDOFFS_PATH\)/);
  });

  it('pending rows newest first; a row without a status counts as pending', () => {
    assert.deepEqual(handoffGroups(rows, now).pending.map((h) => h.id), [2, 1]);
  });

  it('accepted rows of the last 7 days only, newest accept first', () => {
    assert.deepEqual(handoffGroups(rows, now).accepted.map((h) => h.id), [5, 3]);
    assert.deepEqual(handoffGroups(null, now), { pending: [], accepted: [] });
  });

  it('a reopened handoff is pending again with nobody holding it', () => {
    const h = reopenedHandoff({ id: 3, status: 'accepted', accepted_by: 'Vin', accepted_at: 'x' });
    assert.deepEqual(h, { id: 3, status: 'pending', accepted_by: null, accepted_at: null });
  });

  it('the page no longer accepts, no longer needs the profile, and calls reopen', () => {
    const src = read('client/src/pages/Portal/HandoffsPage.jsx');
    assert.doesNotMatch(src, /\/accept`|handoffs\.accept['_]|\/api\/me\/profile|profile_failed/);
    assert.match(src, /\/api\/handoff\/\$\{id\}\/reopen/);
    assert.match(src, /handoffs\.auto_accept/);
    assert.equal(dicts.zh['handoffs.auto_accept'], '會在那個專案開對話時自動接手');
    assert.equal(dicts.zh['handoffs.reopen'], '重開');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory › 已歸檔
// ─────────────────────────────────────────────────────────────────────────────

describe('memory — the archived tab lists what the AI archived, newest first, with 還原', () => {
  it('reads a bare array or a {data} envelope', () => {
    assert.deepEqual(archivedPayloadRows([{ id: 1 }]), [{ id: 1 }]);
    assert.deepEqual(archivedPayloadRows({ data: [{ id: 2 }] }), [{ id: 2 }]);
    assert.deepEqual(archivedPayloadRows(null), []);
    assert.deepEqual(archivedPayloadRows({ rows: [] }), []);
  });

  it('newest archive first, with the reason trimmed and a title fallback', () => {
    const rows = archivedRows([
      { id: 1, title: 'old', archived_at: '2026-09-01T00:00:00Z', archived_reason: ' 已結案 ' },
      { id: 2, archived_at: '2026-10-20T00:00:00Z', archived_reason: null },
      { id: 3, title: 'undated' },
    ]);
    assert.deepEqual(rows.map((r) => r.id), [2, 1, 3]);
    assert.equal(rows[1].reason, '已結案');
    assert.equal(rows[0].title, '#2');
    assert.equal(rows[0].reason, '');
  });

  it('is a tab under 記憶 that every member may see, wired to a page', () => {
    assert.equal(navMinRole('/memory/archived'), 'user');
    assert.equal(navLabelKey('/memory/archived'), 'nav.memory.archived');
    assert.equal(dicts.zh['nav.memory.archived'], '已歸檔');
    assert.match(read('client/src/App.jsx'), /'\/memory\/archived': <MemoryArchivedPage \/>/);
    const src = read('client/src/pages/Memory/MemoryArchivedPage.jsx');
    assert.match(src, /\/api\/memory\/archived/);
    assert.match(src, /\/api\/memory\/\$\{id\}\/restore/);
    assert.equal(dicts.zh['memory.archived.empty'], 'AI 還沒歸檔任何記憶');
    assert.equal(dicts.zh['memory.archived.intro'], 'AI 整理記憶時歸檔的條目都在這裡，還原後會回到使用中');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory writes carry a sync_token
// ─────────────────────────────────────────────────────────────────────────────

describe('memory writes — the console fetches a sync_token before archive and restore', () => {
  // A fake api pair: `tokens` is what each GET /sync-token answers in turn, `posts` what each
  // POST answers in turn; every call is recorded so the test can read the order and bodies.
  function fakeApi({ tokens, posts }) {
    const calls = [];
    const apiGet = async (path) => { calls.push(['GET', path]); return tokens.shift(); };
    const apiPost = async (path, body) => { calls.push(['POST', path, body]); return posts.shift(); };
    return { apiGet, apiPost, calls };
  }
  const token = (sync_token, extra = {}) => ({ ok: true, status: 200, data: { sync_token, ...extra } });

  it('reads the token out of the /sync-token answer and nothing else', () => {
    assert.equal(SYNC_TOKEN_PATH, '/api/memory/sync-token');
    assert.equal(syncTokenOf(token('abc', { lessons_waiting: 2 })), 'abc');
    assert.equal(syncTokenOf({ ok: true, status: 200, data: {} }), null);
    assert.equal(syncTokenOf({ ok: false, status: 500, error: 'x' }), null);
    assert.equal(syncTokenOf(undefined), null);
  });

  it('fetches the token first and sends it in the body with the caller\'s fields', async () => {
    const api = fakeApi({ tokens: [token('t1')], posts: [{ ok: true, status: 200, data: { id: 42 } }] });
    const r = await postMemoryWrite(api.apiPost, api.apiGet, '/api/memory/42/archive', { reason: RETRACT_REASON });
    assert.deepEqual(api.calls, [
      ['GET', '/api/memory/sync-token'],
      ['POST', '/api/memory/42/archive', { reason: RETRACT_REASON, sync_token: 't1' }],
    ]);
    assert.deepEqual(r, { ok: true, status: 200, data: { id: 42 } });
  });

  it('a body left out still sends the token', async () => {
    const api = fakeApi({ tokens: [token('t1')], posts: [{ ok: true, status: 200, data: {} }] });
    await postMemoryWrite(api.apiPost, api.apiGet, '/api/memory/7/restore');
    assert.deepEqual(api.calls[1][2], { sync_token: 't1' });
  });

  it('a 409 refetches the token once and retries with the new one', async () => {
    const stale = { ok: false, status: 409, error: 'stale', data: { code: 'sync_token_stale' } };
    const api = fakeApi({ tokens: [token('t1'), token('t2')], posts: [stale, { ok: true, status: 200, data: { id: 7 } }] });
    const r = await postMemoryWrite(api.apiPost, api.apiGet, '/api/memory/7/restore', {});
    assert.deepEqual(api.calls.map((c) => c.slice(0, 2)), [
      ['GET', '/api/memory/sync-token'], ['POST', '/api/memory/7/restore'],
      ['GET', '/api/memory/sync-token'], ['POST', '/api/memory/7/restore'],
    ]);
    assert.equal(api.calls[1][2].sync_token, 't1');
    assert.equal(api.calls[3][2].sync_token, 't2');
    assert.equal(r.ok, true);
  });

  it('a second 409 is returned as is: one retry, never a loop', async () => {
    const refused = { ok: false, status: 409, error: 'Only an archived memory can be restored', data: { status: 'active' } };
    const api = fakeApi({ tokens: [token('t1'), token('t2')], posts: [refused, refused] });
    const r = await postMemoryWrite(api.apiPost, api.apiGet, '/api/memory/7/restore', {});
    assert.equal(api.calls.length, 4);
    assert.equal(r, refused);
  });

  it('a refusal other than 409 is returned without a retry', async () => {
    const gone = { ok: false, status: 404, error: 'not found' };
    const api = fakeApi({ tokens: [token('t1')], posts: [gone] });
    const r = await postMemoryWrite(api.apiPost, api.apiGet, '/api/memory/7/archive', { reason: 'x' });
    assert.equal(api.calls.length, 2);
    assert.equal(r, gone);
  });

  it('when the token cannot be fetched the caller sees that failure, and nothing is posted', async () => {
    const down = { ok: false, status: 500, error: 'Failed to obtain sync-token' };
    const api = fakeApi({ tokens: [down], posts: [] });
    assert.equal(await postMemoryWrite(api.apiPost, api.apiGet, '/api/memory/7/archive', { reason: 'x' }), down);
    assert.deepEqual(api.calls, [['GET', '/api/memory/sync-token']]);
    // A 200 without a token is a failure too, not a POST with sync_token: undefined.
    const empty = fakeApi({ tokens: [{ ok: true, status: 200, data: {} }], posts: [] });
    const r = await postMemoryWrite(empty.apiPost, empty.apiGet, '/api/memory/7/archive', { reason: 'x' });
    assert.equal(r.ok, false);
    assert.equal(empty.calls.length, 1);
  });

  it('if the refetch after a 409 fails, the original 409 is what comes back', async () => {
    const stale = { ok: false, status: 409, error: 'stale', data: { code: 'sync_token_stale' } };
    const api = fakeApi({ tokens: [token('t1'), { ok: false, status: 500, error: 'down' }], posts: [stale] });
    assert.equal(await postMemoryWrite(api.apiPost, api.apiGet, '/api/memory/7/restore', {}), stale);
    assert.equal(api.calls.length, 3);
  });

  it('both pages send their memory writes through the helper, never a bare apiPost', () => {
    const lessons = read('client/src/pages/Portal/LessonsPage.jsx');
    const archived = read('client/src/pages/Memory/MemoryArchivedPage.jsx');
    for (const src of [lessons, archived]) {
      assert.match(src, /import \{ postMemoryWrite \} from '\.\.\/\.\.\/lib\/memory-write\.js'/);
      assert.doesNotMatch(src, /apiPost\(`\/api\/memory/);
    }
    assert.match(lessons, /postMemoryWrite\(apiPost, apiGet, `\/api\/memory\/\$\{memoryId\}\/archive`, \{ reason: RETRACT_REASON \}\)/);
    assert.match(archived, /postMemoryWrite\(apiPost, apiGet, `\/api\/memory\/\$\{id\}\/restore`/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Copy
// ─────────────────────────────────────────────────────────────────────────────

describe('copy — every key the four pages use exists in all three languages', () => {
  const pages = [
    'client/src/pages/Portal/LessonsPage.jsx', 'client/src/pages/Portal/lessons-vm.js',
    'client/src/pages/Portal/TasksPage.jsx', 'client/src/pages/Portal/tasks-vm.js',
    'client/src/pages/Team/TeamTasksPage.jsx',
    'client/src/pages/Portal/HandoffsPage.jsx', 'client/src/pages/Portal/handoffs-vm.js',
    'client/src/pages/Memory/MemoryArchivedPage.jsx',
  ];
  const src = pages.map(read).join('\n');
  const keys = [...new Set([...src.matchAll(/'((?:lessons|tasks|handoffs|memory\.archived)\.[\w.]+)'/g)].map((m) => m[1]))];

  it('finds the keys', () => {
    assert.ok(keys.length > 20, `only ${keys.length} keys found`);
  });

  for (const loc of LOCALES) {
    it(`${loc}.json has every key and none of the removed buttons`, () => {
      for (const k of keys) assert.ok(dicts[loc][k], `${loc}.json has no ${k}`);
      for (const gone of ['lessons.promote', 'lessons.dismiss', 'tasks.review', 'tasks.reviewed_ok', 'handoffs.accept', 'handoffs.profile_failed']) {
        assert.ok(!(gone in dicts[loc]), `${loc}.json still carries ${gone}`);
      }
    });
  }

  it('the three locales share one key set, in one order', () => {
    assert.deepEqual(Object.keys(dicts.en), Object.keys(dicts.zh));
    assert.deepEqual(Object.keys(dicts.ja), Object.keys(dicts.zh));
  });

  it('the fixed sentences are verbatim', () => {
    assert.equal(dicts.zh['lessons.subtitle'], '教訓由 AI 判斷留不留，這裡只看它留了什麼，不對的可以收回');
    assert.match(dicts.zh['lessons.state.dismissed'], /\{reason\}/);
    assert.match(dicts.en['lessons.state.dismissed'], /\{reason\}/);
    assert.match(dicts.ja['lessons.state.dismissed'], /\{reason\}/);
    for (const loc of LOCALES) assert.match(dicts[loc]['handoffs.taken_by'], /\{name\}/);
  });
});
