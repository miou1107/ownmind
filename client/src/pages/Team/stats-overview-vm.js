// v1.26.56 — one row of the 用戶活躍度總表, from GET /activity/stats/all.
//
// `now` is a parameter rather than a `Date.now()` call inside the function.
// The seven-day boundary is the entire meaning of the status dot, and a rule
// that reads the clock itself cannot have its boundary tested.

import { complianceBand } from './stats-compliance-vm.js';

export const ACTIVE_WINDOW_MS = 7 * 86400000;

/** pg returns COUNT(*) as a string; render-only use hides that until someone sums it. */
function toCount(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}

/** `{ key: count }` → `[{ key, count }]`, ordered by count descending. */
function pills(map) {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .map(([key, v]) => ({ key, count: toCount(v) }))
    .sort((a, b) => b.count - a.count);
}

export function overviewRowVm(user, nowMs) {
  const lastActiveIso = user.last_active ?? null;
  const lastActiveMs = lastActiveIso ? Date.parse(lastActiveIso) : NaN;

  // Strictly less than the window: pinned so a later `<=` cannot widen it.
  const isActive = Number.isFinite(lastActiveMs) && (nowMs - lastActiveMs) < ACTIVE_WINDOW_MS;

  // `compliance_rate` arrives as a string (the server does .toFixed(1)) or as
  // null when the period held no compliance events at all. Null is unmeasured
  // — it must not become 0 on the way through Number().
  const rawRate = user.compliance_rate;
  const complianceRate = rawRate === null || rawRate === undefined ? null : Number(rawRate);

  const tools = pills(user.tools);
  const models = pills(user.models);

  return {
    id: user.id,
    label: user.name || user.email || `user#${user.id}`,
    memoryCount: toCount(user.memory_count),
    sessionCount: toCount(user.session_count),
    tools,
    toolsMeasured: tools.length > 0,
    models,
    modelsMeasured: models.length > 0,
    complianceRate,
    complianceBand: complianceBand(complianceRate),
    lastActiveIso,
    neverActive: lastActiveIso === null,
    isActive,
  };
}
