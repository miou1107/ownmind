# v1.19.14 — Bug report tool spec (v4, after three rounds of adversarial review)

> Format: GIVEN / WHEN / THEN.
> v4 changes: cut the confirm-window hook scenarios, add spam detection scenarios, machine fingerprint replaces device id, notification flooding control, union type.

---

## I. Tables

### Scenario 1: migration creates tables

**GIVEN** the v1.19.13 prod database, with no related tables

**WHEN** running `db/0016_create_bug_reports.sql`

**THEN**
- create the `bug_reports` table
- create the `bug_report_declines` table (cooldown)
- 🆕 create the `bug_report_spam_suspects` table
- 🆕 create the `bug_report_notification_mutes` table
- 🆕 create the `bug_report_spam_blocks` table (block window)
- create the necessary indexes
- idempotent on rerun

**`bug_reports` main columns**: see v3, add `device_fingerprint` (replaces device_id), add `client_tool` (which AI tool reported, from MCP metadata).

**🆕 `bug_report_spam_suspects` columns**:

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | bigserial PK | yes | – |
| `user_id` | int FK | yes | – |
| `triggered_at` | timestamptz | yes | – |
| `trigger_rule` | enum | yes | high_volume_1h / high_volume_24h / repeated_fingerprint / similar_content |
| `report_ids` | bigint[] | yes | report ids that triggered this detection |
| `status` | enum | yes | pending / confirmed_spam / dismissed |
| `reviewed_by` | int FK | no | admin |
| `reviewed_at` | timestamptz | no | – |

**🆕 `bug_report_spam_blocks` columns**:

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | bigserial PK | yes | – |
| `user_id` | int FK | yes | – |
| `blocked_at` | timestamptz | yes | – |
| `blocked_until` | timestamptz | yes | default +24h |
| `reason` | text | no | admin fills |
| `blocked_by` | int FK | yes | admin |

**🆕 `bug_report_notification_mutes` columns**:

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | bigserial PK | yes | – |
| `user_id` | int FK | yes | – |
| `mute_target` | enum | yes | fingerprint / own_reports |
| `target_value` | varchar(64) | no | e.g. a specific bug_fingerprint |
| `muted_until` | timestamptz | yes | default +30 days |

---

## II. Backend API

### Scenarios 2-14: create, list, permissions, status transitions, notifications, decline, rate limits

Keep v3 scenarios 2-14, unchanged.

### 🆕 Scenario 15: get spam suspect list (admin)

**GIVEN** admin with `api_key`

**WHEN** GET `/api/bug-reports/spam-suspects?status=pending`

**THEN**
- HTTP 200, returns the list of pending spam suspects
- each includes user_id, trigger_rule, report id array, trigger time
- ordered by triggered_at descending

### 🆕 Scenario 16: admin confirms spam

**GIVEN** admin reviewed suspect id=5 and decides it's spam

**WHEN** POST `/api/bug-reports/spam-suspects/5/confirm` with `{ reason: "AI 腦補垃圾" }`

**THEN**
- HTTP 200
- update `bug_report_spam_suspects.status=confirmed_spam`, record reviewed_by + reviewed_at
- automatically write a row in `bug_report_spam_blocks`: user_id + blocked_until=+24h + reason
- that user's error responses attach no `suggest_report` flag for the next 24 hours

### 🆕 Scenario 17: admin dismisses spam suspect

**GIVEN** admin reviewed suspect id=5 and decides it's not spam

**WHEN** POST `/api/bug-reports/spam-suspects/5/dismiss`

**THEN**
- HTTP 200
- update `bug_report_spam_suspects.status=dismissed`
- don't write `bug_report_spam_blocks`
- that user's behavior is unchanged

### 🆕 Scenario 18: during spam block window, error response has no flag

**GIVEN** a user has an unexpired record in the `bug_report_spam_blocks` table

**WHEN** that user triggers any error (regardless of cooldown state)

