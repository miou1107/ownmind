import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeCleanMac } from './helpers/clean-mac-sim.mjs';
import { startRealDb } from './helpers/real-db.js';
import { startServer } from './helpers/app-server.js';

/**
 * Zero-touch install, acceptance: the exact one-liner from the install prompt, on a simulated
 * clean Mac, against the REAL server (src/app.js on a real Postgres), with the real Node archive
 * fetched from nodejs.org through the server.
 *
 * Step 1 asks the question the whole feature exists for: a colleague whose Mac has no git (only
 * the /usr/bin/git stub that opens the developer-tools dialog) and no node pastes the prompt, the
 * AI runs one line, and the next conversation loads memory. Proved, not inferred:
 *   - the run ends with a NEXT:verify: line and never executes the git stub
 *   - a brand-new `claude` process (the real binary, `claude mcp list`) connects to the MCP server
 *   - the SessionStart hook written into settings.json, run with a PATH that has no node, makes
 *     the server answer `loaded: true` on /api/install/first-load
 *   - the detached watcher the installer started sees the same thing and logs `loaded`
 *
 * Step 4 asks the opposite question: a developer machine that already runs OwnMind (git and node
 * present) runs this branch's install.sh, and every OwnMind entry in ~/.claude/settings.json and
 * ~/.claude.json comes out byte for byte what it was. On a developer's Mac it starts from copies
 * of the developer's own two files (read-only copies, never printed); where those do not exist
 * (CI), from tests/fixtures/zero-touch-v1.33-install-entries.json, which is what install.sh at
 * origin/main writes (regenerate it with OWNMIND_ACCEPTANCE_WRITE_FIXTURE=1).
 *
 * One deviation from a real clean Mac, and why: the installer registers its usage scanner with
 * `launchctl load -w`, which talks to the live login session, not to $HOME. On the developer's
 * own Mac that would unload the developer's real `com.ownmind.usage-scanner` (same label) and
 * load one pointing into a throwaway home. So the scanner is opted out with
 * `~/.ownmind/.no-usage-scanner`. That file cannot exist before the run (bootstrap treats an
 * existing ~/.ownmind without .release as a broken install and moves it aside), so it is written
 * the moment the archive is unpacked, seconds before install.sh starts; the test asserts the
 * installer printed its opt-out line, so a lost race fails loudly instead of silently. As a
 * second guard, `launchctl` on the simulated PATH refuses every subcommand except `list`, and its
 * `list` hides the developer's own com.ownmind.* agents so they cannot make a check pass.
 * Notifications are dry-run (OWNMIND_NOTIFY_DRY_RUN=1), and the detached watcher is killed at
 * the end.
 *
 * macOS only, and it needs Docker (the real database) and the network (nodejs.org, npm). Each
 * missing piece skips loudly. Not in the `node --test` default glob; the `install` job in
 * .github/workflows/test.yml runs it by name and tests/install-e2e-is-actually-run.test.js fails
 * if that stops being true. Set OWNMIND_ACCEPTANCE_EVIDENCE=<file> to write what the run saw as
 * JSON, for docs/superpowers/plans/2026-10-23-zero-touch-install-evidence.md.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'zero-touch-acceptance-key-0123456789abcdef';
const FIXTURE = path.join(repoRoot, 'tests', 'fixtures', 'zero-touch-v1.33-install-entries.json');
const CLAUDE_BIN = '/opt/homebrew/bin/claude';
const skip = process.platform === 'darwin' ? false : 'the acceptance run simulates a clean Mac; it runs on macOS only';

const world = { db: null, server: null, url: '', pool: null, cacheDir: '', skipReason: '' };
const evidence = { date: new Date().toISOString() };
const cleanups = [];

before(async () => {
  if (skip) return;
  const db = await startRealDb();
  if (!db) {
    world.skipReason = 'docker is not available on this machine, so the real server could NOT be started and the acceptance run did NOT happen';
    return;
  }
  world.db = db;
  const skipped = db.applyMigrations(path.join(repoRoot, 'db'));
  assert.equal(skipped.some((s) => /^0(0[135]|11)_/.test(s)), false, `core migrations failed to apply: ${skipped.join('; ')}`);
  db.psql(`INSERT INTO users (email, name, api_key, role) VALUES ('acceptance@example.com', 'Acceptance', '${KEY}', 'user');`);

  world.cacheDir = process.env.OWNMIND_ACCEPTANCE_CACHE_DIR
    || fs.mkdtempSync(path.join(os.tmpdir(), 'zero-touch-node-cache-'));
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_PORT: String(db.port), DB_NAME: 'ownmind', DB_USER: 'ownmind', DB_PASSWORD: 'test',
    INSTALL_CACHE_DIR: world.cacheDir,
    LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
    // src/utils/crypto.js exits the process at import time without one.
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || 'test-only-encryption-key-32-chars-x',
  });
  // The real app: every route, middleware and rate limit the production server has.
  const app = (await import('../src/app.js')).default;
  world.pool = (await import('../src/utils/db.js')).default;
  world.server = await startServer(app);
  world.url = world.server.url;
});

after(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
  if (world.server) await world.server.close();
  if (world.pool) await world.pool.end().catch(() => {});
  if (world.db) world.db.stop();
  if (world.cacheDir && !process.env.OWNMIND_ACCEPTANCE_CACHE_DIR) fs.rmSync(world.cacheDir, { recursive: true, force: true });
  if (process.env.OWNMIND_ACCEPTANCE_EVIDENCE) {
    fs.writeFileSync(process.env.OWNMIND_ACCEPTANCE_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
  }
});

/** Spawns a command asynchronously (the server answering it lives in this process). */
function run(cmd, args, { env, cwd, input, timeoutMs = 20 * 60 * 1000, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; stdout += c; if (onStdout) onStdout(String(c)); });
    child.stderr.on('data', (c) => { out += c; stderr += c; });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, out, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}

