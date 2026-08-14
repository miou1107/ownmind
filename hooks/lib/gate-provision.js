#!/usr/bin/env node
/**
 * Session provisioning for the action gate (P1, Task 7 — v1.26.172).
 *
 * Runs at every SessionStart, from both hook twins: the .js imports provisionGateSession
 * directly, the .sh pipes its stdin payload into this file the same way it runs its other
 * node helpers by path. The gate CLI keeps its own ensureKey/ensureNonce fallback for the
 * unprovisioned edge (action-gate-cli.js); what happens ONLY here is the per-session
 * pointer the approval CLI reads (gate-current-session), the planted-nonce defense, and
 * the 30-day sweep.
 *
 * Nothing here may delay or break session start: the CLI entry swallows every failure and
 * exits 0, and the .js caller wraps its call the same way. A machine this skipped on is
 * covered loudly by the gate CLI at first use.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureKey, ensureNonce } from './gate-receipt.js';

/** Exactly what ensureNonce writes: 16 random bytes as lowercase hex. Anything else was planted. */
const NONCE_CONTENT = /^[0-9a-f]{32}$/;
/** sessionId lands in state file names; same collapse rule as action-gate-cli.js. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;
/**
 * Per-session state only: receipts, asks, limits, nonces. `gate.key` (per-machine),
 * `gate-current-session` (always current by definition) and `gate-log.jsonl` (audit
 * record) never match this prefix and are never swept.
 */
const SWEEPABLE = /^gate-(receipt|ask|limit|nonce)-/;
const SWEEP_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function provisionGateSession(stateDir, sessionId) {
  ensureKey(stateDir);

  // A nonce whose content ensureNonce could not have written is a planted or corrupted
  // file; regenerating it beats signing every receipt this session with attacker-chosen
  // bytes. (rmSync on a symlink removes the link, never its target.)
  const noncePath = path.join(stateDir, `gate-nonce-${sessionId}`);
  try {
    if (!NONCE_CONTENT.test(fs.readFileSync(noncePath, 'utf8'))) {
      fs.rmSync(noncePath, { force: true });
    }
  } catch { /* absent is the normal first-start case; ensureNonce creates it below */ }
  ensureNonce(stateDir, sessionId);

  // The approval CLI resolves "this session" from this file, so it is rewritten on every
  // start — key and nonce already existing is no reason to skip it.
  fs.writeFileSync(path.join(stateDir, 'gate-current-session'), sessionId);

  // Sweep per-session state nobody will read again. 30 days is generous: a receipt, ask
  // or limit is dead the moment its session ends. lstat, not stat: a dangling symlink
  // still has an age and still deserves to go.
  const cutoff = Date.now() - SWEEP_AGE_MS;
  let names = [];
  try { names = fs.readdirSync(stateDir); } catch { return; }
  for (const name of names) {
    if (!SWEEPABLE.test(name)) continue;
    // Never sweep the nonce ensured two steps above: ensureNonce keeps an existing file's
    // mtime, so a reused session id (or a clock jump) would otherwise delete the exact
    // nonce this session is about to sign receipts with.
    if (name === `gate-nonce-${sessionId}`) continue;
    const p = path.join(stateDir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.mtimeMs < cutoff) {
        // A directory-symlink named like state would make rmSync (no recursive) throw EISDIR,
        // which the catch below swallows — leaving the clutter forever. unlink removes the link
        // itself, never its target; rmSync handles ordinary aged files.
        if (st.isSymbolicLink()) fs.unlinkSync(p);
        else fs.rmSync(p, { force: true });
      }
    } catch { /* a racing sweep already took it */ }
  }
}

/**
 * Real paths, not the strings: `import.meta.url` is symlink-resolved while `argv[1]` is
 * whatever the caller typed — same comparison conditional-sync-cli.js documents.
 */
function isMain() {
  try {
    return Boolean(process.argv[1])
      && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    // The SessionStart payload arrives whole on stdin; argv[2] keeps manual invocation
    // working, the same affordance the other gate CLIs grant.
    let sessionId = process.argv[2];
    if (!sessionId && !process.stdin.isTTY) {
      let payload = {};
      try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { payload = {}; }
      sessionId = payload?.session_id;
    }
    if (typeof sessionId === 'string' && sessionId) {
      // Unsafe ids collapse to 'unknown', matching action-gate-cli.js, so the nonce this
      // writes is the nonce the gate will look for. No id at all means no session to
      // provision — repointing gate-current-session then would only unhook a live one.
      if (!SAFE_SESSION_ID.test(sessionId)) sessionId = 'unknown';
      const stateDir = process.env.OWNMIND_GATE_STATE_DIR
        || path.join(os.homedir(), '.ownmind', 'state');
      provisionGateSession(stateDir, sessionId);
    }
  } catch { /* silent skip — the gate CLI provisions loudly at first use */ }
  process.exit(0);
}
