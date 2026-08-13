# Tasks

## 1. Establish what is actually happening

- [x] Reproduce: two commands of the same trigger, one window, count the ⚠️ blocks
- [x] Confirm `listing` is computed and used for `names` only
- [x] Confirm no existing test asserts the listing repeats (in either direction)
- [x] Confirm the legacy branch shares the defect and decide it stays out of scope

The reproduction is in the release notes: two `gh issue comment` calls a minute apart, the second
withholding the names and printing the same nine rules underneath them anyway.

## 2. Red

- [x] `tests/command-listing-obeys-window.test.js` — second command of the same hour prints the
      counts line and no ⚠️ block
- [x] Same file — first command still prints both, and opens the window
- [x] Same file — a different trigger inside the same hour still gets its full listing
- [x] Same file — a different session inside the same hour still gets its full listing
- [x] Same file — `commit` never prints the listing, window or not
- [x] Same file — nothing matched: no output, no window opened
- [x] Same file — an expired window prints the listing again
- [x] `tests/relay-asks-for-a-quiet-line.test.js` — the relay instruction names the blockquote +
      italic form, on both the full and the throttled shapes
- [x] `tests/edit-reminder-english-source.test.js` — no Han characters in the strings OwnMind
      itself emits on the edit path; rule titles the user wrote are exempt

Red exactly once in the first file: `1 failed / 7 passed`. The seven that passed before the fix
are what says the change is narrow — the trigger key, the session key, the `commit` exemption and
the empty case were all already correct and had to stay that way.

## 3. Green

- [x] `hooks/ownmind-render-context.js` — gate the new-path ⚠️ block on `listing`
- [x] `shared/hook-context.js` — presentation instruction in the relay text
- [x] `hooks/ownmind-edit-reminder.js` — English suffix, header, footer, state-failure notice
- [x] `shared/edit-reminder-state.js` — English `renderEditReminderLine`

## 4. Verify

- [x] `npm test` green — 4869 tests, 0 fail, 23 skipped
- [x] Re-run the reproduction against the renderer the shell hook actually invokes
- [x] Check the counts line still renders identically for a first-of-the-hour command

Four existing assertions pinned the Chinese and were updated with it. One of them was worth more
than the update: `does not claim the rules were followed` searched for `正在遵守 / 已遵守 / 遵守中`,
which on an English line matches nothing and passes without checking anything. Its keywords are
English now.

One test defect found and fixed on the way: the renderer suite in
`tests/hook-context-five-categories.test.js` passed no state path and no session id, so it read
and wrote the real `~/.ownmind/state/edit-reminder.json`. Harmless while the window governed only
the names — it just left a window open on the developer's machine — and load-bearing the moment
the window governs the listing, because the assertions then depend on what that machine did in
the previous hour.

## 4b. Code review, and what it sent back

- [x] Reviewer confirmed the `listing` hoist: `:150` sits in the `else if` of `if (legacy)`, so
      the legacy branch is unreachable from it and genuinely unchanged
- [x] Reviewer independently reproduced the red: reverted `&& listing` in a scratch copy, got
      `pass 7 / fail 1` on the one case
- [x] **Important — English at the source with no relay instruction reaching it.** Three paths
      emit OwnMind's own English words alone: the legacy throttled line, the banner header and
      footer, and the state-write notice. Translating them without the instruction leaves a
      Chinese reader worse off than the Chinese they replaced. Fixed: `RELAY_INSTRUCTION` is
      exported from `shared/hook-context.js` and carried on all three.
- [x] **Important — the occurrence suffix landed after the instruction paragraph**, and the
      instruction named only the counts and the version tag. Pre-existing since v1.26.154; this
      release widened the gap and is where it gets fixed. Added `suffix` to
      `renderHookContextLine`; the occurrence is now named in the must-survive list.
- [x] **Important — the empty-`session_id` comment at `ownmind-render-context.js:31-35`** was
      written when the window governed only the names and understated what it now costs.
      Rewritten to say what a new session loses.
- [x] Minor — `/68/` tightened to `/follow: 68/`
- [x] Minor — the CJK guard was Han-only while FILELIST claimed 中日韓; widened to kana, hangul
      and fullwidth forms so the claim is true
- [x] Minor — CHANGELOG said the legacy compatibility path was untouched "including its Chinese".
      True of the command path, false of the edit path, whose legacy line this release does
      change. Corrected, with the reason the two differ.
- [x] Minor — the string count disagreed across proposal / spec / CHANGELOG. It is five.

Not taken up: the reviewer's note that a context compaction now costs the AI its in-context copy
of the rule text for the rest of the hour. That is the throttle working as asked rather than a
defect, and reversing it would undo the release. Recorded in the `:31-35` comment so the next
person weighing it has the number in front of them.

## 5. Ship

- [x] CHANGELOG.md
- [x] FILELIST.md
- [x] README.md / docs/README.ja.md / docs/README.zh-TW.md version bump
- [x] package.json version
- [ ] Code review before commit
- [ ] Commit (owner has not asked for a push or a release)
