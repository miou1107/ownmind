import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { tempDir } from './helpers/temp-dir.js';

/**
 * The Windows session-start hook syncs the enforcement bundle.
 *
 * The bundle is what every later hook reads to check a turn against the standards. It is
 * fetched by `syncEnforcementBundle`, which was called from exactly one place:
 * `conditional-sync-cli.js`'s `main()`. That file is run by `ownmind-session-start.sh`, which
 * macOS and Linux register. Windows registers `ownmind-session-start.js`, which imports
 * `runConditionalSync` directly and never touched that CLI.
 *
 * So on Windows the bundle was never fetched. `~/.ownmind/cache/enforcement.json` never
 * existed, and the prompt hook said "this machine has never synced its standards" on every
 * turn — accurately, and with no way out. Measured 2026-08-15: the server answers a direct
 * request with 37 selectors, and the file was still absent after a clean start into a fresh
 * home.
 *
 * The comment above the CLI's call reasoned that "the .js hook is Windows-only. A sync written
 * into the .js would never execute on the machine it was written for." Both clauses are true
 * of macOS and neither is true of Windows, which is the whole defect in one sentence: a rule
 * about two platforms, written and checked on one.
 *
 * This test runs the hook the way Claude Code runs it — payload on stdin, **stdin closed** —
 * because the hook reads to EOF and a caller that leaves the pipe open hangs it forever. Ten
 * existing tests in this suite got that wrong and were timing out at 25s each.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const HOOK = path.join(repoRoot, 'hooks', 'ownmind-session-start.js');

const BUNDLE = {
  selectors: [{ id: 1, type: 'team_standard', tags: ['trigger:commit'], keywords: [] }],
  guards: [],
  injectables: [],
};

describe('the Windows session-start hook caches the enforcement bundle', () => {
  let server;
  let baseUrl;
  let asked;

  before(async () => {
    asked = [];
    server = http.createServer((req, res) => {
      asked.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.includes('/api/memory/enforcement-bundle')) return res.end(JSON.stringify(BUNDLE));
      if (req.url.includes('/api/memory/init')) {
        return res.end(JSON.stringify({
          sync_token: 'tok', server_version: '9.9.9-test', iron_rules_count: 0,
          profile: null, principles: [], iron_rules_digest: '',
        }));
      }
      return res.end('{}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => { await new Promise((r) => server.close(r)); });

  /** Run the hook as Claude Code does: JSON in, stdin closed, a home of its own. */
  function runHook(home) {
    return new Promise((resolve, reject) => {
      const child = execFile('node', [HOOK], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          OWNMIND_API_KEY: 'test-key-0123456789abcdef',
          OWNMIND_API_URL: baseUrl,
        },
        timeout: 25000,
      }, (err, out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(out)));
      // The line the ten timing-out tests were missing. Without it the hook waits on a pipe
      // nobody will ever close, and the failure reads as a hang with no output at all.
      child.stdin.end(JSON.stringify({ session_id: 'enf', hook_event_name: 'SessionStart' }));
    });
  }

  it('asks the server for the bundle', async () => {
    const home = tempDir('ownmind-enf-ask-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    await runHook(home);
    assert.ok(asked.some((u) => u.includes('/api/memory/enforcement-bundle')),
      `the hook never requested the bundle; it asked for: ${asked.join(', ')}`);
  });

  it('writes it where the later hooks look for it', async () => {
    const home = tempDir('ownmind-enf-write-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    await runHook(home);

    const cached = path.join(home, '.ownmind', 'cache', 'enforcement.json');
    assert.ok(fs.existsSync(cached),
      'enforcement.json is absent — every standards check on this machine is off, and the '
      + 'only symptom is a prompt line saying so');
    const parsed = JSON.parse(fs.readFileSync(cached, 'utf8'));
    assert.equal(parsed.selectors.length, 1, 'the bundle was written but is not the one served');
  });

  it('a session start still succeeds when the bundle cannot be fetched', async () => {
    // The bundle is not worth failing a session over. A machine that cannot reach the server
    // still has to start, and the prompt hook is what reports the consequence.
    const home = tempDir('ownmind-enf-down-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const out = await new Promise((resolve, reject) => {
      const child = execFile('node', [HOOK], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          OWNMIND_API_KEY: 'test-key-0123456789abcdef',
          // A port nothing is listening on, and not one `fetch` refuses outright.
          OWNMIND_API_URL: 'http://127.0.0.1:59999',
        },
        timeout: 25000,
      }, (err, o, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(o)));
      child.stdin.end(JSON.stringify({ session_id: 'down', hook_event_name: 'SessionStart' }));
    });
    assert.equal(typeof out, 'string');
  });
});
