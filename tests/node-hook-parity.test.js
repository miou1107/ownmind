// v1.26.83 — the Node hook has to do what the bash hook does.
//
// v1.26.80 routed Windows to `hooks/ownmind-session-start.js` because the bash command had
// never once fired there. That fixed the thing that mattered most, and shipped a hook 143
// lines against the shell script's 226. The difference was not comments: eight things the
// bash hook does were simply absent, two of them user-visible — **broadcasts never appeared
// on Windows, and memory files were never written into the project directory.**
//
// It was recorded as backlog item 26 with the note "do not close this by declaring the Node
// hook good enough". This closes it.
//
// The shell script is a thin orchestrator over `hooks/lib/*.js`. Parity is therefore mostly
// a matter of calling the same modules, not reimplementing them — and these tests assert
// the observable results, not that particular functions were called.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(repoRoot, 'hooks', 'ownmind-session-start.js');

const BROADCAST = {
  id: 99,
  severity: 'info',
  title: '近期更新比較密集',
  body: '造成打擾請見諒。',
};

const MEMORIES = [
  { id: 1, type: 'iron_rule', title: 'Never commit secrets', content: 'No keys in git.', code: 'IR-001' },
];

describe('node SessionStart hook — parity with the shell hook', () => {
  let server;
  let baseUrl;
  let home;
  let projectDir;
  let stdout = '';
  const hit = new Set();

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const url = req.url.split('?')[0];
        hit.add(url);
        res.setHeader('content-type', 'application/json');
        if (url === '/api/memory/sync-token') return res.end(JSON.stringify({ sync_token: 'tok-1' }));
        if (url === '/api/memory/init') {
          return res.end(JSON.stringify({
            sync_token: 'tok-1',
            server_version: '9.9.9-test',
            profile: { title: 'Vin', content: 'prefers plain Chinese', role: 'user' },
            principles: [],
            iron_rules_digest: 'IR-001: Never commit secrets',
            iron_rules_count: 1,
          }));
        }
        if (url === '/api/broadcast/active') return res.end(JSON.stringify([BROADCAST]));
        if (url === '/api/memory/sync') return res.end(JSON.stringify({ memories: MEMORIES }));
        if (url === '/api/activity/batch') return res.end(JSON.stringify({ inserted: 1 }));
        return res.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    home = tempDir('ownmind-parity-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    projectDir = tempDir('ownmind-proj-');

    stdout = await new Promise((resolve, reject) => {
      execFile('node', [HOOK], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CLAUDE_PROJECT_DIR: projectDir,
          OWNMIND_API_KEY: 'test-key-0123456789abcdef',
          OWNMIND_API_URL: baseUrl,
        },
        timeout: 25000,
      }, (err, out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(out)));
    });
  });

  after(() => {
    server?.close();
    for (const d of [home, projectDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const context = () => JSON.parse(stdout).hookSpecificOutput.additionalContext;

  it('emits the SessionStart schema Claude Code expects', () => {
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(typeof parsed.hookSpecificOutput.additionalContext, 'string');
  });

  it('shows broadcasts — invisible on Windows until now', () => {
    assert.ok(hit.has('/api/broadcast/active'), 'never asked for broadcasts');
    assert.match(context(), /OwnMind broadcast/);
    assert.ok(context().includes(BROADCAST.title), 'the broadcast was fetched and then dropped');
  });

  it('renders through the shared renderer, so both platforms read identically', () => {
    // renderSessionContext's own format, not this file's hand-rolled lines.
    assert.match(context(), /\[OwnMind v9\.9\.9-test\]/);
    assert.match(context(), /IR-001/);
  });

  it('writes memory files into the project directory', () => {
    assert.ok(hit.has('/api/memory/sync'), 'never asked for the memories to sync');
    // resolveMemoryDir puts them under HOME, keyed by a slug of the project path.
    const memDir = path.join(home, '.claude', 'projects');
    const found = fs.existsSync(memDir)
      ? fs.readdirSync(memDir, { recursive: true }).filter((f) => String(f).endsWith('.md'))
      : [];
    assert.ok(found.length > 0, `no memory files written under ${memDir}`);
  });

  it('uses the conditional sync path rather than always downloading everything', () => {
    // The cache is empty on a first run, so a full init is correct here. What must be true
    // is that the cache now exists — the next session is the one that saves the download.
    const cache = path.join(home, '.ownmind', 'cache', 'memories.json');
    assert.ok(fs.existsSync(cache), 'no cache written, so every session pays for a full init');
    const parsed = JSON.parse(fs.readFileSync(cache, 'utf8'));
    assert.equal(parsed.sync_token, 'tok-1');
    assert.ok(parsed.account, 'the cache must be stamped with the account that wrote it');
  });

  it('reports the load to the server', () => {
    assert.ok(hit.has('/api/activity/batch'), 'a working hook must be visible server-side');
  });
});

/**
 * v1.26.98 — the update lock, on the copy Windows runs.
 *
 * `maybeCheckForUpdates` used to read `.update-lock`, return if it was fresh, delete it if
 * it was stale, and then create nothing at all — so every concurrent hook found no lock and
 * ran the update script together. These assert the observable consequences rather than the
 * shape of the code: what lands in the activity log, and what is left on disk.
 */
describe('node SessionStart hook — the update lock', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end('{}');   // enough for the update check, which runs before the memory load
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  /** A HOME that looks like an install: a git checkout, and optionally an update script. */
  /**
   * v1.26.120 — Windows will not delete a directory anything still has open, and this hook
   * starts an update script on purpose, so the child can outlive the hook by a moment. The
   * old cleanup was a bare rmSync in a finally: it threw EPERM on the temp directory and
   * failed the test **after its assertions had already passed** — the reported failure was
   * "takes the lock before announcing the check", which had nothing to do with it.
   *
   * Retry, then give up loudly rather than throwing: the subject here is what the hook did,
   * not whether the OS had released a handle yet, and the directory is under tmpdir.
   */
  async function cleanup(home) {
    for (let i = 0; i < 20; i++) {
      try {
        fs.rmSync(home, { recursive: true, force: true });
        return;
      } catch (e) {
        if (i === 19) {
          // Not swallowed (IR-003): a leak that is never mentioned is a leak nobody fixes.
          process.stderr.write(`[node-hook-parity] could not remove ${home}: ${e.code}
`);
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  function makeHome({ withUpdateScript }) {
    const home = tempDir('ownmind-lock-hook-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.ownmind', '.git'), { recursive: true });
    if (withUpdateScript) {
      fs.mkdirSync(path.join(home, '.ownmind', 'scripts'), { recursive: true });
      for (const name of ['update.sh', 'update.ps1']) {
        fs.writeFileSync(path.join(home, '.ownmind', 'scripts', name), 'exit 0\n');
      }
    }
    return home;
  }

  function runHook(home) {
    return new Promise((resolve) => {
      execFile('node', [HOOK], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          OWNMIND_API_KEY: 'test-key-0123456789abcdef',
          OWNMIND_API_URL: baseUrl,
        },
        timeout: 25000,
      }, () => resolve());   // the hook must never fail the session; its exit code is not the subject
    });
  }

  /** Events the hook wrote locally, in order. */
  function events(home) {
    const dir = path.join(home, '.ownmind', 'logs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('stands down when somebody else holds the lock, and calls it a skip', async () => {
    const home = makeHome({ withUpdateScript: true });
    try {
      // Somebody else is mid-update. Fresh, so it is not reclaimable.
      fs.writeFileSync(path.join(home, '.ownmind', '.update-lock'), 'another-process');
      await runHook(home);

      const names = events(home).map((e) => e.event);
      assert.ok(names.includes('update_skipped'), `expected a skip, got: ${names.join(', ')}`);
      assert.equal(
        events(home).find((e) => e.event === 'update_skipped').details.reason, 'lock_held');
      // Both of these were the bug: announcing a check it is not going to do, and reporting
      // somebody else's turn as this machine's failure.
      assert.ok(!names.includes('update_check'), 'announced a check while standing down');
      assert.ok(!names.includes('update_failed'), 'a held lock is not a failed upgrade');
    } finally {
      await cleanup(home);
    }
  });

  it('leaves the other process\'s lock alone', async () => {
    const home = makeHome({ withUpdateScript: true });
    try {
      const lock = path.join(home, '.ownmind', '.update-lock');
      fs.writeFileSync(lock, 'another-process');
      await runHook(home);
      assert.equal(fs.readFileSync(lock, 'utf8'), 'another-process',
        'released a lock it never held');
    } finally {
      await cleanup(home);
    }
  });

  it('takes the lock before announcing the check', async () => {
    const home = makeHome({ withUpdateScript: true });
    try {
      await runHook(home);
      const names = events(home).map((e) => e.event);
      assert.ok(names.includes('update_check'), `no check ran: ${names.join(', ')}`);
      assert.equal(names.filter((n) => n === 'update_check').length, 1);
    } finally {
      await cleanup(home);
    }
  });

  it('hands the lock back when there is no update script to run', async () => {
    const home = makeHome({ withUpdateScript: false });
    try {
      await runHook(home);
      assert.ok(!fs.existsSync(path.join(home, '.ownmind', '.update-lock')),
        'held a lock for five minutes over work it never started');

      const names = events(home).map((e) => e.event);
      assert.ok(names.includes('update_failed'), 'a broken install must be visible');
      // Once a day, not once a session: the marker has to be stamped on this path too, or
      // the pair repeats on every conversation and `update_failed` stops meaning anything.
      assert.ok(fs.existsSync(path.join(home, '.ownmind', '.last-update-check')),
        'without the marker this fires on every session start');
    } finally {
      await cleanup(home);
    }
  });
});
