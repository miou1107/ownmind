/**
 * install-check-alerts — decide which self-check failures are worth announcing.
 *
 * Pure: no database, no clock, no logging. Everything it needs arrives as
 * arguments so the run-twice behaviour (the point of the whole feature) can be
 * asserted directly rather than inferred from a live table.
 *
 * A failure is identified by (user_id, machine, check_name). One upgrade uploads
 * several reports (one per machine), and the same machine may report multiple
 * times. This function processes only the first (most-recent) report for each
 * machine and ignores all subsequent reports for that machine. The newest report
 * is the machine's current state; older reports are stale and contribute no
 * checks to the announcement decision.
 */

/**
 * @typedef {{name: string, status: string, detail?: string, fix?: string}} Check
 * @typedef {{user_id: number, user_name: string, machine: string, client_version: string|null, checks: Check[]}} MachineReport
 * @typedef {{user_id: number, machine: string, check_name: string, detail: string|null, announced_at: Date|null, resolved_at: Date|null}} AlertStateRow
 */

/** Stable identity for one failure. JSON so no separator can collide with a value. */
export function stateKey(userId, machine, checkName) {
  return JSON.stringify([userId, machine, checkName]);
}

/**
 * @param {{reports: MachineReport[], knownState: AlertStateRow[]}} input
 *
 * IMPORTANT caller obligations:
 * - Supply reports in newest-first order (ordered by descending timestamp).
 *   The function processes only the first (most-recent) report seen for each
 *   (user_id, machine) pair and skips all subsequent reports for that machine.
 * - Supply only reports whose checks array exists and is non-empty (no beacon
 *   rows). A beacon row can never be a machine's newest report per your SQL.
 */
export function evaluateFailures({ reports = [], knownState = [] } = {}) {
  const byKey = new Map(
    knownState.map((row) => [stateKey(row.user_id, row.machine, row.check_name), row])
  );

  const newFailures = [];
  const resolved = [];
  const detailChanges = [];
  const processedMachines = new Set(); // Track which (user_id, machine) pairs we have processed

  for (const report of reports) {
    // Skip if we have already processed this machine's most-recent report
    const machineKey = JSON.stringify([report.user_id, report.machine]);
    if (processedMachines.has(machineKey)) continue;

    const checks = Array.isArray(report?.checks) ? report.checks : [];

    for (const check of checks) {
      if (!check || typeof check.name !== 'string') continue;

      const key = stateKey(report.user_id, report.machine, check.name);
      const prev = byKey.get(key);
      const detail = typeof check.detail === 'string' ? check.detail : '';

      if (check.status === 'fail') {
        // Never announced, or announced and since resolved -> this is news.
        if (!prev || !prev.announced_at || prev.resolved_at) {
          newFailures.push({
            user_id: report.user_id,
            user_name: report.user_name,
            machine: report.machine,
            check_name: check.name,
            detail,
            fix: typeof check.fix === 'string' ? check.fix : '',
            client_version: report.client_version || '',
          });
        } else if ((prev.detail || '') !== detail) {
          // Same problem, new wording. Keep the record current, stay quiet.
          detailChanges.push({
            user_id: report.user_id,
            machine: report.machine,
            check_name: check.name,
            detail,
          });
        }
        continue;
      }

      // Not failing. Only a check that is present and no longer failing counts
      // as resolved; a check missing from the report says nothing either way.
      if (prev && prev.announced_at && !prev.resolved_at) {
        resolved.push({
          user_id: report.user_id,
          machine: report.machine,
          check_name: check.name,
        });
      }
    }

    // Mark this machine as processed after handling all checks from its report
    processedMachines.add(machineKey);
  }

  return { newFailures, resolved, detailChanges };
}

export default evaluateFailures;
