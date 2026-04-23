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
    lines.push('## 📢 OwnMind 系統通知');
    for (const bc of bcList.slice(0, 3)) {
      const sev = String(bc.severity || 'info').toUpperCase();
      lines.push('> **[' + sev + '] ' + String(bc.title || '').replace(/\n/g, ' ') + '**');
      lines.push('> ' + String(bc.body || '').split('\n').slice(0, 5).join(' ').slice(0, 400));
      if (bc.cta_text) {
        const upgradeHint = bc.cta_action === 'upgrade_ownmind' ? '讓 AI 幫你升級' : '';
        lines.push('> 👉 可說「' + bc.cta_text + '」' + upgradeHint);
      }
      if (bc.allow_snooze) {
        const h = Number.isFinite(Number(bc.snooze_hours)) ? Number(bc.snooze_hours) : 24;
        lines.push('> （不想現在處理？可說「暫緩升級」延後 ' + h + ' 小時）');
      }
      lines.push('');
    }
    if (bcList.length > 3) {
      lines.push('（另有 ' + (bcList.length - 3) + ' 則廣播未顯示）');
      lines.push('');
    }
    const hasForced = bcList.slice(0, 3).some(bc =>
      ['warning', 'error'].includes(String(bc.severity || '').toLowerCase()) ||
      bc.type === 'upgrade_reminder'
    );
    if (hasForced) {
      lines.push('> **[SYSTEM] 強制行動要求：** 上方通知為強制等級（WARNING/ERROR 或版本更新）。你必須在本次回應的第一句主動告知使用者通知內容與可執行動作（升級 / 已收到 / 暫緩），不可略過、不可等使用者詢問。');
      lines.push('');
    }
  }

  const d = data || {};
  lines.push('【OwnMind v' + (d.server_version || '?') + '】記憶載入：已載入你的個人記憶');
  lines.push('');

  if (d.profile) {
    lines.push('## Profile');
    lines.push('- ' + (d.profile.title || '') + ': ' + String(d.profile.content || '').substring(0, 200));
    lines.push('');
  }

  if (d.iron_rules_digest) {
    lines.push('## 鐵律（必須嚴格遵守）');
    lines.push(d.iron_rules_digest);
    lines.push('');
  }

  if (Array.isArray(d.principles) && d.principles.length > 0) {
    lines.push('## 工作原則');
    for (const p of d.principles) lines.push('- ' + (p.title || ''));
    lines.push('');
  }

  if (d.active_handoff) {
    lines.push('## 待接手交接');
    lines.push('專案: ' + (d.active_handoff.project || '?'));
    lines.push('');
  }

  lines.push('ownmind_* MCP tools 可操作記憶。鐵律完整內容：ownmind_get("iron_rule")。');

  return lines.join('\n');
}
