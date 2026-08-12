# v1.26.147 — Tasks

## 1. Reproduce before fixing (IR-003)

- [x] Against production as super_admin: `GET /api/memory/108` → 200 (`team_standard`, owner
      user 4); `PUT /api/memory/108` with a valid sync token → **404 Memory not found**
- [x] Confirm the 404 comes from the opening lookup, not the admin gate: the gate returns 403
      and is written 30 lines below the `WHERE id = $1 AND user_id = $2` that fires first
- [x] Confirm the shape is every write path, not one handler — update, disable, enable,
      revert and history all matched on `user_id`
- [x] Count the cost: 32 standards, 2 owner accounts, 6 rows issue #85 wants flagged, 0
      accounts able to flag them all
- [x] Check the role table before writing the gate: 7 `user`, 2 `super_admin`, 0 `admin`

## 2. Tests first, watched failing

- [x] Whole file red before `src/utils/memory-write-access.js` existed
- [x] Owner may write to their own row of every type, and is matched across the string/number
      id gap
- [x] Admin may write to `team_standard` and `standard_detail` owned by someone else
- [x] Admin may not write to another account's `iron_rule`, and that refusal is byte-identical
      to the refusal for a missing row (otherwise the endpoint enumerates other accounts' ids)
- [x] `super_admin` outranks `admin`; a caller with no role at all is refused
- [x] A member may not write to a standard they can read
- [x] The lookup binds id alone and names no `user_id` — the whole point
- [x] Wiring: all five handlers resolve through the helper and none still opens with the
      owner-matched SELECT
- [x] The UPDATE binds the owner's id and not `req.user.id` (comments stripped before the
      assertion reads the call — one of them explains why `req.user.id` is absent, and an
      assertion that reads prose cannot tell an explanation from the code)
- [x] The previously unreachable admin gate is still present on update, and now on enable and
      revert
- [x] All four write verbs record `admin_write`
- [x] Mutation-tested (IR-134), both caught: deleting the admin branch of the helper → 3 red;
      rebinding `req.user.id` in the PUT → 1 red. Restored from file backups, not
      `git checkout` (IR-140)

## 3. Implementation

- [x] `src/utils/roles.js` — `ROLE_RANK` / `isAtLeast` extracted so an authorization decision
      can rank a role without importing the auth middleware and, through it, the DB pool.
      `adminAuth.js` imports and re-exports it, so there is still one definition (imported,
      not re-exported straight through: its own guards call it by name — IR-131)
- [x] `src/utils/memory-write-access.js` — `resolveWritableMemory`, injected query, no DB
      import of its own
- [x] `PUT /:id`, `/:id/disable`, `/:id/enable`, `/:id/revert`, `GET /:id/history` resolve
      through it
- [x] Every authorized UPDATE binds the resolved row's `user_id`
- [x] `admin_write` in history metadata on all four write verbs
- [x] Admin gate added to enable and revert; the one on update and disable left as written
- [x] `memory-visibility.js` header corrected — it stated that writes stay matched on the
      caller's own user_id, which this change makes false

## 4. Verify against something real

- [x] Live database (production, read-only and a rolled-back transaction):
      `SELECT * FROM memories WHERE id = 108` returns the row owned by user 4 — the new lookup
      finds another account's row; `UPDATE ... WHERE id = 108 AND user_id = 4` inside
      `BEGIN … ROLLBACK` matches 1 row — the owner-bound write reaches it; the old predicate
      `id = 108 AND user_id = 1` matches 0 rows — which is exactly why the write 404'd
- [x] Full suite: 4,666 tests, 0 fail
- [ ] After deploy: `PUT /api/memory/108` as super_admin returns 200, on a disposable field,
      and the history row carries `admin_write`

## 5. Both ends (IR-022)

- [x] Server: the five handlers above
- [x] MCP: `ownmind_update` needs no change — it posts to the same route and the client never
      decided this. Checked that no tool description claims a standard is editable only by its
      creator
- [x] Admin console: no memory editor exists (`client/src` calls `/api/memory/search` and
      `/api/memory/type/project` and never `PUT`s), so nothing on the front end to widen
- [x] Hooks: none of them write memories by id

## 6. Quality gates

- [x] `superpowers:verification-before-completion`
- [ ] `superpowers:requesting-code-review`
- [ ] `superpowers:receiving-code-review`

## 7. Release paperwork

- [x] `package.json` → 1.26.147
- [x] README (en / zh-TW / ja) — IR-032
- [x] FILELIST
- [x] CHANGELOG, referencing issue #85
- [ ] Do not tag, push or deploy without Vin (IR-136). Nothing reaches anyone until kkvin.com
      is rebuilt

## 8. Deliberately not done

- [x] Issue #85 itself: no `user_invocable` / `invocation_hint` fields, no tip change, no
      standard flagged. This change only removes the reason it could not start
- [x] No widening for private types, and no new route that could reach one
- [x] No backfill and no production row rewritten
- [x] Ownership is not transferable — an orphaned standard is now maintainable by an admin,
      but it still belongs to the account that made it. Moving ownership is a bigger question
      than this issue needs answering
