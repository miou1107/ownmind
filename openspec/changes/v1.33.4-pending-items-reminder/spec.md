# Spec: pending items reminder

## State file

`~/.ownmind/state/pending-items.json`

```json
{
  "day": "2026-11-13",
  "lastCheckAt": "2026-11-13T09:05:00+08:00",
  "shownToday": ["github:example/app#64:assigned"],
  "commentBaseline": { "github:example/web#50": 3 },
  "hosts": { "github": "ok", "gitlab:https://git.example.com": "expired" },
  "items": [ { "key": "...", "kind": "assigned", "title": "...", "url": "...", "ref": "...", "repo": "...", "at": "..." } ]
}
```

`items` is the full current list (for the pane); `shownToday` holds `key:kind:signal` strings
already listed today.

## Item kinds

| kind | source | label |
|---|---|---|
| `assigned` | open issue assigned to the user | 待處理 |
| `review` | open PR/MR requesting the user's review | 待審核 |
| `failing` | user's open PR/MR whose latest checks failed | 測試未通過 |
| `comment` | user's open PR/MR whose comment count rose since the baseline | 待回覆 |

The signal for `failing` is the head commit; for `comment` it is the comment count; for the
others it is empty. A new signal makes an item new again.

## Host status

| Result of a check | `hosts[h]` becomes | User sees |
|---|---|---|
| answered | `ok` | items |
| refused credentials, previous `ok` or `expired` | `expired` | the expired line |
| refused credentials, never `ok` | unchanged (absent) | nothing |
| not installed / not configured | unchanged | nothing |
| timeout or network error | unchanged | nothing |

## Scenarios

### First check of the day
- GIVEN `day` differs from today
- WHEN a check finishes
- THEN every current item is listed and `shownToday` is reset to the listed keys

### Later session the same day
- GIVEN `day` is today and `#64:assigned` is in `shownToday`
- WHEN a new issue `#112` is assigned
- THEN only `#112` is listed

### Prompt after an hour
- GIVEN `lastCheckAt` is more than 60 minutes ago
- WHEN the user submits a prompt
- THEN a check runs and new items are listed in that turn's `systemMessage`
- AND a prompt sooner than 60 minutes runs no check

### Nothing new
- WHEN a check finds no new items and no expired host
- THEN no `systemMessage` is produced

### Expired GitHub login
- GIVEN `hosts.github` is `ok`
- WHEN `gh` reports bad credentials
- THEN the line "GitHub 登入已過期，需重新登入才能列出等你處理的單" is shown on every check
  until `gh` answers again

### Pane
- GIVEN the desktop app with `mods/pending-items` installed
- WHEN the state file has items
- THEN the pane lists them all, and an item removed from `items` disappears within a minute
