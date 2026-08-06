// v1.26.87 — the credential repair, run as the product runs it.
//
// The defect being closed is not "the key is missing". It is "the key is present, the MCP
// is happily uploading, and every scheduled run is blind" — because launchd / Task
// Scheduler / the hook runner get no shell environment and can only read files.
// resolve-credentials.cjs has reported that as `background_safe: false` since v1.26.82 and
// the only consequence was one line in a log nobody reads.
//
// So, like tests/ensure-session-hook.test.js: the real script, as a process, against real
// files. An imported function would not prove the installers can run it, and "the
// installers can run it" is precisely the link that was broken last time.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts/install-helpers/ensure-key-file.cjs');
const selfCheck = require(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'));

const KEY = 'om_live_0123456789abcdef0123';
const URL = 'https://ownmind.example.com';

/**
 * A sandbox home. `settings` is written to ~/.claude/settings.json when given; a string is
 * written verbatim so the malformed fixtures stay malformed.
 */
function sandbox(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-keyfile-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (typeof settings === 'string') fs.writeFileSync(settingsPath, settings);
  else if (settings !== undefined) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { home, settingsPath, ownmindDir: path.join(home, '.ownmind') };
}

/**
 * Runs the helper as a child process with an environment built from nothing — inheriting
 * the developer's own OWNMIND_API_KEY would quietly turn the "no credentials" fixture into
 * the "key in the environment" fixture and the test would still be green.
 */
function run({ home, ownmindDir }, env = {}) {
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, '--home', home, '--ownmind-dir', ownmindDir], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH || '', HOME: home, ...env },
    });
  } catch (e) {
    status = e.status;
    stdout = e.stdout || '';
  }
  return { status, out: stdout.trim() };
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const keyIn = (p) => read(p).mcpServers?.ownmind?.env?.OWNMIND_API_KEY;
const claudeDir = ({ home }) => fs.readdirSync(path.join(home, '.claude')).sort();

