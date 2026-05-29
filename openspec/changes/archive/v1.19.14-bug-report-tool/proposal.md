# v1.19.14 — Bug report tool (user ⇄ developer two-way notification)

- **Author**: Vin
- **Date**: 2026-05-24 (v1 → v4, through three rounds of Gemini adversarial review)
- **Status**: v4 decided, awaiting implementation
- **Estimated version**: v1.19.14

---

## 0. One-line summary

Let users report to the developer in a consistent way when OwnMind misbehaves or has an unreasonable design; once the developer resolves the report, the reporter also gets notified.

> Plain version: previously when a user felt "why is OwnMind blocking something it shouldn't?" there was nowhere to raise it, only verbally to Vin; this version builds a formal channel, AI proactive detection + two-way notification.

---

## 1. Design rationale

### 1.1 Current gap

OwnMind currently **has no** dedicated channel for "users reporting program bugs or design problems":

| Existing mechanism | Purpose | Why it's insufficient |
|---|---|---|
| `ownmind_report_compliance` | record iron-rule compliance | wrong semantics, not bug reporting |
| `ownmind_save` type=project | record project todos | mixed semantics |
| verbally telling Vin | – | not scalable across many people, no record, no progress tracking |
| GitHub Issues | – | no user accounts set up, external users can't report directly |

Real incident: a user writing project memory got blocked by a "secret-scan false positive"; currently Vin records it himself + opens a patch, other users have no such path.

### 1.2 Why now

- v1.19.11's landed `reply-lint-events.jsonl` is the data foundation for bug reporting, but lacks the "user explicitly says 'this is a bug'" layer
- the OwnMind repo is now public, there will be more users in the future, the verbal channel doesn't scale

---

## 2. Design scope (v4 — re-set through three rounds of adversarial review)

### 2.1 Proactive detection scope

**First phase only handles explicit signals**:

- tool call blocked (e.g. `ownmind_save` returns 400 「敏感資料」)
- tool call errors (e.g. 5xx, connection failure, timeout)

**Next phase**:

