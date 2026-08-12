# v1.26.146 — Proposal: a standard that reads as one line

Issue #89. Seven team standards on the production account answer the documented read with a
single sentence of boilerplate. The text is stored, in child fragments, and nothing in the
answer says so.

```
ownmind_get({ id: 152 })
→ title:   git-push
  content: 由 ownmind-upload 自動建立的規範摘要: git-push
```

What is actually stored under that row, measured 2026-08-12 against production:

| fragment | subject |
|---|---|
| 1 | front-matter: AI Git 版控工作流 |
| 2 | Git Push 與版控工作流 — when the user says 「幫我 push」 |
| 3 | 1. 智慧安全掃描與暫存 — scan for `.env`, keys, `node_modules` and block |
| 4 | 2. 自動文件更新 — update README / CHANGELOG and re-stage them |
| 5 | 3. 自動撰寫 Commit 與 Push |
| 6 | 4. 發布與版本標籤 — ask testing vs production, then `name-rcX.X.X` / `name-vX.X.X` |

So a colleague saying 「幫我 push 一下」 gets an assistant that recognised the standard, went
and read it exactly as instructed, received one sentence, and pushed the way it always would.
None of those six steps was applied and nothing indicated any were missing.

**A short standard and a standard read short are indistinguishable.** That is the defect. It
is not that the lookup errors — an error would have been caught long ago.

## Why the documented read cannot see it

There are two shapes of team standard and one documented way to read them.

| shape | where the text lives | count on this account |
|---|---|---|
| self-contained | on the `team_standard` row's own `content` | 25 |
| fragment-shaped | in `standard_detail` rows keyed by `metadata.parent_id` | 7 |

v1.26.141 changed the documented read from `ownmind_get("standard_detail")` to
`ownmind_search` + `ownmind_get({ id })`, because the former returns `{"data": []}` for a
self-contained standard — which is every standard written recently. That was correct and it
was half the problem: the new instruction reaches self-contained standards and returns
boilerplate for fragment-shaped ones. One instruction, two shapes, and the session context
has room for one instruction.

`mcp/index.js:442` documents the gap in one direction only — "`standard_detail` … is empty for
a standard whose text is on its own record". The reverse case, the one in this issue, is
written down nowhere and has no signal a reader could detect.

## What changes

**`GET /api/memory/:id` returns a standard's fragments alongside it.** When the row is a
`team_standard` and fragments exist under it, the response carries them in a new `fragments`
array. The reader does not have to know which shape it asked for, because the answer is
complete either way.

The field is `fragments`, not `details`: `details` is already a key on a session-log row in the
same tool's output (`mcp/index.js:983`), holding a different type. Two meanings for one key in
one response shape costs nothing to avoid now and something to unpick later.

This is deliberately not a better instruction. The bug under discussion was produced by an
instruction that was accurate when written; v1.26.141 replaced it with another instruction and
created this one. A third sentence would be the same bet a third time. Returning the content
removes the need for anyone to know.

### Four decisions inside that

**1. `content` is left alone; the fragments go in a sibling field.**

Merging the text into `content` would make the parent row read correctly and edit
catastrophically. **The first draft of this proposal named the wrong culprit** — it said the
admin console loads `content` into an editor and writes it back. Checked: the console has no
memory editor at all. `client/src` calls exactly two memory endpoints, `/api/memory/search`
(`MemorySearchModal.jsx:34`) and `/api/memory/type/project` (`ProjectHistoryPage.jsx:22`), and
never `PUT`s a memory.

The real flatten vector is `ownmind_update`, and it is worse than the imagined one, because
the instruction that drives it already exists and is correct today:

> "Call ownmind_get with that row's id to read one in full — and always do that before
> `ownmind_update`, or you will overwrite the rest of it." (`mcp/index.js:460`)

Under a merged-`content` design, that sentence becomes an instruction to flatten: read the
merged blob, edit one line of it, write the whole blob back to the parent, and every fragment
is now duplicated inside the parent and orphaned outside it. `PUT /:id` writes what it is given
(`memory.js:1294` destructures `content` and `memory.js` sets `content = COALESCE($2, content)`).