describe('ensure-key-file.cjs — executed as a process, against real files', () => {
  it('writes an environment-only key into settings.json', () => {
    const s = sandbox({ hooks: {} });
    const { status, out } = run(s, { OWNMIND_API_KEY: KEY });
    assert.equal(status, 0);
    assert.match(out, /^OK:keyfile:repaired /);
    assert.equal(keyIn(s.settingsPath), KEY,
      'the whole point: a scheduled task can read a file and cannot read a shell');
  });

  it('never prints the key it just wrote', () => {
    // This line is echoed by four installers and lands in the uploaded self-check report.
    const s = sandbox({ hooks: {} });
    const { out } = run(s, { OWNMIND_API_KEY: KEY, OWNMIND_API_URL: URL });
    assert.ok(!out.includes(KEY), 'the summary leaked the API key');
  });

  it('writes the URL too when it is environment-only', () => {
    const s = sandbox({ hooks: {} });
    run(s, { OWNMIND_API_KEY: KEY, OWNMIND_API_URL: URL });
    assert.equal(read(s.settingsPath).mcpServers.ownmind.env.OWNMIND_API_URL, URL);
  });

  it('leaves a URL that is already configured in a file alone', () => {
    // A stale shell variable must not overwrite the value somebody configured. Only the
    // key is missing from the file; only the key gets written.
    const s = sandbox({ mcpServers: { ownmind: { env: { OWNMIND_API_URL: 'https://configured.example' } } } });
    run(s, { OWNMIND_API_KEY: KEY, OWNMIND_API_URL: URL });
    const env = read(s.settingsPath).mcpServers.ownmind.env;
    assert.equal(env.OWNMIND_API_URL, 'https://configured.example');
    assert.equal(env.OWNMIND_API_KEY, KEY);
  });

  it('does not copy a URL that another file already configures', () => {
    // Adam's shape: URL in ~/.claude.json, key in the environment. Copying the URL into
    // settings.json as well makes a second copy that goes stale the day he edits the
    // first one, and settings.json wins the lookup. Only the missing thing gets written.
    const s = sandbox({ hooks: {} });
    fs.writeFileSync(path.join(s.home, '.claude.json'),
      JSON.stringify({ mcpServers: { ownmind: { env: { OWNMIND_API_URL: URL } } } }));
    assert.match(run(s, { OWNMIND_API_KEY: KEY }).out, /^OK:keyfile:repaired /);
    const env = read(s.settingsPath).mcpServers.ownmind.env;
    assert.equal(env.OWNMIND_API_KEY, KEY);
    assert.equal(env.OWNMIND_API_URL, undefined, 'a second copy of the URL was created');
  });

  it('reports already_safe and changes nothing when the key is in a file', () => {
    const s = sandbox({ mcpServers: { ownmind: { env: { OWNMIND_API_KEY: KEY } } } });
    const before = fs.readFileSync(s.settingsPath, 'utf8');
    const { status, out } = run(s, { OWNMIND_API_KEY: 'a-different-stale-shell-value' });
    assert.equal(status, 0);
    assert.match(out, /^OK:keyfile:already_safe /);
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), before,
      'a daily updater that rewrites an already-correct file churns it forever');
  });

  it('counts ~/.claude.json as a file, because the scanner reads it too', () => {
    const s = sandbox({ hooks: {} });
    fs.writeFileSync(path.join(s.home, '.claude.json'),
      JSON.stringify({ mcpServers: { ownmind: { env: { OWNMIND_API_KEY: KEY } } } }));
    const { out } = run(s, {});
    assert.match(out, /^OK:keyfile:already_safe /);
    assert.equal(keyIn(s.settingsPath), undefined, 'nothing needed writing');
  });

  it('is idempotent — the second run reports already_safe', () => {
    const s = sandbox({ hooks: {} });
    assert.match(run(s, { OWNMIND_API_KEY: KEY }).out, /^OK:keyfile:repaired /);
    const after = fs.readFileSync(s.settingsPath, 'utf8');
    assert.match(run(s, { OWNMIND_API_KEY: KEY }).out, /^OK:keyfile:already_safe /);
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), after);
  });

  it('keeps every other setting the user has', () => {
    const s = sandbox({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'mine.sh' }] }] },
      permissions: { allow: ['Bash'] },
      mcpServers: { other: { command: 'node', args: ['x.js'] } },
    });
    run(s, { OWNMIND_API_KEY: KEY });
    const after = read(s.settingsPath);
    assert.equal(after.hooks.SessionStart[0].hooks[0].command, 'mine.sh');
    assert.deepEqual(after.permissions, { allow: ['Bash'] });
    assert.deepEqual(after.mcpServers.other, { command: 'node', args: ['x.js'] });
  });

  it('leaves no temp file behind after a successful write', () => {
    // The write is temp-file-then-rename so an interrupted run cannot leave half a
    // settings.json. Debris in ~/.claude would be the visible symptom of that going wrong.
    const s = sandbox({ hooks: {} });
    run(s, { OWNMIND_API_KEY: KEY });
    assert.deepEqual(claudeDir(s), ['settings.json']);
  });

  it('writes through settings.json.tmp rather than straight over settings.json', () => {
    // "No debris afterwards" is also true of a direct write, so it cannot tell the two
    // apart. Occupying the temp path with a directory can: the rename route fails and
    // reports, a direct write would sail through and report success.
    const s = sandbox({ hooks: {} });
    const before = fs.readFileSync(s.settingsPath, 'utf8');
    fs.mkdirSync(`${s.settingsPath}.tmp`);
    const { status, out } = run(s, { OWNMIND_API_KEY: KEY });
    assert.equal(status, 1, 'the write did not go through the temp file');
    assert.match(out, /^ERROR:keyfile:error /);
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), before);
  });

  it('refuses a settings file it cannot parse, and leaves it byte-for-byte unchanged', () => {
    // Overwriting here would delete every other setting the user has, in order to fix a
    // problem whose only symptom is silence.
    const s = sandbox('{ broken');
    const { status, out } = run(s, { OWNMIND_API_KEY: KEY });
    assert.equal(status, 1);
    assert.match(out, /^ERROR:keyfile:error /);
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), '{ broken');
    assert.deepEqual(claudeDir(s), ['settings.json'], 'a refused run must not leave a temp file');
  });

  it('refuses a settings file that parses to something other than an object', () => {
    // A JSON array survives `typeof === 'object'`; JSON.stringify then drops any named
    // properties added to it, so the run would report success while writing nothing.
    const s = sandbox('[1, 2, 3]');
    const { status, out } = run(s, { OWNMIND_API_KEY: KEY });
    assert.equal(status, 1);
    assert.match(out, /^ERROR:keyfile:error /);
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), '[1, 2, 3]');
    assert.deepEqual(claudeDir(s), ['settings.json']);
  });

  it('survives a BOM, which Windows PowerShell writes', () => {
    const s = sandbox();
    fs.writeFileSync(s.settingsPath, '\ufeff' + JSON.stringify({ hooks: {} }));
    const { status, out } = run(s, { OWNMIND_API_KEY: KEY });
    assert.equal(status, 0);
    assert.match(out, /^OK:keyfile:repaired /);
    assert.equal(keyIn(s.settingsPath), KEY);
  });

  it('creates settings.json when there is none', () => {
    const s = sandbox();
    fs.rmSync(path.join(s.home, '.claude'), { recursive: true, force: true });
    assert.match(run(s, { OWNMIND_API_KEY: KEY }).out, /^OK:keyfile:repaired /);
    assert.equal(keyIn(s.settingsPath), KEY);
  });

  it('honors the ~/.ownmind/.no-key-file opt-out and touches nothing', () => {
    const s = sandbox({ hooks: {} });
    fs.mkdirSync(s.ownmindDir, { recursive: true });
    fs.writeFileSync(path.join(s.ownmindDir, '.no-key-file'), '');
    const before = fs.readFileSync(s.settingsPath, 'utf8');
    const { status, out } = run(s, { OWNMIND_API_KEY: KEY });
    assert.equal(status, 0);
    assert.match(out, /^OK:keyfile:opted_out /);
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), before,
      'opted out means not even a repair — that is an argument the user cannot win');
  });

  it('reports no_credentials rather than inventing a file when there is no key at all', () => {
    const s = sandbox({ hooks: {} });
    const before = fs.readFileSync(s.settingsPath, 'utf8');
    const { status, out } = run(s, {});
    assert.equal(status, 0);
    assert.match(out, /^OK:keyfile:no_credentials /);
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), before);
  });
});

