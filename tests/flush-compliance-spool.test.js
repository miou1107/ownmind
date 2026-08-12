import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { tempDir } from './helpers/temp-dir.js';

/**
 * v1.17.97 — hooks/lib/flush-compliance-spool.js
 *
 * Helper called at the start of the SessionStart hook:
 *   - read the entire ~/.ownmind/logs/reply-lint-pending.jsonl file
 *   - POST it once to /api/activity/batch (using settings.json's OWNMIND_API_KEY/URL)
 *   - HTTP 200 → delete the pending file (events landed in the DB)
 *   - any other case → keep it around for the next attempt
 *
 * Never leak anything to stderr / stdout (IR-027 spec #3; SessionStart runs on the user-visible channel).
 */

const repoRoot = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const helperPath = path.join(repoRoot, 'hooks', 'lib', 'flush-compliance-spool.js');

let tmpHome;
let pendingSpoolPath;

function setupTmpHome() {
  tmpHome = tempDir('ownmind-flush-spool-test-');
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingSpoolPath = path.join(tmpHome, '.ownmind', 'logs', 'reply-lint-pending.jsonl');
}
function cleanupTmpHome() { fs.rmSync(tmpHome, { recursive: true, force: true }); }

function setupCredentials(apiUrl) {
  const claudeDir = path.join(tmpHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: apiUrl } } },
  }));
}

function makeEvent(rule = 'IR-037', message = 'mixed lang') {
  return {
    ts: new Date().toISOString(),
    event: 'iron_rule_compliance',
    tool: 'claude-code',
    source: 'reply-lint-hook',
    details: { action: 'violate', rule_code: rule, message },
  };
}

function seedPending(events) {
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(pendingSpoolPath, lines);
}

function runHelper(env = {}) {
  return spawnSync('node', [helperPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      ...env,
    },
  });
}

/** Async variant — required when the fake server and helper share the same Node process. */
function runHelperAsync(env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [helperPath], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        ...env,
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ status: code, stdout, stderr }));
  });
}

function startFakeServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => handler({ method: req.method, url: req.url, body, headers: req.headers }, res));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

describe('v1.17.97 — flush-compliance-spool helper basic contract', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('helper file exists + can be spawned with node', () => {
    assert.ok(fs.existsSync(helperPath));
    const r = runHelper();
    assert.equal(r.status, 0);
  });

  it('pending file missing → exit 0; stderr/stdout blank', () => {
    setupCredentials('http://127.0.0.1:1');
    const r = runHelper();
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'stderr must be blank');
    assert.equal(r.stdout, '', 'stdout must be blank');
  });

  it('pending file exists but empty → no POST; no crash', () => {
    fs.writeFileSync(pendingSpoolPath, '');
    setupCredentials('http://127.0.0.1:1');
    const r = runHelper();
    assert.equal(r.status, 0);
  });

  it('no credentials → leave the pending file untouched', () => {
    seedPending([makeEvent()]);
    const r = runHelper();
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingSpoolPath), 'must not delete the pending file when credentials are missing');
  });
});

describe('v1.17.97 — POST behavior', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('POST 200 → delete the pending file', async () => {
    let captured = null;
    const server = await startFakeServer((req, res) => {
      captured = req;
      res.statusCode = 200; res.end('{"inserted":2}');
    });
    try {
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      seedPending([makeEvent('IR-037'), makeEvent('IR-036')]);
      const r = await runHelperAsync();
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      assert.ok(captured, 'POST should have fired');
      assert.equal(captured.method, 'POST');
      assert.equal(captured.url, '/api/activity/batch');
      const body = JSON.parse(captured.body);
      assert.equal(body.events.length, 2);
      assert.equal(fs.existsSync(pendingSpoolPath), false,
        'after POST 200, the pending file must be deleted (so we do not resend next time)');
    } finally { server.close(); }
  });

  it('POST 5xx → keep the pending file for the next retry', async () => {
    const server = await startFakeServer((req, res) => {
      res.statusCode = 500; res.end('boom');
    });
    try {
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      seedPending([makeEvent()]);
      const r = await runHelperAsync();
      assert.equal(r.status, 0);
      assert.ok(fs.existsSync(pendingSpoolPath),
        '5xx is not success → keep the pending file');
    } finally { server.close(); }
  });

  it('POST connection error → keep the pending file', () => {
    setupCredentials('http://127.0.0.1:1');  // nothing listening
    seedPending([makeEvent()]);
    const r = runHelper();
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingSpoolPath));
  });

  it('bad line (unparseable JSON) is skipped; good lines continue', async () => {
    let captured = null;
    const server = await startFakeServer((req, res) => {
      captured = req;
      res.statusCode = 200; res.end('{"inserted":1}');
    });
    try {
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      // one bad, one good
      fs.writeFileSync(pendingSpoolPath,
        'this is not json\n' +
        JSON.stringify(makeEvent()) + '\n');
      const r = await runHelperAsync();
      assert.equal(r.status, 0);
      assert.ok(captured, 'POST should still fire');
      const body = JSON.parse(captured.body);
      assert.equal(body.events.length, 1, 'only the parseable line is sent');
      assert.equal(fs.existsSync(pendingSpoolPath), false);
    } finally { server.close(); }
  });

  it('all lines bad → do not POST; delete pending (unrecoverable data must not stay forever)', () => {
    setupCredentials('http://127.0.0.1:1');
    fs.writeFileSync(pendingSpoolPath, 'broken1\nbroken2\n');
    const r = runHelper();
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingSpoolPath), false,
      'all bad → delete immediately; avoid retrying an unrecoverable file at every SessionStart');
  });

  // v1.17.98 — flush helper must forward client_event_id verbatim to the server
  it('POST body must include the spooled client_event_id (flush must not eat it)', async () => {
    let captured = null;
    const server = await startFakeServer((req, res) => {
      captured = req;
      res.statusCode = 200; res.end('{"inserted":1}');
    });
    try {
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      const id = '99999999-8888-4777-8666-555555555555';
      const ev = { ...makeEvent(), client_event_id: id };
      seedPending([ev]);
      await runHelperAsync();
      assert.ok(captured);
      const body = JSON.parse(captured.body);
      assert.equal(body.events[0].client_event_id, id,
        'flush helper must forward client_event_id verbatim (dedup depends on it)');
    } finally { server.close(); }
  });

  it('Auth header + Content-Type align with the server expectations', async () => {
    let captured = null;
    const server = await startFakeServer((req, res) => {
      captured = req;
      res.statusCode = 200; res.end('{"inserted":1}');
    });
    try {
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      seedPending([makeEvent()]);
      await runHelperAsync();
      assert.match(captured.headers['authorization'], /^Bearer test-key$/);
      assert.match(captured.headers['content-type'], /application\/json/);
    } finally { server.close(); }
  });
});

