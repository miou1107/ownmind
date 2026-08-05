# v1.26.62 — The 新增廣播 dialog stops asking for database ids

Raised by Vin on 2026-08-05 from the production dialog. Two fields, one release.
Recorded as item 6 of `openspec/BACKLOG.md`.

## What is wrong

**The recipient field asks for numbers nobody knows.** It is labelled 「指定收件人
user_id（選填、逗號分隔；空=全員）」 and placeholdered `1, 2, 3`. Targeting a broadcast
today means opening 使用者管理 in a second tab, reading ids off the table, and typing
them back. Nothing checks that the ids exist: `POST /api/broadcast/admin` validates only
that each entry is a positive integer, so a typo produces a broadcast addressed to a user
who is not there, and it succeeds. The sender gets no signal.

**The end time is blank, so every broadcast is permanent.** `ends_at` is optional, and
blank means forever. Blank is what everyone leaves it. The result is on the page: entry
after entry reads 生效區間 … — 永久. Nothing ages out on its own, and the list only ever
grows.

Both are instances of the project rule that UI and copy target non-technical users. The
dialog is currently written for whoever built the schema.

## What this is not

**Not a new endpoint.** The backlog entry said this "needs a member-lookup endpoint
(name/email prefix, admin-only)". That was an assumption written without checking.
`GET /api/admin/users` already exists at `src/routes/admin.js:83`, already returns
`id, name, email, role`, and already sits behind `adminAuth` — which a super_admin
passes. The team page, the bug-report page and the team-stats page all call it. The team
is a dozen people; there is nothing to paginate and nothing to search server-side.

So this release adds no route, no query, no column, no migration. It is
`client/src/pages/System/` and the three locale files.

**Not a change to the API contract.** `target_users` stays an array of positive integers
and `ends_at` stays an ISO 8601 string. The picker resolves names to ids before the POST;
the server sees exactly what it sees today.

## The two decisions

**The recipient field becomes a picker, and that removes a validation path rather than
adding one.** `validateBroadcastFormClient` currently parses the comma-separated string
and can return `target_users_invalid`. Once ids come from a list of real members, a
non-integer id is unreachable from the UI, so the modal stops feeding that field to the
validator. The validator itself is untouched — it still mirrors the server's own check,
and its tests still pin that. The server keeps validating for defence in depth.

**The end-time field becomes `datetime-local`, not a text box with a default in it.**
Vin chose this over the smaller change on 2026-08-05. Prefilling an ISO 8601 string into
a text box fixes the blank default but leaves anyone who wants a *different* date typing
`2026-12-31T23:00:00+08:00` by hand. A date picker removes the format from the problem.

The cost is one conversion. `datetime-local` yields `2026-09-04T14:30` with no zone, and
per ES2016 `new Date()` reads an offset-less date-time form as **local** time, so
`new Date(value).toISOString()` is the whole conversion. `validateBroadcastFormClient`
already does `new Date(form.ends_at)` and checks the result is finite, which accepts the
new format unchanged.

Clearing the field still means permanent. That path is now deliberate instead of
accidental, which is the point.

## When the member list will not load

The picker needs `/api/admin/users`. If that call fails, the field shows an inline error
and the picker is disabled; sending to everyone still works, because that path needs no
member list at all.

The alternative was falling back to the old free-text id box. Rejected: it means keeping
two input paths and two validation stories alive permanently to cover a rare window, and
the fallback is exactly the interface this release exists to remove.

## Found while doing it

`cooldown_minutes` was built as `Number(form.cooldown_minutes) || 1440`. Zero is falsy,
the field accepts zero, and the validator rejects only negatives — so an admin typing 0
for "repeatable immediately" saw 0 on screen and sent 1440. Wrong since v1.26.50. Fixed
here rather than filed, because it is three lines from the two fields this release is
about, and because extracting the payload builder is what made it visible at all.

## Review round

Adversarial review through the `agy` CLI, against a copy outside the repo. Five findings,
all five verified against the code before acting, all five real — though two arrived with
the wrong severity attached:

- **Minor, the 30-day default drifts an hour across a DST boundary — correct.**
  `now + 30 * 86400000` adds 720 hours, not 30 days. Fixed with `setDate`. The guard is a
  test asserting the local hours and minutes are preserved; it was confirmed to fail
  against the old implementation under `TZ=America/New_York` and pass after, which is the
  only way to see it from a machine in Taipei.
- **Critical, a cooldown of 0 is silently replaced by 1440 — correct, and pre-existing.**
  See above. The severity is right; the attribution is not, and the release notes say so.
- **Important, the `onBlur` `setTimeout` is fragile — correct, with a different reason
  than the one given.** The reviewer argued it breaks scrollbar dragging, which could not
  be reproduced. The real damage is to keyboard users: the timer fires after Tab moves
  focus into the list and removes the button being focused. Now keyed on `relatedTarget`.
  The timer never protected the click path in the first place — the option's
  `onMouseDown` prevents default, so clicking cannot blur the input.
- **Minor, holding Enter adds the same person twice — correct.** The handler outruns the
  re-render, so `suggestions[active]` is still that member. `pick` now ignores an id it
  already holds.
- **Critical, no arrow keys and no ARIA roles — correct, but not Critical.** Refining the
  query reaches most rows, so it is not the total block the review claimed. It *is* a
  block when one name is a prefix of another, which is reachable in a real team. Arrow
  keys, `role="combobox"`/`listbox"`/`option"`, `aria-expanded` and `aria-activedescendant`
  added.

## Non-goals

- No server-side member search. A dozen rows filter client-side.
- No validation that a chosen member still exists at send time. The list is read when the
  dialog opens; a member deleted in the seconds after that is the server's problem, and
  the server's behaviour there is unchanged.
- No change to 撤銷, to the broadcast list, or to any other field in the dialog.
- No backfill of `ends_at` on the broadcasts already sent. They stay permanent until
  someone revokes them.
