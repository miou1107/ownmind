/**
 * OwnMind Shared Helpers.
 *
 * Pure-function module, zero external deps. Shared by hooks and MCP.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

// ============================================================
// Constants
// ============================================================

export const SOURCE_PATTERNS = [/^src\//, /^mcp\//, /^hooks\//, /^shared\//];

const HOME = os.homedir();
const DEFAULT_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

// ============================================================
// Functions
// ============================================================

/**
 * Strip a leading UTF-8 BOM (﻿) from a string.
 * v1.17.12: the Windows installer (PS 5.1) writes JSON with
 * `Set-Content -Encoding UTF8`, which prepends a BOM that crashes
 * Node's JSON.parse.
 */
function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/**
 * Safely read a JSON file; returns null on failure. Tolerates UTF-8 BOM.
 */
export function readJsonSafe(filePath) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Filter to source files matching the configured patterns.
 */
export function getChangedSourceFiles(files, patterns = SOURCE_PATTERNS) {
  return files.filter(f =>
    patterns.some(p => p.test(f))
  );
}

/**
 * Read the MCP client version.
 */
export function getClientVersion() {
  try {
    // Single source of truth: the root package.json version field.
    // v1.17.12 same stripBom guard against BOM emitted by Windows editors.
    const pkg = JSON.parse(stripBom(fs.readFileSync(path.join(HOME, '.ownmind', 'package.json'), 'utf8')));
    return pkg.version || '?';
  } catch {
    return '?';
  }
}

/**
 * Which AI tool is hosting this MCP process.
 *
 * v1.26.67 — this rule used to be written out three times, and one copy dropped
 * `OWNMIND_TOOL`: the variable `install.sh` actually writes into the Cursor MCP config.
 * Nothing in this repository has ever set `OWNMIND_CLIENT_TOOL`, so the copy that read
 * only that variable always resolved to `claude-code`. It was the copy used for the
 * heartbeat, the `x-ownmind-tool` header and the session log.
 *
 * `collector_heartbeat` is UNIQUE (user_id, tool), so a Cursor heartbeat labelled
 * `claude-code` lands on top of the row the claude-code scanner maintains and replaces
 * its machine, version and os. Two tools on one machine become one row that reports
 * whichever wrote last.
 *
 * An empty value counts as unset: an empty `tool` would create a row no report groups
 * by and no human recognises.
 *
 * @param {object} [env] — defaults to process.env
 * @returns {string}
 */
export function resolveClientTool(env = process.env) {
  return env.OWNMIND_TOOL || env.OWNMIND_CLIENT_TOOL || 'claude-code';
}

/**
 * Read OwnMind credentials.
 *
 * v1.26.82 — this used to read `~/.claude/settings.json` and nothing else. On Adam's
 * machine the key is not there: Claude Code keeps MCP config in `~/.claude.json` now, and
 * his key arrives as an `OWNMIND_API_KEY` environment variable. The MCP is handed that
 * environment and kept working, while the usage scanner and both SessionStart hooks — all
 * of which call this function and give up when it returns empty — went silent for weeks
 * and nothing said so.
 *
 * Delegates to `resolve-credentials.cjs` so the installer's self-check and these hooks
 * cannot drift apart on the answer. Explicitly passing `settingsPath` keeps the old
 * single-file behaviour, which is what the existing tests pin.
 *
 * @param {string} [settingsPath] — when given, only this file is read (legacy behaviour)
 */
export function readCredentials(settingsPath) {
  if (settingsPath === undefined) {
    const { resolveCredentials } = createRequire(import.meta.url)('../scripts/install-helpers/resolve-credentials.cjs');
    const r = resolveCredentials();
    return { apiKey: r.apiKey, apiUrl: r.apiUrl, source: r.source, background_safe: r.background_safe };
  }
  try {
    // v1.17.12 — stripBom guards against BOM-prefixed JSON written by
    // Windows PS 5.1 `Set-Content -Encoding UTF8`. Without stripBom,
    // Bob/Alice's scanner throws here, gets caught into empty creds,
    // exits early, and Admin sees "not installed" + zero usage.
    const s = JSON.parse(stripBom(fs.readFileSync(settingsPath, 'utf8')));
    const env = s.mcpServers?.ownmind?.env || {};
    return { apiKey: env.OWNMIND_API_KEY || '', apiUrl: env.OWNMIND_API_URL || '' };
  } catch {
    return { apiKey: '', apiUrl: '' };
  }
}

