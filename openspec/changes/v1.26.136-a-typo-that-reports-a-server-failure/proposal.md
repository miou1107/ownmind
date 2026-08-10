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

## What this does not change

Other routers were checked in the same sweep and do not have this shape. Nothing else in
the memory router changes; every existing behaviour for well-formed ids is untouched.
