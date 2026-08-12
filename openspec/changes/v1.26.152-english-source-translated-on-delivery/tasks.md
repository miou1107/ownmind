# Tasks

## Done

- [x] Re-read issue #94's i18n line. The route was in the parenthetical — 英文原稿 + AI 轉述 —
      not in the cross-referenced issue. The deferral in v1.26.151 was a misreading, not a
      blocked decision.
- [x] Confirm the route already exists in this repo: `hooks/lib/render-session-context.js:164`,
      with a comment explaining why it says "translate" rather than "verbatim".
- [x] `HOOK_CONTEXT_TYPES` and `TRIGGER_LABELS` to English source.
- [x] `renderHookContextLine` emits the relay instruction, naming the counts and version tag
      as the parts that must survive translation.
- [x] Drop the duplicate banner on the new path in `ownmind-render-context.js`; leave the
      legacy branch alone.
- [x] Tests: assertions moved to English, plus a CJK guard over every label and a check that
      the instruction exists and pins the counts.
- [x] Full suite — 4770 tests, 2 failures, both the pre-existing `bare-mount-trailing-slash`
      pair needing the gitignored `src/public/dashboard/`.

## Still open on issue #94

- **Throttling the command path.** The counts line reprints on every matching command. Named
  in #91, still not done in substance. This is the last item on that issue.
