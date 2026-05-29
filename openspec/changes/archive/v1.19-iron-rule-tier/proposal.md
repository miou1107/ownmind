# v1.19 — Iron-rule tiers (3-tier system: Critical / Default / Advisory)

- **Author**: Vin
- **Date**: 2026-05-14 (proposal)
- **Status**: Design decision completed (2026-05-14), pending implementation
- **Worktree**: `stupefied-vaughan-4650ee`
- **Branch**: `vin/stupefied-vaughan-4650ee`

---

## 0. One-line summary

Divide the current 41 iron rules into three tiers: **Critical (core hard rules, 10) / Default (default rules, ~20) / Advisory (pure reference hints, ~10)**. This version does only the **label layer** — adds a `tier` field, changes the admin UI, changes the SessionStart display grouping, and **does not touch the execution logic**. The execution logic (enforcement) is handled by v1.20.

> In plain terms: this version just attaches an "importance level" label to each iron rule; the AI still follows all rules as before, it just knows which are deadlines and which are suggestions.

---

## 1. Design rationale

### 1.1 The number of rules is approaching the cognitive limit

Current state (2026-05-14 / SessionStart load):

- Iron-rule count: **41** (IR-002 ~ IR-042, with gaps from deprecated ones)
- All loaded into memory at every session start
- Hard for new members (including newly onboarded AI tools) to absorb all of them
- Important rules are diluted by secondary rules

### 1.2 Alert fatigue is already happening

