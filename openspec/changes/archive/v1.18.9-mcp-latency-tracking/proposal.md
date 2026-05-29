# v1.18.9 — latency_ms instrumentation

> **🚫 All "alert" and "tab" features dropped (2026-05-14 part 3):**
>
> This proposal went through three rounds of deprecation; the final v1.18.9 release content is just latency_ms instrumentation:
>
> | Dropped item | Reason | When dropped |
> |---|---|---|
> | block_feedback (false-positive feedback) | The web side requires login, violating the "one click, done in 1 second" decision | part 2 |
> | 4 security alert detectors | Vin: "I don't need this feature" (OwnMind is personal use, ROI is too low) | part 3 |
> | Health tab | Only latency p95 remains, not worth a new tab | part 3 |
>
> **v1.18.9 final release scope:** only MCP API latency_ms instrumentation (Phase A).
> The Phase 2 pure functions already committed in 127b740 (safety-detect / safety-audit + two tests) were all deleted in part 3. Git history is kept as a "once planned" record.
>
> Chapters B / C / Phase 2 / Phase 3 of the proposal are all marked deprecated and kept for history.
>
> ---
>
> **block_feedback feature dropped (2026-05-14 part 2):** The decision designed it as "message-stream markdown link → open browser confirmation page", but hit a wall during implementation:
> - The reply-lint hook cannot sign the sig on the client side (no server secret, no user_id)
> - OwnMind has no cookie/session mechanism (pure Bearer api_key); the web side must log in first to POST
> - "The web page requires login" completely violates the decision's "one click, done in 1 second" UX goal
>
> Vin rejected all three alternatives (pure CLI / link + login / hook waits for server to sign sig), so the entire block_feedback feature was dropped. The server-side code already committed in 8bcfc69 (feedback-sig / block-feedback handler / two routes / two tests) is deleted in the next commit. Git history is kept as an "attempted" record.
>
> **Remaining scope of this proposal:** 4 security alerts + health tab + latency_ms instrumentation. The false-positive-rate metric card (C6) is also removed (no block_feedback event source).
>
> ---
>
> **Version correction (2026-05-14):** Originally named v1.18.5, but v1.18.5/.6/.7/.8 were already taken by the previous 4 hotfixes / observability patches, so this proposal's actual release number is **v1.18.9**. The worktree directory name is kept unchanged (`v1.18.5-block-feedback-and-safety-alerts`) to avoid git path changes.
>
> **Scope expansion (2026-05-14):** Merge in the `latency_ms` instrumentation originally planned for v1.18.6 (a missed item) to ship in this version too.

- **Author**: Vin
- **Date**: 2026-05-13 (proposal) / 2026-05-14 (three deprecations, final v1.18.9 = latency instrumentation)
- **Status**: Scope narrowed to just Phase A latency instrumentation, part 3 wrap-up
- **Worktree**: `determined-bouman-20c22a`
- **Branch**: `vin/determined-bouman-20c22a`

---

## 0. Design rationale

v1.18.4 landed the prototype product-health daily report (route C stage A, looking only at absolute numbers). The next step is to fill the two metrics missing from the Phase 1 MVP:

| Phase 1 MVP metric | Current state | What's missing |
|---|---|---|
| 24h violation rate (B2) | ✅ already has `iron_rule_compliance` event | — |
| MCP API p95 (C4) | ⚠️ partial | add `latency_ms` instrumentation (handled in v1.18.6) |
| **rule-block false-positive rate (C6)** | ❌ not collected at all | **add a "wrongly blocked" feedback mechanism** |
| post-block correction success rate (C8) | ⚠️ SQL too hard | handled in Phase 2 |
| WAU/MAU | ✅ already has activity_logs | — |
| **4 security alerts** | ❌ `usage_audit_log` mechanism exists but 0 detection rules | **add 4 detection rules** |

This proposal handles two things: "rule-block false-positive rate" + "4 security alerts".

---

## 1. Why do this

### 1.1 Rule false-positive rate: no feedback channel, rule design cannot evolve

Current state: when the reply-lint Stop hook (since v1.17.96) or an iron-rule block triggers, the AI only sees a warning, and the user has no way to say "wrongly blocked".

Problems:
- Rules too strict → user silently disables the iron rule or ignores the warning, the product side can't see it
- Gemini r3 review warning: false-positive rate > 30% is the UX Score red-line threshold, and right now we don't even measure it

Design goals:
- When a block happens, the client shows a "wrongly blocked 👎" button (two sources: reply-lint warning + iron-rule block)
- The client sends a false-positive record to the `block_feedback` event (using `activity_logs.event='block_feedback'`, no new table)
- The admin dashboard shows the false-positive rate: `(wrongly-blocked count / total block count) × 100%`

### 1.2 Security alerts: the mechanism exists, 0 detection rules

