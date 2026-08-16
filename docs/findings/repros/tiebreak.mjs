// Two red teams disagree. Settle both with output, not argument.
//
// 爭點 1：縮排／引號會不會讓金鑰通過？
//   紅隊一：漏得比回報的更嚴重。 紅隊二：抓得到，16 個裡擋 11 個，該把這條從清單移除。
// 爭點 2：那組六位數同意碼還能不能反推？
//   紅隊二：已經修好了，猜錯 5 次就燒掉。 但「反推」不需要猜錯任何一次。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { detectSecretLike } = await import(path.join(REPO, 'shared/secret-detect.js'));

console.log('=== 爭點 1：git hook 用的模式 (skip_keyword: true) ===\n');
// Real-shaped but fake, and assembled at runtime rather than written out.
//
// Not caution for its own sake: written as literals, GitHub's push protection rejects this
// file outright ("Stripe API Key", "Slack API Token"), so the script measuring how well
// OwnMind's scanner reads these shapes could not be committed. The prefixes are what both
// scanners key on, so splitting there is enough — and the value each test sees is identical.
const P = (...parts) => parts.join('');
const bodies = {
  'AWS secret key 形狀': P('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY'),
  'Stripe 形狀':        P('sk_', 'live_', '51H8xQpKj3nMvB7cRtYuIoPaSdFgHjKlZ'),
  'Google API 形狀':    P('AIza', 'SyD9x2KmQp7RtVwYzB4nE6cJhLfGdSaW1uT'),
  'Slack bot 形狀':     P('xoxb', '-2154871435-2154871435-', 'KmQp7RtVwYzB4nE6cJhLfGdS'),
  '64 字元隨機':        'aB3xK9mQ7pR2vT5wY8zC1dF4gH6jL0nPsV9uX2yB5eG8kM1qT4wZ7aD0fJ3hN6rU',
};
const shapes = [
  ['頂格', (v) => v],
  ['縮排四格', (v) => '    ' + v],
  ['KEY=value', (v) => 'SECRET=' + v],
  ['引號包起來', (v) => `key = "${v}"`],
  ['YAML', (v) => `  token: "${v}"`],
];
let blocked = 0; let total = 0;
const rows = [];
for (const [name, val] of Object.entries(bodies)) {
  const cells = shapes.map(([, f]) => {
    const hit = detectSecretLike(f(val), { skip_keyword: true }).detected;
    total += 1; if (hit) blocked += 1;
    return hit ? '擋' : '漏';
  });
  rows.push([name, ...cells]);
}
const head = ['', ...shapes.map(([n]) => n)];
const w = head.map((_, i) => Math.max(...[head, ...rows].map((r) => [...r[i]].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0))));
const fmt = (r) => r.map((c, i) => c + ' '.repeat(w[i] - [...c].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0))).join('  ');
console.log(fmt(head));
for (const r of rows) console.log(fmt(r));
console.log(`\n  ${total} 格裡擋住 ${blocked}、漏掉 ${total - blocked}`);

console.log('\n  同一個值，換個寫法結果就變的有幾組：');
for (const r of rows) {
  const set = new Set(r.slice(1));
  if (set.size > 1) console.log(`    ${r[0]}：${shapes.map(([n], i) => `${n}=${r[i + 1]}`).join('  ')}`);
}

console.log('\n\n=== 爭點 2：同意碼 ===\n');
// This used to grep action-gate.js for the sha256 line. A grep answers a question about the
// source, not about the product: reword the line and the script says "fixed". So it now
// issues a real ask and reads what actually landed on disk.
const { evaluateGate, approveAction } = await import(path.join(REPO, 'hooks/lib/action-gate.js'));
const { ensureKey, ensureNonce } = await import(path.join(REPO, 'hooks/lib/gate-receipt.js'));

const gate = fs.readFileSync(path.join(REPO, 'hooks/lib/action-gate.js'), 'utf8');
const miss = gate.match(/MAX_ASK_MISSES\s*=\s*(\d+)/);
console.log(`  猜錯上限：${miss ? miss[1] : '(找不到)'} 次`);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-tiebreak-'));
ensureKey(stateDir);
ensureNonce(stateDir, 'tiebreak');
const codeGuard = {
  id: 899, kind: 'action', title: '同意碼測試', triggers: ['deploy'],
  checks: [], read_required: false, ask_first: true,
  rule_text: 'x', rules_hash: createHash('sha256').update('x').digest('hex'),
};
const asked = evaluateGate({
  command: 'git push origin v9.9.9', guards: [codeGuard], stateDir, sessionId: 'tiebreak',
});
const issued = (asked.userLine || '').match(/(\d{6})/)?.[1];
const rec = JSON.parse(fs.readFileSync(path.join(stateDir, 'gate-ask-tiebreak-899.json'), 'utf8'));

const plainSha = createHash('sha256').update(String(issued)).digest('hex');
console.log(`  硬碟上存的就是 sha256(同意碼) 嗎：${plainSha === rec.codeHash ? '是 ← 一秒就反推得出來' : '不是'}`);

// Time one attempt and scale, rather than actually sweeping 900,000 of them.
const t = process.hrtime.bigint();
approveAction(stateDir, 'tiebreak', 899, '000000');
const per = Number(process.hrtime.bigint() - t) / 1e6;
console.log(`  試一個數字要 ${per.toFixed(1)} 毫秒 → 掃完 900,000 個要 ${(900000 * per / 3.6e6).toFixed(1)} 小時`);
console.log(`  真的同意碼還能不能用：${approveAction(stateDir, 'tiebreak', 899, issued) ? '能' : '不能'}`);
fs.rmSync(stateDir, { recursive: true, force: true });

console.log('\n\n=== 爭點 3：印章跟同意書是不是放在同一個抽屜 ===\n');
const keyPath = path.join(os.homedir(), '.ownmind/state/gate.key');
if (fs.existsSync(keyPath)) {
  const st = fs.statSync(keyPath);
  console.log(`  印章檔在：~/.ownmind/state/gate.key`);
  console.log(`  權限：${(st.mode & 0o777).toString(8)}   擁有者 uid：${st.uid}   我這個行程的 uid：${process.getuid()}`);
  let readable = false;
  try { fs.readFileSync(keyPath); readable = true; } catch { /* not readable */ }
  console.log(`  AI 讀不讀得到：${readable ? '讀得到' : '讀不到'}`);
} else {
  console.log('  這台機器上還沒有那個印章檔');
}
