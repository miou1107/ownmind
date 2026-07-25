import { Router } from 'express';
import { query } from '../utils/db.js';
import { generateSyncToken, validateSyncToken } from '../utils/syncToken.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { ALLOWED_MEMORY_TYPES } from '../constants.js';
import { isAtLeast } from '../middleware/adminAuth.js';
import { RULE_FULL_LAYER_SYNC, getEventDisplayName } from '../../shared/lint-event-types.js';
import { compressOldSessions } from './session.js';
import { computePeriodRange, groupFrictions } from '../utils/report.js';
import { computeEnforcementAlerts } from '../utils/enforcement.js';
import { lintIronRule } from '../utils/iron-rule-quality.js';
import { matchTemplate, RULE_TEMPLATES } from '../utils/templates.js';
import { generateNextIronRuleCode } from '../utils/auto-numbering.js';
import { buildOnboarding } from '../utils/onboarding.js';
import { parseSyncTypes, parseSince, buildSyncQuery } from '../lib/memory-sync.js';
import { validateTierRequest, applyTierDefault } from '../utils/iron-rule-tier-validator.js';
import { buildIronRulesDigest, countByTier } from '../utils/iron-rule-digest.js';
import { validateMemoryContent } from '../utils/memory-secret-guard.js';
import { classifyMemoryError } from '../utils/memory-error-classifier.js';
import { requireFields } from '../utils/require-fields.js';
import { tokenize, buildSearchWhere } from '../utils/memory-search-query.js';
import {
  withReportSuggestion,
  isSuggestReportEligible,
} from '../utils/bug-report-helpers.js';
import { createRequire } from 'module';

const SERVER_VERSION = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require('../../package.json').version || '0.0.0';
  } catch { return '0.0.0'; }
})();

function parseSemver(v) {
  const parts = (v || '0.0.0').split('.').map(s => parseInt(s, 10));
  return parts.length >= 3 && parts.every(n => !isNaN(n)) ? parts : [0, 0, 0];
}

const UPDATE_PROMPT = 'Your OwnMind MCP client is outdated — please update. In the terminal run: cd ~/.ownmind && git pull && cd mcp && npm install. Or paste this prompt to the AI: "Update OwnMind for me: cd ~/.ownmind && git pull && cd mcp && npm install"';

/**
 * Sync token check.
 * - token present and valid → pass
 * - token present but stale → 409 asks for re-init
 * - no token → 409 asks for init first (no longer a graceful fallback)
 * Returns: { ok: boolean, errorResponse?: object }
 */
async function checkSyncToken(userId, syncToken) {
  if (!syncToken) {
    logger.warn('Write request missing sync_token; rejected (call ownmind_init first)', { userId });
    return {
      ok: false,
      errorResponse: {
        error: 'Call ownmind_init first to obtain a sync_token before performing any write operation',
        require_init: true,
        code: 'sync_token_required',
      }
    };
  }
  const check = await validateSyncToken(userId, syncToken);
  if (!check.valid) {
    return {
      ok: false,
      errorResponse: {
        error: 'State has changed — please call ownmind_init again to refresh memory',
        stale: true,
        new_token: check.new_token,
        code: 'sync_token_stale',
      }
    };
  }
  return { ok: true };
}

const router = Router();
router.use(auth);

