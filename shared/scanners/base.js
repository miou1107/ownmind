/**
 * shared/scanners/base.js
 *
 * Scanner orchestrator — every IDE adapter shares the same pipeline
 * (spec S4 D11):
 *   1. Read offsets file (missing = start from 0; no first-run branch).
 *   2. adapter.readSince(state) → { events, offsetPatch, cumulativePatch, heartbeat }
 *   3. POST /api/usage/events in batches (500 per batch).
 *   4. Any batch failing → throw, don't advance offsets; the server's UNIQUE
 *      constraint deduplicates and replay is safe.
 *   5. All batches succeed → atomic rename writes the new offsets + cumulative.
 *
 * Failure mode: events landed on the server but the offset didn't advance →
 * next run replays, repeats are blocked by UNIQUE, session_cumulative
 * re-accumulates. Invariant: "the server holds ≥ every event before the
 * local offset."
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { OK, NO_NEW_ACTIVITY, NO_INSTALL, UNREADABLE, ACCOUNT_CHANGED } from './reasons.js';

export const DEFAULT_CACHE_PATH = path.join(
  os.homedir(), '.ownmind', 'cache', 'scanner-offsets.json'
);
export const BATCH_SIZE = 500;
export const POST_TIMEOUT_MS = 30_000;

/**
 * Which account this machine's cursor belongs to.
 *
 * v1.26.69. `scanner-offsets.json` used to be keyed by tool and file and nothing else,
 * so a machine that changed account handed the new account the previous one's
 * "already reported" state. Observed on a Windows box on 2026-08-05: the cursor said
 * antigravity was reported up to 2026-07-23, the account configured there had no such
 * row, and the account that did have one could not have produced it from its own
 * machine.
 *
 * A truncated digest, never the key. The raw key already sits in
 * `~/.claude/settings.json` on the same machine, so this discloses nothing new; it is
 * hashed so that a bookkeeping file never becomes a second place a credential lives.
 *
 * @param {{apiUrl: string, apiKey: string}} creds
 * @returns {string}
 */
export function accountFingerprint({ apiUrl = '', apiKey = '' } = {}) {
  // Normalised the same way postBatch normalises it before posting. Two configs that
  // differ only by a trailing slash are the same account talking to the same server,
  // and calling that an account change would drop every day cursor on the machine.
  const server = String(apiUrl).replace(/\/+$/, '');
  return createHash('sha256')
    .update(`${server}\0${apiKey}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The cursor to scan with, given who is configured now.
 *
 * Three cases, and only one of them is an account change:
 *
 *   - the fingerprint matches            → carry on
 *   - there is no fingerprint at all     → a cursor written before v1.26.69, or a first
 *                                          install. Stamp it and carry on; calling this
 *                                          a change would reset every existing install
 *                                          on upgrade, and a first install should still
 *                                          collect this machine's history.
 *   - the fingerprint differs            → discard. The new account starts fresh.
 *
 * On a change, the two kinds of entry are treated differently, because they claim
 * different things:
 *
 *   - `last_session_date` claims a particular day was already reported. That day
 *     belongs to whoever worked it, so the claim is dropped and the new account gets
 *     to report the day it finds.
 *   - `byte_offset` is a position marker meaning "this file has been read this far".
 *     It is kept, and keeping it *is* the policy: the new account starts from now.
 *     Dropping it would replay the machine's whole history into the new account, which
 *     is the misattribution this exists to prevent.
 *
 * @param {object} state - parsed offsets file
 * @param {string} fingerprint
 * @returns {{state: object, changed: boolean}}
 */
export function cursorForAccount(state, fingerprint) {
  const prev = state?.account ?? null;
  if (!prev || prev === fingerprint) {
    return { state: { ...state, account: fingerprint }, changed: false };
  }

  const kept = { account: fingerprint };
  for (const [key, value] of Object.entries(state)) {
    if (key === 'account') continue;
    if (!value || typeof value !== 'object' || !('last_session_date' in value)) {
      kept[key] = value;
      continue;
    }
    // Drop the day claim, not the entry. Today no single entry carries both a day claim
    // and a read position, but dropping a whole object because of one field would
    // silently take the read position with it the moment one does — and a lost read
    // position replays the machine's history into the new account, which is the exact
    // misattribution this is here to prevent.
    const { last_session_date: _dropped, ...rest } = value;
    if (Object.keys(rest).length > 0) kept[key] = rest;
  }
  return { state: kept, changed: true };
}

/**
 * Read the offsets file; returns {} when missing or corrupted.
 */
export async function readOffsets(cachePath = DEFAULT_CACHE_PATH) {
  try {
    const s = await fs.readFile(cachePath, 'utf8');
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Atomic write: write to tmp, then rename.
 * On crash mid-write the original file is intact; rename is POSIX-atomic.
 */
export async function writeOffsetsAtomic(cachePath, offsets) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(offsets, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, cachePath);
}

export function chunk(arr, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * POST /api/usage/events — throws on failure.
 * fetchFn is injectable for tests.
 */
export async function postBatch({ apiUrl, apiKey, fetchFn = fetch, timeoutMs = POST_TIMEOUT_MS }, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${apiUrl.replace(/\/+$/, '')}/api/usage/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST /api/usage/events ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * v1.26.142 — a thrown message is written by somebody else and goes to a server.
 *
 * The messages this carries are Node's, and Node's file errors quote the path in full:
 * `ENOENT: no such file or directory, open '/Users/alice/Projects/acme-merger/...'`. The
 * collector's business is when a tool was used, never what it was used on, and a folder
 * name can be the most sensitive thing on the machine. The home directory is replaced with
 * `~`, which keeps every part of the path that helps diagnose and drops the two that
 * identify — the account name and anything above it.
 *
 * The match stops at a path boundary. `/home/vin` is a prefix of `/home/vincent`, and a
 * plain substring replace would turn a colleague's path into `~cent/...` — which is not a
 * leak, but is a diagnostic message that reads as corrupted, and the person reading it has
 * no way to tell which it is.
 *
 * Both slash directions are tried: the path inside a Node error and the one in USERPROFILE
 * do not always agree about separators, and matching only one of them leaks the other.
 *
 * @param {string} text
 * @param {string} homeDir
 * @returns {string}
 */
export function redactHome(text, homeDir = os.homedir()) {
  let out = String(text ?? '');
  const candidates = [homeDir, homeDir?.replace(/\\/g, '/'), homeDir?.replace(/\//g, '\\')]
    .filter((h) => typeof h === 'string' && h.length > 1);
  for (const home of new Set(candidates)) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}(?=[/\\\\]|$|['"\\s])`, 'g'), '~');
  }
  return out;
}

