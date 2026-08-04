// v1.26.58 — 團隊用量 (Stage 6). The row and coverage view models.
//
// Two payloads meet here. GET /api/usage/team-stats is a LEFT JOIN from `users`,
// so every member comes back whether or not they reported; GET
// /api/usage/admin/team-overview is an inner join against session_logs, so only
// members with conversations in the window appear at all. A member can therefore
// be in one, both, or neither, and the three cases mean different things:
//
//   in team-stats, has_usage_data false → the collector reported nothing
//   absent from team-overview            → no conversation was logged
//
// Requirement 7 is the reason they are kept apart instead of being COALESCE'd to
// zero on the way in: the legacy table rendered both as `0`, which reads as "this
// person barely uses it" when the truth is "we have nothing for this person".

import { complianceBand } from './stats-compliance-vm.js';

/** The metrics the ranking can be sorted by. Cost is gone; see Requirement 8. */
export const SORT_KEYS = ['usage', 'messages', 'active'];

/** pg hands bigint columns back as strings. */
function n(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}

/**
 * One row of the ranking.
 *
 * @param {object} usageRow  an entry of team-stats `users[]`
 * @param {object|null} member  the matching team-overview member, or null
 */
export function teamUsageRowVm(usageRow, member) {
  const { id, name, email } = usageRow.user;
  const t = usageRow.totals || {};
  const measured = t.has_usage_data === true;

  // Cache excluded from the headline on purpose: it is the same context read
  // back, it dwarfs the fresh figure by orders of magnitude, and a ranking over
  // the sum would order members by conversation length rather than by workload.
  const fresh = n(t.input_tokens) + n(t.output_tokens) + n(t.reasoning_tokens);
  const total = fresh + n(t.cache_creation_tokens) + n(t.cache_read_tokens);

  const compliance = member?.rule_compliance ?? null;
  // team-overview reports a fraction; the bands are in percent. Feeding 0.95
  // straight in would paint a 95% member red.
  const complianceRate = compliance && Number.isFinite(Number(compliance.rate))
    ? Math.round(Number(compliance.rate) * 100)
    : null;

  return {
    id,
    label: name || email || `user#${id}`,

    // Reported usage. Null rather than 0 when we have nothing, so no consumer
    // can average, sum or rank it by accident.
    measured,
    freshTokens: measured ? fresh : null,
    totalTokens: measured ? total : null,
    messageCount: measured ? n(t.message_count) : null,
    activeSeconds: measured ? n(t.active_seconds) : null,
    usageSessionCount: measured ? n(t.session_count) : null,

    // Logged conversations, from the other endpoint and absent for its own
    // separate reason.
    hasActivity: member != null,
    lastActiveIso: member?.last_active_at ?? null,
    sessionCount: member ? n(member.session_count) : null,
    topProject: member?.top_project ?? null,

    complianceRate,
    complianceBand: complianceBand(complianceRate),
    complianceCounts: compliance
      ? { complied: n(compliance.complied), triggered: n(compliance.triggered) }
      : null,
  };
}

const SORT_FIELD = {
  usage: 'freshTokens',
  messages: 'messageCount',
  active: 'activeSeconds',
};

/**
 * Rank the rows, with the unmeasured always last.
 *
 * They sort last rather than as zero because that is the whole point of marking
 * them: a member we have no data for must not be placed below a member who
 * genuinely did nothing, as though the two were the same observation.
 */
export function sortTeamRows(rows, sortBy) {
  const field = SORT_FIELD[sortBy] ?? SORT_FIELD.usage;
  return [...rows].sort((a, b) => {
    if (a.measured !== b.measured) return a.measured ? -1 : 1;
    const diff = (b[field] ?? 0) - (a[field] ?? 0);
    if (diff !== 0) return diff;
    return a.id - b.id;
  });
}

/**
 * The coverage panel.
 *
 * `pct` is over the members we are trying to measure — the exempt are excluded
 * from both halves, because they are missing deliberately and counting them as a
 * gap would leave the warning permanently lit.
 */
export function coverageVm(coverage) {
  if (!coverage) {
    return {
      known: false, totalUsers: 0, measured: 0, unmeasured: 0, optedOut: 0,
      pct: null, incomplete: false, missingNames: [], exemptNames: [],
    };
  }

  const totalUsers = n(coverage.total_users);
  const measured = n(coverage.measured);
  const optedOut = n(coverage.opted_out);
  const expected = totalUsers - optedOut;
  const pct = expected > 0 ? Math.round((measured / expected) * 100) : null;

  return {
    known: true,
    totalUsers,
    measured,
    unmeasured: n(coverage.unmeasured),
    optedOut,
    pct,
    // The legacy threshold, kept: below four fifths the ranking is partial
    // enough that reading it as the team's shape would be wrong.
    incomplete: pct !== null && pct < 80,
    missingNames: nameList(coverage.unmeasured_users),
    exemptNames: nameList(coverage.exempt_users),
  };
}

// Taiwan has no daylight saving, so the offset is a constant rather than a
// timezone lookup. Every other usage endpoint already buckets its days in
// Asia/Taipei (`toYmd` in src/routes/usage/stats.js), and these bounds line the
// session endpoints up with them.
const TAIPEI_OFFSET = '+08:00';

/**
 * Turn a YYYY-MM-DD pair into the instants the team-overview endpoints want.
 *
 * They parse with `new Date(req.query.to)`, and a bare date string is UTC
 * midnight by specification — so passing today's date as `to` cut the window at
 * 08:00 Taipei and the legacy page's 最近活動 column could never show anything
 * from the current working day. Sending explicit local bounds fixes that
 * without touching the endpoint.
 */
export function dayBoundsIso(from, to) {
  return {
    fromIso: `${from}T00:00:00.000${TAIPEI_OFFSET}`,
    toIso: `${to}T23:59:59.999${TAIPEI_OFFSET}`,
  };
}

function nameList(users) {
  return Array.isArray(users) ? users.map((u) => u.name || u.email || `user#${u.id}`) : [];
}
