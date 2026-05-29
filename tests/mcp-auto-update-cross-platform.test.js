/**
 * Reproduction tests: MCP auto-update silently fails on Windows
 *
 * Background (discovered 2026-05-07 while reviewing work logs):
 *   Alice (LAPTOP-G95HIQ3V) stuck on v1.17.17; Bob stuck on v1.17.16.
 *   Neither had any update_check / update_failed event after 4/21.
 *   Root cause: mcp/index.js used process.env.HOME, which is undefined on Windows,
 *   so OWNMIND_DIR became the relative path '.ownmind' → fs.existsSync('.ownmind/.git')
 *   was always false → the entire auto-update silently skipped with zero logs.
 *
 * Two-layer fix:
 *   1. Use os.homedir() (cross-platform — Windows reads USERPROFILE automatically).
 *   2. Replace exec(bashScript) with Node-native execFile calls to git/npm;
 *      Unix runs update.sh, Windows runs update.ps1.
 *   3. When conditions are not met, logEvent('update_skipped', { reason }); never silent-skip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpSource = readFileSync(join(__dirname, '..', 'mcp', 'index.js'), 'utf8');
const repoRoot = join(__dirname, '..');

test('mcp/index.js: OWNMIND_DIR must use os.homedir(), not process.env.HOME', () => {
  // Before: path.join(process.env.HOME || '', '.ownmind')
  // After:  path.join(os.homedir(), '.ownmind')
  assert.match(
    mcpSource,
    /OWNMIND_DIR\s*=\s*path\.join\(\s*os\.homedir\(\)\s*,\s*['"]\.ownmind['"]\s*\)/,
    'OWNMIND_DIR must go through os.homedir(); otherwise Windows lacks USERPROFILE → path becomes relative → silent skip'
  );
  assert.doesNotMatch(
    mcpSource,
    /OWNMIND_DIR[^\n]*process\.env\.HOME/,
    'OWNMIND_DIR must no longer use process.env.HOME (undefined on Windows)'
  );
});

test('mcp/index.js: import os module', () => {
  assert.match(
    mcpSource,
    /import\s+os\s+from\s+['"]os['"]|from\s+['"]os['"]\s+import/,
    'mcp/index.js must import os to use os.homedir()'
  );
});

test('mcp/index.js: when conditions fail, must logEvent(update_skipped); never silent-skip', () => {
  // Before: condition not met → fall through out of the try block; no logs.
  // After: every skip path writes logEvent('update_skipped', { reason: '...' }).
  assert.match(
    mcpSource,
    /logEvent\(['"]update_skipped['"]/,
    'must add update_skipped event; otherwise users stuck on old versions are invisible to us'
  );
});

test('mcp/index.js: skip reasons must cover three scenarios', () => {
  // Three skip scenarios:
  //   - marker_today: already checked today
  //   - no_git_dir: ~/.ownmind/.git is missing (tarball install or Windows path error)
  //   - lock_held: another process is updating
  for (const reason of ['marker_today', 'no_git_dir', 'lock_held']) {
    assert.ok(
      mcpSource.includes(`'${reason}'`) || mcpSource.includes(`"${reason}"`),
      `update_skipped reason must include '${reason}'`
    );
  }
});

test('mcp/index.js: no more exec(bashScript) — switch to cross-platform execFile', () => {
  // Before: exec(`touch ... cd ... bash ...`) (bash syntax fails wholesale on Windows cmd).
  // After: execFile('git', [...], { cwd: OWNMIND_DIR }) and similar.
  // At minimum, the bash-heredoc-style inline shell script inside exec must be gone.
  assert.doesNotMatch(
    mcpSource,
    /exec\(`[\s\S]*?touch[\s\S]*?cd ~\/\.ownmind/,
    'exec(`touch ... cd ~/.ownmind ...`) pattern must be removed (Windows cmd does not understand it)'
  );
});

test('mcp/index.js: on Windows, use npm.cmd (so execFile can find it)', () => {
  // Node's execFile on Windows cannot find 'npm' directly (it is npm.cmd).
  assert.match(
    mcpSource,
    /process\.platform\s*===?\s*['"]win32['"][\s\S]{0,200}npm\.cmd|npm\.cmd[\s\S]{0,200}process\.platform/,
    'must detect Windows and use npm.cmd; otherwise npm install ENOENTs on Windows'
  );
});

test('scripts/update.ps1 must exist (the Windows counterpart)', () => {
  const ps1Path = join(repoRoot, 'scripts', 'update.ps1');
  assert.ok(
    existsSync(ps1Path),
    'scripts/update.ps1 must exist; Windows MCP auto-update calls it at the end for skill/hook sync'
  );
});

test('scripts/update.ps1 must sync the Claude Code skills directory', () => {
  const ps1Path = join(repoRoot, 'scripts', 'update.ps1');
  if (!existsSync(ps1Path)) return; // previous test will catch it
  const content = readFileSync(ps1Path, 'utf8');
  // PS1 builds paths via Join-Path: ".claude" + "skills\ownmind-memory\SKILL.md".
  // It must also reference both ownmind-memory and ownmind-upgrade skills.
  assert.match(content, /\.claude/, 'update.ps1 must reference the .claude directory');
  assert.match(content, /skills/i, 'update.ps1 must handle skill sync');
  assert.match(content, /ownmind-memory/, 'update.ps1 must copy the ownmind-memory skill');
  assert.match(content, /ownmind-upgrade/, 'update.ps1 must copy the ownmind-upgrade skill');
  assert.match(content, /SessionStart|PreToolUse/,
    'update.ps1 must inject settings.json hooks (counterpart to update.sh step 3)');
});

// v1.17.23 follow-up fixes (4 issues caught by Codex review)

test('v1.17.23 update.ps1: Node script uses argv[2]/argv[3], not argv[1]/argv[2]', () => {
  // v1.17.22 bug: when running `node $tmpScript $arg1 $arg2`, argv[1] is the .js path,
  // not $arg1, so JSON.parse runs on itself → settings injection fails wholesale.
  const ps1Path = join(repoRoot, 'scripts', 'update.ps1');
  if (!existsSync(ps1Path)) return;
  const content = readFileSync(ps1Path, 'utf8');
  // Should use argv[2] (settings path) and argv[3] (noSessionHook flag).
  assert.match(
    content,
    /process\.argv\[2\]/,
    'Node script reading settings path must use process.argv[2] (argv[1] is the .js path itself)'
  );
  assert.doesNotMatch(
    content,
    /settingsPath\s*=\s*process\.argv\[1\]/,
    'argv[1] is the .js path; cannot be used as the settings path'
  );
});

test('v1.17.23 mcp/index.js: lock acquire must be atomic (openSync wx)', () => {
  // v1.17.22 used existsSync + writeFileSync — TOCTOU race; two MCPs could both pass existsSync.
  // Fix: fs.openSync(LOCK_FILE, 'wx') — exclusive create; existing file yields EEXIST.
  assert.match(
    mcpSource,
    /fs\.openSync\(LOCK_FILE,\s*['"]wx['"]\)/,
    'lock acquire must use openSync wx flag for atomicity (prevent concurrent races)'
  );
});

test('v1.17.23 update.ps1: must inject Gemini / Copilot / Cursor hooks', () => {
  // v1.17.22 update.ps1 missed update.sh's sections 4 / 5 / 6 (Gemini / GitHub Copilot / Cursor).
  const ps1Path = join(repoRoot, 'scripts', 'update.ps1');
  if (!existsSync(ps1Path)) return;
  const content = readFileSync(ps1Path, 'utf8');
  for (const tool of ['.gemini', '.github', '.cursor']) {
    assert.ok(
      content.includes(tool),
      `update.ps1 must inject the ${tool} hook (counterpart to update.sh sections 4/5/6)`
    );
  }
});

test('v1.17.23 mcp/index.js: use git pull --autostash (avoid stash-without-pop swallowing user changes)', () => {
  // v1.17.22 ran git stash -q then pull but never stash pop → uncommitted user changes vanished.
  // Fix: git pull --rebase --autostash handles both in one shot (git 2.6+).
  assert.match(
    mcpSource,
    /['"]--autostash['"]/,
    'git pull must include --autostash; otherwise stash without pop swallows user changes'
  );
});

test('v1.17.65 mcp/index.js: autostash fallback must not include --autostash (otherwise both paths fail the same way)', () => {
  // v1.17.23 wrote a fallback for git < 2.6 that lacks --autostash, but the fallback
  // also passed --autostash → whatever caused the main path to fail, the fallback
  // would re-fail for the same reason.
  // Fix: fallback becomes git pull -q --ff-only (no --autostash, no --rebase).
  // When the user has uncommitted changes, ff-only pull explicitly refuses and logEvents
  // step=pull, so the user handles it themselves; we no longer perform a manual stash
  // (v1.17.22 already proved manual stash without pop swallows user changes).
  const idx = mcpSource.indexOf("'pull', '-q', '--rebase', '--autostash'");
  assert.ok(idx >= 0, 'main path must still be git pull -q --rebase --autostash');
  // Within 1500 chars after the main-path catch block, find the fallback execFile.
  const slice = mcpSource.slice(idx, idx + 1500);
  const fallbackMatch = slice.match(/} catch[\s\S]+?execFile\([^)]*'git'[^)]*\[([^\]]+)\]/);
  assert.ok(fallbackMatch, 'fallback execFile git block must follow the main path');
  assert.ok(
    !fallbackMatch[1].includes('--autostash'),
    `autostash fallback must not pass --autostash (the dead path v1.17.23 left behind); actual args: ${fallbackMatch[1]}`
  );
});

test('v1.17.23 mcp/index.js: outer catch must log update_failed step=outer', () => {
  // v1.17.22 had runAutoUpdate().catch(() => {}) — silent failure.
  // Fix: catch (e) => logEvent('update_failed', { step: 'outer', error: ... }).
  assert.match(
    mcpSource,
    /runAutoUpdate\(\)\.catch\([\s\S]{0,200}step:\s*['"]outer['"]/,
    'outer catch must logEvent update_failed step=outer; never silently swallow exceptions'
  );
});
