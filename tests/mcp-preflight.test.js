import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { preflightMcp, readRegistration } = require_(
  path.join(repoRoot, 'scripts/install-helpers/mcp-preflight.cjs'),
);
const selfCheck = require_(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'));

/**
 * v1.26.117 — "registered" and "starts" are different questions, and only the first was asked.
 *
 * `mcp_registered` (v1.26.112) reads `~/.claude.json` and confirms `mcpServers.ownmind` is
 * there. Everything between that entry and a working server was unwatched, and this
 * repository has broken that stretch four times: a `cygpath -w` path interpolated into
 * `node -e` source (v1.26.94), PowerShell 5.1 stripping the quotes off that same source
 * (v1.26.112), Git Bash rewriting cmd.exe's `/c` into `C:/` (v1.26.112), and `start.cmd`'s
 * node-not-found ladder (v1.17.77/79). All four leave a registration that reads perfectly.
 *
 * These tests need no Windows and no installed OwnMind: every case runs a fake MCP server
 * from a temp directory, which is deliberate — the defects above survived precisely because
 * every test that could reach them needed a real Windows machine (v1.26.106).
 */

// A fake MCP server, one file, behaviour chosen by argv. Spawned as `node fake-server.js
// <mode> <pidfile>`, which works identically on all three platforms.
const FAKE_SERVER = `
'use strict';
const fs = require('fs');
const mode = process.argv[2];
const pidFile = process.argv[3];
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));

if (mode === 'crash') {
  process.stderr.write('Cannot find module ../shared/helpers.js\\n');
  process.exit(3);
}
if (mode === 'leak') {
  // The shape that matters: a server that dies complaining about its own credentials. Its
  // stderr is quoted back into the report, which is uploaded.
  process.stderr.write('auth failed for key ' + process.env.OWNMIND_API_KEY + '\\n');
  process.exit(2);
}

let initialized = false;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});

function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }

function handle(msg) {
  if (mode === 'hang') return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-ownmind', version: '9.9.9' },
    } });
    return;
  }
  if (msg.method === 'notifications/initialized') { initialized = true; return; }
  if (msg.method === 'tools/list') {
    if (mode === 'half') return;
    // The real SDK server rejects requests that arrive before the initialized notification.
    // Reproducing that here is what keeps the client's handshake honest: drop the
    // notification and this turns into a timeout rather than a silent pass.
    if (!initialized) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'not initialized' } });
      return;
    }
    const tools = mode === 'no-ownmind'
      ? [{ name: 'some_other_tool' }]
      : [{ name: 'ownmind_init' }, { name: 'ownmind_save' }, { name: 'some_other_tool' }];
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    return;
  }
}
// Do not exit when there is nothing to do: a real server waits.
setInterval(() => {}, 1 << 30);
`;

let tmp;
let serverPath;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-preflight-'));
  serverPath = path.join(tmp, 'fake-server.js');
  fs.writeFileSync(serverPath, FAKE_SERVER);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function entryFor(mode, { pidFile = null, env = {} } = {}) {
  const args = [serverPath, mode];
  if (pidFile) args.push(pidFile);
  return { command: process.execPath, args, env };
}

function fakeHome(entry) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  if (entry) {
    fs.writeFileSync(path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { ownmind: entry } }, null, 2));
  }
  return home;
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitForDeath(pid, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

describe('v1.26.117 — the registered MCP server is actually started, not just read about', () => {
  it('a server that starts and carries ownmind_* tools passes', async () => {
    const r = await preflightMcp({ entry: entryFor('ok'), timeoutMs: 15000 });
    assert.equal(r.status, 'ok', r.reason);
    assert.equal(r.tool_count, 3);
    assert.equal(r.ownmind_tool_count, 2);
    assert.equal(r.server_name, 'fake-ownmind');
    assert.equal(r.server_version, '9.9.9');
    assert.equal(r.phase, 'tools');
  });

  it('a registration whose command does not exist fails', async () => {
    // The v1.17.77 case: `start.cmd` cannot find node, so the thing named in the entry never
    // becomes a process. Registration is perfect; nothing runs.
    const r = await preflightMcp({
      entry: { command: path.join(tmp, 'no-such-binary-ownmind'), args: [] },
      timeoutMs: 5000,
    });
    assert.equal(r.status, 'fail');
    assert.match(r.reason, /could not spawn/);
  });

  it('a server that dies on start fails, and says what it said on the way out', async () => {
    // The v1.26.112 / v1.26.94 shape: the command is launchable, the code it runs is broken.
    // Without the stderr tail the report reads "exited code=3", which sends the reader back
    // to the machine to find out why (IR-003).
    const r = await preflightMcp({ entry: entryFor('crash'), timeoutMs: 8000 });
    assert.equal(r.status, 'fail');
    assert.equal(r.exit_code, 3);
    assert.match(r.stderr_tail, /Cannot find module/);
  });

  it('a server that starts but exposes no ownmind_* tools fails', async () => {
    // Starting is not the goal. An entry pointing at some other MCP server handshakes
    // flawlessly and leaves the user with no ownmind_* tool — the exact symptom of v1.26.112.
    const r = await preflightMcp({ entry: entryFor('no-ownmind'), timeoutMs: 15000 });
    assert.equal(r.status, 'fail');
    assert.match(r.reason, /no ownmind_\* tools/);
    assert.equal(r.ownmind_tool_count, 0);
  });
});

describe('a timeout means cannot tell, never broken', () => {
  it('a server that never answers is unknown, not fail', async () => {
    // The design decision this check turns on. A cold or loaded machine can exceed any
    // budget while being perfectly healthy, and self-check runs at the end of an install —
    // the busiest moment there is. v1.26.106 uploaded a fabricated FAIL from exactly this.
    const r = await preflightMcp({ entry: entryFor('hang'), timeoutMs: 800 });
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /no answer within 800ms/);
  });

  it('the phase says how far it got, because the two stalls need different answers', async () => {
    const stalled = await preflightMcp({ entry: entryFor('hang'), timeoutMs: 800 });
    assert.equal(stalled.phase, 'spawn', 'never answered initialize');
    const halfway = await preflightMcp({ entry: entryFor('half'), timeoutMs: 800 });
    assert.equal(halfway.status, 'unknown');
    assert.equal(halfway.phase, 'initialized', 'answered initialize, then stopped');
  });

  it('the server is not left running after a timeout', async () => {
    // A diagnostic that leaks a process every run costs more than it is worth, and on the
    // daily quick run nobody is watching it happen.
    const pidFile = path.join(tmp, `pid-${Date.now()}.txt`);
    const r = await preflightMcp({ entry: entryFor('hang', { pidFile }), timeoutMs: 800 });
    assert.equal(r.status, 'unknown');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0, 'the fake server never recorded its pid');
    assert.ok(await waitForDeath(pid), `pid ${pid} is still running after the check finished`);
  });
});

