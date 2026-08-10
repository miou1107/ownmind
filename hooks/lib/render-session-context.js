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

/**
 * @param {Object} data  memory init response (server_version, profile, iron_rules_digest, principles, active_handoff)
 * @param {Array}  broadcasts  fetched from /api/broadcast/active
 * @param {Object} [deps]  injection point for tests
 * @param {Function} [deps.tip]  supplies the tip line
 * @returns {string}  additionalContext
 */
export function renderSessionContext(data, broadcasts, { tip = getRandomTip } = {}) {
  const lines = [];

  // v1.17.0 P3: broadcasts go first so the AI relays them first; cap at 3 to avoid context bloat.
  const bcList = Array.isArray(broadcasts) ? broadcasts : [];
  if (bcList.length > 0) {
    lines.push('## 📢 OwnMind broadcast');
    for (const bc of bcList.slice(0, 3)) {
      const sev = String(bc.severity || 'info').toUpperCase();
      lines.push('> **[' + sev + '] ' + String(bc.title || '').replace(/\n/g, ' ') + '**');
      lines.push('> ' + String(bc.body || '').split('\n').slice(0, 5).join(' ').slice(0, 400));
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
  lines.push('Tip (relay this one — translate it if you are speaking another language, '
    + 'but do not compose your own): ' + tip());

  return lines.join('\n');
}