/**
 * v1.26.142 — the check-in for a tool that never got as far as a scan.
 *
 * `runScan` sends a heartbeat on every outcome it knows about, including all the empty
 * ones. The outcomes it does not know about are the ones where the adapter itself failed:
 * a throw, a hang, or a tool dropped by `OWNMIND_SKIP_TOOLS` before the loop. Those used
 * to produce a line in a local log file and no row anywhere, which reads from the server
 * as a tool the member has never installed.
 *
 * Errors are swallowed on purpose. This runs inside the scanner's own failure handler; a
 * diagnostic that can end the run is worse than the defect it reports.
 *
 * @param {object} deps
 * @param {string} deps.apiUrl
 * @param {string} deps.apiKey
 * @param {Function} [deps.fetchFn]
 * @param {object} [deps.logger]
 * @param {object} beat
 * @param {string} beat.tool
 * @param {string} beat.reason      - one of the collector-failure codes in reasons.js
 * @param {string} [beat.scannerVersion]
 * @param {string} [beat.machine]
 * @param {string} [beat.error]     - the thrown message; the server truncates it
 * @returns {Promise<boolean>} whether the report reached the server
 */
export async function reportCollectorState(
  { apiUrl, apiKey, fetchFn = fetch, logger = null, homeDir = os.homedir() },
  { tool, reason, scannerVersion, machine, error }
) {
  if (!apiUrl || !apiKey || !tool || !reason) return false;
  const heartbeat = { tool, reason, scanner_version: scannerVersion, machine };
  // Sent only when there is one. An `error: undefined` survives JSON.stringify as an
  // absent key, but an empty string does not, and the server would store the absence of
  // a message as a message.
  if (error) heartbeat.error = redactHome(String(error), homeDir);
  try {
    await postBatch({ apiUrl, apiKey, fetchFn }, { events: [], heartbeat });
    return true;
  } catch (err) {
    logger?.warn?.(`[scanner] could not report ${tool} ${reason}: ${err?.message || err}`);
    return false;
  }
}

/**
 * Full scan → post → commit-offset pipeline for a single adapter.
 *
 * @param {object} deps
 * @param {object} deps.adapter - must have tool + readSince(state)
 * @param {string} deps.apiUrl
 * @param {string} deps.apiKey
 * @param {string} [deps.cachePath]
 * @param {Function} [deps.fetchFn]
 * @param {object} [deps.logger]
 */
