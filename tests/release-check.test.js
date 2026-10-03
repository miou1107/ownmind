// v1.31.5 — release check.
//
// Before a tag goes out: the branch must not be behind its base (the one blocking check),
// and the person is shown what else is open — cards not reviewed, lessons not kept, the
// team standards written for a release, in full. Git and the network are injected.
//
// See openspec/changes/v1.31.5-release-check/spec.md.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { stageHookHome } from './helpers/hook-home.js';
import {
  isReleaseCommand, detectBase, behindCount, lastTag, commitsSince, gitFacts, buildReleaseReport,
} from '../shared/release-git.js';
import { runReleaseCheck, releaseEnvelope, projectNameOf } from '../hooks/lib/release-check.js';
import { createReleaseRouter } from '../src/routes/release.js';

/** A git double: answers from a table keyed by the joined args; throws for anything else. */
function fakeGit(table) {
  return (args) => {
    const key = args.join(' ');
    if (!(key in table)) throw new Error(`git ${key}`);
    const v = table[key];
    if (v instanceof Error) throw v;
    return v;
  };
}

describe('isReleaseCommand — tagging and pushing tags, not listing or deleting', () => {
  it('recognises a release', () => {
    for (const c of ['git tag v1.2.3', 'git tag -a v1.2.3 -m x', 'git push --tags', 'git push origin --follow-tags', 'git push origin v1.2.3', 'cd x && git tag rc/2026-10']) {
      assert.equal(isReleaseCommand(c), true, c);
    }
  });
  it('leaves the rest alone', () => {
    for (const c of ['git tag', 'git tag -l', 'git tag --list "v1*"', 'git tag -d v1.2.3', 'git tag --contains abc', 'git push', 'git push origin main', 'git status', '', null]) {
      assert.equal(isReleaseCommand(c), false, String(c));
    }
  });

  it('is not fooled by quoted text or by flags that list, verify or sort', () => {
    // A commit whose message mentions `git tag` was denied when the branch was behind.
    for (const c of ['git commit -m "see git tag v1 later"', "echo 'git tag v1'", 'git tag --sort=-v:refname', 'git tag -ln', 'git tag -v v1.2.3', 'git tag -l v1*']) {
      assert.equal(isReleaseCommand(c), false, c);
    }
    assert.equal(isReleaseCommand('git tag -a v1 -m "git tag mentioned here"'), true);
  });
});

describe('the git half outside a repository, and with a stale origin/HEAD', () => {
  it('a dangling origin/HEAD is not a base; main is tried next', () => {
    const git = fakeGit({
      'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/gone\n',
      'rev-parse --verify --quiet origin/main': '',
    });
    assert.deepEqual(detectBase(git), { base: 'origin/main', source: 'fallback' });
  });

  it('not a repository: nothing blocks, the server is not asked, the report says so', async () => {
    const git = fakeGit({ 'rev-parse --is-inside-work-tree': new Error('fatal: not a git repository') });
    let asked = false;
    const r = await runReleaseCheck({ apiKey: 'k', apiUrl: 'http://api', cwd: '/some/folder', git, fetchJson: async () => { asked = true; return { status: 200, body: '{}' }; } });
    assert.equal(r.blocking.length, 0);
    assert.equal(r.project, null);
    assert.equal(asked, false);
    assert.match(r.lines.join('\n'), /not inside a git repository/);
    assert.equal(gitFacts(git).inRepo, false);
  });
});

describe('the git half', () => {
  it('reads the base from origin/HEAD, falls back to main then master, honours --base', () => {
    assert.deepEqual(detectBase(fakeGit({ 'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n', 'rev-parse --verify --quiet origin/main': '' })), { base: 'origin/main', source: 'origin/HEAD' });
    assert.deepEqual(detectBase(fakeGit({ 'rev-parse --verify --quiet origin/master': '' })), { base: 'origin/master', source: 'fallback' });
    assert.deepEqual(detectBase(fakeGit({}), 'origin/dev'), { base: 'origin/dev', source: 'option' });
    assert.deepEqual(detectBase(fakeGit({})), { base: null, source: 'none' });
  });

  it('counts commits behind, finds the last tag and the commits since', () => {
    const git = fakeGit({
      'rev-list --count HEAD..origin/main': '3\n',
      'describe --tags --abbrev=0': 'v1.2.2\n',
      'log --format=%h%x09%s v1.2.2..HEAD': 'abc1\tfix: a\ndef2\tfeat: b\n',
    });
    assert.equal(behindCount(git, 'origin/main'), 3);
    assert.equal(behindCount(git, null), null);
    assert.equal(lastTag(git), 'v1.2.2');
    assert.deepEqual(commitsSince(git, 'v1.2.2'), [{ hash: 'abc1', subject: 'fix: a' }, { hash: 'def2', subject: 'feat: b' }]);
    assert.deepEqual(commitsSince(fakeGit({}), null), []);
    assert.equal(lastTag(fakeGit({})), null);
  });
});

