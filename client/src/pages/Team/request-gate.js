// v1.26.56 — "only the newest request may write state".
//
// Extracted from StatsPage rather than left as two inline `if` lines, for the
// reason the rest of this codebase extracts its decisions: a guard that lives
// only in JSX can be asserted about but not executed, and this one is subtle
// enough that a reviewer reading it agreed it looked fine while it was absent.
//
// The failure it prevents, found in review: the page refetches on every select
// change, so two loads overlap the moment someone clicks twice. They resolve in
// arrival order, not issue order. The overview branch nulls `detail` and the
// detail branch nulls `overview`, so a late reply from the abandoned request
// nulls what the current one just set and the page renders nothing at all —
// no table, no spinner, no error. The user-to-user variant is quieter and
// worse: one member's numbers under another member's name.

/**
 * A monotonic gate. `begin()` starts a request and returns its token;
 * `isCurrent(token)` is true only for the most recently begun one.
 *
 * @returns {{ begin: () => number, isCurrent: (token: number) => boolean }}
 */
export function makeRequestGate() {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      return latest;
    },
    isCurrent(token) {
      return token === latest;
    },
  };
}
