import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageHookHome } from './helpers/hook-home.js';

/**
 * v1.26.132 — when the rule lookup failed, the hook said nothing and behaved exactly as if
 * the user had no rules.
 *
 * The fetch was written with three separate silencers stacked on one line:
 *
 *   curl -sf --max-time 3 ... 2>/dev/null
 *
 * `-s` hides the progress and error text, `-f` returns empty on any 4xx/5xx instead of the
 * body, and `2>/dev/null` discards whatever survived. `RULES` then came back empty, and an
 * empty `RULES` is the same code path as "no rule matched this operation" — silence.
 *
 * So a server that was down, a key that had been revoked, and an operation with genuinely
 * no matching rule were indistinguishable, to the hook and to the user. Iron rules are a
 * safety mechanism; one that can switch itself off without a word is worse than one that is
 * absent, because absence is at least visible.
 *
 * This file is deliberately about the *record*, not about output on stdout: whatever lands
 * on stdout is fed to Claude Code and has to stay a valid envelope. The failure belongs in
 * the activity log, which is where every other hook failure in this project already goes
 * (`update_failed`, `edit_reminder_failed`) and where it survives the shell exiting.
 *
 * The 3-second timeout is raised to 5 here as part of the same fix. It is a ceiling on how
 * long a reminder may delay a command, not a correctness knob — but at 3 seconds an
 * ordinary slow connection silently lost the rules, which is this same defect arriving by a
 * different road.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

describe('v1.26.132 — a failed rule lookup is recorded, not swallowed', () => {
  let server;
  let baseUrl;
  let tmpHome;
  let respond;

  before(async () => {
    server = http.createServer((req, res) => respond(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    tmpHome = stageHookHome({ apiUrl: baseUrl });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true, force: true });
  });

  /** Every event the hook wrote to the local activity log during this run. */
  function loggedEvents() {
    const dir = path.join(tmpHome, '.ownmind', 'logs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /**
   * Both endpoints the hook may use to look rules up.
   *
   * v1.26.151 added `/hook-context` and made `/type/iron_rule` the fallback for a server that
   * does not have it. A stub that failed only the old URL would let the new one answer 200
   * and the hook would sail past the failure this file exists to prove is recorded — the test
   * would go green by measuring nothing, which is the same shape as the defect.
   */
  function isRuleLookup(url) {
    return url.includes('/api/memory/hook-context') || url.includes('/api/memory/type/iron_rule');
  }

  function run(command) {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', [path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.sh')], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
        stdio: 'pipe',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      }));
    });
  }

  it('a 500 from the rules endpoint is written to the activity log', async () => {
    respond = (req, res) => {
      if (isRuleLookup(req.url)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const r = await run('git commit -m x');
    const failures = loggedEvents().filter((e) => e.event === 'iron_rule_fetch_failed');
    assert.equal(failures.length, 1,
      `a failed lookup left no trace. exit=${r.status} events=${JSON.stringify(loggedEvents())}`);
    assert.match(failures[0].details.reason, /500/,
      'the record has to say what happened, or it is only a quieter kind of silence');
    assert.equal(failures[0].details.trigger, 'commit', 'and which operation lost its rules');
  });

  it('a revoked key (401) is recorded too', async () => {
    respond = (req, res) => {
      if (isRuleLookup(req.url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    await run('bash install.sh --api-key abc');
    const failures = loggedEvents().filter((e) => e.event === 'iron_rule_fetch_failed');
    assert.equal(failures.length, 1, 'an expired or revoked key must not look like "no rules"');
    assert.match(failures[0].details.reason, /401/);
  });

  it('a successful lookup records no failure', async () => {
    respond = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    };

    await run('git commit -m x');
    const failures = loggedEvents().filter((e) => e.event === 'iron_rule_fetch_failed');
    assert.equal(failures.length, 0, 'no rules matched is not a failure — it must stay quiet');
  });

  it('the failure never reaches stdout and never blocks the command', async () => {
    respond = (req, res) => {
      if (isRuleLookup(req.url)) {
        res.writeHead(500);
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const r = await run('git commit -m x');
    assert.equal(r.status, 0, 'a hook must never fail the tool call it is inspecting');
    if (r.stdout.trim()) {
      // Whatever is printed is handed to Claude Code, so it has to remain a valid envelope.
      JSON.parse(r.stdout.trim());
    }
    assert.doesNotMatch(r.stdout, /"decision"\s*:\s*"block"/);
  });
});
