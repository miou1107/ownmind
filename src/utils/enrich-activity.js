/**
 * enrichActivityDetails — enrich event.details before activity_logs hits the DB
 *
 * Why it exists:
 *   Before v1.17.88, the client MCP sent only { id, reason } to /api/activity/batch
 *   for ownmind_disable / ownmind_update, and the server wrote it straight into
 *   activity_logs.details. Later, when admin viewed /api/me/pitfalls it had to JOIN
 *   memories to fill in title/code, and a failed JOIN showed "(not found)".
 *   Nearly all 30 missing-observation records looked like this.
 *
 *   Fix: when the server receives an activity that is memory_disable / memory_update
 *   and the target is an iron_rule, immediately look up memories and snapshot
 *   code+title into event.details. Future activity_log views carry full context
 *   without needing a JOIN.
 *
 * Pure function — lookup is injected via a callback for easy unit testing (no DB).
 *
 * @param {Object} event - { event, details, ... }
 * @param {(id) => Promise<{type, code, title}|null>} lookup - memory lookup function
 * @returns {Promise<Object>} the enriched details (always returns an object, never throws)
 */
export async function enrichActivityDetails(event, lookup) {
  const baseDetails = event?.details && typeof event.details === 'object'
    ? event.details
    : {};

  // only enrich these two events
  if (event?.event !== 'memory_disable' && event?.event !== 'memory_update') {
    return baseDetails;
  }

  // no id → nothing to look up
  if (baseDetails.id === undefined || baseDetails.id === null) {
    return baseDetails;
  }

  // id must be numeric or convertible to a number (same regex as me.js pitfalls)
  const idStr = String(baseDetails.id);
  if (!/^\d+$/.test(idStr)) {
    return baseDetails;
  }

  // always swallow lookup errors — an enrich failure must not block the main INSERT
  let row = null;
  try {
    row = await lookup(parseInt(idStr, 10));
  } catch (_e) {
    return baseDetails;
  }

  if (!row) {
    return baseDetails;
  }

  // v1.17.90: snapshot disabled_type regardless of type
  //   Background: of the 30 missing-observation records in v1.17.88 pitfalls, prod
  //   verification found 22 (73%) were team_standard / standard_detail / project
  //   disables miscounted as iron_rule sensitive. The me.js pitfalls SQL needs
  //   disabled_type to filter out the genuine iron_rule disables.
  //
  // Snapshot semantics are "at lookup time", not "at the moment the event occurred":
  //   - memory_disable event: the activity log is written after the disable completes,
  //     so the looked-up title/code/type is the current value → consistent with intent
  //   - memory_update event: the log is written after the UPDATE, so lookup gets the
  //     post-update value. This is correct for pitfalls display (admin wants to know
  //     "what is this iron rule called"), but anyone expecting this field to be the
  //     "title at moment of trigger" would be misled.
  //
  // Use || null rather than || '' — only a JSONB NULL makes me.js's COALESCE fallback
  // JOIN fire correctly ('' is not NULL and would swallow the fallback)
  const enriched = {
    ...baseDetails,
    disabled_type: row.type || null,
  };

  // disabled_code / disabled_title are for admins to see "which iron rule was disabled";
  // written only for iron_rule (other types have no IR-XXX code, and their titles are
  // usually too long for inline display)
  if (row.type === 'iron_rule') {
    enriched.disabled_code = row.code || null;
    enriched.disabled_title = row.title || null;
  }

  return enriched;
}