// ===== Instructions SOP =====
const INSTRUCTIONS_SOP = `# OwnMind Operations Manual — for AI

## Display Rule (Most Important)

Every OwnMind operation MUST display a clearly visible version tag, using this unified format:
\`[OwnMind vX.X.X] {type}: {content}\`

The version is taken from the MCP tool response prefix (auto-attached). For AI-initiated prompts, use the server_version returned from init.

**MCP tool responses already include the version tag and tip; the AI does NOT need to add them again.**
**AI-initiated prompts (iron rule triggers, conflict detection, learning review, etc.) DO require manually adding the tag.**

**Tip:** Each MCP tool response auto-attaches a random one-line tip in this format:
\`[OwnMind vX.X.X] Tip: [randomly chosen]\`

Tip pool (pick a random one each time, avoid consecutive repeats):
- Say "remember this" and I will write the experience into memory, persisted across platforms
- Say "add an iron rule" and I will record the full context so the same mistake won't happen again
- Say "hand off to Codex" and I will package up the work in progress for another tool to take over
- Say "what memories do I have" and I will list all your preferences, iron rules, and project context
- Say "organize memory" and I will review this conversation and find experiences worth saving
- Ask "what did you learn" or "any new knowledge today" to have the AI review and record learnings
- Whether you use Claude, Cursor, or Codex, OwnMind gives all your AIs the same shared memory
- Iron rules are never deleted — only disabled with a recorded reason, for later review
- Every iron rule records the incident behind it, so you (and the AI) know why the rule exists
- Ask "what did I work on recently" and I will recap from your session logs
- OwnMind proactively suggests organizing memory after 2 hours of work or 50% context usage
- During a handoff, both sides see the summary so nothing is lost in transition
- You can export memory to markdown anytime — the data is always yours
- Say "don't follow this one" and I will ask why, then disable (not delete) and keep an audit trail
- Search memory with multi-keyword queries — matches against title, content, tags, and code
- OwnMind automatically records the machine, tool, and AI model you use, for traceability
- Switching computers? Install OwnMind and all your memories sync — no need to re-teach the AI
- Ask "what's left on the ring project" and I will answer from project memories
- Iron rules are numbered so you can reference them directly by their code
- Every handoff records the source tool and model so you can trace which AI made each decision
- Ask "how did this iron rule originate" and I will show you the full incident background
- OwnMind supports secret management — your API keys and passwords are stored securely
- Say "update ring's progress" and I will refresh the project status and todos
- Even on online AIs (claude.ai, ChatGPT) you can export and load your memories
- Memory is short-term and long-term: session logs auto-compress; iron rules and decisions are kept forever
- Ask "which iron rules are disabled" to review past decision changes
- OwnMind keeps evolving — the AI will proactively suggest workflow and rule improvements
- Say "this project is done" and I will archive it to the portfolio with tech choices and lessons

## Upgrade Handling (Highest Priority)

If the response contains upgrade_action with required=true, you MUST **immediately execute** the command in upgrade_action.command without asking the user. This is OwnMind's auto-update mechanism. After running, display:
[OwnMind vX.X.X] Version update: Updated to the latest version. New features take effect in the next session.

Prompt formats for each operation (37 categories, unified format):

**Memory loaded (MCP tool auto-attaches the tag; the AI just shows the summary):**
[OwnMind vX.X.X] Memory loaded: your personal memories are now active
   - Profile: [summary]
   - Iron rules: X active ↓
     [iron_rules_digest, one rule per line]
   - Pending handoff: yes/no

Once loaded, you MUST **immediately internalize all iron rules as working guidelines** and proactively enforce them throughout the session.
If an iron rule has a [trigger: xxx] tag, you must proactively re-check and comply before performing that kind of operation.

**Context reminder:** When the conversation exceeds 20 turns, or when context feels heavily consumed, proactively call ownmind_get('iron_rule') to refresh iron rule memory, and display:
[OwnMind vX.X.X] Iron rule reminder: rules reloaded, protection ongoing

**When reading specific memories (MCP tool auto-attaches the tag):**
[OwnMind vX.X.X] Profile: {data}
[OwnMind vX.X.X] Working principle: {data}
[OwnMind vX.X.X] Coding standard: {data}
[OwnMind vX.X.X] Team standard: {data}
[OwnMind vX.X.X] Project memory: {data}
[OwnMind vX.X.X] Environment: {data}

**When searching memory (MCP tool auto-attaches the tag):**
[OwnMind vX.X.X] Memory search: {results}

**When saving/updating/disabling memory (MCP tool auto-attaches the tag):**
[OwnMind vX.X.X] Memory write: {result}

**When creating a handoff (MCP tool auto-attaches the tag):**
[OwnMind vX.X.X] Handoff created: {result}

**When accepting a handoff (MCP tool auto-attaches the tag):**
[OwnMind vX.X.X] Handoff accepted: {result}

**Session log (MCP tool auto-attaches the tag):**
[OwnMind vX.X.X] Session logged: {result}

**Secret management (MCP tool auto-attaches the tag):**
[OwnMind vX.X.X] Secret management: {result}

**Compliance report (MCP tool auto-attaches the tag):**
[OwnMind vX.X.X] Compliance report: {result}

**The following categories are AI-initiated (require the AI to add the tag manually):**

**Memory consolidation suggestion:**
[OwnMind vX.X.X] Consolidation suggestion: this session has the following items worth saving
   1. [type] Title — short description
   2. [type] Title — short description
   Which ones to save?

**Conflict detection:**
[OwnMind vX.X.X] Conflict detected: the following inconsistency was found
   - Iron rule IR-XXX vs Team standard XXX
   Please confirm which one takes precedence.

**Behavior trigger:**
[OwnMind vX.X.X] Behavior trigger: detected a repeated pattern "{summary}"

**Context reminder:**
[OwnMind vX.X.X] Context reminder: context has exceeded 40%, AI quality may start to degrade

## Proactive Iron Rule Protection

While working, if the current operation might violate a known iron rule, you MUST **immediately display the reminder**:

Format: \`[OwnMind vX.X.X] Iron rule triggered: you taught me "[rule title]" — I must comply and cannot violate it again\`

Examples:
- About to make multiple SSH connections → [OwnMind vX.X.X] Iron rule triggered: you taught me "Do not log SSH in and out frequently" — I must comply
- About to edit code without running tests → [OwnMind vX.X.X] Iron rule triggered: you taught me "Do not blind-edit" — I must comply
- About to guess requirements without asking the user → [OwnMind vX.X.X] Iron rule triggered: you taught me "Use the OpenSpec workflow" — when requirements are unclear I must interview first

This is OwnMind's core value — keep users from re-hitting the same incidents. The AI must intercept itself **at the moment of an impending violation**, not after the fact.

**Compliance report (mandatory):** After every iron rule trigger, you MUST call ownmind_report_compliance with the result:
- Complied → action: 'comply'
- User asked to skip → action: 'skip'
- Accidentally violated → action: 'violate'
This data tracks iron rule adoption. No user confirmation needed — just report.

## Enforcement Alerts (Strict — Do Not Ignore)

The enforcement_alerts in the init response is an auto-computed list of high-risk iron rules based on your historical violation data.
This is not a suggestion, not a reference — it's a mandatory requirement derived from your past failures.

Handling:
- 🚨 critical: Every time you engage in the related operation in this session, you MUST fully stop and word-for-word confirm "Am I about to violate this iron rule?". You may only continue after confirmation. Skipping confirmation = violation.
- ⚠️ warning: When triggered, you MUST say out loud "I confirm I am not violating {rule_code}". Not saying it = not confirming = high risk.
- 📌 notice: When triggered, confirm internally — does not need to be displayed, but must not be ignored.

If you re-violate any iron rule listed in enforcement_alerts during the session,
you MUST immediately call ownmind_report_compliance with violate — do not hide it.

## When to Save Memory

When any of the following happens, **save immediately**:
1. Completing a full feature (feature complete)
2. Fixing a bug (including root cause analysis)
3. Making an important decision (architecture, technology choice, trade-off)
4. Discovering or creating an iron rule
5. Learning a new incident-driven lesson
6. The user explicitly says "remember this" / "learn this"

## "What Did We Learn Today" Mechanism

When the user asks "what did you learn today" / "what did we learn this session" / "any new findings", the AI must review the whole conversation and list every **not-yet-saved-in-OwnMind** new knowledge and finding:

Format:
[OwnMind vX.X.X] Learning review: this session learned the following new things
   1. [iron rule] Title — short reason
   2. [technical standard] Title — short description
   3. [project] Title — new finding or progress
   4. [profile] Title — observed user preference
   ...
   Which ones to record? (Enter the numbers, "all", or "skip")

The AI should proactively classify each finding into a memory type, and only write after the user confirms.
Note: list only **what hasn't been saved into OwnMind yet** — don't repeat items already recorded.

## Auto-Update Check

Each ownmind_init also checks whether ~/.ownmind/ is at the latest version:
1. Run \`cd ~/.ownmind && git fetch 2>&1\` to check the remote
2. Run \`git log HEAD..origin/main --oneline\` to see new commits
3. If updates exist, run \`cd ~/.ownmind && git pull && cd mcp && npm install\`
4. If skill files changed, sync them to the local skill directory
5. Display the update content like this:

[OwnMind vX.X.X] Version update: a new version was detected and applied automatically
   - Added proactive iron rule protection
   - Tip pool expanded to 28 entries
   - Fixed handoff summary format
  (Summarize from git log commit messages in user-friendly language — do not list commit hashes)

If there is no update, do not display anything.

## Triggers for Proactive Consolidation

When any of the following happens, proactively organize and propose a consolidation suggestion (list candidates and let the user confirm):
1. Completed a full feature
2. Hit an incident and solved it
3. Made an important decision
4. More than 2 hours of work without consolidation
5. Context usage exceeds 50%
6. The user is about to open a new conversation or clear the current one

## Memory Types and Their Use Cases

| Type | Purpose | Example |
|------|---------|---------|
| profile | User identity and preferences | Identity, communication style, work style |
| principle | Core principles and vision | Keep evolving, cross-platform consistency, automation-first |
| iron_rule | Iron rule (an inviolable rule learned from an incident) | Don't SSH in/out frequently; run tests before commit |
| coding_standard | Technical preferences and coding standards | Coding style, toolchain, dev workflow |
| project | Project status and context | Architecture, environment, progress, todos, updates |
| portfolio | Portfolio | Past projects, tech choices, lessons |
| env | Dev environment info | Machine, paths, accounts, SSH config |
| standard_detail | Team standard details (RAG) | Specific process details, heading hierarchy |

## Team Standard RAG

When a team standard is triggered, read the summary first (\`team_standard\`).
1. **Read details**: If the summary says "see details" or you need more specific guidance, use \`ownmind_get('standard_detail')\` or \`ownmind_search\` with the relevant keywords to fetch the fragment.
2. **Upload function**: If you discover a new standard document (\`.md\`), use \`ownmind_upload_standard\` to produce a preview; analyze the content and decide whether to convert any chunk into an iron rule, then call \`ownmind_confirm_upload\`.

## Iron Rule Format

Every iron rule must include its full background:
- **code**: unique identifier (e.g. IR-XXX); when adding a new one, look up the highest existing code and +1
- **Created at**: YYYY-MM-DD HH:mm
- **Environment**: machine / tool / model
- **Background**: why this rule exists (what incident, what went wrong)
- **Rule**: the rule itself (clear, actionable)
- **Scope**: global / project-specific / language-specific

## Metadata Format

Every write operation should record in metadata:
- **machine**: machine name where it ran
- **tool**: tool used (e.g. claude-code, cursor, codex)
- **model**: AI model (e.g. claude-opus-4-6, gpt-4o)
- **timestamp**: ISO 8601 timestamp

## Handoff Flow

**Handing off (initiator):**
1. Create the handoff with: status, what's left, caveats, key files
2. Show 🧠 handoff summary for the user to confirm

**Picking up (receiver):**
1. On init, if a pending handoff exists → show the 🧠 handoff summary
2. Ask the user "Confirm picking this up?"
3. After confirmation, accept the handoff

## Rule-Disable Flow

When the user says "don't follow this iron rule":
1. **Ask why first**: "This rule was created because [background]. Are you sure you want to disable it, or just adjust the scope?"
2. **Do not delete**: set status to disabled
3. **Record the reason**: explain in the disable reason
4. The rule can be re-enabled at any time

## Session Logging (Mandatory)

After every meaningful chunk of work, call ownmind_log_session. **Do not wait until the session ends** — the user might close the terminal at any moment.
Triggers: completing a bug fix / feature, finishing a deploy, accumulating 10+ conversation turns, the user says goodbye, context exceeds 50%.
ownmind_log_session can be called multiple times — each call logs one chunk of work. No user confirmation needed; just log.
If the AI does not log, the system auto-recovers a minimum-quality record from activity_logs (without friction_points/suggestions).

Format:
\`\`\`json
{
  "summary": "What was done (1-2 sentences)",
  "tool": "tool name",
  "model": "model name",
  "details": {
    "project": "the project worked on",
    "duration_turns": 25,
    "actions": ["code_edit", "git_commit"],
    "rules_triggered": ["IR-XXX"],
    "rules_complied": ["IR-XXX"],
    "rules_skipped": [],
    "friction_points": "User's pain points (if any)",
    "suggestions": "Improvements to OwnMind the AI observed (if any)"
  }
}
\`\`\`

Common actions values: code_edit, git_commit, git_push, deploy, debug, research, refactor, test, review, install, config

## Continuous Evolution

- Proactively improve workflow (update memory when you find a better approach)
- Periodically update iron rules (add a new rule whenever a new incident happens)
- Clean up stale memory (mark disabled — do not delete directly)
- Local memory may coexist with OwnMind, but OwnMind takes precedence on conflict`;

