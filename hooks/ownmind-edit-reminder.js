#!/usr/bin/env node
/**
 * v1.26.92 — the edit-trigger iron rule reminder.
 *
 * One implementation, two callers: `ownmind-iron-rule-check.js` imports `editReminder()`,
 * and `ownmind-iron-rule-check.sh` runs this file by path, the way it already runs
 * `ownmind-verify-trigger.js`. The alias table in v1.26.91 had to be duplicated because it
 * lives inside a `node -e` string; this does not, so it is not.
 *
 * v1.26.164 — the edit trigger blocks in exactly one case: a file whose path a standard in
 * the enforcement bundle marks as somebody else's. Everything else on this path is still a
 * reminder, and the verification engine is still untouched — its conditions are written for
 * commit and deploy, so the block below is its own exit and shares nothing with it.
 *
 * The guard lives here rather than in `ownmind-iron-rule-check.js` because of what is
 * registered. `install.sh` passes `--bash`, `ensure-pretooluse-hooks.cjs` turns that into
 * `ownmind-iron-rule-check.sh`, and that script hands every edit tool to this file and exits.
 * A guard written into the `.js` hook would pass its tests and never run on macOS or Linux.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { findGuardViolation, findContentMention, formatGuardBlock } from './lib/path-guard.js';
import { readEnforcementBundle } from './lib/enforcement-cache.js';
import { getClientVersion, readCredentials } from '../shared/helpers.js';
import { renderHookContextLine, RELAY_INSTRUCTION } from '../shared/hook-context.js';
import { fetchHookContext } from './lib/hook-context-fetch.js';
import {
  readEditReminderState,
  writeEditReminderState,
  decideEditReminder,
  renderEditReminderLine,
  FETCH_BACKOFF_MS,
} from '../shared/edit-reminder-state.js';

function envelope(text) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  });
}

/**
 * Said out loud when the state file cannot be written.
 *
 * Without this the degradation is invisible and permanent: every edit re-lists and pays a
 * network round trip, because nothing can remember that the listing already happened. The
 * whole point of this release line is that a broken guard must not look like a working one.
 */
const STATE_WRITE_FAILED =
  '(OwnMind cannot write to ~/.ownmind/state/, so the full listing will repeat on every edit. '
  + 'Check the permissions on that directory.)';

/**
 * The same notice when it is the only thing being said.
 *
 * v1.26.161 — it goes out alone on the two paths where there is no rule to report, and English
 * with nothing to translate it is a regression for the reader it was Chinese for. Everywhere
 * else it is appended to a line that already carries the instruction.
 */
const STATE_WRITE_FAILED_ALONE = `${STATE_WRITE_FAILED}\nTell the user this, in the language you `
  + 'are speaking with them.';

/**
 * @param {{version: string, apiKey: string, apiUrl: string, now: number, sessionId?: string}} opts
 * @returns {Promise<string|null>} the JSON envelope to print, or null to stay silent
 */
