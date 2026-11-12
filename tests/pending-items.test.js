// Pending items reminder (issue #203): what is collected, what counts as new, what the user sees.
// Every repository, person and host below is invented; this repository is public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import {
  collectGithub, collectGitlab, decide, render, isDue, checkPendingItems, readGitHosts, recheckPendingItemsIfDue,
} from '../hooks/lib/pending-items.js';

const T = (key, p = {}) => `${key}${JSON.stringify(p)}`;

function ghPayload({ assigned = [], review = [], authored = [] } = {}) {
  return JSON.stringify({ data: {
    viewer: { login: 'me' },
    assigned: { nodes: assigned }, review: { nodes: review }, authored: { nodes: authored },
  } });
}
const repo = (n) => ({ nameWithOwner: n });

test('collectGithub: maps the three searches to items', async () => {
  const run = async () => ({ code: 0, stdout: ghPayload({
    assigned: [{ number: 64, title: 'Morning message shows codes', url: 'https://github.com/example/app/issues/64', updatedAt: '2026-11-12T01:00:00Z', repository: repo('example/app') }],
    review: [{ number: 7, title: 'Add a quota', url: 'https://github.com/example/api/pull/7', updatedAt: '2026-11-12T02:00:00Z', author: { login: 'member-2' }, repository: repo('example/api') }],
    authored: [
      { number: 50, title: 'Skip button', url: 'https://github.com/example/web/pull/50', updatedAt: '2026-11-13T00:40:00Z', repository: repo('example/web'), comments: { nodes: [{ createdAt: '2026-11-12T09:00:00Z', author: { login: 'member-2' } }, { createdAt: '2026-11-12T10:00:00Z', author: { login: 'me' } }, { createdAt: '2026-11-12T11:00:00Z', author: { login: 'ci-helper[bot]' } }] }, reviews: { nodes: [{ submittedAt: '2026-11-12T08:00:00Z', author: { login: 'member-3' } }] }, commits: { nodes: [{ commit: { oid: 'abc', statusCheckRollup: { state: 'FAILURE' } } }] } },
      { number: 51, title: 'Green one', url: 'https://github.com/example/web/pull/51', updatedAt: '2026-11-13T00:40:00Z', repository: repo('example/web'), comments: { nodes: [] }, reviews: { nodes: [] }, commits: { nodes: [{ commit: { oid: 'def', statusCheckRollup: { state: 'SUCCESS' } } }] } },
    ],
  }), stderr: '' });
  const r = await collectGithub({ run });
  assert.equal(r.status, 'ok');
  const kinds = r.items.map((i) => `${i.key}:${i.kind}`);
  assert.deepEqual(kinds.sort(), [
    'github:example/api#7:review',
    'github:example/app#64:assigned',
    'github:example/web#50:failing',
  ]);
  // The newest comment by someone else: not the user's own reply, not the bot's.
  assert.deepEqual(r.commentMarks, { 'github:example/web#50': '2026-11-12T09:00:00Z', 'github:example/web#51': '' });
  const review = r.items.find((i) => i.kind === 'review');
  assert.equal(review.who, 'member-2');
  assert.equal(review.ref, 'example/api PR #7');
});

