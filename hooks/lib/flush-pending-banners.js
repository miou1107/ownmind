#!/usr/bin/env node
/**
 * v1.17.71 — 從 stdin 讀 banner-pending.jsonl 全部行、印 block 到 stderr
 *（SessionStart hook stderr → user 看得到）。
 *
 * 為什麼不在 session-start.sh bash while loop 裡 per-line spawn node：
 *   non-tty long-running 場景下可能積到 50+ banner，per-line spawn 會起 50 次
 *   node process、SessionStart 卡住數秒。改一次 spawn、stdin 串流讀完、批次印。
 *
 * 用法：
 *   node hooks/lib/flush-pending-banners.js < banner-pending.jsonl
 *
 * 輸出：每個 record 的 block 印到 stderr，record 之間空一行。
 * Exit 0 always — 解析失敗的 line 略過、不擋 SessionStart。
 */

'use strict';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { buf += chunk; });
process.stdin.on('end', () => {
  const lines = buf.split('\n').filter((l) => l.trim());
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.block === 'string' && rec.block.length > 0) {
        process.stderr.write(rec.block + '\n\n');
      }
    } catch {
      // 該行壞掉就略過、繼續下一行
    }
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
