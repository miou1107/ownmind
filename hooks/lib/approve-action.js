#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = process.env.OWNMIND_GATE_STATE_DIR
  || path.join(os.homedir(), '.ownmind', 'state');

let sessionId = '';
try { sessionId = fs.readFileSync(path.join(stateDir, 'gate-current-session'), 'utf8').trim(); } catch { /* falls through to REJECTED */ }

const args = process.argv.slice(2);
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
