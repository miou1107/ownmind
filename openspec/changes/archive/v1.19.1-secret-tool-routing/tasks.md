# v1.19.1 — Passwords/tokens not written to memory task list

> Per IR-003 (TDD): write tests before each implementation task.
> Per IR-012 (three quality-gate steps): verify → request review → handle feedback.
> Per IR-008 (commit syncs README/FILELIST/CHANGELOG).

---

## Stage A: Detector pure function + unit tests ✅

- [x] A1. Write test `tests/secret-detect-unit.test.js` (actually 26 cases, with extra coverage of detection order, boundary inputs, return structure)
  - WP Application Password format hit (scenario 1)
  - JWT format hit (scenario 2)
  - GitHub PAT format hit (`ghp_...`, `ghs_...`, `gho_...`, `ghu_...`)
  - AWS Access Key format hit (`AKIA...`)
  - OpenAI API key format hit (`sk-...`)
  - keyword hit: title contains `password`, `token`, `api_key`, `secret` (case-insensitive)
  - keyword hit: description contains Traditional Chinese keywords (`應用程式密碼`, `存取金鑰`)
  - length heuristic: pure alphanumeric ≥20 chars → hit
  - length heuristic: contains Chinese → no hit
  - length heuristic: short string < 20 → no hit
  - bypass: `{ allow_secret_like: true }` → skip all detection
  - `detectSecretLike(null)` / `undefined` → `{ detected: false }` (doesn't throw)
  - return structure: `{ detected: boolean, rule: string, reason: string }`
- [x] A2. New file `src/utils/secret-detect.js` (pure function, no DB dependency)
  - `detectSecretLike(value, { title, description, allow_bypass } = {}): DetectResult`
  - constants section: `SECRET_REGEXES` (5), `SECRET_KEYWORDS` (mixed English/Chinese)
  - detection order: bypass → regex → keyword → length heuristic

---

## Stage B: Memory API wires up the detector ✅

- [x] B1. Write test `tests/memory-secret-guard.test.js` (actually 24 cases)
  - detection hits 4 cases (WP / JWT / keyword:password / heuristic)
  - normal memory passes 4 cases (contains Chinese, iron_rule discussing passwords, principle, narrative regex still blocks)
  - Bypass 3 cases (lint_warning_entry structure, real JWT bypass, no metadata doesn't throw)
  - boundary 3 cases (body structure, empty content, null content)
  - narrative types full coverage 10 cases (5 narrative types × 2 scenarios)
  - **Design adjustment**: use "helper pure-function tests" rather than "full route integration tests", the same pattern as iron-rule-quality.test.js
- [x] B2. New file `src/utils/memory-secret-guard.js`
  - `validateMemoryContent({ type, title, content, metadata })`
  - narrative types (iron_rule / principle / coding_standard / team_standard / session_log) skip keyword, keep regex
  - bypass: metadata.allow_secret_like=true → skip + return lint_warning_entry
  - hit → `{ ok: false, status: 400, body: { error, hint, redirect_tool, detected_by } }`
- [x] B3. detector adds a `skip_keyword` option (v1.19.1 design adjustment)
  - regex changed to non-anchored, using word boundary etc. to catch embedded secrets
  - WP password changed to `{5}` instead of `{5,}` to narrow to exactly 6 groups, reducing false positives
- [x] B4. Change `src/routes/memory.js`
  - POST handler: wire up validateMemoryContent after lintIronRule, before syncToken
  - PUT handler: wire up validateMemoryContent after merged is computed, before UPDATE (only runs when contentChanged)
  - bypass: merge lint_warning_entry into metadata.lint_warnings (keep existing warnings)
  - hit → directly res.status(400).json(body), don't write memory / memory_history
  - skip the __upgrade_test__ prefix (test memories shouldn't be blocked)

---

## Stage C: 500 → 4xx catch-all rework ✅

- [x] C1. Write test `tests/memory-error-classifier.test.js` (actually 21 cases)
  - PG constraint violations 4 cases: 23502 / 23503 / 23505 / 23514
  - PG connection / system errors 3 cases: 08000 / 08006 / ECONNREFUSED
  - JS built-in errors 2 cases: SyntaxError / TypeError
  - boundary 5 cases: null / undefined / string / object with status / unclassified Error
  - return structure 4 cases: error string, logStack, logLevel
  - context parameter 3 cases: create / update / default
- [x] C2. New file `src/utils/memory-error-classifier.js`
  - `classifyMemoryError(err, { context }): { status, body, logLevel, logStack }`
  - PG SQLSTATE classification: 23xxx → 400/409, 22xxx → 400, 08xxx → 503
  - JS SyntaxError → 400, others → 500
  - null/undefined/non-object → 500 fallback, doesn't throw
- [x] C3. Change `src/routes/memory.js` POST + PUT catch
  - POST handler line 1114 catch wires up classifyMemoryError({ context: 'create' })
  - PUT handler line 1326 catch wires up classifyMemoryError({ context: 'update' })
  - log includes error.message + code, 500/503 additionally include stack
  - use classified.logLevel (warn for 4xx, error for 5xx) to avoid noisy 4xx logs

---

## Stage D: MCP tool-description warning ✅

- [x] D1. Write test `tests/mcp-tool-description-secret-warning.test.js` (actually 10 cases, source-level regex verification)
  - ownmind_save: find the description / contains "敏感資料／密碼" / contains "ownmind_set_secret" / warning within the first 80 chars
  - ownmind_update: same 4 cases
  - ownmind_set_secret: find the description / does not contain "請改用 ownmind_set_secret" (avoid the loop)
- [x] D2. Change `mcp/index.js`
  - `ownmind_save` description starts with: "⚠️ 含密碼／token／API key／credential 等敏感資料請改用 ownmind_set_secret、不要寫進記憶（記憶 API 會偵測並擋下、回 400）"
  - `ownmind_update` description same
  - don't touch inputSchema
  - `ownmind_set_secret` description stays as-is (don't add a self-loop warning)

---

## Stage E: add iron rule ✅

- [x] E1. Create **IR-047** (id=436) via the ownmind_save MCP tool:
  - Title: "敏感資料一律走密鑰管理工具、不寫進記憶／對話／程式碼提交"
  - type: `iron_rule`
  - tier: `critical` (set directly, no manual admin UI promotion needed)
  - tags: `trigger:credential`, `trigger:password`, `trigger:secret`, `trigger:api_key`, `trigger:token`
  - 5-section structure (per IR-039 / IR-040):
    - when to trigger (with 4 sensitive-data categories)
    - rules (3 proper channels + 4 things not to do)
    - why (the 2026-05-18 real incident + explanation of the three layers of defense)
    - self-check (anything that must be changed immediately if leaked = a secret)
    - related iron rules (IR-002, IR-041)
  - origin_context auto-attached into metadata (time, confidence, project, git branch, user's original words, related_rules)
  - related_rules: `["IR-002", "IR-041"]`
  - **Design adjustment**: originally planned to create via the admin UI (has an audit log), but ownmind_save already supports the tier parameter + origin_context auto-recording, so it was done in one shot via the MCP tool, with equivalent effect
- [x] E2. SessionStart load verification pending — verify the iron rule appears in the critical group the next time a new session opens (manual acceptance item, left for after stage F release)

---

## Stage F: docs and release

- [ ] F1. Update the `README.md` "Memory vs Secret" section (new section)
  - the decision tree of when to use which tool (plain language)
  - detection-rule summary
  - bypass mechanism explanation
- [ ] F2. Sync `docs/README.zh-TW.md` and `docs/README.ja.md`
- [ ] F3. `CHANGELOG.md` add a v1.19.1 entry
- [ ] F4. `FILELIST.md` add new files:
  - `src/utils/secret-detect.js`
  - `tests/secret-detect-unit.test.js`
  - `tests/memory-api-secret-detect.test.js`
  - `tests/memory-api-error-codes.test.js`
  - `tests/mcp-tool-description-secret-warning.test.js`
- [ ] F5. Sync the version in three places (IR-031): `package.json`, `SERVER_VERSION`, git tag `v1.19.1`
- [ ] F6. Run all tests (`npm test`), confirm 0 failures
- [ ] F7. Three quality-gate steps (IR-012):
  - verification-before-completion (run the verification commands, paste the output)
  - requesting-code-review (request review)
  - receiving-code-review (handle feedback rigorously)
- [ ] F8. Vin's decision → push → deploy prod
- [ ] F9. Browser testing (IR-020): view the new iron rule in the admin UI, actually call `ownmind_save` with a password to confirm it's blocked

---

## Acceptance criteria

- [ ] Reproduce this proposal's 1.1 real incident (use `ownmind_save` to write a memory containing a password) → receive 400 + hint "請改用 ownmind_set_secret"
- [ ] Normal memory (containing Chinese content) is written without error
- [ ] The new iron rule appears in the SessionStart Critical group
- [ ] `ownmind_save` / `ownmind_update` tool descriptions contain the warning
- [ ] DB errors still return 500 (not misclassified as 400)
- [ ] All tests pass, no regression

---

## Non-tasks (handled in v1.19.2)

- ❌ Scanning + redacting passwords that already exist in the memory DB
- ❌ Hook-side reply-lint detecting passwords in AI replies
- ❌ Expanding the detector to more regexes (Slack, Stripe, Discord, etc.)
