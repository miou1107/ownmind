#!/usr/bin/env node
/**
 * Action-gate CLI — the PreToolUse gate as a standalone stdin→stdout program.
 *
 * The registered hook on macOS/Linux is a bash script; it cannot import evaluateGate, so
 * it pipes its stdin payload here the same way it already runs its other node helpers by
 * path. The .js twin imports the same modules directly — both wirings answer alike.
 *
 * The whole contract is on stdout:
 *   - block   → one JSON deny envelope, exit 0
 *   - allow   → nothing at all (silence is the common case and must stay free)
 *   - degraded allow → a systemMessage saying receipts were unavailable
 *   - anything thrown in the gate path → fail-open-LOUD: the command runs, but the user
 *     is told it was NOT gated. A gate that switches itself off silently is the exact
 *     failure this product exists to prevent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOT_GATED_LINE =
  "[OwnMind] 🔴 OwnMind could not check this command, and the AI ran it anyway. If it matters, look at what it did.";
const DEGRADED_LINE =
  "[OwnMind] 🟡 OwnMind could not confirm whether the AI had read your rules this time, but it is still blocking the AI's commands against them.";

/** sessionId lands in state file names; anything unsafe collapses to 'unknown'. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Looks up a gate notice through t(), but the two lines above are what tell the user the
 * gate itself just broke — that lookup must never depend on the same i18n module it would be
 * reporting as broken. A dynamic import here (not a static one at module scope) means a
 * broken hooks/lib/i18n.js only ever degrades this ONE notice's text to the plain English
 * literal; it cannot take down this whole CLI before main() even runs.
 */
async function gateNotice(key, fallback) {
  try {
    const { t } = await import('./i18n.js');
    return t(key);
  } catch {
    return fallback;
  }
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch { /* no payload, no gate */ }

  // The harness sends { tool_input: { command } }; a bare { command } keeps manual
  // invocation working, the same affordance both hook twins already grant.
  const rawCommand = payload?.tool_input?.command ?? payload?.command;
  const sessionId = typeof payload?.session_id === 'string' && SAFE_SESSION_ID.test(payload.session_id)
    ? payload.session_id
    : 'unknown';
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) process.exit(0);

  try {
    const { evaluateGate } = await import('./action-gate.js');
    const { readEnforcementBundle } = await import('./enforcement-cache.js');
    const { ensureKey, ensureNonce } = await import('./gate-receipt.js');

    const bundle = readEnforcementBundle();
    const stateDir = path.join(os.homedir(), '.ownmind', 'state');

    // First contact with the state dir provisions it. Idempotent, and a failure here is
    // survivable on purpose: evaluateGate degrades to stateless checks and says so, which
    // is a better answer than turning the whole gate off over an unwritable directory.
    try {
      ensureKey(stateDir);
      ensureNonce(stateDir, sessionId);
    } catch { /* evaluateGate reports the degradation itself */ }

    const d = evaluateGate({ command: rawCommand, guards: bundle.guards, stateDir, sessionId });

    if (d.action === 'block') {
      // DENY ENVELOPE — both field pairs, or the block loses its words. Inlined rather
      // than imported for the same reason gateNotice() is: a block must not be reachable
      // only through a file that could be missing. tests/hook-deny-envelope.test.js holds
      // the rationale and keeps all four emitters agreeing.
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: d.reason,
        systemMessage: d.userLine,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: d.reason,
        },
      }));
    } else if (d.userLine) {
      // An allow that still has something to say: the gate let this through on the strength
      // of a spoken go-ahead, and the person said to have spoken it should hear about it.
      process.stdout.write(JSON.stringify({ systemMessage: d.userLine }));
    } else if (d.degraded) {
      process.stdout.write(JSON.stringify({ systemMessage: await gateNotice('gate.degraded', DEGRADED_LINE) }));
    }
    // plain allow: print nothing — the everyday path costs one process and zero words
  } catch {
    process.stdout.write(JSON.stringify({ systemMessage: await gateNotice('gate.failopen', NOT_GATED_LINE) }));
  }
  process.exit(0);
}

main().catch(() => {
  // main() already catches the gate path; this guards the guard.
  try { process.stdout.write(JSON.stringify({ systemMessage: NOT_GATED_LINE })); } catch { /* stdout gone */ }
  process.exit(0);
});