export async function editReminder({
  version, apiKey, apiUrl, now, sessionId,
  filePath = '',
  content = '',
  guards = null,
}) {
  // The guard runs before the throttle, and before anything that can decide to stay quiet.
  // The listing below is shown once an hour by design; a block that inherited that throttle
  // would let the second attempt within the hour through, which is a delay, not a guarantee.
  if (filePath || content) {
    try {
      const rules = guards || readEnforcementBundle().guards;
      if (rules.length > 0) {
        // The path first: an actual write to a file somebody else owns.
        const violation = filePath ? findGuardViolation(filePath, rules) : null;
        if (violation) {
          const reason = formatGuardBlock(violation);
          return JSON.stringify({
            decision: 'block',
            reason,
            hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason },
          });
        }
        // Then the text. A document at an ordinary path can propose the forbidden change,
        // which is what the incident behind this feature actually produced - and by the time
        // anyone notices, a person has read a plan built on a rule already broken. This is a
        // warning rather than a block: the document is not the edit, and blocking every file
        // that mentions a guarded path would stop the assistant explaining why it will not
        // touch it.
        const mention = findContentMention(content, rules);
        if (mention) {
          return envelope(
            `[OwnMind] Standard ${mention.standard.id} covers ${mention.matchedPath} in this `
            + `repository, and this text proposes changes there. Those paths belong to `
            + `${mention.standard.owner || 'someone else'} — whatever a permissions list inside `
            + 'the repository says. Re-read the standard before going further, and say plainly '
            + 'that the change has to go through its owner.\n'
            + 'Tell the user this, in the language you are speaking with them.',
          );
        }
      }
    } catch { /* fail open: a broken guard must not stop the user editing files */ }
  }

  // v1.26.154 — the window is keyed by trigger as well now. This path is always `edit`; the
  // command path passes its own, so a commit listing no longer silences a deploy listing.
  const decision = decideEditReminder(readEditReminderState(sessionId, 'edit'), now);

  if (decision.mode === 'line') {
    // No request on this path. The count is carried in the state file precisely so the
    // throttled case — the common one — puts no network round trip in front of an edit.
    const wrote = writeEditReminderState(sessionId, 'edit', {
      window_start_ms: decision.window_start_ms,
      occurrence: decision.occurrence,
      rule_count: decision.rule_count,
      counts: decision.counts,
      totals: decision.totals,
    });
    // rule_count 0 means there is nothing to say: either this account has no rule matching
    // an edit, or the last lookup failed and this is the back-off window. Saying "0 rules"
    // before every file write is noise with no content, and a brand new account — the
    // population least willing to put up with it — is exactly where it would happen.
    if (decision.rule_count <= 0) return wrote ? null : envelope(STATE_WRITE_FAILED_ALONE);
    // issue #94 — the throttled line names every category too, from the counts stored in the
    // window. A state file written by an older client has none, so the pre-v1.26.151 line is
    // still what comes out until the next full listing refreshes the window.
    // v1.26.161 — the occurrence goes in as `suffix`, so it lands inside the line rather than
    // after the instruction that says which parts must survive translation.
    const contextLine = decision.counts
      ? renderHookContextLine({
        version,
        trigger: 'edit',
        counts: decision.counts,
        suffix: ` · occurrence ${decision.occurrence} this hour`,
      })
      : '';
    // The legacy line has no relay instruction of its own — it predates the English-source
    // route and was Chinese until v1.26.161. Translating it without carrying the instruction
    // would leave a Chinese reader worse off than before, so the instruction comes with it.
    const line = contextLine
      || `${renderEditReminderLine(version, decision.rule_count, decision.occurrence)}\n`
        + RELAY_INSTRUCTION;
    return envelope(wrote ? line : `${line}\n${STATE_WRITE_FAILED}`);
  }

  if (!apiKey || !apiUrl) return null;

  let ctx = null;
  try {
    // issue #94 — all five categories in one request. See fetchHookContext for the fallback
    // to `/type/iron_rule` when the server predates that endpoint.
    ctx = await fetchHookContext({ apiUrl, apiKey, trigger: 'edit' });
  } catch {
    // Back off rather than retry on the next keystroke. An unreachable server would
    // otherwise cost every edit a 3s timeout for the length of the outage, silently. A
    // short window still leaves the hourly listing intact once the server is back.
    writeEditReminderState(sessionId, 'edit', {
      window_start_ms: now,
      occurrence: 1,
      rule_count: 0,
      window_ms: FETCH_BACKOFF_MS,
    });
    return null;
  }

  const relevant = ctx.rules;
  // A legacy response knows the iron-rule count and nothing else. Storing zeroes for the other
  // four would have the throttled line claim they were consulted and empty, when they were
  // never asked — so nothing is stored and the old line is what gets printed.
  const counts = ctx.legacy ? undefined : ctx.counts;
  const totals = ctx.legacy ? undefined : ctx.totals;

  const wrote = writeEditReminderState(sessionId, 'edit', {
    window_start_ms: decision.window_start_ms,
    occurrence: decision.occurrence,
    rule_count: relevant.length,
    counts,
    totals,
  });

  if (relevant.length === 0) return wrote ? null : envelope(STATE_WRITE_FAILED_ALONE);

  const tag = `[OwnMind v${version}] Iron rules the AI must follow when editing files: `
    + `${relevant.length}`;
  // The names of everything that matched, iron rules included.
  //
  // v1.26.154 held them back here on the grounds that the banner below already prints them and
  // twice is once too many. v1.26.160 reverses that on the owner's instruction: the listing is
  // meant to be the answer to "what did OwnMind find", and a category that shows a count with
  // no names beside every other category that has them reads as though nothing was found. The
  // banner is a different job — it is what stops you — so the two overlapping is the point.
  const names = ctx.legacy || !ctx.names ? undefined : ctx.names;
  const contextLine = counts
    ? renderHookContextLine({ version, trigger: 'edit', counts, totals, names, withHowTo: true })
    : '';
  const lines = [
    ...(contextLine ? [contextLine, ''] : []),
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    tag,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ...relevant.map(r => `  ⚠️  ${r.code || 'IR-?'}: ${r.title}`),
    '',
    'The full list is shown once an hour; later edits in the same hour get a single line. '
    + 'This is a reminder — it does not block the edit.',
    // v1.26.161 — the banner needs its own instruction. The counts line above carries one, and
    // it says "the line above", which is everything this block is not. On a legacy server there
    // is no counts line at all and this block is the entire output. Rule titles are excluded by
    // name: they are user data, in whatever language their author wrote them, and a model told
    // to translate the surrounding text will otherwise take them with it.
    'If you surface any of this to the user, put OwnMind\'s own wording above into the language '
    + 'you are speaking with them. Leave each rule title exactly as written — the user wrote '
    + 'those.',
  ];
  if (!wrote) lines.push(STATE_WRITE_FAILED);
  return envelope(lines.join('\n'));
}

/** Read the session id off the payload, when a caller pipes one in. */
function readPayload() {
  // Only when something is actually piping. `readFileSync(0)` on an interactive terminal
  // waits for input that will never come, which turns "run this file to see what it does"
  // into a hung shell. The .sh always pipes, so the guard costs nothing where it matters.
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/** Write and Edit name the incoming text differently; both are the text about to land. */
function readContent(toolInput) {
  return [toolInput?.content, toolInput?.new_string]
    .filter((s) => typeof s === 'string')
    .join('\n');
}

/** CLI entry — how the .sh hook calls this. */
async function main() {
  const { apiKey, apiUrl } = readCredentials();
  // One read of stdin, because there is only one. The session id and the file being written
  // arrive in the same payload, and a second `readFileSync(0)` would find it spent.
  const payload = readPayload();
  const toolInput = payload.tool_input || {};
  const out = await editReminder({
    version: getClientVersion(),
    apiKey,
    apiUrl,
    now: Date.now(),
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : '',
    filePath: typeof toolInput.file_path === 'string' ? toolInput.file_path : '',
    content: readContent(toolInput),
  });
  if (out) console.log(out);
}

// Compare real paths, not the strings. `import.meta.url` is already symlink-resolved while
// `argv[1]` is whatever path the caller typed, so a hooks directory assembled with symlinks
// — which is how the tests build one — makes the two differ and this file silently does
// nothing when run as a CLI. Exactly the failure mode this release exists to stop.
function invokedDirectly() {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch(() => process.exit(0));
}