// review-I2 fix: rename → POST → unlink; the read-then-delete race is narrowed.
describe('v1.17.97 review-I2 — rename-then-process race narrowed', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('POST success — no leftover processing file; pending is consumed', async () => {
    const server = await startFakeServer((req, res) => { res.statusCode = 200; res.end('{}'); });
    try {
      setupCredentials(`http://127.0.0.1:${server.address().port}`);
      seedPending([makeEvent()]);
      await runHelperAsync();
      assert.equal(fs.existsSync(pendingSpoolPath), false, 'pending should be consumed');
      // No .processing-* leftover.
      const orphans = fs.readdirSync(path.join(tmpHome, '.ownmind', 'logs'))
        .filter(f => f.includes('.processing-'));
      assert.equal(orphans.length, 0, 'processing file must not linger: ' + orphans.join(','));
    } finally { server.close(); }
  });

  it('POST failure — processing reverts to pending; no data loss', () => {
    setupCredentials('http://127.0.0.1:1');
    const ev = makeEvent('IR-037', 'must-survive');
    seedPending([ev]);
    runHelper();
    assert.ok(fs.existsSync(pendingSpoolPath), 'POST failure → pending should be restored');
    const lines = fs.readFileSync(pendingSpoolPath, 'utf8').trim().split('\n');
    const recovered = JSON.parse(lines[0]);
    assert.equal(recovered.details.message, 'must-survive', 'original event must be fully restored');
    // No .processing file leftover.
    const orphans = fs.readdirSync(path.join(tmpHome, '.ownmind', 'logs'))
      .filter(f => f.includes('.processing-'));
    assert.equal(orphans.length, 0);
  });

  it('no credentials — processing reverts to pending (user is still configuring OwnMind)', () => {
    // Do not call setupCredentials → readCredentialsInline returns empty strings.
    const ev = makeEvent('IR-037', 'wait-for-creds');
    seedPending([ev]);
    runHelper();
    assert.ok(fs.existsSync(pendingSpoolPath),
      'no credentials must not drop data; pending should be restored');
    const recovered = JSON.parse(fs.readFileSync(pendingSpoolPath, 'utf8').trim().split('\n')[0]);
    assert.equal(recovered.details.message, 'wait-for-creds');
  });

  it('PENDING_FILE missing — exit 0; do not attempt rename', () => {
    setupCredentials('http://127.0.0.1:1');
    // do not seed
    const r = runHelper();
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });
});

describe('v1.17.97 — strict contract: never pollute stdout / stderr', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('success / failure / no file / no credentials — stdout and stderr must be completely blank', async () => {
    const okServer = await startFakeServer((req, res) => { res.statusCode = 200; res.end('{}'); });
    try {
      const okUrl = `http://127.0.0.1:${okServer.address().port}`;
      const cases = [
        { name: 'no file', setup: () => setupCredentials(okUrl), env: {} },
        { name: 'no credentials', setup: () => seedPending([makeEvent()]), env: {} },
        { name: 'POST success', setup: () => { setupCredentials(okUrl); seedPending([makeEvent()]); }, env: {} },
        { name: 'POST connection failure', setup: () => { setupCredentials('http://127.0.0.1:1'); seedPending([makeEvent()]); }, env: {} },
      ];
      for (const c of cases) {
        cleanupTmpHome(); setupTmpHome();
        c.setup();
        const r = await runHelperAsync(c.env);
        assert.equal(r.stdout, '', `[${c.name}] stdout must be blank: ${JSON.stringify(r.stdout)}`);
        assert.equal(r.stderr, '', `[${c.name}] stderr must be blank: ${JSON.stringify(r.stderr)}`);
        assert.equal(r.status, 0);
      }
    } finally { okServer.close(); }
  });
});
