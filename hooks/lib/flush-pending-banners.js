#!/usr/bin/env node
/**
 * v1.17.71 — read every line of banner-pending.jsonl from stdin and print each block to stderr
 * (SessionStart hook stderr → user sees it).
 *
 * Why not per-line `spawn node` in a session-start.sh bash while-loop:
 *   In non-tty long-running scenarios, 50+ banners can pile up; per-line spawn would start 50 node
 *   processes and stall SessionStart for several seconds. Spawn once, stream stdin to end, batch-print instead.
 *
 * Usage:
 *   node hooks/lib/flush-pending-banners.js < banner-pending.jsonl
 *
 * Output: each record's block is written to stderr, separated by a blank line.
 * Always exit 0 — broken lines are skipped, never block SessionStart.
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
      // broken line — skip and continue with the next
    }
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
