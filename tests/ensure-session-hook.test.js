// v1.26.86 — the settings repair, run as the product runs it.
//
// Four rounds of Windows fixes were declared complete on the assumption that install.ps1's
// repair block executed. It did not, and the evidence was sitting in production the whole
// time: 采瑤 upgraded to v1.26.84 at 16:38 and her SessionStart entry still had a single
// `null` matcher afterwards. The repair had shipped in v1.26.82. It never ran on her
// machine, and nothing said so, because a PowerShell `ConvertTo-Json` round trip that
// fails simply returns a value that is not "true".
//
// The lesson is not "PowerShell is awkward". It is that the one link in the chain nobody
// had executed was the one that turned out to be broken — every time, for four releases.
// So this file executes the real script, as a process, against real files.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts/install-helpers/ensure-session-hook.cjs');

function sandbox(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-hookfix-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const p = path.join(home, '.claude', 'settings.json');
  if (settings !== undefined) fs.writeFileSync(p, JSON.stringify(settings, null, 2));
  return { home, settingsPath: p, ownmindDir: path.join(home, '.ownmind') };
}

function run({ settingsPath, ownmindDir }, platform = 'win32') {
  // Windows by default: that is the platform every one of these defects lived on, and the
  // one this machine cannot otherwise reach.
  const out = execFileSync(process.execPath, [
    SCRIPT, '--settings', settingsPath, '--ownmind-dir', ownmindDir, '--platform', platform,
  ], { encoding: 'utf8' });
  return out.trim();
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const entryWith = (command, matcher = null) => ({ matcher, hooks: [{ type: 'command', command, timeout: 10 }] });

describe('ensure-session-hook.cjs — executed as a process, against real files', () => {
  it('installs four matchers when there is nothing', () => {
    const s = sandbox({ hooks: {} });
    assert.equal(run(s), 'OK:hook:installed');
    const after = read(s.settingsPath).hooks.SessionStart;
    assert.deepEqual(after.map((e) => e.matcher), ['startup', 'resume', 'clear', 'compact']);
  });

  it('is idempotent — the second run changes nothing', () => {
    const s = sandbox({ hooks: {} });
    run(s);
    const before = fs.readFileSync(s.settingsPath, 'utf8');
    assert.equal(run(s), 'OK:hook:unchanged');
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), before,
      'a daily updater that rewrites an already-correct file churns it forever');
  });

  it("repairs 采瑤's real entry: one null matcher becomes four", () => {
    // Her settings verbatim, as reported by her own machine at 16:38 on v1.26.84.
    const s = sandbox({
      hooks: {
        SessionStart: [entryWith('node C:/Users/Celia/.ownmind/hooks/ownmind-session-start.js')],
      },
    });
    assert.equal(run(s), 'OK:hook:repaired');
    const after = read(s.settingsPath).hooks.SessionStart;
    assert.deepEqual(after.map((e) => e.matcher), ['startup', 'resume', 'clear', 'compact']);
  });

  it("repairs Adam's real entry: four matchers pointing at the copy that cannot run", () => {
    const s = sandbox({
      hooks: {
        SessionStart: ['startup', 'resume', 'clear', 'compact'].map((m) =>
          entryWith('node "C:/Users/Adam/.claude/hooks/ownmind-session-start.js"', m)),
      },
    });
    assert.equal(run(s), 'OK:hook:repaired');
    for (const e of read(s.settingsPath).hooks.SessionStart) {
      assert.doesNotMatch(e.hooks[0].command, /\.claude[\\/]hooks/);
    }
  });

  it('repairs an unquoted command whose path contains a space', () => {
    // "C:\Users\Jane Doe" is an ordinary Windows home directory. Unquoted, the path has a
    // space in the middle; mis-reading that as a user customisation would leave exactly
    // the broken cohort unrepaired, silently, forever.
    const s = sandbox({
      hooks: {
        SessionStart: [entryWith('node C:/Users/Jane Doe/.claude/hooks/ownmind-session-start.js')],
      },
    });
    assert.equal(run(s), 'OK:hook:repaired');
    const after = read(s.settingsPath).hooks.SessionStart;
    assert.deepEqual(after.map((e) => e.matcher), ['startup', 'resume', 'clear', 'compact']);
    for (const e of after) assert.doesNotMatch(e.hooks[0].command, /\.claude[\\/]hooks/);
  });

  it('refuses a settings file that parses to something other than an object', () => {
    // A JSON array survives `typeof === 'object'`; JSON.stringify then drops any named
    // properties added to it, so the run would report success while writing nothing.
    const s = sandbox();
    fs.writeFileSync(s.settingsPath, '[1, 2, 3]');
    let code = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, [SCRIPT, '--settings', s.settingsPath, '--ownmind-dir', s.ownmindDir, '--platform', 'win32'], { encoding: 'utf8' });
    } catch (e) { code = e.status; out = e.stdout || ''; }
    assert.equal(code, 1);
    assert.match(out, /^ERROR:hook:/);
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), '[1, 2, 3]', 'the file must be left as it was');
  });

  it('honors the ~/.ownmind/.no-session-hook opt-out and touches nothing', () => {
    // The documented way to opt out entirely. A user who set this flag and deleted our
    // entries must not find them re-installed by the next daily update — that is an
    // argument the user cannot win.
    const s = sandbox({
      hooks: { SessionStart: [entryWith('node C:/x/.claude/hooks/ownmind-session-start.js')] },
    });
    fs.mkdirSync(s.ownmindDir, { recursive: true });
    fs.writeFileSync(path.join(s.ownmindDir, '.no-session-hook'), '');
    const before = fs.readFileSync(s.settingsPath, 'utf8');
    assert.equal(run(s), 'OK:hook:opted_out');
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), before,
      'opted out means not even a repair');
  });

  it('leaves a hand-edited command alone and says so', () => {
    const s = sandbox({
      hooks: { SessionStart: [entryWith('node /x/ownmind-session-start.js --debug', 'startup')] },
    });
    assert.equal(run(s), 'OK:hook:user_customised');
  });

  it('keeps every other hook the user has', () => {
    const s = sandbox({
      hooks: {
        SessionStart: [entryWith('node C:/x/ownmind-session-start.js')],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }],
      },
      permissions: { allow: ['Bash'] },
    });
    run(s);
    const after = read(s.settingsPath);
    assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'mine.sh');
    assert.deepEqual(after.permissions, { allow: ['Bash'] });
  });

  it('refuses to touch a settings file it cannot parse', () => {
    // Overwriting here would delete every other hook the user has.
    const s = sandbox();
    fs.writeFileSync(s.settingsPath, '{ broken');
    let code = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, [SCRIPT, '--settings', s.settingsPath, '--ownmind-dir', s.ownmindDir, '--platform', 'win32'], { encoding: 'utf8' });
    } catch (e) { code = e.status; out = e.stdout || ''; }
    assert.equal(code, 1);
    assert.match(out, /^ERROR:hook:/);
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), '{ broken', 'the file must be left as it was');
  });

  it('survives a BOM, which Windows PowerShell writes', () => {
    const s = sandbox();
    fs.writeFileSync(s.settingsPath, '\ufeff' + JSON.stringify({ hooks: {} }));
    assert.equal(run(s), 'OK:hook:installed');
  });
});

