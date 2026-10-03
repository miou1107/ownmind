# Spec — lessons at close

## Normalising `lessons`

GIVEN `lessons: ["cache was stale", { stuck: "x", fix: " y " }, { fix: "no stuck" }, 42]`
WHEN `normalizeLessons` runs
THEN it returns two lessons (`{stuck:"cache was stale"}`, `{stuck:"x", fix:"y"}`) and `dropped: 2`.

GIVEN 25 lessons with a `stuck`
WHEN normalised
THEN 20 are kept and `dropped` is 5.

GIVEN a `stuck` longer than 2000 characters
WHEN normalised
THEN it is cut to 2000.

## The MCP body

GIVEN `ownmind_log_session({ summary, lessons: [{ stuck: "a" }] })`
WHEN the body is built
THEN it carries `lessons: [{ stuck: "a" }]`.

GIVEN `lessons` absent, `[]`, or made only of blanks
WHEN the body is built
THEN `lessons` is not a key of the body.

GIVEN the tool schema
THEN `ownmind_log_session.inputSchema.properties.lessons` exists, is an array of objects with
`stuck` required, and `required` still names only `summary`.

## Storing

GIVEN POST /api/session with `lessons` of three entries, one of which contains a private key
WHEN handled
THEN the session row is created, two `session_lessons` rows are inserted with the session's
`project`, and the answer carries `lessons_saved: 2, lessons_rejected: 1`.

GIVEN POST /api/session with no `lessons`
THEN nothing about the answer changes from v1.30.50.

## Listing

GIVEN GET /api/session/lessons
THEN rows are this person's `new` lessons, newest first, no time window.

GIVEN `?status=promoted&days=7`
THEN rows are this person's promoted lessons of the last 7 days.

## Promoting

GIVEN PUT /api/session/lessons/:id/promote on a `new` row of mine
WHEN handled
THEN a `memories` row of type `project` is inserted whose content has `Stuck:`, `Fix:` and
`Next time:` lines, tagged `lesson` and `project:<name>`, and the lesson becomes `promoted`
with `memory_id` set. The answer carries both rows.

GIVEN the row is `dismissed` or `promoted`
THEN 409 with the current status.

GIVEN the row is someone else's or the id is not a number
THEN 404.

GIVEN the lesson text matches a secret
THEN 400 with the rule name and no fragment of the text; nothing is written.

## Dismissing

GIVEN PUT /:id/dismiss on a `new` row of mine
THEN the row becomes `dismissed` with `resolved_at`.

GIVEN the row is already resolved
THEN 404.

## Session-start context

GIVEN the init answer carries `lessons_waiting: 3`
WHEN the context is rendered
THEN it has a line `## Lessons waiting: 3` naming the page.

GIVEN `lessons_waiting` is 0 or absent
THEN no such line.

## The tool's own answer

GIVEN `ownmind_log_session` was called without usable lessons
THEN the answer carries `lessons_notice`, one sentence asking for them if there were any.

GIVEN it was called with lessons
THEN the answer carries `lessons_saved` from the server and no notice.

## The console

GIVEN the navigation
THEN `/portal/lessons` is under 我的 at `minRole: user`, has an icon, a page in `REAL_PAGES`,
and a label in all three locales (asserted by tests/console-nav-structure.test.js).