`fragments` is safe from the default round-trip for a checkable reason rather than a hopeful
one: `PUT /:id` destructures a fixed set of keys and `fragments` is not among them, and the MCP
update handler builds its body from an explicit whitelist (`mcp/index.js:1083-1089`). A caller
that deliberately concatenates the fragments into `content` can still do so; no response shape
prevents that, and the spec claims only what it can enforce — that a no-op save changes
nothing.

**2. Only the read-one path merges. The list-all path does not.**

| path | today | after |
|---|---|---|
| `ownmind_get({ id })` on one standard | 1 row | 1 row + its fragments |
| `ownmind_get({ type: 'team_standard' })` | 32 rows, 38,108 chars | unchanged |
| `ownmind_search` | 400-char previews | unchanged |
| session-start context | titles only | unchanged |

Merging into the listing would take it from 38,108 to roughly 74,000 characters for a caller
who asked for an index. The growth in this change happens only where a caller asked for one
specific standard.

**3. Sync writes the document position; reading orders by it.**

The first draft ordered by row id and argued the breadcrumb titles made that good enough. Both
reviews rejected it, and tracing `POST /batch-sync-standard` shows why. It diffs existing
fragments **by title** (`memory.js:1933`). So a heading rename is not an update — the old row
is disabled and a new one is inserted at the end of the id sequence (`memory.js:1944-1957`,
`1972-1981`). Rename a *top-level* heading and every descendant's breadcrumb changes with it,
so the whole subtree is disabled and re-inserted, and its id order is now the rename date
rather than the document.

Breadcrumb plus `level` recovers the *tree*. It does not recover the order of siblings under
the same parent, and a numbered procedure only survives because its headings happen to start
with digits — luck, not design. A checklist reassembled in the wrong order reads as complete
and correct while being neither, which is a milder form of the exact defect this change exists
to remove.

So `batch-sync-standard` now writes the chunk's position in the incoming array into
`metadata.ord`, on insert and on update, and the read orders by `COALESCE(metadata->>'ord', id)`.
Chunks arrive in document order, so this is information the sync already has and was throwing
away. No backfill: every existing standard gains its ordinals the next time it is synced, and
falls back to id until then.

**4. The cap is declared, and it names the way out.**

Fragments are accumulated until a character budget is reached; the response then states
`fragments_total`, `fragments_returned` and `fragments_truncated`. Same shape as the search
response's `memory_total` / `memory_returned`, for the same reason: a caller that received a
partial answer must be able to tell.

**Budget: 20,000 characters, counted over each fragment's title plus content.** The first draft
said 50,000, and review killed it on the change's own terms. The cap exists to stay under the
caller's output ceiling — the failure mode of bug #11, where an uncapped search answered with
about a quarter of a million characters and the caller received nothing usable. That ceiling is
counted in tokens, and this corpus is Chinese, where a character costs roughly a token. A
50,000-character budget therefore *passes* while producing a response the caller cannot
receive: the guard would have permitted the thing it was built to prevent. 20,000 leaves 40%
headroom over today's largest standard (14,091) and stays well under the ceiling. The constant
is exported so a test can pin the production number rather than an injected one — the same
treatment `SEARCH_ROW_LIMIT` gets in `shared/memory-search-result.js`.

**A truncated response names its own follow-up.** `ownmind_get({ type: 'standard_detail',
parent_id })` already returns every fragment of one standard and is not capped, so the recovery
path exists; nothing in the response said so, which made the declaration a tombstone rather
than a map. The truncation notice now carries that call.

**5. A fragment read by id says which standard it belongs to.**

Review raised a residual path to the same defect: search can hand back a fragment rather than
the parent, and a fragment read by id shows one section with no indication that it is one of
seventeen. Measured against production — searching each of the three fragment-shaped standards
by its exact title returns the parent `team_standard` as row 1 every time, with fragments at
rows 3 and 4 — so the documented flow does not hit this. It is reachable by searching keywords
instead of a title, which assistants do. A `standard_detail` read by id therefore carries its
`parent_id` and the number of siblings, so a reader that lands on a section can climb to the
standard. One field, and it closes the hole rather than documenting it.

## Keeping a local copy: measured, and deferred

`ownmind_get({ id })` falls back to the local cache when a call fails
(`mcp/index.js:904-914`), and that cache holds seven memory types
(`shared/init-cache.js:78-86`) — `standard_detail` is not one of them. So on that path a
fragment-shaped standard would read as one line again.

