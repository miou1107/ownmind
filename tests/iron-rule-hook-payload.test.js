import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * v1.26.90 — the PreToolUse iron-rule hook never saw the command.
 *
 * Two independent defects stacked, and both were invisible:
 *
 *   1. `readFileSync('/dev/stdin')` — Windows node resolves that POSIX path against the
 *      drive root (C:\dev\stdin) and throws ENOENT. The throw sits outside the try, and
 *      the whole block is wrapped in `2>/dev/null`, so the error went nowhere.
 *   2. `JSON.parse(d).command` — Claude Code sends { tool_name, tool_input: { command } }.
 *      There is no top-level `command`. This half was never platform-specific: on macOS
 *      the stdin read succeeded and the extraction still yielded ''.
 *
 * Either one leaves the hook at `if (!command) exit 0`, which is a silent, successful
 * exit. So the reminder had never fired for anyone, on any platform.
 *
 * These tests use one content-independent signal: `!command` is checked BEFORE the
 * credential read, so *the hook contacting the API at all* proves the command was
 * extracted. That keeps the assertion off rule text, which changes release to release.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** The shape Claude Code actually sends to a PreToolUse hook. */
const REAL_PAYLOAD = JSON.stringify({
  session_id: 'test-session',
  transcript_path: '/tmp/nope.jsonl',
  cwd: '/tmp',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git commit -m "test"' },
});

/** The shape the hooks were written against, still supported for manual invocation. */
const BARE_PAYLOAD = JSON.stringify({ command: 'git commit -m "test"' });

/** A payload with a tool that carries no command at all — must stay silent. */
const NO_COMMAND_PAYLOAD = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '/tmp/x' },
});

describe('v1.26.90 — the hook extracts the command Claude Code actually sends', () => {
  let server;
  let baseUrl;
  let hits;
  let tmpHome;

  before(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      hits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-irhook-'));
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: baseUrl } },
        },
      })
    );
    // Deliberately no ~/.ownmind/.git — that keeps the .sh one-time upgrade block, which
    // would run `git pull`, from firing inside a test.
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Run a hook with the given stdin and report whether it reached the rules endpoint.
   * Async on purpose: spawnSync would block this process's event loop, so the local
   * server could not answer and every hook would look like it never called out.
   */
  function run(hookPath, payload) {
    const before = hits.length;
    const isShell = hookPath.endsWith('.sh');
    return new Promise((resolve, reject) => {
      const child = spawn(
        isShell ? 'bash' : process.execPath,
        [path.join(repoRoot, hookPath)],
        { env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome }, stdio: 'pipe' }
      );
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (status) => {
        const reached = hits.slice(before).some((u) => u.includes('/api/memory/type/iron_rule'));
        resolve({ status, stdout, reached });
      });
      child.stdin.end(payload);
    });
  }

  for (const hook of ['hooks/ownmind-iron-rule-check.sh', 'hooks/ownmind-iron-rule-check.js']) {
    it(`${hook}: the real Claude Code payload reaches the rules endpoint`, async () => {
      const r = await run(hook, REAL_PAYLOAD);
      assert.equal(r.reached, true,
        'tool_input.command was not extracted — the hook exited at the empty-command guard');
    });

    it(`${hook}: a bare { command } payload still works`, async () => {
      const r = await run(hook, BARE_PAYLOAD);
      assert.equal(r.reached, true, 'manual invocation with a bare payload must keep working');
    });

    it(`${hook}: a payload with no command stays silent and exits 0`, async () => {
      const r = await run(hook, NO_COMMAND_PAYLOAD);
      assert.equal(r.reached, false, 'nothing to check — must not call the API');
      assert.equal(r.status, 0, 'a hook must never fail the tool call it is inspecting');
      assert.equal(r.stdout.trim(), '', 'must print nothing');
    });
  }

  it('the pre-v1.26.90 extraction is what failed, reproduced', () => {
    // Not a tautology check: this is the exact expression both hooks carried, run against
    // the exact payload Claude Code sends.
    assert.equal(JSON.parse(REAL_PAYLOAD).command, undefined);
    assert.equal(JSON.parse(REAL_PAYLOAD).tool_input.command, 'git commit -m "test"');
  });
});

describe('v1.26.90 — no shipped script reads stdin through the POSIX-only path', () => {
  // Grown, not hand-listed: a new script with the same defect is caught without anyone
  // remembering to add it here.
  const tracked = execFileSync('git', ['ls-files', '*.sh', '*.js', '*.cjs', '*.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('tests/') && !f.startsWith('docs/'));

  it('finds files to check (fails closed if the listing breaks)', () => {
    assert.ok(tracked.length > 50, `expected a repo-wide listing, got ${tracked.length}`);
  });

  it("no readFileSync('/dev/stdin') survives", () => {
    const offenders = [];
    for (const f of tracked) {
      const text = fs.readFileSync(path.join(repoRoot, f), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/readFileSync\(\s*['"]\/dev\/stdin['"]/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(offenders, [],
      "use readFileSync(0); '/dev/stdin' does not exist for node on Windows");
  });
});