**THEN** the error response JSON **does not contain** the `suggest_report` field (spam block takes priority over the cooldown check)

### 🆕 Scenario 19: spam block window expired, behavior restored

**GIVEN** the 24-hour block window has passed

**WHEN** that user triggers an explicit-signal error again

**THEN** the error response attaches the flag per normal logic (subject to cooldown)

### 🆕 Scenario 20: batch mark notifications as read

**GIVEN** a user has 50 unread notifications

**WHEN** POST `/api/bug-reports/notifications/mark-all-read?role=reporter`

**THEN**
- HTTP 200
- all records with `resolved_at IS NOT NULL AND notified_to_reporter=false` set to true
- returns `{ marked_count: 50 }`

### 🆕 Scenario 21: mute notifications for a fingerprint

**GIVEN** a user no longer wants notifications for the `mem_blocked_secret_keyword` fingerprint

**WHEN** POST `/api/bug-reports/notifications/mute` with `{ mute_target: "fingerprint", target_value: "mem_blocked_secret_keyword" }`

**THEN**
- HTTP 201, `bug_report_notification_mutes` adds a row, `muted_until=+30 days`
- for the next 30 days, GET notifications won't return resolution notifications for that fingerprint

### 🆕 Scenario 22: admin sets "don't remind me of my own reports"

**GIVEN** the admin has also sent many reports and doesn't want to flood themselves

**WHEN** POST `/api/bug-reports/notifications/mute` with `{ mute_target: "own_reports" }`

**THEN**
- HTTP 201, adds a mute record
- afterward, on admin startup the admin notifications don't include the admin's "own" reports

---

## III. 🆕 Backend spam detector

### 🆕 Scenario 23: 5 sent within 1 hour + 3 with similar content → auto-mark spam

**GIVEN** user A sent 5 reports in the past 1 hour, of which 3 have (title + description) Levenshtein similarity > 80%

**WHEN** detection triggers after a new write (background task or post-write hook)

**THEN**
- `bug_report_spam_suspects` adds a row, `trigger_rule="similar_content"`, `report_ids=[those 5 ids]`
- the admin home card count +1

### 🆕 Scenario 24: 30 sent within 24 hours → auto-mark spam (v4.1 raised threshold from 10)

**GIVEN** user A sent 30 reports in the past 24 hours

**WHEN** after the 30th write

**THEN**
- add a spam suspect, `trigger_rule="high_volume_24h"`

### 🆕 Scenario 25: same fingerprint 5 within 1 hour → auto-mark (v4.1 raised threshold from 3, since the interface layer already hard-blocks at 3)

**GIVEN** user A sent 5 reports in the past 1 hour all with fingerprint `mem_blocked_secret_keyword` (note: the interface layer 429-blocks at the 3rd, so in practice it's hard to reach 5, but if the interface layer is bypassed it's still detected)

**WHEN** after the 5th write

**THEN**
- add a spam suspect, `trigger_rule="repeated_fingerprint"`, `report_ids` includes these 5

### 🆕 Scenario 25b: same fingerprint, the 3rd within 1 hour → 429 directly (interface-layer hard-block, added in v4.1)

**GIVEN** user A has already sent 2 reports with fingerprint=`mem_blocked_secret_keyword` in the past 1 hour

**WHEN** attempting to POST a 3rd with the same fingerprint

**THEN**
- HTTP 429, message 「同類錯誤回報太頻繁、請稍後再試」
- **does not write** the `bug_reports` table
- **does not trigger** the spam detection flow

### 🆕 Scenario 26: similarity computation

**GIVEN** two reports A, B

**WHEN** the backend computes similarity

**THEN**
- concatenate `title + " " + description`, lowercase, strip extra whitespace
- compute Levenshtein distance / max(lenA, lenB) → take 1 minus it → similarity score
- score ≥ 0.8 is considered similar

