import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOL_TRIGGERS, detectToolTrigger, ruleMatchesTrigger } from '../shared/helpers.js';
import {
  decideEditReminder,
  renderEditReminderLine,
  WINDOW_MS,
} from '../shared/edit-reminder-state.js';

/**
 * v1.26.92 — the rules people tag most were the ones that never fired.
 *
 * The hook was registered for `Bash` only, so a rule could fire only while a shell command
 * ran. Editing a file is not a shell command. On the account this was measured against,
 * `trigger:edit` was the most-used tag of all — 56 rules, 68 once aliases and the untagged
 * rules that match everything are counted — and not one of them had ever been surfaced.
 *
 * Editing is also the most frequent thing in a session, so the reminder is throttled: the
 * full listing once an hour, a single line for every edit after that. A reminder that is
 * in the way gets switched off, and a switched-off reminder enforces nothing.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const editPayload = (toolName = 'Edit') => JSON.stringify({
  session_id: 'test-session',
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: { file_path: '/tmp/x.js', old_string: 'a', new_string: 'b' },
});

describe('v1.26.92 — the edit trigger, end to end through both hook copies', () => {
  let server;
  let hits;
  let tmpHome;
  let statePath;

  /** Two rules match `edit`, one does not — so a count is a real assertion, not a tautology. */
  const rulesResponse = { data: [
    { code: 'IR-001', title: 'a rule about editing', tags: ['trigger:edit'] },
    { code: 'IR-002', title: 'a rule filed under write', tags: ['trigger:write'] },
    { code: 'IR-003', title: 'a rule about deploying', tags: ['trigger:deploy'] },
  ] };

  before(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      hits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rulesResponse));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-edittrig-'));
    statePath = path.join(tmpHome, 'edit-reminder.json');
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: baseUrl } } },
      })
    );
    // No ~/.ownmind/.git — that keeps the .sh one-time upgrade block, which runs git pull,
    // from firing inside a test.
    fs.mkdirSync(path.join(tmpHome, '.ownmind', 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.ownmind', 'package.json'),
      JSON.stringify({ version: '99.99.99' })
    );
    // The .sh hook runs the edit reminder by absolute path under HOME, the way it already
    // runs ownmind-verify-trigger.js.
    fs.symlinkSync(path.join(repoRoot, 'shared'), path.join(tmpHome, '.ownmind', 'shared'));
    fs.symlinkSync(
      path.join(repoRoot, 'hooks', 'ownmind-edit-reminder.js'),
      path.join(tmpHome, '.ownmind', 'hooks', 'ownmind-edit-reminder.js')
    );
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(statePath, { force: true });
  });

  function run(hookPath, payload) {
    const before = hits.length;
    const isShell = hookPath.endsWith('.sh');
    return new Promise((resolve, reject) => {
      const child = spawn(
        isShell ? 'bash' : process.execPath,
        [path.join(repoRoot, hookPath)],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            HOME: tmpHome,
            USERPROFILE: tmpHome,
            __OWNMIND_EDIT_REMINDER_PATH: statePath,
          },
          stdio: 'pipe',
        }
      );
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (status) => {
        const reached = hits.slice(before).some((u) => u.includes('/api/memory/type/iron_rule'));
        resolve({ status, stdout, reached, context: contextOf(stdout) });
      });
      child.stdin.end(payload);
    });
  }

  /** The additionalContext the model would actually receive, or '' when the hook was silent. */
  function contextOf(stdout) {
    const line = stdout.trim();
    if (!line) return '';
    try {
      return JSON.parse(line).hookSpecificOutput?.additionalContext || '';
    } catch {
      return '';
    }
  }

  for (const hook of ['hooks/ownmind-iron-rule-check.sh', 'hooks/ownmind-iron-rule-check.js']) {
    it(`${hook}: an Edit call lists the rules — the whole point of the release`, async () => {
      const r = await run(hook, editPayload('Edit'));
      assert.equal(r.status, 0);
      assert.equal(r.reached, true, 'the edit trigger must look the rules up');
      assert.match(r.context, /IR-001/, 'a trigger:edit rule must be listed');
      assert.match(r.context, /IR-002/, 'trigger:write means the same thing and must be listed');
      assert.doesNotMatch(r.context, /IR-003/, 'a deploy-only rule must not be dragged in');
    });

    it(`${hook}: Write is an edit too`, async () => {
      const r = await run(hook, editPayload('Write'));
      assert.match(r.context, /IR-001/);
    });

    it(`${hook}: the second edit in the window is one line, and asks nobody`, async () => {
      const first = await run(hook, editPayload());
      assert.equal(first.reached, true);

      const second = await run(hook, editPayload());
      assert.equal(second.reached, false,
        'the throttled path must make no request — the count is carried in the state file');
      assert.equal(
        second.context,
        '【OwnMind v99.99.99】AI 改檔案要遵守的鐵律 2 條 · 本小時第 2 次'
      );

      const third = await run(hook, editPayload('MultiEdit'));
      assert.match(third.context, /本小時第 3 次$/, 'the occurrence must keep counting');
    });

    it(`${hook}: once the hour is up, the full listing comes back`, async () => {
      fs.writeFileSync(statePath, JSON.stringify({
        window_start_ms: Date.now() - (WINDOW_MS + 60_000),
        occurrence: 9,
        rule_count: 2,
      }));
      const r = await run(hook, editPayload());
      assert.equal(r.reached, true, 'an expired window must list again');
      assert.match(r.context, /IR-001/);
      assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).occurrence, 1,
        'a new window restarts the count');
    });

    it(`${hook}: a corrupt state file costs one extra listing, never a suppressed one`, async () => {
      fs.writeFileSync(statePath, 'this is not json');
      const r = await run(hook, editPayload());
      assert.match(r.context, /IR-001/, 'must fail open, in the direction of showing more');
      assert.equal(r.status, 0);
    });

    it(`${hook}: the edit trigger never blocks`, async () => {
      for (const payload of [editPayload(), editPayload(), editPayload()]) {
        const r = await run(hook, payload);
        assert.equal(r.status, 0);
        const parsed = r.stdout.trim() ? JSON.parse(r.stdout.trim()) : {};
        assert.equal('decision' in parsed, false,
          'an edit must never be aborted — the verification engine is not on this path');
      }
    });

    it(`${hook}: a tool that does not change files stays silent`, async () => {
      const r = await run(hook, JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'x' },
      }));
      assert.equal(r.reached, false);
      assert.equal(r.stdout.trim(), '');
      assert.equal(r.status, 0);
    });

    it(`${hook}: a Bash command is still resolved by the command, not the tool name`, async () => {
      // The regression guard for the priority rule: tool_name is only consulted when there
      // is no command, so commit/deploy/delete behave exactly as in v1.26.91.
      const r = await run(hook, JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m x' },
      }));
      assert.equal(r.reached, true);
      assert.doesNotMatch(r.context, /改檔案/, 'a commit must not render as an edit reminder');
      assert.equal(fs.existsSync(statePath), false, 'a commit must not open an edit window');
    });
  }
});

