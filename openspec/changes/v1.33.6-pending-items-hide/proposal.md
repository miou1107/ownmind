# The pending-items pane: hide a card, name someone on every card, handle OwnMind items in the conversation

Follows v1.33.5 (the pane as a board grouped by project).

## Why

On 2026-11-12, right after v1.33.5 shipped, the product owner asked for a way to hide or ignore
a card: once hidden, the item should never be reminded again, and pressing must ask first.
Trying each build in the pane, he then asked for: an icon instead of the word, shown only while
the pointer is on the card; an avatar on every card, himself and bots included, with the full
name on hover; a different card layout; no status labels; a pull request numbered like a merge
request; and OwnMind task cards and bug reports handled in the conversation instead of on a web
page, as a request placed in the prompt box that he sends himself.

## What changes

### Hiding

- Each card has a hide control, the 🔕 emoji (a Button holds only text, and draws its `label`
  in place of its children, so the control has no label). On the desktop it waits in a hidden
  box inside a slot of fixed width at the end of the card's last row and shows while the pointer
  is on the card; the terminal always draws it.
- Pressing it opens the engine's own question dialog (`$.ui.ask`) with a one-line warning and
  two answers, hide and cancel. Dismissing the dialog or choosing cancel changes nothing.
- On hide, the pane appends `{ key, title, at }` to `~/.ownmind/state/pending-items-hidden.json`
  and redraws without the card.
- `decide` takes the hidden keys: a hidden item is left out of the list shown at the start of a
  conversation and out of the items written to the state file, whatever its kind and also when
  it is carried over from a host that did not answer. Comment baselines still move.
- `checkPendingItems` reads the hidden file that sits beside the state file it was given, so a
  test with a temporary state path never reads the real one.

### Who a card names

- Every item carries `person`: the issue's opener, the PR or MR's author, the last commenter,
  the user themself for their own PR whose tests failed, a task card's opener, a bug report's
  reporter. Bots are named like anyone else. Whether a comment counts as waiting on the user is
  still decided apart from this (`latestOther`).
- The avatar's Svg carries the full name as its `<title>` and is drawn `isInteractive`, which
  is what lets the desktop show it as a tooltip.
- `GET /api/bug-reports/notifications` returns `reporter_name` on both lists. Until the server
  runs this version a bug report's card has no avatar.

### The card

- One row holds the avatar, the title and the number; the next holds the age and the hide slot.
- No label says why an item waits; the title alone opens the item.
- A GitHub pull request is shown as `!206`.

### OwnMind items in the conversation

- Pressing the title of an OwnMind task card or bug report puts a one-line request in the
  prompt box (`$.prompt.fill`; appended on a new line when a draft is already there).
- A `prompt.submit` hook recognises such a request (a line that is exactly what the pane
  writes, typed by hand too), runs `hooks/pending-items-show.js <task|bug> <id>` and attaches
  what it printed as `context`. Only a prompt the person sent themself counts (origin `composer`
  or `bridge`, no slash command, not a meta prompt): a background task's notice, another
  session's message or another plugin's prompt that quotes the request runs nothing.
- `describeOwnMindItem` reads the item with the user's own credentials. The server has no route
  for one task card, so the card is picked out of `GET /api/tasks?mine=true&full=true`. Every
  field of an item is other people's text, so all of it sits behind a `|` bar under one line
  that says so: a short field as one capped line, a body line by line, split on every character
  that breaks a line anywhere. A long body is cut and says so.
- New MCP tool `ownmind_bug_report_status` (admins): triaged, in_progress, fixed, or wontfix
  with a reason, through the existing `PATCH /api/bug-reports/:id/status`.

## Decisions

- Hidden is per item key, not per kind: hiding a PR hides its failing-tests card and its
  new-comment card too. "Never remind me again" is about the item.
- The hidden list is a file of its own, written only by the pane. The state file is rewritten
  whole by every check, so keeping the list there would let a check that started before the
  press write the old list back.
- A hidden list that is there but cannot be read (half written, damaged) is never written over:
  the hide is refused with a toast, since writing would bring every earlier item back.
- The list is never pruned and is per computer. No restore control in this change; the file
  keeps each item's title so one can be added.
- The request is filled, not submitted: the product owner wants to press Enter himself.
- The item's text reaches the model through the prompt hook, not through a new read tool: it
  arrives with the prompt, needs no tool choice by the model, and works for a request typed by
  hand.

## Tried and dropped

- The whole card as the press target: only a Button can be pressed and it holds only text.
- The full title on hover: no element takes a tooltip but Svg; a strip laid over the card hid
  what was above it, and one in the flow made the card jump in height under the pointer.
- The hide control laid over the card's corner: it hid the end of the title.

## Out of scope

- A restore control in the pane.
- Syncing what is hidden between computers.
