# v1.26.39 — Admin dashboard memory-count card always showed 0

## One-Line Summary

`loadStats()` counted top-level arrays in the `/export` payload, but that
endpoint groups memories under a `memories` object, so nothing was ever counted
and the card rendered `0` for every account. It now reads the authoritative
`total_count`, and the card is relabelled to say whose count it is.

## Why

Found during the post-deploy browser check for v1.26.38 on
`https://kkvin.com/ownmind/admin/` (2026-07-29): the card read `0` while the
signed-in account held 387 memories.

`src/routes/export.js:32-37` responds with:

```json
{ "exported_at": "...", "user_id": 1, "total_count": 387,
  "memories": { "iron_rule": [...], "project": [...] } }
```

`src/public/index.html:1296-1305` counted with:

```js
Object.values(data).forEach(arr => { if (Array.isArray(arr)) count += arr.length; });
```

The top-level values are a string, two numbers, and an object. None is an
array, so `count` stayed `0`. The `catch` never fired either, because the
request succeeds — hence a confident, wrong `0` rather than the `-` that
signals failure.

Pre-existing and unrelated to v1.26.38: neither `src/public/index.html` nor
`src/routes/export.js` was touched by that release.

### The second occurrence is fine

`src/public/index.html:2796` renders `d.memory.total` from
`/api/activity/stats?user_id=…`, a different endpoint. Verified live: it
returns `{ total: 418, active: 387, disabled: 31, … }`, so that card is
correct and is left alone.

## Fix

- Extract `countExportedMemories(data)` in the admin inline script:
  1. `total_count` when it is finite (the authoritative value)
  2. otherwise `memories.length` when it is an array
  3. otherwise sum the arrays under `memories`
  4. otherwise sum top-level arrays
  5. `0` for empty, null, or non-object input
- `loadStats()` calls it, and now throws on a non-OK response before parsing.
  Without that, a 401 or 500 body parses cleanly and counts as `0`, which is
  precisely the symptom being removed. The rest of this page already guards
  with `if (!res.ok)` in 28 places; this one had simply been missed.
- The `catch` that renders `-` is unchanged, keeping "request failed" visually
  distinct from "genuinely zero".

Branches 2-4 are **defence, not compatibility**. `total_count` has been in the
response since the first commit (`79cab15`), and this page is served by
`express.static` from the same process it calls, so client and server can never
be different versions. They exist so that a future payload change degrades into
a visibly odd number instead of silently regressing into this exact bug.

## Relabel: 記憶總數 → 我的記憶（啟用中）

`/export` is scoped to the caller (`WHERE user_id = $1`), so the number is the
signed-in admin's own count. The card sits beside 使用者總數, which counts every
user, so an unqualified 記憶總數 reads as system-wide. Live figures make the gap
concrete: the signed-in account has 387, the whole instance has 573 across nine
accounts.

The scope word matters too. `/export` filters `status = 'active'`
(`src/routes/export.js:15-19`), so 387 is the active count, not a total. The
statistics tab meanwhile labels 記憶總數 a figure of 418 that includes the 31
disabled rows. Reusing 總數 here would have put two different definitions of
the same word in the same console.

Fixing only the number would have replaced a visible bug with a quieter one, so
the label now states both whose rows are counted and which ones.

A genuine system-wide card is possible — `/api/activity/stats/all` already
returns a per-user `memory_count` that sums to 573 — but that endpoint also
computes compliance rates, tool and model breakdowns, and per-period activity
for every user. Paying for all of that to render one number belongs in its own
change, not here.

## Non-goals

- No change to `/export` or any other server route; this is a display defect.
- No new system-wide statistic and no new endpoint call.
- No change to the `/api/activity/stats` card at line 2796, which is correct.

## Guard against regression

New `tests/admin-stats-memory-count.test.js` lifts `countExportedMemories` out
of the HTML and executes it, so the tests check behaviour rather than source
text:

- current payload with `total_count` → that number
- `total_count` present alongside a grouped object → `total_count` wins (the
  exact regression: grouped lengths must not override it)
- grouped object without `total_count` → sum of its arrays
- legacy flat `type -> array` payload → sum
- empty, `null`, `undefined`, non-object, non-numeric `total_count` → no throw
- `total_count: 0` → `0`, treated as a real count rather than a missing value

Plus wiring checks: `loadStats` calls the helper, no longer contains the broken
loop, keeps the `-` fallback, and the card carries the qualified label.

## Backlog (raised in review, not fixed here)

`loadStats()` downloads every memory the account owns — 387 full records — to
read one integer. Pre-existing, but the code now visibly uses only
`total_count`, which makes the waste obvious. A dedicated count endpoint, or
reusing a figure the page already fetches, belongs in its own change.

## Release

Patch bump to `v1.26.39`. Deploy to kkvin.com, then confirm in the browser that
the card shows the real count.
