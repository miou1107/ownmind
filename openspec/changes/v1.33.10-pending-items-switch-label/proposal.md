# v1.33.10 — Switch label that says what it does; the reminder reaches desktop users

## Why

- On 2026-11-19 a colleague could not tell what the 自動提醒 switch at the top of the
  OwnMind 待辦事項 side pane did. The label named a reminder, not what the switch controls:
  whether the pane opens by itself when new items arrive.
- The owner had never once seen the one-sentence reminder sent when a conversation starts,
  although the hook sent it (this very session started with one). The Claude desktop app does
  not draw a SessionStart or UserPromptSubmit `systemMessage`, and the model-facing note told
  the model the user had already seen the reminder and need not repeat it, so nobody said it.

## What changes

- The switch label becomes 有新待辦時自動打開; the toasts become 有新待辦時會自動打開 /
  有新待辦時不會自動打開 (wording approved by the owner on 2026-11-19).
- The longer label always gets a row of its own above the select / refresh row, so the
  refresh button is never pushed out of a narrow pane.
- The `pane` tool description names the new label and keeps the old phrases (關掉自動提醒,
  打開自動提醒) as triggers.
- `contextNote` takes `userSees` (default: `CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop'`).
  Where the user cannot see hook messages, the note tells the model to put the reminder,
  exactly as written and with every line, at the top of its next reply, and not to repeat it
  later. Elsewhere it is unchanged.

## Not verified before release

- Only `claude-desktop` is treated as hiding hook messages; whether the VS Code panel or the
  web shows a SessionStart `systemMessage` has not been checked.

- The desktop relay has not been seen working end to end: it needs a new conversation that
  starts with new items. The label change has been checked by tests only, not on screen.