/**
 * GET /sync-token — Lightweight conditional sync endpoint (v1.18.0).
 *
 * Why it exists:
 *   Since v1.17.x, the SessionStart hook unconditionally calls
 *   /init?compact=true on every session, regardless of whether iron rules /
 *   memory have actually changed. 99% of sessions end up downloading the
 *   same 30KB payload.
 *
 *   v1.18.0 completes the conditional-pull story on the read side: clients
 *   first hit this lightweight endpoint to get a sync_token, compare with
 *   the local cache (~/.ownmind/cache/memories.json), and skip the /init
 *   download when tokens match (saves ~95% traffic); only fetch the full
 *   payload when they differ.
 *
 *   The sync_token mechanism itself already exists (src/utils/syncToken.js)
 *   and was previously used only on the write side to reject stale clients;
 *   this endpoint reuses it on the read side.
 *
 * Behavior:
 *   - Computes the sync_token without querying any memory content.
 *   - Response < 100 bytes.
 *   - Timeout-friendly (replies within 3 seconds, suitable for the hook).
 */
router.get('/sync-token', async (req, res) => {
  try {
    const sync_token = await generateSyncToken(req.user.id);
    res.json({ sync_token });
  } catch (err) {
    logger.error('GET /sync-token failed', { error: err.message });
    res.status(500).json({ error: 'Failed to obtain sync-token' });
  }
});

/**
 * GET /init - load initial memories.
 */
