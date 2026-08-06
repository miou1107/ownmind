# v1.26.76 — the heartbeat statement the database would not accept

## What happened

v1.26.75 went out to production at 03:16 on 2026-08-06. Eight seconds later:

```
[ERROR] heartbeat update failed {"error":"inconsistent types deduced for parameter $2"}
```

Every heartbeat. The write that tells the server a collector is alive could not even be
prepared, so no collector on any machine could report.

## Why

v1.26.73 changed this write from `INSERT ... VALUES` to `INSERT ... SELECT ... WHERE`, so
that the 20-machines-per-tool cap could be enforced in the same round trip instead of a
second query.

The two forms deduce parameter types differently:

- In `INSERT ... VALUES`, each parameter takes its type from the column it is written into.
- In `INSERT ... SELECT`, the SELECT is analysed as a query in its own right first. A bare
  `$2` in the select list is `unknown` and settles as `text`.

And `$2` is also used in `WHERE tool = $2`, where it is deduced as `character varying` from
the column. Two deductions for one parameter, and Postgres refuses the statement outright:

```
DETAIL: text versus character varying
```

## Why no test caught it

Every test in this suite hands the route a fake `query`. The statement is passed to a
function that pushes it onto an array; nothing that understands SQL ever reads it. A
hundred tests of that shape cannot distinguish a valid statement from an invalid one.

This is the same class of blind spot as the one v1.26.71 hit with `sqlite3 -readonly`: the
instrument could not see the failure it was supposed to detect.

## The fix

Cast every parameter in the select list. Verified three ways:

1. A test asserting the property, with a mutation check — removing one cast turns it red.
2. `PREPARE` of the uncast statement against the production database, reproducing the exact
   error message and its `text versus character varying` detail.
3. `PREPARE` of the cast statement against the same database: accepted.

## What else was checked

One other `INSERT ... SELECT` with parameters exists (`src/routes/broadcast.js:343`). Its
parameters each appear exactly once, so there is no second deduction to conflict with, and
it prepares cleanly against production. Left alone.
