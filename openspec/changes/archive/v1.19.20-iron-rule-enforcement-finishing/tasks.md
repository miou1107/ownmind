# Critical iron-rule enforcement — task list for 5 sub-versions

> Per IR-003 (TDD): write the test before each implementation task.
> Per IR-012 (the quality gates): verify → request review → handle feedback.
> Per IR-008 (commit syncs README/FILELIST/CHANGELOG).

---

## Progress table (re-planned 2026-05-24)

| Spec sub-version | Actual release | Content | Status |
|---|---|---|---|
| Version 1 | **v1.19.6** | shared decision core + bypass channel + audit extension | ✅ Done 2026-05-22 |
| Version 2 | **v1.19.7** | IR-041 + IR-002 + reply-lint switched to block | ✅ Done |
| Version 3 | **v1.19.20** | 5 command-pattern rules: IR-044/023/018/046/043 | ⏳ To do (this batch) |
| Version 4 | **v1.19.21** | static checks: IR-009/024/031 git hook integration | ⏳ To do |
| Version 5 | **v1.19.22** | two-week observation period + false-positive tuning | ⏳ To do |

> **The original task list below is kept for historical context**; for the actual version mapping use the table above.
> original v1.19.20 = already done in v1.19.6
> original v1.19.21 = already done in v1.19.7
> original v1.19.22 = renumbered to v1.19.20 (this batch)
> original v1.19.23 = renumbered to v1.19.21
> original v1.19.24 = renumbered to v1.19.22

---

## v1.19.20 — shared decision core + bypass channel + audit extension (this batch)

> Pure infrastructure, doesn't block any rule. The goal is to let the later v1.19.21~ hook layers just compose.

- [ ] **A1. Write tests** `tests/rule-enforcer-core.test.js` (estimated 12+ cases)
  - the various branches of `enforceRule(ruleCode, context, options)`
  - rule not in cache → `action: 'allow'`, `reason: 'rule_not_in_cache'`
  - critical rule violated → `action: 'block'`
  - default rule violated → `action: 'warn'`
  - advisory rule violated → `action: 'log_only'`
  - critical rule passes → `action: 'allow'`
  - bypass setting takes effect → `action: 'bypass'`
  - bypass=all → any rule `action: 'bypass'`
  - iron rule has no conditions → `action: 'allow'`, `reason: 'no_conditions'`
  - batch `enforceRules` judges multiple rules independently
  - context missing fields fallback (per verification handler behavior)
  - hook_internal_error fallback: handler throws → fail-open + mark
- [ ] **A2. New file** `hooks/lib/rule-enforcer.js`
  - pure-function entry points `enforceRule` / `enforceRules`
  - internally wraps `evaluateConditions` from `shared/verification.js`
  - decides action by tier: critical → block, default → warn, advisory → log_only
  - bypass set replaces process.env parsing (test-friendly)
- [ ] **B1. Write tests** `tests/bypass-handler.test.js` (estimated 8+ cases)
  - `parseBypass(env)` empty / single / multiple / `all`
  - `isBypassed` hit / miss / null
  - bypass=all covers all rules
  - bypass scope is the process (doesn't modify env when parsing)
  - `logBypass` writes audit, action='bypass'
- [ ] **B2. New file** `hooks/lib/bypass-handler.js`
  - `parseBypass(env): Set<string>` parses the environment variable
  - `isBypassed(ruleCode, bypassSet): boolean`
  - `logBypass({ ruleCode, source, context })` writes audit
- [ ] **C1. Change shared/compliance.js**
  - `appendCompliance` accepts the new `action='block' | 'bypass' | 'hook_internal_error'` values
  - schema unchanged (purely adding legal values), doesn't break existing tests
- [ ] **C2. Add tests** `tests/compliance.test.js`
  - all three new action values can be written and read back
- [ ] **D. Run all tests + the quality gates**
  - `npm test` all green
  - `superpowers:verification-before-completion`
  - `superpowers:requesting-code-review`
- [ ] **E. Docs + version sync**
  - `README.md` Iron Rule Enforcement Engine section adds a v1.19.20 paragraph
  - `docs/README.zh-TW.md` / `docs/README.ja.md` (IR-032 tri-lingual sync)
  - `CHANGELOG.md` v1.19.20 entry
  - `FILELIST.md` adds `hooks/lib/rule-enforcer.js`, `hooks/lib/bypass-handler.js`, new test files
  - three version numbers in sync (IR-031): `package.json` 1.19.5 → 1.19.6
  - prepare to create tag `v1.19.20`

### v1.19.20 acceptance

- [ ] `npm test` 0 failures
- [ ] `enforceRule('IR-002', { stagedFiles: ['.env'] }, { rules: [...] })` returns `action: 'block'`
- [ ] `OWNMIND_BYPASS=IR-002 enforceRule(...)` returns `action: 'bypass'`
- [ ] when the iron-rule cache is empty, `enforceRule` fails open (action: 'allow')
- [ ] no existing hook is broken

---

## v1.19.21 — IR-041 + IR-002 + reply-lint switched to block (next batch)

- [ ] Write the IR-041 privacy detector (national-ID / email / phone patterns + user prompt exception)
- [ ] Write the IR-002 pre-commit integration (using v1.19.1 secret-detect + the new rule-enforcer)
- [ ] reply-lint hook switched to block mode (exit 2) + downgrade to warning after 3 consecutive
- [ ] Two-week observation period, tune rules based on false-positive records

---

## v1.19.22 — 5 command-pattern rules

- [ ] PreToolUse integrates rule-enforcer
- [ ] IR-023 / IR-018 / IR-044 / IR-046 / IR-043 detectors

---

## v1.19.23 — static-check wrap-up

- [ ] IR-009 git user.name check
- [ ] IR-024 commit-msg Co-Authored-By check
- [ ] IR-031 pre-tag three-version-number check

---

## v1.19.24 — observation period + tuning

- [ ] Collect two weeks of false-positive records
- [ ] Tune detector rules based on the bypass audit log
- [ ] Assess whether an admin UI Bypass record tab is needed

---

## Non-tasks (explicitly not done)

- ❌ IR-005 (blind edit) cross-tool tracking — Gemini adversarial review's critique: MCP is stateless, a user manually opening a file causes mass false positives; keep as warning
- ❌ IR-008 (three-doc sync) hard block — Gemini's critique: blocking even a typo fix would force people to bypass; keep as warning
- ❌ IR-048 (pre-deploy DB migration) hard block — Gemini's critique: depending on external state is too fragile; keep as warning
- ❌ Advisory tier logic (v1.21+)
- ❌ Dynamic promotion/demotion (v1.22+)
- ❌ AI-assisted classification
- ❌ per-user custom tiering
- ❌ Cursor PreToolUse enforcement (Cursor has no hook point)

---

## Risk checkpoints (review at the end of each phase)

- [ ] End of v1.19.20: run a dogfood once, commit the v1.19.20 code using rule-enforcer itself, confirm no deadlock
- [ ] End of v1.19.21: run a reply-lint hard block once, confirm the AI can redo correctly
- [ ] End of v1.19.22: run migrate-hooks on another machine, verify the upgrade flow
- [ ] End of v1.19.24: before release, run a full e2e once more, violate each critical rule yourself, confirm all are blocked