describe('nothing that leaves this helper carries a credential', () => {
  it('the API key never appears in the result, even when the server prints it', async () => {
    // This result is written to a log file and uploaded. A failing server is precisely the
    // case where its stderr gets quoted back.
    const KEY = 'super-secret-key-0123456789abcdef';
    const r = await preflightMcp({
      entry: entryFor('leak', { env: { OWNMIND_API_KEY: KEY, OWNMIND_API_URL: 'https://example.invalid' } }),
      timeoutMs: 8000,
    });
    assert.equal(r.status, 'fail');
    assert.ok(!JSON.stringify(r).includes(KEY),
      `the key reached the report: ${JSON.stringify(r)}`);
    assert.match(r.stderr_tail, /auth failed for key \*\*\*/,
      'redacted, but the message must survive — a blanked-out reason diagnoses nothing');
    assert.deepEqual(r.env_keys, ['OWNMIND_API_KEY', 'OWNMIND_API_URL'],
      'names are what tells a reader the entry is complete; values are never reported');
  });

  it('positive control: an unredacted result would fail the test above', async () => {
    // Without this, the assertion passes on any change that stops the key reaching the env
    // at all, and stops testing redaction.
    const KEY = 'super-secret-key-0123456789abcdef';
    const { makeRedactor } = require_(path.join(repoRoot, 'scripts/install-helpers/mcp-preflight.cjs'));
    const redact = makeRedactor({ home: null, env: { OWNMIND_API_KEY: KEY } });
    assert.equal(redact(`auth failed for key ${KEY}`), 'auth failed for key ***');
    const passthrough = (s) => s;
    assert.ok(passthrough(`auth failed for key ${KEY}`).includes(KEY));
  });
});

describe('which home it asks about is the callers choice', () => {
  it('reads the registration from the home it was given, not os.homedir()', async () => {
    // v1.26.112 shipped this bug twice inside its own fix: the helper defaulted to
    // os.homedir() (Windows USERPROFILE) while the installer meant bash $HOME, so it wrote
    // and read back perfectly somewhere nobody was looking.
    const home = fakeHome(entryFor('ok'));
    const r = await preflightMcp({ home, timeoutMs: 15000 });
    assert.equal(r.status, 'ok', r.reason);
    assert.match(r.command, /fake-server\.js/);
  });

  it('an unregistered machine is unknown, not a second failure about the same thing', async () => {
    // mcp_registered already reports this one, and two failures for one cause is how a
    // report stops being read.
    const home = fakeHome(null);
    const r = await preflightMcp({ home, timeoutMs: 5000 });
    assert.equal(r.status, 'unknown');
    assert.equal(r.phase, 'registration');
    assert.match(r.reason, /\.claude\.json/);
    assert.match(r.reason, /mcp_registered/);
  });

  it('readRegistration reports an unreadable config rather than pretending it is empty', () => {
    const home = fs.mkdtempSync(path.join(tmp, 'home-bad-'));
    fs.writeFileSync(path.join(home, '.claude.json'), '{ not json');
    const r = readRegistration({ home });
    assert.match(r.error, /unreadable/);
  });
});

