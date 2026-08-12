# English source, translated on delivery

## Why

v1.26.151 wrote the five category names as Chinese string literals. Issue #94 asked for the
opposite, in the same sentence that raised the point:

> 類別的顯示名稱要走 #91 講的 i18n 路線（**英文原稿 + AI 轉述**），不要硬寫中文。

The parenthetical *is* the route: an English source, paraphrased by the model into whatever
language it is speaking. What happened instead is that the cross-reference beside it was
followed, #91 turned out to be closed and about something else entirely, and "there is no
route described anywhere to follow" became the stated reason to defer — while the route sat
in the same sentence, four words to the right.

It is also not a new route here. `hooks/lib/render-session-context.js:164` already does it for
the startup tip:

> Tip (relay this one — translate it if you are speaking another language, but keep any quoted
> phrase the user is meant to say exactly as written…)

with a comment explaining why it is phrased as "translate" rather than "verbatim". So the
decision this deferred to the user had already been taken, in this repo, and was reachable
from the file being edited.

## What changes

Labels become English source:

```
[OwnMind v1.26.152] Deploy · Team standards 7, Iron rules 71, Coding standards 3, Working principles 2, Preferences 0
Relay the line above to the user, translated into the language you are speaking with them.
Keep the counts and the version tag exactly as written.
```

**The instruction names what must survive the translation.** Without pinning the counts, a
model summarises them away — and the numbers are the whole point of the line. `Preferences 0`
is the sentence the old display could not form; a paraphrase that drops it puts the display
back where it started.

**A test walks every label and fails on any CJK character.** The failure mode being guarded
is not "someone translates it wrongly" but "someone adds a sixth category and writes its name
in the language they happen to be speaking" — which is exactly what v1.26.151 did, and it
passed a full suite.

## What does not change

**The fallback path's Chinese.** That output is what users on an un-upgraded server have been
reading all along. Translating it as well would turn a degraded path into a third thing nobody
asked for, and the English-source route is about the line being introduced.

**The new path drops its duplicate banner.** The counts line already reads `Iron rules 71` and
already carries the relay instruction; a second heading repeating both was the same sentence
twice.

## Impact

- `shared/hook-context.js` — labels, and the relay instruction in `renderHookContextLine`.
- `hooks/ownmind-render-context.js` — the new path's listing loses its redundant banner; the
  legacy branch is untouched.
- `tests/hook-context-five-categories.test.js` — assertions in English, plus the two new
  guards (no CJK in labels; the instruction exists and pins the counts).
- Nothing about which rules match, or how many. This release changes only what the line says
  and in what language it arrives.
