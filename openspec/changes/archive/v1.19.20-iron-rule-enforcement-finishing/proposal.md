# Critical iron-rule enforcement (upgrading the reminder layer to a logic layer) — phased rollout v1.19.20 → v1.19.24

- **Author**: Vin
- **Date**: 2026-05-22 (original) / 2026-05-22 (10 candidates re-set per Gemini adversarial review) / 2026-05-24 (version renumbering: the original v1.19.6 → v1.19.10 were used by other features, changed to v1.19.20 → v1.19.24)
- **Status**: Approved and in progress (v1.19.20 started)
- **Strategy**: split into five sub-versions v1.19.20 ~ v1.19.24, always staying on v1.19.x, not bumping the major version
- **Original spec folder**: originally named `openspec/changes/v1.20-iron-rule-enforcement/`, renamed on 2026-05-24 to `openspec/changes/v1.19.20-rule-enforcer-core/` (i.e. the first sub-version's scope)

---

## 0. One-line summary

Upgrade the 10 most critical iron rules from "reminder" to "enforcement" — on violation the hook directly blocks the action (commit, tool call, reply send), instead of just popping a warning.

> In plain terms: previously an iron rule was "a notice taped to the wall"; the AI could see it and still break it; this version changes it to "electronic access control" that you can't get past on violation. Maps to IR-027 "reminders don't work, only logic does".

---

## 1. Design rationale

### 1.1 The reminder model is proven to fail

Direct observed evidence:

- **v1.19.0 pops 13 reply-lint warnings at startup** (IR-036, IR-037) — the same rule triggers repeatedly within the same session
- **On this session resume, SessionStart showed 8 historical reply-quality warnings at once** — the AI sees the reminder and still violates next time
- The v1.19 iron-rule-tier proposal §1.2 itself uses "alert fatigue" as a design rationale

These are all live samples of IR-027: **reminders didn't block violations, only the user's patience for warnings**.

### 1.2 The hook left by v1.19

The v1.19 proposal explicitly wrote:

> | critical | same as default (**this version doesn't touch enforcement logic**) | direct enforcement: pre-commit blocks commit, PreToolUse blocks tool calls, reply-lint interrupts the reply |

This proposal fills that gap.

### 1.3 OwnMind's differentiated positioning

Other memory systems: "I help you remember things."
OwnMind's memory system after v1.19.20+: "I help you remember rules, and I block violations."

---

## 2. Gemini adversarial review conclusion (2026-05-22)

The original v1.20 proposal listed 10 critical candidates; after a harsh Gemini review, the following adjustments were approved:

### 2.1 Removed (downgraded to warning level)

| Iron rule | Reason for removal |
|---|---|
| **IR-005** no blind edit | MCP is stateless; if the user manually opens a file in the editor without going through the Read interceptor, the AI can't see it → mass false positives block all human-AI collaborative edits |
| **IR-008** commit sync README/FILELIST/CHANGELOG | fixing a typo, changing CSS padding, adding one log line would all require touching the CHANGELOG → the user would stuff junk in or turn off the hook |
| **IR-048** check unapplied migrations before deploy | detection needs to connect to the production DB; when VPN/bastion is down, an emergency fix would die halfway |

These three stay at the "warning layer", handled by the existing verification engine, not on the v1.19.20+ hard block.

### 2.2 Major reordering of the schedule

Original v1.20 schedule: first do the zero-false-positive static checks (IR-009/024), then the high-false-positive regex (IR-002/041).
Gemini's critique: "calm early, then suddenly blocking randomly late" violates the early-defusing principle.

New schedule: **first do the high-false-positive ones that need early polishing, then the zero-false-positive wrap-up**.

---

## 3. Final 10 candidates (per Gemini's "absolutely static + zero/low false positive + catastrophic" principle)

### 3.1 S-tier (absolutely static, zero false positive, catastrophic) — 7

| Number | Iron rule | Main location | Detection logic | False positive |
|---|---|---|---|---|
| **IR-002** | don't commit .env / secrets | pre-commit + PreToolUse | scan staged diff for `.env*` filenames + secret-detect string pattern matching (already in v1.19.1) | low |
| **IR-009** | git contributors = Vin | pre-commit | whether `git config user.name` is Vin | very low |
| **IR-024** | commit has no Co-Authored-By | commit-msg | match message for `Co-Authored-By` | very low |
| **IR-031** | three version numbers in sync | pre-tag | parse package.json / SERVER_VERSION / the tag about to be created | very low |
| **IR-023** | deploy with docker compose build, not docker build | PreToolUse | command pattern matching (contains docker build without compose) | very low |
| **IR-018** | docker build must add --no-cache | PreToolUse | command pattern matching | very low |
| **IR-044** | paramiko sudo must not stdin.write the password | PreToolUse | scan Edit/Write content for `stdin.write` appearing near `sudo -S` | low |

### 3.2 A-tier (command pattern, hit in the field) — 2

| Number | Iron rule | Main location | Detection logic |
|---|---|---|---|
| **IR-043** | Windows AI ssh with password uses paramiko, not sshpass | PreToolUse | command pattern matching |
| **IR-046** | background tasks running over 5 minutes must use nohup | PreToolUse | command pattern matching |

### 3.3 B-tier (high false positive, polish early) — 1

| Number | Iron rule | Main location | Detection logic | False positive |
|---|---|---|---|---|
| **IR-041** | don't collect user privacy (national ID / email / phone) | reply-lint + pre-commit | string pattern matching + user prompt exception (i.e. an email the user themselves mentioned doesn't count) | medium |

### 3.4 Bonus: Reply-lint switched to block mode

The already-effective IR-036 (jargon without plain-language) / IR-037 (mixed Chinese-English) merely had exit code 0 and didn't block; just switch the exit code + add a loop guard (after 3 consecutive blocks, downgrade to warning).

---

## 4. Phased approach (5 sub-versions, v1.19.6 → v1.19.22)

| Spec sub-version | Actual release | Scope | Status |
|---|---|---|---|
| Version 1 | **v1.19.6** | shared decision core `hooks/lib/rule-enforcer.js` + bypass channel `hooks/lib/bypass-handler.js` + audit record extension | ✅ Done 2026-05-22 |
| Version 2 | **v1.19.7** | IR-041 (privacy) + IR-002 (secret into commit) + reply-lint switched to block mode (IR-036 / IR-037) | ✅ Done |
| Version 3 | **v1.19.20** | 5 command-pattern rules: IR-044 / IR-023 / IR-018 / IR-046 / IR-043 | ⏳ To do (this batch first) |
| Version 4 | **v1.19.21** | static-check wrap-up: IR-009 / IR-024 / IR-031 | ⏳ To do |
| Version 5 | **v1.19.22** | two-week observation period, tune rules based on false-positive records | ⏳ To do |

> **Historical context:** originally planned as consecutive numbers v1.19.6-v1.19.10; after the first two versions (v1.19.6 + v1.19.7) were completed as planned, Vin gave the subsequent version numbers to other features (v1.19.8 setup wizard, v1.19.9 password recovery, etc.), and the remaining 3 sub-versions were deferred to start from v1.19.20.

Key principle (adopting Gemini): **the first two versions polish the high-false-positive ones + switch reply-lint to block; the last version does the zero-false-positive wrap-up**. The two-week observation period collects real feedback on "how to tune string-pattern matching", not the false calm of "static checks with zero surprises".

---

## 5. The three enforcement locations

```
┌─────────────────────────────────────────────────────────┐
│ 1. PreToolUse hook (before the AI calls a tool, local)   │
│    Covers: IR-023 / IR-018 / IR-044 / IR-043 / IR-046    │
│    Platform: Claude Code ✓ / Codex ✓ / Cursor ✗ / Gemini ?│
└─────────────────────────────────────────────────────────┘
         ↓ passes
┌─────────────────────────────────────────────────────────┐
│ 2. Reply-lint hook (before the AI sends a reply, local)  │
│    Covers: IR-036 / IR-037 / IR-041                      │
│    Platform: Claude Code ✓ / Codex ✓ / others per vendor │
└─────────────────────────────────────────────────────────┘
         ↓ passes
┌─────────────────────────────────────────────────────────┐
│ 3. Git pre-commit / commit-msg / pre-tag hook            │
│    Covers: IR-002 / IR-009 / IR-024 / IR-031 / IR-041    │
│    Platform: universal across all AI tools (wherever git)│
└─────────────────────────────────────────────────────────┘
```

**Design focus**: the git hook is the **most stable cross-tool enforcement point**. PreToolUse is "blocking at the AI end, preventing in advance"; the git hook is "blocking at the git end, the last-resort line of defense". Both layers are needed.

---

## 6. v1.19.20 scope (this batch: 5 PreToolUse command-pattern rules)

### 6.1 In scope

- **PreToolUse hook integrates rule-enforcer**: connect the already-written `hooks/lib/rule-enforcer.js` from v1.19.6 to the Claude Code / Codex PreToolUse hook (check before the AI calls a tool)
- **5 detectors** (via command string pattern matching):
  - IR-023 deploy with docker compose build, not docker build
  - IR-018 docker build must add --no-cache
  - IR-044 paramiko sudo must not stdin.write the password (leaks downstream)
  - IR-046 background tasks running over 5 minutes must use nohup (detach from session)
  - IR-043 Windows AI ssh with password uses paramiko, not sshpass
- **Tests**: 3-5 cases per detector × 5 + PreToolUse hook integration test

### 6.2 Already done (prior batches, no need to redo)

- ✅ shared decision core `hooks/lib/rule-enforcer.js` (v1.19.6, 36 tests green)
- ✅ bypass channel `hooks/lib/bypass-handler.js` (v1.19.6)
- ✅ audit record extension `shared/compliance.js` (v1.19.6, new action values block / bypass / hook_internal_error)
- ✅ IR-041 privacy detector (v1.19.7)
- ✅ IR-002 secret-into-commit detector (v1.19.7, reuses v1.19.1 secret-detect)
- ✅ reply-lint switched to block mode (v1.19.7, exit 2 + downgrade to warning after 3 consecutive)

### 6.3 Out of scope (handled in later versions)

- ❌ Git pre-commit / commit-msg / pre-tag integrating IR-009 / IR-024 / IR-031 (→ version 4, v1.19.21)
- ❌ Admin UI Bypass record tab (→ version 5, v1.19.22, reassess after the observation period)

---

## 7. Awaiting Vin's decision (decided)

✅ Bypass mechanism: **A. environment variable + audit log** (`OWNMIND_BYPASS=IR-008 git commit ...`)
✅ Reply-lint enforcement mode: **A. hard block (exit 2) makes the AI redo**, downgrade to warning after 3 consecutive blocks
✅ Hook performance SLA: **< 100ms p95**
✅ Existing user upgrade: v1.19.20 is pure infrastructure, doesn't affect existing hooks, no migration needed

---

## 8. Risks and mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Hook false-blocks, deadlocking the workflow | medium | high | bypass mechanism + full audit log + v1.19.21~ phased rollout, two-week observation per version |
| Hook runs slowly, commit becomes hard to use | medium | medium | < 100ms p95 SLA + benchmark + parallel detection |
| Cross-tool inconsistency | high | medium | git pre-commit as the last-resort line (across all tools) + accept "Cursor only goes through the git layer" |
| Reply-lint hard block causes an infinite loop | medium | high | downgrade to warning after 3 consecutive blocks |
| Bypass abuse | high | medium | audit log + later admin UI visualization + weekly review |

---

## 9. Relationship with existing projects

| Item | Relationship |
|---|---|
| v1.19 iron-rule-tier | direct continuation; this proposal is the enforcement-logic implementation of v1.19 |
| v1.19.1 secret-tool-routing | shares `shared/scanners/`; IR-002's pre-commit detection reuses it directly |
| project_373 (v3 route C) | no conflict; route C is iron-rule quality metrics, this proposal is enforcement; same vision, different layer |
| project_342 (LLM iron-rule lint) | no conflict; LLM lint is a default-tier upgrade, not in this proposal |
| IR-027 (reminders don't work) | this proposal is the long-term solution to IR-027 |

---

## 10. One-line positioning

> v1.19 attached tier labels to iron rules. v1.19.20 starts making the labels actually mean something.

Without this version, OwnMind's iron-rule system equals "a notice taped to the wall" — the AI sees it, then violates anyway.
