import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * Windows PowerShell 5.1（仍然是 Windows 10 預設）讀 .ps1 檔時，無 BOM 會以系統
 * codepage 解譯。繁中 Windows 的 CP950 碰到 UTF-8 中文字節會錯誤對應，輕則亂碼，
 * 重則撞到 PowerShell 的保留字元（如反引號、引號）導致 parser 直接失敗。
 *
 * 任何含中文的 .ps1 都必須是 UTF-8 BOM（EF BB BF）。PowerShell 7+ 預設就吃
 * UTF-8 無 BOM，但 PowerShell 5.1 需要 BOM 來「強制」走 UTF-8 路徑。BOM 對 7+
 * 是 no-op 不會造成副作用，所以統一加 BOM 最安全。
 *
 * 本檔以 Buffer 讀 bytes 後檢查前三個字節，避免字串解析繞過問題。
 */

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function collectPs1Files(dir) {
  const out = [];
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) queue.push(full);
      else if (ent.isFile() && ent.name.endsWith('.ps1')) out.push(full);
    }
  }
  return out;
}

function hasChinese(buf) {
  // Rough UTF-8 Chinese check: bytes E4-E9 as lead, followed by 80-BF x2
  for (let i = 0; i < buf.length - 2; i++) {
    const b = buf[i];
    if (b >= 0xe4 && b <= 0xe9 && (buf[i + 1] & 0xc0) === 0x80 && (buf[i + 2] & 0xc0) === 0x80) {
      return true;
    }
  }
  return false;
}

describe('PS1 UTF-8 BOM 強制規範', () => {
  const ps1Files = collectPs1Files(repoRoot);

  it('repo 內至少找得到 .ps1 檔', () => {
    assert.ok(ps1Files.length > 0, `no .ps1 found in ${repoRoot}`);
  });

  for (const file of ps1Files) {
    const rel = path.relative(repoRoot, file);
    const buf = fs.readFileSync(file);

    it(`${rel} — 起始必須是 UTF-8 BOM`, () => {
      if (!hasChinese(buf)) {
        // 只含英文不強求，但一旦將來加入中文就會失敗
        return;
      }
      const actualHead = buf.slice(0, 3);
      assert.ok(
        actualHead.equals(UTF8_BOM),
        `${rel} 含中文但沒 UTF-8 BOM\n` +
        `前 3 byte: ${[...actualHead].map(b => b.toString(16).padStart(2, '0')).join(' ')}`
      );
    });
  }
});