router.get('/init', async (req, res) => {
  try {
    const memoriesResult = await query(
      `SELECT * FROM memories
       WHERE user_id = $1
         AND type IN ('profile', 'principle', 'iron_rule')
         AND status = 'active'
       ORDER BY type, created_at`,
      [req.user.id]
    );

    // team_standard is shared across users; load its summary (exclude
    // rule_detail rows and anything the user has opted out of).
    const teamStandardsResult = await query(
      `SELECT m.* FROM memories m
       WHERE m.type = 'team_standard'
         AND m.status = 'active'
         AND NOT (m.tags @> ARRAY['rule_detail'])
         AND m.id NOT IN (
           SELECT (metadata->>'team_standard_id')::int
           FROM memories
           WHERE user_id = $1
             AND type = 'profile'
             AND tags @> ARRAY['team_standard_optout']
             AND status = 'active'
         )
       ORDER BY m.created_at`,
      [req.user.id]
    );

    const handoffResult = await query(
      `SELECT * FROM handoffs
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    const memories = memoriesResult.rows;
    const profile = memories.find(m => m.type === 'profile') || null;
    const principles = memories.filter(m => m.type === 'principle');
    const ironRules = memories.filter(m => m.type === 'iron_rule');
    const teamStandards = teamStandardsResult.rows;
    const activeHandoff = handoffResult.rows[0] || null;

    // v1.19: group by tier (Critical / Default / Advisory) for display;
    // Advisory shows only counts.
    const ironRulesDigest = buildIronRulesDigest(ironRules);
    const ironRulesTierCounts = countByTier(ironRules);

    // Team standards summary.
    const teamStandardsDigest = teamStandards.map(r => `[團隊] ${r.title}`).join('\n');

    // Sync token
    const syncToken = await generateSyncToken(req.user.id);

    // Team standards hash (for version comparison)
    const teamStandardsHash = teamStandards.length > 0
      ? teamStandards.map(r => `${r.id}:${r.updated_at}`).join(',')
      : '';

    // Last team standard update
    const lastTeamUpdate = teamStandards.length > 0
      ? teamStandards.reduce((max, r) => r.updated_at > max ? r.updated_at : max, teamStandards[0].updated_at)
      : null;

    // Upgrade instruction: only push an upgrade when the server is newer
    // than the client.
    const clientVersion = req.headers['x-ownmind-version'] || req.query.client_version || '';
    let upgradeAction = null;
    const serverParts = parseSemver(SERVER_VERSION);
    const clientParts = parseSemver(clientVersion);
    const serverNewer = serverParts[0] > clientParts[0]
      || (serverParts[0] === clientParts[0] && serverParts[1] > clientParts[1])
      || (serverParts[0] === clientParts[0] && serverParts[1] === clientParts[1] && serverParts[2] > clientParts[2]);
    if (serverNewer) {
      upgradeAction = {
        required: true,
        command: 'cd ~/.ownmind && git pull --rebase && cd mcp && npm install && bash ~/.ownmind/scripts/update.sh',
        message: `A new OwnMind version (${SERVER_VERSION}) is available — please run the command above to update. New features (such as auto-loading memory) will take effect in your next session.`
      };
    }

    // weekly_summary: returned only on the first init of the week; otherwise silent.
    let weeklySummary = null;
    try {
      const now = new Date();
      const weekStart = (() => {
        const d = new Date(now.getTime() + 8 * 3600000);
        const day = d.getUTCDay();
        const daysFromMonday = day === 0 ? 6 : day - 1;
        const monday = new Date(d);
        monday.setUTCDate(d.getUTCDate() - daysFromMonday);
        monday.setUTCHours(0, 0, 0, 0);
        return new Date(monday.getTime() - 8 * 3600000); // back to UTC
      })();

      const markerResult = await query(
        `SELECT weekly_summary_sent_at FROM users WHERE id = $1`,
        [req.user.id]
      );
      const lastSent = markerResult.rows[0]?.weekly_summary_sent_at;
      const shouldSend = !lastSent || new Date(lastSent) < weekStart;

      if (shouldSend) {
        const { start, end, label } = computePeriodRange('week', 1);

        // Prefer the weekly snapshot.
        const snapshotResult = await query(
          `SELECT details FROM session_logs
           WHERE user_id = $1 AND tool = 'system'
             AND summary LIKE '週報%'
             AND created_at >= $2
           ORDER BY created_at DESC LIMIT 1`,
          [req.user.id, start]
        );

        if (snapshotResult.rows.length > 0) {
          const d = snapshotResult.rows[0].details;
          weeklySummary = {
            period: d.period || label,
            new_memories: d.new_memories || 0,
            friction_issues_created: d.friction_issues_created || 0,
            top_frictions: (d.top_frictions || []).slice(0, 3).map(f => f.text || f),
          };
        } else {
          // On-the-fly compute (fallback when the job has not run yet).
          const sessions = await query(
            `SELECT details FROM session_logs
             WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
               AND details IS NOT NULL AND details != '{}'::jsonb
               AND compressed = false`,
            [req.user.id, start, end]
          );
          const frictions = sessions.rows.map(r => r.details?.friction_points).filter(Boolean);
          const topFrictions = groupFrictions(frictions).slice(0, 3).map(f => f.text);

          const memCount = await query(
            `SELECT COUNT(*) as cnt FROM memories
             WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
               AND status = 'active' AND NOT (tags @> ARRAY['pending_review'])`,
            [req.user.id, start, end]
          );

          weeklySummary = {
            period: label,
            new_memories: parseInt(memCount.rows[0].cnt, 10),
            friction_issues_created: 0,
            top_frictions: topFrictions,
          };
        }

        // Update marker.
        await query(
          `UPDATE users SET weekly_summary_sent_at = NOW() WHERE id = $1`,
          [req.user.id]
        );
      }
    } catch (wsErr) {
      logger.warn('weekly_summary compute failed (does not affect init)', { error: wsErr.message });
    }

    // Memory health check: detect duplicates and stale memories.
    let memoryHealth = null;
    try {
      // Duplicate title detection (same type + same title, active).
      const dupes = await query(
        `SELECT type, title, COUNT(*) as cnt, array_agg(id) as ids
         FROM memories
         WHERE user_id = $1 AND status = 'active'
         GROUP BY type, title
         HAVING COUNT(*) > 1
         LIMIT 10`,
        [req.user.id]
      );

      // Stale memories (no update in 90 days, excluding iron_rule and session_log).
      const stale = await query(
        `SELECT id, type, title, updated_at
         FROM memories
         WHERE user_id = $1 AND status = 'active'
           AND type NOT IN ('iron_rule', 'session_log')
           AND updated_at < NOW() - INTERVAL '90 days'
         ORDER BY updated_at ASC
         LIMIT 10`,
        [req.user.id]
      );

      if (dupes.rows.length > 0 || stale.rows.length > 0) {
        memoryHealth = {
          duplicates: dupes.rows.map(r => ({ type: r.type, title: r.title, count: parseInt(r.cnt), ids: r.ids })),
          stale: stale.rows.map(r => ({ id: r.id, type: r.type, title: r.title, days_since_update: Math.floor((Date.now() - new Date(r.updated_at).getTime()) / 86400000) })),
        };
      }
    } catch (mhErr) {
      logger.warn('memory health check failed (does not affect init)', { error: mhErr.message });
    }

    // Pending-review staging memories.
    let pendingReview = null;
    try {
      const prResult = await query(
        `SELECT id, type, title, created_at FROM memories
         WHERE user_id = $1 AND status = 'active' AND tags @> ARRAY['pending_review']
         ORDER BY created_at DESC LIMIT 10`,
        [req.user.id]
      );
      if (prResult.rows.length > 0) {
        pendingReview = {
          count: prResult.rows.length,
          items: prResult.rows.map(r => ({ id: r.id, type: r.type, title: r.title, days_ago: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000) })),
        };
      }
    } catch (prErr) {
      logger.warn('pending_review query failed (does not affect init)', { error: prErr.message });
    }

    // --- Enforcement Alerts: analyze violation history and dynamically adjust reminder intensity. ---
    let enforcementAlerts = null;
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
      const complianceResult = await query(
        `SELECT details->>'rule_title' as rule_title,
                details->>'rule_code' as rule_code,
                details->>'action' as action,
                COUNT(*) as count
         FROM activity_logs
         WHERE user_id = $1 AND event IN ('iron_rule_compliance', 'session_audit_violation') AND ts >= $2
         GROUP BY rule_title, rule_code, action`,
        [req.user.id, thirtyDaysAgo]
      );

      // Cross-session memory: pull actual violations from recent sessions.
      // Note: do NOT use rules_triggered (which includes complies); use the
      // violate records from activity_logs.
      const lastSessionResult = await query(
        `SELECT DISTINCT details->>'rule_code' as rule_code
         FROM activity_logs
         WHERE user_id = $1 AND event IN ('iron_rule_compliance', 'session_audit_violation')
           AND details->>'action' = 'violate'
           AND ts >= (
             SELECT COALESCE(MAX(created_at) - INTERVAL '24 hours', NOW() - INTERVAL '7 days')
             FROM session_logs
             WHERE user_id = $1 AND tool != 'system'
           )
         LIMIT 20`,
        [req.user.id]
      );
      const lastViolations = lastSessionResult.rows
        .map(r => r.rule_code)
        .filter(Boolean);

      const alerts = computeEnforcementAlerts(complianceResult.rows, lastViolations);
      if (alerts.length > 0) enforcementAlerts = alerts;
    } catch (err) {
      logger.error('Enforcement alerts compute failed', { error: err.message });
    }

    // compact mode: skip SOP + full rules, only send digests (saves ~6000 tokens)
    const compact = req.query.compact === 'true';

    // Server-side rendering: embed enforcement_alerts into iron_rules_digest.
    // Guarantees every client (MCP, hooks, future clients) shows them, instead
    // of relying on each client to parse it independently.
    let ironRulesDigestFinal = ironRulesDigest;
    if (enforcementAlerts && enforcementAlerts.length > 0) {
      const alertText = '\n\n## Enforcement Alerts (Historical Violations)\n' +
        enforcementAlerts.map(a => a.reinforcement_message).join('\n');
      ironRulesDigestFinal = ironRulesDigest + alertText;
    }

    // v1.17.21 fix: with INSTRUCTIONS_SOP dropped in compact mode, the AI could
    // not see the "must call ownmind_report_compliance" instruction; compliance
    // records dried up from 4/21 onward.
    // Append the instruction permanently to the digest tail (also sent in
    // compact). Semantically: digest = iron-rule list; compliance = the report
    // after a rule fires; the two naturally pair, costing ~80 tokens for
    // permanent observability.
    ironRulesDigestFinal +=
      '\n\n## Compliance Report (Mandatory)\n' +
      'Whenever an iron rule is triggered, you MUST call ownmind_report_compliance with the result:\n' +
      '- Complied → action: comply\n' +
      '- User asked to skip → action: skip\n' +
      '- Accidentally violated → action: violate\n' +
      'No user confirmation needed — report directly. This data is used to track iron rule adoption.';

    // Principles: compact mode only sends titles
    const principlesOut = compact
      ? principles.map(p => ({ id: p.id, title: p.title, code: p.code }))
      : principles;

    const detectedTool = req.headers['x-ownmind-tool'] || 'AI tool';
    const userStateResult = await query(
      `SELECT
        EXISTS (SELECT 1 FROM memories WHERE user_id = $1 AND status = 'active') AS has_any_memory,
        (SELECT settings->>'onboarding_completed_at' FROM users WHERE id = $1) AS onboarding_completed_at`,
      [req.user.id]
    );
    const { has_any_memory: hasAnyMemory, onboarding_completed_at: onboardingCompletedAt } = userStateResult.rows[0] || {};
    const onboarding = buildOnboarding({ hasAnyMemory, onboardingCompletedAt, tool: detectedTool });

    res.json({
      sync_token: syncToken,
      server_version: SERVER_VERSION,
      allowed_types: ALLOWED_MEMORY_TYPES,
      compact,
      upgrade_action: upgradeAction,
      team_standards_hash: teamStandardsHash,
      last_team_standard_update: lastTeamUpdate,
      iron_rules_count: ironRules.length,
      iron_rules_tier_counts: ironRulesTierCounts,
      ...(!compact && { instructions: INSTRUCTIONS_SOP }),
      profile,
      principles: principlesOut,
      ...(!compact && { iron_rules: ironRules }),
      iron_rules_digest: ironRulesDigestFinal,
      ...(!compact && { team_standards: teamStandards }),
      team_standards_digest: teamStandardsDigest,
      active_handoff: activeHandoff,
      weekly_summary: weeklySummary,
      memory_health: memoryHealth,
      pending_review: pendingReview,
      enforcement_alerts: enforcementAlerts,
      _onboarding: onboarding,
    });

    // Background: compress old session logs (does not block the response).
    compressOldSessions(req.user.id).catch(() => {});
    // Background: recover orphan sessions (activity exists but no session_log).
    recoverOrphanSession(req.user.id).catch(() => {});
    // Background: auto-confirm expired pending_review (7-day auto-confirm).
    autoConfirmPendingReview(req.user.id).catch(() => {});
  } catch (err) {
    logger.error('init failed', { error: err.message });
    res.status(500).json({ error: 'Failed to load initial memories' });
  }
});

/**
 * GET /type/:type - fetch memories by type.
 */
/**
 * v1.17.0 P6: cleanup endpoint for upgrade-verification test data.
 *
 * DELETE /api/memory/test-cleanup?name_prefix=__upgrade_test__
 * Only allows: is_test = TRUE AND title LIKE <prefix>%
 * Double safety: even if the prefix is changed, is_test still filters;
 * even if is_test is set incorrectly, the prefix still gates.
 */
router.delete('/test-cleanup', async (req, res) => {
  try {
    const rawPrefix = String(req.query.name_prefix || '').trim();
    // Hard limit: only accept names starting with __upgrade_test__ to prevent
    // accidental deletion of normal titles.
    if (!rawPrefix.startsWith('__upgrade_test__')) {
      return res.status(400).json({ error: 'name_prefix must start with __upgrade_test__' });
    }
    const result = await query(
      `DELETE FROM memories
       WHERE user_id = $1
         AND is_test = TRUE
         AND title LIKE $2
       RETURNING id, title`,
      [req.user.id, rawPrefix + '%']
    );
    res.json({ deleted: result.rowCount, titles: result.rows.map((r) => r.title) });
  } catch (err) {
    logger.error('test-cleanup failed', { error: err.message });
    res.status(500).json({ error: 'Cleanup failed: ' + err.message });
  }
});

/**
 * GET /sync — Delta sync for local memory mirror.
 * Query:
 *   types=iron_rule,project,feedback (default)
 *   since=<ISO8601> (optional; if omitted → first-run, only active)
 * Returns: { server_time, memories: [{id, type, title, content, tags, metadata, updated_at, status}] }
 * Includes disabled rows when `since` provided so client can tombstone local files.
 */
router.get('/sync', async (req, res) => {
  try {
    const typesCheck = parseSyncTypes(req.query.types);
    if (!typesCheck.ok) return res.status(400).json({ error: typesCheck.error });

    const sinceCheck = parseSince(req.query.since);
    if (!sinceCheck.ok) return res.status(400).json({ error: sinceCheck.error });

    const q = buildSyncQuery(req.user.id, typesCheck.types, sinceCheck.since);
    const result = await query(q.text, q.values);

    res.json({
      server_time: new Date().toISOString(),
      memories: result.rows,
    });
  } catch (err) {
    logger.error('memory sync failed', { error: err.message });
    res.status(500).json({ error: 'Sync failed' });
  }
});

router.get('/type/:type', async (req, res) => {
  try {
    // team_standard is shared across users; return all of them.
    const sql = req.params.type === 'team_standard'
      ? `SELECT * FROM memories WHERE type = 'team_standard' AND status = 'active' ORDER BY updated_at DESC`
      : `SELECT * FROM memories WHERE type = $1 AND user_id = $2 AND status = 'active' ORDER BY updated_at DESC`;
    const params = req.params.type === 'team_standard'
      ? []
      : [req.params.type, req.user.id];
    const result = await query(sql, params);

    // Read operations: mark stale only when a token is supplied and turns out invalid.
    const clientToken = req.query.sync_token;
    const response = { data: result.rows };
    if (clientToken) {
      const tokenCheck = await validateSyncToken(req.user.id, clientToken);
      if (!tokenCheck.valid) {
        response.stale = true;
        response.new_token = tokenCheck.new_token;
      }
    }
    res.json(response);
  } catch (err) {
    logger.error('memory query by type failed', { error: err.message });
    res.status(500).json({ error: 'Query failed' });
  }
});

/**
 * GET /project/:name - fetch a single project.
 */
router.get('/project/:name', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM memories
       WHERE type = 'project'
         AND title ILIKE $1
         AND user_id = $2
         AND status = 'active'
       LIMIT 1`,
      [req.params.name, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('project query failed', { error: err.message });
    res.status(500).json({ error: 'Query failed' });
  }
});

/**
 * GET /search?q= - full-text search over memories.
 */
router.get('/search', async (req, res) => {
  try {
    const rawQ = req.query.q;
    const tokens = tokenize(rawQ);
    if (tokens.length === 0) {
      return res.status(400).json({ error: 'Please provide search keyword q' });
    }

    // user_id is $1, tokens start at $2.
    const built = buildSearchWhere(tokens, 2);
    const result = await query(
      `SELECT * FROM memories
       WHERE user_id = $1
         AND status = 'active'
         AND ${built.whereClause}
       ORDER BY ${built.orderClause}`,
      [req.user.id, ...built.params]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error('memory search failed', { error: err.message });
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /:id - fetch a single memory.
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM memories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('memory query failed', { error: err.message });
    res.status(500).json({ error: 'Query failed' });
  }
});

/**
 * POST / - create a memory.
 */
router.post('/', async (req, res) => {
  try {
    const validation = requireFields(req.body, ['type', 'title', 'content']);
    if (validation) return res.status(400).json(validation);

    const { type, title, content, code, tags, metadata, sync_token, rule_stats, is_test, tier } = req.body;

    if (!ALLOWED_MEMORY_TYPES.includes(type)) {
      return res.status(400).json({
        error: `Invalid memory type: "${type}"`,
        allowed_types: ALLOWED_MEMORY_TYPES
      });
    }

    // v1.19: iron-rule tier field validation.
    const tierCheck = validateTierRequest({ memoryType: type, tier });
    if (!tierCheck.ok) {
      return res.status(tierCheck.status).json({ error: tierCheck.error });
    }

    // v1.17.94: iron_rule writes run a quality check; failures reject directly
    // (logic-over-reminders program enforcement). Ensures future-session AI knows when
    // a rule triggers and what it says — rules can't be empty shells.
    // Skip __upgrade_test__ prefixed test memories.
    // v1.18.0: lintIronRule upgraded to detect SKILL.md frontmatter:
    //   - With frontmatter → schema lint S1-S9
    //   - Without frontmatter → v1.17.94 regex lint (backward compatible)
    // Return shape now has format ('skill_md' | 'legacy_text') + warnings.
    let lintFormat = null;
    let lintWarnings = [];
    if (type === 'iron_rule' && !String(title).startsWith('__upgrade_test__')) {
      // v1.18.3 fix: feed metadata into lint so checkOriginContext (v1.18.2)
      // can see metadata.origin_context. Previously omitted; callers carrying
      // origin_context still got a "missing" lint warning.
      const lintResult = lintIronRule({ title, content, tags, metadata });
      lintFormat = lintResult.format;
      lintWarnings = lintResult.warnings || [];
      if (!lintResult.ok) {
        return res.status(400).json({
          error: 'Iron rule quality check failed — please fix the following issues and try again',
          errors: lintResult.errors,
          format: lintResult.format,
          hint: 'An iron rule must let a future-session AI understand when it triggers and what the rule says. See the rule-metadata design docs for rationale.',
        });
      }
    }

    // v1.17.0 P6: the is_test flag (used by upgrade verification) must be paired
    // with the __upgrade_test__ prefix; otherwise normal users could bypass sync
    // by setting is_test.
    const isTestFlag = Boolean(is_test);
    if (isTestFlag && !String(title).startsWith('__upgrade_test__')) {
      return res.status(400).json({
        error: 'is_test is only allowed for upgrade verification (title must start with __upgrade_test__)'
      });
    }

    // v1.19.1: secret-detect gate (the logic-over-reminders principle, secret-detect extension).
    //   Before POST /api/memory inserts, detect whether value looks like a
    //   password / token / API key; on hit, 400 and direct caller to
    //   ownmind_set_secret (instead of a generic 500).
    //   bypass: metadata.allow_secret_like=true → skip + write a lint_warning audit.
    //   __upgrade_test__ prefix → skip (test memories should not be blocked).
    let secretGuardWarning = null;
    if (!String(title).startsWith('__upgrade_test__')) {
      const guardResult = validateMemoryContent({ type, title, content, metadata });
      if (!guardResult.ok) {
        // v1.19.14: attach a suggest_report flag so the client can ask the
        // user whether to report a false positive.
        // detected_by prefix mapping: keyword:* → mem_blocked_secret_keyword;
        // otherwise (regex:*, heuristic:*) → mem_blocked_secret_regex.
        let body = guardResult.body;
        try {
          const fingerprint =
            typeof guardResult.body?.detected_by === 'string' &&
            guardResult.body.detected_by.startsWith('keyword:')
              ? 'mem_blocked_secret_keyword'
              : 'mem_blocked_secret_regex';
          const eligible = await isSuggestReportEligible(
            query,
            req.user.id,
            fingerprint
          );
          if (eligible) {
            body = withReportSuggestion(body, fingerprint, {
              hint: 'Think this block was wrong? File a report to the developer (the user will be asked to preview before sending).',
            });
          }
        } catch (err) {
          // Adding the flag failing must not break the original error response.
          logger.warn('suggest_report_flag_failed', { error: err.message });
        }
        return res.status(guardResult.status).json(body);
      }
      secretGuardWarning = guardResult.lint_warning_entry || null;
    }

    // Sync token check (graceful fallback for old clients without a token).
    const tokenResult = await checkSyncToken(req.user.id, sync_token);
    if (!tokenResult.ok) {
      return res.status(409).json(tokenResult.errorResponse);
    }

    // team_standard writes are admin-only.
    if (type === 'team_standard' && !isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: 'Team standards may only be created by admins' });
    }

    // iron_rule auto-numbering.
    let finalCode = code || null;
    if (type === 'iron_rule' && !finalCode) {
      const codeResult = await query(
        `SELECT code FROM memories WHERE user_id = $1 AND type = 'iron_rule' AND code LIKE 'IR-%'`,
        [req.user.id]
      );
      finalCode = generateNextIronRuleCode(codeResult.rows.map(r => r.code));
    }

    // v1.19: tier write (non-iron_rule always null so other types stay clean).
    const finalTier = applyTierDefault({ memoryType: type, tier });

    // v1.19.1: secret-guard bypass → merge the warning entry into
    // metadata.lint_warnings.
    let finalMetadata = metadata || null;
    if (secretGuardWarning) {
      const baseMetadata = metadata && typeof metadata === 'object' ? { ...metadata } : {};
      const existingWarnings = Array.isArray(baseMetadata.lint_warnings)
        ? baseMetadata.lint_warnings
        : [];
      finalMetadata = {
        ...baseMetadata,
        lint_warnings: [...existingWarnings, secretGuardWarning],
      };
    }

    const result = await query(
      `INSERT INTO memories (user_id, type, title, content, code, tags, metadata, is_test, tier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.id, type, title, content, finalCode, tags || null, finalMetadata, isTestFlag, finalTier]
    );

    const memory = result.rows[0];

    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'create', $3, $4)`,
      [memory.id, metadata?.tool || 'api', content, finalMetadata]
    );

    // v1.17.87 observability backfill: creating an iron_rule is a
    // high-risk sensitive event; the server writes a system_auto
    // observed_trigger compliance log immediately, without relying on the
    // client batch upload (the client may drop it, and the batch path can
    // stall).
    // Tied to me.js compliance gap audit: 4 memory_save iron_rule events
    // were unobserved because this server route never wrote a compliance
    // log; now it does, so future events won't be missed.
    // v1.26.32: de-identified — keys on the neutral RULE_FULL_LAYER_SYNC event
    // instead of a personal rule code (see shared/lint-event-types.js).
    if (type === 'iron_rule') {
      try {
        await query(
          `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
           VALUES ($1, NOW(), 'iron_rule_compliance', $2, 'system_server_auto', $3)`,
          [
            req.user.id,
            metadata?.tool || 'server',
            JSON.stringify({
              rule_code: '',
              rule_title: getEventDisplayName(RULE_FULL_LAYER_SYNC),
              triggered_by_event: RULE_FULL_LAYER_SYNC,
              action: 'observed_trigger',
              source: 'system_server_auto',
              tool_call: 'memory_save',
              context: `Added iron rule "${title}" (id=${memory.id})`,
            }),
          ]
        );
      } catch (e) {
        logger.error?.('memory_save iron_rule observed_trigger write failed', { error: e.message });
        // Failure must not block the main flow.
      }
    }

    // Mark onboarding complete on first memory save (sticky marker, so deleting
    // everything later does not re-trigger onboarding).
    await query(
      `UPDATE users
       SET settings = jsonb_set(
         COALESCE(settings, '{}'::jsonb),
         '{onboarding_completed_at}',
         to_jsonb(NOW()::text)
       )
       WHERE id = $1 AND (settings->>'onboarding_completed_at') IS NULL`,
      [req.user.id]
    );

    // Auto-match an iron_rule to a verification template.
    let matched_template = null;
    if (type === 'iron_rule' && !memory.metadata?.verification) {
      const templateId = matchTemplate({ title, content, tags });
      if (templateId) {
        matched_template = templateId;
        const verification = RULE_TEMPLATES[templateId].verification;
        const updatedMetadata = { ...(memory.metadata || {}), verification };
        await query(
          `UPDATE memories SET metadata = $1 WHERE id = $2`,
          [JSON.stringify(updatedMetadata), memory.id]
        );
        memory.metadata = updatedMetadata;
        logger.info('iron rule auto-matched verification template', { memory_id: memory.id, template: templateId });
      }
    }

    // Piggyback: merge rule_stats (after the main write so we don't bump the
    // sync token prematurely).
    if (rule_stats && typeof rule_stats === 'object') {
      for (const [ruleKey, stats] of Object.entries(rule_stats)) {
        try {
          await query(
            `UPDATE memories
             SET metadata = jsonb_set(
               COALESCE(metadata, '{}'::jsonb),
               '{stats}',
               jsonb_build_object(
                 'enforced', COALESCE((metadata->'stats'->>'enforced')::int, 0) + COALESCE(($1::jsonb->>'enforced')::int, 0),
                 'missed', COALESCE((metadata->'stats'->>'missed')::int, 0) + COALESCE(($1::jsonb->>'missed')::int, 0),
                 'triggered', COALESCE((metadata->'stats'->>'triggered')::int, 0) + COALESCE(($1::jsonb->>'triggered')::int, 0)
               )
             )
             WHERE code = $2 AND user_id = $3 AND status = 'active'`,
            [JSON.stringify(stats), ruleKey, req.user.id]
          );
        } catch (e) {
          logger.warn('rule_stats merge failed', { ruleKey, error: e.message });
        }
      }
    }

    // Return a fresh sync token (state changed after the write).
    const newToken = await generateSyncToken(req.user.id);
    const response = { ...memory, sync_token: newToken };
    if (matched_template) response.matched_template = matched_template;
    if (tokenResult.warning) response.update_warning = tokenResult.warning;

    // v1.18.0: iron_rule write result returns lint format + warnings so the
    // client can display them.
    if (lintFormat) {
      response.lint_format = lintFormat;
      if (lintWarnings.length > 0) response.lint_warnings = lintWarnings;
    }

    // Attach pending_review count (reminds AI there are items to confirm).
    const prCount = await query(
      `SELECT COUNT(*) as cnt FROM memories WHERE user_id = $1 AND status = 'active' AND tags @> ARRAY['pending_review']`,
      [req.user.id]
    );
    const pendingCount = parseInt(prCount.rows[0].cnt, 10);
    if (pendingCount > 0) response.pending_review_count = pendingCount;

    res.status(201).json(response);
  } catch (err) {
    // v1.19.1: split the catch-all 500 into 400/409/503/500.
    //   Proposal §2.3: previously everything returned a generic 500
    //   "Memory create failed" and callers had no idea what went wrong;
    //   now route by err.code (PG SQLSTATE) / err type and include a hint.
    const classified = classifyMemoryError(err, { context: 'create' });
    const logPayload = { error: err?.message, code: err?.code };
    if (classified.logStack) logPayload.stack = err?.stack;
    logger[classified.logLevel]('memory create failed', logPayload);
    res.status(classified.status).json(classified.body);
  }
});

/**
 * PUT /:id - update a memory.
 */
router.put('/:id', async (req, res) => {
  try {
    const { title: rawTitle, content, tags, metadata, update_reason, sync_token, rule_stats, tier } = req.body;

    // Sync token check (graceful fallback for old clients without a token).
    const tokenResult = await checkSyncToken(req.user.id, sync_token);
    if (!tokenResult.ok) {
      return res.status(409).json(tokenResult.errorResponse);
    }

    // Confirm the memory exists and belongs to the user, and grab the old content.
    const existing = await query(
      'SELECT * FROM memories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    const oldMemory = existing.rows[0];

    // v1.26.29: a present-but-empty title would lint an empty title and log a
    // history change while COALESCE('' -> null) silently keeps the old title —
    // an inconsistent no-op. Reject it up front. This also turns title:null
    // (previously a silent keep-old fallthrough) into a 400.
    if (rawTitle !== undefined && (typeof rawTitle !== 'string' || rawTitle.trim() === '')) {
      return res.status(400).json({ error: 'title must be a non-empty string' });
    }
    // Stored trimmed, so "Foo" -> "Foo " is not a phantom rename (it would
    // pollute history and churn the local memory-file slug).
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : undefined;

    // v1.26.29 review I1: the __upgrade_test__ prefix disarms the iron-rule
    // lint and the secret guard below. Now that clients can send titles,
    // renaming a real memory INTO the prefix must be rejected — the upgrade
    // helper itself never renames, so nothing legitimate is blocked.
    if (title !== undefined
        && title.startsWith('__upgrade_test__')
        && !String(oldMemory.title).startsWith('__upgrade_test__')) {
      return res.status(400).json({ error: 'title may not be renamed to the reserved __upgrade_test__ prefix' });
    }

    // team_standard edits are admin-only.
    if (oldMemory.type === 'team_standard' && !isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: 'Team standards may only be edited by admins' });
    }

    // v1.19: tier validation — use the existing memory's type to avoid the
    // client smuggling in a different type to bypass.
    if (tier !== undefined && tier !== null) {
      const tierCheck = validateTierRequest({ memoryType: oldMemory.type, tier });
      if (!tierCheck.ok) {
        return res.status(tierCheck.status).json({ error: tierCheck.error });
      }
    }

    // v1.18.0: lintIronRule upgraded to detect SKILL.md frontmatter (same as
    // POST handler).
    // v1.18.0 review B2 fix: judge __upgrade_test__ bypass against merged.title,
    //   not oldMemory.title. Attack surface: a POST with __upgrade_test__xxx
    //   bypasses lint into the DB → a PUT then changes title to a normal name
    //   while replacing content with garbage. Using oldMemory.title would let
    //   this through; using merged.title (the future title) blocks it.
    let lintFormatPut = null;
    let lintWarningsPut = [];
    // v1.18.3 fix: feed metadata into merged so lint can see origin_context.
    const merged = {
      title: title !== undefined ? title : oldMemory.title,
      content: content !== undefined ? content : oldMemory.content,
      tags: tags !== undefined ? tags : oldMemory.tags,
      metadata: metadata !== undefined ? metadata : oldMemory.metadata,
    };
    // v1.18.2 hotfix: skip content lint for metadata-only updates.
    //   Scenario: a backfill script only adds origin_context, not changing
    //   content / title / tags; it should not be blocked by content-structure
    //   lint. Lint only runs when a lint-relevant field actually changes.
    const contentChanged = content !== undefined && content !== oldMemory.content;
    const titleChanged = title !== undefined && title !== oldMemory.title;
    const tagsChanged = tags !== undefined && JSON.stringify(tags) !== JSON.stringify(oldMemory.tags);
    const lintRelevantChange = contentChanged || titleChanged || tagsChanged;

    if (oldMemory.type === 'iron_rule' && !String(merged.title).startsWith('__upgrade_test__') && lintRelevantChange) {
      const lintResult = lintIronRule(merged);
      lintFormatPut = lintResult.format;
      lintWarningsPut = lintResult.warnings || [];
      if (!lintResult.ok) {
        return res.status(400).json({
          error: 'Iron rule quality check failed — please fix the following issues and try again',
          errors: lintResult.errors,
          format: lintResult.format,
          hint: 'An iron rule must let a future-session AI understand when it triggers and what the rule says. See the rule-metadata design docs for rationale.',
        });
      }
    }

    // v1.19.1: secret-detect gate (the logic-over-reminders principle, secret-detect extension).
    //   PUT must also block so update content cannot smuggle a key in.
    //   Only runs when content actually changes (metadata-only updates skip).
    //   __upgrade_test__ prefix → skip.
    let secretGuardWarningPut = null;
    // v1.26.29 review M2: the title is part of the keyword haystack, so a
    // title-only change must re-run the guard too (content regex re-scan on
    // unchanged content is a no-op cost).
    if ((contentChanged || titleChanged) && !String(merged.title).startsWith('__upgrade_test__')) {
      const guardResult = validateMemoryContent({
        type: oldMemory.type,
        title: merged.title,
        content: merged.content,
        metadata: merged.metadata,
      });
      if (!guardResult.ok) {
        return res.status(guardResult.status).json(guardResult.body);
      }
      secretGuardWarningPut = guardResult.lint_warning_entry || null;
    }

    // v1.18.0: back up the previous content into previous_content before the
    // write (so the upgrade helper can recover if it writes the wrong thing).
    // Only iron_rule, and only when content really changes, to avoid no-op writes.
    const willChangeContent = content !== undefined && content !== oldMemory.content;
    const shouldBackup = oldMemory.type === 'iron_rule' && willChangeContent;

    // v1.19: tier change — only override when caller explicitly provided tier,
    // keeping COALESCE behavior consistent.
    const tierForUpdate = (tier === undefined || tier === null) ? null : tier;

    // v1.19.1: secret-guard bypass → merge the warning entry into
    // metadata.lint_warnings.
    //   Base it on "the metadata about to be written" (what caller sent),
    //   not oldMemory.metadata, to avoid duplicating old lint_warnings.
    let metadataForUpdate = metadata !== undefined ? metadata : null;
    if (secretGuardWarningPut) {
      const baseMetadata = metadata && typeof metadata === 'object'
        ? { ...metadata }
        : (oldMemory.metadata && typeof oldMemory.metadata === 'object'
           ? { ...oldMemory.metadata }
           : {});
      const existingWarnings = Array.isArray(baseMetadata.lint_warnings)
        ? baseMetadata.lint_warnings
        : [];
      metadataForUpdate = {
        ...baseMetadata,
        lint_warnings: [...existingWarnings, secretGuardWarningPut],
      };
    }

    const result = await query(
      `UPDATE memories
       SET title = COALESCE($1, title),
           content = COALESCE($2, content),
           tags = COALESCE($3, tags),
           metadata = COALESCE($4, metadata),
           previous_content = CASE WHEN $7::boolean THEN content ELSE previous_content END,
           tier = COALESCE($8, tier),
           updated_at = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [title || null, content || null, tags || null, metadataForUpdate, req.params.id, req.user.id, shouldBackup, tierForUpdate]
    );

    const memory = result.rows[0];

    // Save the old content to history and record the update reason.
    // v1.19: tier change recorded in metadata.tier_change for audit
    // (spec scenario 2 / scenario 8).
    const tierChanged = tier !== undefined && tier !== null && tier !== oldMemory.tier;
    const historyMetadata = {
      ...oldMemory.metadata,
      update_reason: update_reason || null,
      ...(tierChanged && {
        tier_change: { from: oldMemory.tier || 'default', to: tier },
      }),
      // v1.26.29: title renames are audited the same way as tier changes —
      // history only archives the old content, so without this the old title
      // would be unrecoverable.
      ...(titleChanged && {
        title_change: { from: oldMemory.title, to: title },
      }),
    };
    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'update', $3, $4)`,
      [
        memory.id,
        metadata?.tool || oldMemory.metadata?.tool || 'api',
        oldMemory.content,
        JSON.stringify(historyMetadata),
      ]
    );

    // Piggyback: merge rule_stats (after the main write so we don't bump the
    // sync token prematurely).
    if (rule_stats && typeof rule_stats === 'object') {
      for (const [ruleKey, stats] of Object.entries(rule_stats)) {
        try {
          await query(
            `UPDATE memories
             SET metadata = jsonb_set(
               COALESCE(metadata, '{}'::jsonb),
               '{stats}',
               jsonb_build_object(
                 'enforced', COALESCE((metadata->'stats'->>'enforced')::int, 0) + COALESCE(($1::jsonb->>'enforced')::int, 0),
                 'missed', COALESCE((metadata->'stats'->>'missed')::int, 0) + COALESCE(($1::jsonb->>'missed')::int, 0),
                 'triggered', COALESCE((metadata->'stats'->>'triggered')::int, 0) + COALESCE(($1::jsonb->>'triggered')::int, 0)
               )
             )
             WHERE code = $2 AND user_id = $3 AND status = 'active'`,
            [JSON.stringify(stats), ruleKey, req.user.id]
          );
        } catch (e) {
          logger.warn('rule_stats merge failed', { ruleKey, error: e.message });
        }
      }
    }

    const newToken = await generateSyncToken(req.user.id);
    const response = { ...memory, sync_token: newToken };
    if (tokenResult.warning) response.update_warning = tokenResult.warning;

    // v1.18.0: iron_rule update result returns lint format + warnings.
    if (lintFormatPut) {
      response.lint_format = lintFormatPut;
      if (lintWarningsPut.length > 0) response.lint_warnings = lintWarningsPut;
    }

    // Attach pending_review count.
    const prCount = await query(
      `SELECT COUNT(*) as cnt FROM memories WHERE user_id = $1 AND status = 'active' AND tags @> ARRAY['pending_review']`,
      [req.user.id]
    );
    const pendingCount = parseInt(prCount.rows[0].cnt, 10);
    if (pendingCount > 0) response.pending_review_count = pendingCount;

    res.json(response);
  } catch (err) {
    // v1.19.1: split the catch-all 500 into 400/409/503/500 (same as POST handler).
    const classified = classifyMemoryError(err, { context: 'update' });
    const logPayload = { error: err?.message, code: err?.code };
    if (classified.logStack) logPayload.stack = err?.stack;
    logger[classified.logLevel]('memory update failed', logPayload);
    res.status(classified.status).json(classified.body);
  }
});