**This is not an offline story.** Vin's correction: an assistant with no network cannot run at
all, so "works on a plane" is not a benefit anyone collects. The cache path is a degraded-call
fallback, not a mode people use. It gets one honest line — when a cached row is a
`team_standard`, say its text is held in fragments the cache does not carry — and no further
engineering.

The real question is the one Vin actually asked: keep the standards on the machine, and read
them locally to save round trips. Measured against production, 2026-08-12, from this laptop:

| call | total | bytes |
|---|---|---|
| read one standard by id | 0.25–0.33 s | 443 |
| all 27 fragments of the largest standard | 0.34–0.39 s | 35,357 |
| ask the server whether anything changed | 0.27–0.32 s | 29 |

**Asking whether anything changed costs the same as reading the thing.** Of the ~0.3 s, about
0.25 s is connection setup (TCP ~0.08 s, TLS ~0.17 s); the payload is rounding error at both 443
bytes and 35 KB. So the loop as described — ask first, then read locally — saves bandwidth
nobody is short of and no measurable time.

A local copy only pays if it removes the round trip entirely, which means not asking: the
session already holds a sync token from session start, and every response carries a fresh one
(`currentSyncToken`, `mcp/index.js`), so a client can serve locally on the token it already has
and correct itself on the next call it makes for any other reason.

That version is worth building when standards are read often enough for 0.3 s to add up. Today
an assistant reads one or two per session. **Deferred, with the number recorded rather than
guessed.**

One thing must be fixed before local-first is ever switched on, and it is cheap to note now:
the freshness signal is `generateSyncToken` (`src/utils/syncToken.js:15-29`), whose team-wide
half is `MAX(updated_at)` over **`team_standard` rows only**. Re-syncing a standard's text
updates its `standard_detail` rows and never touches the parent (`batch-sync-standard` inserts
the parent once and leaves it alone). Content changes, token does not, every machine concludes
it is current and keeps serving the old copy. Harmless while nobody reads locally; a silent
stale-rules bug the day someone does. `standard_detail` belongs in that token.

## What is measured

All figures 2026-08-12, against production, through the API.

| parent | title | fragments | chars |
|---|---|---|---|
| 135 | config-placement-rule | 7 | 1,795 |
| 143 | gitlab-migration-checklist | 36 | 8,469 |
| 152 | git-push | 6 | 1,262 |
| 161 | optimize-existing-project | 11 | 2,519 |
| 183 | vibe-coding-new-project | 15 | 3,550 |
| 210 | vibe-coding-standard | 27 | 14,091 |
| 345 | code-review-tooling-issue-report | 17 | 4,274 |

All seven have fragments. The issue confirmed two of them and inferred the rest from a shared
creation path; that inference is now checked rather than assumed.

Whole-corpus figures: 119 active fragments totalling 35,962 characters, under 32
`team_standard` rows of which 7 are placeholder-shaped.

## What this does not do

**The seven placeholder rows are not rewritten and no data is backfilled.** Their `content`
still reads 「由 ownmind-upload 自動建立的規範摘要: …」, which is what the admin console and a
search preview show. Under this change that line is no longer the whole answer to a read, so
it costs nothing to leave; rewriting it would be a one-off write across production rows to
fix something the read path already handles (IR-146).

**`POST /batch-sync-standard` keeps producing the same parent row.** New uploads still create
the boilerplate parent, and they are readable by construction once the read path merges, so the
acceptance criterion is met without changing what the write path creates. It does gain one
thing — the ordinal in decision 3 — and its response gains `stats.reordered`, which the only
consumer passes through untouched (`mcp/index.js:1380`). On the first sync after this ships,
a legacy standard reports every one of its rows as reordered: that is the backfill happening,
not an anomaly.

**Nothing changes for a self-contained standard.** It has no fragments, the lookup finds none,
and the response is byte-identical to today's. That is the second acceptance criterion, and it
falls out of the design rather than needing a branch.

**This reaches nobody until the server is deployed.** The fix is server-side, so it does not
ride the client upgrade path; kkvin.com needs a rebuild. Deployment is Vin's call (IR-136).
