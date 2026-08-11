#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Node 18+ has global fetch — node-fetch is not required (dependency removed in v1.17.99).
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import { exec, execSync } from 'child_process';
import { logEvent } from "./ownmind-log.js";
import { composeToolResponse } from "./lib/compose-tool-response.js";
import { isNetworkError, readMemoryCache, writeMemoryCache, localSearch, findCachedMemory, enqueueOperation, readQueue, replayQueue } from './offline.js';
import { appendCompliance, readComplianceEvents } from '../shared/compliance.js';
import { RULE_FULL_LAYER_SYNC, getEventDisplayName } from '../shared/lint-event-types.js';
import { shouldRetryForSyncToken, applyNewToken } from './lib/sync-token-retry.js';
import { buildApiErrorMessage } from './lib/api-error-message.js';
import { localDateOnly } from '../shared/local-date.js';
import { filterCacheableRules } from '../shared/cacheable-rules.js';
// v1.26.133 — a compact init response is not evidence that a collection is empty.
import { pickRulesForCache, mergeOfflineCacheData, previousDataForAccount } from '../shared/init-cache.js';
import { accountFingerprint } from '../shared/scanners/base.js';
// v1.26.127: the tip list lives in shared/tips.js so this and INSTRUCTIONS_SOP cannot drift.
import { getRandomTip } from '../shared/tips.js';
import { findMissingArgs, buildMissingArgsError } from './lib/required-args.js';
import { buildSessionLogBody } from './lib/session-log-body.js';
import { writeSessionOffState, clearSessionOffState, readSessionOffState } from '../shared/session-off-state.js';
import { queueUpdateBanner } from '../shared/update-banner.js';
import {
  detectTriggerFromContext,
  sanitizeErrorMessage,
  pushBounded,
  shouldSkipDuplicate,
  resolveClientTool,
  resolveProjectName,
  getClientVersion,
} from '../shared/helpers.js';
import { parseStandardMarkdown } from '../src/utils/md-parser.js';
import { captureClientOriginContext, injectOriginSection, validateOriginContext } from '../src/utils/iron-rule-origin-context.js';
import { enrichErrorDetails, errorAliasFields } from './lib/enrich-error.js';
import { tryAcquireUpdateLock, releaseUpdateLock } from '../shared/update-lock.js';
import { logMcpCallSafe } from './lib/log-mcp-call.js';
// v1.26.108 — `await import()` takes a module specifier, and an absolute filesystem path is
// only accidentally one. On Windows it starts with a drive letter, which the ESM loader reads
// as a URL scheme and rejects: ERR_UNSUPPORTED_ESM_URL_SCHEME. On macOS and Linux the same
// string begins with `/` and resolves, which is why this only ever failed on Windows — and
// failed into a catch that hid it.
const importFile = (p) => import(pathToFileURL(p).href);


// --- Verifiable rules cache (in-memory, loaded at init) ---
let cachedVerifiableRules = [];

function getCachedVerifiableRules() {
  if (cachedVerifiableRules.length > 0) return cachedVerifiableRules;
  // Fallback: try loading from local file cache
  try {
    const cachePath = path.join(os.homedir(), '.ownmind/cache/iron_rules.json');
    if (fs.existsSync(cachePath)) {
      cachedVerifiableRules = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
  } catch { /* ignore */ }
  return cachedVerifiableRules;
}

// --- Lazy-loaded verification engine ---
let evaluateConditions = null;
async function getEvaluateConditions() {
  if (evaluateConditions) return evaluateConditions;
  try {
    const mod = await importFile(path.join(os.homedir(), '.ownmind/shared/verification.js'));
    evaluateConditions = mod.evaluateConditions;
    return evaluateConditions;
  } catch {
    return null;
  }
}

// --- Cache refresh (called after iron_rule mutations) ---
const CACHE_PATH = path.join(os.homedir(), '.ownmind/cache/iron_rules.json');

async function refreshIronRulesCache() {
  try {
    const tokenParam = currentSyncToken ? `?sync_token=${currentSyncToken}` : '';
    const rules = await callApi('GET', `/api/memory/type/iron_rule${tokenParam}`);
    if (rules.new_token) currentSyncToken = rules.new_token;
    const allRules = Array.isArray(rules) ? rules : (rules.data || []);
    // v1.26.124: also keep rules carrying lint_validator — see shared/cacheable-rules.js.
    // The reply-lint hook reads this same file, and dropping its rules here made enabling a
    // reply check a no-op that reported nothing.
    const verifiable = filterCacheableRules(allRules);
    cachedVerifiableRules = verifiable;
    const cacheDir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(verifiable, null, 2));
  } catch { /* silent fail — don't block the caller */ }
}

// --- Session audit helpers ---
function extractSessionChecks(conditions) {
  if (!conditions) return [];
  if (conditions.type === 'recent_event_exists') return [conditions];
  if (conditions.when) return extractSessionChecks(conditions.then);
  if (conditions.checks) return conditions.checks.flatMap(c => extractSessionChecks(c));
  return [];
}

/**
 * End-of-session audit (L6).
 * Only checks the recent_event_exists family of precondition rules.
 * Git-context checks (staged_files, commit_message) are handled by the L1 git pre-commit hook
 * before the action; we don't duplicate them here — if the commit completed, L1 either passed
 * (or was bypassed with --no-verify).
 */
async function auditSession() {
  try {
    if (!sessionStartTime) return { commits_checked: 0, violations_found: 0, violations: [] };
    const since = new Date(sessionStartTime).toISOString();
    const gitLog = execSync(`git log --since="${since}" --format="%H" 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!gitLog) return { commits_checked: 0, violations_found: 0, violations: [] };

    const commitHashes = gitLog.split('\n').filter(Boolean);
    const rules = getCachedVerifiableRules().filter(r =>
      r.metadata?.verification?.trigger?.includes('commit')
    );

    const evalFn = await getEvaluateConditions();
    if (rules.length === 0 || !evalFn) {
      return { commits_checked: commitHashes.length, violations_found: 0, violations: [] };
    }

    const violations = [];
    for (const hash of commitHashes) {
      for (const rule of rules) {
        const sessionChecks = extractSessionChecks(rule.metadata.verification.conditions);
        if (sessionChecks.length === 0) continue;

        const ctx = { complianceEvents };
        const result = evalFn({ operator: 'AND', checks: sessionChecks }, ctx);
        if (!result.pass) {
          violations.push({
            rule_code: rule.code,
            rule_title: rule.title,
            commit_hash: hash.substring(0, 7),
            failures: result.failures
          });
        }
      }
    }

    // Record violations using shared compliance module
    for (const v of violations) {
      appendCompliance({
        event: v.rule_code,
        action: 'violate',
        rule_code: v.rule_code,
        rule_title: v.rule_title,
        source: 'session_audit',
        commit_hash: v.commit_hash,
        failures: v.failures,
      });
    }

    return {
      commits_checked: commitHashes.length,
      violations_found: violations.length,
      violations
    };
  } catch (e) {
    return { commits_checked: 0, violations_found: 0, violations: [], error: e.message };
  }
}

const pendingUploads = new Map();

// --- Config from env ---
const API_URL = (process.env.OWNMIND_API_URL || "http://localhost:3100").replace(
  /\/$/,
  ""
);
const API_KEY = process.env.OWNMIND_API_KEY || "";

// --- Version & Sync Token (in-memory, per session) ---
const CLIENT_VERSION = (() => {
  try {
    // Read the version uniformly from the root package.json (single source of truth).
    const rootPkg = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(rootPkg, 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
})();
// Which AI tool is hosting this MCP. Cursor / Codex / Antigravity / OpenCode configs
// set OWNMIND_TOOL (what install.sh writes) or OWNMIND_CLIENT_TOOL; the resolver knows
// the precedence. Defaults to claude-code.
//
// v1.26.67 — this line read only OWNMIND_CLIENT_TOOL, which nothing in this repository
// sets, while install.sh writes OWNMIND_TOOL. Every non-Claude-Code client therefore
// sent its heartbeat as claude-code.
const CLIENT_TOOL = resolveClientTool();

let serverVersion = null;
let currentSyncToken = null;

// --- Unified version banner labels ---
const TYPE_MAP = {
  ownmind_init: 'Memory loaded',
  ownmind_get: {
    profile: 'Profile', principle: 'Working principle', iron_rule: 'Iron rule reminder',
    coding_standard: 'Coding standard', team_standard: 'Team standard', project: 'Project memory',
    env: 'Environment', portfolio: 'Portfolio', session_log: 'Session log',
    standard_detail: 'Team standard details',
  },
  ownmind_search: 'Memory search',
  ownmind_save: 'Memory write',
  ownmind_update: 'Memory write',
  ownmind_disable: 'Memory write',
  ownmind_handoff_create: 'Handoff created',
  ownmind_handoff_accept: 'Handoff accepted',
  ownmind_log_session: 'Session logged',
  ownmind_get_secret: 'Secret management',
  ownmind_list_secrets: 'Secret management',
  ownmind_set_secret: 'Secret management',
  ownmind_delete_secret: 'Secret management',
  ownmind_report_compliance: 'Compliance report',
};

function getVersion() { return serverVersion || CLIENT_VERSION; }
function formatTag(type) { return `[OwnMind v${getVersion()}] ${type}`; }

function resolveType(name, args) {
  const entry = TYPE_MAP[name];
  if (!entry) return name;
  if (typeof entry === 'string') return entry;
  // entry is object (ownmind_get)
  return entry[args?.type] || 'Memory loaded';
}

// --- Session tracking (for emergency shutdown log) ---
// v1.26.67: this was TOOL_NAME, a second constant resolving to the same value as
// CLIENT_TOOL. Two names for one answer in one file is how the two rules drifted apart
// in the first place, so there is now one.
let sessionStartTime = null;
const toolCallCounts = {};
let complianceEvents = [];
const COMPLIANCE_EVENTS_MAX = 500;
const AUTO_COMPLY_DEDUP_TTL_MS = 60_000;
let sessionLogged = false;
// v1.17.37: auto-detect project name (only-logic-works — don't make the user repeat
// it to the AI every time). CLAUDE_PROJECT_DIR is the project root passed in by Claude Code
// when it launches the MCP. If the user isn't in a git repo or is using another tool, fall
// back to the cwd basename.
// v1.26.98 — this derivation moved to shared/helpers.js so the activity logger can use the
// same one. Two copies would have been two answers to "which project is this" on the same
// machine, which is exactly the confusion the team page column was showing.
const AUTO_PROJECT = resolveProjectName();

// --- v1.17.0 P4: Broadcast fetch + render ---
// Never block the tool call; failures stay silent; 2s timeout.
async function fetchBroadcastsSafely() {
  if (!API_KEY) return '';
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 2000);
    // v1.17.18: use CLIENT_VERSION read from package.json (process.env.OWNMIND_VERSION was
    // never being set, so broadcast inject never carried a version and the semver filter
    // skipped everything).
    const clientVersion = CLIENT_VERSION || process.env.OWNMIND_VERSION || '';
    const res = await fetch(`${API_URL}/api/broadcast/inject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        ...(clientVersion ? { 'x-ownmind-version': clientVersion } : {})
      },
      body: JSON.stringify({ tool: CLIENT_TOOL, client_version: clientVersion || null }),
      signal: controller.signal
    }).finally(() => clearTimeout(to));
    if (!res.ok) return '';
    const data = await res.json();
    const bcList = Array.isArray(data.broadcasts) ? data.broadcasts : [];
    if (bcList.length === 0) return '';
    return renderBroadcasts(bcList);
  } catch {
    return '';  // network error / timeout → stay silent
  }
}

