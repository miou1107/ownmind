/**
 * render-session-context.js
 *
 * 給 hooks/ownmind-session-start.sh 用的 render 純函式。
 * 接收 init API 回來的 memory data + broadcasts array，
 * 回傳 SessionStart hook additionalContext 的字串。
 *
 * 拆出來做 unit test（tests/session-start-render.test.js）。
 */

/**
 * @param {Object} data  memory init response（server_version、profile、iron_rules_digest、principles、active_handoff）
 * @param {Array}  broadcasts  由 /api/broadcast/active 取回
 * @returns {string}  additionalContext
 */
export function renderSessionContext(data, broadcasts) {
  const lines = [];

  // v1.17.0 P3：廣播放最前面，AI 會優先轉述；最多 3 則避免 context 膨脹
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
    // v1.19: 標題後加 tier 分佈 summary（舊 server 沒回 iron_rules_tier_counts 時跳過）
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

  return lines.join('\n');
}
