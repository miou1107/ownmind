// v1.30.45 — the monitor mod reaches every machine through settings.json's "env" block.
// v1.31.4 — the same helper places every mod in its MODS list (ownmind-monitor, wrapup-check).
//
// Executes the real helper as a process against real files under a temp HOME, the way
// install.sh / update.sh / install.ps1 / update.ps1 run it. Nothing here reads or writes the
// real ~/.claude/settings.json, and nothing talks to a server.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts/install-helpers/ensure-monitor-mod.cjs');
const { ensureMonitorMod, ensureMods, MODS } = createRequire(import.meta.url)(SCRIPT);

const NAMES = MODS.map((m) => m.name);
const MONITOR = 'ownmind-monitor';
const WRAPUP = 'wrapup-check';

function sandbox(settings, { withMods = NAMES } = {}) {
  const home = tempDir('ownmind-mods-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (settings !== undefined) {
    fs.writeFileSync(settingsPath, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  const ownmindDir = path.join(home, '.ownmind');
  fs.mkdirSync(ownmindDir, { recursive: true });
  for (const name of withMods) {
    fs.mkdirSync(path.join(ownmindDir, 'mods', name, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(ownmindDir, 'mods', name, '.claude-plugin', 'plugin.json'), '{}');
  }
  const dir = (name) => path.join(ownmindDir, 'mods', name);
  return { home, settingsPath, ownmindDir, modDir: dir(MONITOR), wrapDir: dir(WRAPUP), dir };
}

function run(s, extra = []) {
  return execFileSync(process.execPath, [
    SCRIPT, '--settings', s.settingsPath, '--ownmind-dir', s.ownmindDir, '--home', s.home, ...extra,
  ], { encoding: 'utf8' }).trim();
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sep = process.platform === 'win32' ? ';' : ':';
const line = (monitor, wrapup) => `OK:mods:${MONITOR}=${monitor},${WRAPUP}=${wrapup}`;
const both = (s) => [s.modDir, s.wrapDir].join(sep);

describe('ensure-monitor-mod.cjs — executed as a process, against real files', () => {
  it('lists the two mods it manages', () => {
    assert.deepEqual(NAMES, [MONITOR, WRAPUP]);
  });

  it('creates settings.json when there is none, with both mods in MODS order', () => {
    const s = sandbox(undefined);
    assert.equal(run(s), line('installed', 'installed'));
    assert.deepEqual(read(s.settingsPath), {
      env: { CLAUDE_CODE_PLUGIN_DIRS: both(s), CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    });
  });

  it('adds to an existing env block and keeps every other setting as it was', () => {
    const before = {
      model: 'opus',
      env: { FOO: 'bar', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'x' }] }] },
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'k' } } },
    };
    const s = sandbox(before);
    assert.equal(run(s), line('installed', 'installed'));
    const after = read(s.settingsPath);
    assert.deepEqual(Object.keys(after), ['model', 'env', 'hooks', 'mcpServers'], 'key order kept');
    assert.equal(after.model, 'opus');
    assert.deepEqual(after.hooks, before.hooks);
    assert.deepEqual(after.mcpServers, before.mcpServers);
    assert.deepEqual(after.env, {
      FOO: 'bar',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      CLAUDE_CODE_PLUGIN_DIRS: both(s),
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    });
  });

  it('keeps another plugin folder the user listed, in front of ours', () => {
    const s = sandbox({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/opt/my-plugin' } });
    assert.equal(run(s), line('installed', 'installed'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, `/opt/my-plugin${sep}${both(s)}`);
  });

  it('a machine that already has the monitor mod gets only the wrap-up mod added', () => {
    const s = sandbox({});
    fs.writeFileSync(s.settingsPath, JSON.stringify({ env: {
      CLAUDE_CODE_PLUGIN_DIRS: `/opt/a${sep}${s.modDir}`, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    } }));
    assert.equal(run(s), line('unchanged', 'installed'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, `/opt/a${sep}${s.modDir}${sep}${s.wrapDir}`);
  });

  it('is idempotent — two runs in a row leave the file byte-for-byte the same', () => {
    const s = sandbox({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/opt/a' } });
    assert.equal(run(s), line('installed', 'installed'));
    const first = fs.readFileSync(s.settingsPath, 'utf8');
    const mtime = fs.statSync(s.settingsPath).mtimeMs;
    assert.equal(run(s), line('unchanged', 'unchanged'));
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), first);
    assert.equal(fs.statSync(s.settingsPath).mtimeMs, mtime, 'an unchanged run must not rewrite the file');
    const dirs = read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS.split(sep);
    assert.equal(dirs.filter((d) => d === s.modDir).length, 1);
    assert.equal(dirs.filter((d) => d === s.wrapDir).length, 1);
  });

  it('replaces the hand-installed copies (tilde form) instead of loading a mod twice', () => {
    const s = sandbox({ env: {
      CLAUDE_CODE_PLUGIN_DIRS: `/opt/a${sep}~/.claude/mods/ownmind-monitor${sep}~/.claude/mods/wrapup-check${sep}/opt/b`,
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    } });
    assert.equal(run(s), line('installed', 'installed'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS,
      ['/opt/a', s.modDir, s.wrapDir, '/opt/b'].join(sep), 'same positions, new paths');
  });

  it('replaces the hand-installed copy in expanded form, trailing slash included', () => {
    const legacy = (home) => `${home}/.claude/mods/wrapup-check/`;
    const s = sandbox({});
    fs.writeFileSync(s.settingsPath, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: legacy(s.home) } }));
    assert.equal(run(s), line('installed', 'installed'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, [s.wrapDir, s.modDir].join(sep),
      'the hand-installed entry keeps its position; the other mod is appended');
  });

  it('collapses our own path spelled twice (tilde + expanded) into one', () => {
    const s = sandbox({});
    fs.writeFileSync(s.settingsPath, JSON.stringify({ env: {
      CLAUDE_CODE_PLUGIN_DIRS: `~/.ownmind/mods/ownmind-monitor${sep}${s.modDir}${sep}${s.wrapDir}`,
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    } }));
    assert.equal(run(s), line('updated', 'unchanged'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, both(s));
  });

  it('turns function hooks on even when the user had them off, and says the mods were updated', () => {
    const s = sandbox({ env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0' } });
    run(s);
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, '1');
    const t = sandbox({});
    run(t);
    const off = read(t.settingsPath);
    off.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '0';
    fs.writeFileSync(t.settingsPath, JSON.stringify(off, null, 2));
    assert.equal(run(t), line('updated', 'updated'), 'the file changed, so nothing is "unchanged"');
  });

  it('normalising our own entry (a trailing slash) counts as updated, not unchanged', () => {
    const s = sandbox({});
    fs.writeFileSync(s.settingsPath, JSON.stringify({ env: {
      CLAUDE_CODE_PLUGIN_DIRS: `${s.modDir}/${sep}${s.wrapDir}`, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    } }));
    assert.equal(run(s), line('updated', 'unchanged'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, both(s));
  });

  it('accepts a settings.json that starts with a BOM (PowerShell 5.1 writes one)', () => {
    const s = sandbox(`\uFEFF${JSON.stringify({ env: { A: '1' } })}`);
    assert.equal(run(s), line('installed', 'installed'));
    assert.equal(read(s.settingsPath).env.A, '1');
  });

  it('refuses to touch a settings.json it cannot parse', () => {
    const s = sandbox('{ not json');
    assert.throws(() => run(s), (e) => /ERROR:mods:settings unreadable/.test(e.stdout));
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), '{ not json');
  });

  it('writes nothing when the checkout has no mod folders at all', () => {
    const s = sandbox({ env: { A: '1' } }, { withMods: [] });
    assert.equal(run(s), line('missing', 'missing'));
    assert.deepEqual(read(s.settingsPath), { env: { A: '1' } });
  });

  it('an older checkout without the wrap-up folder gets only the monitor mod', () => {
    const s = sandbox(undefined, { withMods: [MONITOR] });
    assert.equal(run(s), line('installed', 'missing'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, s.modDir);
  });

  it('removes one entry when that mod folder is gone (rollback), keeping the other and the rest', () => {
    const s = sandbox({}, { withMods: [MONITOR] });
    fs.writeFileSync(s.settingsPath, JSON.stringify({ env: {
      CLAUDE_CODE_PLUGIN_DIRS: `/opt/a${sep}${s.modDir}${sep}${s.wrapDir}`, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    } }));
    assert.equal(run(s), line('unchanged', 'missing'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, `/opt/a${sep}${s.modDir}`);
  });

  for (const [label, env] of [['a string', 'oops'], ['an array', ['a']], ['null', null]]) {
    it(`refuses an "env" that is ${label}, and leaves the file alone`, () => {
      const s = sandbox({ env });
      const before = fs.readFileSync(s.settingsPath, 'utf8');
      assert.throws(() => run(s), (e) => /ERROR:mods:settings "env" is not an object/.test(e.stdout));
      assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), before);
    });
  }

  it('refuses a CLAUDE_CODE_PLUGIN_DIRS that is not a string', () => {
    const s = sandbox({ env: { CLAUDE_CODE_PLUGIN_DIRS: ['/opt/a'] } });
    assert.throws(() => run(s), (e) => /ERROR:mods:CLAUDE_CODE_PLUGIN_DIRS is not a string/.test(e.stdout));
  });

  it('the wrap-up opt-out file removes only the wrap-up entry', () => {
    const s = sandbox({});
    run(s);
    const withOther = read(s.settingsPath);
    withOther.env.CLAUDE_CODE_PLUGIN_DIRS = `/opt/a${sep}${both(s)}`;
    fs.writeFileSync(s.settingsPath, JSON.stringify(withOther, null, 2));
    fs.writeFileSync(path.join(s.ownmindDir, '.no-wrapup-mod'), '');
    assert.equal(run(s), line('unchanged', 'opted_out'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, `/opt/a${sep}${s.modDir}`);
    assert.equal(run(s), line('unchanged', 'opted_out'), 'and stays out on the next update');
  });

  it('the monitor opt-out file removes only the monitor entry (v1.30.45 marker still honored)', () => {
    const s = sandbox({});
    run(s);
    fs.writeFileSync(path.join(s.ownmindDir, '.no-monitor-mod'), '');
    assert.equal(run(s), line('opted_out', 'unchanged'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, s.wrapDir);
  });

  it('both opted out: the user\'s folders stay, or the key goes when none are left', () => {
    const s = sandbox({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/opt/a' } });
    run(s);
    fs.writeFileSync(path.join(s.ownmindDir, '.no-monitor-mod'), '');
    fs.writeFileSync(path.join(s.ownmindDir, '.no-wrapup-mod'), '');
    assert.equal(run(s), line('opted_out', 'opted_out'));
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, '/opt/a');
    const t = sandbox({});
    run(t);
    fs.writeFileSync(path.join(t.ownmindDir, '.no-monitor-mod'), '');
    fs.writeFileSync(path.join(t.ownmindDir, '.no-wrapup-mod'), '');
    run(t);
    assert.equal(read(t.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, undefined);
  });
});

describe('ensure-monitor-mod.cjs — Windows, run from this machine with --platform win32', () => {
  const win = (settings, ownmindDir = 'C:\\Users\\amy\\.ownmind') => {
    const s = sandbox(settings);
    const out = execFileSync(process.execPath, [
      SCRIPT, '--settings', s.settingsPath, '--ownmind-dir', ownmindDir,
      '--home', 'C:\\Users\\amy', '--platform', 'win32',
    ], { encoding: 'utf8' }).trim();
    return { out, env: read(s.settingsPath).env, s };
  };
  const MOD = 'C:\\Users\\amy\\.ownmind\\mods\\ownmind-monitor';
  const WRAP = 'C:\\Users\\amy\\.ownmind\\mods\\wrapup-check';

  it('uses Windows paths and joins folders with ;', () => {
    const { out, env } = win({ env: { CLAUDE_CODE_PLUGIN_DIRS: 'D:\\plugins\\mine' } });
    assert.equal(out, line('installed', 'installed'));
    assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, `D:\\plugins\\mine;${MOD};${WRAP}`,
      'the drive-letter colon must not be read as a separator');
    assert.equal(env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, '1');
  });

  it('turns a Git Bash home (/c/Users/amy) into a native path', () => {
    const { env } = win({}, '/c/Users/amy/.ownmind');
    assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, `${MOD};${WRAP}`);
  });

  it('migrates the hand-installed copies, any slash direction or letter case', () => {
    const { env } = win({ env: {
      CLAUDE_CODE_PLUGIN_DIRS: 'd:\\x;~/.claude/mods/ownmind-monitor;c:/users/AMY/.claude/mods/wrapup-check\\',
    } });
    assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, `d:\\x;${MOD};${WRAP}`);
  });

  it('opt-out on Windows removes that mod\'s entries (checkout and hand-installed) and keeps the rest', () => {
    // The marker file lives on this machine's disk, so the transform is called directly.
    const settings = { env: {
      CLAUDE_CODE_PLUGIN_DIRS: `D:\\x;${MOD};~/.claude/mods/ownmind-monitor;${WRAP}`,
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    } };
    const r = ensureMods(settings, {
      ownmindDir: 'C:\\Users\\amy\\.ownmind', home: 'C:\\Users\\amy', platform: 'win32', optOut: [MONITOR],
    });
    assert.equal(r.statuses[MONITOR], 'opted_out');
    assert.equal(r.settings.env.CLAUDE_CODE_PLUGIN_DIRS, `D:\\x;${WRAP}`);
  });

  it('the single-mod transform is still exported and leaves the other mod alone', () => {
    const settings = { env: { CLAUDE_CODE_PLUGIN_DIRS: `D:\\x;${MOD};${WRAP}`, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } };
    const r = ensureMonitorMod(settings, {
      ownmindDir: 'C:\\Users\\amy\\.ownmind', home: 'C:\\Users\\amy', platform: 'win32', optOut: true,
    });
    assert.equal(r.status, 'opted_out');
    assert.equal(r.settings.env.CLAUDE_CODE_PLUGIN_DIRS, `D:\\x;${WRAP}`);
    const again = ensureMonitorMod({ env: { CLAUDE_CODE_PLUGIN_DIRS: `~/.claude/mods/wrapup-check` } }, {
      ownmindDir: 'C:\\Users\\amy\\.ownmind', home: 'C:\\Users\\amy', platform: 'win32', optOut: false,
    });
    assert.equal(again.status, 'installed');
    assert.equal(again.settings.env.CLAUDE_CODE_PLUGIN_DIRS, `~/.claude/mods/wrapup-check;${MOD}`,
      'the hand-installed wrap-up entry is not this transform\'s to touch');
  });

  it('is idempotent on Windows too', () => {
    const first = win({});
    const again = execFileSync(process.execPath, [
      SCRIPT, '--settings', first.s.settingsPath, '--ownmind-dir', 'C:\\Users\\amy\\.ownmind',
      '--home', 'C:\\Users\\amy', '--platform', 'win32',
    ], { encoding: 'utf8' }).trim();
    assert.equal(again, line('unchanged', 'unchanged'));
  });
});

describe('every installer and updater runs the helper', () => {
  // Not just the file name: the call itself, live (not commented out), in the form that
  // cannot abort the script — inside `if x=$(…)` under bash's set -e, and checked through
  // $LASTEXITCODE in PowerShell.
  const live = (text, re) => text.split(/\r?\n/).some((l) => !/^\s*#/.test(l) && re.test(l));
  for (const file of ['install.sh', 'scripts/update.sh']) {
    it(file, () => {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      assert.ok(live(text, /ENSURE_MOD=.*ensure-monitor-mod\.cjs/), `${file} does not name the helper`);
      assert.ok(live(text, /^\s*if mod_result=\$\(node "\$ENSURE_MOD" /),
        `${file} does not run the helper inside an if — machines that only run it never get the mods`);
    });
  }
  for (const file of ['install.ps1', 'scripts/update.ps1']) {
    it(file, () => {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      assert.ok(live(text, /\$EnsureMod = .*ensure-monitor-mod\.cjs/), `${file} does not name the helper`);
      assert.ok(live(text, /^\s*\$modResult = & node \$EnsureMod /),
        `${file} does not run the helper — Windows machines that only run it never get the mods`);
    });
  }
});