export async function runScan(deps) {
  const {
    adapter, apiUrl, apiKey,
    cachePath = DEFAULT_CACHE_PATH,
    fetchFn = fetch,
    logger = console,
    accountChanged = false
  } = deps;

  const state = await readOffsets(cachePath);
  const {
    events, offsetPatch, cumulativePatch, heartbeat,
    sessions = [],       // Tier 2 adapters supply this; Tier 1 defaults to empty
    scanned = null,      // how many source files were visible; null = adapter does not report it
    skipped = [],        // error codes of files that could not be opened this run
    reason = null        // v1.26.69; Tier 1 adapters do not supply one, see deriveReason
  } = await adapter.readSince(state);

  // v1.26.69 — an account change invalidates every tool's answer this run, so it wins
  // over whatever the adapter concluded from a cursor that has just been reset.
  const effectiveReason = accountChanged
    ? ACCOUNT_CHANGED
    : (reason ?? deriveReason({ events, sessions, scanned, skipped }));
  const beat = heartbeat ? { ...heartbeat, reason: effectiveReason } : heartbeat;

  // Empty scan: still send heartbeat + any sessions.
  if (events.length === 0) {
    if (beat || sessions.length > 0) {
      const payload = { events: [], heartbeat: beat };
      if (sessions.length > 0) payload.sessions = sessions;
      await postBatch({ apiUrl, apiKey, fetchFn }, payload);
    }
    // Still need to atomic-write offsets (Tier 2 session_date may advance).
    if (Object.keys(offsetPatch).length > 0) {
      const newState = mergeState(state, adapter.tool, offsetPatch, cumulativePatch);
      await writeOffsetsAtomic(cachePath, newState);
    }
    return {
      tool: adapter.tool, sent: 0, batches: 0, accepted: 0, duplicated: 0,
      sessions: sessions.length, files: scanned, skipped, reason: effectiveReason
    };
  }

  const batches = chunk(events, BATCH_SIZE);
  let accepted = 0;
  let duplicated = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const isLast = i === batches.length - 1;
    const payload = { events: batches[i] };
    if (isLast && beat) payload.heartbeat = beat;
    if (isLast && sessions.length > 0) payload.sessions = sessions;

    const resp = await postBatch({ apiUrl, apiKey, fetchFn }, payload);
    accepted += Number(resp.accepted ?? 0);
    duplicated += Number(resp.duplicated ?? 0);
    logger.info?.(`[scanner] ${adapter.tool} batch ${i + 1}/${batches.length} ` +
      `accepted=${resp.accepted} dup=${resp.duplicated} rejected=${resp.rejected?.length || 0}`);
  }

  // All batches succeeded → merge and atomic write.
  const newState = mergeState(state, adapter.tool, offsetPatch, cumulativePatch);
  await writeOffsetsAtomic(cachePath, newState);

  return {
    tool: adapter.tool,
    sent: events.length,
    batches: batches.length,
    accepted, duplicated,
    sessions: sessions.length,
    files: scanned,
    skipped,
    reason: effectiveReason
  };
}

/**
 * Why a Tier 1 adapter produced nothing.
 *
 * v1.26.69. Tier 2 adapters answer this themselves, because only they know whether the
 * sqlite3 CLI was the problem. Tier 1 adapters do not, but they already report
 * `scanned` and `skipped` (v1.26.65), which is enough to separate the three cases that
 * matter: nothing to read, something unreadable, and nothing new.
 *
 * @returns {string} one of REASONS
 */
export function deriveReason({ events = [], sessions = [], scanned = null, skipped = [] }) {
  if (events.length > 0 || sessions.length > 0) return OK;
  if (skipped.length > 0) return UNREADABLE;
  if (scanned === 0) return NO_INSTALL;
  return NO_NEW_ACTIVITY;
}

/**
 * Merge offsetPatch + session_cumulative into state. Pure function.
 */
export function mergeState(state, tool, offsetPatch = {}, cumulativePatch = {}) {
  const next = { ...state };
  for (const [k, v] of Object.entries(offsetPatch)) next[k] = v;
  const existing = state.session_cumulative?.[tool] || {};
  next.session_cumulative = {
    ...(state.session_cumulative || {}),
    [tool]: { ...existing, ...cumulativePatch }
  };
  return next;
}
