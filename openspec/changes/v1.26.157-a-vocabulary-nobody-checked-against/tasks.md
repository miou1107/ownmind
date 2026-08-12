# Tasks

## 1. Establish that nothing checks

- [x] Grep every reader of `TRIGGER_TAG_ALIASES`: one, inside `ruleMatchesTrigger`
- [x] Grep the create and update routes for any tag validation: none
- [x] Grep for any detector of unreachable memories: none

Three greps, and the answer to all three was nothing. That is the whole finding.

## 2. The check

- [x] `KNOWN_TRIGGER_WORDS`, derived from the alias table rather than restated
- [x] `unknownTriggerTags(tags)` — only `trigger:`-prefixed tags judged, case-insensitive,
      offending tags returned verbatim
- [x] `unknownTriggerTagWarning(offending)` — says what will happen, lists the real triggers,
      and says that no tag at all is a legitimate answer

## 3. Both write paths

- [x] Create attaches `response.warning`
- [x] Update attaches it too — `tags` REPLACES there, so it is where a working tag is dropped
      or a dead one introduced
- [x] Neither refuses the write

## 4. Tests

- [x] The eleven tags actually found on the account are all flagged
- [x] Every word in the alias table is accepted **and** still honoured by `ruleMatchesTrigger`
      — the two must agree by construction, or the warning fires on tags that work
- [x] Canonical names, `command`, and mixed case are accepted
- [x] Ordinary labels are untouched
- [x] `undefined` / `null` / bare string / array of junk do not throw
- [x] The warning names the tags, says what happens, lists the triggers, and offers "no tag"
- [x] Both routes carry the call, and neither turns it into a 4xx
- [x] `KNOWN_TRIGGER_WORDS` equals what the alias table derives — a hand-written second list
      would be this same defect one level up

## 5. Release

- [x] CHANGELOG / FILELIST / three READMEs / package.json
- [x] Full suite
- [x] Commit, push, tag `v1.26.157`

## Deliberately not done

**Scanning the existing memories for dead tags.** This change stops new ones being created
silently; it does not find the ones already there. All nine were found by hand, on request,
during a product check — which is exactly the problem. A detector that reports "this memory
can never fire" is the next thing worth building and is a separate change.

**Refusing the tag.** Seven of the nine are deliberately untagged: they name a kind of work
rather than an operation and are reached by name through the session-start channel. A refusal
would make them uneditable for any unrelated reason.
