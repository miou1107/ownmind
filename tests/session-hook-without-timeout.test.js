import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeCleanMac } from './helpers/clean-mac-sim.mjs';
import { spawnBashScript } from './helpers/bash-script.js';

/**
 * The SessionStart hook on a stock Mac, which has no `timeout` command (it is GNU coreutils;
 * a developer's Mac usually has it from Homebrew, a colleague's does not).
 *
 * Found by the zero-touch acceptance run (tests/zero-touch-acceptance.e2e.mjs) on 2026-10-23:
 * the hook ran `timeout 5 node session-start-output.js …` to print the memories into the new
 * conversation. With no `timeout` that line is "command not found", its stderr goes to
 * /dev/null, and the hook exits 0 having printed nothing — while it has already reported a
 * successful `init` to the server, so the first-load watcher tells the colleague "OwnMind is
 * running" and the conversation holds no memory at all. `timeout 10 node conditional-sync-cli.js`
 * failed the same way and fell back to a plain download.
 *
 * Runs the real hooks/ownmind-session-start.sh in a simulated clean Mac (system tools only, no
 * timeout, no node on PATH; node only as the private runtime under ~/.ownmind) against a stub
 * server, and requires the hook to hand the conversation its memory context (the JSON Claude Code reads).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'session-hook-timeout-test-key-0123';
const MARKER = 'ZERO-TOUCH-HOOK-MARKER-RULE';
const skip = process.platform === 'win32' ? 'the shell hook is what macOS and Linux run; Windows runs the node one' : false;

const stub = { server: null, url: '' };

before(async () => {
  if (skip) return;
  stub.server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/memory/init')) {
        return res.end(JSON.stringify({
          profile: null,
          iron_rules: [{ id: 1, type: 'iron_rule', title: MARKER, content: 'never skip the marker', tags: [] }],
          principles: [],
          memories: [],
        }));
      }
      if (req.url.startsWith('/api/broadcast/active')) return res.end('[]');
      return res.end('{}');
    });
  });
  await new Promise((resolve, reject) => {
    stub.server.once('error', reject);
    stub.server.listen(0, '127.0.0.1', resolve);
  });
  stub.url = `http://127.0.0.1:${stub.server.address().port}`;
});

after(async () => {
  if (stub.server) await new Promise((resolve) => stub.server.close(resolve));
});

/** ~/.ownmind built from this checkout by symlinks, with node only as the private runtime. */
function stageOwnmind(home, { slowOutput = false } = {}) {
  const dir = path.join(home, '.ownmind');
  fs.mkdirSync(path.join(dir, 'runtime', 'current', 'bin'), { recursive: true });
  for (const name of ['hooks', 'shared', 'scripts', 'node_modules', 'mcp']) {
    fs.symlinkSync(path.join(repoRoot, name), path.join(dir, name));
  }
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(dir, 'package.json'));
  const nodeBin = path.join(dir, 'runtime', 'current', 'bin', 'node');
  if (slowOutput) {
    // The script that prints the memories hangs past its 5-second limit; everything else is
    // the real node. `exec`, so the process the hook stops is the sleep itself.
    fs.writeFileSync(nodeBin, [
      '#!/bin/sh',
      'case "$*" in *session-start-output.js*) exec sleep 8.71 ;; esac',
      `exec "${process.execPath}" "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
  } else {
    fs.symlinkSync(process.execPath, nodeBin);
  }
  // No .git: the hook's update block (git pull) only runs in a git install.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { ownmind: { command: 'node', args: [], env: { OWNMIND_API_KEY: KEY, OWNMIND_API_URL: stub.url } } },
  }));
  return dir;
}

function runHook(mac, dir, { onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    // detached: its own process group, so everything it starts can be found afterwards by group.
    const child = spawn('bash', [path.join(dir, 'hooks', 'ownmind-session-start.sh')], {
      cwd: mac.home, env: mac.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    if (onSpawn) onSpawn(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ session_id: 'timeout-test', hook_event_name: 'SessionStart', source: 'startup' }));
  });
}

test('with no `timeout` and no system node, the SessionStart hook still prints the memories', { skip, timeout: 60_000 }, async () => {
  const mac = makeCleanMac();
  try {
    const probe = await new Promise((resolve) => {
      spawn('sh', ['-c', 'command -v timeout || command -v node'], { env: mac.env }).once('close', resolve);
    });
    assert.notEqual(probe, 0, 'the simulated Mac must have neither timeout nor node on PATH');
    const dir = stageOwnmind(mac.home);
    const r = await runHook(mac, dir);
    assert.equal(r.status, 0, r.stderr);
    let context = '';
    try { context = JSON.parse(r.stdout).hookSpecificOutput?.additionalContext || ''; } catch { /* nothing printed */ }
    assert.match(context, /Memory loaded/, `the hook put no memory into the conversation:\nstdout: ${r.stdout.slice(0, 2000)}\nstderr: ${r.stderr.slice(0, 2000)}`);
  } finally {
    mac.cleanup();
  }
});

/** Every running `sleep` as { pid, pgid, command }, read from this process (not the simulated PATH). */
function sleepProcesses() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf8' });
  const found = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S*\bsleep\s.*)$/);
    if (m) found.push({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] });
  }
  return found;
}

/** The stand-in exactly as the hook defines it. */
function standIn() {
  const src = fs.readFileSync(path.join(repoRoot, 'hooks', 'ownmind-session-start.sh'), 'utf8');
  const m = src.match(/^if ! command -v timeout >\/dev\/null 2>&1; then\n[\s\S]*?^fi$/m);
  assert.ok(m, 'the hook no longer defines its timeout stand-in');
  return m[0];
}

test('the stand-in stops a command that runs past its limit, on time, and leaves no sleep behind', { skip, timeout: 30_000 }, async () => {
  const mac = makeCleanMac();
  try {
    const script = [
      standIn(),
      'start=$(date +%s)',
      'timeout 2.37 sleep 9.73; rc=$?',
      'echo "late rc=$rc took=$(( $(date +%s) - start ))"',
      // A command that takes a moment, so the watchdog is already sleeping when it is told to stop.
      'timeout 4.19 sleep 0.31; echo "early rc=$?"',
    ].join('\n');
    const r = spawnBashScript(script, { env: mac.env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    const late = r.stdout.match(/late rc=(\d+) took=(\d+)/);
    assert.ok(late, r.stdout + r.stderr);
    assert.equal(late[1], '143', 'a command stopped on time returns 143 (SIGTERM)');
    assert.ok(Number(late[2]) <= 3, `a 2.37-second limit took ${late[2]} s`);
    assert.match(r.stdout, /early rc=0/);
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    // The three durations are this test's own, so no other process's sleep can be mistaken for one.
    const ours = sleepProcesses().filter((p) => /sleep (2\.37|9\.73|4\.19)$/.test(p.command));
    assert.deepEqual(ours, [], 'the stand-in left a sleep running');
  } finally {
    mac.cleanup();
  }
});

test('a SessionStart hook whose output step hangs still exits 0 within its limit, with no sleep left over', { skip, timeout: 60_000 }, async () => {
  const mac = makeCleanMac();
  try {
    const dir = stageOwnmind(mac.home, { slowOutput: true });
    let group = 0;
    const started = Date.now();
    const r = await runHook(mac, dir, { onSpawn: (pid) => { group = pid; } });
    const seconds = (Date.now() - started) / 1000;
    assert.equal(r.status, 0, r.stderr);
    // The output step's limit is 5 seconds; the rest of the hook (a download, a few short node
    // runs) takes about a second and a half here.
    assert.ok(seconds < 8, `the hook took ${seconds.toFixed(1)} s with a 5-second limit on the step that hung`);
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
    const ours = sleepProcesses().filter((p) => p.pgid === group);
    assert.deepEqual(ours, [], 'the hook left a sleep running');
  } finally {
    mac.cleanup();
  }
});
