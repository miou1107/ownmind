# A vocabulary nobody checked against

## Why

`TRIGGER_TAG_ALIASES` decides which `trigger:` tags a hook will honour. Until now it had
exactly one reader — `ruleMatchesTrigger`, at the moment a hook decides what to show.

**Nothing consulted it when a memory was written.** A tag naming a word no trigger asks for
was accepted, reported as saved, and then never asked for again.

Measured 2026-08-12 on the live account: **nine memories** carried tags matching no operation
at all. One was a team standard requiring an independent review before anything leaves. It had
never fired in the two weeks it had existed — and an issue was filed that afternoon without it
appearing.

The reason it lasted is that **neither end of the system could see it**:

- the author sees the tag they wrote, still sitting there
- the reader sees a category count that is merely lower than it should be

Both views are consistent with everything working. The same shape as the other faults found
that day: a leaked temp directory, a standard that never fired, a search returning zero. None
of them raised anything. This one is the first fix aimed at the *mechanism* rather than at an
instance of it.

## What changes

`unknownTriggerTags(tags)` returns the `trigger:`-prefixed tags whose word is not in the
vocabulary, and both write paths attach a warning:

```
這些標籤系統不認得：trigger:收工。貼了也不會讓這條記憶在做事的時候自動跳出來。
認得的時機是：edit / commit / deploy / send / delete / install（或 command＝每次都跳）。
如果本來就打算靠名字被找到，可以不加時機標籤。
```

**Both paths, not just create.** On update, `tags` REPLACES rather than merges — so an update
is exactly where a working tag gets dropped or a dead one introduced, and it is the path the
tagging work of that afternoon went through.

## Decisions

**A warning, not a refusal.** Seven of the nine memories found are deliberately untagged:
they name a kind of work — wrapping up, debugging, onboarding — rather than an operation, and
they are reached through the session-start channel that loads every standard's title instead.
Rejecting the tag would make those rows uneditable for any unrelated reason, which is a worse
failure than the one being fixed.

**The message says what will happen, not that something is wrong.** Usually nothing is. A
memory found by name needs no trigger tag at all. What the author cannot otherwise discover is
that the tag they wrote buys them nothing — so the sentence ends by saying that no tag is a
legitimate answer.

**The offending tags are echoed verbatim.** Normalising them would send the author looking for
a string they never typed.

**The vocabulary is derived from the alias table, never restated.** A second hand-written list
is this same defect one level up: it would drift, and start warning about tags that work. A
test walks every word in the table and asserts that this check accepts it *and* that
`ruleMatchesTrigger` still honours it.

## What this does not do

It does not find the memories that already carry a dead tag — it only stops new ones being
created silently. Nothing scans the existing set and reports "this memory can never fire",
which is how all nine were found: by hand, on request. That detector is the next thing worth
building, and it is not this change.

## Impact

- `shared/helpers.js` — `KNOWN_TRIGGER_WORDS`, `unknownTriggerTags`,
  `unknownTriggerTagWarning`.
- `src/routes/memory.js` — a `warning` field on the create and update responses. Additive; no
  status code changes, no shape changes to anything a caller already reads.
- `tests/unknown-trigger-tags.test.js` — new.
