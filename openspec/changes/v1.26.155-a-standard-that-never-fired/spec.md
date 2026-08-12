# Spec — outward sends are an operation

## Requirement 1 — sending something out is classified

`detectCommandTrigger` MUST return `send` for commands that put content where other people
will read it.

### Scenario: filing or replying

- **GIVEN** `gh issue create`, `gh issue comment`, `gh pr create`, `gh pr review`,
  `gh issue edit`, `gh issue close`, `gh issue reopen`, or `git send-email`
- **THEN** the trigger is `send`

### Scenario: reading

- **GIVEN** `gh issue list` or `gh pr view`
- **THEN** the trigger is `null`

Nothing leaves. A reminder in front of every list command is one that gets scrolled past, and
it takes the real case with it.

### Scenario: publishing a build

- **GIVEN** `gh release create`
- **THEN** the trigger is `deploy`

### Scenario: a command that both sends and deploys

- **GIVEN** `gh pr create && git push`
- **THEN** the trigger is `deploy`

Deploy is matched first and keeps priority, so no command that already had a classification
changes because of this release.

## Requirement 2 — the label names the operation truthfully

The label for `send` MUST be `Outward send` — not "Deploy" and not "Publish", both of which
read as shipping software. This fires on a reply to an issue as much as on a public post, and
the property it has to convey is that the thing is about to leave.

## Requirement 3 — the ambiguous words match both buckets

### Scenario: a memory tagged for publishing

- **GIVEN** a memory tagged `trigger:publish`, `trigger:發布` or `trigger:發佈`
- **THEN** it matches `send`
- **AND** it matches `deploy`

發布新版本 is a deploy; 發布一篇文章 is an outward send. The word does not decide, and the
author cannot know which bucket their tag lands in. One extra line on the wrong operation is
cheaper than silence on the right one, and the standard behind this says why: what goes out
cannot be taken back.

### Scenario: the deploy-only vocabulary

- **GIVEN** `trigger:部署`, `trigger:上線`, `trigger:升級`, `trigger:kubectl`
- **THEN** they do **not** match `send`

Otherwise every deployment standard appears on a reply to an issue.

### Scenario: a send tag on an unrelated operation

- **GIVEN** `trigger:send` or `trigger:對外`
- **THEN** it matches neither `commit` nor `edit`

## Out of scope

Seven memories carry tags that name a kind of work rather than an operation — replying,
wrapping up, debugging, onboarding a project, migrating a repo. No vocabulary change reaches
them, because there is no tool call to hook. They are already served by the session-start
channel, which loads every team standard's title. Their tags are redundant, not broken.

`trigger:push` is left alone: every memory carrying it already matches `commit` via another
tag, so adding the word would change no behaviour.
