# Running task cards unattended

OwnMind ships the cards and the tools (v1.31.3). It does not ship a runner: whether a team
lets AI sessions work cards with nobody watching is that team's decision and that team's
cost. This page is the recipe for doing it with Claude Code's scheduled routines.

## The convention

- A card with `auto: true` is one the owner is willing to have picked up unattended.
  Everything else waits for a person to say "do #12".
- The card body is the whole brief. If the session has to ask a question, the card was too
  big; drop it with the question as the reason and let the owner split it.
- A session claims one card, finishes it, logs the session with lessons, and stops. One card
  per run; a loop that empties the queue is a loop nobody reviews.

## The routine

Create a scheduled routine (the `schedule` skill, or `/schedule`) in the project's folder with
a prompt like this:

```
Call ownmind_task_list with project "<project>". Pick the oldest open card whose `auto` is
true. If there is none, say so and stop.
Call ownmind_task_claim on it. Read the card body as the whole brief.
Do the work on a branch named task/<id>. Run the project's tests. Commit.
Call ownmind_task_done with a result that says what changed, where, and how to verify it,
and a link to the branch or merge request.
Call ownmind_log_session with lessons.
Do not pick a second card.
```

Run it at a time nobody is editing, so the collision warning (v1.31.2) has nothing to say.

## What the person does

- Writes small cards, marks the safe ones `auto`.
- The next morning, opens 任務卡 in the console: `done` cards carry the result and the link.
  Review closes the card. A card that should go back to the queue is dropped by the session
  that holds it (`ownmind_task_drop`), with the reason on the card.
- A card that keeps being dropped is a card that needs a person.

## What OwnMind guarantees

- A claim is exclusive; two routines cannot take the same card.
- A claim older than 24 hours is handed back by the daily job with a note, so a run that died
  does not hold a card forever.
- No tool can mark a card reviewed. Only the console can.
