#!/usr/bin/env node
/**
 * v1.17.97 — flush ~/.ownmind/logs/reply-lint-pending.jsonl to the server.
 *
 * Invoked by ownmind-session-start.sh after the banner-pending flush.
 *
 * Flow:
 *   1. No file → exit 0 immediately.
 *   2. File exists but every line is broken → delete the file and exit 0
 *      (avoid retrying content that can never be sent on every SessionStart).
 *   3. File exists with parseable lines → one POST /api/activity/batch:
 *      - HTTP 2xx → delete the file (events have landed in the server DB).
 *      - Anything else → keep the file for the next SessionStart to retry.
 *
 * Vin spec #3: never write to stderr / stdout (SessionStart channel is visible to the user).
 * Always exit 0; never block SessionStart.
 *
 * Environment variables (test):
 *   OWNMIND_FLUSH_API_URL — override the API URL (test with a fake server).
 */

// Safety net: swallow every error, never leak to stderr.
process.on('uncaughtException', () => { try { process.exit(0); } catch { /* ignore */ } });
process.on('unhandledRejection', () => { try { process.exit(0); } catch { /* ignore */ } });

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PENDING_FILE = path.join(HOME, '.ownmind', 'logs', 'reply-lint-pending.jsonl');
const API_URL_OVERRIDE = process.env.OWNMIND_FLUSH_API_URL || '';
const POST_TIMEOUT_MS = 3000;  // SessionStart is more relaxed than Stop — 3s is acceptable

main().catch(() => { try { process.exit(0); } catch { /* ignore */ } });

async function main() {
  if (!fs.existsSync(PENDING_FILE)) { process.exit(0); return; }

  // v1.17.97 review I2 fix — rename → process → unlink, avoiding the read-then-delete race:
  //   The original flow was read → POST → unlink. During the POST window (hundreds of ms ~ 3s),
  //   if the hook wrote a new event, the post-POST unlink would also delete that new event —
  //   permanent data loss. The fix is to rename the in-flight chunk out of the way, so new events
  //   land in a brand-new empty pending file.
  //
  //   This also solves Concern #2 (concurrent SessionStart): two flushes running at once —
  //   the first rename succeeds, the second sees ENOENT and exits 0 cleanly.
  //
  //   The .processing-<ts>-<pid> suffix prevents the unlikely case where two flushes on different
  //   filesystems briefly observe different PENDING lifecycles, and one's processing file overwrites
  //   the other's.
  const processingFile = `${PENDING_FILE}.processing-${Date.now()}-${process.pid}`;
  try {
    fs.renameSync(PENDING_FILE, processingFile);
  } catch {
    // ENOENT — another flush already grabbed it, or the file was deleted. Not an error.
    process.exit(0); return;
  }

  let raw;
  try { raw = fs.readFileSync(processingFile, 'utf8'); }
  catch { restoreOrCleanup(processingFile); process.exit(0); return; }
  if (!raw.trim()) {
    safeUnlinkPath(processingFile);
    process.exit(0); return;
  }

  // Parse each line; skip broken lines.
  const lines = raw.split('\n').filter(l => l.trim());
  const events = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      // Must have at least ts + event, otherwise the server batch handler skips the row.
      if (ev && ev.ts && ev.event) events.push(ev);
    } catch { /* skip broken line */ }
  }

  if (events.length === 0) {
    // Every line is broken → just delete the processing file. Don't retry content that will
    // never be sent on every SessionStart.
    safeUnlinkPath(processingFile);
    process.exit(0); return;
  }

  // Read credentials — inline rather than importing shared/helpers.js, because this helper is
  // copied by install.sh to ~/.claude/hooks/lib/, and a cross-directory relative import of shared/
  // wouldn't resolve (shared/ lives at ~/.ownmind/shared/).
  let { apiKey, apiUrl } = readCredentialsInline();
  if (API_URL_OVERRIDE) apiUrl = API_URL_OVERRIDE;
  if (!apiKey || !apiUrl) {
    // No credentials → restore the processing file back to pending and retry next time
    // (the user might still be configuring OwnMind).
    restoreOrCleanup(processingFile);
    process.exit(0); return;
  }

  const ok = await postEvents(events, apiKey, apiUrl);
  if (ok) {
    // POST 2xx → safe to delete the processing file (any events the hook writes during this
    // window land in a fresh PENDING_FILE, completely isolated from processing).
    safeUnlinkPath(processingFile);
  } else {
    // POST failed → restore the processing file back to pending and retry next SessionStart.
    restoreOrCleanup(processingFile);
  }
  process.exit(0);
}

function safeUnlinkPath(p) {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

/**
 * Restore the processing file back to the pending file for next retry.
 * If PENDING_FILE already exists (the hook wrote new events in the meantime), append the
 * processing content to it and then delete the processing file.
 * On total failure, leave .processing in place — a leftover file is better than dropping data.
 */
function restoreOrCleanup(processingFile) {
  try {
    if (!fs.existsSync(processingFile)) return;
    if (!fs.existsSync(PENDING_FILE)) {
      try { fs.renameSync(processingFile, PENDING_FILE); return; } catch { /* fall through */ }
    }
    // PENDING was already rewritten → append the processing content to it.
    const data = fs.readFileSync(processingFile);
    fs.appendFileSync(PENDING_FILE, data);
    safeUnlinkPath(processingFile);
  } catch { /* on failure, leave the .processing file for manual handling */ }
}

/**
 * Read OwnMind credentials from ~/.claude/settings.json.
 * Mirrors the behavior of shared/helpers.js readCredentials, but inline — no import (avoids
 * cross-directory resolution).
 * Tolerates UTF-8 BOM (PS 5.1 Set-Content -Encoding UTF8 emits BOM on Windows).
 */
function readCredentialsInline() {
  try {
    const settingsPath = path.join(HOME, '.claude', 'settings.json');
    let raw = fs.readFileSync(settingsPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const s = JSON.parse(raw);
    const env = s.mcpServers?.ownmind?.env || {};
    return { apiKey: env.OWNMIND_API_KEY || '', apiUrl: env.OWNMIND_API_URL || '' };
  } catch {
    return { apiKey: '', apiUrl: '' };
  }
}

function postEvents(events, apiKey, apiUrl) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/api/activity/batch', apiUrl); }
    catch { resolve(false); return; }

    const body = JSON.stringify({ events });
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok === true); } };

    let req;
    try {
      req = mod.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: POST_TIMEOUT_MS,
      }, (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        res.on('data', () => { /* drain */ });
        res.on('end', () => done(ok));
        res.on('error', () => done(false));
      });
    } catch { resolve(false); return; }

    req.on('error', () => done(false));
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } done(false); });
    try { req.write(body); req.end(); }
    catch { done(false); }
  });
}
