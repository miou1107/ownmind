# v1.26.136 — Proposal: a typo that reports a server failure

## What was measured

Production, 2026-08-10, during a full-surface sweep of every endpoint:

| request | response | server log |
|---|---|---|
| `GET /api/memory/stats` | **500** `{"error":"Query failed"}` | `invalid input syntax for type integer: "stats"` |
| `GET /api/memory/recent` | **500** | `... "recent"` |
| `GET /api/memory/abc` | **500** | `... "abc"` |
| `GET /api/memory/abc/history` | **500** | `... "abc"` |
| `GET /api/memory/999999` | 404 `Memory not found` | — |
| `GET /api/memory/1` | 200 | — |

Reproduced on every call, not intermittently.

## Why

`GET /:id` is registered after every literal path in `src/routes/memory.js`, so a request
that matched none of them arrives there with the unmatched word as `req.params.id`. That
value went into the query verbatim, Postgres refused it, and the catch reported the refusal
as a 500 `Query failed`.

A 500 is a statement that the server failed. The server did not fail — the path does not
exist, which is a 404. The difference is not cosmetic: 500s are what an operator watches to
decide whether something is broken, and these were produced by nothing worse than a typo or
a client still calling a route that has been renamed.

**Nothing shipped was calling these paths.** `memory/stats` and `memory/recent` appear
nowhere in `mcp/`, `client/src`, `hooks/`, `shared/` or `scripts/`; they were reached by the
sweep tool itself. So no feature was down. What was real is the shape: any typo, any client
left on a renamed route, and any future literal path shadowed by `/:id` produces a 500 that
says the server broke.

Five more routes take the same parameter and had the same behaviour: `PUT /:id`,
`PUT /:id/disable`, `PUT /:id/enable`, `PUT /:id/revert`, `GET /:id/history`.

## What changes

- `parseMemoryId()` accepts only a bare run of digits, at least 1, no greater than the
  `INT` ceiling of the column it is compared against. Anything else is not an id.
- The check is wired once, at `router.param('id', ...)`, rather than at each of the six
  handlers — a `:id` route added later cannot forget it.
- A rejected id answers 404 `Memory not found`, the same answer a well-formed id for a
  row that does not exist already gets. It does not distinguish "no such row" from
  "not an id", which is also the right amount to tell a caller.

Deliberately stricter than `parseInt`: `parseInt('12abc')` is `12`, so a fat-fingered path
would quietly return row 12 — a real row, belonging to someone, with no error anywhere.

## Why 404 rather than 400

400 has a case: `/api/memory/12abc` is a malformed request, and answering 404 tells a buggy
client "that row is not there", which sends them looking in the database instead of at their
string interpolation.

404 wins anyway. The `:id` segment is *path*, not a field — `/api/memory/stats` is a path
that genuinely does not exist, and the router cannot tell "you meant an id and fumbled it"
apart from "you meant a route that was never there". Answering 400 to `/api/memory/stats`
would be the more confusing of the two lies. The route already collapses "no such row" and
"not your row" into one 404, so collapsing "not an id" into it matches what it already
discloses.

## What this does not change

No other router has a literal path shadowed by `/:id`, so nowhere else was a real endpoint
answering 500. The underlying shape did exist one route over in `handoff.js` and inside
`/:id/revert`, and both are fixed here. Every existing behaviour for well-formed ids is
untouched.

The routers that parse ids with `parseInt` (`admin.js`, `broadcast.js`, `bug-reports.js`)
are a milder version of the same question — `parseInt('abc')` is `NaN`, which Postgres also
rejects, but they would read row 12 for `12abc`. Left as follow-up, deliberately.
