/**
 * v1.33.0 — what the session-start hook must learn live rather than from the cache.
 *
 * The init payload is served from disk whenever the memory table has not moved, and the
 * sync token does not cover handoffs or task cards. A cached `handoffs` list would have the
 * matching project accept the same handoff on every start; a cached consolidation report
 * would be relayed every morning until an unrelated memory write happened to move the token.
 * So: the cache never holds them, the sync-token answer may carry them, pending handoffs are
 * asked for on every start, and the two "shown" marks go out once the context is rendered.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import {
  fetchSyncTokenInfo, overlayLiveFields, writeCache, readCache, stripLiveFields, LIVE_FIELDS,
} from '../hooks/lib/conditional-sync.js';
import { fetchPendingHandoffs, mergeHandoffs, markConsolidationShown } from '../hooks/lib/session-live-state.js';
import { gitRemoteRepoName, projectAliases } from '../hooks/lib/project-aliases.js';

const okJson = (body) => async () => ({ ok: true, json: async () => body });

describe('conditional-sync — handoffs and consolidation never come from disk', () => {
  const account = { apiUrl: 'http://api', apiKey: 'k' };
  const handoffs = [{ id: 1, project: 'vinutes', status: 'pending', content: 'x' }];
  const consolidation = { card: { id: 40, status: 'open' }, report: null, questions: [] };

  it('writeCache strips them; everything else is kept', () => {
    const dir = tempDir('ownmind-live-cache-');
    try {
      const cachePath = path.join(dir, 'memories.json');
      writeCache({ sync_token: 't1', data: { profile: { name: 'Vin' }, lessons_waiting: 0, handoffs, consolidation, active_handoff: null } }, cachePath, fs, account);
      const cache = readCache(cachePath, fs, account);
      assert.deepEqual(cache.data, { profile: { name: 'Vin' }, lessons_waiting: 0, active_handoff: null });
      for (const key of LIVE_FIELDS) assert.ok(!(key in cache.data), `${key} must not be cached`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stripLiveFields leaves non-objects alone and does not mutate its input', () => {
    const data = { a: 1, handoffs, consolidation };
    const out = stripLiveFields(data);
    assert.deepEqual(out, { a: 1 });
    assert.ok('handoffs' in data, 'the caller\'s object is untouched');
    assert.equal(stripLiveFields(null), null);
    const arr = [1];
    assert.equal(stripLiveFields(arr), arr);
  });

  it('fetchSyncTokenInfo carries them when the server sends them, and only in the right shape', async () => {
    const full = await fetchSyncTokenInfo('http://api', 'k', okJson({ sync_token: 't', lessons_waiting: 1, handoffs, consolidation }));
    assert.deepEqual(full, { sync_token: 't', lessons_waiting: 1, handoffs, consolidation });
    const wrongShape = await fetchSyncTokenInfo('http://api', 'k', okJson({ sync_token: 't', handoffs: 'nope', consolidation: 3 }));
    assert.deepEqual(wrongShape, { sync_token: 't' });
    const older = await fetchSyncTokenInfo('http://api', 'k', okJson({ sync_token: 't' }));
    assert.deepEqual(older, { sync_token: 't' });
  });

  it('overlayLiveFields puts the live values on the cached payload, and nothing when there are none', () => {
    const data = { profile: { name: 'Vin' } };
    assert.deepEqual(overlayLiveFields(data, { sync_token: 't', handoffs, consolidation }), { profile: { name: 'Vin' }, handoffs, consolidation });
    assert.equal(overlayLiveFields(data, { sync_token: 't' }), data, 'no live fields: the same object back');
    assert.deepEqual(overlayLiveFields(data, { sync_token: 't', lessons_waiting: 2, handoffs }), { profile: { name: 'Vin' }, lessons_waiting: 2, handoffs });
  });
});

describe('session-live-state — pending handoffs on every start', () => {
  it('fetches /api/handoff/pending with the key, and returns the rows', async () => {
    const calls = [];
    const fetchFn = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => [{ id: 7, project: 'ownmind' }] }; };
    const rows = await fetchPendingHandoffs({ apiUrl: 'http://api/', apiKey: 'k', fetchFn });
    assert.deepEqual(rows, [{ id: 7, project: 'ownmind' }]);
    assert.equal(calls[0].url, 'http://api/api/handoff/pending');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  });

  it('answers null — never throws — on a failure, a non-list, missing credentials', async () => {
    assert.equal(await fetchPendingHandoffs({ apiUrl: 'http://api', apiKey: 'k', fetchFn: async () => { throw new Error('down'); } }), null);
    assert.equal(await fetchPendingHandoffs({ apiUrl: 'http://api', apiKey: 'k', fetchFn: async () => ({ ok: false }) }), null);
    assert.equal(await fetchPendingHandoffs({ apiUrl: 'http://api', apiKey: 'k', fetchFn: okJson({ error: 'x' }) }), null);
    assert.equal(await fetchPendingHandoffs({ apiUrl: '', apiKey: 'k', fetchFn: okJson([]) }), null);
  });

  it('mergeHandoffs: the live list replaces cached pending rows, keeps recently accepted ones, and stands aside on null', () => {
    const init = { profile: null, handoffs: [{ id: 1, status: 'pending' }, { id: 2, status: 'accepted', accepted_at: 'now' }] };
    const merged = mergeHandoffs(init, [{ id: 3, project: 'x' }]);
    assert.deepEqual(merged.handoffs, [{ id: 3, project: 'x', status: 'pending' }, { id: 2, status: 'accepted', accepted_at: 'now' }]);
    assert.equal(merged.profile, null);
    assert.equal(mergeHandoffs(init, null), init);
    assert.deepEqual(mergeHandoffs({ profile: null }, []).handoffs, []);
  });
});

describe('session-live-state — the two "shown" marks', () => {
  it('PUTs report-shown with the task id and POSTs questions/asked with the ids', async () => {
    const calls = [];
    const fetchFn = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
    const outcome = await markConsolidationShown({
      apiUrl: 'http://api', apiKey: 'k', fetchFn,
      consolidation: { card: null, report: { task_id: 40, month: '2026-10' }, questions: [{ id: 5 }, { id: 6 }, { id: null }] },
    });
    assert.deepEqual(outcome, { reportShown: true, questionsAsked: 2 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://api/api/memory/consolidation/report-shown');
    assert.equal(calls[0].init.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[0].init.body), { task_id: 40 });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
    assert.equal(calls[1].url, 'http://api/api/memory/consolidation/questions/asked');
    assert.equal(calls[1].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1].init.body), { ids: [5, 6] });
  });

  it('sends nothing when there is nothing shown', async () => {
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return { ok: true }; };
    for (const c of [undefined, null, {}, { card: { id: 1 }, report: null, questions: [] }]) {
      assert.deepEqual(await markConsolidationShown({ apiUrl: 'http://api', apiKey: 'k', fetchFn, consolidation: c }), { reportShown: false, questionsAsked: 0 });
    }
    assert.deepEqual(calls, []);
  });

  it('a failed mark is reported as not shown and never throws', async () => {
    const outcome = await markConsolidationShown({
      apiUrl: 'http://api', apiKey: 'k', fetchFn: async () => { throw new Error('down'); },
      consolidation: { report: { task_id: 1 }, questions: [{ id: 2 }] },
    });
    assert.deepEqual(outcome, { reportShown: false, questionsAsked: 0 });
  });
});

describe('project-aliases — the names this directory answers to', () => {
  it('reads the origin repository name from .git/config, with or without .git, over ssh or https', () => {
    const dir = tempDir('ownmind-alias-');
    try {
      fs.mkdirSync(path.join(dir, '.git'));
      fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:miou1107/nantou-funbus.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
      assert.equal(gitRemoteRepoName(dir), 'nantou-funbus');
      fs.writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/miou1107/Vinutes\n');
      assert.equal(gitRemoteRepoName(dir), 'Vinutes');
      assert.deepEqual(projectAliases({ project: 'bot', projectDir: dir }), ['bot', 'Vinutes']);
      assert.deepEqual(projectAliases({ project: 'vinutes', projectDir: dir }), ['vinutes'], 'the same name twice is listed once');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('follows a worktree\'s gitdir file to the main checkout\'s config', () => {
    const dir = tempDir('ownmind-alias-wt-');
    try {
      const main = path.join(dir, 'main');
      const wt = path.join(dir, 'wt');
      fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
      fs.mkdirSync(wt);
      fs.writeFileSync(path.join(main, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:miou1107/ownmind.git\n');
      fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
      assert.equal(gitRemoteRepoName(wt), 'ownmind');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no repository, no origin, no directory: just the folder name, never a throw', () => {
    const dir = tempDir('ownmind-alias-none-');
    try {
      assert.equal(gitRemoteRepoName(dir), null);
      assert.equal(gitRemoteRepoName(null), null);
      assert.equal(gitRemoteRepoName(path.join(dir, 'missing')), null);
      fs.mkdirSync(path.join(dir, '.git'));
      fs.writeFileSync(path.join(dir, '.git', 'config'), '[remote "upstream"]\n\turl = x\n');
      assert.equal(gitRemoteRepoName(dir), null);
      assert.deepEqual(projectAliases({ project: 'x', projectDir: dir }), ['x']);
      assert.deepEqual(projectAliases({ project: null, projectDir: null }), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
