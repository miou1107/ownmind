# v1.19.14 — Bug report tool task list (v4, after three rounds of adversarial review)

## Scope

### Tables and migration
- [ ] Write `db/0016_create_bug_reports.sql`
  - [ ] `bug_reports` table (incl. device_fingerprint, client_tool columns)
  - [ ] `bug_report_declines` table (cooldown)
  - [ ] 🆕 `bug_report_spam_suspects` table
  - [ ] 🆕 `bug_report_spam_blocks` table (block window)
  - [ ] 🆕 `bug_report_notification_mutes` table
- [ ] 5+ indexes
- [ ] Write down migration
- [ ] migration idempotent

### Shared schema 🆕
- [ ] `shared/context-blob-schema.js` (union type definition `string | TruncatedMessage`)
- [ ] shared by backend, admin, client
- [ ] schema tests

### Backend error fingerprint system
- [ ] `shared/bug-fingerprints.js` (code-level enumeration table)
- [ ] referenced uniformly at business logic block points
- [ ] global 5xx handler uses the `srv_err_<class>` template
- [ ] test: same error produces same fingerprint

### 🆕 Backend spam detector (v4.1 raised thresholds)
- [ ] `src/services/bug-report-spam-detector.js`
  - [ ] Levenshtein distance computation (use an existing lib or write your own)
  - [ ] Rule 1: 5 within 1h + 3 with similarity > 80%
  - [ ] Rule 2: **30 within 24h** (v4.1 raised)
  - [ ] Rule 3: same fingerprint **5 within 1h** (v4.1 raised, since the interface layer blocks 3)
  - [ ] triggered by post-write hook, runs in background, doesn't block creation
  - [ ] writes to the `bug_report_spam_suspects` table
- [ ] test: each of the three rules triggers, similarity algorithm correct
- [ ] **added in v4.1**: POST `/api/bug-reports` middleware adds "same fingerprint 3 within 1h → 429 directly"

### Backend API
- [ ] `src/routes/bug-reports.js` new endpoints:
  - [ ] POST `/api/bug-reports` (create, rate limit + 413 + confirm_string validation)
  - [ ] GET `/api/bug-reports` (user list)
  - [ ] GET `/api/bug-reports?scope=all` (admin)
  - [ ] GET `/api/bug-reports/:id`
  - [ ] PATCH `/api/bug-reports/:id/status`
  - [ ] GET `/api/bug-reports/notifications`
  - [ ] POST `/api/bug-reports/:id/mark-notified`
  - [ ] POST `/api/bug-reports/decline`
  - [ ] 🆕 GET `/api/bug-reports/spam-suspects?status=`
  - [ ] 🆕 POST `/api/bug-reports/spam-suspects/:id/confirm`
  - [ ] 🆕 POST `/api/bug-reports/spam-suspects/:id/dismiss`
  - [ ] 🆕 POST `/api/bug-reports/notifications/mark-all-read`
  - [ ] 🆕 POST `/api/bug-reports/notifications/mute`
- [ ] Middleware:
  - [ ] `bug-report-privacy.js` (forced redaction + fail-closed)
  - [ ] `bug-report-size-limit.js` (1MB)
  - [ ] `bug-report-confirm-string.js` (confirm_string="送出")
  - [ ] 🆕 `bug-report-spam-block-check.js` (don't attach suggest_report during block window)
- [ ] Register in `app.js`
- [ ] **🚫 v3's should-prompt API not done**

### Error response integration
- [ ] `src/utils/error-response.js` helper: `withReportSuggestion(err, fingerprint, userId)`
  - [ ] query `bug_report_spam_blocks`: don't attach flag during block window
  - [ ] query `bug_report_declines`: don't attach flag during cooldown
  - [ ] attach `suggest_report: true` only if both pass
- [ ] `src/routes/memory.js` add flag to blocked write responses
- [ ] global 5xx handler add flag
- [ ] test: spam block, cooldown, normal three cases

### MCP tool
- [ ] `src/mcp-server.js` add `ownmind_report_bug`
- [ ] schema: title / description / severity / component / reproduce_input / context_summary / confirm_string
- [ ] backend auto-fills `context_blob` (OS, Node, client version, client_tool)
- [ ] docs: confirm-string required hint

### Client hook
- [ ] **🆕 `hooks/lib/device-fingerprint.js`** (v4.1: use node-machine-id)
  - [ ] add npm dependency `node-machine-id`
  - [ ] sync-update install/update scripts (IR-042)
  - [ ] call `node-machine-id` to get the OS machine ID
  - [ ] concatenate "OS ID + install path", SHA-256, take first 16 chars
  - [ ] compute on each startup, don't write a file
  - [ ] OS ID unavailable fallback: hostname + install path + `fingerprint_source: "no_machine_id"`
  - [ ] **🚫 cut** v3's cross-platform path + tmpdir fallback logic
  - [ ] **🚫 cut** v4's hostname + MAC logic (unstable in Docker / VPN)
- [ ] `hooks/lib/bug-report-cooldown-client.js` (calls backend decline)
- [ ] `hooks/lib/bug-report-notifications.js`
  - [ ] fetch admin/reporter/both notifications
  - [ ] mark-notified (single)
  - [ ] 🆕 mark-all-read (batch)
  - [ ] 🆕 mute (by fingerprint or own_reports)
- [ ] `hooks/lib/conversation-snippet-truncator.js`
  - [ ] 50 messages / 5KB / 1MB limits
  - [ ] use shared `shared/context-blob-schema.js`
  - [ ] wrap with union type when over
- [ ] SessionStart hook integrate notification display (dual-track)
- [ ] **🚫 cut** v3's `confirm-window.js` hook (can't be done across clients)
- [ ] **🚫 cut** v3's `bug-report-retry-queue.js`

