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
 */
export function renderSessionContext(data, broadcasts, { tip = getRandomTip, notifications = null } = {}) {
  const lines = [];

  // v1.17.0 P3: broadcasts go first so the AI relays them first; cap at 3 to avoid context bloat.
  const bcList = Array.isArray(broadcasts) ? broadcasts : [];
  if (bcList.length > 0) {
    lines.push('## 📢 OwnMind broadcast');
    for (const bc of bcList.slice(0, 3)) {
      const sev = String(bc.severity || 'info').toUpperCase();
      lines.push('> **[' + sev + '] ' + String(bc.title || '').replace(/\n/g, ' ') + '**');
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

  if (d.active_handoff) {
    lines.push('## Pending handoff');
    lines.push('Project: ' + (d.active_handoff.project || '?'));
    lines.push('');
  }

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
  // still answered "I do not have information about kkvin.com" — then found it immediately
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