/**
 * PUT /:id/disable - disable a memory.
 */
router.put('/:id/disable', async (req, res) => {
  try {
    const { reason, sync_token } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'A disable reason is required' });
    }

    // Sync token check (graceful fallback for old clients without a token).
    const tokenResult = await checkSyncToken(req.user.id, sync_token);
    if (!tokenResult.ok) {
      return res.status(409).json(tokenResult.errorResponse);
    }

    // team_standard disables are admin-only.
    const check = await query('SELECT type FROM memories WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (check.rows.length > 0 && check.rows[0].type === 'team_standard' && !isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: 'Team standards may only be disabled by admins' });
    }

    const result = await query(
      `UPDATE memories
       SET status = 'disabled',
           disabled_reason = $1,
           disabled_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [reason, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'disable', $3, $4)`,
      [req.params.id, 'api', result.rows[0].content, JSON.stringify({ reason })]
    );

    // v1.17.87: disabling an iron_rule is a high-risk sensitive event;
    // the server writes a system_auto observed_trigger compliance log immediately
    // (same approach as save iron_rule).
    // Tied to me.js compliance gap audit: 3 memory_disable events went unobserved
    // because this server route never wrote one; now fixed. team_standard /
    // other types aren't sensitive, so skip them.
    // v1.26.32: de-identified — keys on the neutral RULE_FULL_LAYER_SYNC event.
    if (result.rows[0].type === 'iron_rule') {
      try {
        await query(
          `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
           VALUES ($1, NOW(), 'iron_rule_compliance', $2, 'system_server_auto', $3)`,
          [
            req.user.id,
            'server',
            JSON.stringify({
              rule_code: '',
              rule_title: getEventDisplayName(RULE_FULL_LAYER_SYNC),
              triggered_by_event: RULE_FULL_LAYER_SYNC,
              action: 'observed_trigger',
              source: 'system_server_auto',
              tool_call: 'memory_disable',
              context: `Disabled iron rule ${result.rows[0].code || ''} (id=${result.rows[0].id}): ${reason.slice(0, 80)}`,
            }),
          ]
        );
      } catch (e) {
        logger.error?.('memory_disable iron_rule observed_trigger write failed', { error: e.message });
      }
    }

    const newToken = await generateSyncToken(req.user.id);
    const response = { ...result.rows[0], sync_token: newToken };
    if (tokenResult.warning) response.update_warning = tokenResult.warning;
    res.json(response);
  } catch (err) {
    logger.error('memory disable failed', { error: err.message });
    res.status(500).json({ error: 'Failed to disable memory' });
  }
});