describe('self-check maps each outcome to the status the alerting depends on', () => {
  // v1.26.87's alerting broadcasts new `fail` items to the super admin and deliberately
  // ignores `warn`. So the split is not cosmetics: a failed repair has to reach a person,
  // and a deliberate opt-out must never nag them.
  const check = (s, env) => selfCheck.checkBackgroundCredentials({
    home: s.home, settings: s.settingsPath, ownmindDir: s.ownmindDir, env,
  });

  it('pass when the key was already in a file, saying so', () => {
    const s = sandbox({ mcpServers: { ownmind: { env: { OWNMIND_API_KEY: KEY } } } });
    const r = check(s, {});
    assert.equal(r.name, 'background_credentials');
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /\.claude\/settings\.json/);
  });

  it('pass when this run repaired it, saying that instead', () => {
    const s = sandbox({ hooks: {} });
    const r = check(s, { OWNMIND_API_KEY: KEY });
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /wrote it to/,
      'a pass that does not say which of the two ways it passed is the report we already had');
    assert.equal(keyIn(s.settingsPath), KEY, 'the check must actually repair, not just report');
  });

  it('warn when the user opted out — their choice, and no alert', () => {
    const s = sandbox({ hooks: {} });
    fs.mkdirSync(s.ownmindDir, { recursive: true });
    fs.writeFileSync(path.join(s.ownmindDir, '.no-key-file'), '');
    const r = check(s, { OWNMIND_API_KEY: KEY });
    assert.equal(r.status, 'warn');
    assert.ok(r.fix, 'a warning with no way back out is a dead end');
  });

  it('warn when there are no credentials at all', () => {
    // api_key_format already fails on an empty key; a second alert about the same missing
    // key is noise aimed at a human being.
    const r = check(sandbox({ hooks: {} }), {});
    assert.equal(r.status, 'warn');
  });

  it('fail when the repair was attempted and could not be done, with the reason and a fix', () => {
    const s = sandbox('{ broken');
    const r = check(s, { OWNMIND_API_KEY: KEY });
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /unreadable/, 'the detail must say why, not just that');
    assert.match(r.fix, /OWNMIND_API_KEY/, 'the fix must be something a person can carry out');
  });

  it('fail on a settings file that is valid JSON but not an object', () => {
    const r = check(sandbox('[1, 2, 3]'), { OWNMIND_API_KEY: KEY });
    assert.equal(r.status, 'fail');
  });

  it('is in the check list, including the daily quick run', async () => {
    // The quick run is the one that happens on its own. Dropping this check from it would
    // mean the repair only ever runs when somebody is already re-installing by hand.
    for (const quick of [true, false]) {
      const names = await selfCheck.checkNamesFor({ quick });
      assert.ok(names.includes('background_credentials'), `quick=${quick} dropped the check`);
    }
  });

  it('and the list is what actually runs', async () => {
    // checkNamesFor is a declaration. A check that is declared and never executed reports
    // nothing and alerts nobody — the precise shape of the bug being fixed here. Executing
    // runAllChecks for real would hit the network and rewrite this machine's own
    // settings.json, so the two are compared where they are written instead.
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'), 'utf8');
    const executed = new Set([...src.matchAll(/safeCheck\('([a-z_]+)'/g)].map((m) => m[1]));
    for (const name of await selfCheck.checkNamesFor({ quick: false })) {
      assert.ok(executed.has(name), `${name} is declared in checkNamesFor but never run`);
    }
    assert.ok(executed.has('background_credentials'));
  });
});

