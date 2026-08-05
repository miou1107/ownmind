# v1.26.38 — Share team-standard details with every member (fix half-shared standards)

## One-Line Summary

`team_standard` summaries are deliberately global, but the `standard_detail`
rows that carry the actual rule text are still scoped to the uploader's
`user_id` on every read path. Team members therefore load a shelf of standard
titles whose contents nobody but the uploader can open. This change makes a
`standard_detail` row readable by any member whose parent `team_standard` is
active and not opted out.

## Why

`ownmind_upload_standard` splits a long team standard into two layers:

- a **summary** row of type `team_standard` (auto-created with the placeholder
  text `由 ownmind-upload 自動建立的規範摘要: <title>` when the parent does not
  exist yet — `src/routes/memory.js:1789-1795`)
- many **detail** rows of type `standard_detail`, tagged `rule_detail`, each
  carrying `metadata.parent_id` and inserted with `user_id = req.user.id`
  (`src/routes/memory.js:1825-1835`)

The summary layer is explicitly shared: the `/init` query drops the `user_id`
filter and comments "team_standard is shared across users"
(`src/routes/memory.js:418-424`). The detail layer never got the same
treatment. All four read paths still filter on the caller's own `user_id`:

| Path | Line | Filter |
|---|---|---|
| `/init` team standards | `src/routes/memory.js:424` | excludes `rule_detail` by design (lazy load) |
| `GET /type/:type` | `src/routes/memory.js:813` | `user_id = $2` for every type except `team_standard` |
| `GET /search` | `src/routes/memory.js:877` | `user_id = $1` |
| `GET /:id` | `src/routes/memory.js:897` | `user_id = $2` |

`INSTRUCTIONS_SOP` (`src/routes/memory.js:295`) tells the assistant to fetch
the fragment with `ownmind_get('standard_detail')` or `ownmind_search`, so the
product intent is unambiguous: details are meant to be reachable. They are not.

### Production evidence (queried 2026-07-29)

Seven active auto-created summaries are visible to everyone while their content
is reachable only by the uploader:

| Summary id | Title | Detail rows (total / active) |
|---|---|---|
| 135 | config-placement-rule | 7 / 7 |
| 143 | gitlab-migration-checklist | 45 / 36 |
| 152 | git-push | 12 / 6 |
| 161 | optimize-existing-project | 11 / 11 |
| 183 | vibe-coding-new-project | 15 / 15 |
| 210 | vibe-coding-standard | 31 / 27 |
| 345 | code-review-tooling-issue-report | 27 / 17 |

Across the whole database there are 127 active and 41 disabled
`standard_detail` rows, every one of them owned by a single uploader. The
sharing feature has never worked for anyone else since the first upload on
2026-04-07.

The content is real, not placeholder debris — for example id 135 holds a
five-layer config-placement model with 150-320 characters per layer, and id 152
holds a four-section git push workflow. Deleting the summaries (an earlier
proposal, made on the assumption that they were empty shells) would orphan 119
active fragments beyond recovery.

### Related defects found in the same read

1. `ownmind_get`'s MCP tool schema (`mcp/index.js:442`) omits `standard_detail`
   from its type enum, even though the server allows the type
   (`src/constants.js:17`) and `INSTRUCTIONS_SOP` instructs the assistant to
   call it. The documented retrieval route is not callable at all.
2. `TYPE_MAP.ownmind_get` (`mcp/index.js:181-187`) has no label for
   `standard_detail`, so its banner falls back to the generic `Memory loaded`
   (`resolveType`, `mcp/index.js:206-212`) and never names the type. Cosmetic,
   not a crash.
3. Disabling a summary leaves its details active and permanently unreachable.
   Summary 173 (`regression-test`, disabled) still has 8 active orphan
   fragments today.
4. `POST /api/memory` gates only `team_standard` behind the admin check
   (`src/routes/memory.js:1030`), and `PUT /:id` and the disable handler do the
   same. `standard_detail` is an allowed type (`src/constants.js:17`), so any
   authenticated user can mint one. That was inert while fragments were
   owner-only; widening reads turns it into cross-account content injection, so
   this change has to close it in the same pass.

## Fix

Introduce a single shared read-visibility rule and apply it to all three
non-init read paths.

New pure module `src/utils/memory-visibility.js`:

- `SHARED_MEMORY_TYPES = ['team_standard', 'standard_detail']`
- `isSharedMemoryType(type)`
- `buildReadableWhere({ alias, userParam })` returning the SQL fragment for
  "rows this caller may read":

```
  <alias>.user_id = $U
  OR <alias>.type = 'team_standard'
  OR ( <alias>.type = 'standard_detail'
       AND EXISTS ( active team_standard parent, matched on
                    parent.id::text = <alias>.metadata->>'parent_id',
                    with no team_standard_optout profile row for $U ) )
```