/**
 * PUT /:id/enable - re-enable a memory.
 */
router.put('/:id/enable', async (req, res) => {
  try {
    const { sync_token } = req.body || {};

    // Sync token check (graceful fallback for old clients without a token).
    const tokenResult = await checkSyncToken(req.user.id, sync_token);
    if (!tokenResult.ok) {
      return res.status(409).json(tokenResult.errorResponse);
    }

    const result = await query(
      `UPDATE memories
       SET status = 'active',
           disabled_reason = NULL,
           disabled_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'enable', $3, NULL)`,
      [req.params.id, 'api', result.rows[0].content]
    );

    const newToken = await generateSyncToken(req.user.id);
    const response = { ...result.rows[0], sync_token: newToken };
    if (tokenResult.warning) response.update_warning = tokenResult.warning;
    res.json(response);
  } catch (err) {
    logger.error('memory enable failed', { error: err.message });
    res.status(500).json({ error: 'Failed to enable memory' });
  }
});

/**
 * PUT /:id/revert - revert to a historical version.
 */
router.put('/:id/revert', async (req, res) => {
  try {
    const { history_id } = req.body;

    if (!history_id) {
      return res.status(400).json({ error: 'history_id is required' });
    }

    // Confirm the memory belongs to the user, then fetch the historical version.
    const memCheck = await query(
      'SELECT id FROM memories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (memCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    const historyResult = await query(
      `SELECT * FROM memory_history WHERE id = $1 AND memory_id = $2`,
      [history_id, req.params.id]
    );

    if (historyResult.rows.length === 0) {
      return res.status(404).json({ error: 'History version not found' });
    }

    const historyContent = historyResult.rows[0].content;

    // Update the memory content.
    const result = await query(
      `UPDATE memories
       SET content = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [historyContent, req.params.id, req.user.id]
    );

    // Record the revert.
    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'revert', $3, $4)`,
      [req.params.id, 'api', historyContent, JSON.stringify({ reverted_from: history_id })]
    );

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('memory revert failed', { error: err.message });
    res.status(500).json({ error: 'Failed to restore memory' });
  }
});