describe('the installers call it instead of marshalling JSON through PowerShell', () => {
  // Not "mentions the filename" — the first version of this test passed on a comment while
  // the scripts did nothing, which is the same false green that let four Windows releases
  // ship. The assertion is a line that actually executes node against the helper, and it
  // was mutation-checked: deleting that line in any of the four turns this red.
  const INVOKES = /(^|\n)[^\n#]*\bnode\b[^\n]*(EnsureHook|ENSURE_HOOK|ensure-session-hook\.cjs)[^\n]*/;

  for (const rel of ['install.ps1', 'install.sh', 'scripts/update.ps1', 'scripts/update.sh']) {
    it(`${rel} runs ensure-session-hook.cjs`, () => {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const line = src.match(INVOKES);
      assert.ok(line, `${rel} never executes ensure-session-hook.cjs`);
      assert.doesNotMatch(line[0].trim(), /^(#|\/\/)/, 'the only match is a comment');
    });
  }

  // The helper prints "ERROR:hook:<why>" and exits 1. A script that pastes that into a
  // "[ OK ]" line has hidden the failure behind a green checkmark — the exact disease this
  // whole change treats. Asserting the whole if/else shape (not just that "[FAIL]" appears
  // somewhere) also catches the swapped-branch mutation: [FAIL] on success, [ OK ] on error.
  const PS1_BRANCHES = /if \(\$LASTEXITCODE -eq 0\) \{\s*Write-Host "(?:\[ OK \] |   )SessionStart hook: \$hookResult"\s*\} else \{\s*Write-Host "(?:\[FAIL\]|   \[FAIL\]) SessionStart hook: \$hookResult"\s*\}/;
  const SH_BRANCHES = /if hook_result=\$\(node "\$ENSURE_HOOK"[^\n]*\); then\s*\n\s*echo "(?:\[ OK \] |   )SessionStart hook: \$hook_result"\s*\n\s*else\s*\n\s*echo "(?:\[FAIL\]|   \[FAIL\]) SessionStart hook: \$hook_result"\s*\n\s*fi/;
  for (const [rel, shape] of [
    ['install.ps1', PS1_BRANCHES], ['scripts/update.ps1', PS1_BRANCHES],
    ['install.sh', SH_BRANCHES], ['scripts/update.sh', SH_BRANCHES],
  ]) {
    it(`${rel} prints [FAIL] on a non-zero exit and success text only on zero`, () => {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.match(src, shape, `${rel} does not branch on the helper's exit code correctly`);
    });
  }

  it('install.ps1 runs the helper AFTER its own last write of settings.json', () => {
    // The first shipped shape of this change called the helper mid-script and then wrote a
    // stale in-memory snapshot of settings.json back over the helper's work — a fresh
    // Windows install ended with no SessionStart entries and a green OK on screen. The
    // repair must be the final word on that file.
    const src = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
    const lastSettingsWrite = src.lastIndexOf('Write-Utf8NoBom -Path $ClaudeSettings');
    const helperCall = src.indexOf('& node $EnsureHook');
    assert.ok(lastSettingsWrite !== -1 && helperCall !== -1, 'expected markers are missing');
    assert.ok(helperCall > lastSettingsWrite,
      'install.ps1 writes settings.json after the helper ran — that write reverts the repair');
  });

  it('install.ps1 no longer round-trips settings through ConvertTo-Json', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
    assert.doesNotMatch(src, /needsRewrite\(JSON\.parse\(process\.argv/,
      "this is the block that silently did nothing on 采瑤's machine");
  });
});
