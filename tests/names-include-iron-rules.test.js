import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stageHookHome } from './helpers/hook-home.js';
import { tempDir } from './helpers/temp-dir.js';

/**
 * The once-an-hour listing names every category that matched, iron rules included.
 *
 * v1.26.154 introduced the listing and had each caller strip `iron_rule` out of it, on the
 * grounds that the ⚠️ banner underneath already prints those and twice is once too many.
 * What that produced in practice, reported by the owner on 2026-08-13, is a line reading
 * "Iron rules 2/4" with names beside every other category and none beside that one — which
 * reads as the category that found nothing, directly above a banner that found two.
 *
 * v1.26.160 reverses it: everything matched is named, and the banner keeps doing its own job,
 * which is not to inform but to stop you.
 *
 * There was no test either way. The exclusion was three lines in three files and nothing
 * asserted it, so it could be removed without a single red — which is how a decision becomes
 * an accident. This file is the assertion that was missing, and it covers all three callers,
 * because "one of the three still strips them" is exactly the shape this project keeps
 * finding.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const IRON = { code: 'IR-777', title: 'a rule about deploying', tags: ['trigger:deploy'] };
const RESPONSE = {
  data: {
    trigger: 'deploy',
    counts: { iron_rule: 1, team_standard: 1, coding_standard: 0, principle: 0, profile: 0 },
    totals: { iron_rule: 4, team_standard: 32, coding_standard: 0, principle: 1, profile: 1 },
    names: { iron_rule: [IRON.title], team_standard: ['a standard about deploying'] },
    rules: [IRON],
  },
};

describe('the listing names iron rules as well as everything else', () => {
  let server;
  let baseUrl;
  let tmpHome;
  let statePath;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RESPONSE));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    tmpHome = stageHookHome({ apiUrl: baseUrl });
    statePath = path.join(tempDir('ownmind-names-state-'), 'edit-reminder.json');
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // Each case has to be the first operation of its hour, because the listing is what the
  // window throttles — a stale state file would leave every assertion below testing the
  // one-line form instead.
  beforeEach(() => { fs.rmSync(statePath, { force: true }); });

  function spawnHook(args, { payload, stdin }) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: tmpHome,
          USERPROFILE: tmpHome,
          __OWNMIND_EDIT_REMINDER_PATH: statePath,
        },
        stdio: 'pipe',
      });
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', () => resolve(stdout));
      child.stdin.end(stdin ?? JSON.stringify(payload));
    });
  }

  /** What the model is actually handed, whether the hook wraps it or prints it plain. */
  function shown(stdout) {
    const text = stdout.trim();
    if (!text) return '';
    try {
      return JSON.parse(text).hookSpecificOutput?.additionalContext || text;
    } catch {
      return text;
    }
  }

  it('the renderer the shell hook pipes into names them', async () => {
    const out = shown(await spawnHook(
      [path.join(repoRoot, 'hooks', 'ownmind-render-context.js'), '9.9.9', 'deploy', 's-render'],
      { stdin: JSON.stringify(RESPONSE) }
    ));
    assert.match(out, new RegExp(`Iron rules: ${IRON.title}`),
      `the iron rule is missing from the listing:\n${out}`);
    assert.match(out, /Team standards: a standard about deploying/,
      'the other categories must be unaffected');
  });

  it('and still prints the banner, which is a different job', async () => {
    const out = shown(await spawnHook(
      [path.join(repoRoot, 'hooks', 'ownmind-render-context.js'), '9.9.9', 'deploy', 's-banner'],
      { stdin: JSON.stringify(RESPONSE) }
    ));
    // The point of the change is that these overlap. The listing answers "what did OwnMind
    // find"; the banner is what stops you. Asserting only the listing would let a future
    // tidy-up delete the banner and stay green.
    assert.match(out, new RegExp(`⚠️ +${IRON.code}: ${IRON.title}`),
      `the banner no longer prints the rule:\n${out}`);
  });

  it('the command hook names them', async () => {
    const out = shown(await spawnHook(
      [path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.js')],
      {
        payload: {
          session_id: 's-command',
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git push origin main' },
        },
      }
    ));
    assert.match(out, new RegExp(`Iron rules: ${IRON.title}`),
      `the iron rule is missing from the listing:\n${out}`);
  });

  it('the edit hook names them', async () => {
    const out = shown(await spawnHook(
      [path.join(repoRoot, 'hooks', 'ownmind-edit-reminder.js')],
      {
        payload: {
          session_id: 's-edit',
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: '/tmp/x.js', old_string: 'a', new_string: 'b' },
        },
      }
    ));
    assert.match(out, new RegExp(`Iron rules: ${IRON.title}`),
      `the iron rule is missing from the listing:\n${out}`);
  });
});