describe('v1.26.92 — the throttle decision, without waiting an hour', () => {
  it('no state means show the full listing', () => {
    const d = decideEditReminder(null, 1000);
    assert.equal(d.mode, 'full');
    assert.equal(d.occurrence, 1);
  });

  it('inside the window it counts up', () => {
    const state = { window_start_ms: 1000, occurrence: 3, rule_count: 68 };
    const d = decideEditReminder(state, 1000 + WINDOW_MS - 1);
    assert.equal(d.mode, 'line');
    assert.equal(d.occurrence, 4);
    assert.equal(d.window_start_ms, 1000, 'the window does not slide forward on each edit');
    assert.equal(d.rule_count, 68, 'the count is carried so the throttled path needs no network');
  });

  it('the boundary belongs to the next window', () => {
    const state = { window_start_ms: 1000, occurrence: 3, rule_count: 68 };
    assert.equal(decideEditReminder(state, 1000 + WINDOW_MS).mode, 'full');
  });

  it('a clock that jumped backwards starts a new window rather than counting forever', () => {
    const state = { window_start_ms: 10_000, occurrence: 3, rule_count: 68 };
    assert.equal(decideEditReminder(state, 5_000).mode, 'full');
  });
});

describe('v1.26.92 — what the one-line reminder says', () => {
  const line = renderEditReminderLine('1.26.92', 68, 4);

  it('names the AI as the party bound by the rules', () => {
    // Without this the line reads as an instruction to whoever is watching the screen, and
    // they are not the party the rules apply to.
    assert.match(line, /AI/);
  });

  it('carries the count and the occurrence', () => {
    assert.match(line, /68 條/);
    assert.match(line, /第 4 次/);
  });

  it('does not claim the rules were followed', () => {
    // The hook can see that the rules were put in front of the AI. It cannot see whether
    // they were obeyed, and a line that claims so is false exactly when it matters.
    for (const claim of ['正在遵守', '已遵守', '遵守中']) {
      assert.doesNotMatch(line, new RegExp(claim));
    }
  });
});

