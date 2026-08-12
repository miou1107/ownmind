# Five categories, not one

## Why

The line a hook prints before a risky operation has three jobs:

1. say what OwnMind thinks is about to happen;
2. show that OwnMind actually consulted the user's memories, per category;
3. leave a way to read the contents.

It did none of them. It printed `鐵律觸發（install）` — an internal trigger name, no counts,
no next step. And job 2 was impossible in the data, not merely in the rendering: both hooks
fetched `/api/memory/type/iron_rule` and nothing else, so a user could not distinguish

- "no team standard applies to this operation" from
- "team standards were never looked at".

Those are different facts. One of them is a defect, and the display had no way to report
which had occurred.

`install` is the same failure in the label. A user debugging an auth header watched
`鐵律觸發（install）` appear under every `curl` carrying an `X-API-KEY` and asked what was
being installed. Nothing was — `install` is an internal bucket that happens to contain
credential work, and it had no business being the thing shown to a person.

## What changes

**A new endpoint, `GET /api/memory/hook-context?trigger=X`**, returning all five categories
already filtered for that trigger: counts for each, plus iron-rule titles.

One request, not five. This sits in front of every risky command the user runs; the shell
hook's `curl` is synchronous with a `--max-time 5` ceiling, so five in sequence is a
25-second worst case ahead of a `git commit`. A delay like that is how the whole mechanism
gets switched off, and a switched-off safety mechanism enforces nothing.

**Counts, not contents, for four of the five.** Iron rules keep their listing. Sending every
matching row of all five categories is a few hundred titles in front of a command, which is
how a reminder becomes something people scroll past — and that costs more than the four
lists are worth. The how-to line covers the gap: it says how to ask for any category in full.

**`ruleMatchesTrigger` gains `untaggedMatchesAll`.** Untagged means "relevant to everything"
stays the default and stays what the iron-rule path does. It does not survive contact with
the other four types, which carry no trigger tags because nothing ever asked them to.
Measured on one account (150 iron rules / 32 team standards / 33 coding standards / 92
principles / 14 profile entries):

| trigger | untagged matches all | strict |
| --- | --- | --- |
| commit | 63 | 38 |
| install | 38 | 13 |
| edit | 112 | 87 |

Every extra was a note with nothing to say about the operation. Under the strict setting no
iron rule is lost — commit 33/33, install 12/12, edit 71/71 — which is what makes it safe.

**Rendering moved out of the shell's inline `node -e`** into `hooks/ownmind-render-context.js`.
That inline block was the reason the shell hook carried its own copy of `TRIGGER_TAG_ALIASES`:
a module cannot be imported from `node -e` without interpolating a path into source, the move
behind two silent Windows failures. Running a file BY path as argv is a different thing and is
what this hook already does for its other helpers. The copy is gone, and both hooks now print
the same line rather than two translations of one idea.

## Version skew

`/hook-context` is new; hooks and server are deployed separately and are routinely not the
same version. A hook that only knew the new URL would go silent against a server that has not
been updated, and silence is indistinguishable from "no rules apply" — the exact failure this
codebase keeps being rewritten to avoid.

So anything other than a 200 falls back to `/type/iron_rule`, which every server since v1.19
answers, and the fallback is written to the activity log as `hook_context_fallback`. A
permanently degraded reminder that never says so looks exactly like a working one.

In the fallback the other four counts are **not** printed as zeroes. Zero means "consulted,
matched nothing"; these were never asked. Printing them would be the same lie the issue is
about, told by the fix.

## Decisions taken

**A category at 0 is printed.** The issue flagged this as needing alignment, since the edit
reminder already declines to speak when `rule_count` is 0. They are not in conflict: that rule
is about the *total* — nothing to say, so say nothing — and this is about one row inside a
listing that already earned its place. The zero is the informative part. On an account where
only 2 of 14 profile entries carry a trigger tag, `個人偏好 0` is telling the truth about the
tagging, and it is exactly the sentence the old display could not form.

**The how-to line rides on the infrequent triggers only.** The command path has no session
state to throttle a repeat with, so putting it on `commit` would print it before every commit
and turn a hint into wallpaper. It appears on deploy/delete and on the edit path's hourly full
listing, which is already throttled.

## Impact

- New: `src/routes/memory.js` `/hook-context`, `shared/hook-context.js`,
  `hooks/ownmind-render-context.js`, `hooks/lib/hook-context-fetch.js`.
- Changed: both hooks, `hooks/ownmind-edit-reminder.js`, `shared/edit-reminder-state.js`
  (the window now carries per-category counts so the throttled path still makes no request),
  `shared/helpers.js`, both installers, five test files.
- **The new line only appears once the server is deployed.** Until then every client falls
  back and prints what it printed before, with the fallback recorded.
- Not addressed: category labels are Chinese literals in `shared/hook-context.js`. The issue
  asks for the i18n route described in #91; #91 is closed and about something else, so there
  is no route to follow yet. Left as a follow-up rather than invented here.