/**
 * Detect the trigger type from a PreToolUse hook command.
 * @param {string} command — bash command
 * @returns {'commit' | 'deploy' | 'delete' | null}
 */
export function detectCommandTrigger(command) {
  if (!command) return null;
  if (/\bgit\s+(commit|reset|rebase|merge)\b/i.test(command)) return 'commit';
  if (/\bgit\s+tag\b/i.test(command)) return 'commit';
  if (/\bgit\s+push\b/i.test(command)) return 'deploy';
  if (/\b(docker\s+compose\s+(up|build|push)|kubectl\s+apply|npm\s+run\s+deploy)\b/i.test(command)) return 'deploy';
  if (/\b(rm\s+-rf|rmdir|Remove-Item|drop\s+table|DELETE\s+FROM)\b/i.test(command)) return 'delete';
  return null;
}

/**
 * Detect the trigger type from the free-form context passed to MCP
 * report_compliance.
 * @param {string} context — free-form text
 * @returns {'commit' | 'deploy' | 'delete' | null}
 */
export function detectTriggerFromContext(context) {
  if (!context) return null;
  if (/\bcommit\b/i.test(context)) return 'commit';
  if (/\bdeploy\b|部署/i.test(context)) return 'deploy';
  if (/\bdelete\b|刪除/i.test(context)) return 'delete';
  return null;
}

/**
 * Sanitize an error message: replace the home directory with `~`, redact
 * sk-/Bearer-style tokens, truncate length.
 * Used on console.error stderr to avoid leaking local paths or API keys.
 * @param {unknown} msg
 * @param {number} [maxLen=80]
 * @returns {string}
 */
export function sanitizeErrorMessage(msg, maxLen = 80) {
  if (msg === null || msg === undefined) return '';
  let s = typeof msg === 'string' ? msg : String(msg);
  const home = HOME;
  if (home && home.length > 1) {
    s = s.split(home).join('~');
  }
  s = s.replace(/sk-[A-Za-z0-9_-]{6,}/g, '<redacted>');
  s = s.replace(/Bearer\s+[A-Za-z0-9_.-]+/g, '<redacted>');
  if (s.length > maxLen) s = s.slice(0, maxLen) + '...';
  return s;
}

/**
 * Push an item onto an array while enforcing a max length, dropping the
 * oldest when full (ring buffer). Used for in-memory arrays that grow
 * over long sessions.
 * @template T
 * @param {T[]} arr
 * @param {T} item
 * @param {number} maxSize
 * @returns {T[]} the same array reference (mutated in place)
 */
export function pushBounded(arr, item, maxSize) {
  arr.push(item);
  while (arr.length > maxSize) arr.shift();
  return arr;
}

/**
 * Sliding time-window dedupe: returns true when the key has been seen
 * within ttlMs and should be skipped. Also GCs expired entries. The first
 * occurrence records its timestamp; subsequent calls do not slide the
 * timestamp (the original is reused, so entries eventually expire).
 * @param {Map<string, number>} map - records key → first_seen_ts
 * @param {string} key
 * @param {number} ttlMs
 * @param {number} [now=Date.now()] - injected time for testability
 * @returns {boolean} whether this entry should be skipped
 */
export function shouldSkipDuplicate(map, key, ttlMs, now = Date.now()) {
  for (const [k, ts] of map) {
    if (now - ts >= ttlMs) map.delete(k);
  }
  const last = map.get(key);
  if (last !== undefined && now - last < ttlMs) return true;
  map.set(key, now);
  return false;
}
