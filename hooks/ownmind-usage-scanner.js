#!/usr/bin/env node
/**
 * hooks/ownmind-usage-scanner.js
 *
 * Main entry: invokes each tool adapter in turn through the shared `runScan()` flow, sending
 * events + heartbeat.
 * Plan P4: currently only the claude-code adapter is wired; P5 adds codex and opencode.
 *
 * After installation this is invoked every 30 minutes by launchd / systemd / Task Scheduler (P6).
 */

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { readCredentials, getClientVersion } from '../shared/helpers.js';
import { runScan } from '../shared/scanners/base.js';
import { createClaudeCodeAdapter } from '../shared/scanners/claude-code.js';
import { createCodexAdapter } from '../shared/scanners/codex.js';
import { createOpenCodeAdapter } from '../shared/scanners/opencode.js';
import { createCursorAdapter } from '../shared/scanners/cursor.js';
import { createAntigravityAdapter } from '../shared/scanners/antigravity.js';

const HOME = os.homedir();
const LOG_PATH = path.join(HOME, '.ownmind', 'logs', 'scanner.log');
const LOCK_PATH = path.join(HOME, '.ownmind', 'cache', 'scanner.lock');

async function log(line) {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

const STALE_LOCK_MS = 6 * 60 * 60 * 1000;  // 6 hours

/**
 * Self-locking: prevents the scheduled scanner from colliding with a manual run.
 *
 * Create the lock file with O_EXCL. When it already exists:
 *   1. Read the PID inside; if that process is gone (`kill -0` returns ESRCH) → treat as stale, take over.
 *   2. Or if the lock file's mtime is older than 6 hours → treat as stale, take over.
 *   3. Otherwise assume another instance is alive and return false.
 *
 * This avoids an orphaned lock from SIGKILL / OOM / laptop sleep blocking all future scans forever.
 */
async function acquireLock() {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(LOCK_PATH, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    // Lock already exists — check whether it's stale.
    let stale = false;
    try {
      const raw = await fs.readFile(LOCK_PATH, 'utf8');
      const otherPid = parseInt(raw.trim(), 10);
      if (Number.isFinite(otherPid) && otherPid > 0 && otherPid !== process.pid) {
        try {
          process.kill(otherPid, 0);  // returns if it exists; throws ESRCH if it does not
        } catch (e) {
          if (e.code === 'ESRCH') stale = true;
        }
      }
      if (!stale) {
        const st = await fs.stat(LOCK_PATH);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) stale = true;
      }
    } catch {
      // Can't read it → treat as stale and rebuild.
      stale = true;
    }

    if (!stale) return false;

    // Delete the stale lock then retry once (still wx to avoid a race).
    try { await fs.unlink(LOCK_PATH); } catch { /* another process just took over — also fine */ }
  }
}

async function releaseLock() {
  try { await fs.unlink(LOCK_PATH); } catch { /* best-effort */ }
}

async function main() {
  const locked = await acquireLock();
  if (!locked) {
    await log('[scanner] another instance is running (lock exists), skipping');
    return;
  }

  try {
    const { apiKey, apiUrl } = readCredentials();
    if (!apiKey || !apiUrl) {
      // v1.26.65 — this used to `return`, so the process exited 0 and every layer
      // above reported success: run-hidden.vbs, Task Scheduler's LastTaskResult,
      // and the diagnostic that tells people to read it.
      //
      // The scanner cannot inherit an environment the way the MCP does; it has to
      // find ~/.claude/settings.json itself. So this branch is exactly where the
      // two components diverge, and it is the one place a broken scanner still
      // gets to say so. Throwing makes the direct-run handler log and exit 1.
      throw new Error('credentials not found in ~/.claude/settings.json '
        + '(mcpServers.ownmind.env); the usage scanner cannot report anything');
    }

    const scannerVersion = getClientVersion() || 'unknown';
    const machine = os.hostname();

    // OWNMIND_SKIP_TOOLS=tool1,tool2 skips the named adapters (for backfill / debug).
    const skip = new Set(
      (process.env.OWNMIND_SKIP_TOOLS || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
    );
    if (skip.size > 0) {
      await log(`[scanner] OWNMIND_SKIP_TOOLS active: skipping ${[...skip].join(',')}`);
    }
    const adapterSpecs = [
      // Tier 1 — raw token events
      { tool: 'claude-code', factory: createClaudeCodeAdapter },
      { tool: 'codex',       factory: createCodexAdapter },
      { tool: 'opencode',    factory: createOpenCodeAdapter },
      // Tier 2 — session_count only
      { tool: 'cursor',      factory: createCursorAdapter },
      { tool: 'antigravity', factory: createAntigravityAdapter }
    ];
    const adapters = adapterSpecs
      .filter((spec) => !skip.has(spec.tool))
      .map((spec) => spec.factory({ scannerVersion, machine }));

    for (const adapter of adapters) {
      try {
        const result = await runScan({ adapter, apiUrl, apiKey });
        // v1.26.65: `files=` says how many source files were visible. Without it
        // `sent=0` cannot be read: nothing new and cannot see anything look the
        // same, and on 2026-08-05 that cost an hour of chasing the wrong cause.
        const seen = result.files == null ? '' : ` files=${result.files}`;
        // Skipped files used to end the whole tool's scan. They no longer do, which
        // means they would now pass unnoticed unless the count says otherwise.
        const missed = result.skipped?.length
          ? ` skipped=${result.skipped.length}(${[...new Set(result.skipped)].join(',')})`
          : '';
        // v1.26.66: `sent` counts token events, and a Tier 2 adapter has none by
        // construction, so cursor and antigravity printed all zeros whether they had
        // just recorded a day or recorded nothing at all. This is the line a human
        // reads to decide whether collection is working, and for two of the five tools
        // it could not answer the question. That is how a dead antigravity adapter went
        // eleven weeks unnoticed.
        const days = ` sessions=${result.sessions ?? 0}`;
        await log(`[scanner] ${adapter.tool} ` +
          `sent=${result.sent} accepted=${result.accepted} duplicated=${result.duplicated} ` +
          `batches=${result.batches}${days}${seen}${missed}`);
      } catch (err) {
        await log(`[scanner] ${adapter.tool} failed: ${err.message}`);
      }
    }
  } finally {
    await releaseLock();
  }
}

export { main, acquireLock, releaseLock };

// Only run main when invoked directly; importing this module does not trigger it (test-friendly).
// fileURLToPath handles Windows backslash and URL-encoding differences — a plain `import.meta.url`
// string comparison fails on Windows.
const isDirectRun = process.argv[1] && (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
})();
if (isDirectRun) {
  main().catch(async (err) => {
    await log(`[scanner] fatal: ${err.message}`);
    try { await releaseLock(); } catch { /* ignore */ }
    process.exit(1);
  });
}
