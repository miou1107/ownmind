# v1.26.40 — Spec: WP Application Password composition check

> Companion to `proposal.md`. Observable behaviour in GIVEN / WHEN / THEN form.

---

## Requirement 1 — Real application passwords SHALL still be detected

Recall MUST NOT regress. A secret scanner that misses credentials is worse than
one that occasionally over-blocks.

### Scenario 1.1 — a known password

- **GIVEN** the value `iXEN ops5 pJcy 8PJI lVFM heaH`
- **WHEN** it is scanned
- **THEN** the result is detected with rule `regex:wp_application_password`

### Scenario 1.2 — embedded in surrounding text

- **GIVEN** a line reading `the key is iXEN ops5 pJcy 8PJI lVFM heaH, keep it safe`
- **WHEN** it is scanned
- **THEN** the password is detected

### Scenario 1.3 — passwords drawn as WordPress draws them

- **GIVEN** values of 24 characters drawn at random from upper case, lower
  case, and digits, grouped in fours
- **WHEN** a fixed, seeded sample of them is scanned
- **THEN** every one is detected
- **AND** the sample is seeded rather than live-random, because the residual
  miss rate would otherwise turn roughly one run in 784 red against a correct
  implementation

### Scenario 1.4 — the residual miss is known and bounded

- **GIVEN** a legal draw whose six groups all happen to be word-shaped, such as
  `Abcd efgh Ijkl mnop QRST uvwx`
- **WHEN** it is scanned
- **THEN** it is NOT detected
- **AND** this is the accepted trade for removing the false positives: the rate
  is `(3·(26/62)^4)^6 = 6.378 × 10⁻⁷`, about 1 in 1.57 million, against 1.5%
  for the next-best candidate

---

## Requirement 2 — Ordinary prose SHALL NOT be flagged

Six consecutive four-letter words MUST NOT be treated as a credential,
whatever casing the prose uses.

### Scenario 2.1 — the reported sentence

- **GIVEN** a video description containing `we hope that this vlog will help you`
- **WHEN** it is scanned
- **THEN** the rule does not fire

### Scenario 2.2 — other casings

- **GIVEN** `Hope That This Vlog Will Help`, `HOPE THAT THIS VLOG WILL HELP`, or
  `this data came from open only when your team said okay`
- **WHEN** each is scanned
- **THEN** the rule does not fire for any of them

### Scenario 2.3 — a run split across lines

- **GIVEN** four-letter words that span a line break, so the shape matches
  through the newline
- **WHEN** the value is scanned
- **THEN** the rule does not fire

---

## Requirement 3 — Prose SHALL NOT shadow a credential in the same value

Checking only the first shape match MUST NOT be how the rule works. Trading a
false positive for a false negative is a strictly worse outcome.

### Scenario 3.1 — credential separated from prose

- **GIVEN** a value whose first shape match is prose and whose second is a real
  password, with punctuation or a label between them
- **WHEN** it is scanned
- **THEN** the result is detected with rule `regex:wp_application_password`
- **AND** `matched_text` equals the password exactly

### Scenario 3.2 — credential sharing a token run with prose

- **GIVEN** a value where 1 to 7 four-letter words run directly into a
  credential with nothing but single spaces between them
- **WHEN** it is scanned
- **THEN** the credential is detected at every one of those offsets
- **AND** `matched_text` contains the group that proves the value is not prose
- **BUT NOT** necessarily the credential exactly: a window shifted a group or
  two earlier is itself a legal match that passes the composition check, and
  nothing in the text marks where the credential begins. Pointing at the
  evidence is what the report owes the reader

### Scenario 3.3 — the scan considers overlapping windows

- **GIVEN** a contiguous run of four-character tokens longer than six
- **WHEN** an early window is rejected as prose
- **THEN** the scan resumes one character past that window's start, not past
  its end, so windows straddling the boundary are still examined

---

## Requirement 4 — The other detectors SHALL be unaffected

This change MUST stay scoped to one rule.

### Scenario 4.1 — prefixed rules keep working

- **GIVEN** a JWT, a GitHub personal access token, or an AWS access key ID
- **WHEN** each is scanned
- **THEN** each is detected by its own rule as before
