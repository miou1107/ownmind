# Spec — tasks the AI picks up

## Creating

GIVEN `ownmind_task_create({ project, title, body, links?, auto?, private? })`
WHEN handled
THEN a row is inserted with status `open`, owner = caller, visible to the team unless
`private`, and the answer carries the id.

GIVEN `body` longer than 4000 characters
THEN 400 naming the limit; nothing is written.

GIVEN `title` or `project` missing
THEN the client guard refuses before any request (required-args.js), naming the fields.

## Listing

GIVEN `ownmind_task_list({ project })`
THEN open and claimed cards of that project visible to the caller, oldest first, at most 50,
each with id, title, status, claimed_by name, created_at.

GIVEN `ownmind_task_list({ mine: true })`
THEN cards the caller owns or has claimed, any status except `reviewed`/`dropped`.

## Claiming

GIVEN an `open` card
WHEN `ownmind_task_claim({ id })`
THEN status `claimed`, claimed_by = caller, claimed_tool = client tool, claimed_session =
this session, claimed_at = now.

GIVEN the card is already `claimed` by someone else
THEN 409 naming who and when; nothing changes.

GIVEN the card is `claimed` by the caller from another session
THEN the claim moves to this session (same person, new conversation).

GIVEN a claim is older than 24 hours and the card is still `claimed`
WHEN the daily job runs
THEN status returns to `open`, `claimed_*` are cleared, and a line is appended to `body`
saying the claim expired.

## Finishing

GIVEN a card the caller has claimed
WHEN `ownmind_task_done({ id, result, links? })`
THEN status `done`, result stored, links merged, done_at = now.

GIVEN the caller has not claimed it
THEN 403.

GIVEN `ownmind_task_drop({ id, reason })` on a card the caller has claimed
THEN status `open`, claim cleared, reason appended to `body`.

## Reviewing

GIVEN a `done` card
WHEN the owner (or an admin) clicks review on the console
THEN status `reviewed`, reviewed_by, reviewed_at.

GIVEN any MCP tool tries to set `reviewed`
THEN there is no such tool; the schema offers none.

## Session-start context

GIVEN the current project has open or claimed cards visible to the caller
WHEN the context is rendered
THEN a block `## Tasks (project)` lists at most five, the caller's own claimed one first,
as `#12 claimed by you — title`.

GIVEN none
THEN no block.

## Visibility

GIVEN a `private` card of another member
THEN it is absent from every list, 404 on claim.

GIVEN the console team view
THEN admin+ only (`adminAuth`), every non-private card of every member.