- semantic detection (judging from the tone of a user's complaint) → easily misjudged, not done in this version

### 2.2 Storage location

**Sent to the central server**, with a user preview confirmation before sending.

### 2.3 Attached data and query permissions

**Report data attaches by default**:

- the surrounding conversation snippets that triggered the report (forced through middleware redaction, see 2.10)
- environment info (OS, AI tool version, OwnMind version)
- current project path (path only, no content)
- trigger time + reporter identifier + source machine fingerprint (see 2.6)

**Query permissions**:

- regular user: sees only their own reports
- admin (admin level and above): sees all reports

### 2.4 Relationship with the reply-quality log file

Both kept, referenced by id, not stored twice. Report data carries `related_lint_event_ids` (array).

### 2.5 Cross-AI-tool trigger mechanism (v4: accept imperfection + backend spam protection)

**v3 design flaw (pointed out in round three by Gemini)**: the client `confirm-window hook` needs transcript monitoring + pre-tool interception, fully available only in Claude Code; OwnMind also supports Cursor, Codex, Windsurf, Copilot, OpenCode, Gemini CLI, etc., and other clients can't do it.

**v4 changes to "accept imperfection + backend spam protection"**:

#### Layer 1 (backend `confirm_string` gatekeeper)

- AI calling `ownmind_report_bug` must provide `confirm_string="送出"`
- absent or not equal to 「送出」 → reject 400
- **acknowledged** the AI might hallucinate filling in 「送出」, don't expect this layer to be 100% effective

#### Layer 2 (interface layer hard-blocks repeated same-fingerprint sends) — added in v4.1

- POST `/api/bug-reports` adds "same user + same bug_fingerprint ≥ 3 within the past 1 hour" → HTTP 429 directly
- no record written, no spam detection started, rejected outright
- blocks 99% of "AI hallucinating the same error and spamming"

#### Layer 3 (backend spam detection + auto degrade) — v4.1 raised the thresholds

The backend continuously analyzes each user's reporting pattern and auto-marks spam suspects:

| Trigger condition | Action |
|---|---|
| same user sent ≥ 5 in the past 1 hour, of which ≥ 3 have content similarity > 80% | mark `spam_suspect_auto` |
| same user sent ≥ **30** in the past 24 hours (v4.1 raised from 10; the original value misjudged normal developers) | mark `spam_suspect_auto` |
| same user + same bug_fingerprint sent ≥ **5** within 1 hour (v4.1 raised from 3, since the interface layer already hard-blocks at 3) | mark `spam_suspect_auto` |

**Similarity algorithm**: concatenate title + description, compute Levenshtein distance, convert to a 0-1 similarity score.

**spam suspect consequences**:

- the admin home page shows 「N 筆疑似 spam」, admin can click in to view
- admin one-click "confirm spam" → backend enables a 24-hour `suggest_report` flag block on that user, client error responses no longer attach the flag
- admin one-click "normal" → revoke the spam_suspect mark, keep watching

#### Explicit manual entry (always kept)

The user can run `/ownmind report` anytime to report proactively, bypassing auto-detection and the cooldown.

### 2.6 Reporter identity (v4.1: switch to OS machine identifier)

**v3 design flaw**: device-id written to tmpdir gets cleared.
**v4 design flaw (pointed out in round four by Gemini)**: using hostname + primary NIC MAC changes frequently in Docker / VPN / VM environments (the in-container hostname is a random container ID, virtual NICs make MAC ordering unstable), the fingerprint changes daily, notification muting and the cooldown break.

**v4.1 changes to "OS-level machine identifier"**:

- use the npm package `node-machine-id` to get the stable ID the OS provides:
  - macOS: `IOPlatformUUID` (system permanent ID)
  - Linux: `/etc/machine-id` (set on first boot, unchanged after)
  - Windows: registry `MachineGuid`
- these values are OS-managed, stable across reboots, unaffected by NIC or hostname changes
- then concatenate "OwnMind install path" and SHA-256 → distinguish different installs on the same machine
- take the first 16 chars of SHA-256 as `device_fingerprint`
- computed fresh on each startup, not written to a file
- when the OS ID can't be obtained (very rare, special container config) → fallback to hostname + install path + `fingerprint_source: "no_machine_id"` marker

`api_key` identifies "who", `device_fingerprint` identifies "the source machine".

**Requires adding npm dependency `node-machine-id`**, and per iron rule, sync-update the install/update scripts (IR-042).

### 2.7 Cooldown (integrated into the original error response, backend inline query)

Keep the v3 design:

1. when throwing 400 / 5xx, the backend inline-queries the `bug_report_declines` table
2. a decline record for that user against that fingerprint exists within the past 24 hours → **don't attach** the `suggest_report` flag
3. doesn't exist and not in the spam block window → attach `suggest_report: true` + `bug_fingerprint`

Writing a decline is still a separate API: `POST /api/bug-reports/decline`.

### 2.8 Notification pileup and flooding control (v4 added control mechanism)

**v3 design flaw (pointed out in round three by Gemini)**: when an admin is also a reporter, notifications pile up infinitely and flood, and there's no batch-handling mechanism.

**v4 changes to**:

- admin startup: "N unhandled reports" + a list of the latest 10 + a **"mark all as viewed" button**
- reporter startup: "M of your reports resolved" + the latest 10 + a **"mark all read" button**
- each notification gets a "mute this kind" link (targeting bug_fingerprint):
  - click → that user no longer receives "same fingerprint" notifications for 30 days
  - written to the `bug_report_notification_mutes` table
- **extra admin setting**: a "don't remind me of my own reports" toggle (avoid self-flooding)

### 2.9 Error fingerprint generation (unified on backend)

Keep v3: the enumeration table is maintained at the backend code level, the client doesn't participate in parsing.

| Source | Format | Example |
|---|---|---|
| business logic block | `<business code>_<situation>` | `mem_blocked_secret_keyword` |
| 5xx | `srv_err_<error class>` | `srv_err_db_connection` |
| client error | `clt_<situation>` | `clt_invalid_payload` |

### 2.10 Privacy forced redaction (done on backend, fail-closed)

Keep v3:

- `shared/privacy-detect.js` middleware enforces it
- email / national ID / phone → placeholder
- **fail-closed**: redaction crashes → 500, don't write DB

### 2.11 Required fields + conversation snippet size limit + JSON union type (v4 completion, v4.1 doc reinforcement)

**v3 design flaw (pointed out in round three by Gemini)**: JSON structural truncation turns a single message from `string` into `object`; a front/back mismatch crashes.

**v4 solution**:

- the `context_blob.conversation_snippets` field is explicitly defined as a `(string | TruncatedMessage)[]` union type
- `TruncatedMessage` schema: `{ truncated: true, original_size: number, head: string, tail: string }`
- both the backend and admin parsers explicitly handle the two types
- client, backend, and admin share one schema definition (`shared/context-blob-schema.js`)

**v4.1 reinforcement**: advanced users writing a custom MCP client (especially integrating in strongly-typed languages like Go / Rust) need the README API integration section to clearly state the union type, otherwise deserialization fails:

- add an "API integration notes" section to the README, explicitly stating `conversation_snippets` is a `(string | TruncatedMessage)[]` union type
- include a JSON Schema example
- sync across the three languages

**Size limits**:

- client truncates first: 50 messages, 5KB each, 1MB total
- over the count: keep "the last 49 + the 1st", replace the middle with `{ truncated_messages: N, summary: "已省略 N 條" }`
- over per-message: wrap with `{ truncated: true, original_size, head, tail }`
- backend re-validates 1MB again (double safety)

### 2.12 API rate limits

Keep v3:

| API | Limit |
|---|---|
| POST `/api/bug-reports` | 20 / hour / user |
| POST `/api/bug-reports/decline` | 50 / hour / user |
| GET `/api/bug-reports/notifications` | 30 / hour / user |
| PATCH `/api/bug-reports/:id/status` | 100 / hour / admin |
| POST `/api/bug-reports/notifications/mark-all-read` | 10 / hour / user |
| POST `/api/bug-reports/notifications/mute` | 30 / hour / user |

### 2.13 Out of scope

- ❌ Local persistent retry queue (cut in v3)
- ❌ should-prompt standalone API (cut in v3)
- ❌ Client confirm-window hook (cut in v4, can't be done across clients)
- ❌ device-id file persistence (v4 switches to machine fingerprint, computed live)
- ❌ Auto-filled fix suggestions (v2.0+)
- ❌ Two-way sync with GitHub Issues (v2.0+)
- ❌ Auto screenshots (privacy risk)

---

## 3. Effort estimate (v4)

| Item | v3 | v4 |
|---|---|---|
| Tables + migration (incl. mutes table) | 80 | 100 |
| Backend API (incl. spam suspect API) | 280 | 350 |
| MCP tool | 80 | 80 |
| Error response integration (incl. spam block + cooldown inline) | 80 | 100 |
| Backend fingerprint generator | 60 | 60 |
| **🆕 Backend spam detector** | – | 150 |
| Backend privacy forced redaction (incl. fail-closed) | 70 | 70 |
| Client hook: notification fetch (incl. batch read + mute) | 100 | 130 |
| Client machine fingerprint (replaces device id) | 60 | 30 |
| **🚫 Client confirm-window hook (cut in v4)** | 150 | 0 |
| Client two-stage confirm preview | 80 | 80 |
| **Shared context_blob schema (new in v4)** | – | 30 |
| Admin interface (incl. spam suspect page + mute management) | 600 | 750 |
| Startup notifications (incl. batch-read button) | 100 | 130 |
| Backend tests (incl. spam detection + union type) | 350 | 450 |
| Client tests (excl. confirm-window) | 280 | 200 |
| Docs | 150 | 150 |
| openspec | 400 | 400 |
| **Total** | **2,920** | **~3,260** |

Engineering time: **~3.5-4 working days**.

> v4 is slightly more than v3: cut the confirm-window hook (-150) but added spam protection (+150) + admin spam page (+150) + mute control (+80) + shared union-type schema (+30) + test reinforcement (+100), net +340.

---

## 4. Risk checkpoints

- [ ] migration is idempotent on rerun
- [ ] backend API full test suite green
- [ ] MCP tool `ownmind_report_bug` can be called successfully from Claude Code, Cursor, Codex each
- [ ] a regular user with their own key can't see others' reports
- [ ] admin can see all reports
- [ ] `suggest_report` flag: attached outside cooldown, not attached during cooldown
- [ ] `suggest_report` flag: not attached during the spam block window
- [ ] cross-device cooldown sync
- [ ] startup notifications dual-track (admin + reporter)
- [ ] **🆕 spam detection**: 5 within 1 hour + 3 with similarity > 80% auto-marks suspect
- [ ] **🆕 spam confirm**: after admin clicks "confirm spam", that user gets no flag for 24h
- [ ] **🆕 notification batch read**: after clicking the button, that user's notifications all clear
- [ ] **🆕 notification mute**: after clicking mute, same fingerprint no longer notifies for 30 days
- [ ] **🆕 admin "don't remind me"**: after the admin toggle, no notifications for the admin's own reports
- [ ] **🆕 machine fingerprint stable**: multiple startups on the same machine compute the same value
- [ ] **🆕 machine fingerprint differs**: different machines compute different values
- [ ] **🆕 context_blob union type**: both backend and admin can parse `string` and `TruncatedMessage`
- [ ] conversation snippets over 1MB blocked with 413
- [ ] conversation snippet PII redacted before writing
- [ ] privacy redaction crash is fail-closed (500, don't write DB)
- [ ] missing `confirm_string="送出"` always blocked with 400
- [ ] correlated with `reply-lint-events.jsonl` by id
- [ ] can't reach backend: don't write a cache, show a "retry later" message
- [ ] three-language docs synced
