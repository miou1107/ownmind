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

const { evaluateGate, approveAction } = await import(path.join(REPO, 'hooks/lib/action-gate.js'));
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

// And the 6-digit code. This used to assume the stored form and sweep it; it now reads what
// the gate really wrote, so the script cannot go on describing a format the product left.
console.log('\n--- 另一條：那組六位數同意碼 ---');
// Same rule, in code mode rather than verbal, and without the read gate in front of it —
// this section is about the code, not about the number of blocks it takes to reach one.
const codeGuard = { ...guard, id: 821, ask_mode: undefined, read_required: false };
const askedForCode = evaluateGate({
  command: 'git push origin v9.9.9', guards: [codeGuard], stateDir, sessionId,
});
const realCode = (askedForCode.userLine || '').match(/(\d{6})/)?.[1];
const stored = JSON.parse(fs.readFileSync(path.join(stateDir, `gate-ask-${sessionId}-821.json`), 'utf8'));
console.log(`閘門這次發的同意碼是 ${realCode}，硬碟上存的是：`);
console.log(`  ${JSON.stringify({ codeSalt: stored.codeSalt, codeHash: stored.codeHash })}`);

const plain = createHash('sha256').update(String(realCode)).digest('hex');
console.log(`\n舊做法（直接存 sha256）還在不在：${plain === stored.codeHash ? '在 ← 沒修好' : '不在'}`);

// Time one derivation the way the gate does it, and scale it to the whole 900,000-value space
// rather than actually sweeping it.
const t0 = process.hrtime.bigint();
approveAction(stateDir, sessionId, 821, '000000');
const perTry = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`試一個數字要 ${perTry.toFixed(1)} 毫秒 → 掃完 900,000 個要 ${(900000 * perTry / 3.6e6).toFixed(1)} 小時`);
console.log(`而且同意碼過 1 小時就作廢，掃不完。`);

fs.rmSync(SCRATCH, { recursive: true, force: true });
