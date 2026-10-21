/**
 * render-session-context.js
 *
 * Pure render function used by hooks/ownmind-session-start.sh.
 * Receives the memory data + broadcasts array returned by the init API and produces the
 * SessionStart hook's additionalContext string.
 *
 * Extracted for unit testing (tests/session-start-render.test.js).
 */

import { getRandomTip } from '../../shared/tips.js';
import { hintsFromStandards } from '../../shared/invocable-standards.js';
import { bugReportNotificationLines } from './bug-report-notifications.js';
import { missingSkillContextLines } from './missing-skills.js';
import { t as translate } from './i18n.js';

/**
 * How much of one broadcast's body reaches the session, and what happens to the rest.
 *
 * The old line was `body.split('\n').slice(0, 5).join(' ').slice(0, 400)` — three lossy
 * operations at once, none of them announced. A ten-line notice arrived as one run-on
 * sentence stopping mid-word, and neither the person who wrote it nor the person reading it
 * could tell anything was missing. Bug #26.
 *
 * A cap is still right: a broadcast is written by an admin and pasted into every member's
 * session start, so one person pasting a document must not cost everybody their context. What
 * was wrong is a cap that lied about being one. The list of broadcasts three lines below has
 * always said "(N more broadcast(s) not shown)"; this now does the same thing for a body.
 */
const BODY_MAX_LINES = 60;
/**
 * Deliberately the same number the server refuses a broadcast above — see
 * `validateBroadcastPayload`, "body must not exceed 2000 characters". Matching it means
 * nothing the server accepted is ever cut here, and the notice below is a belt-and-braces for
 * a body that arrived some other way. Two caps that disagree is how the earlier bug worked:
 * the writer stayed inside one limit and a different, smaller one silently removed the rest.
 */
const BODY_MAX_CHARS = 2000;

export function broadcastBody(body) {
  const all = String(body ?? '').split('\n');
  const kept = [];
  let chars = 0;

  for (const line of all.slice(0, BODY_MAX_LINES)) {
    // The newline is charged BETWEEN lines, not after the last one — the length of what a
    // reader actually sees. Charging it after every line made a single 2000-character body
    // cost 2001 and dropped the whole thing, one character over the server's own limit.
    const cost = line.length + (kept.length ? 1 : 0);
    if (chars + cost > BODY_MAX_CHARS) break;
    chars += cost;
    kept.push(line);
  }

  const droppedLines = all.length - kept.length;
  if (droppedLines > 0) {
    const droppedChars = all.slice(kept.length).join('\n').length;
    kept.push('');
    kept.push(`（還有 ${droppedLines} 行、約 ${droppedChars} 字沒顯示。要看全文的話問 AI，或到 OwnMind 後台看這則公告。）`);
  }
  return kept;
}

// v1.33.0 — handoffs and the consolidation card.

const HANDOFF_GRACE_MINUTES = 30;
/** Pending handoffs of other projects, one line each; past this, one line with the count. */
const ELSEWHERE_MAX_LINES = 3;
const HANDOFF_BODY_MAX_LINES = 80;
const HANDOFF_BODY_MAX_CHARS = 4000;

/** The whole segments of a project name: `nantou-funbus_admin v2/api.x` → nantou, funbus, admin, v2, api, x. */
function nameSegments(name) {
  return String(name || '').trim().toLowerCase().split(/[-_\s/.]+/).filter(Boolean);
}