Current state:
- The `usage_audit_log` table already exists (007 migration)
- The `event_type` column can carry any alert type
- But right now there is **only one event type, `unknown_model`** (written when token pricing doesn't match)
- Real security alerts (memory mis-sync, secret leak, unauthorized access) have **never been detected**

Design goal: 4 alert detection rules, adding hooks on the existing server side:

| Alert | Detection point | Trigger condition |
|---|---|---|
| private memory mis-sync | `GET /api/memory/sync` | returned memory's `user_id` ≠ requester's `user_id` |
| secret leak | when response body is written to logs | log content regex-matched against secrets-table value |
| cross-user unauthorized access | all `/api/memory/*` responses | returned memory.user_id ≠ req.user.id |
| bulk data exfiltration | rate-limit middleware | **per user_id / api_key** (not IP, to avoid NAT-shared false positives) reading > 1000 rows within 1h |

Following the three rounds of Gemini r2 / r3 review suggestions:
- ✅ Use the user_id / api_key dimension, not IP (NAT blind spot)
- ✅ All 4 are `Fatal` level, suspend the affected account immediately on trigger
- ✅ Do not show alert details to the admin (only show user_id + alert type, to prevent privacy reverse-lookup)

---

## 2. In scope vs out of scope

### In scope
- ✅ `block_feedback` event write + client button (reply-lint hook + Claude Code block UI)
- ✅ 4 security-alert detection rules (server-side middleware)
- ✅ Add a "Health" tab to the admin dashboard, showing false-positive rate + security-alert count
- ✅ Auto-suspend account logic after a security alert triggers

### Scope expansion (2026-05-14, merged into v1.18.9)
- ✅ MCP API latency instrumentation (add `latency_ms` to mcp/index.js) — originally planned for v1.18.6 but missed

### Out of scope (handled in v1.19.x+)
- ❌ Phase 2 post-block correction success rate (SQL needs to correlate two events, too hard)
- ❌ Phase 3 frozen 100-iron-rule benchmark
- ❌ Forced red light when rule-effective coverage < 10% (depends on the Veto mechanism; Gemini r3 warned Veto is too strict, a design-layer issue)

---

## 3. Decisions (completed 2026-05-14)

| # | Issue | Decision | Notes |
|---|---|---|---|
| 1 | How to show the "wrongly blocked" button | **markdown link in the message stream → open browser confirmation page** | Vin originally chose "IDE-rendered button", but [project_326](memory) already verified that Claude Code's architecture does not allow the MCP server to render buttons, so it was changed to the equivalent "blue markdown link" approach. Cursor/Gemini/Codex see it directly; in Claude Code the user can manually expand the collapsed card |
| 2 | False-positive feedback form | **web confirmation page (one click to confirm, no form) + CLI in parallel** | The main channel is link → confirmation page; "one click to confirm, done in 1 second" minimizes chatter; the CLI `ownmind report-false-positive --event-id=xxx` is kept for power users / AI agents |
| 3 | After the 4 alerts trigger | **only notify super_admin, do not auto-suspend the account** | Auto-suspend is high-risk and might wrongly lock out one's own user. Look at the data after a month, then decide whether to add auto-suspend |
| 4 | Suspend threshold (bulk data exfiltration) | **per user / api_key reading > 1000 rows within 1h** | A reasonable cap, to avoid AI-agent scripts triggering it accidentally |
| 5 | Rule-block false-positive-rate red-line threshold | **> 30%** | Loose at first; run for 1 month to watch the trend, then adjust |

**Derived design decisions (based on the decisions above):**

- The link URL carries an HMAC signature (to prevent the URL from being hijacked): `https://example.com/ownmind/feedback/block?event_id=xxx&sig=abc123`
- The confirmation page shows only one `[確認擋錯了]` button; pressing it POSTs → shows "已回報", then auto-closes after 1 second. No form, no reason field
- The CLI channel (decision 2, in parallel) goes through the same server endpoint `POST /api/feedback/block`, but uses `Authorization: Bearer ${OWNMIND_API_KEY}` instead of the sig query param

---

## 4. Impact

### 4.1 Client
- `hooks/ownmind-reply-lint.js` adds "wrongly blocked" CLI prompt text
- New mcp tool: `ownmind_report_false_positive(event_id, reason?)`

### 4.2 Server
- New `src/middleware/safety-alerts.js`: 4 alert detection rules
- New `src/routes/block-feedback.js`: receives false-positive reports
- New `src/routes/admin-health.js`: admin dashboard endpoint
- Change `src/routes/memory.js`: sync endpoint adds user_id comparison
- Change `src/public/index.html`: admin web page adds a "Health" tab

### 4.3 Database
- **No new table** (uses existing activity_logs + usage_audit_log)
- No migration needed

---

## 5. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| High mis-click rate on the "wrongly blocked" button, false-positive rate falsely inflated | Medium | Dashboard misleads | Add a reason field, force a short explanation |
| The 4 alerts wrongly lock a user account | Medium | User wrongly locked | Use "notify only, decide manually" (decision 3, option B) |
| Security-alert SQL slows down API response | Low | API p95 rises | Write the audit log async, don't block the main flow |
| User keeps clicking once they see the "wrongly blocked" button | Low | Data pollution | Record only once per user per event within 5 minutes |

---

## 6. Relationship to v1.18.4 / route C

| Stage | Landing version | Content |
|---|---|---|
| Route C stage A | **v1.18.4 done** | Health daily-report SQL prototype, 4 absolute numbers |
| Route C stage A+ | v1.18.5 / .6 / .7 / .8 | sync hotfix + error observability enrichErrorDetails + health daily-report launchd schedule |
| Route C stage B | **this proposal v1.18.9** | Block false-positive feedback + 4 security alerts + latency_ms instrumentation (merging the originally-missed v1.18.6 item) |
| Route C stage C | v1.19.x | After user > 10 and sample > 1000, implement the full composite metrics of the v3 spec |

---

## 7. Next steps after the decision (in progress)

1. ✅ Vin made decisions on the 5 issues (2026-05-14)
2. ✅ Update proposal.md / spec.md / tasks.md to reflect the decisions
3. Follow TDD (per IR-003): write reproduction test → implement → test
4. Browser testing (per IR-020) — the link approach's web confirmation page, security-alert triggering
5. Follow the three quality-gate steps (per IR-012/045) + sync README/FILELIST/CHANGELOG (per IR-008)
6. Tag v1.18.9, push, remind Vin to deploy prod, run two weeks to watch the data
