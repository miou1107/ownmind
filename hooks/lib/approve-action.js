#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approveAction } from './action-gate.js';

const stateDir = process.env.OWNMIND_GATE_STATE_DIR
  || path.join(os.homedir(), '.ownmind', 'state');
const [, , guardId, code] = process.argv;
let sessionId = '';
try { sessionId = fs.readFileSync(path.join(stateDir, 'gate-current-session'), 'utf8').trim(); } catch { /* falls through to REJECTED */ }
if (sessionId && guardId && code && approveAction(stateDir, sessionId, Number(guardId), code)) {
  process.stdout.write('APPROVED\n');
  process.exit(0);
}
process.stdout.write('REJECTED\n');
process.exit(1);
