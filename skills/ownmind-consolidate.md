---
name: ownmind-consolidate
description: Work the monthly "整理記憶" task card — merge duplicate memories, archive finished ones, settle waiting decisions, keep or dismiss lessons — in a background subagent, without asking the person for anything the machine can answer. Use when the session-start context says a memory consolidation card is open, or when the person says 整理記憶 / 清一下記憶.
---

audience: agent

# Consolidating the memory store

The person does not maintain the memory store; you do. This skill is the judgement the
card expects. Everything you change leaves a history row and can be undone with one call,
so prefer acting over asking — but never act on a rule-type memory (iron rules, team
standards, preferences): those are the person's words and only they may retire them.

## Run it in the background

The session-start context tells you when a card is open. Start a background subagent
(Agent tool) with this skill and the card id; keep the main conversation free for the
person. Inside the subagent:

1. `ownmind_task_claim(id)` — if already claimed by another session, stop.
2. `ownmind_consolidation_candidates()` — six groups: `duplicates`, `concluded`, `stale`,
   `waiting`, `lessons`, `closed_tasks`.
3. Work the groups in the order below. Each action tool appends its own progress line to
   the card, so a run that stops half-way is not lost; the next run continues from the
   remaining candidates.
4. `ownmind_task_done(id, result, evidence)` — `result` is the count per action;
   `evidence` is the list of ids you changed with the action taken. The server then
   renders the one-line report at the person's next session start.

First month after this skill ships: do only the exact duplicates and the title-marked
archives (sections 1 and 2a). Leave `stale` and body-only markers for the second month.

## 1. Duplicates (`duplicates`: pairs with similarity ≥ 0.6)

Read both in full (`ownmind_get`). Decide which case it is:

| Case | Action |
|---|---|
| Same event, same facts, different wording | `ownmind_merge({keep: newer, drop: older})` |
| Same subject, the newer one adds facts | `ownmind_update(newer)` with the missing facts folded in, then merge with `keep: newer` |
| Same subject, the two conflict (old way vs new way) | the newer wins: merge with `keep: newer`; the older text is kept in history, never pasted into the body |
| Different things that merely share words (正式機 vs 測試機 checklists, two projects with the same template) | do nothing; note the pair in the card result so it is not re-asked |
| Cannot tell | `ownmind_ask_later(memory_id, question)` with one concrete question |

Never merge across types, never merge an iron rule.

## 2. Concluded (`concluded`, `stale`)

a. **Title marker** (`marker` set: 已過時 / 已結案 / 已完成 / 已發 / 已合併 / 已關單 at the
   start or end of the title): read it once. If the whole memory is about the finished
   thing → `ownmind_archive(id, reason)` for `project` memories. If the title is marked
   but the body still carries a standing rule or a next step, split: `ownmind_save` the
   standing part as a new memory (it will be checked for duplicates), then archive.
   If the memory is outdated rather than finished (a key that was replaced, a setting
   that no longer exists) → `ownmind_disable(id, reason)`, not archive.
b. **Stale** (`project`, 90 days without an update): flag only this month. From the second
   month: check the machine before deciding — `git log -1` in the project folder, the file
   or server the memory names. Evidence that the thing moved on → archive with the
   evidence in the reason. No evidence either way → `ownmind_ask_later`.

Body-only markers (已完成 inside a sentence) are not a reason to archive: "當 PR 已合併後要
通知測試群組" is a live rule.

## 3. Waiting decisions (`waiting`: 待決定 / 待確認 / 待執行 / 等…回覆 in the title or first line)

1. `ownmind_search` for the subject. Only a memory **created after** the waiting one may
   settle it; a test, a plan or a partial step does not settle an execution item.
2. Found → `ownmind_decide({id, decision, source_id})`. Then:
   - one-off item (a migration, a purchase, an install) whose outcome is fully recorded in
     the source memory → `ownmind_archive(id, '決定已記在 #source')`
   - standing decision (which model, which format, which host) → leave active and
     `ownmind_update` the title without the 待決定 word.
3. Not found in memories → check the machine first: git log of the project, the config
   file, the crontab, the server status. Found there → decide with the evidence in the
   decision text (`source_id` may then be the memory you just saved about it).
4. Still unknown and the answer lives outside the machine (someone else's reply, a form
   resent, a vendor) → `ownmind_ask_later`. At most three open questions per month; the
   oldest go first.
5. A waiting item that is really a to-do ("Mac 還沒裝 X") → `ownmind_task_create` a card for
   it and archive the memory with reason `已開成任務卡 #N`. Never ask about the same to-do a
   second month.

## 4. Lessons (`lessons`: `new`, older than 7 days)

Keep a lesson (`ownmind_lesson_set(id, 'promoted')`) only when all three hold: it would
still bite in a new session today; it is not already fixed in code, a test, CLAUDE.md or an
iron rule (grep the repo); it is about this person's environment or habits, not a generic
fact. Otherwise `ownmind_lesson_set(id, 'dismissed', reason)` with the one-line reason
(`已修進程式`, `只發生一次，環境問題`, `CLAUDE.md 已經有這條`). Lessons that happened twice
were promoted automatically at log time; you will see them as `promoted`.

## 5. Reporting

Do not write a report into the conversation yourself; the server renders one line at the
next session start from the history rows. Questions you parked with `ownmind_ask_later`
reach the person in a session of the matching project, at most three at a time; a
question shown twice without an answer is archived automatically and listed in the next
report.

When the person later says 還原 / 撤銷 / 那條不該歸檔: `ownmind_restore(id)` for archived
memories; for a merge, `ownmind_update` the kept memory back to its previous text (the old
body is in its history, `ownmind_get` shows it) and tell the person the dropped memory can be
re-enabled from the console's memory history; `ownmind_lesson_set` for lessons,
`ownmind_task_reopen` for cards, `ownmind_handoff_reopen` for handoffs.