describe('a diagnostic start must not be mistaken for a session', () => {
  it('marks the child as a preflight so it does not send a heartbeat', async () => {
    // The server beats on startup, and collector-silence reads that beat to decide whether a
    // machine has gone quiet. Left alone, this check would refresh the heartbeat every run —
    // including the unattended daily one — and vouch for a machine nobody is using.
    let seenEnv = null;
    const { spawn } = await import('node:child_process');
    const spy = (cmd, args, opts) => { seenEnv = opts.env; return spawn(cmd, args, opts); };
    const r = await preflightMcp({ entry: entryFor('ok'), timeoutMs: 15000, spawnFn: spy });
    assert.equal(r.status, 'ok', r.reason);
    assert.equal(seenEnv.OWNMIND_PREFLIGHT, '1');
  });

  it('a registration cannot switch that off', async () => {
    let seenEnv = null;
    const { spawn } = await import('node:child_process');
    const spy = (cmd, args, opts) => { seenEnv = opts.env; return spawn(cmd, args, opts); };
    const entry = entryFor('ok', { env: { OWNMIND_PREFLIGHT: '0' } });
    await preflightMcp({ entry, timeoutMs: 15000, spawnFn: spy });
    assert.equal(seenEnv.OWNMIND_PREFLIGHT, '1', 'the entry env must not win over the marker');
  });

  it('and the server honours it', () => {
    // Asserted in the source: mcp/index.js is an ESM module that connects a stdio transport
    // on import, so there is no way to load it in-process and ask.
    const src = fs.readFileSync(path.join(repoRoot, 'mcp/index.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function sendMcpHeartbeat'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /OWNMIND_PREFLIGHT.*===.*'1'[\s\S]{0,20}return/,
      'sendMcpHeartbeat must return early for a preflight start');
  });
});

describe('the self-check wiring', () => {
  const stub = (result) => () => Promise.resolve(result);

  it('ok maps to pass', async () => {
    const c = await selfCheck.checkMcpLaunches({ preflight: stub({ status: 'ok', reason: 'handshake ok, 19/19' }) });
    assert.equal(c.status, 'pass');
    assert.equal(c.name, 'mcp_launches');
  });

  it('unknown maps to warn, never fail', async () => {
    // The rule the whole check turns on. If this ever reads `fail`, every slow machine gets
    // an alert about a server that is fine, and the alerts stop being read.
    const c = await selfCheck.checkMcpLaunches({ preflight: stub({ status: 'unknown', reason: 'no answer within 20000ms' }) });
    assert.equal(c.status, 'warn');
    assert.ok(c.fix, 'a warning with no next step is a dead end');
  });

  it('fail maps to fail, with a fix a person can carry out', async () => {
    const c = await selfCheck.checkMcpLaunches({ preflight: stub({ status: 'fail', reason: 'server exited before answering (code=3)' }) });
    assert.equal(c.status, 'fail');
    assert.match(c.fix, /mcp-preflight\.cjs/);
  });

  it('is declared in the check list and actually run — both MCP checks are', async () => {
    // mcp_registered has run since v1.26.112 and was never declared, so it was invisible to
    // every assertion made about the set, including this one.
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'), 'utf8');
    const executed = new Set([...src.matchAll(/safeCheck\('([a-z_]+)'/g)].map((m) => m[1]));
    for (const quick of [true, false]) {
      const names = await selfCheck.checkNamesFor({ quick });
      assert.ok(names.includes('mcp_launches'), `quick=${quick} dropped mcp_launches`);
      assert.ok(names.includes('mcp_registered'), `quick=${quick} dropped mcp_registered`);
    }
    assert.ok(executed.has('mcp_launches'), 'declared but never run');
    assert.ok(executed.has('mcp_registered'), 'declared but never run');
  });

  it('the preflight budget is far above a real launch, on purpose', async () => {
    // Measured on TANK: 693ms warm, through cmd.exe. The budget is not a performance target,
    // it is the line past which the check stops claiming to know anything.
    assert.ok(selfCheck.MCP_PREFLIGHT_TIMEOUT_MS >= 15000,
      'a tight budget here reproduces the fabricated FAIL of v1.26.106');
  });
});
