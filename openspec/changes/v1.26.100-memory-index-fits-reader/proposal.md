# v1.26.100 — the memory index is longer than the thing that reads it

## What is wrong

`hooks/lib/sync-memory-files.js` writes one index line per active memory into
`MEMORY.md`, with no upper bound. The reader on the other side has one.

Measured on a real install, 2026-08-08:

```
MEMORY.md                284 lines, 32708 characters (52222 bytes)
  ## Iron Rules          143 entries, ending at line 151
  ## Projects            130 entries
longest entry line       196 characters (305 bytes)
```

The line limit is exceeded. The per-entry character limit is not: "305" as first
recorded here was `awk length()` counting bytes, and the longest line is 196
characters. Corrected during review.

Here is what the reader said, from two separate warnings in the same session:

```
WARNING: MEMORY.md is 280 lines and 31.8KB. Only part of it was loaded.
         Keep index entries to one line under ~200 chars.

Error: this write left the memory index at MEMORY.md at 281 lines, over its
       200-line read limit. The write succeeded, but everything past the limit
       is silently dropped each time the index is loaded — entries at the end
       are already invisible to readers. Rewrite it to under 140 lines.
```

**What has not been reaching the session is projects, specifically.** Iron rules
are listed first and run out by line 151, so all 143 of them arrived inside the
200-line cut. Of 130 projects, 47 arrived and 83 did not. The generator does not
know it, the reader does not say it out loud at load time, and the file carries
no mark. It reads as a complete index and is not one.

## Why it grew past the limit without anyone noticing

The index lists every iron rule. The SessionStart hook **already injects the
full iron-rule set into the session directly** — 143 of them, with trigger
conditions, under `## Iron rules (strictly enforced)` — so those 143 index lines
buy nothing that is not already in context, while consuming the budget that
projects, which have no second channel, then run out of.

Nothing here is a bad decision made once. It is an index that grows with the
user's memory count and a reader whose budget does not.

## The allocation question this change does not settle

Sharing the budget by entry count means iron rules still take about half of it,
for listings that duplicate what the hook injects anyway. Concretely, on the
measured data: projects go from 47 visible to 63, and iron rules from 143 to 63.
Losing an iron-rule index line costs only the link to the local file — the rule
text reaches the session through the hook either way — so capping iron rules at
a small fixed share and giving the rest to projects is very likely better.

That is a change to the design rather than a fix to it, so it is left alone here
and flagged for a decision. What this change does settle is that the file fits,
and that whatever it omits, it says so.

## What changes

`MEMORY.md` gets a line budget it cannot exceed, and says out loud what did not
fit.

1. **A hard cap of 140 lines, enforced while building, not checked afterwards.**
   140 is the number the reader itself asks for.
2. **Entries are chosen most-recently-updated first**, per type, so what is
   visible for free is what is current.
3. **The budget is shared out by need.** A type that wants fewer lines than its
   even share releases the rest to the others, so a user with 300 projects and
   4 iron rules gets a useful index, and so does the opposite user.
4. **Every entry line is capped at 200 characters**, title truncated with `…`.
5. **What was left out is stated, per type**, with the count and where to find
   it. Full titles are already in the individual filenames on disk, so nothing
   needs a second copy:

   ```
   ## Projects
   - [Recent one](project_812_recent_one.md) — updated 2026-08-07
   …
   - 87 more not listed here (line budget): see the project_*.md files in this
     directory, or search with the `ownmind_search` MCP tool.
   ```

## What does not change

- Every memory still gets its own `<type>_<id>_<slug>.md` file. Nothing is
  deleted, and no memory becomes unreachable — only the index listing is capped.
- Tombstone deletion, backup-on-first-run, and fail-mode warnings are untouched.
- No new files are written. An overflow index file was considered and dropped:
  the per-memory filenames already carry the titles, so a second listing would
  be one more thing to keep in sync for no new information.

## Why by construction rather than by a lint

A check that runs afterwards reports a file that has already been written and
already been read short. The cap belongs in the builder, and the test asserts
the builder cannot emit an over-budget index for any input, including 5000
memories with 400-character titles.