describe('the installers run it', () => {
  // Not "mentions the filename" — the sibling's first version of this test passed on a
  // comment while the scripts did nothing. The assertion is a line that actually executes
  // node against the helper, and it was mutation-checked: deleting that line in any of the
  // four turns this red.
  const INVOKES = /(^|\n)[^\n#]*\bnode\b[^\n]*(EnsureKeyFile|ENSURE_KEY_FILE|ensure-key-file\.cjs)[^\n]*/;

  for (const rel of ['install.ps1', 'install.sh', 'scripts/update.ps1', 'scripts/update.sh']) {
    it(`${rel} runs ensure-key-file.cjs`, () => {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const line = src.match(INVOKES);
      assert.ok(line, `${rel} never executes ensure-key-file.cjs`);
      assert.doesNotMatch(line[0].trim(), /^(#|\/\/)/, 'the only match is a comment');
    });
  }

  // The helper prints "ERROR:keyfile:error <why>" and exits 1. A script that pastes that
  // into a "[ OK ]" line has hidden the failure behind a green checkmark. Asserting the
  // whole if/else shape also catches the swapped-branch mutation.
  const PS1_BRANCHES = /if \(\$LASTEXITCODE -eq 0\) \{\s*Write-Host "(?:\[ OK \] |   )Background credentials: \$keyResult"\s*\} else \{\s*Write-Host "(?:\[FAIL\]|   \[FAIL\]) Background credentials: \$keyResult"\s*\}/;
  const SH_BRANCHES = /if key_result=\$\(node "\$ENSURE_KEY_FILE"[^\n]*\); then\s*\n\s*echo "(?:\[ OK \] |   )Background credentials: \$key_result"\s*\n\s*else\s*\n\s*echo "(?:\[FAIL\]|   \[FAIL\]) Background credentials: \$key_result"\s*\n\s*fi/;
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
    // Same trap the SessionStart repair fell into: a later write of a stale in-memory
    // snapshot silently reverts the repair, and the screen still says OK.
    const src = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
    const lastSettingsWrite = src.lastIndexOf('Write-Utf8NoBom -Path $ClaudeSettings');
    const helperCall = src.indexOf('& node $EnsureKeyFile');
    assert.ok(lastSettingsWrite !== -1 && helperCall !== -1, 'expected markers are missing');
    assert.ok(helperCall > lastSettingsWrite,
      'install.ps1 writes settings.json after the helper ran — that write reverts the repair');
  });
});
