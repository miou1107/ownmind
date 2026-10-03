# Spec — collision warning

## What the hook sends

GIVEN an Edit/Write/MultiEdit tool call on `/Users/x/work/idaytour/src/order/cart.js`
WHEN the edit hook runs
THEN it posts `{ project: "idaytour", dir: "src/order", session_id }` to
`POST /api/activity/touch` — no file name, no absolute path, no home directory segment.

GIVEN the same directory was reported less than 10 minutes ago in this session
THEN nothing is posted; the cached answer is reused.

GIVEN `~/.ownmind/.no-touch-report` exists
THEN nothing is posted and nothing is printed.

GIVEN the file is outside any git repository, or the project name resolves to null
THEN nothing is posted.

## What the server keeps

GIVEN a touch arrives
WHEN stored
THEN `edit_touches` has one row per (user_id, project, dir, session_id) with `last_seen` =
now, upserted rather than appended.

GIVEN rows older than 24 hours
THEN no query returns them, and the daily cleanup job deletes them.

## What the server answers

GIVEN Amiee touched `idaytour / src/order` 12 minutes ago and Vin touches the same
WHEN Vin's hook posts
THEN the answer is `{ others: [{ name: "Amiee", minutes_ago: 12 }] }`.

GIVEN the only other touch is Vin's own second session
THEN `others` is empty — a person does not collide with themself.

GIVEN the other touch is 3 hours old
THEN `others` is empty.

GIVEN a different directory in the same project
THEN `others` is empty.

## What the hook prints

GIVEN `others` names Amiee for `src/order`
WHEN the hook answers the tool call
THEN `additionalContext` carries one line naming Amiee, the directory, the project and the
minutes, and asking the AI to tell the user once.

GIVEN the same (Amiee, src/order) pair was already printed in this session
THEN no line is printed again.

GIVEN the server answers anything but 200, or does not answer within 3 seconds
THEN the edit proceeds, nothing is printed about collisions, and
`~/.ownmind/logs/<day>.jsonl` carries an event `touch_report_failed` with the reason.

## The team page

GIVEN two members touched the same (project, dir) within the last 24 hours
WHEN an admin opens `/team/stats`
THEN an "Overlaps" block lists the pair, the directory, the project and when.

GIVEN a plain member
THEN the block is not served (`adminAuth`).
