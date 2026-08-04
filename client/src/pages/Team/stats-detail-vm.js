// v1.26.56 — the single-user detail blocks that are not charts or compliance.
//
// contextVm is the one with a behaviour change. The legacy page answers
// `context: null` with classList.add('hidden'): four blocks disappear and the
// reader cannot tell a broken feature from missing data. Requirement 7's last
// scenario says a value that could not be computed names its reason, so this
// always returns a shape and carries a reason key when there is nothing to show.

import { barChartRows } from './stats-chart-data.js';

/** i18n key for "no session in this period reported context data". */
export const CONTEXT_ABSENT_REASON = 'stats.context.absent';

/** 記憶數量卡片 — the stat-mini row above the charts. */
export function memoryCards(d) {
  const cards = [
    { key: 'memory_total', value: d.memory.total, tone: 'default' },
    { key: 'memory_active', value: d.memory.active, tone: 'default' },
    { key: 'memory_disabled', value: d.memory.disabled, tone: 'default' },
    { key: 'memory_created', value: d.memory.created_this_period, tone: 'default' },
    { key: 'sessions_total', value: d.sessions.total, tone: 'default' },
  ];

  // Conditional in the legacy page too. A permanent "0 recovered" card is noise
  // on every account that has never crashed mid-session.
  if (d.sessions.recovered > 0) {
    cards.push({ key: 'sessions_recovered', value: d.sessions.recovered, tone: 'warn' });
  }

  cards.push(
    { key: 'activity_events', value: d.activity.total_events, tone: 'default' },
    { key: 'rules_active', value: d.iron_rules.total_active, tone: 'default' },
    { key: 'rule_triggers', value: d.iron_rules.total_triggers, tone: 'default' },
  );
  return cards;
}

// `activity.by_event` is `GROUP BY event ORDER BY count DESC LIMIT 20`. Below
// that limit nothing was truncated, so a missing key is proof of zero.
const BY_EVENT_LIMIT = 20;

/**
 * Can we tell whether any init happened?
 *
 * `src/routes/activity.js` computes
 * `initRate = (initS + initF) > 0 ? … : 100`, so a member whose period contains
 * no init event at all is reported as a flawless 100%. Seen on the e2e fixture:
 * an account with one session and no init events rendered "Init 成功率 100%" in
 * green. That is a confident claim about something never observed.
 *
 * The endpoint cannot be changed in this stage, but the payload does carry
 * enough to detect the case. If fewer than twenty event types came back, the
 * LIMIT did not truncate anything, so `init` and `init_fail` being absent means
 * they genuinely did not occur. At or above the limit we cannot tell, and fall
 * back to trusting the number.
 */
function initRateMeasured(d) {
  const byEvent = d.activity?.by_event ?? {};
  if ('init' in byEvent || 'init_fail' in byEvent) return true;
  return Object.keys(byEvent).length >= BY_EVENT_LIMIT;
}

/** 系統健康. */
export function healthLines(d) {
  const rate = d.health.init_success_rate;
  const measured = initRateMeasured(d);
  return [
    {
      key: 'init_rate',
      value: measured ? rate : null,
      band: measured ? (rate >= 95 ? 'high' : 'low') : 'unmeasured',
      isPercent: true,
    },
    { key: 'sync_conflicts', value: d.health.sync_conflicts, band: null, isPercent: false },
    { key: 'updates_applied', value: d.health.updates_applied, band: null, isPercent: false },
  ];
}

/** 交接統計. */
export function handoffLines(d) {
  return [
    { key: 'handoff_total', value: d.handoffs.total, tone: 'default' },
    { key: 'handoff_completed', value: d.handoffs.completed, tone: 'ok' },
    { key: 'handoff_pending', value: d.handoffs.pending, tone: 'warn' },
  ];
}

/** `[[key, count], …]` — what Object.entries() left in top_actions / top_projects. */
function pairsToRows(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return [];
  return barChartRows(Object.fromEntries(pairs));
}

/**
 * 常用操作 / 專案分布 / 使用者痛點 / AI 改善建議.
 *
 * `available: false` covers both a null context and a context with no sessions.
 * Callers render `reasonKey` rather than hiding the section.
 */
export function contextVm(context) {
  const sessionsWithContext = Number(context?.sessions_with_context ?? 0);
  if (!context || !(sessionsWithContext > 0)) {
    return {
      available: false,
      reasonKey: CONTEXT_ABSENT_REASON,
      sessionsWithContext: 0,
      avgTurns: null,
      actions: [],
      projects: [],
      friction: [],
      suggestions: [],
    };
  }

  return {
    available: true,
    reasonKey: null,
    sessionsWithContext,
    avgTurns: context.avg_turns ?? null,
    actions: pairsToRows(context.top_actions),
    projects: pairsToRows(context.top_projects),
    friction: Array.isArray(context.friction_points) ? context.friction_points : [],
    suggestions: Array.isArray(context.suggestions) ? context.suggestions : [],
  };
}
