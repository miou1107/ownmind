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

    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-parity-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-proj-'));

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
