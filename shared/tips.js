/**
 * shared/tips.js — the one-line tips attached to every OwnMind response.
 *
 * v1.26.127. There used to be two copies of this list: `const TIPS` in mcp/index.js, which
 * rides on every MCP tool response, and a literal bullet list inside INSTRUCTIONS_SOP in
 * src/routes/memory.js, served to clients that talk to the API instead. They were
 * byte-identical, which is the state a duplicated list is in right before it stops being.
 *
 * Each tip carries an `anchor`: the thing in this repo that makes the claim true. That is
 * what tests/tips-list.test.js checks, and it exists because the list had drifted from the
 * product. Four entries were dropped for claiming things that do not exist: listing disabled
 * iron rules (no tool retrieves them), the AI proactively suggesting workflow improvements
 * (nothing implements or instructs it), exporting/loading memories on claude.ai or ChatGPT
 * (no such path), and the 2h/50% organize prompt — that last one IS instructed, but only in
 * two of the six templates while the tip goes to every client.
 *
 * Three more were dropped and five added on a read-through by the person these are written
 * for, which is the other half of the job: an anchor proves the named thing exists, not that
 * the sentence is worth showing.
 * Out went the ones that only make sense to someone who works on OwnMind (which machine and
 * model get logged, that iron rules have codes you can cite, how to turn the checks off).
 * In came the everyday moments that had no tip at all: starting the day, wrapping it up,
 * reporting a bug, team standards. Several others lost their internal phrasing — no example
 * project names, no "multi-keyword query".
 *
 * A tip is a claim about the product, in the product's own voice. Write it for someone who
 * has never read this file.
 *
 * Anchors are either:
 *   - `ownmind_*` — an MCP tool name mcp/index.js registers, or
 *   - `file:<path>` — a repo-relative file whose existence backs a capability no single
 *     tool call covers (the memory files on disk, the machine/model logging, compaction).
 *
 * Adding a tip: write the anchor first. If there isn't one, the tip is describing something
 * that has not been built.
 */

export const TIPS = [
  { text: 'Say "remember this" and I will write the experience into memory, persisted across platforms', anchor: 'ownmind_save' },
  { text: 'Say "add an iron rule" and I will record the full context so the same mistake won\'t happen again', anchor: 'ownmind_save' },
  { text: 'Say "hand off my work" and I will package up what is in progress so another tool or session can take over', anchor: 'ownmind_handoff_create' },
  { text: 'Starting the day? Say "I am starting work" and I will pick up whatever handoff was left waiting', anchor: 'ownmind_handoff_accept' },
  // "pick it up later just by asking", not "carry on automatically": nothing surfaces session
  // logs at the next start — the SessionStart context renders profile, iron rules, principles
  // and a pending handoff, and retrieval is a search the user has to ask for.
  { text: 'Say "wrapping up" and I will record where things stand, so you can pick it up later just by asking', anchor: 'ownmind_log_session' },
  { text: 'Say "what memories do I have" and I will list all your preferences, iron rules, and project context', anchor: 'ownmind_get' },
  { text: 'Say "organize memory" and I will review this conversation and find experiences worth saving', anchor: 'ownmind_save' },
  { text: 'Ask "what did you learn" or "any new knowledge today" to have the AI review and record learnings', anchor: 'ownmind_save' },
  { text: 'Whether you use Claude, Cursor, or Codex, OwnMind gives all your AIs the same shared memory', anchor: 'ownmind_init' },
  { text: 'Iron rules are never deleted — only disabled with a recorded reason, for later review', anchor: 'ownmind_disable' },
  { text: 'Every iron rule records the incident behind it, so you (and the AI) know why the rule exists', anchor: 'ownmind_save' },
  { text: 'Ask "what did I work on recently" and I will recap from your session logs', anchor: 'ownmind_search' },
  { text: 'After a handoff, whoever picks it up can see where you left off — you do not have to explain it again', anchor: 'ownmind_handoff_accept' },
  // Narrower than it looks, and the tip has to say so: resolveMemoryDir() needs
  // CLAUDE_PROJECT_DIR, and SYNCABLE_TYPES is three of the nine memory types.
  { text: 'In Claude Code, your iron rules and project notes are mirrored to local markdown files — the data is always yours', anchor: 'file:hooks/lib/sync-memory-files.js' },
  { text: 'Say "search my memory for X" and I will look through titles, content, tags and code', anchor: 'ownmind_search' },
  { text: 'Switching computers? Install OwnMind and all your memories sync — no need to re-teach the AI', anchor: 'ownmind_init' },
  { text: 'Ask "what is left on this project" and I will answer from that project\'s memory', anchor: 'ownmind_get' },
  { text: 'Every handoff records the source tool and model so you can trace which AI made each decision', anchor: 'ownmind_handoff_create' },
  { text: 'Ask "how did this iron rule originate" and I will show you the full incident background', anchor: 'ownmind_get' },
  // Phrased around what the user does, not around what the detector catches. The write-time
  // secret scan is conservative by design (shared/secret-detect.js prefers a miss to a wrong
  // block), so "anything sensitive is never written into a memory" would be a promise the
  // product deliberately does not make — and believing it is how a token ends up in plaintext.
  { text: 'Say "store this as a secret" for passwords and tokens — they are encrypted and kept out of your memories', anchor: 'ownmind_set_secret' },
  { text: 'Say "update this project\'s progress" and I will refresh its status and todos', anchor: 'ownmind_update' },
  { text: 'Memory is short-term and long-term: session logs auto-compress; iron rules and decisions are kept forever', anchor: 'file:src/routes/session.js' },
  { text: 'Say "this project is finished" and I will archive the whole context and what you took away from it', anchor: 'ownmind_save' },
  { text: 'Say "report an OwnMind bug" to send the problem straight to the administrators', anchor: 'ownmind_report_bug' },
  // v1.26.128: this claim is now delivered rather than asserted — render-session-context.js
  // renders team_standards_digest, which it had been dropping. What still backs it is the AI
  // following loaded rules, the same footing iron rules stand on; no hook blocks a violation.
  { text: 'OwnMind has team standards: every member\'s AI follows the same rules automatically, so nobody breaks them by accident', anchor: 'ownmind_upload_standard' },
];

