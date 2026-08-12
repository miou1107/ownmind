# Tasks

## 1. Establish the problem, not assume it

- [x] Query the live account: which memories actually match a commit, and how many exist
      (4 of 32 team standards, 0 of 4 iron rules, 1 of 1 principle, 0 of 1 preference)
- [x] Read the standard that matched and was ignored — 「Commit 前品管三步驟」, whose step 2 is
      to request a code review, skipped on the release before this one
- [x] Read `TRIGGER_TAG_ALIASES` before proposing any tag, so no tag is added that nothing
      will ever match

## 2. The line

- [x] `tallyHookContext` returns `totals` (counted before the filter) and `names`
- [x] `renderHookContextLine` takes them; sentence form; `N/M` when totals are known and bare
      `N` when they are not
- [x] `/hook-context` returns both — same rows, no second query

## 3. The window

- [x] `windowKey(sessionId, trigger)`; read/write take a trigger
- [x] `decideEditReminder` carries `totals` alongside `counts`, and deliberately not `names`
- [x] Command path: `render-context` takes a session id and applies the window
- [x] `.sh` payload yields `session_id` (line 1), `tool_name` (line 2), command (line 3+)
- [x] JS twin holds the same window, keyed the same way

## 4. Tests

- [x] Denominator present / absent; names listed / withheld; empty category gets no name row
- [x] `tallyHookContext` counts the total before filtering
- [x] A commit listing does not silence the deploy listing
- [x] A second session still gets its own
- [x] A pre-v1.26.154 state entry expires rather than being misread
- [x] Updated the assertions that pinned the old `·` separator and the bare session key

## 5. Two guards this change tripped, and should have

- [x] `IR-022` written into a hook comment — product code may not carry concrete rule codes
- [x] The owner's name written into a hook comment — product code may not carry it

Both were caught by existing repo tests, not by review. Fixed in place.

## 6. Release

- [x] CHANGELOG / FILELIST / three READMEs / package.json
- [x] Full suite: 4782 tests, 4763 pass, 2 fail — both the pre-existing
      `bare-mount-trailing-slash` cases that need the gitignored `src/public/dashboard/` build
- [x] Commit, push, tag `v1.26.154`

## 7. One defect found while waiting for the suite

- [x] The window was opened even when nothing was printed — every category at zero makes
      `renderHookContextLine` return `''`, and the hour would then have been spent on a listing
      nobody saw, throttling the next operation of that kind against nothing. Both hook copies
      now open the window only when a line was actually emitted.

## Blocked, and handed back

**Tagging the five team standards that have a real trigger** (`trigger:commit` on 100, 108,
109; `trigger:deploy` on 242; `trigger:edit` on 135). Reading them returns 200 and writing
returns 404: the account this was developed from owns none of them and is not an admin. Needs
an account that is.

**The other five stay untagged on purpose.** They govern a kind of work — onboarding a project,
running a review, starting a new codebase — not a kind of operation. The only tag that would
make them appear is `trigger:command`, which matches everything, and putting them in front of
every commit is the noise v1.26.151 was built to remove.
