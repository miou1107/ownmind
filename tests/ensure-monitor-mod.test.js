// v1.30.45 — the monitor mod reaches every machine through settings.json's "env" block.
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
const { ensureMonitorMod } = createRequire(import.meta.url)(SCRIPT);

function sandbox(settings, { withMod = true } = {}) {
  const home = tempDir('ownmind-monitor-mod-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (settings !== undefined) {
    fs.writeFileSync(settingsPath, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  const ownmindDir = path.join(home, '.ownmind');
  if (withMod) {
    fs.mkdirSync(path.join(ownmindDir, 'mods', 'ownmind-monitor', '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(ownmindDir, 'mods', 'ownmind-monitor', '.claude-plugin', 'plugin.json'), '{}');
  } else {
    fs.mkdirSync(ownmindDir, { recursive: true });
  }
  return { home, settingsPath, ownmindDir, modDir: path.join(ownmindDir, 'mods', 'ownmind-monitor') };
}

function run(s, extra = []) {
  return execFileSync(process.execPath, [
    SCRIPT, '--settings', s.settingsPath, '--ownmind-dir', s.ownmindDir, '--home', s.home, ...extra,
  ], { encoding: 'utf8' }).trim();
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sep = process.platform === 'win32' ? ';' : ':';

describe('ensure-monitor-mod.cjs — executed as a process, against real files', () => {
  it('creates settings.json when there is none', () => {
    const s = sandbox(undefined);
    assert.equal(run(s), 'OK:monitor_mod:installed');
    assert.deepEqual(read(s.settingsPath), {
      env: { CLAUDE_CODE_PLUGIN_DIRS: s.modDir, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
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
    assert.equal(run(s), 'OK:monitor_mod:installed');
    const after = read(s.settingsPath);
    assert.deepEqual(Object.keys(after), ['model', 'env', 'hooks', 'mcpServers'], 'key order kept');
    assert.equal(after.model, 'opus');
    assert.deepEqual(after.hooks, before.hooks);
    assert.deepEqual(after.mcpServers, before.mcpServers);
    assert.deepEqual(after.env, {
      FOO: 'bar',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      CLAUDE_CODE_PLUGIN_DIRS: s.modDir,
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    });
  });

  it('keeps another plugin folder the user listed, in front of ours', () => {
    const s = sandbox({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/opt/my-plugin' } });
    assert.equal(run(s), 'OK:monitor_mod:installed');
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, `/opt/my-plugin${sep}${s.modDir}`);
  });

  it('is idempotent — two runs in a row leave the file byte-for-byte the same', () => {
    const s = sandbox({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/opt/a' } });
    assert.equal(run(s), 'OK:monitor_mod:installed');
    const first = fs.readFileSync(s.settingsPath, 'utf8');
    const mtime = fs.statSync(s.settingsPath).mtimeMs;
    assert.equal(run(s), 'OK:monitor_mod:unchanged');
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), first);
    assert.equal(fs.statSync(s.settingsPath).mtimeMs, mtime, 'an unchanged run must not rewrite the file');
    const dirs = read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS.split(sep);
    assert.equal(dirs.filter((d) => d === s.modDir).length, 1);
  });

  it('replaces the hand-installed copy (tilde form) instead of loading the mod twice', () => {
    const s = sandbox({ env: {
      CLAUDE_CODE_PLUGIN_DIRS: `/opt/a${sep}~/.claude/mods/ownmind-monitor${sep}/opt/b`,
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    } });
    assert.equal(run(s), 'OK:monitor_mod:installed');
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS,
      [`/opt/a`, s.modDir, '/opt/b'].join(sep), 'same position, new path');
  });

  it('replaces the hand-installed copy in expanded form, trailing slash included', () => {
    const legacy = (home) => `${home}/.claude/mods/ownmind-monitor/`;
    const s = sandbox({});
    fs.writeFileSync(s.settingsPath, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: legacy(s.home) } }));
    assert.equal(run(s), 'OK:monitor_mod:installed');
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, s.modDir);
  });

  it('collapses our own path spelled twice (tilde + expanded) into one', () => {
    const s = sandbox({ env: { CLAUDE_CODE_PLUGIN_DIRS: '~/.ownmind/mods/ownmind-monitor' } });
    fs.writeFileSync(s.settingsPath, JSON.stringify({ env: {
      CLAUDE_CODE_PLUGIN_DIRS: `~/.ownmind/mods/ownmind-monitor${sep}${s.modDir}`,
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    } }));
    assert.equal(run(s), 'OK:monitor_mod:updated');
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, s.modDir);
  });

  it('turns function hooks on even when the user had them off', () => {
    const s = sandbox({ env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0' } });
    run(s);
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, '1');
  });

  it('accepts a settings.json that starts with a BOM (PowerShell 5.1 writes one)', () => {
    const s = sandbox(`\uFEFF${JSON.stringify({ env: { A: '1' } })}`);
    assert.equal(run(s), 'OK:monitor_mod:installed');
    assert.equal(read(s.settingsPath).env.A, '1');
  });

  it('refuses to touch a settings.json it cannot parse', () => {
    const s = sandbox('{ not json');
    assert.throws(() => run(s), (e) => /ERROR:monitor_mod:settings unreadable/.test(e.stdout));
    assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), '{ not json');
  });

  it('writes nothing when the checkout has no mod folder', () => {
    const s = sandbox({ env: { A: '1' } }, { withMod: false });
    assert.equal(run(s), 'OK:monitor_mod:missing');
    assert.deepEqual(read(s.settingsPath), { env: { A: '1' } });
  });

  it('removes our entry when the mod folder is gone (rollback), keeping the others', () => {
    const s = sandbox({}, { withMod: false });
    const mod = path.join(s.ownmindDir, 'mods', 'ownmind-monitor');
    fs.writeFileSync(s.settingsPath, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: `/opt/a${sep}${mod}` } }));
    assert.equal(run(s), 'OK:monitor_mod:missing');
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, '/opt/a');
  });

  for (const [label, env] of [['a string', 'oops'], ['an array', ['a']], ['null', null]]) {
    it(`refuses an "env" that is ${label}, and leaves the file alone`, () => {
      const s = sandbox({ env });
      const before = fs.readFileSync(s.settingsPath, 'utf8');
      assert.throws(() => run(s), (e) => /ERROR:monitor_mod:settings "env" is not an object/.test(e.stdout));
      assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), before);
    });
  }

  it('refuses a CLAUDE_CODE_PLUGIN_DIRS that is not a string', () => {
    const s = sandbox({ env: { CLAUDE_CODE_PLUGIN_DIRS: ['/opt/a'] } });
    assert.throws(() => run(s), (e) => /ERROR:monitor_mod:CLAUDE_CODE_PLUGIN_DIRS is not a string/.test(e.stdout));
  });

  it('opt-out file removes only our entry', () => {
    const s = sandbox({});
    run(s);
    const withOther = read(s.settingsPath);
    withOther.env.CLAUDE_CODE_PLUGIN_DIRS = `/opt/a${sep}${s.modDir}`;
    fs.writeFileSync(s.settingsPath, JSON.stringify(withOther, null, 2));
    fs.writeFileSync(path.join(s.ownmindDir, '.no-monitor-mod'), '');
    assert.equal(run(s), 'OK:monitor_mod:opted_out');
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, '/opt/a');
    assert.equal(run(s), 'OK:monitor_mod:opted_out', 'and stays out on the next update');
    assert.equal(read(s.settingsPath).env.CLAUDE_CODE_PLUGIN_DIRS, '/opt/a');
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

  it('uses a Windows path and joins folders with ;', () => {
    const { out, env } = win({ env: { CLAUDE_CODE_PLUGIN_DIRS: 'D:\\plugins\\mine' } });
    assert.equal(out, 'OK:monitor_mod:installed');
    assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, `D:\\plugins\\mine;${MOD}`,
      'the drive-letter colon must not be read as a separator');
    assert.equal(env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, '1');
  });

  it('turns a Git Bash home (/c/Users/amy) into a native path', () => {
    const { env } = win({}, '/c/Users/amy/.ownmind');
    assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, MOD);
  });

  it('migrates the hand-installed copy, any slash direction or letter case', () => {
    const { env } = win({ env: {
      CLAUDE_CODE_PLUGIN_DIRS: 'd:\\x;~/.claude/mods/ownmind-monitor;c:/users/AMY/.claude/mods/ownmind-monitor\\',
    } });
    assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, `d:\\x;${MOD}`);
  });

  it('opt-out on Windows removes our entries (checkout and hand-installed) and keeps the rest', () => {
    // The marker file lives on this machine's disk, so the transform is called directly.
    const settings = { env: {
      CLAUDE_CODE_PLUGIN_DIRS: `D:\\x;${MOD};~/.claude/mods/ownmind-monitor`,
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    } };
    const r = ensureMonitorMod(settings, {
      ownmindDir: 'C:\\Users\\amy\\.ownmind', home: 'C:\\Users\\amy', platform: 'win32', optOut: true,
    });
    assert.equal(r.status, 'opted_out');
    assert.equal(r.settings.env.CLAUDE_CODE_PLUGIN_DIRS, 'D:\\x');
  });

  it('is idempotent on Windows too', () => {
    const first = win({});
    const again = execFileSync(process.execPath, [
      SCRIPT, '--settings', first.s.settingsPath, '--ownmind-dir', 'C:\\Users\\amy\\.ownmind',
      '--home', 'C:\\Users\\amy', '--platform', 'win32',
    ], { encoding: 'utf8' }).trim();
    assert.equal(again, 'OK:monitor_mod:unchanged');
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
        `${file} does not run the helper inside an if — machines that only run it never get the mod`);
    });
  }
  for (const file of ['install.ps1', 'scripts/update.ps1']) {
    it(file, () => {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      assert.ok(live(text, /\$EnsureMod = .*ensure-monitor-mod\.cjs/), `${file} does not name the helper`);
      assert.ok(live(text, /^\s*\$modResult = & node \$EnsureMod /),
        `${file} does not run the helper — Windows machines that only run it never get the mod`);
    });
  }
});