Parent matching compares `id::text` against the JSON string rather than casting
the JSON value to `int`, so a malformed `parent_id` yields no match instead of
a query-aborting cast error.

Call-site changes in `src/routes/memory.js`:

- `GET /type/:type` — treat `standard_detail` like `team_standard`: return the
  shared set rather than the caller's own rows. Parent must be active, so
  orphans under a disabled summary stop surfacing.
- `GET /search` — replace the bare `user_id = $1` with the readable predicate,
  keeping `status = 'active'` and the existing tokenized match untouched.
- `GET /:id` — same predicate, so a fragment found through search can be opened
  by id.

- `POST /`, `PUT /:id`, and the disable handler — swap the
  `type === 'team_standard'` admin gate for `isSharedMemoryType(type)`, so
  minting or editing a fragment needs admin just like its summary does.
  Legitimate fragments come only from `batch-sync-standard`, which carries its
  own admin gate, so no existing flow breaks.
- `GET /type/:type` also accepts an optional `?parent_id=` so a caller can pull
  one standard's fragments instead of the whole corpus. Omitting it keeps the
  full result rather than silently truncating.

Client-side (IR-022 requires both ends):

- add `standard_detail` to the `ownmind_get` enum in `mcp/index.js:442`
- add an optional `parent_id` argument that threads through to the query string
- add a `standard_detail` label to `TYPE_MAP.ownmind_get`

## Non-goals

- **No write-path change.** `PUT /:id` and `disable` stay owner-scoped; a
  member must not be able to edit or retire another member's fragments. A
  regression test pins this.
- **No change to `ownmind_save`'s enum.** Fragments are created only through
  `ownmind_upload_standard`; letting `save` mint a loose `standard_detail`
  would produce parentless rows.
- **`/init` still excludes `rule_detail`.** Lazy loading is the whole point of
  the two-layer design; pulling every fragment into each session would undo it.
- **No data migration and no deletion.** The 7 summaries and their 119 active
  fragments stay exactly as they are; they simply become readable. Orphans
  under disabled summaries (id 173) are hidden by the parent-active condition
  rather than removed.
- **No fix for the placeholder summary text.** Auto-created summaries keep
  reading `由 ownmind-upload 自動建立的規範摘要: <title>`. Improving that copy
  is a separate follow-up.

## Guard against regression

New `tests/memory-visibility.test.js` (written before the implementation, per
IR-003):

- own rows readable regardless of type
- `team_standard` readable across users
- `standard_detail` readable across users when the parent is an active
  `team_standard`
- `standard_detail` NOT readable when the parent is disabled (orphan case)
- `standard_detail` NOT readable when the caller has opted out of the parent
- an unrelated private type stays owner-only
- malformed `metadata.parent_id` produces no match and no cast error
- the emitted SQL parameterizes the user id rather than inlining it

Plus a route-level guard asserting `PUT /:id` and the disable handler still
carry `user_id = ` in their WHERE clauses.

## Known limitations (accepted, not fixed here)

1. **Opt-out is asymmetric.** The predicate short-circuits on
   `type = 'team_standard'`, so an opted-out member still sees the summary
   through `/type/team_standard` and `/search` while its fragments are
   correctly hidden. `/init` already hides the summary, so the two disagree.
   Left alone deliberately: changing summary visibility is a behaviour decision
   beyond this fix, and the path is unreachable today (see 2).
2. **Nothing writes an opt-out row.** A repo-wide grep finds only two readers
   of the `team_standard_optout` tag (`src/routes/memory.js:431` and the new
   module) and no writer anywhere in server, client, or MCP. The opt-out branch
   is therefore dead code until a surface for it exists, which is why it had to
   be verified with synthetic rows rather than production data.
3. **Opt-out key comparison diverges from `/init`.** This module compares
   `metadata->>'team_standard_id'` as text; `/init:431` casts it `::int`. A
   value like `'0135'` would opt out in one path and not the other. Harmless
   while no writer exists; worth unifying when one is built.
4. **Parent lookup cannot use the primary-key index.** `parent.id::text = ...`
   forces a cast, so Postgres hashes the small active-`team_standard` set and
   semi-joins. At roughly 4k rows the cost is dominated by the pre-existing
   ILIKE scans in `/search`, so no index is added now. Past ~100k rows, a
   composite `(type, status)` index is the useful addition — a functional index
   on `metadata->>'parent_id'` would not help, since the scan is on the parent
   side.

## Release

Patch bump to `v1.26.38` (IR-076: no minor/major without asking). Version must
stay in sync across `package.json`, the server version constant, and the git
tag (IR-031). Deploy to kkvin.com, then verify from a non-uploader account that
a fragment is now readable.