function renderBroadcasts(broadcasts) {
  const lines = ['📢 OwnMind broadcast'];
  for (const bc of broadcasts.slice(0, 3)) {
    const sev = String(bc.severity || 'info').toUpperCase();
    lines.push(`[${sev}] ${String(bc.title || '').replace(/\n/g, ' ')}`);
    const body = String(bc.body || '').split('\n').slice(0, 5).join(' ').slice(0, 400);
    if (body) lines.push(body);
    if (bc.cta_text) {
      const hint = bc.cta_action === 'upgrade_ownmind' ? '(let the AI run the upgrade)' : '';
      lines.push(`👉 Say "${bc.cta_text}" ${hint}`.trim());
    }
    if (bc.allow_snooze) {
      lines.push(`(Not ready? Say "snooze upgrade" to defer for ${bc.snooze_hours || 24} hours)`);
    }
    lines.push('');
  }
  if (broadcasts.length > 3) {
    lines.push(`(${broadcasts.length - 3} more broadcast(s) not shown)`);
  }
  lines.push('---');
  return lines.join('\n');
}

// --- Helper ---
// Send MCP heartbeat so dashboard can mark this user as "installed" even
// without the scheduled scanner. Fire-and-forget — never block init.
//
// Crash-loop protection: a misconfigured MCP that starts → crashes → restarts
// in a fast loop would otherwise spam heartbeats at high rate. The module-
// scope `heartbeatSent` flag caps each MCP process at exactly one heartbeat,
// regardless of how many call sites trigger it (startup + ownmind_init).
// The flag is set BEFORE the await so parallel/rapid calls during the in-
// flight POST also short-circuit, instead of racing multiple POSTs.
let heartbeatSent = false;
//
// v1.26.117 — OWNMIND_PREFLIGHT is the self-check starting this server on purpose, to find
// out whether the registered command produces one (scripts/install-helpers/mcp-preflight.cjs).
// That start is a diagnostic, not a session: letting it beat would refresh this machine's
// heartbeat on every self-check run, including the unattended daily one, and the heartbeat is
// what collector-silence reads to decide a machine has stopped reporting. A check that
// quietly vouches for the thing it is checking is worse than no check.
//
// The guard sits above the `heartbeatSent` one and both stay at the top of the body: the
// v1.17.x rule is that the flag is set synchronously before the await, and a comment long
// enough to push that out of sight is a comment in the wrong place (tests/heartbeat-once-
// per-process.test.js reads the first 400 characters of this function and says so).
async function sendMcpHeartbeat() {
  if (process.env.OWNMIND_PREFLIGHT === '1') return; // diagnostic start — see above
  if (heartbeatSent) return;
  heartbeatSent = true;
  try {
    await callApi('POST', '/api/usage/events', {
      events: [],
      heartbeat: {
        tool: CLIENT_TOOL,
        scanner_version: CLIENT_VERSION,
        machine: os.hostname(),
        os: os.platform(),
      },
    });
  } catch { /* silent fail — heartbeat is best-effort */ }
}

async function callApi(method, path, body, _retried = false) {
  const url = `${API_URL}${path}`;
  const headers = {
    "Content-Type": "application/json",
    "x-ownmind-tool": CLIENT_TOOL,
  };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  const opts = { method, headers };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = buildApiErrorMessage(data, text);

    // v1.20.2 follow-up #2: on write 409 sync_token stale → auto-fetch a new token and retry once.
    // Background: when the user has multiple AI sessions open, session A's token gets bumped
    // by session B's writes; A's next write then 409s. Previously the AI had to manually call
    // ownmind_init and retry — bad UX.
    if (!_retried && shouldRetryForSyncToken({ method, status: res.status, errorMessage: msg, body: data })) {
      const newToken = await refreshSyncToken();
      if (newToken && applyNewToken(body, newToken)) {
        return callApi(method, path, body, true);
      }
    }

    throw new Error(`API ${res.status}: ${msg}`);
  }

  return data;
}

/**
 * v1.20.2 follow-up #2: GET /api/memory/sync-token to fetch the latest token and refresh
 * currentSyncToken — used by callApi's auto-retry. Side effects are minimal (no reset of
 * complianceEvents or other init-time side effects).
 *
 * @returns {Promise<string|null>} new token, or null on failure
 */
async function refreshSyncToken() {
  try {
    const data = await callApi('GET', '/api/memory/sync-token');
    if (data?.sync_token) {
      currentSyncToken = data.sync_token;
      return data.sync_token;
    }
  } catch {
    // Refresh failed → give up the retry and let the original 409 propagate to the caller.
  }
  return null;
}

