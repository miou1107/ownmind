# v1.19 — Iron-rule tier task list

> Per IR-003 (TDD): write tests before each implementation task.
> Per IR-012 (three quality-gate steps): verify → request review → handle feedback.
> Per IR-008 (commit syncs README/FILELIST/CHANGELOG).

> **Execution record (2026-05-14):** Stages A~F are done, code review feedback was received and patched (I-1 ~ I-4, M-1, M-2, M-5). The actual file names differ slightly from the original plan; the list below is aligned with the final implementation.

## Stage A: database layer ✅

- [x] A1. Write `db/014_iron_rule_tier.sql`
  - ADD COLUMN tier VARCHAR(20) DEFAULT 'default' + CHECK ('critical', 'default', 'advisory')
  - CREATE INDEX idx_memories_iron_rule_tier ON memories(tier) WHERE type='iron_rule'
  - Re-run safe (IF NOT EXISTS), the CHECK constraint added via a DO $$ block
- [x] A2. The migration acceptance SQL is written as a trailing comment in the SQL file (run manually, no automated test written, aligned with the existing db/*.sql convention)

## Stage B: Server API ✅

- [x] B1. Write test `tests/iron-rule-tier-validator.test.js` (10 cases)
  - no tier passed is ok (backward compatible)
  - valid tier ok
  - invalid tier returns 400 + lists the valid options
  - setting tier on a non-iron_rule returns 400
  - applyTierDefault fallback logic
- [x] B2. New file `src/utils/iron-rule-tier-validator.js` (pure function)
- [x] B3. Change `src/routes/memory.js`
  - POST receives tier, runs validateTierRequest, writes into INSERT
  - PUT receives tier, uses `oldMemory.type` to prevent bypass, writes into UPDATE
  - PUT memory_history carries `tier_change: { from, to }` (added per review I-1)
  - GET (SELECT *) carries tier automatically
  - /init returns the structured `iron_rules_tier_counts`

## Stage C: MCP tools ✅

- [x] C1. Write test `tests/iron-rule-tier-mcp.test.js` (7 cases, source-level)
  - Note: loading mcp/index.js auto-connects the stdio MCP server and can't be imported directly, so regex source verification is used instead
- [x] C2. Change `mcp/index.js`
  - ownmind_save inputSchema adds tier
  - ownmind_update inputSchema adds tier
  - the two case handlers `if (args.tier !== undefined) body.tier = args.tier`

## Stage D: shared helper ✅

- [x] D1. Write test `tests/iron-rule-tier-helper.test.js` (21 cases)
- [x] D2. New file `shared/iron-rule-tier.js` (pure functions)
  - VALID_TIERS / TIER_EMOJI / TIER_LABEL_ZH / TIER_ORDER constants
  - isValidTier / normalizeTier / getTierFromRules / getTierEmoji / compareTier / groupByTier
  - Note: originally planned in `shared/verification.js`, but made a separate file in implementation to avoid bloating the verification module
- [x] D3. Change `shared/compliance.js`
  - appendCompliance accepts entry.tier (filtered with isValidTier, invalid values dropped)
- [x] D4. Add 3 tier tests to `tests/compliance.test.js`

## Stage E: Hook integration ✅

- [x] E1. Add 3 tests to `tests/session-start-render.test.js`
  - when tier_counts exists, the iron-rule section header adds the distribution
  - without tier_counts (old server), falls back to the old format
  - total of 0 doesn't show a fake count
- [x] E2. New file `src/utils/iron-rule-digest.js` (buildIronRulesDigest + countByTier, 12 cases of tests total)
- [x] E3. Change `hooks/lib/render-session-context.js` to add a tier summary to the iron-rule section header
- [x] E4. Change `src/routes/memory.js` /init to use buildIronRulesDigest instead of inline assembly
- [x] E5. New file `hooks/lib/build-compliance-events.js` + 9 cases of tests
- [x] E6. Change `hooks/ownmind-reply-lint.js`
  - dynamic import getTierFromRules + buildComplianceEvents
  - readIronRulesCache helper (best-effort)
  - after review M-2: dynamic import failure uniformly exits 0, no more inline fallback
- [x] E7. Change `hooks/ownmind-git-post-commit.js`
  - appendCompliance carries the tier field (taken from rule.tier)
- [ ] ~~E8. Change git-pre-commit~~ — that hook doesn't call appendCompliance (only uses blockFailures + console.error), skipped

## Stage F: Admin UI ✅

- [x] F1. Change `src/routes/admin-iron-rule-upgrade.js`
  - /upgrade-status SELECT adds the tier field, returned to the client
- [x] F2. Change `src/public/index.html`
  - the iron-rule upgrade assistant list adds a Tier column
  - dropdown (🔴 Critical / 🟡 Default / ⚪ Advisory) distinguished by background color
  - dropdown change → iruUpdateTier()
  - iruUpdateTier carries prevTier into update_reason (added per review I-3)
- [ ] ~~F3. browser testing~~ — left for Vin to run manually after deploying prod (IR-020), out of scope for this conversation

## Stage G: doc sync (IR-008, IR-032)

- [ ] G1. README.md (English) "Iron Rule Enforcement Engine" section adds an explanation of the tier system
- [ ] G2. docs/README.zh-TW.md sync
- [ ] G3. docs/README.ja.md sync
- [ ] G4. CHANGELOG.md add a v1.19.0 entry
- [ ] G5. FILELIST.md add the 014 migration and new test files
- [ ] G6. Run grep to confirm the tier wording is consistent across the trilingual docs

## Stage H: version sync (IR-031)

- [ ] H1. package.json change version to 1.19.0
- [ ] H2. SERVER_VERSION change to 1.19.0
- [ ] H3. Run `node scripts/check-sync.sh` to confirm the three places match

## Stage I: three quality-gate steps (IR-012, IR-045)

- [ ] I1. Invoke superpowers:verification-before-completion
  - run all tests (npm test)
  - browser-test the admin UI edit flow
  - run the migration on the dev DB, confirm all 41 iron rules have tier=default
  - SQL acceptance: `SELECT tier, COUNT(*) FROM memories WHERE type='iron_rule' GROUP BY tier`
- [ ] I2. Invoke superpowers:requesting-code-review
  - prepare the change list for the reviewer agent (plainly: another AI helps review)
  - confirm all scenarios (the 12 scenarios in spec.md) have corresponding tests
- [ ] I3. Handle review feedback (superpowers:receiving-code-review)
  - write a reproduction test for each critical issue
  - evaluate whether to handle each important issue in this version
  - open a TODO for each minor issue, leave for next time

## Stage J: release

- [ ] J1. Tag v1.19.0
- [ ] J2. push origin (await Vin's decision)
- [ ] J3. Deploy prod (IR-018: docker compose build, --no-cache; IR-023)
- [ ] J4. Browser test after deployment (IR-020)
- [ ] J5. Vin manually promotes the 10 Critical iron rules in the admin UI
- [ ] J6. Run SQL acceptance: `SELECT tier, COUNT(*)`, confirm critical=10, default≈30

## Stage K: post-release tracking (v1.19.1 prep)

- [ ] K1. Run 7 days observing the compliance event distribution
- [ ] K2. Find candidate Advisory rules ("0 violations within 7 days, and communication-style only")
- [ ] K3. The v1.19.1 hotfix batch-demotes the candidate list to advisory
- [ ] K4. Move the v1.19-iron-rule-tier proposal to `openspec/changes/archive/` (using git mv per CONVENTIONS.md item 3)

## Stage L: move into archive (after release)

- [ ] L1. Confirm CHANGELOG.md already has a v1.19.0 entry
- [ ] L2. Use `git mv openspec/changes/v1.19-iron-rule-tier openspec/changes/archive/`
- [ ] L3. Run grep to confirm external references are updated (CONVENTIONS.md item 5 verification flow)
- [ ] L4. commit

---

## Estimated scale

| Stage | Estimated PRs | Estimated time |
|------|------------|----------|
| A~D data layer + API + MCP + helper | 1 | half a day |
| E hook integration | 1 | half a day |
| F admin UI | 1 | half a day |
| G~H docs + version | 1 | 1~2 hours |
| I quality gates | (along with the PRs above) | 1~2 hours |
| J release | — | 30 minutes |
| K tracking + L archive | 1 (v1.19.1) | after 1 week |

**Total:** 4 PRs, about 2~3 working days (excluding the 7-day observation period in stage K).
