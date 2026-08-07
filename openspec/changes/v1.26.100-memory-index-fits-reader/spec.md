# Spec — bounded memory index

Module: `hooks/lib/sync-memory-files.js`

## Exported constants

| Name | Value | Meaning |
| --- | --- | --- |
| `MEMORY_INDEX_MAX_LINES` | 140 | Hard ceiling on the total line count of `MEMORY.md`. Taken from the reader's own remediation text ("Rewrite it to under 140 lines"). |
| `MEMORY_INDEX_MAX_ENTRY_CHARS` | 200 | Hard ceiling on any single entry line. Taken from the reader's own warning ("Keep index entries to one line under ~200 chars"). |

Both are exported so the test asserts against the same number the builder uses,
rather than a second copy that can drift.

## Behaviour

### Requirement: the index never exceeds the reader's budget

The builder allocates the budget before emitting, and emits only what fits.

#### Scenario: far more memories than the budget allows
- **GIVEN** 5000 active memories spread across `iron_rule`, `project`, `feedback`
- **WHEN** `buildMemoryIndex` runs
- **THEN** the result has at most `MEMORY_INDEX_MAX_LINES` lines
- **AND** every line has at most `MEMORY_INDEX_MAX_ENTRY_CHARS` characters

#### Scenario: a single pathological title
- **GIVEN** a memory whose title is 400 characters
- **WHEN** the index is built
- **THEN** that entry's line is at most `MEMORY_INDEX_MAX_ENTRY_CHARS` characters
- **AND** the line ends with `…` before the closing link, so the truncation is visible
- **AND** the link target is still the correct, untruncated filename

#### Scenario: the budget is not exceeded by the omission notes themselves
- **GIVEN** all three types overflow
- **WHEN** the index is built
- **THEN** the total line count including all three omission notes is at most
  `MEMORY_INDEX_MAX_LINES`

### Requirement: what was omitted is stated, never silently dropped

#### Scenario: a type has more entries than its share
- **GIVEN** 130 `project` memories and a share that fits 40
- **WHEN** the index is built
- **THEN** the `## Projects` section lists 40 entries
- **AND** it ends with a line stating `90 more not listed here`
- **AND** that line names both the `project_*.md` files and the `ownmind_search`
  MCP tool as the way to reach them

#### Scenario: nothing overflows
- **GIVEN** 3 memories in total
- **WHEN** the index is built
- **THEN** no omission note appears anywhere in the output

### Requirement: what is shown is what is current

#### Scenario: entries arrive in arbitrary order
- **GIVEN** 100 `project` memories whose `updated_at` values are shuffled
- **WHEN** the index is built with a share that fits 40
- **THEN** the 40 listed are the 40 with the most recent `updated_at`
- **AND** they appear in descending `updated_at` order

Ordering is done by the builder. It does not rely on the server's `ORDER BY`,
because a caller that reorders would silently change which memories are visible.

### Requirement: the budget is shared out by need, not split evenly

#### Scenario: one type is small and another is large
- **GIVEN** 4 `iron_rule`, 300 `project`, 0 `feedback`
- **WHEN** the index is built
- **THEN** all 4 iron rules are listed
- **AND** the projects section uses the lines the other two types did not need
- **AND** the total is still at most `MEMORY_INDEX_MAX_LINES`

#### Scenario: an absent type consumes no budget
- **GIVEN** no `feedback` memories
- **WHEN** the index is built
- **THEN** no `## Feedback` heading is emitted
- **AND** no lines are reserved for it

### Requirement: existing index behaviour is unchanged

#### Scenario: small index, same output as before
- **GIVEN** one memory of each type
- **WHEN** the index is built
- **THEN** the auto-synced marker, the `# Memory Index` title, the do-not-edit
  note, and the per-type headings appear exactly as they did before this change
- **AND** each entry line keeps the `- [title](filename) — updated YYYY-MM-DD` shape

#### Scenario: sync failure
- **GIVEN** `syncFailed` is true
- **WHEN** the index is built
- **THEN** the failure marker is present, as before
- **AND** the line budget still holds

### Requirement: truncation produces valid text

#### Scenario: a title made of astral characters
- **GIVEN** a title of emoji, and filenames whose length walks the budget through both
  odd and even offsets
- **WHEN** the entry line is truncated
- **THEN** no line contains a lone surrogate

`String.prototype.slice` counts UTF-16 code units, so cutting at an odd offset splits a
surrogate pair and leaves half a character. Measured before the fix: 12 of 24 filename
lengths produced one. The cut walks whole code points instead.

## The size axis, and why there is no byte cap

The reader's warning cited two numbers, "280 lines and 31.8KB", and only ever stated a
remediation in lines. Measured against the file it was complaining about:

| | measured |
| --- | --- |
| lines | 284 |
| characters | 32708 (31.9K) |
| bytes | 52222 (51.0KB) |

The reader's "31.8KB" is its character count, not its byte count. So the axis it measures is
characters, and `MEMORY_INDEX_MAX_LINES × MEMORY_INDEX_MAX_ENTRY_CHARS` = 28000 characters
already bounds it below the size that triggered the warning. The worst case this builder can
actually emit measures 26114 characters (64.7 KB of UTF-8, which is not the axis in
question). No byte cap is added, because no byte limit has been observed and inventing a
threshold would be guessing at one.

## Non-goals

- No overflow index files. Per-memory filenames already carry slugified titles,
  so `ls` over the directory is the complete listing.
- No change to which memory types sync (`iron_rule`, `project`, `feedback`).
- No change to the reader. The 140-line budget is the reader's stated limit;
  this change makes the generator respect it.
