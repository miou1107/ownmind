/**
 * client/src/pages/Team/members-vm.js
 *
 * v1.32.5 — the member's view of 團隊 › 成員, as data. From the team half of
 * /api/me/report (`team.users`, one row per account with sessions / events /
 * last_activity in the range) produce table rows with the one status a member can act
 * on: whether OwnMind has seen this person at all in the range.
 *
 * Sorted by most recent activity, the people with no record last, so the table reads
 * "who is around" before "who is missing".
 */
export function memberRows(users, t) {
  const list = Array.isArray(users) ? users : [];
  const rows = list.map((u) => {
    const last = u.last_activity ?? null;
    const sessions = Number.parseInt(u.sessions, 10) || 0;
    const visible = last ? 'yes' : 'no';
    return {
      id: u.id,
      name: u.name || u.email || `#${u.id}`,
      role: ['user', 'admin', 'super_admin'].includes(u.role) ? u.role : 'user',
      lastActivity: last,
      sessions,
      visible,
      visibleLabel: visible === 'yes' ? t('members.visible.yes') : t('members.visible.no'),
    };
  });
  return rows.sort((a, b) => {
    const at = a.lastActivity ? new Date(a.lastActivity).getTime() : -Infinity;
    const bt = b.lastActivity ? new Date(b.lastActivity).getTime() : -Infinity;
    if (at !== bt) return bt - at;
    return String(a.name).localeCompare(String(b.name));
  });
}