/**
 * The tip pool as it appears in the operations manual served to API clients.
 * Rendered rather than duplicated: the manual and the MCP responses are one list.
 */
export function renderTipPool() {
  return TIPS.map((t) => `- ${t.text}`).join('\n');
}

/**
 * The static tip about team standards, and the reason it is singled out.
 *
 * v1.26.148 (issue #85): it announces that the mechanism exists — "OwnMind has team
 * standards" — which tells a member nothing about what their own company has made askable.
 * A colleague could not know 「幫我發 pages」 works unless somebody told them out loud, and
 * this line is the only place the product speaks to them every day.
 *
 * So when the caller knows the user's own invocable standards, this entry steps aside for
 * them. It is a replacement rather than an addition: adding N company sentences to a
 * 25-entry pool would quietly turn the pool into mostly company sentences.
 */
const TEAM_STANDARD_ENTRY = TIPS.find((t) => t.anchor === 'ownmind_upload_standard');
if (!TEAM_STANDARD_ENTRY) {
  // Thrown rather than tolerated: `?.text` would leave the static line in the pool beside the
  // company's own sentences, which is the state this entry exists to prevent. The throw is at
  // import, so it surfaces the moment anything loads this module rather than one tip later.
  throw new Error('shared/tips.js: no tip anchored to ownmind_upload_standard — getRandomTip has nothing to replace');
}
const TEAM_STANDARD_TIP = TEAM_STANDARD_ENTRY.text;

let lastTip = null;

/**
 * One tip at random, never the same one twice in a row.
 *
 * @param {object} [options]
 * @param {string[]} [options.invocableHints] sentences from the user's own team standards,
 *   as built by shared/invocable-standards.js. When present they take the place of the
 *   static team-standard tip; when absent nothing changes for anyone.
 * @returns {string}
 */
export function getRandomTip({ invocableHints = [] } = {}) {
  const hints = (Array.isArray(invocableHints) ? invocableHints : [])
    .filter((h) => typeof h === 'string' && h.trim() !== '')
    .map((h) => h.trim());

  const pool = hints.length > 0
    ? [...TIPS.map((t) => t.text).filter((text) => text !== TEAM_STANDARD_TIP), ...hints]
    : TIPS.map((t) => t.text);

  let choice;
  do {
    choice = pool[Math.floor(Math.random() * pool.length)];
  } while (choice === lastTip && pool.length > 1);
  lastTip = choice;
  return choice;
}