### 🆕 Scenario 27: detection itself is rate-limited

**GIVEN** the detector is a post-write hook

**WHEN** each new write triggers detection

**THEN**
- the detection logic itself ≤ 50ms (doesn't block the create flow)
- not on the critical path, a write failure doesn't affect report creation
- compute-intensive work (similarity) runs in background, results written to the spam_suspects table

---

## IV. 🆕 Machine fingerprint (v4.1: OS machine identifier)

### 🆕 Scenario 28: each startup computes the same machine fingerprint

**GIVEN** the same machine, the same OwnMind install path

**WHEN** the OwnMind client starts three times

**THEN**
- each time it calls the `node-machine-id` package to get the OS machine ID:
  - macOS: `IOPlatformUUID`
  - Linux: `/etc/machine-id`
  - Windows: registry `MachineGuid`
- concatenate "OS machine ID + OwnMind install path", SHA-256, take first 16 chars
- all three times get the same fingerprint string
- writes no file

### 🆕 Scenario 29: different machines compute different fingerprints

**GIVEN** two different computers, the same OwnMind account

**WHEN** each starts

**THEN**
- the two machines have different OS machine IDs → the computed fingerprints must differ
- when viewing reports in the admin, can distinguish "Vin reported from Mac" vs "Vin reported from Windows"

### 🆕 Scenario 30: stable in Docker / VPN / VM environments (v4.1 focus)

**GIVEN** OwnMind runs in a Docker container, or with Tailscale VPN enabled (which adds a virtual NIC), or inside a VM

**WHEN** the client starts

**THEN**
- since it uses the OS machine ID (not relying on hostname, not on MAC), even if the container hostname changes or virtual NICs come and go, the fingerprint stays stable
- two reboots (hostname randomly changes, MAC ordering differs) → still the same fingerprint

### 🆕 Scenario 31: fallback when OS machine ID can't be obtained

**GIVEN** a special container config, `/etc/machine-id` doesn't exist, the `node-machine-id` package returns an error

**WHEN** the client tries to generate a fingerprint

**THEN**
- fallback to SHA-256 of "hostname + install path"
- with a `fingerprint_source: "no_machine_id"` marker
- the admin knows this OS provides no stable ID and may be unstable

### 🆕 Scenario 32: copy the OwnMind install to a new machine, fingerprint differs

**GIVEN** the entire OwnMind install directory is copied to a new machine

**WHEN** the new machine starts

**THEN**
- different OS machine ID → fingerprint must differ
- the admin can tell the two machines apart

---

## V. MCP tool `ownmind_report_bug`

### Scenarios 32-35: see v3 scenarios 19-23

Covers create, auto-fill environment, confirm_string validation, two-stage preview, privacy forced redaction fail-closed.

**🚫 v4 cuts v3 scenarios 24-30** (confirm-window hook related): can't be done across clients, the whole layer removed.

---

## VI. Error response integration `suggest_report` flag

### Scenario 36: blocked + outside cooldown + not in spam block window → attach flag

**GIVEN** the user's write is blocked, no decline of that fingerprint in the past 24 hours, not in the spam block window

**WHEN** the backend throws 400

**THEN** the response JSON contains `suggest_report: true` + `bug_fingerprint`

### Scenario 37: during cooldown → no flag

**GIVEN** that fingerprint was declined in the past 24 hours

**WHEN** the backend throws 400

**THEN** the response JSON does not contain `suggest_report`

### 🆕 Scenario 38: during spam block window → no flag (priority over cooldown)

**GIVEN** that user has an unexpired record in `bug_report_spam_blocks`

**WHEN** the backend throws 400 / 5xx

**THEN** the response JSON does not contain `suggest_report`, taking priority over the cooldown check

### Scenario 39: 2xx normal → no flag

Keep v3.

---

## VII. AI auto-fills fields + conversation snippet truncation (union type)

### Scenario 40: AI fills all fields completely

Keep v3.

### Scenario 41: AI can't get a field → placeholder

Keep v3.

### 🆕 Scenario 42: conversation snippet union type (`string | TruncatedMessage`)

**GIVEN** the conversation history contains a 100KB message

**WHEN** the client prepares `context_blob.conversation_snippets`

**THEN** that message becomes:
```json
{
  "truncated": true,
  "original_size": 102400,
  "head": "first 2KB content...",
  "tail": "...last 2KB content"
}
```

while other short messages stay as `string` type. The whole array type is `(string | TruncatedMessage)[]`, shared schema in `shared/context-blob-schema.js`.

### 🆕 Scenario 43: backend parses the union type without crashing

**GIVEN** the `conversation_snippets` the backend receives mixes string and TruncatedMessage

**WHEN** the backend middleware processes (privacy redaction, write to DB)

**THEN**
- judge the type of each message
- string → apply privacy-detect directly
- TruncatedMessage → apply privacy-detect to head + tail separately
- neither crashes

### 🆕 Scenario 44: admin parses the union type, displays to the admin

**GIVEN** the admin reads a report's `conversation_snippets`

**WHEN** the admin interface renders

**THEN**
- string → display directly
- TruncatedMessage → display as a collapsible block: "message truncated (original length 100KB)" + expandable to view head/tail

### Scenario 45: 50 messages + 1MB limit

Keep v3.

---

## VIII. Admin interface

### Scenarios 46-49: list page, detail page, permission block

Keep v3 scenarios 41-44.

### 🆕 Scenario 50: admin home spam suspect card

**GIVEN** the admin opens `/admin`

**WHEN** the page loads

**THEN**
- the home page gets an extra card: 「疑似 spam：N 筆」
- clicking goes to `/admin/bug-reports/spam-suspects?status=pending`

### 🆕 Scenario 51: spam suspect list page

**GIVEN** the admin opens `/admin/bug-reports/spam-suspects`

**WHEN** the page loads

**THEN**
- the table shows: user / triggered_at / trigger_rule / report count
- clicking a user goes to that user's full report list
- each suspect has two buttons: 「確認 spam」 (red), 「正常」 (green)

### 🆕 Scenario 52: admin clicks 「確認 spam」

**GIVEN** the admin clicks the 「確認 spam」 button on suspect id=5

**WHEN** a confirm dialog pops up, enters a block reason, clicks confirm

**THEN**
- call POST `/api/bug-reports/spam-suspects/5/confirm`
- the list refreshes, id=5 disappears from pending
- that user is added to the block window

### 🆕 Scenario 53: notification list adds batch read + mute

**GIVEN** the user sees the notification list on startup

**WHEN** the notification area renders

**THEN**
- a 「全部標已讀」 button at the top of the list
- a 「靜音同類」 link on the right of each notification
- the admin additionally has a 「不提醒我自己」 toggle

---

## IX. Startup notification integration

### Scenarios 54-57: see v3 scenarios 45-48

Dual-track notification display, not shown when there are none.

---

## X. Degradation and failure modes

### Scenario 58: can't reach backend → show error, don't cache

**GIVEN** the client AI calls `ownmind_report_bug`, the backend times out / 5xx

**WHEN** the connection fails

**THEN**
- the client shows: 「目前連不到 OwnMind 後端、回報未送出、請稍後再試」
- **doesn't write** a local cache, **doesn't auto** retry
- the AI prompts the user via text 「需要時請說『再試一次回報』」 (plain text, doesn't rely on a button)

### Scenario 59: notification fetch fails → silently skip

Keep v3.

### 🚫 v4 cuts v3 scenario 51 (confirm-window hook intercepting the AI to show the preview): the whole hook layer is removed, no longer relevant

---

## XI. Privacy boundaries

### Scenarios 60-62: forced middleware redaction, preview full text, can still send with all snippets unchecked

Keep v3 scenarios 52-54.
