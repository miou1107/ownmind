# Spec — the window governs everything long, not part of it

## Requirement 1 — the ⚠️ listing obeys the window it already computes

### Scenario: the first command of the hour

- **GIVEN** a command whose trigger matched at least one rule
- **AND** no window is open for that session and trigger
- **THEN** the counts line MUST be printed with the names
- **AND** the ⚠️ listing MUST be printed
- **AND** the window MUST be opened

Unchanged. This is the operation the listing exists for.

### Scenario: the second command of the same hour, same trigger

- **GIVEN** a window already open for that session and trigger
- **WHEN** another command of the same trigger runs
- **THEN** the counts line MUST be printed without names, as before
- **AND** the ⚠️ listing MUST NOT be printed

This is the change. Before it, the listing printed here, in full, every time — measured at nine
rules per `gh issue comment` on a real session with two commands a minute apart.

### Scenario: a different trigger inside the same hour

- **GIVEN** a window open for `send`
- **WHEN** a `commit` runs
- **THEN** `commit` gets its own full listing

Unchanged, and the reason the state key carries the trigger. A window opened by one kind of
operation must not silence a different kind.

### Scenario: nothing matched

- **GIVEN** every category at zero, so the counts line renders empty
- **THEN** nothing is printed
- **AND** the window MUST NOT be opened

Unchanged. Opening a window on an operation that printed nothing spends the hour on a listing
nobody saw.

### Scenario: the server predates `/hook-context`

- **GIVEN** the fallback `/type/iron_rule` response shape
- **THEN** the legacy branch behaves exactly as it does today, window or no window

Deliberately excluded. That branch has no `counts` to store and is the compatibility path for a
server this client can be newer than.

## Requirement 2 — the relayed line tells the model how to present it

### Scenario: any operation that prints a counts line

- **GIVEN** the relay instruction is emitted with the line
- **THEN** it MUST ask for the line to be rendered as an italic blockquote
- **AND** it MUST keep the existing requirements to translate it and preserve the counts and
  version tag verbatim

Measured in the Claude Code renderer: `<sub>` and `<small>` produce nothing, inline code takes a
theme accent colour and reads louder than body text, and blockquote + italic is the one
combination that sits behind the answer.

### Scenario: the throttled one-line form

- **GIVEN** the shortened line that the edit path emits inside an open window
- **THEN** it carries the same presentation instruction

The two forms are the same line to the reader. Only one of them being quiet would read as a
rendering bug.

## Requirement 3 — OwnMind's own words on the edit path are English at the source

### Scenario: the occurrence suffix

- **GIVEN** the throttled edit line
- **THEN** the suffix MUST be English in the source
- **AND** it MUST sit inside the line, before the relay instruction
- **AND** the relay instruction MUST name the occurrence among the parts that survive translation

`· 本小時第 3 次` is appended to a line whose whole point is that the model translates it. Half
of it arriving pre-translated into one specific language is the defect.

Appending it after the instruction is a second defect, and the older one — the instruction names
the counts and the version tag, so a model that follows it drops the occurrence. The occurrence
is what stops a one-line reminder, where a list stood a minute ago, from reading as a breakage.

### Scenario: an English string emitted on its own

- **GIVEN** any path that emits OwnMind's own English words without the counts line
- **THEN** a relay instruction MUST accompany it

There are three: the legacy throttled line, the ⚠️ banner header and footer, and the
state-write failure notice. None is covered by the counts line's instruction, which says "relay
the line above".

This is the half that matters. English at the source is not an improvement on its own — for a
reader who was reading the Chinese, an English string with nothing to translate it is strictly
worse than what it replaced.

### Scenario: the edit banner header and footer

- **GIVEN** the full edit listing
- **THEN** OwnMind's own header and footer text MUST be English in the source

### Scenario: the rule titles inside the banner

- **GIVEN** rules whose titles the user wrote in Chinese
- **THEN** those titles MUST be printed unchanged

User data. The i18n tracks have never covered it and must not start here.

### Scenario: the state-write failure notice

- **GIVEN** `~/.ownmind/state/` cannot be written
- **THEN** the notice MUST be English in the source, and still say what to check
