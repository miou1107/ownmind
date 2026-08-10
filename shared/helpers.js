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
/**
 * v1.26.98 — the name of the project the caller is working in, or null.
 *
 * The team page has a "most common project" column that was blank for most people. The
 * reason was not that the value is unknown: `mcp/index.js` has computed it since v1.17.37
 * and puts it on the session log the AI writes. It just never travelled with anything else.
 *
 * When the AI does not call `ownmind_log_session` — which, measured on 2026-08-07, is most
 * sessions, including 76 of one heavy user's 95 — the server rebuilds the session from the
 * activity log, and no activity event carried a project. So the column was blank for four
 * people entirely and four fifths of the fifth, and the fix is to send it, not to recover it.
 *
 * **Only the last path segment is returned, never the full path.** A directory name is
 * work context; the path to it says where someone keeps their files, which is not something
 * this product needs in order to group work by project.
 *
 * Returns null at the filesystem root and at the home directory, where the basename would
 * describe the machine's owner rather than any project.
 *
 * @param {object} [env] — defaults to process.env
 * @returns {string|null}
 */
export function resolveProjectName(env = process.env) {
  try {
    const dir = env.CLAUDE_PROJECT_DIR || env.OWNMIND_PROJECT_DIR || process.cwd();
    if (!dir || dir === '/' || dir === os.homedir()) return null;
    const name = path.basename(dir);
    return name && name !== '.' && name !== '/' ? name : null;
  } catch {
    return null;
  }
}

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
 * @returns {'commit' | 'deploy' | 'delete' | 'install' | null}
 */
export function detectCommandTrigger(command) {
  if (!command) return null;
  if (/\bgit\s+(commit|reset|rebase|merge)\b/i.test(command)) return 'commit';
  if (/\bgit\s+tag\b/i.test(command)) return 'commit';
  if (/\bgit\s+push\b/i.test(command)) return 'deploy';
  if (/\b(docker\s+compose\s+(up|build|push)|kubectl\s+apply|npm\s+run\s+deploy)\b/i.test(command)) return 'deploy';
  if (/\b(rm\s+-rf|rmdir|Remove-Item|drop\s+table|DELETE\s+FROM)\b/i.test(command)) return 'delete';
  // v1.26.132 — last, so no command that already had a trigger changes classification.
  //
  // Install and credential work had no trigger at all, which meant the two rules written
  // for it were unreachable: one says "the install script reporting success does not
  // count, go and read the config file", the other says a silenced failure in a setup
  // script is a defect. Both were tagged `trigger:install` by their author and nothing
  // ever asked for that tag.
  //
  // Matched narrowly on purpose. `npm install` and `pip install` are excluded: a reminder
  // in front of every dependency install is one the user learns to scroll past, and
  // neither rule is about fetching packages. A bare `token` is excluded too — it matches
  // ordinary prose like "token count" — where API_KEY and credential do not.
  if (/(^|[\s/\\])[\w.~-]*(install|setup|bootstrap|update)\.(sh|ps1|bat|cmd)\b/i.test(command)) return 'install';
  // Not `\bAPI[_-]?KEY\b`: an underscore is a word character, so `\b` does not exist between
  // the `D` and the `A` of OWNMIND_API_KEY — the prefixed form every real env var uses, and
  // the one this rule is about, was the one shape that regex could not see. Guard on a
  // non-letter instead, which still refuses `therapy_keys` and friends.
  if (/(^|[^A-Za-z])API[_-]?KEYS?\b/i.test(command)) return 'install';
  if (/\bcredentials?\b/i.test(command)) return 'install';
  return null;
}

/**
 * Tool names that change a file on disk, and the trigger each produces.
 *
 * v1.26.92: the hook was registered for `Bash` only, so a rule could fire only while a
 * shell command ran. Editing a file is not a shell command, so no rule tagged
 * `trigger:edit` had ever fired — on one real account that was 56 rules, the most-used tag
 * on it, and 63 once the untagged rules that match everything are counted.
 */
export const TOOL_TRIGGERS = {
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
};

/**
 * Detect the trigger type from the tool being called, for tools that carry no command.
 * The command path keeps priority: callers consult `detectCommandTrigger` first, so a
 * payload with both is resolved by the command exactly as before this change.
 * @param {string} toolName — PreToolUse `tool_name`
 * @returns {'edit' | null}
 */
export function detectToolTrigger(toolName) {
  if (typeof toolName !== 'string') return null;
  // hasOwn, not a plain lookup: 'constructor', 'toString', '__proto__' and friends resolve
  // up the prototype chain to functions, which are truthy. Those five names would clear the
  // caller's "did we get a trigger" guard and reach the reminder as a trigger named after
  // native code.
  return Object.hasOwn(TOOL_TRIGGERS, toolName) ? TOOL_TRIGGERS[toolName] : null;
}