/**
 * Does a handoff written for `handoffProject` belong to the directory this session runs in?
 *
 * Case-insensitive, and either name may extend the other by whole segments: `Vinutes` matches
 * `vinutes`, `nantou-funbus` matches `nantou-funbus-admin` and the other way round, a handoff
 * written as `ownmind` is accepted in a checkout called `OwnMind-worktree`. Segments are split
 * on `-`, `_`, space, `/` and `.`, and the shorter name must be the *leading* segments of the
 * longer one — a sub-project is named by extending its parent's name, not by containing it.
 *
 * Until the review of v1.33.0 this was a substring test in either direction with no floor, so
 * a handoff for `api` was accepted in `fapa-api-gateway`, `ai` in `main`, `bot` in anything
 * with the word in it — and accepted means `ownmind_handoff_accept` is called at once. A
 * trailing segment is the same mistake one notch up (`bot` is a segment of
 * `line-summarizer-bot`), which is why the match is anchored at the start.
 *
 * Both sides must have at least one segment; a blank matches nothing.
 *
 * @param {string|null|undefined} handoffProject
 * @param {string[]} aliases the names the current directory answers to
 */
export function handoffMatchesProject(handoffProject, aliases) {
  const target = nameSegments(handoffProject);
  if (target.length === 0) return false;
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const mine = nameSegments(alias);
    if (mine.length === 0) continue;
    const [shorter, longer] = mine.length <= target.length ? [mine, target] : [target, mine];
    if (shorter.every((segment, i) => longer[i] === segment)) return true;
  }
  return false;
}

/** Minutes since `acceptedAt`, or null when the timestamp cannot be read. */
function minutesSince(acceptedAt, now) {
  const ms = Date.parse(acceptedAt);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((now - ms) / 60000));
}

/** A handoff's text, capped the way a broadcast is, and saying so when it cuts. */
function handoffBody(content) {
  const all = String(content ?? '').split('\n');
  const kept = [];
  let chars = 0;
  for (const line of all.slice(0, HANDOFF_BODY_MAX_LINES)) {
    const cost = line.length + (kept.length ? 1 : 0);
    if (chars + cost > HANDOFF_BODY_MAX_CHARS) break;
    chars += cost;
    kept.push(line);
  }
  if (kept.length < all.length) {
    kept.push(`(… ${all.length - kept.length} more line(s) not shown; the full text is on the console's handoffs page)`);
  }
  return kept;
}

/**
 * The handoff sections. Pure: the rows come in, the lines go out.
 *
 * @param {object[]} rows  `{id, project, from_machine, content, status, accepted_at}`
 * @param {object} opts
 * @param {string[]} opts.aliases  the current directory's names
 * @param {string|null} opts.machine
 * @param {number} opts.now
 * @param {Function} opts.t
 * @returns {string[]}
 */
export function handoffContextLines(rows, { aliases, machine, now, t }) {
  const lines = [];
  const elsewhere = [];
  for (const h of Array.isArray(rows) ? rows : []) {
    if (!h || typeof h !== 'object') continue;
    const matches = handoffMatchesProject(h.project, aliases);
    const from = h.from_machine ? `, from ${h.from_machine}` : '';
    const project = h.project || '?';
    if (h.status === 'pending') {
      if (!matches) { elsewhere.push(h); continue; }
      lines.push(`## Handoff to accept now (#${h.id}${from})`);
      for (const line of handoffBody(h.content)) lines.push(line);
      lines.push('');
      lines.push(`Accept it before anything else: ownmind_handoff_accept({ id: ${h.id}, accepted_by: ${JSON.stringify(machine || 'this machine')} }). `
        + 'Then tell the person this one line, exactly as written, in your first reply: '
        + t('handoff.accepted', { project }));
      lines.push('');
    } else if (h.status === 'accepted' && matches) {
      const minutes = minutesSince(h.accepted_at, now);
      if (minutes === null || minutes > HANDOFF_GRACE_MINUTES) continue;
      lines.push(`## Handoff #${h.id} was taken by another window ${minutes} minute(s) ago (${project}${from})`);
      for (const line of handoffBody(h.content)) lines.push(line);
      lines.push('');
      lines.push('Do not accept it again; it is already yours to read. Tell the person once: '
        + t('handoff.takenByAnotherWindow', { minutes }));
      lines.push('');
    }
  }
  if (elsewhere.length > 0) {
    lines.push('## Handoffs waiting in other projects');
    for (const h of elsewhere.slice(0, ELSEWHERE_MAX_LINES)) {
      lines.push(`- #${h.id ?? '?'} (${h.project || '?'}): tell the person once — `
        + t('handoff.waitingElsewhere', { project: h.project || '?' })
        + ' — and do not accept it from here.');
    }
    if (elsewhere.length > ELSEWHERE_MAX_LINES) {
      lines.push(`- and ${elsewhere.length - ELSEWHERE_MAX_LINES} more: tell the person once — `
        + t('handoff.waitingElsewhereMore', { count: elsewhere.length - ELSEWHERE_MAX_LINES }));
    }
    lines.push('');
  }
  return lines;
}

