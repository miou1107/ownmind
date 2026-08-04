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
    // v1.26.56: "no row at all" is not how the real endpoint reports a member
    // who has never used AI. loadUsersAggregate is a LEFT JOIN with COALESCE on
    // every column, so that member arrives as a row of zeros and the branch
    // above never fires — which is how "0 tokens / 0 次對話" ended up on screen
    // for exactly the people Requirement 7 is about. The server now says
    // outright whether any usage row existed, and that is what decides.
    //
    // Absent flag means an older server: fall through to measured, so a version
    // skew cannot flip every member to unmeasured.
    if (totals.has_usage_data === false) {
      return { ...u, usage: { measured: false } };
    }
    const input = Number(totals.input_tokens) || 0;
    const output = Number(totals.output_tokens) || 0;
    // v1.26.56: was `message_count`, which is a count of messages, under a
    // column the three locales label "sessions" / 次對話 / 回. It also excludes
    // tier 2 (Cursor / Antigravity), so a Cursor-only member — who now passes
    // the has_usage_data gate above — would have rendered "0 次對話" beside
    // their real session count. `totals.session_count` is tier 1 + tier 2.
    const sessions = Number(totals.session_count) || 0;
    return {
      ...u,
      usage: {
        measured: true,
        total_tokens: input + output,
        session_count: sessions,
      },
    };
  });
}