### Connection failure UI
- [ ] AI prompt text template: 「連不上後端、稍後請說『再試一次回報』」
- [ ] **don't rely on** a button, don't write a cache file

### Admin interface
- [ ] `src/public/admin/bug-reports/list.html`
- [ ] `src/public/admin/bug-reports/detail.html`
- [ ] home `/admin` add an "unhandled reports" card
- [ ] 🆕 home add a "suspected spam" card
- [ ] 🆕 `src/public/admin/bug-reports/spam-suspects.html` list page
- [ ] 🆕 spam confirm / dismiss dialog
- [ ] filter / sort / pagination
- [ ] handling status edit area
- [ ] 🆕 notification list batch-read button
- [ ] 🆕 notification mute management page `/admin/notifications/mutes`
- [ ] display correlated `reply-lint-events.jsonl` events
- [ ] **🆕** `context_blob` union type rendering (string vs TruncatedMessage collapsible block)

### Docs
- [ ] `package.json` version 1.19.13 → 1.19.14
- [ ] `src/utils/version.js` `SERVER_VERSION` synced
- [ ] CHANGELOG.md add v1.19.14 section
- [ ] FILELIST.md add new files
- [ ] three-language README (zh-TW / en / ja)
  - [ ] **added in v4.1**: "API integration notes" section, explicitly state `conversation_snippets` is a union type, include JSON Schema example
- [ ] MCP tool list docs updated

### Tests
- [ ] Backend API (`tests/routes/bug-reports.test.js`)
  - [ ] POST / GET / PATCH full suite
  - [ ] permissions, rate limits, 413
  - [ ] notifications three roles
  - [ ] decline + mark-all-read + mute
  - [ ] 🆕 spam-suspects three endpoints
  - [ ] 🆕 error response doesn't attach flag during spam block window
- [ ] Backend error response integration (`tests/utils/error-response.test.js`)
  - [ ] not attached during cooldown
  - [ ] not attached during spam block window
  - [ ] attached only if both pass
- [ ] Backend fingerprint (`tests/shared/bug-fingerprints.test.js`)
- [ ] Backend privacy redaction (`tests/middleware/bug-report-privacy.test.js`)
  - [ ] fail-closed
- [ ] Backend confirm_string (`tests/middleware/bug-report-confirm-string.test.js`)
- [ ] 🆕 Backend spam detection (`tests/services/bug-report-spam-detector.test.js`)
  - [ ] Rule 1: 5 within 1h + similarity > 80%
  - [ ] Rule 2: 10 within 24h
  - [ ] Rule 3: same fingerprint 3 within 1h
  - [ ] Levenshtein algorithm correct
  - [ ] doesn't block creation flow (runs in background)
- [ ] 🆕 Backend union type parsing (`tests/shared/context-blob-schema.test.js`)
- [ ] MCP tool (`tests/mcp/bug-report-tool.test.js`)
- [ ] 🆕 Client machine fingerprint (`tests/hooks/device-fingerprint.test.js`)
  - [ ] same machine same fingerprint (multiple startups)
  - [ ] different OS machine ID different fingerprint
  - [ ] when OS ID unavailable, fallback with `fingerprint_source` marker
  - [ ] stable in Docker / VPN environments (mock node-machine-id)