This session start triggered **13** reply-quality warnings (IR-036, IR-037).
Repeatedly triggering the same warning = the reminder mechanism failing, which is exactly the failure mode that IR-027 (reminders don't work, only logic does) warns about.

### 1.3 v1.20 enforcement needs tiers as a prerequisite

Doing enforcement without tiers leads to one of two failure modes:

- **Indiscriminate strictness** → all rules block → the workflow gets blocked so much no one uses it
- **Indiscriminate looseness** → no real enforcement → equivalent to doing nothing

Only the path "enforce Critical, keep the rest as reminders" works, and the prerequisite is to tier them first.

---

## 2. Tier design

### 2.1 Three-tier definitions

| Tier | Chinese | Violation handling (this version) | Violation handling (after v1.20) |
|------|------|------------------|----------------------|
| `critical` | 核心硬規則 | same as default (**this version does not touch execution logic**) | direct enforcement: pre-commit blocks the commit, PreToolUse blocks the tool call, reply-lint interrupts the response |
| `default` | 預設規則 | shows a warning + writes a violation record | shows a warning + writes a violation record (unchanged) |
| `advisory` | 純參考提示 | same as default (**this version does not touch execution logic**) | only writes a record, no warning |

> This version just **plants the seed of tiering**. AI behavior, hook behavior, and reporting behavior are all **identical to v1.18.9**; the only difference is "one extra field at the data layer + one extra field in the admin UI".

### 2.2 Critical list (10, decided)

| Number | Title | Why Critical |
|------|------|----------|
| IR-002 | 不要 commit .env 或密碼 | Security: a leaked password cannot be recovered |
| IR-005 | 不要不確認就改（不要 blind edit） | Quality: editing the wrong place breaks functionality |
| IR-008 | commit 同步更新 README/FILELIST/CHANGELOG | Consistency: docs that don't match code are as good as no docs |
| IR-009 | Git contributors 一律顯示 Vin | Identity: paired with IR-024, a business requirement |
| IR-012 | 品管三步驟（驗證、請評審、處理回饋） | Process: skipping = a half-finished product |
| IR-024 | Git commit 絕對不加 Co-Authored-By | Identity: a business requirement |
| IR-027 | 提醒無效，邏輯才有效 | Meta-rule: the design guiding principle for v1.20 enforcement |
| IR-031 | 發版時 package.json / SERVER_VERSION / git tag 三處版號同步 | Release: a wrong version means users see an old version |
| IR-038 | 修 bug 前必須先確保有觀測資料 | Quality: no observability means blind fixing |
| IR-041 | 不收集使用者隱私 | Privacy: leaked personal data cannot be recovered |

Selection criterion: **a violation causes real loss** (data leak, version chaos, quality regression, release failure, identity misattribution, privacy violation).

### 2.3 Default by default

At migration time **all 41 iron rules default to `default`**; after release, **manually promote these 10 to `critical` via the admin UI**.

Reasons:

- No automatic classification, to avoid the machine misclassifying
- Critical changes are treated as high-risk and must go through the admin audit log
- Run for a week to watch stability, then evaluate the Advisory list

### 2.4 Advisory list (handled in v1.19.1)

After this version's release, **keep all non-Critical as default first**, and run for a week to actually observe which rules are truly just "for reference". The v1.19.1 hotfix then manually demotes them to advisory.

Reason: the cost of mis-tiering is asymmetric — marking a Critical as Default loses one line of defense, but marking a Default as Advisory turns off the defense entirely. Better to be a week slow than to wrongly demote.

---

## 3. In scope vs out of scope

### 3.1 In scope (v1.19)

- ✅ DB migration: add a `tier` field to the `memories` table (default: 'default')
- ✅ Server API: `GET/POST/PUT/PATCH /memory` supports reading/writing the tier field
- ✅ MCP tools: `ownmind_save` / `ownmind_update` accept an optional `tier` parameter
- ✅ Admin UI: the iron-rule list shows the tier and is editable (single-select dropdown)
- ✅ SessionStart display: grouped by tier (Critical bolded at the top, Default in the middle, Advisory collapsed)
- ✅ Compliance event: the violation record carries a `tier` field (for v1.20)
- ✅ Shared helper: add a `getTier(ruleCode)` function to `shared/verification.js`
- ✅ Tests: add 5~8 tests covering the above changes
- ✅ Sync update: README (trilingual), FILELIST, CHANGELOG (IR-008, IR-032)

### 3.2 Out of scope (handled in v1.20)

- ❌ **Alert enforcement**: actually blocking commit / tool call / reply when a Critical is violated
- ❌ **Dynamic adjustment**: e.g. "auto-promote a Default to Critical after N consecutive violations"
- ❌ **AI-assisted classification**: using an LLM to auto-suggest tiers
- ❌ **per-user custom tiering**: each user can override the team default

### 3.3 Out of scope (handled in v1.21)

- ❌ **Splitting memory.js / mcp/index.js** (pure refactor)

### 3.4 Out of scope (never)

- ❌ **Cross-platform tier differentiation**: e.g. "tier=critical on Cursor but tier=advisory on Claude Code" — complexity explosion, and contradicts OwnMind's core vision of "consistent memory across tools"

---

## 4. Impact

### 4.1 Database

| File | Content |
|------|------|
| `db/014_iron_rule_tier.sql` | New migration (ADD COLUMN + INDEX) |

### 4.2 Server

| File | Change |
|------|------|
| `src/routes/memory.js` | POST/PUT/PATCH accept the tier field; GET returns tier; tier can only be set when type='iron_rule' |
| `src/public/index.html` | the iron-rule list adds tier display + an edit dropdown |
| `mcp/index.js` | `ownmind_save` / `ownmind_update` schema adds a tier parameter |

### 4.3 Hook / Client

| File | Change |
|------|------|
| `hooks/ownmind-session-start.js` | iron rules displayed grouped by tier |
| `hooks/ownmind-reply-lint.js` | compliance event carries a `tier` field |
| `shared/verification.js` | add a `getTier(ruleCode)` helper |
| `shared/compliance.js` | the violation object adds a `tier` field |

### 4.4 Tests

New tests (estimated 5~8 files):

- `tests/iron-rule-tier-migration.test.js` — migration doesn't break existing data
- `tests/iron-rule-tier-api.test.js` — reading/writing tier via the API
- `tests/iron-rule-tier-mcp.test.js` — MCP tools support the tier parameter
- `tests/iron-rule-tier-session-start.test.js` — SessionStart grouped display
- `tests/iron-rule-tier-compliance.test.js` — violation event carries tier
- `tests/iron-rule-tier-validation.test.js` — non-iron_rule type cannot set tier
- `tests/iron-rule-tier-default.test.js` — migration defaults existing data to default

### 4.5 Docs

| File | Change |
|------|------|
| `README.md` | the "Iron Rule Enforcement Engine" section adds an explanation of the tier system |
| `docs/README.zh-TW.md` | same, Traditional Chinese version |
| `docs/README.ja.md` | same, Japanese version |
| `CHANGELOG.md` | add a v1.19 entry |
| `FILELIST.md` | add the 014 migration and new test files |

---

## 5. Risks and mitigations

| Risk | Probability | Impact | Mitigation |
|------|------|------|------|
| migration affects the existing 41 iron rules | Very low | Large | pure ADD COLUMN with a default, doesn't change existing data, fully reversible |
| out-of-sync across tools (old clients can't read tier) | Medium | Small | use a `default` fallback when the API returns no tier; the hook also uses a fallback |
| Mis-selection during manual tiering in the admin UI | Medium | Medium | editing the tier writes an audit log (who, when, from what to what); the previous_content mechanism already exists |
| Too few Critical, the safety net is too thin | Low | Medium | filled by the v1.19.1 hotfix; this version is designed to be "strict first, loosen later" |
| Users feel tiering is useless, keep treating all rules the same | Medium | Small | this version just plants a seed, the real effect shows in v1.20; collect data first |

---

## 6. Relationship to existing projects

| Item | Relationship |
|------|------|
| project_373 (OwnMind v3 spec route C) | this version is prerequisite work for "route C stage C" — the tier data is a prerequisite for the 100-iron-rule benchmark |
| project_342 (upgrading iron-rule quality lint to LLM semantic scoring) | no conflict, this version only touches tier, not the content-quality lint |
| IR-027 (reminders don't work, only logic does) | this version is the first step of the long-term solution to IR-027 |
| v1.18.9 (latency instrumentation) | completely independent, no dependency |

---

## 7. Decision record

| # | Issue | Decision (2026-05-14) |
|---|------|--------------------|
| 1 | How many tiers | **3 tiers**: Critical / Default / Advisory |
| 2 | Critical list | **10**: IR-002 / 005 / 008 / 009 / 012 / 024 / 027 / 031 / 038 / 041 |
| 3 | migration default value | **all set to `default`**, admin manually promotes to Critical after release |
| 4 | Advisory list timing | **handled in the v1.19.1 hotfix**, this version keeps all non-Critical as default first |
| 5 | Does this version include execution-logic enforcement | **No**, pure data layer + UI, enforcement waits for v1.20 |

---

## 8. Next steps

1. Write `spec.md` (GIVEN/WHEN/THEN scenarios)
2. Write `tasks.md` (task list)
3. Follow TDD (IR-003): write tests first → run red → implement → run green
4. Three quality-gate steps (IR-012): verification → request review → handle review
5. Sync README / FILELIST / CHANGELOG (IR-008, IR-032)
6. Browser testing (IR-020): the admin UI tier-editing flow
7. Sync the version in three places (IR-031): package.json, SERVER_VERSION, git tag
8. Tag v1.19.0, push (Vin's decision), remind to deploy prod, run a week to watch tier stability
9. v1.19.1: fill in the Advisory list based on observation
