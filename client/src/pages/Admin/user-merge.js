// Join /api/admin/users with /api/usage/team-stats.
//
// Requirement 2 in openspec/changes/v1.26.49-team-management-page/spec.md:
// missing data must never render as 0. The distinction — did this user report
// nothing, or did they report zeros? — must survive the merge, because the UI
// renders different strings for each ("尚無資料" italic vs "0 tokens").
//
// Cache tokens are deliberately excluded from the headline `total_tokens`:
// they can be ~250x larger than input+output for the same conversation, so
// showing them next to a headline number is misleading. Umbrella spec
// Requirement 6.

/**
 * @param {Array<object>} users  Rows from `/api/admin/users`.
 * @param {object|null}   stats  Body of `/api/usage/team-stats`, or null on fetch failure.
 * @returns {Array<object>}      One row per user, with a `.usage` object.
 */
export function mergeUsersWithUsage(users, stats) {
  const byId = new Map();
  const statsUsers = (stats && Array.isArray(stats.users)) ? stats.users : [];
  for (const s of statsUsers) {
    if (s && s.user && typeof s.user.id === 'number') {
      byId.set(s.user.id, s.totals || {});
    }
  }

  return users.map((u) => {
    const totals = byId.get(u.id);
    if (!totals) {
      return { ...u, usage: { measured: false } };
    }
    const input = Number(totals.input_tokens) || 0;
    const output = Number(totals.output_tokens) || 0;
    const messages = Number(totals.message_count) || 0;
    return {
      ...u,
      usage: {
        measured: true,
        total_tokens: input + output,
        session_count: messages,
      },
    };
  });
}