- [ ] Client cooldown (`tests/hooks/bug-report-cooldown-client.test.js`)
- [ ] Client notification fetch (`tests/hooks/bug-report-notifications.test.js`)
  - [ ] 🆕 mark-all-read
  - [ ] 🆕 mute
- [ ] Client conversation truncation (`tests/hooks/conversation-snippet-truncator.test.js`)
  - [ ] union type produced correctly
- [ ] **🚫 cut** v3's confirm-window tests
- [ ] **🚫 cut** v3's retry queue tests
- [ ] Integration tests
  - [ ] full flow: block → flag → ask → preview → user confirm → MCP call → backend redact → write DB → admin sees → handle → notify
  - [ ] 🆕 spam flow: send 5 similar in a row → auto-mark suspect → admin confirm → that user has no flag for 24h
  - [ ] 🆕 mute flow: user mutes fingerprint → afterward that fingerprint's resolution notifications don't show

### Deploy
- [ ] run `superpowers:verification-before-completion`
- [ ] run `superpowers:requesting-code-review`
- [ ] run prod migration
- [ ] `docker compose build --no-cache` rebuild
- [ ] browser test after deploy
- [ ] confirm cross-tool: send one from Claude Code and Cursor each, admin sees both

## Risk checkpoints

- [ ] regular user hitting `?scope=all` can't get others' data
- [ ] migration run twice doesn't blow up the second time
- [ ] rate limits: create 20/h, decline 50/h, notifications 30/h, PATCH 100/h, mark-all 10/h, mute 30/h
- [ ] after applying `privacy-detect` to conversation snippets, PII is placeholdered
- [ ] fail-closed: privacy redaction crash → 500, don't write DB
- [ ] conversation snippets over 1MB blocked with 413
- [ ] when conversation snippets are truncated, use the union type, both backend + admin can parse
- [ ] missing `confirm_string="送出"` always blocked with 400
- [ ] 🆕 spam detection: 5 similar within 1h auto-marks suspect
- [ ] 🆕 spam detection: 10 within 24h auto-marks suspect
- [ ] 🆕 after spam confirm, that user's error response has no flag for 24h
- [ ] 🆕 spam detection runs in background, doesn't block the create API
- [ ] 🆕 machine fingerprint: same machine multiple startups same value
- [ ] 🆕 machine fingerprint: different machines different values
- [ ] 🆕 machine fingerprint MAC failure fallback, with marker
- [ ] 🆕 batch read: clears all notifications at once
- [ ] 🆕 mute fingerprint: no more same-kind notifications for 30 days
- [ ] 🆕 admin "don't remind me" toggle takes effect
- [ ] can't reach backend: don't write cache, AI uses a text prompt
- [ ] correlated with `reply-lint-events.jsonl` by id
- [ ] three-language docs synced

## Non-tasks

- ❌ semantic detection → next version
- ❌ ML error classification → v2.0+
- ❌ proactive fix suggestion → v2.0+
- ❌ two-way sync with GitHub Issues → v2.0+
- ❌ auto screenshots → privacy risk
- ❌ backend auto-creating drafts → would dirty the DB
- ❌ local persistent retry queue (cut in v3)
- ❌ should-prompt standalone API (cut in v3)
- ❌ **🆕 client confirm-window hook** (cut in v4, can't be done across clients)
- ❌ **🆕 device-id file persistence** (v4 switches to machine fingerprint, computed live)

## Effort estimate (v4)

| Item | v3 | v4 |
|---|---|---|
| Tables + migration (incl. spam suspects + spam blocks + mutes) | 80 | 100 |
| Backend API (incl. spam suspect 3 endpoints + notifications mark-all/mute) | 280 | 350 |
| MCP tool | 80 | 80 |
| Error response integration (spam block + cooldown) | 80 | 100 |
| Backend fingerprint generator | 60 | 60 |
| **🆕 Backend spam detector** | – | 150 |
| Backend privacy forced redaction | 70 | 70 |
| Client hook: notification fetch (batch read + mute) | 100 | 130 |
| Client machine fingerprint | 60 | 30 |
| **🚫 confirm-window hook (cut)** | 150 | 0 |
| Client two-stage confirm preview | 80 | 80 |
| **Shared schema** | – | 30 |
| Admin interface (incl. spam page + mute management) | 600 | 750 |
| Startup notifications (incl. batch read) | 100 | 130 |
| Backend tests (incl. spam + union type) | 350 | 450 |
| Client tests (excl. confirm-window) | 280 | 200 |
| Docs | 150 | 150 |
| openspec | 400 | 400 |
| **Total** | **2,920** | **~3,260** |

Engineering time: **~3.5-4 working days**.
