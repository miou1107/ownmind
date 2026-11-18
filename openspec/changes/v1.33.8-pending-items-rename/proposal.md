# The pending-items pane: a new title, a switch for opening by itself, and opening only when named

Follows v1.33.7 (open only for new items, a button for opening by itself, a one-sentence reminder).

## Why

On 2026-11-18, right after v1.33.7 shipped, the product owner tried the pane and asked for three
things: the header button should be an on/off switch named 自動提醒; the pane should be titled
OwnMind 待辦事項; and Claude should open the pane only when the request names the side pane,
because his usual way of asking Claude to list and handle the items (看一下我有哪些 issue 要處理)
was opening the pane instead.

## What changes

- The pane's title is `OwnMind 待辦事項`. The slash command and the plugin's name are unchanged.
- The header control for opening by itself is a switch: the label 自動提醒 and a knob on a track,
  drawn from `Text` (a Button holds strings and `Text` only, and no surface has a switch
  element). The knob sits at the right of a green track while on and at the left of a grey one
  while off; the terminal draws the same glyphs inverse or dim. The stored value and the atom
  are unchanged.
- The toasts are 已開啟自動提醒 and 已關閉自動提醒.
- The `pane` tool's description: `show` only when the user names the side pane itself (sidebar,
  側邊欄, 面板); a request to see or handle the items that does not name it is answered in the
  conversation. The description lists both the new and the old title among the phrases.
- The note handed to the model with the reminder names the pane by its new title.

## Not in this change

- When the reminder appears in the conversation, and its wording.
- Server code.