async function reachable(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Every OwnMind hook command in a settings object, as "Event[matcher] command" strings, in order. */
function ownmindHooks(settings) {
  const found = [];
  for (const [event, groups] of Object.entries(settings?.hooks || {})) {
    for (const group of groups || []) {
      for (const h of group?.hooks || []) {
        if (typeof h?.command === 'string' && /ownmind/i.test(h.command)) {
          found.push({ event, matcher: group.matcher ?? null, command: h.command });
        }
      }
    }
  }
  return found;
}

/** Kills every process whose command line names `dir` (the watcher, a stray MCP server). */
function killProcessesUnder(dir) {
  let pids = [];
  try {
    pids = execFileSync('/usr/bin/pgrep', ['-f', dir], { encoding: 'utf8' }).split('\n').map((s) => Number(s.trim())).filter((n) => n > 0);
  } catch { /* none */ }
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  return pids;
}

/**
 * A `launchctl` that cannot touch the login session: `list` is answered by the real one with
 * every com.ownmind.* line removed (the developer's own agent must not make a check pass), and
 * every other subcommand is recorded and refused.
 */
function guardLaunchctl(mac) {
  const log = path.join(mac.binDir, 'launchctl-calls.log');
  const shim = path.join(mac.binDir, 'launchctl');
  fs.rmSync(shim, { force: true });
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${log}"`,
    'if [ "$1" = list ]; then',
    '  if [ -n "$2" ]; then case "$2" in com.ownmind.*) exit 113 ;; esac; exec /bin/launchctl "$@"; fi',
    "  /bin/launchctl list | /usr/bin/grep -v 'com\\.ownmind\\.'",
    '  exit 0',
    'fi',
    'echo "launchctl $1: refused by the acceptance test (it would change the developer\'s login session)" >&2',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  return log;
}

test('Step 1: a clean Mac runs the prompt\'s one-liner against the real server, and the next conversation loads memory', { skip, timeout: 25 * 60 * 1000 }, async (t) => {
  if (world.skipReason) { t.skip(world.skipReason); return; }
  if (!(await reachable('https://nodejs.org/dist/index.json'))) {
    t.skip('nodejs.org is not reachable from this machine, so the private Node could NOT be downloaded and the acceptance run did NOT happen');
    return;
  }

  const mac = makeCleanMac({ xcodeStub: true });
  const dir = path.join(mac.home, '.ownmind');
  cleanups.push(() => {
    try {
      const pid = Number(fs.readFileSync(path.join(dir, 'state', 'first-load-watch.pid'), 'utf8').trim());
      if (pid > 0) process.kill(pid, 'SIGTERM');
    } catch { /* the watcher already finished */ }
    killProcessesUnder(mac.home);
    if (!process.env.OWNMIND_ACCEPTANCE_KEEP) mac.cleanup();
  });
  const launchctlLog = guardLaunchctl(mac);
  const env = { ...mac.env, OWNMIND_NOTIFY_DRY_RUN: '1' };

  // Nothing of the developer's is reachable: no git that works, no node, an empty home.
  assert.notEqual((await run('sh', ['-c', 'command -v node'], { env })).status, 0, 'the simulated Mac must not have node');
  assert.deepEqual(fs.readdirSync(mac.home), [], 'the simulated home must start empty');

  // The scanner opt-out, written the moment the release is unpacked (see the header).
  const optOut = setInterval(() => {
    if (fs.existsSync(path.join(dir, '.release')) && !fs.existsSync(path.join(dir, '.no-usage-scanner'))) {
      try { fs.writeFileSync(path.join(dir, '.no-usage-scanner'), ''); } catch { /* next tick */ }
    }
  }, 5);
  cleanups.push(() => clearInterval(optOut));

  const oneLiner = `curl -fsSL ${world.url}/install.sh | bash -s -- ${KEY} ${world.url}`;
  const since = new Date(Date.now() - 1000).toISOString();
  const started = Date.now();
  let nextAfterMs = null;
  const r = await run('bash', ['-c', oneLiner], {
    env,
    cwd: mac.home,
    onStdout: (chunk) => { if (nextAfterMs === null && /(^|\n)NEXT:/.test(chunk)) nextAfterMs = Date.now() - started; },
  });
  const totalMs = Date.now() - started;
  clearInterval(optOut);
  Object.assign(evidence, {
    step1: {
      command: oneLiner.replace(KEY, '<KEY>'),
      exitStatus: r.status,
      firstNextAfterSeconds: nextAfterMs === null ? null : Math.round(nextAfterMs / 1000),
      totalSeconds: Math.round(totalMs / 1000),
      output: r.out.split(KEY).join('<KEY>'),
    },
  });

  const tail = r.out.slice(-8000);
  assert.equal(r.status, 0, tail);
  assert.match(r.out, /INFO:archive_mode:/, tail);
  assert.match(r.out, /OK:unpack:release v\d+\.\d+\.\d+ unpacked/, tail);
  assert.match(r.out, /OK:node:private Node v22\.\d+\.\d+ installed/, tail);
  assert.match(r.out, /\d+ passed, \d+ warnings?, \d+ failed/, 'the self-check summary is printed');
  assert.match(r.out, /\[INFO\] Skipping usage scanner install \(\.no-usage-scanner opt-out\)/,
    'the scanner opt-out was not in place when install.sh reached it; the run may have touched launchd');
  assert.doesNotMatch(r.out, /\nERROR:|\nASK:|\nFIX:/, 'a clean install prints no ERROR, ASK or FIX line');
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.match(lines[lines.length - 1], /^NEXT:verify:/, lines.slice(-4).join('\n'));
  assert.ok(!fs.existsSync(mac.gitMarker), 'the git stub was executed; on a real Mac that opens the developer-tools dialog');
  assert.doesNotMatch(r.out, /requesting install/);
  const launchctlCalls = fs.existsSync(launchctlLog) ? fs.readFileSync(launchctlLog, 'utf8').split('\n').filter(Boolean) : [];
  assert.deepEqual(launchctlCalls.filter((l) => !l.startsWith('list')), [], 'only read-only launchctl calls');
  evidence.step1.selfCheckSummary = (r.out.match(/^.*\d+ passed, \d+ warnings?, \d+ failed.*$/m) || [''])[0].trim();
  evidence.step1.selfCheckProblems = r.out.split('\n').filter((l) => /^\s*(\[FAIL\]|\[WARN\]|✗|⚠)/.test(l)).map((l) => l.trim());
  evidence.step1.launchctlCalls = launchctlCalls;

  // Files.
  const release = fs.readFileSync(path.join(dir, '.release'), 'utf8').trim();
  const privateNode = path.join(dir, 'runtime', 'current', 'bin', 'node');
  fs.accessSync(privateNode, fs.constants.X_OK);
  const privateNodeVersion = execFileSync(privateNode, ['--version'], { encoding: 'utf8' }).trim();
  assert.match(privateNodeVersion, /^v22\./);
  assert.ok(!fs.existsSync(path.join(dir, '.git')), 'an archive install has no .git');
  const settings = readJson(path.join(mac.home, '.claude', 'settings.json'));
  const hooks = ownmindHooks(settings);
  const hookEvents = [...new Set(hooks.map((h) => h.event))];
  for (const event of ['SessionStart', 'PreToolUse']) {
    assert.ok(hookEvents.includes(event), `settings.json has no OwnMind ${event} hook (has: ${hookEvents.join(', ')})`);
  }
  const claudeJson = readJson(path.join(mac.home, '.claude.json'));
  const mcp = claudeJson.mcpServers?.ownmind;
  assert.ok(mcp, '~/.claude.json has no mcpServers.ownmind');
  assert.ok(path.isAbsolute(mcp.command) && mcp.command.startsWith(path.join(dir, 'runtime')) && mcp.command.endsWith(path.join('bin', 'node')),
    `the MCP command must be the absolute private node, got ${mcp.command}`);
  fs.accessSync(mcp.command, fs.constants.X_OK);
  evidence.step1.files = {
    release,
    privateNode: privateNode.replace(mac.home, '~'),
    privateNodeVersion,
    hooks: hooks.map((h) => ({ ...h, command: h.command.split(mac.home).join('~') })),
    mcp: { command: mcp.command.replace(mac.home, '~'), args: (mcp.args || []).map((a) => String(a).replace(mac.home, '~')) },
    ownmindTopLevel: fs.readdirSync(dir).sort(),
    claudeTopLevel: fs.readdirSync(path.join(mac.home, '.claude')).sort(),
  };

  // A brand-new claude process reads the fresh ~/.claude.json and connects to the MCP server.
  if (fs.existsSync(CLAUDE_BIN)) {
    evidence.step1.claudeVersion = (await run(CLAUDE_BIN, ['--version'], { env, cwd: mac.home, timeoutMs: 60_000 })).stdout.trim();
    const list = await run(CLAUDE_BIN, ['mcp', 'list'], { env, cwd: mac.home, timeoutMs: 120_000 });
    const line = list.stdout.split('\n').find((l) => l.startsWith('ownmind:')) || '';
    evidence.step1.claudeMcpList = { status: list.status, line: line.split(mac.home).join('~'), stderr: list.stderr.trim() };
    assert.match(line, /Connected/, `claude mcp list:\n${list.out}`);
  } else {
    evidence.step1.claudeMcpList = `skipped: ${CLAUDE_BIN} is not installed`;
    t.diagnostic(`${CLAUDE_BIN} is not installed; the claude mcp list check was skipped`);
  }

  // The next conversation: the SessionStart hook exactly as settings.json has it, run with the
  // clean PATH (no system node), as a new Claude Code session would run it.
  // Only the entry for a new conversation (matcher "startup"), as Claude Code would pick.
  const sessionHooks = hooks.filter((h) => h.event === 'SessionStart' && (h.matcher === 'startup' || h.matcher === null));
  assert.equal(sessionHooks.length, 1, `one SessionStart entry for a new conversation: ${JSON.stringify(sessionHooks)}`);
  evidence.step1.sessionStart = [];
  for (const h of sessionHooks) {
    const hr = await run('bash', ['-c', h.command], {
      env,
      cwd: mac.home,
      input: JSON.stringify({ session_id: 'zero-touch-acceptance', hook_event_name: 'SessionStart', source: 'startup', cwd: mac.home }),
      timeoutMs: 120_000,
    });
    evidence.step1.sessionStart.push({
      command: h.command.split(mac.home).join('~'),
      status: hr.status,
      stdoutHead: hr.stdout.split('\n').slice(0, 6).join('\n').split(mac.home).join('~'),
      stderr: hr.stderr.trim().split(mac.home).join('~').slice(0, 2000),
    });
    assert.equal(hr.status, 0, `SessionStart hook failed:\n${hr.out.slice(-3000)}`);
    // What Claude Code puts into the new conversation: the hook's JSON, with the memory context.
    let context = '';
    try { context = JSON.parse(hr.stdout).hookSpecificOutput?.additionalContext || ''; } catch { /* nothing printed */ }
    evidence.step1.sessionStart[evidence.step1.sessionStart.length - 1].contextFirstLine = context.split('\n')[0];
    assert.match(context, /Memory loaded/, `the hook gave the conversation no memory:\n${hr.out.slice(0, 3000)}`);
  }

  // The server's answer, the same question the watcher asks.
  let firstLoad = null;
  for (let i = 0; i < 15; i += 1) {
    const res = await fetch(`${world.url}/api/install/first-load?since=${encodeURIComponent(since)}`, { headers: { Authorization: `Bearer ${KEY}` } });
    firstLoad = { status: res.status, body: await res.json() };
    if (firstLoad.body?.loaded === true) break;
    await sleep(3000);
  }
  evidence.step1.firstLoad = { since, ...firstLoad };
  assert.equal(firstLoad.status, 200);
  assert.equal(firstLoad.body.loaded, true, `first-load: ${JSON.stringify(firstLoad)}`);

  // The detached watcher the installer started sees the load and logs it (it polls every 15 s).
  const watchLog = path.join(dir, 'logs', 'first-load-watch.log');
  let watchLine = '';
  for (let i = 0; i < 60 && !watchLine; i += 1) {
    if (fs.existsSync(watchLog)) watchLine = fs.readFileSync(watchLog, 'utf8').trim().split('\n').filter(Boolean).pop() || '';
    if (!watchLine) await sleep(1000);
  }
  evidence.step1.watcherLog = watchLine;
  assert.match(watchLine, /outcome=loaded/, `watcher log: ${watchLine || '(nothing after 60 s)'}`);

  // Nothing after the install ran the git stub either: not the MCP server, not the hook, not the watcher.
  evidence.step1.gitStubEverRun = fs.existsSync(mac.gitMarker);
  assert.ok(!fs.existsSync(mac.gitMarker), 'the git stub was executed after the install (MCP server, hook or watcher)');
});

/** Copies the files of a tree into a one-commit repository and clones it to `dest` (see install-clean-machine.e2e.mjs for why not a clone of the checkout). */
function seedGitInstall(treeDir, dest) {
  const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-touch-upstream-'));
  cleanups.push(() => fs.rmSync(upstream, { recursive: true, force: true }));
  fs.cpSync(treeDir, upstream, { recursive: true });
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  git(['init', '-q', '-b', 'main'], upstream);
  git(['add', '-A'], upstream);
  git(['-c', 'user.name=acceptance', '-c', 'user.email=acceptance@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'seed'], upstream);
  git(['clone', '-q', upstream, dest], path.dirname(dest));
}

/** The files of `ref` in this repository, extracted into a fresh directory. */
function treeAt(ref) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-touch-tree-'));
  cleanups.push(() => fs.rmSync(out, { recursive: true, force: true }));
  const tarFile = path.join(out, '..', `${path.basename(out)}.tar`);
  execFileSync('git', ['archive', '--format=tar', '-o', tarFile, ref], { cwd: repoRoot });
  execFileSync('tar', ['-xf', tarFile, '-C', out]);
  fs.rmSync(tarFile, { force: true });
  return out;
}

/** An environment for a developer machine (normal PATH, git and node present) sealed into `home`. */
function developerEnv(home) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|OWNMIND_)/i.test(k)) delete env[k];
  return Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    OWNMIND_NOTIFY_DRY_RUN: '1',
    OWNMIND_SKIP_FIRST_LOAD_WATCH: '1',
    npm_config_cache: path.join(os.homedir(), '.npm'),
  });
}

