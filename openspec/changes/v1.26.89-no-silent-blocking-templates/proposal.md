# v1.26.89 — Proposal: the server was silently turning reminders into blockers

## Background

Bug report #16, filed 2026-08-06 by `Vin-windows-test`, severity `high`.

Saving an iron rule ran it through `matchTemplate()`. On a hit, the server wrote
`metadata.verification` onto the stored rule and returned `matched_template` as a bare id
buried in a large response object. Nothing said a template had been applied.

Every one of the five templates carries `block_on_fail: true`. So the shape was: you write
a reminder, you get back a rule that will stop your work, and you only find out the next
time it stops you — with a message that has nothing to do with what you wrote.

### The reported case

Memory 829, titled 「失敗處理不能毀掉診斷線索：回滾／清理前，先把日誌搬到不會被還原的
地方」. It is about not deleting diagnostic logs during rollback. It was tagged
`trigger:deploy` and its body contains the word 測試 once, in passing. That was enough to
match `deploy_requires_test`, whose block message is 「還沒跑測試」.

The reporter guessed the match keyed on the tag alone. It does not: `matchTemplate` requires
a trigger tag **and** at least one keyword. In practice that is the same thing — one
incidental keyword anywhere in a long rule clears the bar.

### The part the report did not know

Earlier the same day, eight iron rules were found carrying the `commit_sync_docs`
verification condition, only two of which were about documentation. That was recorded as
hand-copying. It was not. `commit_sync_docs` matches on `trigger:commit` plus any of
同步 / README / CHANGELOG / FILELIST / 文件 — and 文件 appears in a great many rules that
have nothing to do with docs. **This mechanism put them there**, which means removing them
by hand without changing this would have let them come straight back.

## Decisions

| question | decision |
|---|---|
| keep auto-applying non-blocking templates? | there are none — every template blocks. Asked, and the answer was to stop auto-applying entirely |
| drop the matching too? | no. The hint is useful; what was wrong is that it took effect without anybody agreeing to it |
| how does the caller learn about a match? | `template_suggestion`: name, `applied: false`, `blocks_work`, and a sentence an AI can relay verbatim |
| tighten the matching rules? | not now. With nothing auto-applied, a loose match costs a suggestion, not a blocked commit. Tightening a heuristic nobody has calibrated would be guesswork |
| clean up rules already carrying a mis-applied template | not in this change; see Risks |

## Scope

**In:** `src/routes/memory.js` stops writing `metadata.verification` on a template match and
returns a suggestion instead; a regression test built from the reported rule's real text.

**Out:** a way for a user to clear a verification block that was applied to their rule
before this change (`ownmind_update` can do it today, but only by overwriting the whole
metadata object and remembering to carry `origin_context` back — which is what the reporter
correctly calls too fragile for a normal user). Recorded in the backlog.

## Risks

- **Rules already carrying a mis-applied template keep it.** This change stops new ones; it
  does not sweep old ones. Eight were cleared by hand on 2026-08-06 and will now stay
  cleared. Others may exist on other accounts, unaudited.
- **A genuinely useful template now needs an explicit request.** Accepted: the templates
  block work, and nothing that blocks work should arrive without somebody choosing it.
