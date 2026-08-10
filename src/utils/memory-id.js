/**
 * Validate a `:id` path parameter before it reaches a query.
 *
 * `/api/memory/:id` is the last route registered, so every path that matched no
 * literal above it lands here as an id — `/api/memory/stats`, a typo, a client
 * still calling a route that was renamed. Those used to go to Postgres verbatim
 * and come back as `invalid input syntax for type integer`, which the route
 * reported as 500 "Query failed". A 500 tells the caller the server broke. The
 * server did not break; the path does not exist, which is a 404.
 *
 * Deliberately stricter than `parseInt`: `parseInt('12abc')` is 12, so a
 * fat-fingered path would quietly read a real row belonging to someone else.
 * Only a bare run of digits is an id. The upper bound is the ceiling of the INT
 * column it is compared against — one past it raises 22003, the same avoidable
 * 500 in a different disguise.
 *
 * @param {unknown} raw - the value from `req.params`
 * @returns {{ ok: true, id: number } | { ok: false }}
 */
const PG_INT_MAX = 2147483647;

export function parseMemoryId(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false };
  const s = String(raw);
  if (!/^\d+$/.test(s)) return { ok: false };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > PG_INT_MAX) return { ok: false };
  return { ok: true, id: n };
}