/**
 * Tag values each trigger accepts, beyond the trigger name itself.
 *
 * v1.26.91: `detectCommandTrigger` only ever answers commit/deploy/delete, and the hooks
 * used to match a rule only when one of its tags was literally `trigger:<that word>`.
 * But nothing tells the user those three words are the whole vocabulary — `ownmind_save`
 * accepts any tag — so rules get filed under the words people actually think in
 * (`trigger:回滾`, `trigger:cleanup`, `trigger:部署`) and then never fire. The rule is
 * stored, the hook runs, the filter drops it, and the exit is silent: nothing anywhere
 * says why. On a real account with 3 iron rules, all 3 were unreachable.
 *
 * This only widens which stored rules a trigger can match. It does NOT widen when the
 * hooks run — that is still `detectCommandTrigger`, unchanged.
 *
 * KEEP IN SYNC with the copy inlined in hooks/ownmind-iron-rule-check.sh. That hook builds
 * its filter inside `node -e`, and importing this module from there would mean handing node
 * a path — the exact move that produced two silent Windows failures (install.sh
 * CLAUDE_SETTINGS in v1.26.88, /dev/stdin in v1.26.90). A duplicated literal cannot ENOENT.
 */
export const TRIGGER_TAG_ALIASES = {
  // v1.26.92: `edit` covers Edit / Write / MultiEdit / NotebookEdit, so a rule tagged
  // `trigger:write` has to match it. Without this the Write tool would fire the edit
  // trigger and then drop every rule the author filed under "write" — 23 of them on the
  // account this was measured against, the second most-used tag there.
  edit: ['edit', 'write', '編輯', '寫檔', '改檔', 'modify'],
  commit: ['commit', 'git', '提交', 'checkin'],
  deploy: ['deploy', '部署', 'release', '發布', '上線', 'publish', 'upgrade', '升級'],
  delete: ['delete', '刪除', 'cleanup', '清理', 'rollback', '回滾', '還原', 'restore'],
  // v1.26.132: the vocabulary an author actually reaches for when filing a rule about
  // installing or rotating a key. `setup`, `config` and `api_key` are here because that is
  // how the rules on the account this was measured against were already tagged — the tags
  // were never wrong, no trigger asked for them. Deliberately narrower than the others:
  // `script` and `debug` are not accepted, or every rule about shell scripting would list
  // itself in front of an unrelated key rotation.
  install: ['install', 'setup', 'config', '安裝', '設定', 'api_key', 'credential_rotation', '換金鑰', '切換帳號'],
};

/**
 * Is this rule relevant to the operation about to run?
 * An untagged rule is relevant to everything — that is the pre-existing contract.
 * @param {{tags?: string[]}} rule
 * @param {string} trigger — canonical trigger, or the 'command' fallback
 * @returns {boolean}
 */
export function ruleMatchesTrigger(rule, trigger) {
  if (!rule || !Array.isArray(rule.tags) || rule.tags.length === 0) return true;
  const accepted = new Set(
    (TRIGGER_TAG_ALIASES[trigger] || [trigger]).map(w => `trigger:${w}`)
  );
  // v1.19.20: command-based iron rules are relevant to every trigger.
  accepted.add('trigger:command');
  return rule.tags.some(t => accepted.has(String(t).toLowerCase()));
}

/**
 * Detect the trigger type from the free-form context passed to MCP
 * report_compliance.
 * @param {string} context — free-form text
 * @returns {'commit' | 'deploy' | 'delete' | 'install' | null}
 */
export function detectTriggerFromContext(context) {
  if (!context) return null;
  if (/\bcommit\b/i.test(context)) return 'commit';
  if (/\bdeploy\b|部署/i.test(context)) return 'deploy';
  if (/\bdelete\b|刪除/i.test(context)) return 'delete';
  // v1.26.132 — the same gap as the command gate, one door further in. This is the entry
  // MCP report_compliance uses, so leaving `install` out here would recreate the exact
  // mismatch this release exists to close: a vocabulary the rules use and no caller asks
  // for. Nothing is enforced by adding it — it selects rules carrying an explicit
  // `verification.trigger` of `install`, of which there are none today.
  if (/\binstall\b|安裝|換金鑰|切換帳號/i.test(context)) return 'install';
  if (/(^|[^A-Za-z])API[_-]?KEYS?\b/i.test(context)) return 'install';
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
