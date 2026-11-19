# The pending-items pane: a switch that looks different on and off, and the list in the conversation

Follows v1.33.8 (the pane's new title, the 自動提醒 switch, opening only when named).

## Why

On 2026-11-18, right after v1.33.8 shipped, the product owner saw the 自動提醒 switch in the
Claude desktop app as a plain black dot whether it was on or off, and the refresh button cut
off at the pane's edge. The desktop app draws a Button's label alone: the colours of any `Text`
inside a Button are dropped, so the green and grey tracks of v1.33.8 were never painted. v1.33.8
was released without anyone seeing the switch on the desktop surface.

A review of v1.33.8 made after its release found two more gaps. 「打開 OwnMind 待辦事項」 was
listed as a phrase for switching the reminder on, though it is also the pane's own name with
"open" in front of it. And the tool told the model to answer "what is waiting on me" in the
conversation without giving it the list.

## What changes

- On a graphical surface the switch is the label 自動提醒 (a plain Button) and, beside it, a
  track: a `Box` with a background and a round border, green while on and grey while off,
  around a plain Button whose label is the knob (a white-circle emoji, which keeps its own
  colour) at the right while on and at the left while off. Both Buttons toggle. The terminal
  keeps the text switch of v1.33.8.
- With a project select, the switch has a row of its own above the select and the refresh
  button; without one, the switch and the refresh button share a row.
- The `pane` tool: 打開 with the pane's title is `show`; `on` keeps the phrases that name the
  reminder. A new action `list` returns the items as text, most urgent first, and leaves the
  pane closed; it is what the model answers 我有哪些待辦事項 from.
- The note handed to the model with the reminder says where the whole list is.
- Tests assert the track's colour and the knob's side for on and off, the terminal branch, the
  switch's own row, and what `list` returns.

## Not in this change

- The project dots in the group headers, which the desktop also draws without their colours.
- When the reminder appears in the conversation, and its wording.
- Server code.
