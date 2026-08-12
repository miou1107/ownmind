import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageHookHome } from './helpers/hook-home.js';

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
  let otherRepo;
  let rulesResponse = { data: [] };

  before(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      hits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rulesResponse));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // The version this stages into ~/.ownmind/package.json makes the version gate reachable;
    // the gate must still decline to fire, because the cwd below is a different repository.
    tmpHome = stageHookHome({ apiUrl: baseUrl });

    // A cached rule marked "block if this fails", with a condition that cannot pass (no
    // compliance events exist under this HOME). This is the shape a pre-v1.26.89 server
    // attached on its own. The hooks must report it and let the command through.
    fs.mkdirSync(path.join(tmpHome, '.ownmind', 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.ownmind', 'cache', 'iron_rules.json'),
      JSON.stringify([{
        code: 'IR-TEST',
        title: 'a rule that has nothing to do with running tests',
        metadata: {
          verification: {
            mode: 'pre_action',
            trigger: ['deploy', 'commit'],
            block_on_fail: true,
            conditions: {
              type: 'recent_event_exists',
              params: { event: 'test-pass', action: 'comply' },
              message: '還沒跑測試',
            },
          },
        },
      }], null, 2)
    );
    otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-otherrepo-'));
    for (const args of [
      ['init', '-q'],
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    ]) {
      execFileSync('git', args, { cwd: otherRepo, stdio: 'ignore' });
    }
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(otherRepo, { recursive: true, force: true });
  });

  /**
   * The failure message these assertions used to carry was a guess — "the command was not
   * extracted" — and a guess is what a reader then spends an afternoon disproving. Attach
   * what the hook actually did instead: an early exit from a guard higher up prints its own
   * envelope on stdout, and a crash prints on stderr.
   */
  function why(r, guess) {
    return [
      guess,
      `exit=${r.status}`,
      r.stdout ? `stdout=${r.stdout.slice(0, 500)}` : 'stdout=(empty)',
      r.stderr ? `stderr=${r.stderr.slice(0, 500)}` : 'stderr=(empty)',
    ].join('\n  ');
  }

  /**
   * Run a hook with the given stdin and report whether it reached the rules endpoint.
   * Async on purpose: spawnSync would block this process's event loop, so the local
   * server could not answer and every hook would look like it never called out.
   */
  function run(hookPath, payload, opts = {}) {
    const before = hits.length;
    const isShell = hookPath.endsWith('.sh');
    return new Promise((resolve, reject) => {
      const child = spawn(
        isShell ? 'bash' : process.execPath,
        [path.join(repoRoot, hookPath)],
        {
          cwd: opts.cwd || repoRoot,
          env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
          stdio: 'pipe',
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      // v1.26.120 — kept, not resumed into the void (IR-003). These assertions fail on a
      // platform the author is not on, and `reached: false` on its own says nothing about
      // why the hook stopped: a payload it could not parse, a guard higher up that exited
      // first, and a crash all look identical. Every one of those writes a different stderr.
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', reject);
      child.on('close', (status) => {
        // v1.26.151: either endpoint counts as "the hook looked the rules up". `/hook-context` is
        // what it asks for now; `/type/iron_rule` is the fallback for a server without it, and
        // these assertions are about whether a lookup happened at all, not about which URL.
        const reached = hits.slice(before).some((u) => (u.includes('/api/memory/hook-context') || u.includes('/api/memory/type/iron_rule')));
        resolve({ status, stdout, stderr, reached });
      });
      child.stdin.end(payload);
    });
  }

  for (const hook of ['hooks/ownmind-iron-rule-check.sh', 'hooks/ownmind-iron-rule-check.js']) {
    it(`${hook}: the real Claude Code payload reaches the rules endpoint`, async () => {
      const r = await run(hook, REAL_PAYLOAD);
      assert.equal(r.reached, true,
        why(r, 'tool_input.command was not extracted — the hook exited at the empty-command guard'));
    });

    it(`${hook}: a bare { command } payload still works`, async () => {
      const r = await run(hook, BARE_PAYLOAD);
      assert.equal(r.reached, true, why(r, 'manual invocation with a bare payload must keep working'));
    });

    it(`${hook}: a payload with no command stays silent and exits 0`, async () => {
      const r = await run(hook, NO_COMMAND_PAYLOAD);
      assert.equal(r.reached, false, 'nothing to check — must not call the API');
      assert.equal(r.status, 0, 'a hook must never fail the tool call it is inspecting');
      assert.equal(r.stdout.trim(), '', 'must print nothing');
    });

    it(`${hook}: a non-string command is treated as absent`, async () => {
      // An ARRAY, deliberately: a plain object stringifies to something no trigger regex
      // matches, so the hook would exit at the trigger gate whether or not the type is
      // checked — that assertion would hold for the wrong reason. An array stringifies to
      // text that still contains "git commit", so it clears the trigger gate and reaches
      // the API unless the value is rejected for not being a string.
      const r = await run(hook, JSON.stringify({
        tool_input: { command: ['git commit -m x'] },
      }));
      assert.equal(r.reached, false, 'a non-string command must not start a rule lookup');
      assert.equal(r.status, 0);
    });

    it(`${hook}: git push outside the OwnMind checkout is not blocked`, async () => {
      // This gate compares OwnMind's own version against `git tag -l` in the user's cwd.
      // It had never executed, so un-hiding it would block pushes in every other repo,
      // telling the user to create OwnMind's version tag there.
      const r = await run(hook, JSON.stringify({
        tool_name: 'Bash', tool_input: { command: 'git push origin main' },
      }), { cwd: otherRepo });
      assert.doesNotMatch(r.stdout, /"decision"\s*:\s*"block"/,
        'a push in an unrelated repository must not be blocked by OwnMind version state');
    });

    it(`${hook}: an ordinary command produces no output at all`, async () => {
      // Not a trigger. Must not inject an empty context blob in front of every Bash call.
      const r = await run(hook, JSON.stringify({
        tool_name: 'Bash', tool_input: { command: 'ls -la' },
      }));
      assert.equal(r.stdout.trim(), '', 'silence, not an empty additionalContext');
    });
  }

  for (const hook of ['hooks/ownmind-iron-rule-check.sh', 'hooks/ownmind-iron-rule-check.js']) {
    it(`${hook}: a failing block_on_fail rule reports but does not block`, async () => {
      // The conditions come from a cache that mirrors the server, and the server-side data
      // still carries verification templates a pre-v1.26.89 bug attached by itself — all of
      // them blocking. Nobody has ever seen this path run, so restoring the hook must not
      // silently start enforcing conditions no user wrote. Report, do not abort.
      const r = await run(hook, JSON.stringify({
        tool_name: 'Bash', tool_input: { command: 'git push origin main' },
      }), { cwd: otherRepo });

      assert.doesNotMatch(r.stdout, /"decision"\s*:\s*"block"/,
        'a cached blocking rule must not abort the command');
      assert.notEqual(r.stdout.trim(), '', 'the failure must still be reported, not hidden');
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.decision, undefined);
      assert.match(parsed.hookSpecificOutput.additionalContext, /IR-TEST/,
        'the rule that failed must be named');
    });
  }

  it('the .sh reminder is delivered as hookSpecificOutput, not bare stdout', async () => {
    // A PreToolUse hook exiting 0 has its bare stdout shown only in transcript mode; it
    // never reaches the model. The reminder text instructs the AI, so bare stdout means
    // the instruction can never arrive.
    rulesResponse = {
      data: [{ code: 'IR-001', tags: ['trigger:commit'], title: 't', content: 'c' }],
    };
    try {
      const r = await run('hooks/ownmind-iron-rule-check.sh', REAL_PAYLOAD);
      assert.notEqual(r.stdout.trim(), '', 'a matching rule must produce output');
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PreToolUse');
      assert.match(parsed.hookSpecificOutput.additionalContext, /鐵律檢查/);
    } finally {
      rulesResponse = { data: [] };
    }
  });

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
  const tracked = execFileSync('git', ['ls-files', '*.sh', '*.js', '*.cjs', '*.mjs', '*.ps1'], {
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
    // Matched against the whole file, not line by line: `readFileSync(` and its argument
    // can sit on separate lines, and a per-line regex would report zero offenders while
    // the defect is fully present. Line numbers come from the match index instead.
    const pattern = /readFileSync\(\s*['"]\/dev\/stdin['"]/g;
    const offenders = [];
    for (const f of tracked) {
      const text = fs.readFileSync(path.join(repoRoot, f), 'utf8');
      for (const m of text.matchAll(pattern)) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${f}:${line}`);
      }
    }
    assert.deepEqual(offenders, [],
      "use readFileSync(0); '/dev/stdin' does not exist for node on Windows");
  });

  it('the scan catches a read split across lines', () => {
    // The evasion that the line-based first draft missed, pinned so it cannot come back.
    const split = "const d = require('fs').readFileSync(\n  '/dev/stdin', 'utf8');";
    assert.match(split, /readFileSync\(\s*['"]\/dev\/stdin['"]/);
  });
});
