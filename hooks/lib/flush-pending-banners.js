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
 *
 * v1.26.133: the parsing rule moved to lib/pending-banners.js, shared with the Node
 * SessionStart hook. That hook used to spawn this file detached with stderr ignored, which
 * discarded every block it wrote while the spool was truncated anyway; it now prints the
 * blocks in-process. This CLI stays for the shell hook, which cannot parse jsonl itself.
 *
 * v1.26.171 removed both SessionStart flushes, so NO HOOK RUNS THIS ANY MORE. Notices are
 * delivered on the turn they happen via systemMessage, and banner-pending.jsonl became an
 * append-only audit record. This file is now a hand tool: run it against the spool when you
 * want to read what was shown. It is not a delivery path, and nothing should make it one
 * again — a notice that needs delivering needs a queue of its own, the way the background
 * update's outcome got logs/update-pending.jsonl in v1.26.173.
 */

'use strict';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { buf += chunk; });
process.stdin.on('end', async () => {
  try {
    const { parsePendingBanners } = await import('./pending-banners.js');
    for (const block of parsePendingBanners(buf).blocks) {
      process.stderr.write(block + '\n\n');
    }
  } catch {
    // The import is the only thing left that can fail here. A non-zero exit would surface as
    // a SessionStart failure over a display concern, so this stays a silent no-op.
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
