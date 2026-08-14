#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approveAction, approveActionVerbal } from './action-gate.js';

const stateDir = process.env.OWNMIND_GATE_STATE_DIR
  || path.join(os.homedir(), '.ownmind', 'state');

let sessionId = '';
try { sessionId = fs.readFileSync(path.join(stateDir, 'gate-current-session'), 'utf8').trim(); } catch { /* falls through to REJECTED */ }

const args = process.argv.slice(2);
let approved = false;
if (args[0] === '--verbal') {
  // Verbal go-ahead (Amendment 3): no code, marks a verbal-mode ask approved. Refuses a
  // code-mode ask inside approveActionVerbal, so this flag cannot downgrade a code guard.
  const guardId = args[1];
  approved = Boolean(sessionId && guardId && approveActionVerbal(stateDir, sessionId, Number(guardId)));
} else {
  const [guardId, code] = args;
  approved = Boolean(sessionId && guardId && code && approveAction(stateDir, sessionId, Number(guardId), code));
}

if (approved) {
  process.stdout.write('APPROVED\n');
  process.exit(0);
}
process.stdout.write('REJECTED\n');
process.exit(1);
