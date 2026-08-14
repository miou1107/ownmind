#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = process.env.OWNMIND_GATE_STATE_DIR
  || path.join(os.homedir(), '.ownmind', 'state');

/**
 * v1.26.174 — `--session <id>`, because "the current session" is not a thing one file can name.
 *
 * `gate-current-session` is a single pointer that every SessionStart overwrites. With two
 * Claude sessions open — the normal state on this product author's own machine — the gate
 * writes its ask under the session that was blocked, and this CLI then looked up whichever
 * session started most recently. Measured 2026-08-14 on the first real release this gate ever
 * stopped: the ask sat at `gate-ask-2fc0ce05…-820.json`, the pointer said `54e53a3e…`, and a
 * genuine user "go" printed REJECTED with nothing on screen explaining why. The gate had no
 * way to be approved at all while a second session was running.
 *
 * So the gate now names the session in the command it tells the AI to run, and this reads it.
 * The pointer stays as the fallback for a bare invocation.
 *
 * This grants nothing: `approveAction`/`approveActionVerbal` still require an ask file the
 * gate itself wrote for that exact (session, guard), still refuse an already-approved record,
 * and still collapse an unsafe id to 'unknown' before it reaches a path. Anything able to pass
 * this flag could equally have written the pointer file — it is a lookup, never a permission.
 */
const args = process.argv.slice(2);
const flagAt = args.indexOf('--session');
const namedSession = flagAt !== -1 ? args[flagAt + 1] : undefined;
if (flagAt !== -1) args.splice(flagAt, namedSession === undefined ? 1 : 2);

let sessionId = namedSession || '';
if (!sessionId) {
  try { sessionId = fs.readFileSync(path.join(stateDir, 'gate-current-session'), 'utf8').trim(); } catch { /* falls through to REJECTED */ }
}

let approved = false;
try {
  // Dynamic, not static: action-gate.js (Task 3, gate-message-i18n) now statically imports
  // i18n.js. A broken i18n.js must fail THIS CLI closed — printing REJECTED, same as any
  // other bad input below — never crash with a raw stack trace and empty stdout, which is
  // what a static top-level import of action-gate.js would do here.
  const { approveAction, approveActionVerbal } = await import('./action-gate.js');
  if (args[0] === '--verbal') {
    // Verbal go-ahead (Amendment 3): no code, marks a verbal-mode ask approved. Refuses a
    // code-mode ask inside approveActionVerbal, so this flag cannot downgrade a code guard.
    const guardId = args[1];
    approved = Boolean(sessionId && guardId && approveActionVerbal(stateDir, sessionId, Number(guardId)));
  } else {
    const [guardId, code] = args;
    approved = Boolean(sessionId && guardId && code && approveAction(stateDir, sessionId, Number(guardId), code));
  }
} catch { /* an import failure anywhere in the chain fails closed, same as any other bad input */ }

if (approved) {
  process.stdout.write('APPROVED\n');
  process.exit(0);
}
process.stdout.write('REJECTED\n');
process.exit(1);