describe('buildReleaseReport — one blocking check, everything else to read', () => {
  const facts = (over) => ({ branch: 'feat', base: 'origin/main', baseSource: 'origin/HEAD', behind: 0, lastTag: 'v1', since: '2026-10-01T00:00:00Z', commits: [{ hash: 'a', subject: 's' }], ...over });

  it('blocks only when behind the base, with the merge instruction', () => {
    const r = buildReleaseReport(facts({ behind: 3 }), null);
    assert.equal(r.blocking.length, 1);
    assert.match(r.blocking[0], /3 commit\(s\) behind origin\/main/);
    assert.match(r.blocking[0], /git merge origin\/main/);
    assert.equal(buildReleaseReport(facts({ behind: 0 }), null).blocking.length, 0);
    assert.equal(buildReleaseReport(facts({ base: null, behind: null }), null).blocking.length, 0, 'no base is reported, never blocking');
  });

  it('says when the server could not be asked, and lists cards, lessons and standards when it could', () => {
    const offline = buildReleaseReport(facts(), null).lines.join('\n');
    assert.match(offline, /could not reach its server/);
    const online = buildReleaseReport(facts(), {
      cards: { pending: [{ id: 15, title: 'coupon', status: 'done', holder: 'Amiee' }], ready: [{ id: 12 }] },
      lessons: { new: 3 },
      standards: [{ title: 'idaytour 打 tag 前先確認分支沒落後 master', content: 'line one\nline two' }],
    }).lines.join('\n');
    assert.match(online, /cards: 1 reviewed, 1 not yet/);
    assert.match(online, /#15 done \(Amiee\) — coupon/);
    assert.match(online, /lessons: 3 from this project/);
    assert.match(online, /## idaytour 打 tag 前先確認分支沒落後 master/);
    assert.match(online, /    line two/);
    assert.match(online, /For you to read \(a reminder, not a check\)/);
  });
});

describe('runReleaseCheck + releaseEnvelope — the hook half', () => {
  const git = fakeGit({
    'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
    'rev-parse --verify --quiet origin/main': '',
    'rev-parse --abbrev-ref HEAD': 'feat',
    'rev-list --count HEAD..origin/main': '0',
    'describe --tags --abbrev=0': 'v1',
    'log -1 --format=%cI v1': '2026-10-01T00:00:00+08:00',
    'log --format=%h%x09%s v1..HEAD': '',
    'rev-parse --show-toplevel': '/Users/x/work/idaytour',
    'rev-parse --is-inside-work-tree': 'true\n',
  });

  it('asks the server with the project, the milestone and the tag date; never the path', async () => {
    const calls = [];
    const fetchJson = async (url) => { calls.push(url); return { status: 200, body: JSON.stringify({ cards: { pending: [], ready: [] }, lessons: { new: 0 }, standards: [] }) }; };
    const r = await runReleaseCheck({ apiKey: 'k', apiUrl: 'http://api/', cwd: '/Users/x/work/idaytour', git, fetchJson, milestone: '2026-10' });
    assert.equal(r.project, 'idaytour');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^http:\/\/api\/api\/release\/check\?/);
    assert.match(calls[0], /project=idaytour/);
    assert.match(calls[0], /milestone=2026-10/);
    assert.match(calls[0], /since=2026-10-01/);
    assert.ok(!calls[0].includes('Users'), 'no path in the request');
    assert.equal(r.blocking.length, 0);
    const env = JSON.parse(releaseEnvelope('1.31.3', r));
    assert.equal(env.decision, undefined);
    assert.match(env.hookSpecificOutput.additionalContext, /^\[OwnMind v1\.31\.3\] Release check/);
  });

  it('denies with the whole report in the reason when behind the base', async () => {
    const behind = fakeGit({ 'rev-parse --is-inside-work-tree': 'true', 'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main', 'rev-parse --verify --quiet origin/main': '', 'rev-parse --abbrev-ref HEAD': 'feat', 'rev-list --count HEAD..origin/main': '2', 'rev-parse --show-toplevel': '/w/om' });
    const r = await runReleaseCheck({ cwd: '/w/om', git: behind, fetchJson: async () => { throw new Error('no'); } });
    assert.equal(r.blocking.length, 1);
    const env = JSON.parse(releaseEnvelope('1.31.3', r));
    assert.equal(env.decision, 'block');
    assert.equal(env.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(env.reason, /2 commit\(s\) behind/);
    assert.match(env.reason, /could not reach its server/);
  });

  it('skips the server without credentials', async () => {
    let asked = false;
    const r = await runReleaseCheck({ cwd: '/w/om', git, fetchJson: async () => { asked = true; return { status: 200, body: '{}' }; } });
    assert.equal(asked, false);
    assert.match(r.lines.join('\n'), /could not reach its server/);
    // Outside a repository there is no project: the folder name would be an arbitrary one.
    assert.equal(projectNameOf(fakeGit({})), null);
  });
});

// ── the hook, end to end, against a real repository ─────────────────────────────────────

describe('the Bash hook in front of git tag', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const HOOK = path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.js');
  let apiServer;
  let apiUrl;
  let home;
  let work;
  let scratch;
  let hookContextStatus = 200;

  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  before(async () => {
    // The hook asks the server for rule counts before anything else and exits in silence
    // when it cannot; so a server that answers, and answers 404 to the release half, which
    // then fails open.
    apiServer = http.createServer((req, res) => {
      if (req.url.startsWith('/api/memory/hook-context')) {
        if (hookContextStatus !== 200) { res.writeHead(hookContextStatus); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { counts: {}, totals: {}, names: {}, rules: [] } }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${apiServer.address().port}`;
    home = stageHookHome({ apiUrl });

    scratch = tempDir('ownmind-release-repo-');
    const bare = path.join(scratch, 'origin.git');
    git(scratch, 'init', '--bare', '-b', 'main', bare);
    work = path.join(scratch, 'work');
    git(scratch, 'clone', '-q', bare, work);
    fs.writeFileSync(path.join(work, 'a.txt'), 'a');
    git(work, 'add', 'a.txt'); git(work, 'commit', '-q', '-m', 'a'); git(work, 'push', '-q', '-u', 'origin', 'HEAD:main');
    git(work, 'remote', 'set-head', 'origin', 'main');
    // Somebody else lands a commit on main.
    const other = path.join(scratch, 'other');
    git(scratch, 'clone', '-q', bare, other);
    fs.writeFileSync(path.join(other, 'b.txt'), 'b');
    git(other, 'add', 'b.txt'); git(other, 'commit', '-q', '-m', 'b'); git(other, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'fetch', '-q');
  });

  after(async () => {
    await new Promise((r) => apiServer.close(r));
    for (const d of [home, scratch]) fs.rmSync(d, { recursive: true, force: true });
  });

  // Spawned, never execFileSync: the fake API lives in this process, and a synchronous child
  // would block the event loop that has to answer it — every request would time out and the
  // hook would exit before the release check, in silence.
  function runHook(command) {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.OWNMIND_API_KEY; delete env.OWNMIND_API_URL;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK], { cwd: work, env, stdio: 'pipe' });
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', () => resolve(stdout));
      child.stdin.end(JSON.stringify({ tool_name: 'Bash', session_id: 's-release', tool_input: { command } }));
    });
  }

  it('denies the tag while the branch is behind its base, with the whole report in the reason', async () => {
    const out = await runHook('git tag v9.9.9');
    const env = JSON.parse(out);
    assert.equal(env.decision, 'block');
    assert.match(env.reason, /Release check/);
    assert.match(env.reason, /1 commit\(s\) behind origin\/main/);
    assert.match(env.reason, /git merge origin\/main/);
    assert.match(env.reason, /could not reach its server/, 'the server half failed open and said so');
  });

  it('lets the tag through once merged, and hands the AI the report to show', async () => {
    git(work, 'merge', '-q', 'origin/main');
    const out = await runHook('git tag v9.9.9');
    const env = JSON.parse(out);
    assert.equal(env.decision, undefined);
    assert.match(env.hookSpecificOutput.additionalContext, /Release check/);
    assert.match(env.hookSpecificOutput.additionalContext, /nothing that blocks/);
    assert.match(env.hookSpecificOutput.additionalContext, /Show the "For you to read" part/);
  });

  it('does nothing for listing tags', async () => {
    const out = await runHook('git tag -l');
    assert.ok(!/Release check/.test(out), `listing is not a release; got: ${out.slice(0, 200)}`);
  });

  it('still denies a branch behind its base when the rule lookup fails and when there is no key', async () => {
    // Behind again: a third commit lands on main.
    const other = path.join(scratch, 'other');
    fs.writeFileSync(path.join(other, 'c.txt'), 'c');
    git(other, 'add', 'c.txt'); git(other, 'commit', '-q', '-m', 'c'); git(other, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'fetch', '-q');

    hookContextStatus = 500;
    try {
      const env1 = JSON.parse(await runHook('git tag v9.9.10'));
      assert.equal(env1.decision, 'block', 'the rule lookup failing must not skip the release check');
      assert.match(env1.reason, /behind origin\/main/);
    } finally {
      hookContextStatus = 200;
    }

    const noKey = tempDir('ownmind-release-nokey-');
    try {
      fs.mkdirSync(path.join(noKey, '.ownmind'), { recursive: true });
      fs.writeFileSync(path.join(noKey, '.ownmind', 'package.json'), JSON.stringify({ version: '99.99.99' }));
      const env = { ...process.env, HOME: noKey, USERPROFILE: noKey };
      delete env.OWNMIND_API_KEY; delete env.OWNMIND_API_URL;
      const out = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [HOOK], { cwd: work, env, stdio: 'pipe' });
        let stdout = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.resume();
        child.on('error', reject);
        child.on('close', () => resolve(stdout));
        child.stdin.end(JSON.stringify({ tool_name: 'Bash', session_id: 's-release', tool_input: { command: 'git tag v9.9.10' } }));
      });
      const env2 = JSON.parse(out);
      assert.equal(env2.decision, 'block', 'no OwnMind key on the machine must not skip the release check');
    } finally {
      fs.rmSync(noKey, { recursive: true, force: true });
    }
  });
});

// ── the server half ─────────────────────────────────────────────────────────────────────

function fakeAuth(req, res, next) { req.user = { id: 7, name: 'Vin', role: 'user' }; next(); }
function scriptedQuery(answers) {
  const calls = [];
  const fn = async (text, values) => {
    calls.push({ text, values });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { rows: next || [] };
  };
  fn.calls = calls;
  return fn;
}
function buildApp(query) {
  const app = express();
  app.use(express.json());
  app.use('/api/release', createReleaseRouter({ query, auth: fakeAuth, logger: { error() {}, warn() {} } }));
  return app;
}
function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, method, path,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
      (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => { server.close(); try { resolve({ status: r.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: r.statusCode, body: data }); } });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('GET /api/release/check', () => {
  it('splits the milestone cards into ready and pending, counts lessons since, returns standards in full', async () => {
    const q = scriptedQuery([
      [{ id: 12, title: 'a', status: 'reviewed', holder: null }, { id: 15, title: 'b', status: 'done', holder: 'Amiee' }],
      [{ n: 3 }],
      [{ id: 1, title: 'S', content: 'full text', tags: ['trigger:deploy'] }],
    ]);
    const r = await request(buildApp(q), 'GET', '/api/release/check?project=idaytour&milestone=2026-10&since=2026-10-01T00:00:00Z');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.cards.ready.map((c) => c.id), [12]);
    assert.deepEqual(r.body.cards.pending.map((c) => c.id), [15]);
    assert.deepEqual(r.body.lessons, { new: 3 });
    assert.equal(r.body.standards[0].content, 'full text');
    assert.match(q.calls[0].text, /links->>'milestone' = \$3/);
    assert.deepEqual(q.calls[1].values, [7, 'idaytour', '2026-10-01T00:00:00Z']);
    assert.match(q.calls[2].text, /tags && \$1::text\[\]/);
  });

  it('without a milestone takes every unfinished card of the project; without a table says so', async () => {
    const q = scriptedQuery([new Error('relation "tasks" does not exist'), [{ n: 0 }], []]);
    const r = await request(buildApp(q), 'GET', '/api/release/check?project=om');
    assert.equal(r.status, 200);
    assert.equal(r.body.cards.unavailable, true);
    assert.equal((await request(buildApp(scriptedQuery([])), 'GET', '/api/release/check')).status, 400);
  });
});

describe('POST /api/release/tag', () => {
  it('refuses while a card is not reviewed, naming it — only among cards this person may see', async () => {
    const q = scriptedQuery([[{ id: 15, status: 'done' }]]);
    const r = await request(buildApp(q), 'POST', '/api/release/tag', { project: 'om', milestone: 'm', tag: 'v1' });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.cards, [{ id: 15, status: 'done' }]);
    assert.equal(q.calls.length, 1);
    assert.match(q.calls[0].text, /t\.is_private = FALSE OR t\.user_id = \$2 OR t\.claimed_by = \$2/);
    assert.deepEqual(q.calls[0].values, ['om', 7, 'm']);
  });

  it('records the tag on every reviewed card this person may see', async () => {
    const q = scriptedQuery([[], [{ id: 12 }, { id: 13 }]]);
    const r = await request(buildApp(q), 'POST', '/api/release/tag', { project: 'om', milestone: 'm', tag: 'v1.2.3' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { tag: 'v1.2.3', cards: [12, 13] });
    assert.match(q.calls[1].text, /links = t\.links \|\| \$4::jsonb/);
    assert.match(q.calls[1].text, /t\.is_private = FALSE OR t\.user_id = \$2/);
    assert.deepEqual(q.calls[1].values, ['om', 7, 'm', '{"released_in":"v1.2.3"}']);
  });

  it('needs a project and a tag', async () => {
    assert.equal((await request(buildApp(scriptedQuery([])), 'POST', '/api/release/tag', { project: 'om' })).status, 400);
  });
});
