// v1.26.58 — 團隊用量 (Stage 6), the member drill-down's view models.
//
// Two endpoints again: GET /api/usage/stats?user_id= for the totals and the
// distribution, GET /api/usage/admin/team-overview/:id/sessions for the recent
// conversations. Neither is changed here beyond the has_usage_data flag the
// first one now carries, for the same reason team-stats needed it: its columns
// are all COALESCE'd to zero, so "reported nothing" and "reported zeros" arrive
// looking identical.

import { complianceBand } from './stats-compliance-vm.js';

function n(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}

/**
 * The totals cards.
 *
 * No cost card, and no cost anywhere on the page: Requirement 8 removes the
 * calculation rather than fixing it, and the endpoint still answering with
 * `cost_usd` is not a reason to render it.
 *
 * @param {object} totals  `totals` from GET /api/usage/stats
 * @param {boolean} measured  its `has_usage_data`
 * @returns {Array<{key: string, value: number|null}>} null value = no data
 */
export function detailTotalsVm(totals, measured) {
  const t = totals || {};
  const fresh = n(t.input_tokens) + n(t.output_tokens) + n(t.reasoning_tokens);
  const cache = n(t.cache_creation_tokens) + n(t.cache_read_tokens);

  const cards = [
    { key: 'fresh_tokens', value: fresh },
    { key: 'cache_tokens', value: cache },
    { key: 'messages', value: n(t.message_count) },
    { key: 'wall', value: n(t.wall_seconds) },
    { key: 'active', value: n(t.active_seconds) },
    { key: 'sessions', value: n(t.session_count) },
  ];

  // All of them, not some: if the member reported nothing then every one of
  // these is a zero the query invented, and showing half as figures would make
  // the other half look like a rendering bug.
  if (!measured) return cards.map((c) => ({ ...c, value: null }));
  return cards;
}

/**
 * 用量分佈 — one bar per series key, scaled against the busiest.
 *
 * The legacy chart drew cost. With cost gone the bars carry the same fresh-token
 * figure the ranking does, so the two views agree on what "用量" means.
 *
 * `anyTokens` is false for a member whose tools only report session counts
 * (Cursor, Antigravity). That is not an empty period and the page must not
 * present it as one.
 */
export function usageBarRows(series) {
  const rows = (Array.isArray(series) ? series : []).map((r) => ({
    key: String(r.key),
    tokens: n(r.input_tokens) + n(r.output_tokens) + n(r.reasoning_tokens),
    sessions: n(r.session_count),
  }));
  const max = rows.reduce((m, r) => Math.max(m, r.tokens), 0);
  return {
    rows: rows.map((r) => ({ ...r, pct: max > 0 ? Math.round((r.tokens / max) * 100) : 0 })),
    anyTokens: max > 0,
  };
}

const OS_NAMES = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

/** `process.platform` as people say it. An unmapped code passes through. */
export function osDisplayName(raw) {
  if (!raw) return '';
  return OS_NAMES[raw] || raw;
}

const SUMMARY_MAX = 60;

/** One row of 最近對話. Unreported fields stay null so the page can name them. */
export function sessionRowVm(s) {
  const meta = s.machine_meta
    ? [osDisplayName(s.machine_meta.os), s.machine_meta.scanner_version].filter(Boolean).join(' · ')
    : '';

  const compliance = s.rule_compliance ?? null;
  const complianceRate = compliance && Number.isFinite(Number(compliance.rate))
    ? Math.round(Number(compliance.rate) * 100)
    : null;

  const full = s.summary || '';
  const truncated = full.length > SUMMARY_MAX;

  return {
    id: s.id,
    createdAtIso: s.created_at ?? null,
    tool: s.tool || null,
    model: s.model || null,
    machine: s.machine || null,
    machineMeta: meta || null,
    project: s.project ?? null,
    turns: s.duration_turns ?? null,
    complianceRate,
    complianceBand: complianceBand(complianceRate),
    complianceCounts: compliance
      ? { complied: n(compliance.complied), triggered: n(compliance.triggered) }
      : null,
    summary: truncated ? `${full.slice(0, SUMMARY_MAX)}…` : full,
    summaryFull: full,
    truncated,
  };
}
