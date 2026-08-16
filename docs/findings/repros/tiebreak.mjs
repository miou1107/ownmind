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
const gate = fs.readFileSync(path.join(REPO, 'hooks/lib/action-gate.js'), 'utf8');
const miss = gate.match(/MAX_ASK_MISSES\s*=\s*(\d+)/);
console.log(`  猜錯上限：${miss ? miss[1] : '(找不到)'} 次`);
const writesHash = /codeHash:\s*createHash\('sha256'\)\.update\(code\)/.test(gate);
console.log(`  同意碼的指紋有沒有寫進硬碟上的檔案：${writesHash ? '有' : '沒有'}`);
if (writesHash) {
  const code = String(Math.floor(Math.random() * 900000) + 100000);
  const h = createHash('sha256').update(code).digest('hex');
  const t = Date.now();
  let got = null;
  for (let i = 100000; i <= 999999; i += 1) if (createHash('sha256').update(String(i)).digest('hex') === h) { got = String(i); break; }
  console.log(`  從指紋反推回數字：${got === code ? '成功' : '失敗'}，${Date.now() - t} 毫秒`);
  console.log('  → 反推出來之後只送一次，而且是對的。「猜錯 5 次燒掉」擋不到這條路。');
}

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