describe('v1.26.92 — trigger derivation', () => {
  it('every file-changing tool maps to edit', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      assert.equal(detectToolTrigger(tool), 'edit', tool);
    }
  });

  it('anything else maps to nothing', () => {
    for (const tool of ['Read', 'Grep', 'Bash', 'Glob', '', null, undefined, 42]) {
      assert.equal(detectToolTrigger(tool), null, String(tool));
    }
  });

  it('trigger:write reaches the edit trigger', () => {
    // 23 rules on the measured account carry it, the second most-used tag there. Without
    // the alias the Write tool would fire the edit trigger and then drop all of them.
    assert.equal(ruleMatchesTrigger({ tags: ['trigger:write'] }, 'edit'), true);
    assert.equal(ruleMatchesTrigger({ tags: ['trigger:編輯'] }, 'edit'), true);
    assert.equal(ruleMatchesTrigger({ tags: ['trigger:deploy'] }, 'edit'), false);
  });
});

describe('v1.26.92 — the .sh copy of the tool list does not drift', () => {
  const sh = fs.readFileSync(path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.sh'), 'utf8');

  it('matches TOOL_TRIGGERS in shared/helpers.js', () => {
    // The .sh dispatches on tool name in a shell `case`, so it cannot import the module.
    // Same trade as the v1.26.91 alias table: duplication is fine only while something
    // checks the copies still agree.
    const m = sh.match(/case "\$TOOL_NAME" in\s*\n\s*([A-Za-z|]+)\)/);
    assert.ok(m, 'the .sh hook no longer dispatches on tool name');
    assert.deepEqual(m[1].split('|').sort(), Object.keys(TOOL_TRIGGERS).sort());
  });
});

describe('v1.26.92 — the installer registers both matchers, and only once', () => {
  const EXPECTED = ['Bash', 'Edit|Write|MultiEdit|NotebookEdit'];

  /**
   * Runs install.sh's real settings-editing block, twice.
   *
   * Twice on purpose: the presence check used to ask "is this hook registered anywhere in
   * PreToolUse", which is true on every existing install — so the second matcher would
   * never have reached anyone who already had the first, and every user is an upgrade.
   * A single run cannot tell the two behaviours apart.
   */
  function runInstallerBlock(settingsPath) {
    const installSh = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
    const start = installSh.indexOf('# --- 4c.');
    assert.ok(start > 0, 'install.sh no longer has the 4c hook-settings step');
    const open = installSh.indexOf('node -e "', start);
    const close = installSh.indexOf('\n" 2>>', open);
    assert.ok(open > 0 && close > open, 'could not find the node -e block in step 4c');

    const script = installSh
      .slice(open + 'node -e "'.length, close)
      .replaceAll('$CLAUDE_SETTINGS_WIN', settingsPath)
      .replaceAll('\\"', '"');
    execFileSync(process.execPath, ['-e', script], { stdio: 'ignore' });
  }

  it('adds both entries, and adds nothing on a second run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-installer-'));
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({}));

    runInstallerBlock(settingsPath);
    const first = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(first.hooks.PreToolUse.map(h => h.matcher), EXPECTED);

    runInstallerBlock(settingsPath);
    const second = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(second.hooks.PreToolUse.map(h => h.matcher), EXPECTED,
      'running the installer twice must not duplicate the entries');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an install that already has only the Bash entry gets the edit one added', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-installer-'));
    const settingsPath = path.join(dir, 'settings.json');
    const existing = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-iron-rule-check.sh' }],
    };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [existing] } }));

    runInstallerBlock(settingsPath);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(after.hooks.PreToolUse.map(h => h.matcher), EXPECTED);
    assert.deepEqual(after.hooks.PreToolUse[0], existing, 'the existing entry is left alone');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