/**
 * The consolidation sections: an open card to run in the background, a finished card's
 * one-line report, and the questions only the person can answer.
 *
 * @param {object|null|undefined} consolidation  `{card, report, questions}` from init
 * @param {object} opts
 * @param {Function} opts.t
 * @returns {string[]}
 */
export function consolidationContextLines(consolidation, { t }) {
  const lines = [];
  const c = consolidation && typeof consolidation === 'object' ? consolidation : null;
  if (!c) return lines;

  const card = c.card && typeof c.card === 'object' && c.card.id != null ? c.card : null;
  if (card && (card.status === 'open' || card.status === 'claimed' || card.status == null)) {
    lines.push(`## Memory consolidation card #${card.id} is open${card.title ? ` (${card.title})` : ''}`);
    lines.push('Run it now in a background subagent (Agent tool) so the person is not kept waiting; '
      + 'do not work it in this conversation. The subagent follows the `ownmind-consolidate` skill: '
      + `it starts with ownmind_task_claim({ id: ${card.id} }) — and stops if another session already holds the card — `
      + 'then ownmind_consolidation_candidates, and ends with ownmind_task_done with evidence. '
      + 'Tell the person in one short line that the memory tidy-up is running in the background; do not list candidates to them.');
    lines.push('');
  }

  const report = c.report && typeof c.report === 'object' ? c.report : null;
  if (report) {
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    lines.push('## Memory consolidation report (relay this line once, as written)');
    lines.push(t('consolidation.report', {
      month: report.month || '',
      merged: n(report.merged), archived: n(report.archived), decided: n(report.decided),
    }));
    lines.push('Say it in your first reply, after whatever the person asked about. If they want '
      + 'something back: ownmind_restore({ id }) for an archived memory, ownmind_task_reopen for a card.');
    lines.push('');
  }

  const questions = (Array.isArray(c.questions) ? c.questions : [])
    .filter((q) => q && typeof q === 'object' && q.question).slice(0, 3);
  if (questions.length > 0) {
    lines.push('## Questions for the person (ask at a natural moment, at most 3)');
    for (const q of questions) {
      const where = q.project ? `, project ${q.project}` : '';
      lines.push(`- Q#${q.id} about memory #${q.memory_id}${where}: ${String(q.question).replace(/\s*\n\s*/g, ' ')}`);
    }
    lines.push('Ask when the conversation touches that project or at a pause, never as the first thing. '
      + 'When they answer: ownmind_decide({ id: <memory_id>, decision, source_id }) records a decision '
      + '(source_id is a newer memory holding the answer; save one with ownmind_save first if none exists); '
      + 'ownmind_archive({ id: <memory_id>, reason }) closes a project memory whose subject is over. '
      + 'A question asked twice with no answer archives its memory on its own.');
    lines.push('');
  }
  return lines;
}

/**
 * @param {Object} data  memory init response (server_version, profile, iron_rules_digest, principles, active_handoff)
 * @param {Array}  broadcasts  fetched from /api/broadcast/active
 * @param {Object} [deps]  injection point for tests
 * @param {Function} [deps.tip]  supplies the tip line
 * @returns {string}  additionalContext
 */
