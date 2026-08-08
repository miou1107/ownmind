# v1.26.92 — Proposal: the rules people tag most are the ones that never fire

## Background

v1.26.90 made the PreToolUse iron-rule hook run at all. v1.26.91 made a stored rule
reachable by tags its author actually wrote. Both changes only matter for rules the hook
can reach in the first place, and the hook is registered for exactly one tool:

```js
// install.sh
s.hooks.PreToolUse.push({
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-iron-rule-check.sh' }]
});
```

So a rule fires only while a shell command is being run, and only when that command looks
like commit / deploy / delete. Editing a file is not a shell command, so no rule has ever
fired during an edit.

Measured on a real account with 138 active iron rules (2026-08-07):

| tag | rules carrying it | reachable today |
|---|---|---|
| `trigger:edit` | 56 | no |
| `trigger:write` | 23 | no |
| `trigger:commit` + aliases | 32 | yes |

`trigger:edit` is the single most-used tag on the account. Counting the rules that match
`edit` through the v1.26.91 alias rules — including the 7 untagged rules, which match every
trigger — **63 of 138 rules are relevant to an edit and none of them are ever surfaced.**

These are not obscure rules. They are the ones about what to do while changing code:
verify the write landed, break a new guard once to confirm it goes red, keep the three
READMEs in sync. The AI is at its most likely to drift exactly where the reminder is
absent.

## What this changes

Register the same hook for the file-editing tools, and give it a trigger for them.

The cost is frequency. Editing is the most common thing in a session; commit and deploy
are rare. Surfacing 63 rules on every edit would be unusable, and worse, it would be
switched off — a reminder people turn off enforces nothing.

So the reminder is throttled on a one-hour window:

- **first edit in the window** — the full list, as `deploy` does today
- **every edit after that, until the hour is up** — a single line naming the count
- **first edit after the hour** — full list again, new window

The one-line form deliberately answers the question its own brevity provokes ("did it
break?") by saying which occurrence this is:

```
【OwnMind v1.26.92】AI 改檔案要遵守的鐵律 63 條 · 本小時第 4 次
```

The subject is the AI, not the reader: a bare "63 rules in effect" reads as an instruction
to the person watching. It says the rules apply, not that they were obeyed — the hook
knows the first and cannot know the second, and a line that claims compliance is false
exactly when it matters.

## What this does not change

- **No new blocking.** The edit trigger produces a reminder and nothing else; it does not
  run the verification engine, which is the only path that can emit `decision: block`.
  v1.26.90 already downgraded that path to report-only for every other trigger.
- **No change to the Bash triggers.** `detectCommandTrigger` is untouched, so commit /
  deploy / delete behave exactly as they do today.
- **No extra network per edit.** The rule list is fetched once per window and the count is
  carried in the state file, so the throttled path makes no request at all.

## Decision record

Asked on 2026-08-07 whether to make these rules effective given the noise cost, the answer
was yes, with the one-hour repeat form specified directly: "1 小時內如果有多次重複觸發時，
從第二次起就簡單一行字提醒就好". The occurrence count in the line was chosen over the
alternatives in the same exchange.