/** Runs install.sh from a git install of `treeDir` in `home`, with the scanner opted out. */
async function installGit(treeDir, home) {
  const dir = path.join(home, '.ownmind');
  seedGitInstall(treeDir, dir);
  fs.writeFileSync(path.join(dir, '.no-usage-scanner'), '');
  return run('bash', ['install.sh', KEY, world.url], { env: developerEnv(home), cwd: dir });
}

const swapHome = (text, from, to) => text.split(from).join(to);

/** The OwnMind-owned entries the comparison looks at: hook commands and the MCP command line. */
function ownedEntries(settings, claudeJson) {
  const mcp = claudeJson?.mcpServers?.ownmind || null;
  return {
    hooks: ownmindHooks(settings),
    mcp: mcp ? { type: mcp.type ?? null, command: mcp.command ?? null, args: mcp.args ?? null } : null,
  };
}

test('Step 4: on a machine that already runs OwnMind (git and node present), this branch\'s install.sh leaves every OwnMind entry unchanged', { skip, timeout: 25 * 60 * 1000 }, async (t) => {
  if (world.skipReason) { t.skip(world.skipReason); return; }
  const realSettings = path.join(os.homedir(), '.claude', 'settings.json');
  const realClaudeJson = path.join(os.homedir(), '.claude.json');

  // Regenerating the CI fixture: what install.sh at origin/main writes, with the home as {HOME}.
  if (process.env.OWNMIND_ACCEPTANCE_WRITE_FIXTURE === '1') {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zero-touch-main-home-')));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const sha = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const r = await installGit(treeAt(sha), home);
    assert.equal(r.status, 0, r.out.slice(-4000));
    const settingsText = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const mcp = readJson(path.join(home, '.claude.json')).mcpServers.ownmind;
    const fixture = {
      generatedFrom: `install.sh at origin/main ${sha}`,
      settings: JSON.parse(swapHome(swapHome(settingsText, home, '{HOME}'), KEY, '{KEY}')),
      claudeJson: { mcpServers: { ownmind: JSON.parse(swapHome(swapHome(JSON.stringify(mcp), home, '{HOME}'), KEY, '{KEY}')) } },
    };
    fs.writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  }

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zero-touch-dev-home-')));
  cleanups.push(() => { killProcessesUnder(home); fs.rmSync(home, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // OWNMIND_ACCEPTANCE_SYNTHETIC=1 runs the CI branch on a machine that has the real files.
  const useReal = fs.existsSync(realSettings) && fs.existsSync(realClaudeJson) && process.env.OWNMIND_ACCEPTANCE_SYNTHETIC !== '1';
  let source;
  if (useReal) {
    // Copies only; the paths of the real home are rewritten to this one, as if it were the real
    // home. Contents are never printed (they can hold keys).
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), swapHome(fs.readFileSync(realSettings, 'utf8'), os.homedir(), home));
    fs.writeFileSync(path.join(home, '.claude.json'), swapHome(fs.readFileSync(realClaudeJson, 'utf8'), os.homedir(), home));
    source = 'copies of this developer\'s own ~/.claude/settings.json and ~/.claude.json';
  } else {
    const fixture = readJson(FIXTURE);
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), swapHome(swapHome(JSON.stringify(fixture.settings, null, 2), '{HOME}', home), '{KEY}', KEY));
    fs.writeFileSync(path.join(home, '.claude.json'), swapHome(swapHome(JSON.stringify(fixture.claudeJson, null, 2), '{HOME}', home), '{KEY}', KEY));
    source = `the synthetic v1.33.x files in ${path.relative(repoRoot, FIXTURE)} (${fixture.generatedFrom})`;
    t.diagnostic(`no ~/.claude/settings.json here; starting from ${source}`);
  }
  const before = ownedEntries(readJson(path.join(home, '.claude', 'settings.json')), readJson(path.join(home, '.claude.json')));
  assert.ok(before.hooks.length > 0 && before.mcp, 'the starting files must hold OwnMind entries, or there is nothing to compare');

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const r = await installGit(treeAt(head), home);
  assert.equal(r.status, 0, r.out.slice(-4000).split(KEY).join('<KEY>'));
  assert.doesNotMatch(r.out, /\[INFO\] Archive install/, 'a git install must stay a git install');
  const after = ownedEntries(readJson(path.join(home, '.claude', 'settings.json')), readJson(path.join(home, '.claude.json')));

  // Where something differs, say which entry, with home paths shortened and nothing key-shaped.
  const show = (v) => swapHome(JSON.stringify(v), home, '~').replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>');
  const beforeSet = new Set(before.hooks.map(show));
  const afterSet = new Set(after.hooks.map(show));
  const removed = [...beforeSet].filter((h) => !afterSet.has(h));
  const added = [...afterSet].filter((h) => !beforeSet.has(h));
  evidence.step4 = {
    source,
    head,
    beforeHookCount: before.hooks.length,
    afterHookCount: after.hooks.length,
    removed,
    added,
    mcpBefore: show(before.mcp),
    mcpAfter: show(after.mcp),
    identical: removed.length === 0 && added.length === 0 && show(before.mcp) === show(after.mcp)
      && before.hooks.length === after.hooks.length,
  };
  assert.deepEqual({ removed, added }, { removed: [], added: [] }, 'OwnMind hook commands changed');
  assert.equal(after.hooks.length, before.hooks.length, 'the number of OwnMind hook entries changed');
  assert.deepEqual(after.mcp, before.mcp, `mcpServers.ownmind changed: ${show(before.mcp)} -> ${show(after.mcp)}`);
  assert.ok(!path.isAbsolute(after.mcp.command), `with a system node the MCP command stays a bare name, got ${show(after.mcp.command)}`);
});