test('collectGithub: bad credentials is refused, a missing CLI or no login is absent, a timeout is an error', async () => {
  assert.equal((await collectGithub({ run: async () => ({ code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' }) })).status, 'refused');
  assert.equal((await collectGithub({ run: async () => ({ code: -1, error: 'ENOENT', stdout: '', stderr: '' }) })).status, 'absent');
  assert.equal((await collectGithub({ run: async () => ({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }) })).status, 'absent');
  assert.equal((await collectGithub({ run: async () => ({ code: -1, error: 'timeout', stdout: '', stderr: '' }) })).status, 'error');
});

test('collectGitlab: 401 on /user is refused; assigned, review and failing MRs are mapped', async () => {
  const host = { url: 'https://git.example.com', token: 'x' };
  const refused = await collectGitlab({ host, fetchJson: async () => ({ status: 401, body: '{}' }) });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.host, 'gitlab:https://git.example.com');

  const routes = {
    '/api/v4/user': { id: 9, username: 'me' },
    '/api/v4/issues?scope=assigned_to_me&state=opened&per_page=30': [{ iid: 112, project_id: 1, title: 'Price warning', web_url: 'https://git.example.com/g/p/-/issues/112', updated_at: '2026-11-13T05:50:00Z', references: { full: 'g/p#112' } }],
    '/api/v4/merge_requests?scope=all&state=opened&reviewer_id=9&per_page=30': [{ iid: 401, project_id: 1, title: 'Quota', web_url: 'https://git.example.com/g/p/-/merge_requests/401', updated_at: '2026-11-12T03:00:00Z', references: { full: 'g/p!401' }, author: { username: 'member-2' } }],
    '/api/v4/merge_requests?scope=created_by_me&state=opened&per_page=30': [{ iid: 405, project_id: 1, title: 'Background upload', web_url: 'https://git.example.com/g/p/-/merge_requests/405', updated_at: '2026-11-13T07:32:00Z', references: { full: 'g/p!405' }, user_notes_count: 4, sha: 'f00' }],
    '/api/v4/projects/1/merge_requests/405': { head_pipeline: { status: 'failed', sha: 'f00' } },
    '/api/v4/projects/1/merge_requests/405/notes?sort=desc&order_by=created_at&per_page=20': [
      { created_at: '2026-11-13T07:40:00Z', system: false, author: { id: 9 } },
      { created_at: '2026-11-13T07:35:00Z', system: true, author: { id: 3 } },
      { created_at: '2026-11-13T07:32:00Z', system: false, author: { id: 3 } },
    ],
  };
  const fetchJson = async (url) => {
    const p = url.replace('https://git.example.com', '');
    return p in routes ? { status: 200, body: JSON.stringify(routes[p]) } : { status: 404, body: '{}' };
  };
  const r = await collectGitlab({ host, fetchJson });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.items.map((i) => `${i.ref}:${i.kind}`).sort(), [
    'g/p!401:review', 'g/p!405:failing', 'g/p#112:assigned',
  ]);
  assert.deepEqual(r.commentMarks, { 'gitlab:https://git.example.com:g/p!405': '2026-11-13T07:32:00Z' });
});

const item = (key, kind, signal = '') => ({ key, kind, signal, title: key, url: `https://x/${key}`, ref: key });

test('decide: first check of the day lists everything; later the same day only what is new', () => {
  const now = new Date('2026-11-13T09:05:00+08:00');
  const a = item('github:e/a#1', 'assigned');
  const b = item('github:e/b#2', 'review');
  const first = decide({}, [{ host: 'github', status: 'ok', items: [a, b], commentMarks: {} }], now);
  assert.deepEqual(first.fresh.map((i) => i.key), ['github:e/a#1', 'github:e/b#2']);
  assert.equal(first.firstToday, true);

  const later = new Date('2026-11-13T14:20:00+08:00');
  const c = item('github:e/c#3', 'assigned');
  const second = decide(first.state, [{ host: 'github', status: 'ok', items: [a, b, c], commentMarks: {} }], later);
  assert.deepEqual(second.fresh.map((i) => i.key), ['github:e/c#3']);
  assert.equal(second.firstToday, false);
  assert.equal(second.state.items.length, 3);

  const nextDay = decide(second.state, [{ host: 'github', status: 'ok', items: [a, b, c], commentMarks: {} }], new Date('2026-11-14T09:00:00+08:00'));
  assert.equal(nextDay.fresh.length, 3);
});

test('decide: a new comment is flagged only after a baseline exists, and a new commit re-lists a failing PR', () => {
  const now = new Date('2026-11-13T09:00:00+08:00');
  const r1 = decide({}, [{ host: 'github', status: 'ok', items: [], commentMarks: { 'github:e/w#5': 2 } }], now);
  assert.equal(r1.fresh.length, 0);
  const r2 = decide(r1.state, [{ host: 'github', status: 'ok', items: [], commentMarks: { 'github:e/w#5': 3 } }], new Date('2026-11-13T10:30:00+08:00'));
  assert.deepEqual(r2.fresh.map((i) => `${i.key}:${i.kind}`), ['github:e/w#5:comment']);

  const f1 = item('github:e/w#6', 'failing', 'sha1');
  const r3 = decide(r2.state, [{ host: 'github', status: 'ok', items: [f1], commentMarks: {} }], new Date('2026-11-13T11:00:00+08:00'));
  assert.equal(r3.fresh.length, 1);
  const r4 = decide(r3.state, [{ host: 'github', status: 'ok', items: [f1], commentMarks: {} }], new Date('2026-11-13T12:30:00+08:00'));
  assert.equal(r4.fresh.length, 0);
  const r5 = decide(r4.state, [{ host: 'github', status: 'ok', items: [item('github:e/w#6', 'failing', 'sha2')], commentMarks: {} }], new Date('2026-11-13T13:30:00+08:00'));
  assert.equal(r5.fresh.length, 1);
});

test('decide: refused credentials warn only after the host once answered', () => {
  const now = new Date('2026-11-13T09:00:00+08:00');
  const never = decide({}, [{ host: 'github', status: 'refused', items: [] }], now);
  assert.deepEqual(never.expired, []);
  const ok = decide({}, [{ host: 'github', status: 'ok', items: [], commentMarks: {} }], now);
  const gone = decide(ok.state, [{ host: 'github', status: 'refused', items: [] }], now);
  assert.deepEqual(gone.expired, ['github']);
  const still = decide(gone.state, [{ host: 'github', status: 'refused', items: [] }], now);
  assert.deepEqual(still.expired, ['github']);
  const back = decide(still.state, [{ host: 'github', status: 'ok', items: [], commentMarks: {} }], now);
  assert.deepEqual(back.expired, []);
  const timeout = decide(ok.state, [{ host: 'github', status: 'error', items: [] }], now);
  assert.deepEqual(timeout.expired, []);
});

test('decide: an unreachable host keeps its items in the pane, stale, and never lists them as new', () => {
  const now = new Date('2026-11-13T09:00:00+08:00');
  const a = item('github:e/a#1', 'assigned');
  const r1 = decide({}, [{ host: 'github', status: 'ok', items: [a], commentMarks: {} }], now);
  const r2 = decide(r1.state, [{ host: 'github', status: 'error', items: [] }], new Date('2026-11-13T10:30:00+08:00'));
  assert.deepEqual(r2.state.items.map((i) => [i.key, i.stale]), [['github:e/a#1', true]]);
  // Next morning, still unreachable: yesterday's list is not announced again.
  const r3 = decide(r2.state, [{ host: 'github', status: 'error', items: [] }], new Date('2026-11-14T09:00:00+08:00'));
  assert.equal(r3.fresh.length, 0);
  assert.equal(r3.state.items.length, 1);
  // Signed out: the items go.
  const r4 = decide(r3.state, [{ host: 'github', status: 'absent', items: [] }], new Date('2026-11-14T10:30:00+08:00'));
  assert.equal(r4.state.items.length, 0);
});

test('render: nothing to say is null; otherwise a header, one line per item, and expired lines', () => {
  assert.equal(render({ fresh: [], expired: [], firstToday: true }, T), null);
  const text = render({ fresh: [item('github:e/a#1', 'assigned')], expired: ['github', 'gitlab:https://git.example.com'], firstToday: true }, T);
  const lines = text.split('\n');
  assert.match(lines[0], /^pendingItems\.header\.all/);
  assert.match(lines[1], /^pendingItems\.item\{.*"label":"pendingItems\.kind\.assigned/);
  assert.match(lines[2], /^pendingItems\.expired\.github/);
  assert.match(lines[3], /^pendingItems\.expired\.gitlab\{"host":"git\.example\.com"\}/);
  assert.match(render({ fresh: [item('k', 'review')], expired: [], firstToday: false }, T), /^pendingItems\.header\.new/);
});

test('isDue: an hour after the last check, or never checked', () => {
  const now = new Date('2026-11-13T15:40:00+08:00');
  assert.equal(isDue({}, now), true);
  assert.equal(isDue({ lastCheckAt: '2026-11-13T14:50:00+08:00' }, now), false);
  assert.equal(isDue({ lastCheckAt: '2026-11-13T14:39:00+08:00' }, now), true);
});

test('checkPendingItems: writes the state file and returns text only when there is something to say', async () => {
  const dir = tempDir('pending-items-');
  const statePath = path.join(dir, 'state', 'pending-items.json');
  const collectors = [async () => ({ host: 'github', status: 'ok', items: [item('github:e/a#1', 'assigned')], commentMarks: {} })];
  const r1 = await checkPendingItems({ statePath, collectors, now: new Date('2026-11-13T09:00:00+08:00'), t: T });
  assert.ok(r1.text);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).items.length, 1);
  const r2 = await checkPendingItems({ statePath, collectors, now: new Date('2026-11-13T10:30:00+08:00'), t: T });
  assert.equal(r2.text, null);
  const none = await checkPendingItems({ statePath, collectors: [], now: new Date('2026-11-13T10:30:00+08:00'), t: T });
  assert.equal(none.text, null);
});

test('readGitHosts: a missing or malformed file means no GitLab hosts', () => {
  const dir = tempDir('git-hosts-');
  assert.deepEqual(readGitHosts(path.join(dir, 'none.json')), []);
  const f = path.join(dir, 'git-hosts.json');
  fs.writeFileSync(f, '{not json');
  assert.deepEqual(readGitHosts(f), []);
  fs.writeFileSync(f, JSON.stringify({ gitlab: [{ url: 'https://git.example.com/', token: 't' }, { url: '', token: 'x' }] }));
  assert.deepEqual(readGitHosts(f), [{ url: 'https://git.example.com', token: 't' }]);
});

test('render: more than ten items show ten lines and a count of the rest', () => {
  const many = Array.from({ length: 13 }, (_, n) => item(`github:e/a#${n}`, 'assigned'));
  const lines = render({ fresh: many, expired: [], firstToday: true }, T).split('\n');
  assert.equal(lines.length, 12);
  assert.match(lines[11], /^pendingItems\.more\{"count":3\}/);
});

test('recheckPendingItemsIfDue: skips within the hour, checks after it', async () => {
  const dir = tempDir('pending-recheck-');
  const statePath = path.join(dir, 'pending-items.json');
  let calls = 0;
  const collectors = [async () => { calls += 1; return { host: 'github', status: 'ok', items: [], commentMarks: {} }; }];
  await recheckPendingItemsIfDue({ statePath, collectors, now: new Date('2026-11-13T14:20:00+08:00'), t: T });
  await recheckPendingItemsIfDue({ statePath, collectors, now: new Date('2026-11-13T15:00:00+08:00'), t: T });
  assert.equal(calls, 1);
  await recheckPendingItemsIfDue({ statePath, collectors, now: new Date('2026-11-13T15:40:00+08:00'), t: T });
  assert.equal(calls, 2);
});

test('OWNMIND_PENDING_ITEMS=off turns the check off', async () => {
  process.env.OWNMIND_PENDING_ITEMS = 'off';
  try {
    let calls = 0;
    const r = await checkPendingItems({ statePath: path.join(os.tmpdir(), 'never.json'), collectors: [async () => { calls += 1; return null; }], t: T });
    assert.equal(r.text, null);
    assert.equal(calls, 0);
  } finally { delete process.env.OWNMIND_PENDING_ITEMS; }
});

test('render: review requests and broken PRs come before assigned issues', () => {
  const many = [
    ...Array.from({ length: 11 }, (_, n) => item(`github:e/a#${n}`, 'assigned')),
    item('github:e/r#1', 'review'),
    item('github:e/f#1', 'failing'),
  ];
  const lines = render({ fresh: many, expired: [], firstToday: true }, T).split('\n');
  assert.match(lines[1], /pendingItems\.kind\.review/);
  assert.match(lines[2], /pendingItems\.kind\.failing/);
});

test('collectGithub: a reply with data is used even when gh exits non-zero (an organisation needing SSO)', async () => {
  const r = await collectGithub({ run: async () => ({ code: 1, stderr: 'GraphQL: Resource protected by organization SAML enforcement', stdout: ghPayload({
    assigned: [{ number: 3, title: 'x', url: 'https://github.com/example/app/issues/3', updatedAt: '2026-11-12T01:00:00Z', repository: repo('example/app') }],
  }) }) });
  assert.equal(r.status, 'ok');
  assert.equal(r.items.length, 1);
});

test('checkPendingItems: a host slower than the budget counts as unreachable, and the check still returns', async () => {
  const dir = tempDir('pending-budget-');
  const statePath = path.join(dir, 'pending-items.json');
  const slow = { host: 'gitlab:https://git.example.com', run: () => new Promise(() => {}) };
  const fast = { host: 'github', run: async () => ({ host: 'github', status: 'ok', items: [item('github:e/a#1', 'assigned')], commentMarks: {} }) };
  const t0 = Date.now();
  const r = await checkPendingItems({ statePath, collectors: [fast, slow], now: new Date('2026-11-13T09:00:00+08:00'), t: T, budgetMs: 150 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.fresh.length, 1);
});
