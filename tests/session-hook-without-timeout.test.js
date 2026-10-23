import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeCleanMac } from './helpers/clean-mac-sim.mjs';

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
function stageOwnmind(home) {
  const dir = path.join(home, '.ownmind');
  fs.mkdirSync(path.join(dir, 'runtime', 'current', 'bin'), { recursive: true });
  for (const name of ['hooks', 'shared', 'scripts', 'node_modules', 'mcp']) {
    fs.symlinkSync(path.join(repoRoot, name), path.join(dir, name));
  }
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(process.execPath, path.join(dir, 'runtime', 'current', 'bin', 'node'));
  // No .git: the hook's update block (git pull) only runs in a git install.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { ownmind: { command: 'node', args: [], env: { OWNMIND_API_KEY: KEY, OWNMIND_API_URL: stub.url } } },
  }));
  return dir;
}

function runHook(mac, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(dir, 'hooks', 'ownmind-session-start.sh')], {
      cwd: mac.home, env: mac.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
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
