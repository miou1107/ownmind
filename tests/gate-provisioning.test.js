/**
 * Session provisioning for the action gate (P1, Task 7).
 *
 * At every session start, both SessionStart hook twins must leave the gate's state dir
 * ready before the first command is ever gated: the signing key exists (mode 0400), this
 * session's nonce exists and is the 32-hex string ensureNonce writes (a planted file with
 * any other content is regenerated), gate-current-session names this session (the approval
 * CLI resolves "this session" from that file, so it is rewritten every start), and
 * per-session state older than 30 days is swept — while gate.key, gate-current-session and
 * the gate-log audit record survive.
 *
 * These spawn the real hooks against a staged HOME, exactly as a user's machine runs them.
 * The API creds are unroutable on purpose: provisioning is local and must happen even when
 * the server cannot be reached.
 */

import { strict as assert } from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir } from './helpers/temp-dir.js';
import { provisionGateSession } from '../hooks/lib/gate-provision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const JS_HOOK = path.join(repoRoot, 'hooks', 'ownmind-session-start.js');
const SH_HOOK = path.join(repoRoot, 'hooks', 'ownmind-session-start.sh');

const HEX_NONCE = /^[0-9a-f]{32}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function hookEnv(home) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OWNMIND_API_URL: 'http://127.0.0.1:1',
    OWNMIND_API_KEY: '00000000-0000-4000-8000-000000000000',
  };
  // Provisioning must land in the staged HOME, not wherever the developer's shell points.
  delete env.OWNMIND_GATE_STATE_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

