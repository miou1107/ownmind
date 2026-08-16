// My own reproduction, run by me, not by a subagent.
// Uses the REAL gate code from the repo and the REAL guard 820 copied out of Vin's own
// enforcement.json (read-only). HOME is a throwaway dir; the real ~/.ownmind is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'om-repro-'));

fs.rmSync(SCRATCH, { recursive: true, force: true });
const stateDir = path.join(SCRATCH, '.ownmind', 'state');
fs.mkdirSync(stateDir, { recursive: true });

// The real rule, straight out of the machine's own cache.
const real = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ownmind/cache/enforcement.json'), 'utf8'));
const guard = real.guards.find((g) => String(g.id) === '820');
if (!guard) throw new Error('guard 820 not found');

const { evaluateGate } = await import(path.join(REPO, 'hooks/lib/action-gate.js'));
const { ensureKey, ensureNonce } = await import(path.join(REPO, 'hooks/lib/gate-receipt.js'));

const sessionId = 'repro-session-1';
ensureKey(stateDir);
ensureNonce(stateDir, sessionId);

const CMD = 'git push origin v9.9.9';
const run = (label) => {
  const d = evaluateGate({ command: CMD, guards: [guard], stateDir, sessionId });
  console.log(`${label.padEnd(34)} -> ${String(d.action).toUpperCase().padEnd(6)} (${d.kind || '-'})`);
  return d;
};

console.log(`規矩 ${guard.id}：${guard.title}`);
console.log(`指令：${CMD}\n`);

console.log('--- 正常流程 ---');
run('1. AI 第一次執行');
run('2. AI 直接原封不動再試一次');
const asked = run('3. 再一次');

const askFile = path.join(stateDir, `gate-ask-${sessionId}-${guard.id}.json`);
console.log(`\n閘門在硬碟上留下的檔案：${askFile.replace(SCRATCH, '~')}`);
console.log(`內容：${fs.existsSync(askFile) ? fs.readFileSync(askFile, 'utf8') : '(還沒有)'}`);

console.log('\n--- 現在 AI 自己動手，沒有問任何人 ---');
const before = fs.existsSync(askFile) ? JSON.parse(fs.readFileSync(askFile, 'utf8')) : {};
fs.writeFileSync(askFile, JSON.stringify({ ...before, approved: true, approval_mode: 'verbal' }));
console.log(`AI 執行：echo '{"approved":true}' > ${path.basename(askFile)}`);
const after = run('4. AI 再執行同一個指令');

console.log('\n================ 結果 ================');
console.log(after.action === 'allow'
  ? '放行了。AI 沒有問任何人，自己把鎖打開。'
  : `還是擋住（${after.action}）。這條不成立。`);

// What the audit trail says happened.
const log = path.join(stateDir, 'gate-log.jsonl');
if (fs.existsSync(log)) {
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  console.log('\n事後翻稽核紀錄，最後一筆寫的是：');
  const last = JSON.parse(lines[lines.length - 1]);
  console.log(JSON.stringify({
    action: last.action, kind: last.kind, approval_mode: last.approval_mode, guard: last.guardId ?? last.guard_id,
  }));
}

// And the 6-digit code, if the guard had used code mode.
console.log('\n--- 另一條：那組六位數同意碼 ---');
const code = String(Math.floor(Math.random() * 900000) + 100000);
const hash = createHash('sha256').update(code).digest('hex');
console.log(`假設閘門產生的同意碼是 ${code}，硬碟上只存它的指紋（不存數字本身）`);
const t0 = Date.now();
let found = null;
for (let i = 100000; i <= 999999; i += 1) {
  if (createHash('sha256').update(String(i)).digest('hex') === hash) { found = String(i); break; }
}
console.log(`AI 從指紋反推回數字：${found}，花了 ${Date.now() - t0} 毫秒`);

fs.rmSync(SCRATCH, { recursive: true, force: true });
