# v1.26.126 — Spec

## Requirement: the footer's changelog shows the releases the running server has

The changelog modal MUST render entries derived from the `CHANGELOG.md` shipped with the
running server, and MUST NOT be fed a literal from the client.

### Scenario: a signed-in user opens the changelog

- **GIVEN** a signed-in user on any dashboard page
- **WHEN** they click the footer's changelog button
- **THEN** the modal lists recent releases, newest first, the first of which is the version
  shown beside it in the footer

### Scenario: the request has not returned yet, or failed

- **GIVEN** `GET /api/changelog` is slow or fails
- **WHEN** the user opens the modal
- **THEN** it renders its existing empty state, and no error is surfaced

## Requirement: every heading shape in CHANGELOG.md parses

The parser MUST read all heading shapes present in the file, and MUST skip a heading that
carries no version rather than emitting an entry with an empty version.

### Scenario: the current shape

- **GIVEN** `## v1.26.125 — 名字寫錯了`
- **WHEN** it is parsed
- **THEN** version is `1.26.125`, title is `名字寫錯了`, and date is empty

### Scenario: the pre-v1.16.0 hyphen shape

- **GIVEN** `## v1.15.4 - SessionStart 可靠觸發`
- **WHEN** it is parsed
- **THEN** version is `1.15.4` and title is `SessionStart 可靠觸發`

### Scenario: the earliest shape, date first

- **GIVEN** `## 2026-03-26 — v1.4.0 鐵律防護修正`
- **WHEN** it is parsed
- **THEN** version is `1.4.0`, title is `鐵律防護修正`, and date is `2026-03-26`

### Scenario: a heading with no version

- **GIVEN** `## 尚未發布`
- **WHEN** it is parsed
- **THEN** no entry is produced for it

### Scenario: a heading quoted inside a fenced block

- **GIVEN** an entry whose body contains a fence listing `## v1.15.4 - 標題`
- **WHEN** the file is parsed
- **THEN** no entry is produced for the quoted heading, and the entry after the quoting one
  is the release that actually precedes it

## Requirement: a version identifies a release, not an entry

Consumers MUST NOT treat a version as a unique identifier for an entry.

`CHANGELOG.md` ships several entries under one version: v1.26.98 has six, v1.26.87 and
v1.17.1 two each. A list keyed on version alone silently drops all but the first.

### Scenario: the timeline renders a repeated version

- **GIVEN** two entries carrying the same version
- **WHEN** the timeline renders them
- **THEN** both appear

## Requirement: the summary is prose, not markup and not a log excerpt

Each entry's description MUST be the first prose paragraph of its body, with inline markdown
reduced to its text.

### Scenario: the body opens with a fenced block

- **GIVEN** an entry whose body begins with a fenced log excerpt
- **WHEN** the description is taken
- **THEN** it is the first paragraph after the block, not the block's contents

### Scenario: the body opens with a sub-heading

- **GIVEN** an entry whose body begins with `### 修法`
- **WHEN** the description is taken
- **THEN** it is the first paragraph beneath that sub-heading, which is still this entry's
  own text

### Scenario: the body opens with a table or a list

- **GIVEN** an entry whose body begins with a markdown table or a bulleted list
- **WHEN** the description is taken
- **THEN** it is the first paragraph after it, and contains no pipes or bullet markers

### Scenario: a heading that repeats the version above it

- **GIVEN** `## v1.26.98（同版）— 回滾失敗時不要再回報`
- **WHEN** it is parsed
- **THEN** version is `1.26.98` and title is `回滾失敗時不要再回報`, with the marker and its
  separator removed

### Scenario: inline markdown

- **GIVEN** a title or paragraph containing `` `code` ``, `**bold**` or `[text](url)`
- **WHEN** it is rendered
- **THEN** the reader sees the text and none of the syntax

## Requirement: release notes are not served to unauthenticated callers

`GET /api/changelog` MUST sit behind the same auth as the rest of the dashboard API.

### Scenario: no key

- **GIVEN** a request with no API key
- **WHEN** it reaches `/api/changelog`
- **THEN** it is rejected, and no entries are returned

## Requirement: a runtime file read is packaged with the image

Any file the server reads at runtime MUST be present in the container image. A `COPY` line
is only half of that: `.dockerignore` decides what reaches the daemon, and a `COPY` of an
excluded path fails the build outright rather than producing a smaller image.

### Scenario: CHANGELOG.md in the image

- **GIVEN** the Dockerfile
- **WHEN** its COPY lines are read
- **THEN** `CHANGELOG.md` is among them

### Scenario: nothing copied is excluded from the build context

- **GIVEN** every `COPY` in the Dockerfile that reads from the build context
- **WHEN** each source is matched against `.dockerignore`, last rule winning
- **THEN** none of them is excluded

### Scenario: the file is absent anyway

- **GIVEN** a deployment where `CHANGELOG.md` cannot be read
- **WHEN** the module loads
- **THEN** it yields no entries and the process starts normally

## Requirement: the footer carries no copyright line

The footer MUST NOT render a project or copyright label, and no locale file may retain the
key for one.

### Scenario: the footer renders

- **GIVEN** any dashboard page in any of the three locales
- **WHEN** the footer renders
- **THEN** it shows the version and the changelog button, and nothing else