/**
 * @param {object} data the init payload
 * @param {object[]} broadcasts
 * @param {object} [opts]
 * @param {Function} [opts.tip]
 * @param {object|null} [opts.notifications] the bug-report notifications endpoint's answer.
 *   Passed in rather than fetched here so this stays a pure function; the Windows hook and
 *   session-start-output.js each fetch it and hand it over.
 * @param {object[]} [opts.missingSkills] rules whose skills this machine lacks (issue #139),
 *   from hooks/lib/missing-skills.js. Handed in for the same reason: finding them reads the
 *   disk, and this function does not.
 * @param {string|null} [opts.project] the current project's name (resolveProjectName()).
 * @param {string[]} [opts.projectAliases] every name this directory answers to — the folder
 *   name plus the git remote's repository name (hooks/lib/project-aliases.js). A handoff is
 *   accepted here when its project matches any of them.
 * @param {string|null} [opts.machine] this machine's name, what `accepted_by` records.
 * @param {number} [opts.now] clock for the 30-minute handoff grace; injected by tests.
 * @param {Function} [opts.t] the locale lookup for the lines the person reads.
 */
export function renderSessionContext(data, broadcasts, {
  tip = getRandomTip, notifications = null, missingSkills = [],
  project = null, projectAliases = null, machine = null, now = Date.now(), t = translate,
} = {}) {
  const lines = [];

  // v1.17.0 P3: broadcasts go first so the AI relays them first; cap at 3 to avoid context bloat.
  const bcList = Array.isArray(broadcasts) ? broadcasts : [];
  if (bcList.length > 0) {
    lines.push('## 📢 OwnMind broadcast');
    for (const bc of bcList.slice(0, 3)) {
      const sev = String(bc.severity || 'info').toUpperCase();
      lines.push('> **[' + sev + '] ' + String(bc.title || '').replace(/\n/g, ' ') + '** (notice #' + bc.id + ')');
      for (const line of broadcastBody(String(bc.body || ''))) lines.push('> ' + line);
      if (bc.cta_text) {
        const upgradeHint = bc.cta_action === 'upgrade_ownmind' ? '(let the AI run the upgrade)' : '';
        lines.push(('> 👉 Say "' + bc.cta_text + '" ' + upgradeHint).trim());
      }
      if (bc.allow_snooze) {
        const h = Number.isFinite(Number(bc.snooze_hours)) ? Number(bc.snooze_hours) : 24;
        lines.push('> (Not ready? Say "snooze upgrade" to defer for ' + h + ' hours)');
      }
      lines.push('');
    }
    if (bcList.length > 3) {
      lines.push('(' + (bcList.length - 3) + ' more broadcast(s) not shown)');
      lines.push('');
    }
    const hasForced = bcList.slice(0, 3).some(bc =>
      ['warning', 'error'].includes(String(bc.severity || '').toLowerCase()) ||
      bc.type === 'upgrade_reminder'
    );
    if (hasForced) {
      lines.push('> **[SYSTEM] Action required:** The notice above is mandatory severity (WARNING/ERROR or version update). In your first response sentence, proactively tell the user the notice content and the action they can take (upgrade / acknowledged / snooze). Do not skip; do not wait for the user to ask.');
      lines.push('');
    }
    // "Acknowledged" used to be offered with nothing behind it: the AI said "noted" and the
    // same notice opened the next conversation, on every machine, until someone called the
    // server by hand.
    lines.push('> [SYSTEM] If the user says they already know about a notice or do not want to see it again, call ownmind_dismiss_notice with its notice number. Replying "noted" does not turn it off.');
    lines.push('');
  }

  const d = data || {};
  lines.push('[OwnMind v' + (d.server_version || '?') + '] Memory loaded: your personal memories are now active');
  lines.push('');

  if (d.profile) {
    lines.push('## Profile');
    lines.push('- ' + (d.profile.title || '') + ': ' + String(d.profile.content || '').substring(0, 200));
    lines.push('');
  }

  if (d.iron_rules_digest) {
    // v1.19: append a tier-distribution summary after the heading (skip when an older server
    // doesn't return iron_rules_tier_counts).
    const tc = d.iron_rules_tier_counts;
    if (tc && typeof tc === 'object' && tc.total > 0) {
      lines.push('## Iron rules (strictly enforced) — ' + tc.total + ' total (🔴 Critical ' +
        (tc.critical || 0) + ' / 🟡 Default ' + (tc.default || 0) + ' / ⚪ Advisory ' +
        (tc.advisory || 0) + ')');
    } else {
      lines.push('## Iron rules (strictly enforced)');
    }
    lines.push(d.iron_rules_digest);
    lines.push('');
  }

  // Issue #139: straight after the rules, because it qualifies them. Printed even when the
  // digest is empty, since the rules it names were still delivered some other way.
  for (const line of missingSkillContextLines(missingSkills)) lines.push(line);

  // v1.26.128: the init response has carried team_standards_digest since team standards shipped —
  // outside the `!compact` guard, i.e. deliberately sent on this exact path — and this
  // renderer never read it. So a team's rules were loaded for anyone whose tool calls
  // ownmind_init and silently skipped for everyone whose tool loads memory through the
  // SessionStart hook, which is every Claude Code user. Same shape as the missing tip in
  // v1.26.127: the server sent it, the renderer dropped it, and nothing said so.
  if (d.team_standards_digest) {
    lines.push('## Team standards (follow these like your own rules)');
    lines.push(d.team_standards_digest);
    // v1.26.141: this line used to read `ownmind_get("standard_detail")`, which returns []
    // for a standard whose text lives on its own record rather than in child fragments —
    // i.e. for the ones written most recently. Two assistants given only this context both
    // found the right standard by its title, both followed this instruction, and both would
    // have got nothing back. Search is what actually resolves a title to a row.
    lines.push('These are titles. Read one in full before you follow it: '
      + 'ownmind_search("<its title>"), then ownmind_get({ id }) on the row it returns.');
    lines.push('');
  }

  if (Array.isArray(d.principles) && d.principles.length > 0) {
    lines.push('## Working principles');
    for (const p of d.principles) lines.push('- ' + (p.title || ''));
    lines.push('');
  }

  // v1.33.0: the matching project accepts a handoff; nobody presses 接手 on the console any
  // more. `handoffs` is what a v1.33 server sends (pending rows plus those accepted in the
  // last 30 minutes); `active_handoff` is the single pending row older servers send.
  const handoffRows = Array.isArray(d.handoffs)
    ? d.handoffs
    : (d.active_handoff ? [{ status: 'pending', ...d.active_handoff }] : []);
  const aliases = projectAliases || (project ? [project] : []);
  for (const line of handoffContextLines(handoffRows, { aliases, machine, now, t })) lines.push(line);

  // v1.31.3: the current project's task cards, so "continue #12" means something in a new
  // conversation. A reminder, declared as such: it lists, it does not claim.
  if (d.tasks && Array.isArray(d.tasks.cards) && d.tasks.cards.length > 0) {
    lines.push('## Task cards (' + d.tasks.project + ')');
    for (const c of d.tasks.cards) {
      const who = c.status === 'claimed' ? (c.holder === 'you' ? ' — claimed by you' : ' — claimed by ' + (c.holder || 'someone')) : '';
      lines.push('- #' + c.id + who + ' — ' + (c.title || ''));
    }
    // v1.33.0: done closes the card — there is no 審過 step any more — so done needs the
    // proof a reviewer would have asked for.
    lines.push('Use ownmind_task_claim before working on one; ownmind_task_done when finished — '
      + 'done needs evidence: run the card\'s verification and pass what it printed.');
    lines.push('');
  }

  // v1.31.0 rendered "Lessons waiting: N — see the console". Gone in v1.33.0: the AI promotes
  // a lesson on its second occurrence or at the monthly pass, so nothing waits on a person.
  // `lessons_waiting` still arrives from the server for older hooks and is ignored here.

  // v1.33.0: the monthly consolidation card, its one-line report, and the questions only a
  // person can answer. The marks that say "shown" are sent by the entry points
  // (hooks/lib/session-live-state.js), not here — this function stays pure.
  for (const line of consolidationContextLines(d.consolidation, { t })) lines.push(line);

  lines.push('The ownmind_* MCP tools manage memory. For full iron rule content: ownmind_get("iron_rule").');

  // v1.26.141: everything above is a push — here is what is known. Nothing was a pull, and
  // the difference is what users experience as "the AI forgot OwnMind exists".
  //
  // Measured: a colleague saying 「發 pages」 gets looked up, because the wording happens to
  // match a title in the list above. The same colleague saying 「公司 pages」 does not, because
  // no line anywhere told the AI that an unrecognised term is a reason to go and look. The
  // lists are titles; matching one is luck, and luck was the whole mechanism.
  //
  // Scoped to terms it does not recognise on purpose. "Search every message" is noise, and
  // noise is what gets ignored.
  // Worded to match configs/ownmind-rules-block.md and the ownmind_search tool description.
  // The same rule now reaches the model from three directions, and three wordings of one rule
  // read as three rules — the vaguest of which wins.
  //
  // "Points at them, not at the world" rather than "a term you do not recognise": the reported
  // miss was 「公司 pages」, where every word is one the model knows and only the referent is
  // unfamiliar. A trigger keyed on unfamiliar *vocabulary* does not fire on it.
  lines.push('When something in the request points at them rather than at the world — a name, '
    + 'tool, site, process, server or decision you cannot resolve from the repo in front of '
    + 'you, or a phrase you would have to guess at ("the company X", "our Y", "the usual Z") — '
    + 'call ownmind_search("<it>") BEFORE you answer or start work. The lists above are titles '
    + 'only; not seeing something there does not mean it is not in memory.');
  // The sharper half of the same rule, because it names the exact sentence that goes wrong.
  //
  // Reported 2026-08-11: a server's access details had been in memory for weeks, and the AI
  // still answered "I do not have information about legacy-server.example" — then found it immediately
  // when told to look. Nothing above lists project memories at all (profile, iron rules,
  // standard titles, principle titles — no projects), so from where it sat, not knowing was
  // indistinguishable from there being nothing to know.
  //
  // Saying "I do not have that" is a claim about memory. It requires having looked.
  lines.push('Never tell the user you have no information about something of theirs — a '
    + 'server, a project, a credential, a decision — until you have run ownmind_search on it '
    + 'in this session. "I do not have that" is a claim about their memory, and you have not '
    + 'read it yet.');

  // Bug-report notifications, ahead of the closing tip. Handed in rather than fetched — see
  // the module's header for why the fetch cannot live inside either platform's entry point.
  for (const line of bugReportNotificationLines(notifications)) lines.push(line);

  // v1.26.127: this is where the invented tips came from. The config templates tell the AI to
  // print a tip right after the startup memory load — and until now nothing on this path
  // supplied one. A tip rides on MCP *tool responses*; loading memory through the SessionStart
  // hook is not a tool call, so the instruction landed with no tip available and the model
  // filled the gap, sometimes with advice that had nothing to do with OwnMind.
  //
  // An instruction to relay something is only safe where the something exists.
  lines.push('');
  // Not "verbatim": the tips are written in English and the AI answers in the user's language,
  // so a literal instruction it has to break teaches it that these instructions are negotiable
  // — on the one guard the whole change leans on. The templates use the same framing.
  // v1.26.148 (issue #85): where the company has marked standards as askable, the tip says
  // one of those instead of announcing that team standards exist. The list rides on the init
  // response the hook already has, so this costs no extra call.
  lines.push('Tip (relay this one — translate it if you are speaking another language, but keep any quoted '
    + 'phrase the user is meant to say exactly as written, and do not compose your own): ' + tip({ invocableHints: hintsFromStandards(d.invocable_standards) }));

  return lines.join('\n');
}