// --- Tool definitions ---
const TOOLS = [
  {
    name: "ownmind_init",
    description:
      "Load initial memories (instructions, profile, principles, iron_rules, iron_rules_digest, active_handoff). Must be called at the start of every new conversation. iron_rules_digest is a condensed summary that must be internalized immediately as working guidelines.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "ownmind_get",
    // v1.26.141: this used to end "Use standard_detail to pull the full text behind a
    // team_standard summary." Measured against production, that returns { data: [] } for a
    // standard whose text lives on its own record — the case for every standard written
    // recently. A tool description is read on every turn, so it outranked the session context
    // that was telling the AI the same wrong thing.
    description: "Retrieve memories. Pass id to read one memory in full — that is how you follow up a search result whose content was truncated. Pass type to list every memory of that type. To read a team standard you have only seen the title of, call ownmind_search with that title and then ownmind_get with the id of the row it returns; standard_detail holds child fragments and is empty for a standard whose text is on its own record.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional. A single memory id, returned in full including content and metadata. Use this after a search result shows content_truncated: true." },
        type: { type: "string", enum: ["profile", "principle", "iron_rule", "coding_standard", "team_standard", "project", "portfolio", "env", "session_log", "standard_detail"], description: "Memory type. Required unless id is given." },
        parent_id: { type: "string", description: "Optional. With type=standard_detail, return only the fragments of that one team_standard (its memory id). Omit to fetch every fragment of every standard." },
      },
      required: [],
    },
  },
  {
    name: "ownmind_search",
    // v1.26.141: the two "call this when" sentences. Everything else OwnMind delivers states
    // what is known; nothing said when to go and look, so a term that happened to match a
    // title in the startup list got looked up and the same thing said differently did not.
    // This description is in front of the model on every turn, which the startup context is
    // not — and it reaches every tool, including the ones that never see that context.
    description: "Search memories and session logs by keyword. CALL THIS when something in the request points at the user rather than at the world — a name, tool, site, process, server or decision you cannot resolve from the repo in front of you, or a phrase you would have to guess at (\"the company X\", \"our Y\", \"the usual Z\") — BEFORE you answer or start work. Also call it before you ask the user something they may have stored already. NEVER tell the user you have no information about something of theirs — a server, a project, a credential, a decision — until you have searched for it in this session; that is a claim about their memory, not about the world. Results are previews: content is cut to 400 characters, with content_length and content_truncated on each row. Call ownmind_get with that row's id to read one in full — and always do that before ownmind_update, or you will overwrite the rest of it. The response carries memory_total and memory_returned; when they differ the list was capped and a narrower query will reach the rest.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword" },
      },
      required: ["query"],
    },
  },
  {
    name: "ownmind_save",
    description: "⚠️ For sensitive data (passwords, tokens, API keys, credentials) use ownmind_set_secret instead — do not write secrets into memories (the memory API detects and rejects them with HTTP 400). Save a new memory: specify type, title, content, plus optional code, tags, metadata. When writing an iron_rule, the AI should also pass origin_event / user_quote describing \"why this rule was created at the time\" — if unknown, write \"user issued the rule directly\".",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["profile", "principle", "iron_rule", "coding_standard", "team_standard", "project", "portfolio", "env", "session_log"], description: "Memory type" },
        title: { type: "string", description: "Memory title" },
        content: { type: "string", description: "Memory content" },
        code: { type: "string", description: "Related code (optional)" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tag list (optional). For iron_rule, use the `trigger:` prefix to mark trigger conditions, e.g. trigger:git, trigger:commit, trigger:deploy, trigger:delete",
        },
        metadata: {
          type: "object",
          description: "Additional metadata (optional)",
        },
        // v1.18.2: iron_rule only — AI fills in time-and-place context
        origin_event: {
          type: "string",
          description: "(iron_rule only) Event description inferred by the AI from conversation context. Example: \"Upgrade-helper testing surfaced an IR-XXX misapplied scenario.\" If unknown, write \"user issued the rule directly, no work context.\"",
        },
        user_quote: {
          type: "string",
          description: "(iron_rule only) The user's verbatim quote that triggered the rule's creation (optional). Example: \"I think iron rules should record their time-and-place context.\"",
        },
        origin_confidence: {
          type: "string",
          enum: ["high", "user_direct", "unknown"],
          description: "(iron_rule only) Confidence in the captured context: high = confidently inferred from conversation; user_direct = user issued the rule directly; unknown = cannot determine. Default unknown.",
        },
        related_rules: {
          type: "array",
          items: { type: "string" },
          description: "(iron_rule only) Related iron rule codes (optional). Example: ['IR-XXX', 'IR-YYY']",
        },
        // v1.19: iron rule tier
        tier: {
          type: "string",
          enum: ["critical", "default", "advisory"],
          description: "(iron_rule only) Rule tier (optional, default \"default\"). critical = core hard rule, blocked since v1.20; default = standard rule, raises a warning; advisory = pure hint, only logged.",
        },
      },
      required: ["type", "title", "content"],
    },
  },
  {
    name: "ownmind_update",
    description: "⚠️ For sensitive data (passwords, tokens, API keys, credentials) use ownmind_set_secret instead — do not write secrets into memories (the memory API detects and rejects them with HTTP 400). Update an existing memory: provide the memory ID and an update_reason. The previous content is automatically archived to history.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Memory ID" },
        title: { type: "string", description: "Updated title (optional; keeps existing title if omitted). Must be non-empty when provided. Iron rule titles still go through the quality check." },
        content: { type: "string", description: "Updated content (optional; keeps existing content if omitted)" },
        update_reason: { type: "string", description: "Reason for the update (required)" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Updated tags (optional). For iron_rule, use the `trigger:` prefix, e.g. trigger:commit, trigger:deploy",
        },
        metadata: {
          type: "object",
          description: "Updated metadata (optional)",
        },
        // v1.19: iron rule tier
        tier: {
          type: "string",
          enum: ["critical", "default", "advisory"],
          description: "(iron_rule only) Rule tier (optional). One of: critical, default, advisory.",
        },
      },
      required: ["id", "update_reason"],
    },
  },
  {
    name: "ownmind_disable",
    description: "Disable a memory entry (e.g., an iron rule). A reason is required.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Memory ID" },
        reason: { type: "string", description: "Reason for disabling" },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "ownmind_handoff_create",
    description:
      "Create a handoff record so another tool or session can take over unfinished work.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        content: { type: "string", description: "Handoff content" },
        from_tool: { type: "string", description: "Source tool name (optional)" },
        from_model: { type: "string", description: "Source model name (optional)" },
        from_machine: { type: "string", description: "Source machine name (optional)" },
      },
      required: ["project", "content"],
    },
  },
  {
    name: "ownmind_handoff_accept",
    description: "Accept a pending handoff record.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Handoff record ID" },
        accepted_by: { type: "string", description: "Acceptor name" },
      },
      required: ["id", "accepted_by"],
    },
  },
  {
    name: "ownmind_log_session",
    description: "Log a work session's summary and context. Must be called before a conversation ends; does not require user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Session summary (1-2 sentences describing what was done)" },
        tool: { type: "string", description: "(optional) Tool used (e.g., claude-code, cursor, codex). Defaults to the tool hosting this MCP." },
        model: { type: "string", description: "(optional) Model used (e.g., claude-opus-5, gpt-5). Supply it when you know it; it is recorded as unreported rather than guessed." },
        machine: { type: "string", description: "Machine the session ran on (optional)" },
        details: {
          type: "object",
          description: "Structured context report",
          properties: {
            project: { type: "string", description: "Primary project name" },
            duration_turns: { type: "number", description: "Number of conversation turns" },
            actions: { type: "array", items: { type: "string" }, description: "Action types performed (e.g., code_edit, git_commit, deploy, debug, research)" },
            rules_triggered: { type: "array", items: { type: "string" }, description: "Iron rule codes triggered (e.g. IR-XXX)" },
            rules_complied: { type: "array", items: { type: "string" }, description: "Iron rule codes complied with" },
            rules_skipped: { type: "array", items: { type: "string" }, description: "Iron rule codes skipped" },
            friction_points: { type: "string", description: "Friction points the user encountered" },
            suggestions: { type: "string", description: "Improvements to OwnMind the AI observed" },
          },
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "ownmind_get_secret",
    description: "Retrieve a secret's value. Requires the key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Secret key" },
      },
      required: ["key"],
    },
  },
  {
    name: "ownmind_list_secrets",
    description: "List all stored secret keys (values not included).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "ownmind_set_secret",
    description: "Save or update a secret (upsert: if the key already exists, the value is overwritten).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Secret key" },
        value: { type: "string", description: "Secret value" },
        description: { type: "string", description: "Description (optional)" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "ownmind_delete_secret",
    description: "Permanently delete a secret. Warning: deletion is irreversible. Recommended: confirm the key with ownmind_list_secrets first to avoid accidental deletion.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Secret key to delete" },
      },
      required: ["key"],
    },
  },
  {
    name: "ownmind_report_compliance",
    description: "Report iron rule compliance. When an iron rule is triggered, the AI must call this tool to report whether it complied. action: 'comply' (complied), 'skip' (user asked to skip), 'violate' (violated).",
    inputSchema: {
      type: "object",
      properties: {
        rule_title: { type: "string", description: "Iron rule title" },
        rule_code: { type: "string", description: "Iron rule code (e.g. IR-XXX)" },
        action: { type: "string", enum: ["comply", "skip", "violate"], description: "comply = complied; skip = user asked to skip; violate = violated" },
        context: { type: "string", description: "Operation context that triggered the rule (optional)" },
      },
      required: ["rule_title", "action"],
    },
  },
  {
    name: "ownmind_upload_standard",
    description: "Read a local Markdown standard file and produce a chunked preview. Returns chunk titles and diff statistics.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the Markdown file" },
        title: { type: "string", description: "Standard title (optional; defaults to the file name)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "ownmind_confirm_upload",
    description: "Confirm and commit the standard upload. Requires the session_id returned by upload_standard.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session_id returned by the upload stage" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "ownmind_report_bug",
    description: "Report a bug or design issue in OwnMind itself (plain words: the user thinks OwnMind misbehaved and wants to tell the developer).\n\nIMPORTANT: Before calling this tool, show the field contents to the user, then wait until they type the submit phrase, and pass exactly what they typed as confirm_string.\n\nThis is a protocol you are asked to follow, NOT something the server enforces. The server checks that confirm_string has the expected value; it cannot tell whether you or the user produced those characters. Report which it was in confirmation_declared: 'user_typed' only when the user actually typed the phrase in response to your preview, 'ai_filled' when you supplied it yourself. Reports are read by a person deciding what to act on, and one that nobody looked at is worth knowing about as such.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One-line problem description" },
        description: { type: "string", description: "Full reproduction steps + expected vs actual behavior" },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "Severity (blocked → medium; error raised → high; repeatedly triggered → critical)",
        },
        component: { type: "string", description: "Module where the error occurred (e.g., memory, setup, lint)" },
        reproduce_input: { type: "string", description: "Minimal input that reproduces the error" },
        context_summary: {
          type: "object",
          description: "Surrounding conversation snippet + environment info (the system mandatorily passes this through a PII masking middleware)",
        },
        bug_fingerprint: {
          type: "string",
          description: "Error fingerprint. Prefer the value from a server suggest_report response. If reporting a newly discovered design issue with no matching registered fingerprint, use \"clt_user_reported_other\" instead of inventing a name (free-form names are rejected with HTTP 400).",
        },
        related_lint_event_ids: {
          type: "array",
          items: { type: "number" },
          description: "(optional) Associated reply-lint event ids",
        },
        confirm_string: {
          type: "string",
          description: "Pass back what the user typed, verbatim. If you do not know the phrase, call with your best attempt: the server refuses with an error naming the required phrase, and you then show the user that phrase and ask them to type it. Do not ask the user to guess. The server checks this value only; it cannot see who produced it, so this one is on you. Whichever it was, say so in confirmation_declared.",
        },
        confirmation_declared: {
          type: "string",
          enum: ["user_typed", "ai_filled"],
          description: "Who produced confirm_string. 'user_typed' only when the user typed the phrase after seeing your preview; 'ai_filled' when you supplied it. Nothing verifies this — it is your statement, recorded as such, and it is what tells the person reading these reports whether anyone else has looked at this one. An absent or unrecognised value is recorded as 'unknown'.",
        },
      },
      required: ["title", "description", "bug_fingerprint", "confirm_string", "confirmation_declared"],
    },
  },
  {
    name: "ownmind_session_off",
    description: "Temporarily disable OwnMind hooks for this session (response-quality lint + pre-commit check). AI responses will not be intercepted or rewritten; git commits will not be blocked by iron rules. Automatically restored when a new session starts, or call ownmind_session_on to re-enable immediately. While disabled, every 10 AI responses the user sees a terminal reminder \"OwnMind is currently disabled\".",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Reason for disabling (optional; recorded for audit purposes)" },
      },
      required: [],
    },
  },
  {
    name: "ownmind_session_on",
    description: "Re-enable OwnMind hooks for this session (response-quality lint + pre-commit check). The state file is removed; the next AI response / git commit will run the hooks normally.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// --- Tool handlers ---
async function handleTool(name, args) {
  // Session tracking
  if (!sessionStartTime) sessionStartTime = Date.now();
  toolCallCounts[name] = (toolCallCounts[name] || 0) + 1;

  // Client-side required-argument guard (mirrors src/utils/require-fields.js).
  // Reject an incomplete call before any network round-trip, so a caller that
  // delivers a partial arguments object gets a fast, actionable error instead of
  // a confusing server-side 400 that looks like OwnMind dropped the fields.
  // `required` is derived from each tool's own inputSchema, so new tools are
  // covered automatically.
  const requiredArgs = TOOLS.find((t) => t.name === name)?.inputSchema?.required;
  const missingArgs = findMissingArgs(name, args, requiredArgs);
  if (missingArgs.length > 0) {
    throw new Error(buildMissingArgsError(name, missingArgs, args));
  }

  switch (name) {
    case "ownmind_init": {
      // Reset session state (the MCP process may outlive a single session).
      complianceEvents = [];
      let data;
      try {
        data = await callApi("GET", `/api/memory/init?client_version=${CLIENT_VERSION}&compact=true`);
      } catch (initErr) {
        if (isNetworkError(initErr)) {
          const cache = readMemoryCache();
          if (cache) {
            logEvent('init', { status: 'offline', details: { saved_at: cache.saved_at } });
            return {
              _offline: true,
              _offline_notice: `[OwnMind offline mode] Cannot reach the server — data is served from local cache (${cache.saved_at}) and may be stale`,
              iron_rules: cache.data.iron_rule || [],
              principles: cache.data.principle || [],
              profile: (cache.data.profile || [])[0] || null,
              coding_standards: cache.data.coding_standard || [],
              team_standards: cache.data.team_standard || [],
              projects: cache.data.project || [],
              envs: cache.data.env || [],
              portfolios: cache.data.portfolio || [],
            };
          }
        }
        throw initErr;
      }
      if (data.sync_token) {
        currentSyncToken = data.sync_token;
      }
      if (data.server_version) serverVersion = data.server_version;
      if (data.upgrade_action?.required) {
        data._upgrade_notice = `⚠️ ${data.upgrade_action.message}\nRun: ${data.upgrade_action.command}`;
      }
      data._client_version = CLIENT_VERSION;
      // Enforcement Alerts are already embedded in iron_rules_digest by the server — no need to re-format on the client.
      // E4: Sync verifiable rules to local cache
      // v1.26.124: "verifiable" is now "anything a cache consumer needs" — the reply-lint
      // hook's rules live here too. See shared/cacheable-rules.js.
      //
      // v1.26.133: this request asks for `compact=true`, and a compact response carries
      // `iron_rules_digest` rather than `iron_rules`. So `data.iron_rules || []` filtered an
      // empty array on every single init and wrote `[]` over the cache. Measured on Windows
      // 2026-08-10: the account's only rule carrying a lint_validator was in the cache at
      // 20:25 and gone at 20:30 after one init — leaving the reply-lint Stop hook with zero
      // validators for the rest of the session. See shared/init-cache.js.
      //
      // When the response cannot answer, ask the endpoint that can; when that fails too,
      // leave the cache as it is. `absent` is not `empty`.
      let ironRules = Array.isArray(data.iron_rules) ? data.iron_rules : null;
      if (!ironRules) {
        try {
          const fetched = await callApi('GET', '/api/memory/type/iron_rule');
          ironRules = pickRulesForCache(null, Array.isArray(fetched) ? fetched : fetched?.data);
        } catch { /* offline or 5xx: both caches keep what they already hold */ }
      }

      if (ironRules) {
        try {
          const verifiableRules = filterCacheableRules(ironRules);
          cachedVerifiableRules = verifiableRules;
          const cachePath = path.join(os.homedir(), '.ownmind/cache/iron_rules.json');
          const cacheDir = path.dirname(cachePath);
          if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(cachePath, JSON.stringify(verifiableRules, null, 2));
        } catch { /* silent fail */ }
      }

      // Write full memory cache for offline fallback.
      // v1.26.133: merged rather than replaced, for the same reason — a compact response
      // carries no team standards, coding standards, projects, envs or portfolios, and
      // storing `|| []` for each erased them from the offline cache on every session start.
      // The offline probe on 2026-08-10 came back with no iron rules and no team standards
      // for precisely that.
      //
      // The `account` stamp is what makes merging safe. Replacing needed no such question;
      // keeping what is already on disk does, because a key pointing at another account must
      // not inherit this one's collections. Same rule as the SessionStart cache (v1.26.82):
      // an unattributed cache counts as somebody else's.
      try {
        const fingerprint = accountFingerprint({ apiUrl: API_URL, apiKey: API_KEY });
        writeMemoryCache({
          saved_at: new Date().toISOString(),
          sync_token: data.sync_token || null,
          account: fingerprint,
          data: mergeOfflineCacheData(
            previousDataForAccount(readMemoryCache(), fingerprint), data, ironRules,
          ),
        });
      } catch { /* silent fail */ }

      // Queue replay: send any queued operations now that server is online
      const replayResult = await replayQueue(callApi, currentSyncToken);
      if (replayResult.message) data._queue_replay = replayResult.message;

      // Eagerly load verification engine
      getEvaluateConditions().catch(() => {});

      logEvent('init', { status: 'ok', details: { rules: data.iron_rules?.length || 0, profile: !!data.profile, handoff: !!data.active_handoff, version: data.server_version } });
      sendMcpHeartbeat();
      if (data._onboarding?.is_new_user) {
        data._onboarding_instruction =
          `[OwnMind new-user onboarding] Detected a fresh account with no memories yet. ` +
          `Tool in use: ${data._onboarding.detected_tool} (auto-recorded). ` +
          `Immediately ask the user: "${data._onboarding.question}" ` +
          `Once they reply, call ownmind_save to create a type=profile memory whose content includes name, occupation, and tools used. ` +
          `Then confirm to the user that the memory has been created.`;
      }
      return data;
    }

    case "ownmind_get": {
      const tokenParam = currentSyncToken ? `?sync_token=${currentSyncToken}` : '';
      // v1.26.64 — the way back to a full memory. Search answers with 400-character
      // previews now, and without this there would be no way to read the one you wanted:
      // this tool took a type and never an id. Truncation without a fetch-one path trades
      // "too much" for "not enough".
      if (args.id !== undefined && args.id !== null && args.id !== '') {
        try {
          const row = await callApi("GET", `/api/memory/${encodeURIComponent(args.id)}`);
          logEvent('memory_get', { by_id: true });
          return { data: row ? [row] : [] };
        } catch (err) {
          // Every other branch in this tool degrades to the cache when the network is
          // gone; the first version of this one did not, and would have thrown instead.
          // Caught in review of this release. The cache holds whole memories, so offline
          // the follow-up to a truncated search result still works.
          if (isNetworkError(err)) {
            const cached = findCachedMemory(readMemoryCache(), args.id);
            logEvent('memory_get', { by_id: true, offline: true });
            return {
              data: cached ? [cached] : [],
              _offline: true,
              _offline_notice: cached
                ? '[OwnMind offline mode] Served from the local cache; it may be behind the server'
                : `[OwnMind offline mode] Memory ${args.id} is not in the local cache`,
            };
          }
          throw err;
        }
      }
      if (!args.type) {
        return { error: 'Provide either id (one memory in full) or type (all memories of that type).' };
      }
      // v1.17.13 Dana case: session_log lives in its own session_logs table rather than memories,
      // so we proxy to /api/session/recent — keeping write (ownmind_log_session) and read (ownmind_get) consistent.
      if (args.type === 'session_log') {
        try {
          // v1.26.64: an explicit limit. This is a listing, not a search, so the search
          // default of 20 would hide most of a month; 50 is the server's ceiling.
          const rows = await callApi("GET", `/api/session/recent?days=30&include_compressed=true&limit=50`);
          logEvent('memory_get', { type: args.type, from_session_logs: true });
          return { data: Array.isArray(rows) ? rows : [] };
        } catch (err) {
          if (isNetworkError(err)) {
            logEvent('memory_get', { type: args.type, offline: true });
            return {
              data: [],
              _offline: true,
              _offline_notice: '[OwnMind offline mode] session_log requires a live connection to query the session_logs table',
            };
          }
          throw err;
        }
      }
      try {
        // v1.26.38: parent_id narrows standard_detail to one team standard.
        const parentParam = args.parent_id
          ? `${tokenParam ? '&' : '?'}parent_id=${encodeURIComponent(args.parent_id)}`
          : '';
        const data = await callApi("GET", `/api/memory/type/${encodeURIComponent(args.type)}${tokenParam}${parentParam}`);
        if (data.new_token) currentSyncToken = data.new_token;
        logEvent('memory_get', { type: args.type });
        return data;
      } catch (err) {
        if (isNetworkError(err)) {
          const cache = readMemoryCache();
          const items = cache?.data?.[args.type] || [];
          logEvent('memory_get', { type: args.type, offline: true });
          return {
            data: items,
            _offline: true,
            _offline_notice: `[OwnMind offline mode] Data served from local cache (${cache?.saved_at || 'unknown'})`,
          };
        }
        throw err;
      }
    }

    case "ownmind_search": {
      const searchTokenParam = currentSyncToken ? `&sync_token=${currentSyncToken}` : '';
      try {
        // v1.17.13: search memories + session_logs together and merge (Dana case).
        const [memoryRows, sessionRows] = await Promise.all([
          callApi("GET", `/api/memory/search?q=${encodeURIComponent(args.query)}${searchTokenParam}`)
            .catch(() => []),
          callApi("GET", `/api/session/recent?days=90&include_compressed=true&q=${encodeURIComponent(args.query)}`)
            .catch(() => []),
        ]);
        const memoryData = Array.isArray(memoryRows) ? memoryRows : (memoryRows?.data || []);
        const sessionData = Array.isArray(sessionRows) ? sessionRows : [];
        const sessionAsMemory = sessionData.map((s) => ({
          id: s.id,
          type: 'session_log',
          title: (s.summary || '').slice(0, 80),
          content: s.summary,
          details: s.details,
          tool: s.tool,
          model: s.model,
          created_at: s.created_at,
          _source: 'session_logs',
        }));
        const merged = [...memoryData, ...sessionAsMemory];
        if (memoryRows?.new_token) currentSyncToken = memoryRows.new_token;
        logEvent('memory_search', { query: args.query, memory_hits: memoryData.length, session_hits: sessionData.length });
        // v1.26.64: memory_total is what matched, memory_returned is what came back. A
        // caller that cannot tell the two apart reads twenty of two hundred results as
        // the whole picture.
        return {
          data: merged,
          memory_hits: memoryData.length,
          session_hits: sessionData.length,
          memory_total: memoryRows?.total ?? memoryData.length,
          memory_returned: memoryRows?.returned ?? memoryData.length,
        };
      } catch (err) {
        if (isNetworkError(err)) {
          const cache = readMemoryCache();
          // v1.26.64: localSearch now answers in the same {data, total, returned} shape
          // as the server, so the two paths hand back the same thing.
          const results = localSearch(cache, args.query);
          logEvent('memory_search', { query: args.query, offline: true });
          return {
            data: results.data,
            memory_total: results.total,
            memory_returned: results.returned,
            _offline: true,
            _offline_notice: `[OwnMind offline mode] Local keyword search on cached memories (${results.returned} of ${results.total} matches; content is a preview)`,
          };
        }
        throw err;
      }
    }

    case "ownmind_save": {
      const body = {
        type: args.type,
        title: args.title,
        content: args.content,
        sync_token: currentSyncToken,
      };
      if (args.code !== undefined) body.code = args.code;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.metadata !== undefined) body.metadata = args.metadata;
      // v1.19: iron rule tiering — the server validates that non-iron-rule entries cannot set a tier.
      if (args.tier !== undefined) body.tier = args.tier;

      // v1.18.2: iron_rule auto-capture + inject origin_context (situational context).
      // - Technical fields (cwd / git_branch / captured_at) are filled in by the client.
      // - Event description (event / user_quote / confidence) is supplied by the AI via args.origin_event etc.
      // - If absent → confidence='unknown'; written into metadata but not blocked.
      // - The body is auto-injected with a "## Origin" section so future AIs see the context.
      if (args.type === 'iron_rule') {
        const oc = captureClientOriginContext({
          confidence: args.origin_confidence || (args.origin_event ? 'high' : 'unknown'),
          event: args.origin_event,
          userQuote: args.user_quote,
          relatedRules: args.related_rules,
        });
        // git branch (best-effort; skip if git is not installed)
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          if (branch) oc.git_branch = branch;
        } catch { /* not a git repo */ }

        // Write into metadata.
        body.metadata = body.metadata || {};
        body.metadata.origin_context = oc;

        // Inject the "## Origin" body section (rendered from oc).
        body.content = injectOriginSection(body.content, oc);
      }

      try {
        const data = await callApi("POST", "/api/memory", body);
        if (data.sync_token) currentSyncToken = data.sync_token;
        logEvent('memory_save', { type: args.type, title: args.title });
        // Refresh cache if iron_rule was saved
        if (args.type === 'iron_rule') {
          refreshIronRulesCache().catch(() => {});
        }
        return data;
      } catch (err) {
        if (isNetworkError(err)) {
          const queueLen = readQueue().length;
          enqueueOperation({ method: 'POST', path: '/api/memory', body });
          logEvent('memory_save', { type: args.type, title: args.title, queued: true });
          return { _queued: true, _queue_notice: `[OwnMind offline mode] Operation queued — will be sent automatically once back online (queue: ${queueLen + 1} pending)` };
        }
        throw err;
      }
    }

    case "ownmind_update": {
      const body = { update_reason: args.update_reason, sync_token: currentSyncToken };
      if (args.title !== undefined) body.title = args.title;
      if (args.content !== undefined) body.content = args.content;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.metadata !== undefined) body.metadata = args.metadata;
      // v1.19: iron rule tiering — the server validates that non-iron-rule entries cannot change tier.
      if (args.tier !== undefined) body.tier = args.tier;
      try {
        const data = await callApi("PUT", `/api/memory/${args.id}`, body);
        if (data.sync_token) currentSyncToken = data.sync_token;
        logEvent('memory_update', { id: args.id, reason: args.update_reason });
        // Refresh cache if iron_rule was updated
        if (data.type === 'iron_rule' || data.memory?.type === 'iron_rule') {
          refreshIronRulesCache().catch(() => {});
        }
        return data;
      } catch (err) {
        if (isNetworkError(err)) {
          const queueLen = readQueue().length;
          enqueueOperation({ method: 'PUT', path: `/api/memory/${args.id}`, body });
          logEvent('memory_update', { id: args.id, queued: true });
          return { _queued: true, _queue_notice: `[OwnMind offline mode] Operation queued — will be sent automatically once back online (queue: ${queueLen + 1} pending)` };
        }
        throw err;
      }
    }

    case "ownmind_disable": {
      const disableBody = { reason: args.reason, sync_token: currentSyncToken };
      try {
        const data = await callApi("PUT", `/api/memory/${args.id}/disable`, disableBody);
        if (data.sync_token) currentSyncToken = data.sync_token;
        logEvent('memory_disable', { id: args.id, reason: args.reason });
        // Refresh cache if iron_rule was disabled
        if (data.type === 'iron_rule' || data.memory?.type === 'iron_rule') {
          refreshIronRulesCache().catch(() => {});
        }
        return data;
      } catch (err) {
        if (isNetworkError(err)) {
          const queueLen = readQueue().length;
          enqueueOperation({ method: 'PUT', path: `/api/memory/${args.id}/disable`, body: disableBody });
          logEvent('memory_disable', { id: args.id, queued: true });
          return { _queued: true, _queue_notice: `[OwnMind offline mode] Operation queued — will be sent automatically once back online (queue: ${queueLen + 1} pending)` };
        }
        throw err;
      }
    }

    case "ownmind_handoff_create": {
      const body = { project: args.project, content: args.content, sync_token: currentSyncToken };
      if (args.from_tool !== undefined) body.from_tool = args.from_tool;
      if (args.from_model !== undefined) body.from_model = args.from_model;
      if (args.from_machine !== undefined) body.from_machine = args.from_machine;
      const data = await callApi("POST", "/api/handoff", body);
      if (data.sync_token) currentSyncToken = data.sync_token;
      logEvent('handoff_create', { project: args.project });
      return data;
    }

    case "ownmind_handoff_accept": {
      const data = await callApi("PUT", `/api/handoff/${args.id}/accept`, {
        accepted_by: args.accepted_by,
        sync_token: currentSyncToken,
      });
      if (data.sync_token) currentSyncToken = data.sync_token;
      logEvent('handoff_accept', { id: args.id, accepted_by: args.accepted_by });
      return data;
    }

    case "ownmind_log_session": {
      // v1.26.61: `tool` defaults to this client and `model` may be absent, so a call
      // that arrives carrying only `summary` still records the session. See
      // mcp/lib/session-log-body.js and Eric's bug #9.
      const body = {
        ...buildSessionLogBody(args, { clientTool: CLIENT_TOOL }),
        sync_token: currentSyncToken,
      };

      // E5: Session audit (L6) — check commits against compliance events
      try {
        const auditResult = await auditSession();
        if (auditResult.violations_found > 0 || auditResult.commits_checked > 0) {
          if (!body.details) body.details = {};
          body.details.session_audit = auditResult;
        }
      } catch { /* audit failure should not block session log */ }

      const data = await callApi("POST", "/api/session", body);
      if (data.sync_token) currentSyncToken = data.sync_token;
      sessionLogged = true;
      logEvent('session_log', { summary: args.summary });
      return data;
    }

    case "ownmind_get_secret": {
      // Accept `name` as a fallback alias — AIs frequently confuse this with
      // the memory tools (ownmind_get / ownmind_update) which key off `name`.
      // Without this, a `name=...` call would silently send /api/secret/undefined
      // and return a misleading 404.
      const key = args.key || args.name;
      if (!key) {
        throw new Error("ownmind_get_secret: missing required argument `key` (string). The parameter is `key`, not `name` — `name` is used by the memory tools.");
      }
      return await callApi("GET", `/api/secret/${encodeURIComponent(key)}`);
    }

    case "ownmind_list_secrets":
      return await callApi("GET", "/api/secret");

    case "ownmind_set_secret": {
      const key = args.key || args.name;
      if (!key) {
        throw new Error("ownmind_set_secret: missing required argument `key` (string).");
      }
      if (args.value === undefined || args.value === null) {
        throw new Error("ownmind_set_secret: missing required argument `value` (string).");
      }
      const body = { key, value: args.value };
      if (args.description !== undefined) body.description = args.description;
      return await callApi("POST", "/api/secret", body);
    }

    case "ownmind_delete_secret": {
      // v1.17.91: permanently delete a single secret. The server writes an activity_log audit
      // entry (secret hygiene — do not leak the value; only record the key and the action).
      const key = args.key || args.name;
      if (!key) {
        throw new Error("ownmind_delete_secret: missing required argument `key` (string).");
      }
      return await callApi("DELETE", `/api/secret/${encodeURIComponent(key)}`);
    }

    case "ownmind_report_bug": {
      // Two-stage confirmation flow: show the preview, then pass back what the user typed.
      //
      // v1.26.97: the server checks the VALUE of confirm_string, not who produced it, and
      // it cannot — the AI authenticates with the same API key as the person, so nothing
      // server-side can separate them. What is recorded instead is the client's own
      // statement, in confirmation_declared.
      // device_fingerprint is computed locally on demand (a hash of OS-provided machine identifiers).
      let deviceFingerprint = 'unknown';
      let fingerprintSource = 'unavailable';
      try {
        const { generateDeviceFingerprint } = await import('../shared/device-fingerprint.js');
        const fp = await generateDeviceFingerprint();
        deviceFingerprint = fp.device_fingerprint;
        fingerprintSource = fp.fingerprint_source;
      } catch (err) {
        logEvent('device_fingerprint_failed', { error: err.message });
      }

      const body = {
        title: args.title,
        description: args.description,
        severity: args.severity || 'medium',
        component: args.component || null,
        reproduce_input: args.reproduce_input || null,
        context_blob: {
          ...(args.context_summary || {}),
          env: {
            os: process.platform,
            node: process.version,
            client_version: CLIENT_VERSION,
            fingerprint_source: fingerprintSource,
          },
        },
        bug_fingerprint: args.bug_fingerprint,
        related_lint_event_ids: Array.isArray(args.related_lint_event_ids)
          ? args.related_lint_event_ids
          : null,
        confirm_string: args.confirm_string,
        confirmation_declared: args.confirmation_declared,
        device_fingerprint: deviceFingerprint,
        client_tool: CLIENT_TOOL,
      };

      return await callApi('POST', '/api/bug-reports', body);
    }

    case "ownmind_report_compliance": {
      pushBounded(complianceEvents, { rule_title: args.rule_title, action: args.action, rule_code: args.rule_code || '', ts: new Date().toISOString() }, COMPLIANCE_EVENTS_MAX);
      logEvent('iron_rule_compliance', {
        rule_title: args.rule_title,
        rule_code: args.rule_code || null,
        action: args.action,
        context: args.context || null,
      });

      // E1: Write to compliance JSONL using shared module
      appendCompliance({
        event: args.rule_code || args.rule_title,
        action: args.action,
        rule_code: args.rule_code || '',
        rule_title: args.rule_title,
        source: 'mcp',
        session_id: sessionStartTime ? String(sessionStartTime) : '',
      });

      // E3: Auto-verify on trigger detection
      const trigger = detectTriggerFromContext(args.context);
      if (trigger) {
        try {
          const evalFn = await getEvaluateConditions();
          if (evalFn) {
            const rules = getCachedVerifiableRules().filter(r =>
              r.metadata?.verification?.trigger?.includes(trigger)
            );
            // v1.20.2 follow-up: read from the file rather than only the in-memory variable.
            // Background: ownmind_init resets the complianceEvents variable in the MCP process,
            // so anything in memory is wiped whenever the MCP process restarts. The pre-commit
            // hook reads the jsonl file and is unaffected by restarts. Using two different
            // sources leads to inconsistent behavior — the hook lets things through while
            // ownmind_report_compliance reports status: blocked.
            // Fix: merge the in-memory variable with the file; the file is the source of truth,
            // memory is just a session-scoped cache.
            const fileEvents = readComplianceEvents();
            const mergedEvents = [...complianceEvents, ...fileEvents];

            const failures = [];
            for (const rule of rules) {
              const conditions = rule.metadata?.verification?.conditions;
              if (!conditions) continue;
              const sessionChecks = extractSessionChecks(conditions);
              if (sessionChecks.length === 0) continue;
              const ctx = { complianceEvents: mergedEvents };
              const result = evalFn({ operator: 'AND', checks: sessionChecks }, ctx);
              if (!result.pass) {
                const shouldBlock = rule.metadata?.verification?.block_on_fail;
                failures.push({
                  rule_code: rule.code,
                  rule_title: rule.title,
                  block: !!shouldBlock,
                  failures: result.failures
                });
              }
            }
            const blockingFailures = failures.filter(f => f.block);
            if (blockingFailures.length > 0) {
              return {
                status: 'blocked',
                action: args.action,
                rule: args.rule_title,
                verification_failures: blockingFailures,
                message: `Blocked by verification: ${blockingFailures.map(f => f.rule_code || f.rule_title).join(', ')}`
              };
            }
          }
        } catch { /* verification engine not available, skip */ }
      }

      return { status: 'ok', action: args.action, rule: args.rule_title };
    }

    case "ownmind_upload_standard": {
      const { file_path, title } = args;
      if (!fs.existsSync(file_path)) {
        throw new Error(`File not found: ${file_path}`);
      }
      const rawContent = fs.readFileSync(file_path, 'utf8');
      const standardTitle = title || path.basename(file_path, '.md');
      const chunks = parseStandardMarkdown(rawContent, 3);
      
      const sessionId = Math.random().toString(36).substring(2, 10);
      pendingUploads.set(sessionId, { 
        parent_title: standardTitle, 
        chunks, 
        created_at: Date.now() 
      });
      
      return {
        session_id: sessionId,
        parent_title: standardTitle,
        chunk_count: chunks.length,
        preview: chunks.map(c => ({ title: c.title, level: c.level })),
        notice: "[OwnMind] Preview generated. Review each chunk and decide whether any should be saved as an iron_rule. If everything looks good, call ownmind_confirm_upload with this session_id."
      };
    }

    case "ownmind_confirm_upload": {
      const pending = pendingUploads.get(args.session_id);
      if (!pending) {
        throw new Error(`No pending upload found (Session ID: ${args.session_id})`);
      }
      
      // TTL check (10 minutes).
      if (Date.now() - pending.created_at > 10 * 60 * 1000) {
        pendingUploads.delete(args.session_id);
        throw new Error(`Upload session expired (Session ID: ${args.session_id}). Please call ownmind_upload_standard again.`);
      }
      
      const body = {
        parent_title: pending.parent_title,
        chunks: pending.chunks,
        sync_token: currentSyncToken,
      };
      
      const data = await callApi("POST", "/api/memory/batch-sync-standard", body);
      if (data.sync_token) currentSyncToken = data.sync_token;
      
      pendingUploads.delete(args.session_id);
      logEvent('memory_sync_standard', { title: pending.parent_title, stats: data.stats });

      return data;
    }

    case "ownmind_session_off": {
      // v1.20.3: temporarily disable this session's OwnMind hooks (lint + pre-commit).
      const sessionId = sessionStartTime ? String(sessionStartTime) : `noinit_${Date.now()}`;
      const existing = readSessionOffState();
      const alreadyOff = existing && existing.session_id === sessionId;

      const ok = writeSessionOffState(sessionId);
      if (!ok) {
        return {
          status: 'error',
          message: 'Failed to write state file — OwnMind remains in its current state (in other words: the disable did not take effect, the hooks will still run).',
        };
      }

      logEvent('session_off', { session_id: sessionId, reason: args.reason || null });

      return {
        status: 'ok',
        already_off: !!alreadyOff,
        message: alreadyOff
          ? 'OwnMind is already disabled. A new session will auto-restore, or call ownmind_session_on to re-enable immediately.'
          : 'OwnMind is now temporarily disabled (lint + pre-commit check skipped). A new session will auto-restore, or call ownmind_session_on to re-enable immediately. While disabled, every 10 AI responses you will see a terminal reminder.',
        session_id: sessionId,
      };
    }

    case "ownmind_session_on": {
      // v1.20.3: re-enable this session's OwnMind hooks.
      const existing = readSessionOffState();
      const wasOff = !!existing;
      clearSessionOffState();

      logEvent('session_on', { was_off: wasOff });

      return {
        status: 'ok',
        was_off: wasOff,
        message: wasOff
          ? 'OwnMind is re-enabled. The next AI response / git commit will run the hooks normally.'
          : 'OwnMind was already enabled; no action taken.',
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Server setup ---
const server = new Server(
  { name: "ownmind-mcp", version: CLIENT_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// v1.17.41 — Codex round 4 review fix:
// In v1.17.40 we wrote system observations as action='comply', which is self-deceptive — an
// integrity issue. Changed to action='observed_trigger': honestly says "the system observed
// a tool being called", instead of pretending "iron rule compliance has been verified".
// Also removed the handoff_create → commit-rule overreach (commit rules should be enforced
// by the git hook).
//
// Three-layer semantics:
//   - observed_trigger (system-automatic) = the system saw a trigger point; it does NOT prove compliance.
//   - comply (AI-initiated ownmind_report_compliance) = the AI claims compliance.
//   - verified_comply (reserved for future) = independently verified by a git hook or similar.
//
// In-memory dedup: sliding time window (same rule + tool within 60s counts once).
// v1.17.59 change: the original used a "minute bucket" as the key; :59 → :00 boundary hits
// would land in different buckets and both pass. Switched to Map<key, first_seen_ts> +
// sliding window to avoid the boundary bug.
const _autoComplyDedup = new Map();
function _dedupKey(name, ruleCode) {
  return `${ruleCode}|${name}`;
}

async function autoComplyForToolCall(name, args, result) {
  const triggers = [];
  // v1.26.32: de-identified. Keys on the neutral event RULE_FULL_LAYER_SYNC
  // instead of one user's personal rule code (the "anything learned must be
  // synced across all layers" discipline). rule_code is left empty;
  // cache-holding callers resolve the user's own code.
  const ruleTitle = getEventDisplayName(RULE_FULL_LAYER_SYNC);
  // ownmind_disable rule → full-layer-sync trigger.
  // We observe the "iron rule memory was disabled" trigger, but cannot prove that other
  // layers (OpenSpec, skills, etc.) were synced as well.
  if (name === 'ownmind_disable' &&
      (result?.type === 'iron_rule' || result?.memory?.type === 'iron_rule')) {
    triggers.push({
      triggered_by_event: RULE_FULL_LAYER_SYNC,
      rule_code: '',
      rule_title: ruleTitle,
      action: 'observed_trigger',
      context: `Iron rule disabled (id=${args.id}) — system observed the trigger; cross-layer sync not verified.`,
    });
  }
  // ownmind_save / ownmind_update with type=iron_rule
  if ((name === 'ownmind_save' && args.type === 'iron_rule') ||
      (name === 'ownmind_update' &&
       (result?.type === 'iron_rule' || result?.memory?.type === 'iron_rule'))) {
    triggers.push({
      triggered_by_event: RULE_FULL_LAYER_SYNC,
      rule_code: '',
      rule_title: ruleTitle,
      action: 'observed_trigger',
      context: `Iron rule ${name === 'ownmind_save' ? 'added' : 'updated'} (id=${args.id || result?.id || '?'}) — system observed; not verified.`,
    });
  }
  // Removed the handoff_create → commit-rule overreach.
  // Codex review: creating a handoff does NOT prove the commit followed those iron rules.
  // Those belong to the git hook, not to the MCP handoff handler self-claiming compliance.

  for (const trig of triggers) {
    // Dedup: same trigger event + same tool within 60s counts once (sliding window).
    const key = _dedupKey(name, trig.triggered_by_event);
    if (shouldSkipDuplicate(_autoComplyDedup, key, AUTO_COMPLY_DEDUP_TTL_MS)) continue;

    // logEvent writes to stderr on its own failure; the extra try/catch here MUST NOT swallow the message.
    try {
      logEvent('iron_rule_compliance', {
        rule_code: trig.rule_code,
        rule_title: trig.rule_title,
        triggered_by_event: trig.triggered_by_event,
        action: trig.action,
        context: trig.context,
        source: 'system_auto',
        tool_call: name,
      });
    } catch (e) {
      console.error('[autoComply] logEvent failed:', sanitizeErrorMessage(e?.message));
    }
    try {
      // Aligned with the manual ownmind_report_compliance path (mcp/index.js:907).
      appendCompliance({
        event: trig.triggered_by_event,
        action: trig.action,
        rule_code: trig.rule_code,
        rule_title: trig.rule_title,
        triggered_by_event: trig.triggered_by_event,
        source: 'system_auto',
        tool_call: name,
        context: trig.context,
      });
    } catch (e) {
      console.error('[autoComply] appendCompliance failed:', sanitizeErrorMessage(e?.message));
    }
    pushBounded(complianceEvents, {
      ...trig,
      source: 'system_auto',
      ts: new Date().toISOString(),
    }, COMPLIANCE_EVENTS_MAX);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // v1.18.9: measure "the latency the user actually feels before seeing the result",
  // including broadcast / autoComply / compose.
  const startedAt = Date.now();

  try {
    const result = await handleTool(name, args || {});
    // v1.17.40: auto-invoke iron_rule_compliance on the side (never blocks the main flow).
    // v1.17.41: no longer silent — errors go to stderr so at least debugging is possible.
    autoComplyForToolCall(name, args || {}, result).catch((e) => {
      console.error('[autoComply] failed:', sanitizeErrorMessage(e?.message));
    });
    const typeName = resolveType(name, args);
    const tag = formatTag(typeName);
    const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);

    // v1.17.0 P4: after every ownmind_* tool call, ping the server to request broadcast injection.
    // Never block the main flow: fetch failure → silent skip (a broadcast must not break the tool).
    const broadcastText = await fetchBroadcastsSafely();

    // v1.18.9: success path writes an mcp_call event including latency_ms.
    logMcpCallSafe({ logEvent, tool: name, latencyMs: Date.now() - startedAt, status: 'ok' });

    // v1.17.69: combine into a single text part. v1.17.0–v1.17.68 used 4 separate parts
    // (broadcast / prefix line / body / tip); most clients render them in order so the user
    // sees everything, but Claude Code's UI folds the card and visually swallows the gap
    // between parts — the final tip is completely hidden. Combining into one part is
    // consistent across all clients. Semantics: since v1.17.7 the tip is attached every time
    // (not once every 10 calls).
    return composeToolResponse({
      broadcastText,
      tag,
      body,
      tip: getRandomTip(),
      tipTag: formatTag('Tip'),
    });
  } catch (error) {
    // v1.18.9: error path also carries latency_ms (spread alongside the existing enrichErrorDetails result).
    const latencyMs = Date.now() - startedAt;
    logEvent('error', { ...enrichErrorDetails(error, name, args), latency_ms: latencyMs });
    logMcpCallSafe({ logEvent, tool: name, latencyMs, status: 'error' });
    const tag = formatTag('Error report');
    return {
      content: [
        {
          type: "text",
          text: `${tag}：${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// --- Auto-update check (background, non-blocking) ---
// v1.17.22 fix: root cause of Alice (Windows LAPTOP-G95HIQ3V) / Bob being stuck on old versions:
//   1. process.env.HOME is undefined on Windows; OWNMIND_DIR became a relative path, so the
//      whole block silently skipped. → switched to os.homedir() (cross-platform — reads
//      USERPROFILE on Windows automatically).
//   2. exec(bashScript) — the bash syntax can't be interpreted by Windows cmd, so even
//      when the path resolved correctly, no upgrade happened. → switched to execFile on
//      the git/npm binaries, cross-platform.
//   3. The branch where no condition holds originally did a silent return → added an
//      update_skipped event for observability.
const OWNMIND_DIR = path.join(os.homedir(), '.ownmind');
const MARKER_FILE = path.join(OWNMIND_DIR, '.last-mcp-update-check');
const LOCK_FILE = path.join(OWNMIND_DIR, '.update-lock');
const IS_WINDOWS = process.platform === 'win32';
const NPM_CMD = IS_WINDOWS ? 'npm.cmd' : 'npm';

import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
const execFile = promisify(_execFile);

// v1.17.60: use a module-scope flag so "inside runAutoUpdate" and "the outer catch" share state.
// Previously the outer catch unconditionally called unlinkSync(LOCK_FILE). If a future path
// introduces a "throw before acquiring the lock" case, this would delete another process's
// lock. Now we only cleanup if we actually hold the lock ourselves.
let _lockHeld = false;

async function runAutoUpdate() {
  // v1.26.124: local, not UTC — the one place in the MCP that had not adopted the timezone
  // rule its own logEvent established in v1.20.1. The shell hook computes this marker with
  // `date +%Y-%m-%d` and the Node hook now uses the same helper, so all three finally agree
  // on which day it is. While they did not, the eight hours a UTC+8 machine runs ahead of
  // UTC were a window in which each program read the other's marker as a different day,
  // reran the update, and rewrote the marker so the next session disagreed the other way.
  const today = localDateOnly();
  const lastCheck = fs.existsSync(MARKER_FILE)
    ? fs.readFileSync(MARKER_FILE, 'utf8').trim()
    : '';

  // Skip-reason observability — earlier silent-skip behavior meant Alice/Bob stayed on
  // old versions and nobody noticed.
  if (lastCheck === today) {
    logEvent('update_skipped', { source: 'mcp', reason: 'marker_today' });
    return;
  }
  if (!fs.existsSync(path.join(OWNMIND_DIR, '.git'))) {
    logEvent('update_skipped', { source: 'mcp', reason: 'no_git_dir', dir: OWNMIND_DIR });
    return;
  }

  // v1.17.23: atomic lock acquire — the previous existsSync + writeFileSync had a TOCTOU race.
  // v1.26.98: moved into shared/update-lock.js, which the Node SessionStart hook now uses too,
  // and which also closed the race in the stale-lock reclaim that used to sit above this
  // (stat, unlink, create — two processes could both unlink, the second deleting the fresh
  // lock the first had just taken). `reason` distinguishes a held lock from a disk error;
  // they mean different things to whoever reads the log.
  const acquired = tryAcquireUpdateLock(LOCK_FILE);
  if (!acquired.acquired) {
    if (acquired.reason === 'lock_held') {
      logEvent('update_skipped', { source: 'mcp', reason: 'lock_held' });
    } else {
      // v1.18.8: use errorAliasFields helper (shared with 'error' event); legacy `error` field preserved.
      logEvent('update_failed', {
        source: 'mcp',
        step: 'lock',
        error: acquired.reason,
        ...errorAliasFields(acquired.error),
      });
    }
    return;
  }
  _lockHeld = true;

  logEvent('update_check', { source: 'mcp' });

  const cleanup = () => {
    if (!_lockHeld) return;
    releaseUpdateLock(LOCK_FILE);
    _lockHeld = false;
  };
  const fail = (step, err) => {
    cleanup();
    logEvent('update_failed', {
      source: 'mcp',
      step,
      error: err?.code || err?.message || String(err).slice(0, 120),
    });
    // v1.26.129: whichever of the MCP and the bash hook takes the lock first does that day's
    // update, so reporting the outcome in only one of them makes the message a coin flip.
    queueUpdateBanner({ outcome: 'failed', step });
  };

  try {
    // git fetch
    try {
      await execFile('git', ['fetch', '-q'], { cwd: OWNMIND_DIR, timeout: 30000 });
    } catch (e) {
      return fail('fetch', e);
    }

    // Check whether there are new commits.
    let updates = '';
    try {
      const { stdout } = await execFile(
        'git', ['log', 'HEAD..origin/main', '--oneline'],
        { cwd: OWNMIND_DIR, timeout: 10000 }
      );
      updates = String(stdout || '').trim();
    } catch (e) {
      return fail('log', e);
    }

    if (!updates) {
      cleanup();
      try { fs.writeFileSync(MARKER_FILE, today); } catch {}
      logEvent('update_clean', { source: 'mcp' });
      return;
    }

    // New version detected, continue.
    // v1.17.23: use --autostash (git 2.6+) instead of the manual-stash / no-pop flow.
    // The old manual stash never popped, so uncommitted user changes got stuck in the stash forever.
    // v1.17.65: the fallback no longer passes --autostash. Previously both the main path and
    // the fallback used --autostash, so on git < 2.6 both failed — there was effectively no
    // fallback. Switched to --ff-only: a dirty tree is rejected and we logEvent it so the user
    // can fix it themselves. We must NEVER do a manual stash (v1.17.22 proved it eats changes
    // when not popped).
    try {
      await execFile('git', ['pull', '-q', '--rebase', '--autostash'],
        { cwd: OWNMIND_DIR, timeout: 30000 });
    } catch {
      try {
        await execFile('git', ['pull', '-q', '--ff-only'],
          { cwd: OWNMIND_DIR, timeout: 30000 });
      } catch (e) {
        return fail('pull', e);
      }
    }

    // npm install — on Windows we must use npm.cmd and go through the shell.
    // v1.17.62: as of Node v18.20.2 / v20.12.2 / v21.7.3 (CVE-2024-27980 patch), execFile
    // can no longer run .cmd / .bat files directly — shell:true is required. Bob's
    // update_failed step=npm error=EINVAL was exactly this. Mac / Linux are unaffected,
    // so we only enable the shell on Windows.
    try {
      await execFile(NPM_CMD, ['install', '-q'], {
        cwd: path.join(OWNMIND_DIR, 'mcp'),
        timeout: 120000,
        windowsHide: true,
        shell: IS_WINDOWS,
      });
    } catch (e) {
      return fail('npm', e);
    }

    // Sync skill / hook: run update.sh on Unix, update.ps1 on Windows.
    try {
      if (IS_WINDOWS) {
        await execFile(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(OWNMIND_DIR, 'scripts', 'update.ps1')],
          { cwd: OWNMIND_DIR, timeout: 60000, windowsHide: true }
        );
      } else {
        await execFile('bash', [path.join(OWNMIND_DIR, 'scripts', 'update.sh')],
          { cwd: OWNMIND_DIR, timeout: 60000 });
      }
    } catch (e) {
      return fail('update_sh', e);
    }

    cleanup();
    try { fs.writeFileSync(MARKER_FILE, today); } catch {}
    logEvent('update_applied', { source: 'mcp' });
    // Read the version now, not earlier: the pull just changed it, and CLIENT_VERSION is the
    // value this process cached at module load — i.e. the version the user was leaving.
    queueUpdateBanner({ outcome: 'applied', version: getClientVersion() });

    // v1.17.62: after a successful upgrade, re-send one heartbeat that reads the **new**
    // package.json from disk, so the server sees the new version without waiting for the user
    // to restart their AI tool.
    // Why: CLIENT_VERSION is a constant cached at module-load time; after auto-update the disk
    // is fresh but this process's in-memory value is still old. The previous sendMcpHeartbeat
    // used the cached value, and the heartbeatSent flag only fires once per process — so a
    // long-running MCP process would forever report the old version (the root cause of
    // Dana / Alice being stuck).
    // 5-second timeout (callApi itself has no timeout); on failure, log an observation event.
    try {
      const rootPkg = new URL('../package.json', import.meta.url);
      const freshVersion = JSON.parse(fs.readFileSync(rootPkg, 'utf8')).version;
      if (freshVersion && freshVersion !== CLIENT_VERSION) {
        await Promise.race([
          callApi('POST', '/api/usage/events', {
            events: [],
            heartbeat: {
              tool: CLIENT_TOOL,
              scanner_version: freshVersion,
              machine: os.hostname(),
              os: os.platform(),
            },
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('heartbeat_timeout_5s')), 5000)),
        ]);
      }
    } catch (e) {
      // Log on failure so the dashboard can monitor how reliable the post-upgrade heartbeat is.
      try {
        logEvent('update_heartbeat_failed', {
          source: 'mcp',
          error: e?.code || e?.message || String(e).slice(0, 120),
        });
      } catch {}
    }
  } catch (e) {
    fail('unknown', e);
  }
}

// Fire-and-forget — must not block MCP startup.
// v1.17.23: the catch is no longer silent — any unexpected error writes update_failed step=outer.
// v1.17.60: only cleanup when we actually hold the lock, to avoid deleting another process's lock.
runAutoUpdate().catch((e) => {
  try {
    logEvent('update_failed', {
      source: 'mcp',
      step: 'outer',
      error: e?.code || e?.message || String(e).slice(0, 120),
    });
  } catch {}
  if (_lockHeld) {
    releaseUpdateLock(LOCK_FILE);
    _lockHeld = false;
  }
});

// --- Emergency shutdown: persist the session log ---
async function emergencySessionLog(reason = 'mcp_shutdown') {
  if (sessionLogged || !sessionStartTime) return;
  const totalCalls = Object.values(toolCallCounts).reduce((a, b) => a + b, 0);
  if (totalCalls <= 1) return; // only init was called — don't log
  sessionLogged = true; // prevent repeated triggers

  const summary = `[auto] ${AUTO_PROJECT ? AUTO_PROJECT + ' · ' : ''}${Object.entries(toolCallCounts).map(([k, v]) => `${k}:${v}`).join(', ')}`;
  // v1.17.37: auto-attach project + duration_turns so the report page can group by project.
  const turns = Math.max(1, Math.round(totalCalls / 2));  // estimate conversation turns (~2 tool calls per turn)
  const details = {
    _recovery: reason,
    project: AUTO_PROJECT || undefined,  // ⚠️ undefined gets stripped by sanitizeDetails
    duration_ms: Date.now() - sessionStartTime,
    duration_turns: turns,
    tool_calls: { ...toolCallCounts },
    compliance: [...complianceEvents],
  };

  // 1. Write to the local JSONL log (resilient to power loss / network outage).
  logEvent('session_log_emergency', { summary, ...details });

  // 2. best-effort POST to server, with timeout
  try {
    await Promise.race([
      callApi('POST', '/api/session', {
        summary,
        tool: CLIENT_TOOL,
        model: 'unknown',
        details,
        sync_token: currentSyncToken,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    // Silent fail — local JSONL is the safety net
  }
}

// v1.17.37: trigger on multiple exit signals — SIGTERM/SIGINT for graceful exit,
// SIGHUP for terminal close, process.on('exit') as the synchronous last-chance fallback.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, async () => {
    await emergencySessionLog('signal_' + sig);
    process.exit(0);
  });
}
// 'exit' is a synchronous event — async writes can't complete; we can only fire-and-forget
// logEvent (which writes to the local JSONL).
process.on('exit', () => {
  if (!sessionLogged && sessionStartTime) {
    const totalCalls = Object.values(toolCallCounts).reduce((a, b) => a + b, 0);
    if (totalCalls > 1) {
      logEvent('session_log_emergency', {
        summary: `[exit_sync] ${AUTO_PROJECT ? AUTO_PROJECT + ' · ' : ''}${totalCalls} calls`,
        project: AUTO_PROJECT,
        _recovery: 'process_exit',
        tool_calls: { ...toolCallCounts },
      });
    }
  }
});

// Fire-and-forget heartbeat on every MCP startup so already-installed users
// appear as "installed" in Admin without manually running ownmind_init.
// UPSERT keyed by (user_id, tool) — repeat calls just refresh last_reported_at.
sendMcpHeartbeat();

const transport = new StdioServerTransport();
await server.connect(transport);