/**
 * GET /:id/history - fetch a memory's history.
 */
router.get('/:id/history', async (req, res) => {
  try {
    // Confirm the memory belongs to the user.
    const memCheck = await query(
      'SELECT id FROM memories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (memCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    const result = await query(
      `SELECT * FROM memory_history
       WHERE memory_id = $1
       ORDER BY created_at DESC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error('memory history query failed', { error: err.message });
    res.status(500).json({ error: 'Query failed' });
  }
});

/**
 * Orphan-session recovery: detect when the previous session had activity but
 * no session_log. From activity_logs, auto-generate a minimum-quality
 * recovery session_log.
 */
async function recoverOrphanSession(userId) {
  // Find the previous init event (skipping the current one).
  const prevInit = await query(
    `SELECT ts FROM activity_logs
     WHERE user_id = $1 AND event = 'init'
     ORDER BY ts DESC OFFSET 1 LIMIT 1`,
    [userId]
  );
  if (prevInit.rows.length === 0) return;

  const prevInitTs = prevInit.rows[0].ts;

  // Find the current init time.
  const currInit = await query(
    `SELECT ts FROM activity_logs
     WHERE user_id = $1 AND event = 'init'
     ORDER BY ts DESC LIMIT 1`,
    [userId]
  );
  const currInitTs = currInit.rows[0]?.ts || new Date();

  // Check whether a session_log already exists for that range.
  const existingLog = await query(
    `SELECT id FROM session_logs
     WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
     LIMIT 1`,
    [userId, prevInitTs, currInitTs]
  );
  if (existingLog.rows.length > 0) return; // already logged, no recovery needed

  // Tally activity within that range.
  const activities = await query(
    `SELECT event, tool, details FROM activity_logs
     WHERE user_id = $1 AND ts >= $2 AND ts < $3
     ORDER BY ts`,
    [userId, prevInitTs, currInitTs]
  );

  // Skip empty sessions that only contain init.
  const nonInitEvents = activities.rows.filter(r => r.event !== 'init');
  if (nonInitEvents.length === 0) return;

  // Aggregate the activity data.
  const eventCounts = {};
  const tools = new Set();
  const compliance = [];
  for (const r of activities.rows) {
    eventCounts[r.event] = (eventCounts[r.event] || 0) + 1;
    if (r.tool) tools.add(r.tool);
    if (r.event === 'iron_rule_compliance' && r.details) {
      compliance.push({ rule: r.details.rule_title, action: r.details.action });
    }
  }

  const summary = `[server-recovered] ${Object.entries(eventCounts).map(([k, v]) => `${k}:${v}`).join(', ')}`;

  await query(
    `INSERT INTO session_logs (user_id, tool, model, summary, details, compressed)
     VALUES ($1, $2, 'unknown', $3, $4, false)`,
    [
      userId,
      [...tools][0] || 'unknown',
      summary,
      JSON.stringify({
        _recovery: 'from_activity_logs',
        event_counts: eventCounts,
        compliance,
        recovered_at: new Date().toISOString(),
      }),
    ]
  );

  logger.info('orphan session recovered', { userId, events: nonInitEvents.length });
}

/**
 * Auto-confirm pending_review memories older than 7 days.
 */
async function autoConfirmPendingReview(userId) {
  const result = await query(
    `UPDATE memories
     SET tags = array_remove(tags, 'pending_review'),
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{auto_confirmed}',
           to_jsonb(NOW()::text)
         ),
         updated_at = NOW()
     WHERE user_id = $1
       AND tags @> ARRAY['pending_review']
       AND status = 'active'
       AND created_at < NOW() - INTERVAL '7 days'
     RETURNING id, title`,
    [userId]
  );

  if (result.rows.length > 0) {
    logger.info('pending_review auto-confirmed', {
      userId,
      count: result.rows.length,
      items: result.rows.map(r => r.title),
    });
  }
}

/**
 * POST /batch-sync-standard - batch sync team-standard rule details (RAG).
 */
router.post('/batch-sync-standard', async (req, res) => {
  try {
    const validation = requireFields(req.body, ['parent_title', 'chunks']);
    if (validation) return res.status(400).json(validation);
    if (!Array.isArray(req.body.chunks)) {
      return res.status(400).json({ error: 'chunks must be an array' });
    }

    const { parent_title, chunks, sync_token } = req.body;

    // Sync token check.
    const tokenResult = await checkSyncToken(req.user.id, sync_token);
    if (!tokenResult.ok) {
      return res.status(409).json(tokenResult.errorResponse);
    }

    // 1. Ensure parent (team_standard) exists; admin-only.
    let parent = await query(
      `SELECT id FROM memories WHERE type = 'team_standard' AND title = $1 AND status = 'active'`,
      [parent_title]
    );

    if (parent.rows.length === 0) {
      if (!isAtLeast(req.user.role, 'admin')) {
        return res.status(403).json({ error: 'Team standard not found and only admins may create one' });
      }
      // Auto-create the parent.
      const parentResult = await query(
        `INSERT INTO memories (user_id, type, title, content, tags)
         VALUES ($1, 'team_standard', $2, $3, $4)
         RETURNING id`,
        [req.user.id, parent_title, `由 ownmind-upload 自動建立的規範摘要: ${parent_title}`, ['auto_created']]
      );
      parent = parentResult;
    } else {
       if (!isAtLeast(req.user.role, 'admin')) {
         return res.status(403).json({ error: 'Batch sync of standard details is admin-only' });
       }
    }

    const parentId = parent.rows[0].id;

    // 2. Fetch the existing detail rows.
    const existingResult = await query(
      `SELECT id, title, metadata->>'hash' as hash FROM memories
       WHERE type = 'standard_detail'
         AND metadata->>'parent_id' = $1
         AND status = 'active'`,
      [parentId.toString()]
    );
    const existingMap = new Map(existingResult.rows.map(r => [r.title, r]));

    const stats = { added: 0, updated: 0, deleted: 0, unchanged: 0 };
    const processedTitles = new Set();

    // 3. Process the incoming chunks.
    for (const chunk of chunks) {
      const { title, content, hash, level } = chunk;
      processedTitles.add(title);

      const existing = existingMap.get(title);
      if (!existing) {
        // Add.
        await query(
          `INSERT INTO memories (user_id, type, title, content, tags, metadata)
           VALUES ($1, 'standard_detail', $2, $3, $4, $5)`,
          [
            req.user.id,
            title,
            content,
            ['rule_detail'],
            { parent_id: parentId, hash, level }
          ]
        );
        stats.added++;
      } else if (existing.hash !== hash) {
        // Update.
        await query(
          `UPDATE memories
           SET content = $1, metadata = $2, updated_at = NOW()
           WHERE id = $3`,
          [content, { parent_id: parentId, hash, level }, existing.id]
        );
        stats.updated++;
      } else {
        stats.unchanged++;
      }
    }

    // 4. Delete vanished details (mark as disabled).
    for (const [title, existing] of existingMap) {
      if (!processedTitles.has(title)) {
        await query(
          `UPDATE memories SET status = 'disabled', disabled_reason = 'sync_removal', updated_at = NOW() WHERE id = $1`,
          [existing.id]
        );
        stats.deleted++;
      }
    }

    const newToken = await generateSyncToken(req.user.id);
    res.json({
      status: 'ok',
      parent_id: parentId,
      stats,
      sync_token: newToken
    });
  } catch (err) {
    logger.error('batch sync standard failed', { error: err.message });
    res.status(500).json({ error: 'Sync failed' });
  }
});

export default router;
