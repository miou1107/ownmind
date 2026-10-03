# Tasks the AI picks up

## Why

A task board for people is GitLab's job and it already does it. What GitLab cannot do is
*work the board*: a card sits until a person opens a conversation about it. The comment with
the most agreement under the video that started this (2026-10-03) said it plainly — do not
build a board for one AI tool; let an agent manager hand out the cards.

So the board OwnMind keeps is not for the team to drag cards around. It is a dispatch queue:
the person writes small, well-bounded cards; an AI session, started by a person or by a
schedule, claims one, does it, reports back, and the person reviews. The card's life is the
unit of accounting for everything else OwnMind does — the lessons of v1.31.0 attach to it,
the release check of v1.31.4 reads it.

## What changes

1. **A `tasks` table.** id, user_id (owner), team-visible, project, title, body (Markdown),
   status (`open`, `claimed`, `done`, `reviewed`, `dropped`), claimed_by (user), claimed_tool,
   claimed_session, result (text), links (JSON: GitLab issue URL, MR URL, commit), timestamps.
2. **MCP tools.** `ownmind_task_create` (person asks in chat; the AI writes the card),
   `ownmind_task_list` (open cards for a project, or mine), `ownmind_task_claim` (takes one;
   refuses if already claimed), `ownmind_task_done` (result + links; moves to `done`),
   `ownmind_task_drop` (gives it back with a reason). Every call carries the session id, so a
   card knows which conversation did it.
3. **The session-start context names the open cards** of the current project (title and id,
   at most five) and the one this person has claimed, so a new conversation can say "continue
   #12" and the AI knows what that means. Reminder, declared as such.
4. **A console page, 任務卡, under 我的 and a team view under 團隊** (admin+): the queue by
   status, with a "review" button; a reviewed card is closed. Dropping stays with the
   session that holds the card, through `ownmind_task_drop`, so the reason is always written.
5. **A runner recipe, not a runner.** `docs/task-runner.md` shows how a scheduled Claude Code
   routine (the `schedule` skill) claims and works open cards tagged `auto`. OwnMind ships the
   tools and the recipe; whether a team runs unattended sessions is their decision and their
   cost.

## Decisions

- **Cards are small by construction.** `body` is capped at 4000 characters and the create
  tool's description tells the AI to refuse a card that needs more than one session. A queue
  of epics is a backlog, and a backlog is what nobody works.
- **Claim is exclusive and expires.** A claim older than 24 hours with no `done` is released
  by the daily cron with a note on the card, so a session that died does not hold the card
  forever.
- **The AI cannot review.** `reviewed` is a click. Same reason as v1.31.0's promote.
- **GitLab is a link, not a sync.** A card may carry an issue URL; nothing is written to
  GitLab. Two-way sync is where every previous attempt at this died, and the team standard
  on GitLab API access (personal PAT only) makes a server-side sync the wrong shape anyway.
- **Team-visible by default, private by flag.** The point is that someone else's session can
  pick it up.

## Not in scope

- Drag-and-drop, columns, swimlanes. The queue is a list sorted by status and age.
- Writing to GitLab. See above.
- The runner itself. Recipe only, until a team has run it by hand for a month.
