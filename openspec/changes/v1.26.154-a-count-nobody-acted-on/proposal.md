# A count nobody acted on

## Why

v1.26.151 replaced `鐵律觸發（commit）` with per-category counts, and v1.26.152 made them
translatable. The counts answered "did OwnMind look". They did not get anything read.

Measured on this repo, one release later. The line in front of a commit said:

```
[OwnMind v1.26.153] Commit · Team standards 4, Iron rules 0, …
```

The AI that read it opened none of the four. One of them was **「Commit 前品管三步驟」**, whose
second step is to request a code review before committing. That step was skipped, and the
commit went out. The count was correct, prominent, and inert.

The user's own question, on reading the same line, was the other half of it: *"is that number
right? I assumed it listed everything I have."* `4` cannot distinguish "four apply" from "four
exist". Both problems are the same shape — a number with nothing to hold it against.

## What changes

**A denominator.** `Team standards 4/32`. The totals come off rows the query already returns,
so nothing extra is fetched.

**The names.** Every matching memory is named, not just the iron rules. A name is harder to
walk past than a number, and it is what the user needs in order to say "no, not that one".

**A window, so the names stay readable.** They go out once an hour, per session, per trigger.
Every operation in between gets the counts alone. This reuses the machinery the edit path has
had since v1.26.92 rather than adding a second one.

**The window key gains the trigger.** It had only the session. The memories that match a
commit are not the memories that match a deploy, so one shared window meant seeing the commit
list at 10:00 and being told — silently — that the deploy list at 10:20 had already been
shown. It had not.

**The wording says what actually happened.** `Memories found:`, not "loaded": the hook counts
and names, it does not put the contents into anyone's context. The user proposed "已載入",
was told what the line really does, and picked "已查到" — found.

## Decisions taken and why

**No cap on the list.** A real account matches around 38 iron rules on a commit, and a
`…and 28 more` is 28 memories nobody can act on. The window is what the length is traded
against; truncation would have been a second, quieter way to lose them.

**A category that matched nothing gets a count but no name row.** `Preferences 0/4` still
prints — that zero is the informative part, and it is the distinction issue #94 exists to
draw. A heading with nothing under it is not.

**The window is per session, not per machine.** The user asked for per-machine and changed
their mind on being shown the consequence: the listing exists to put names into *one* AI's
context, and a second conversation that never saw them would be told, in effect, that it had.

**Iron rules are named by the banner or by the list, never both.** Which one is printing is
known only at the call site, so `names` is passed in rather than decided in the renderer.

## Impact

- `shared/hook-context.js` — `tallyHookContext` returns `totals` and `names`;
  `renderHookContextLine` takes them and renders the sentence form.
- `shared/edit-reminder-state.js` — `windowKey(sessionId, trigger)`; read/write take a trigger.
  The module name is now narrower than its job and is left alone rather than renamed across
  four callers in a release that is already touching both hooks.
- `src/routes/memory.js` — `/hook-context` returns `totals` and `names`.
- `hooks/ownmind-render-context.js`, `hooks/ownmind-iron-rule-check.js`,
  `hooks/ownmind-edit-reminder.js`, `hooks/lib/hook-context-fetch.js` — carry them through and
  apply the window. Both hook copies change together (IR-022).
- `hooks/ownmind-iron-rule-check.sh` — the payload now yields `session_id` as well, so the
  command path can key its window by session. It was being thrown away.

## Not in this change

**Tagging the ten team standards that carry no trigger.** Five of them have a real one
(`trigger:commit` ×3, `trigger:deploy`, `trigger:edit`) and were meant to ship here; the
account this was written from can read them and cannot write them — every write is a 404
because it does not own them and is not an admin. The other five govern a kind of work
(onboarding a project, running a review) rather than a kind of operation, and tagging them
`trigger:command` would put them in front of every commit — which is the noise v1.26.151 was
built to remove.
