# v1.26.103 — Proposal: moving a file is not writing it

## Background

Reported as bug #10. `git mv`-ing 22 archived OpenSpec folders — a pure move, not one byte
of content edited — was blocked by the pre-commit secret scan, which named two files as
containing suspected credentials. Both were byte-identical to their committed versions; the
raw diff reports `R100` with the same blob SHA on each side. The same content had been
committed and re-committed for versions without ever being flagged. The only thing that
changed was the path.

## Root cause, which is not the one the report proposed

The report suggested comparing blob hashes and skipping the scan when they match. That
treats a symptom. The scan already gets the correct status: `git diff --cached --name-status`
returns `R100`, and `getStagedFiles()` correctly keeps the destination path.

The defect is one line further on. `getStagedAddedLines()` asks git for the diff of a
**single path**:

    git diff --cached -U0 -- <destination>

Scoped to one path, git has no deleted counterpart to pair the addition with, so rename
detection cannot run. It renders the file as brand new and every line comes back prefixed
`+`. The scanner is not mis-reading the content; it is being handed the whole file and
truthfully told it was just added.

Blob hashes would have hidden the 100%-identical case and left the more damaging one
untouched: **move a file and edit one line of it**, and the other 400 untouched lines are
still presented as newly written. A blob comparison cannot help there, because the blob
genuinely changed.

## What this changes

Give git both paths, so it can pair them again.

- `getRenameSources()` reads `git diff --cached --raw -M -z` once and maps each destination
  path back to its source, renames and copies only.
- `getStagedAddedLines(file, srcPath)` passes both paths when the file was renamed. A pure
  move then yields no added lines at all; a move-plus-edit yields exactly the edited lines.
- `-M` is passed explicitly on both calls. With `diff.renames=false` in a user's config git
  reports a move as an unrelated delete plus add, the source path is lost, and the scan
  falls straight back into the bug. Whether someone's commit is blocked must not depend on
  their rename-detection preference.

## What this deliberately does not add

**No new exemption.** A blob-SHA skip was written first and then removed: with the pairing
in place no test could distinguish its presence from its absence, and in a blocking security
check an untested branch that skips scanning is an extra hole, not extra safety. This
component already carries three escape hatches accumulated from earlier false positives, and
adding a fourth was the outcome to avoid.

**Nothing done about the filename hit.** The report also noted `flush-compliance-spool.js`
being matched by the ≥20-character alphanumeric heuristic. With the pairing fixed that file
is no longer scanned during a move, so the reported symptom is gone; the heuristic itself is
a standing backlog item to reconsider as a strategy rather than to patch again.

## Why this matters beyond the one commit

The failure mode is a user being blocked over content that has been in the repository for
versions. The documented way out is a bypass, and a bypass switches off every other rule in
the same breath — so a false positive here converts directly into a window with no secret
scanning at all.
