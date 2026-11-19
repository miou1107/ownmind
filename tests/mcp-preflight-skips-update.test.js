// A diagnostic start of the MCP must not start an update.
//
// The install's self-check launches the registered MCP once to count its tools
// (scripts/install-helpers/mcp-preflight.cjs) and kills it as soon as it has the answer.
// The MCP used to start its daily update on that launch too. On an archive install the
// update takes `.update-lock` and asks the server for the newest release; when the kill
// lands before that request returns, the signal handler exits without the update's
// `finally`, and the lock stays behind until it goes stale ten minutes later. Anything
// that updates in those ten minutes - the next upgrade a person runs, or the archive update
// in tests/bootstrap-archive-mode.e2e.mjs - fails with `lock_held`. It surfaced as a flaky
// "clean install / ubuntu-latest" on a dependency bump that changed nothing near it.
//
// The server below never answers the release request, which is the slow case made
// permanent: a normal start is still waiting on it, holding the lock; a preflight start
// must never have sent it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startMcp({ preflight }) {
  const home = tempDir('mcp-preflight-update-');
  const ownmindDir = path.join(home, '.ownmind');
  fs.mkdirSync(ownmindDir, { recursive: true });
  // An archive install: a .release file and no .git.
  fs.writeFileSync(path.join(ownmindDir, '.release'), 'v9.9.9\n');

  const releaseRequests = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/install/archive')) {
      releaseRequests.push(req.method);
      return; // never answered: the update stays in flight, holding the lock
    }
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OWNMIND_API_URL: url,
    OWNMIND_API_KEY: '00000000-0000-4000-8000-000000000000',
    OWNMIND_TOOL: 'claude-code',
  };
  delete env.OWNMIND_PREFLIGHT;
  if (preflight) env.OWNMIND_PREFLIGHT = '1';

  const child = spawn(process.execPath, [path.join(repoRoot, 'mcp', 'index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const stop = async () => {
    child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return { child, ownmindDir, releaseRequests, stop, stderr: () => stderr };
}

async function waitFor(cond, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

test('a normal start updates: it takes the lock and asks the server for the newest release', async () => {
  // The control. Without it, the test below would also pass on an MCP that never updates at all.
  const mcp = await startMcp({ preflight: false });
  try {
    const asked = await waitFor(() => mcp.releaseRequests.length > 0, 15000);
    assert.ok(asked, `a normal start never asked for the release: ${mcp.stderr().slice(-800)}`);
    assert.ok(fs.existsSync(path.join(mcp.ownmindDir, '.update-lock')), 'the update holds the lock while it waits');
  } finally {
    await mcp.stop();
  }
});

test('a preflight start does not update, so killing it cannot leave the lock behind', async () => {
  const mcp = await startMcp({ preflight: true });
  try {
    // Wait for the server's own word that it skipped the update, so a slow machine cannot make
    // this pass before the update would even have started.
    const logs = path.join(mcp.ownmindDir, 'logs');
    const skipped = await waitFor(() => {
      try {
        return fs.readdirSync(logs).some((f) => /"reason":"preflight"/.test(fs.readFileSync(path.join(logs, f), 'utf8')));
      } catch { return false; }
    }, 15000);
    assert.ok(skipped, `the server never logged update_skipped reason=preflight: ${mcp.stderr().slice(-800)}`);
    assert.equal(mcp.child.exitCode, null, `the server must still be running: ${mcp.stderr().slice(-800)}`);
    assert.deepEqual(mcp.releaseRequests, [], 'a preflight start asked the server for a release');
    assert.ok(!fs.existsSync(path.join(mcp.ownmindDir, '.update-lock')), 'a preflight start took the update lock');
  } finally {
    await mcp.stop();
  }
});
