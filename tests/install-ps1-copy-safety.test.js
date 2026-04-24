import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.10 — install.ps1 Copy-Item self-overwrite 防護（回報者 Adam）
 *
 * $OwnmindDir = $HOME\.ownmind 跟 dest $HOME\.ownmind\shared\ 是 git clone 後
 * 的同一位置 — Copy-Item 會嘗試「複製自己到自己」並吐 4 個紅字警告（雖無害但吵，
 * 且讓使用者誤以為安裝失敗）。install.sh 用 `-ef` 防護，install.ps1 沒做。
 */

describe('install.ps1 — Copy-Item self-overwrite guard', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('verification.js 複製前必須比對解析後路徑', () => {
    // 接受兩種常見寫法：GetFullPath 比較 OR 用 if($src -ne $dst) 加 Resolve-Path
    // 也接受直接移除該 Copy-Item（因為 git clone 本來就在那）
    const hasGuard =
      /GetFullPath|Resolve-Path.*\$VerificationSrc|\$VerificationSrc\s+-ne|SrcFull\s*=|\$srcResolved/.test(content);
    const copyLineRegex = /Copy-Item\s+\$VerificationSrc/;
    const hasCopy = copyLineRegex.test(content);
    assert.ok(
      !hasCopy || hasGuard,
      'install.ps1 仍對 $VerificationSrc 做無條件 Copy-Item → 會跟 $OwnmindDir 自我複製'
    );
  });

  it('git hook JS 檔複製前必須比對解析後路徑', () => {
    // 找 foreach 迴圈裡的 Copy-Item $src 前有沒有比對
    const loopBlock = content.match(
      /foreach\s*\(\s*\$jsFile[^)]+\)\s*\{[\s\S]*?Copy-Item[\s\S]*?\}/
    );
    if (!loopBlock) {
      // 找不到 loop 代表被重構掉了，OK
      return;
    }
    const block = loopBlock[0];
    const hasGuard =
      /GetFullPath|Resolve-Path|\$srcResolved|\$src\s+-ne|-ef/.test(block);
    assert.ok(
      hasGuard,
      'install.ps1 git hook copy loop 沒做 src/dest 同路徑檢查 → 4 次自我複製警告'
    );
  });
});