function payload(sessionId) {
  return JSON.stringify({ session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' });
}

function runJsHook(home, sessionId) {
  return spawnSync(process.execPath, [JS_HOOK], {
    encoding: 'utf8',
    input: payload(sessionId),
    env: hookEnv(home),
    timeout: 30000,
  });
}

function runShHook(home, sessionId) {
  return spawnSync('bash', [SH_HOOK], {
    encoding: 'utf8',
    input: payload(sessionId),
    env: hookEnv(home),
    timeout: 30000,
  });
}

const stateDirOf = (home) => path.join(home, '.ownmind', 'state');

/** Age a state file to `days` days before now, the way a dead session's files really look. */
function ageFile(p, days) {
  const then = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(p, then, then);
}

test('a session start provisions key, nonce and current-session', () => {
  const home = tempDir('gate-prov-');
  const r = runJsHook(home, 'prov-1');
  assert.equal(r.status, 0, `hook must exit 0 (stderr: ${r.stderr})`);

  const stateDir = stateDirOf(home);
  const keyPath = path.join(stateDir, 'gate.key');
  assert.ok(fs.existsSync(keyPath), 'gate.key must exist after session start');
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o400, 'gate.key must be mode 0400');

  const nonce = fs.readFileSync(path.join(stateDir, 'gate-nonce-prov-1'), 'utf8');
  assert.match(nonce, HEX_NONCE, 'the session nonce is 16 random bytes as lowercase hex');

  assert.equal(fs.readFileSync(path.join(stateDir, 'gate-current-session'), 'utf8').trim(),
    'prov-1', 'the approval CLI reads this file to learn which session is current');
});

test('current-session is rewritten each session even when key and nonce already exist', () => {
  const home = tempDir('gate-prov-');
  runJsHook(home, 'prov-1');
  const stateDir = stateDirOf(home);
  const keyBytes = fs.readFileSync(path.join(stateDir, 'gate.key'), 'utf8');
  const firstNonce = fs.readFileSync(path.join(stateDir, 'gate-nonce-prov-1'), 'utf8');

  runJsHook(home, 'prov-2');

  assert.equal(fs.readFileSync(path.join(stateDir, 'gate-current-session'), 'utf8').trim(),
    'prov-2', 'a new session must repoint current-session even though key/nonce exist');
  assert.equal(fs.readFileSync(path.join(stateDir, 'gate.key'), 'utf8'), keyBytes,
    'the key is per-machine and must survive re-provisioning');
  assert.equal(fs.readFileSync(path.join(stateDir, 'gate-nonce-prov-1'), 'utf8'), firstNonce,
    'the first session nonce is untouched');
  assert.match(fs.readFileSync(path.join(stateDir, 'gate-nonce-prov-2'), 'utf8'), HEX_NONCE);
});

test('a planted or corrupt nonce is regenerated at provisioning time', () => {
  const home = tempDir('gate-prov-');
  const stateDir = stateDirOf(home);
  fs.mkdirSync(stateDir, { recursive: true });
  // Content ensureNonce could never have written: signing receipts with it would mean
  // signing with attacker-chosen bytes.
  const planted = 'ATTACKER-CHOSEN-VALUE-0123456789';
  fs.writeFileSync(path.join(stateDir, 'gate-nonce-prov-1'), planted);

  runJsHook(home, 'prov-1');

  const nonce = fs.readFileSync(path.join(stateDir, 'gate-nonce-prov-1'), 'utf8');
  assert.match(nonce, HEX_NONCE, 'the corrupt nonce must be replaced with a well-formed one');
  assert.notEqual(nonce, planted);
});

test('per-session state older than 30 days is swept; key, current-session and audit log survive', () => {
  const home = tempDir('gate-prov-');
  const stateDir = stateDirOf(home);
  fs.mkdirSync(stateDir, { recursive: true });

  // A machine that has been running the gate for a while: a long-dead session's files,
  // a recent session's receipt, the key, and the audit log.
  const dead = [
    'gate-receipt-dead-918.json',
    'gate-ask-dead-918.json',
    'gate-limit-dead-918.json',
    'gate-nonce-dead',
  ];
  for (const name of dead) {
    fs.writeFileSync(path.join(stateDir, name), '{}');
    ageFile(path.join(stateDir, name), 31);
  }
  fs.writeFileSync(path.join(stateDir, 'gate-receipt-fresh-1.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'gate.key'), 'k'.repeat(64), { mode: 0o400 });
  ageFile(path.join(stateDir, 'gate.key'), 31);
  fs.writeFileSync(path.join(stateDir, 'gate-log.jsonl'), '{"e":"allow"}\n');
  ageFile(path.join(stateDir, 'gate-log.jsonl'), 31);

  runJsHook(home, 'prov-1');

  for (const name of dead) {
    assert.ok(!fs.existsSync(path.join(stateDir, name)), `${name} is 31 days old and must be swept`);
  }
  assert.ok(fs.existsSync(path.join(stateDir, 'gate-receipt-fresh-1.json')),
    'a fresh receipt must survive the sweep');
  assert.ok(fs.existsSync(path.join(stateDir, 'gate.key')),
    'the key is per-machine, never per-session — age must not sweep it');
  assert.ok(fs.existsSync(path.join(stateDir, 'gate-log.jsonl')),
    'the audit log is a durable record, not per-session state');
  assert.equal(fs.readFileSync(path.join(stateDir, 'gate-current-session'), 'utf8').trim(), 'prov-1');
});

test('the sweep never takes the current session\'s own nonce, however old', () => {
  // ensureNonce keeps an existing file's mtime, so a reused session id (or a clock jump)
  // would otherwise have the sweep delete the exact nonce this session signs with.
  const home = tempDir('gate-prov-');
  const stateDir = stateDirOf(home);
  fs.mkdirSync(stateDir, { recursive: true });
  const noncePath = path.join(stateDir, 'gate-nonce-prov-1');
  const oldNonce = 'ab'.repeat(16);
  fs.writeFileSync(noncePath, oldNonce);
  ageFile(noncePath, 31);

  runJsHook(home, 'prov-1');

  assert.equal(fs.readFileSync(noncePath, 'utf8'), oldNonce,
    'the current session keeps the nonce it was ensured, even an aged one');
});

test('an aged directory-symlink in the state dir is swept, not left as clutter', () => {
  // A dir-symlink named like sweepable state: rmSync without recursive throws EISDIR on it,
  // the sweep swallows the throw, and the clutter stays forever. The sweep must lstat and
  // unlink the link (never following it into its target directory).
  const home = tempDir('gate-prov-dirlink-');
  const stateDir = stateDirOf(home);
  fs.mkdirSync(stateDir, { recursive: true });

  const realDir = path.join(home, 'somewhere');
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, 'keep.txt'), 'keep');
  const linkPath = path.join(stateDir, 'gate-receipt-deadlink-1.json');
  fs.symlinkSync(realDir, linkPath);
  // Age the symlink itself; lutimes acts on the link, not on the directory it points at.
  const then = new Date(Date.now() - 31 * DAY_MS);
  fs.lutimesSync(linkPath, then, then);

  provisionGateSession(stateDir, 'prov-1');

  assert.equal(fs.existsSync(linkPath), false, 'an aged dir-symlink must be swept');
  assert.ok(fs.existsSync(realDir), 'sweeping the link must never touch its target directory');
  assert.equal(fs.readFileSync(path.join(realDir, 'keep.txt'), 'utf8'), 'keep',
    'the target directory contents are untouched');
});

test('the .sh twin provisions identically', { skip: process.platform === 'win32' }, () => {
  const home = tempDir('gate-prov-sh-');
  const r = runShHook(home, 'prov-sh-1');
  assert.equal(r.status, 0, `hook must exit 0 (stderr: ${r.stderr})`);

  const stateDir = stateDirOf(home);
  const keyPath = path.join(stateDir, 'gate.key');
  assert.ok(fs.existsSync(keyPath), 'gate.key must exist after a .sh session start');
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o400);
  assert.match(fs.readFileSync(path.join(stateDir, 'gate-nonce-prov-sh-1'), 'utf8'), HEX_NONCE);
  assert.equal(fs.readFileSync(path.join(stateDir, 'gate-current-session'), 'utf8').trim(), 'prov-sh-1');
});
