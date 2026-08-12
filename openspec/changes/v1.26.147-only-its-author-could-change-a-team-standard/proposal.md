# v1.26.147 — Proposal: only its author could change a team standard

Issue #85 asked for a session tip that names the standards a user can invoke, which needs a
flag on each standard saying "this one is worth naming". Marking the first of them failed:

```
ownmind_update({ id: 869, metadata: { user_invocable: true, ... } })
→ 404 Memory not found
```

Reproduced against production 2026-08-12, as a super_admin, on standard 108:

| call | result |
|---|---|
| `GET /api/memory/108` | 200 — `team_standard`, owner user 4 |
| `PUT /api/memory/108` | 404 Memory not found |

The row is readable by every member and writable by nobody but the account that uploaded it.

## Why the admin check never ran

Each write route opened with the same lookup:

```js
// src/routes/memory.js — PUT /:id, before this change
'SELECT * FROM memories WHERE id = $1 AND user_id = $2'   // $2 = req.user.id
→ no row → 404
```

Thirty lines later, and only for callers who got past it:

```js
if (isSharedMemoryType(oldMemory.type) && !isAtLeast(req.user.role, 'admin')) {
  return res.status(403).json({ error: 'Team standards and their details may only be edited by admins' });
}
```

That check reads as "admins manage team standards". It cannot do that: a non-owner is gone one
statement earlier. What it actually gates is a **non-admin editing their own** standard. The
capability it appears to describe has never existed.

Confirmed as the shape of every write path, not one handler: `PUT /:id`, `/:id/disable`,
`/:id/enable`, `/:id/revert` and `GET /:id/history` all matched on `user_id`. The only
statement that ever wrote a memory without an owner match is `batch-sync-standard`, writing
fragments under a parent it just created.

## What that costs today

Measured on the production account, 2026-08-12:

| | |
|---|---|
| team standards | 32, across 2 owner accounts |
| invocable ones issue #85 wants flagged | 6 — 2 owned by user 1, 3 by user 4, 1 excluded |
| accounts able to flag all six | 0 |

Two consequences beyond the blocked issue:

- **A standard outlives the account that made it as an unmaintainable row.** When its creator
  leaves, nobody can correct it, retire it, or restore it — `disable` is owner-matched too. It
  keeps being served to every member's assistant as company policy.
- **`enable` had no admin gate at all**, so where `disable` required admin, putting a retired
  standard back required only being its owner. A one-way door in the wrong direction.

## What changes

**An admin may write to a team standard whoever uploaded it.** One helper,
`src/utils/memory-write-access.js`, answers "may this caller write to this row" for every
write route:

| caller | shared type (`team_standard`, `standard_detail`) | every other type |
|---|---|---|
| the owner | yes (admin gate still applies) | yes |
| an admin / super_admin | **yes (new)** | no — 404 |
| any other member | no — 404 | no — 404 |

Deliberately narrow: it widens exactly the two types that are already readable by everyone.
An admin is not given a key to other people's iron rules, projects or env memories, and the
refusal for those is identical to the refusal for a row that does not exist, so the endpoint
cannot be used to enumerate other accounts' ids.

### Four decisions inside that

**1. The gate that was unreachable now runs, unchanged.** Being resolvable is not being
permitted: an owner who is not an admin still gets 403 on their own standard, which is what
that check was written for and the only thing it used to do.

**2. `enable` and `revert` get the same gate, which they never had.** `revert` rewrites
`content` from history — an edit under another name. `enable` reverses `disable`. Gating one
direction and not the other is not a security boundary, it is an inconvenience.

**3. The write stays scoped to one owner's row.** Authorization is decided once, in the
helper; the `UPDATE` then binds the row's own `user_id`, not the caller's. Rebinding the
caller's id there would re-impose the same 404 one statement later, except silently — it would
write nothing and return no row.

**4. An admin write says who made it.** History is the only place that can record that the row
changed by someone other than its owner, so update, disable, enable and revert write
`admin_write: { action, by_user_id, owner_user_id }` into `memory_history.metadata`. Nothing
is written on the ordinary owner path, so existing history entries keep their shape.

**`GET /:id/history` follows the same rule.** An admin who can revert a standard but cannot
see the versions to revert to has half a capability.

## What this does not do

**It does not implement issue #85.** This unblocks it. The tip still says what it said; the
`user_invocable` / `invocation_hint` fields do not exist yet, and no standard is flagged.

**It does not touch reads.** Who may read a memory is still `memory-visibility.js`, unchanged.
Being able to read a shared fragment still never implies being able to change it.

**It does not extend to private types.** An admin still cannot edit another account's iron
rules or project memories, and this change does not add a route that could.

**It does not backfill or rewrite anything.** No production row changes as a result of
deploying it.

**Roles as they stand:** the production instance has 7 `user` and 2 `super_admin` accounts and
no `admin` accounts, so today this widens what those two accounts can do. The gate is written
against `admin` because that is what every other shared-type check in this file uses, and
`super_admin` outranks it.

**This reaches nobody until the server is deployed.** Server-side change; kkvin.com needs a
rebuild. Deployment is Vin's call (IR-136).
