/**
 * #134 — the session-start output module wrote the right JSON and then aborted.
 *
 * Measured on Windows 10 with Node v25.8.1: `node hooks/lib/session-start-output.js …` printed
 * a complete, well-formed hook response and exited 127 with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`.
 * Five runs out of five.
 *
 * The trigger is the bug-report-notifications fetch: on every run where it completed the process
 * aborted, and on every run where it was skipped (a fourth argument supplies the notifications)
 * it exited 0. libuv is still tearing the connection down when `process.exit(0)` runs in the
 * stdout write callback.
 *
 * So the regression test has to make the fetch actually happen. A local server is enough — the
 * response can even be a 404, because what matters is that a connection was opened and closed,
 * not what came back.
 *
 * It surfaced as `tests/hook-lib-resolution.test.js` failing, since execFileSync throws on a
 * non-zero status. That file was the only red in the suite and says nothing about exit codes,
 * which is why this exists separately.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { startServer } from './helpers/app-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js');

/** A HOME whose settings point the hook at `apiUrl`. */
function homePointingAt(apiUrl) {
  const home = tempDir('om-134-home-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'k-not-real', OWNMIND_API_URL: apiUrl } } },
  }));
  return home;
}

/**
 * Run the module and wait for it, without blocking this process.
 *
 * `spawnSync` cannot be used here. It blocks the parent's event loop for the whole run, so the
 * fixture server below — which lives in this process — never accepts the connection, and the
 * child sits until its own 3s abort fires. An earlier draft of this file did exactly that and
 * spent three seconds proving nothing, which its own "did the server get dialled?" control
 * caught.
 */
function runModule(home, apiUrl, extraArgs = []) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MODULE, '{"server_version":"1.0.0"}', '[]', ...extraArgs], {
      // The environment is a credential source of its own (resolve-credentials.cjs), and the
      // suite inherits whatever the machine running it has configured. Both are set to the
      // fixture's address so the child cannot reach a real server.
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OWNMIND_API_KEY: 'k-not-real',
        OWNMIND_API_URL: apiUrl,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });

    const cap = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
    child.on('error', (err) => { clearTimeout(cap); reject(err); });
    child.on('close', (status, signal) => {
      clearTimeout(cap);
      resolve({ status, signal, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

describe('#134 the session-start output module finishes cleanly', () => {
  it('exits 0 after a fetch that actually completed', async () => {
    const app = express();
    let dialled = 0;
    app.use((_req, res) => { dialled += 1; res.status(404).json({ error: 'not found' }); });
    const server = await startServer(app);

    try {
      const r = await runModule(homePointingAt(server.url), server.url);

      // The control: without a request having gone out, this test is the skipped-fetch case,
      // which never reproduced the abort in the first place.
      assert.ok(dialled > 0, 'the hook never dialled the server, so this proves nothing');

      assert.equal(r.status, 0,
        `exited ${r.status} — a hook that aborts after printing is #134:\n${r.stderr}`);
      assert.doesNotMatch(r.stderr || '', /Assertion failed/,
        `libuv aborted the process:\n${r.stderr}`);

      // And the output is still the whole point: a clean exit that printed nothing would pass
      // the assertions above while taking the memory load down.
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.hookSpecificOutput?.hookEventName, 'SessionStart');
      assert.ok(String(parsed.hookSpecificOutput?.additionalContext || '').length > 0);
    } finally {
      await server.close();
    }
  });

  it('exits 0 when the fetch is skipped entirely', async () => {
    // The shape that always worked, kept as the other half of the comparison: if this ever
    // starts failing too, the cause is not the connection teardown.
    const dead = 'http://127.0.0.1:1/ownmind';
    const r = await runModule(homePointingAt(dead), dead, ['null']);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.stderr}`);
    assert.match(r.stdout, /additionalContext/);
  });

  it('the forced exit cannot hold the process open by itself', () => {
    // The fix is that the fallback timer is unref'd: nothing to tear down means the process
    // ends on its own, and `process.exit` is only reached when something is genuinely stuck.
    // A ref'd timer would put the abort back for everyone on a healthy network.
    const src = fs.readFileSync(MODULE, 'utf8');
    assert.match(src, /setTimeout\(\(\)\s*=>\s*process\.exit\(0\),\s*\d+\)/,
      'the forced-exit fallback is gone; a hung connect would hold the hook past its 10s budget');
    assert.match(src, /\.unref\(\)/,
      'the forced-exit timer is not unref\'d, so it runs on every healthy exit as well');
  });

  it('a server that never answers does not hold the hook anywhere near its 10s budget', async () => {
    // The reason the forced exit exists at all. `AbortSignal.timeout(3000)` gives up on the
    // request but does not tear down a connect still waiting for a SYN-ACK; measured at 10.66s
    // before the fallback was added, against a 10s hook timeout.
    //
    // 10.255.255.1 is inside a private range and routable nowhere, so a SYN to it is dropped
    // rather than refused — which is the case being reproduced. Where the network refuses it
    // outright the run simply finishes sooner, and the bound below still holds.
    const blackhole = 'http://10.255.255.1/ownmind';
    const r = await runModule(homePointingAt(blackhole), blackhole);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.stderr}`);
    assert.ok(r.elapsedMs < 8000,
      `took ${r.elapsedMs}ms; the hook is registered with a 10s timeout and bash is killed at it`);
    assert.match(r.stdout, /additionalContext/, 'the context has to survive a dead network');
  });
});
