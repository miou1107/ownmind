# Gate/Notice Message Localization (Track A: hook i18n) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user-visible hook message (gate blocks, approval asks, compliance notices) displays in the user's habitual language (zh/en/ja), resolved as: account preference > OS system language > English.

**Architecture:** Tracked per-language JSON dictionaries under `hooks/locales/` + a tiny plain-Node `t()` helper in `hooks/lib/i18n.js`. Locale is provisioned once per session by SessionStart (OS query written to a state file; account preference rides the existing `/api/memory/init` payload into `~/.ownmind/cache/memories.json`); the PreToolUse gate path only reads files, never spawns subprocesses. A new MCP tool `ownmind_set_locale` stores the account preference so "tell the AI once" works across machines.

**Tech Stack:** Plain Node ESM hooks (hooks/package.json is `{"type":"module"}`), existing route-C translate pipeline (`client/src/scripts/translate.mjs`, temperature=0 + glossary + overrides), Express server routes, existing test harness under `tests/`.

**Evidence base (verified 2026-08-14, docs/superpowers/specs/2026-08-14-gate-i18n/evidence.md):** Chinese survives the real hook block channel byte-clean; hook env has LANG/LC_ALL/LC_CTYPE all null (env sniffing is dead) while `defaults read -g AppleLocale` returns `zh_TW`; dictionary load costs 0.45 ms.

**String inventory (authoritative):** `docs/superpowers/specs/2026-08-14-gate-i18n/string-inventory.json` — 81 strings; the 30 with `audience: "user"` are in scope. The 43 model-facing and 8 developer-log strings stay English.

## Global Constraints

- Localize ONLY `audience: "user"` strings from the inventory. Model-facing text (`hookSpecificOutput.reason`, Stop-hook stderr rewrite instructions) and gate-log/audit records stay English (track-B policy).
- Protocol literals are NEVER translated in any language: `go`, `no`, `OK`, `/ownmind-on`, `/ownmind-off`, the `node ~/.ownmind/hooks/lib/approve-action.js …` command, the 6-digit code, `APPROVED`, `REJECTED`, the `[OwnMind]` / `[OwnMind v{version}]` prefix.
- User-authored content is interpolated verbatim, never translated: `guard.title`, `guard.rule_text`, machine-check `reason` strings (they come from the user's own rule data).
- One key per full sentence variant. NEVER build a sentence by concatenating translated fragments (the existing `kindLabel === 'limit'` ternary becomes two complete keys).
- Placeholder syntax: `{name}` (same as client i18n). Placeholders must survive translation unchanged.
- Locale resolution order: account preference (from `~/.ownmind/cache/memories.json`) > OS-detected (from `~/.ownmind/state/locale.json`) > `'en'`. Supported locales: `zh`, `en`, `ja`. Normalization: `/^zh/i → zh`, `/^ja/i → ja`, everything else → `en`.
- The PreToolUse gate path must not spawn subprocesses or hit the network for locale. OS detection happens only in SessionStart provisioning.
- i18n failure must NEVER break a hook: `t()` is a total function (per-key fallback chain locale → en → the key itself; all file reads wrapped in try/catch). A hook that blocked/allowed correctly before must behave identically if every dictionary file is missing.
- Dictionaries are tracked repo files under `hooks/locales/` from day one (untracked-then-tracked stalls `git pull --ff-only` upgrades). Load via `fs.readFileSync(new URL('../locales/<loc>.json', import.meta.url))` — bare JSON `import` and `require()` both fail in the hooks' ESM context.
- The `.sh` twin hooks' inline fallback strings (they fire when node itself cannot run) stay English, with a comment saying why.
- All new code, comments, tests, and commit messages in English (track-B). AI replies to Vin stay Chinese.
- Two pre-existing flaky failures (`bare-mount-trailing-slash` console-routing tests) fail on clean main too — not caused by this branch; do not chase them, do not let a reviewer block on them.
- No version bump, tag, release, or deploy inside any task — release requires Vin's explicit per-instance go (IR-136 equivalent is gated live; expect the deploy gate to intercept docker build commands).

## File Structure

- Create: `hooks/locales/zh.json` (hand-written source of truth), `hooks/locales/en.json` (current English strings verbatim), `hooks/locales/ja.json` (pipeline-generated), `hooks/locales/en.override.json` + `hooks/locales/ja.override.json` (pin exact wordings), `hooks/lib/i18n.js`, `hooks/lib/locale.js`, `hooks/lib/locale-provision.js`
- Modify: `hooks/lib/action-gate.js`, `hooks/lib/action-gate-cli.js`, `hooks/ownmind-iron-rule-check.js`, `hooks/ownmind-reply-lint.js`, `hooks/lib/compliance-step.js`, `hooks/ownmind-session-start.js`, `hooks/ownmind-session-start.sh` (call locale provisioning), `client/src/scripts/translate.mjs` (accept `--dir`), `src/routes/memory.js` (init payload + settings write), `mcp/` (new `ownmind_set_locale` tool), `install.sh` + `scripts/update.sh` (fallback copy globs), `README.md`, `CHANGELOG.md`, `FILELIST.md`
- Test: new files under `tests/` following the existing `action-gate` test suite's harness and naming.

---

### Task 1: Dictionaries + `t()` helper

**Files:**
- Create: `hooks/locales/zh.json`, `hooks/locales/en.json`, `hooks/lib/i18n.js`
- Test: `tests/hook-i18n.test.js` (follow the harness style of the existing action-gate tests in `tests/`)

**Interfaces:**
- Produces: `t(key, params?) → string` and `resetI18nCacheForTests()` from `hooks/lib/i18n.js`; consumes `getLocale()` from `hooks/lib/locale.js` (Task 2) — until Task 2 lands, import from a stub `hooks/lib/locale.js` created here that returns `'en'` (Task 2 replaces its body, keeping the export signature `getLocale({ homeDir? }) → 'zh'|'en'|'ja'`).

- [ ] **Step 1: Write failing tests** — `t()` returns the en string for a known key; returns zh when locale resolves zh; falls back per-key to en when a key is missing from zh.json; returns the key itself when missing everywhere; `{title}`/`{code}` substitution works; unknown placeholders are left as-is; a corrupted/missing dictionary file does not throw (t() still returns something). Use an env/DI seam (`OWNMIND_LOCALE_FORCE` env var honored first in `getLocale`, documented test-only) to pin locales in tests.
- [ ] **Step 2: Run tests, verify they fail** (module not found).
- [ ] **Step 3: Implement** `hooks/lib/i18n.js`:

```js
// hooks/lib/i18n.js — total-function message lookup for hook user notices.
// Model-facing strings stay English by policy; only audience=user strings go through t().
import fs from 'node:fs';
import { getLocale } from './locale.js';

const dictCache = new Map();

function loadDict(locale) {
  if (!dictCache.has(locale)) {
    let dict = null;
    try {
      dict = JSON.parse(fs.readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8'));
    } catch { /* fail open: missing/corrupt dictionary must never break a hook */ }
    dictCache.set(locale, dict);
  }
  return dictCache.get(locale);
}

export function t(key, params = {}) {
  let template;
  for (const locale of [getLocale(), 'en']) {
    const dict = loadDict(locale);
    if (dict && typeof dict[key] === 'string') { template = dict[key]; break; }
  }
  if (template === undefined) template = key;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

export function resetI18nCacheForTests() { dictCache.clear(); }
```

- [ ] **Step 4: Author the dictionaries.** `en.json` = the current English strings from the inventory, verbatim, with the ternary split into two keys. `zh.json` = the Traditional-Chinese versions below (hand-written source of truth). Core keys (exact values; Task 3/4 add the remaining `audience: "user"` inventory entries with the same key style):

```json
{
  "gate.ask.verbal": "[OwnMind] ⛔ \"{title}\" needs your go-ahead for this action. Reply \"go\" to approve it once, or \"no\" to cancel.",
  "gate.ask.code.action": "[OwnMind] ⛔ \"{title}\" wants your approval for: this action. Approval code: {code} (paste it to the AI to allow it once)",
  "gate.ask.code.limit": "[OwnMind] ⛔ \"{title}\" wants your approval for: a command blocked 3 times in a row. Approval code: {code} (paste it to the AI to allow it once)",
  "gate.read.blocked": "[OwnMind] ⛔ blocked until the rule \"{title}\" is read (auto-unblocks on retry)",
  "gate.check.blocked": "[OwnMind] ⛔ blocked: {reason}",
  "gate.failopen": "[OwnMind] the action gate could not run - this command was NOT gated",
  "gate.degraded": "[OwnMind] the action gate could not run in full - receipts unavailable, checks still enforced",
  "lint.recovered": "[OwnMind] compliance checks are running again - this turn was checked"
}
```

```json
{
  "gate.ask.verbal": "[OwnMind] ⛔ 「{title}」這個動作要你點頭才放行。回「go」放行一次、回「no」取消。",
  "gate.ask.code.action": "[OwnMind] ⛔ 「{title}」要你同意這個動作。同意碼：{code}（把它貼給 AI 就放行一次）",
  "gate.ask.code.limit": "[OwnMind] ⛔ 「{title}」連續擋了同一個指令 3 次，要你決定放不放行。同意碼：{code}（把它貼給 AI 就放行一次）",
  "gate.read.blocked": "[OwnMind] ⛔ 先讀過規矩「{title}」才放行（AI 讀完重試就自動解鎖）",
  "gate.check.blocked": "[OwnMind] ⛔ 已擋下：{reason}",
  "gate.failopen": "[OwnMind] 閘門這次沒跑起來，這個指令「沒有」被把關",
  "gate.degraded": "[OwnMind] 閘門部分失效：讀取回執暫時無法使用，指令檢查仍照常把關",
  "lint.recovered": "[OwnMind] 回話檢查已恢復運作，這一輪有檢查到"
}
```

- [ ] **Step 5: Run tests to green, commit** (`feat(i18n): hook message dictionaries + total-function t() helper`).

### Task 2: Locale resolution + SessionStart OS detection

**Files:**
- Create: `hooks/lib/locale.js` (replace Task 1 stub body), `hooks/lib/locale-provision.js`
- Modify: `hooks/ownmind-session-start.js` (call provisioning next to the existing `provisionGateSession` call), `hooks/ownmind-session-start.sh` (invoke `node $LIB_DIR/locale-provision.js` beside the existing `gate-provision.js` invocation, same pre-credential position)
- Test: `tests/hook-locale.test.js`

**Interfaces:**
- Produces: `getLocale({ homeDir? }) → 'zh'|'en'|'ja'` (sync, total, no subprocess); `provisionLocale({ homeDir? })` writing `~/.ownmind/state/locale.json` as `{"detected":"zh_TW","detected_at":"<ISO>"}`.
- Consumes: `~/.ownmind/cache/memories.json` shape `{ sync_token, saved_at, account, data }` where `data.locale` is added by Task 5 (absent until then — resolution must tolerate absence).

- [ ] **Step 1: Write failing tests** for `getLocale` with a temp homeDir: preference `data.locale: "ja"` in a fake memories.json wins; absent preference falls to `state/locale.json` detected `zh_TW` → `zh`; `en-US` → `en`; garbage/missing files → `'en'`; `OWNMIND_LOCALE_FORCE=zh` overrides all (test seam). For `provisionLocale`: writes valid JSON; a throwing detector still writes `{"detected":null,…}` and does not throw.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement.** Resolution: `OWNMIND_LOCALE_FORCE` (if set and supported) → memories cache `data.locale` (if `zh|en|ja`) → normalized `state/locale.json` `detected` → `'en'`. Detection in `locale-provision.js` (SessionStart only): darwin `execFileSync('defaults', ['read','-g','AppleLocale'], {timeout:2000})`; win32 `execFileSync('powershell.exe', ['-NoProfile','-Command','(Get-Culture).Name'], {timeout:5000})`; else `process.env.LANG || process.env.LC_ALL || ''`. Trim, store raw; normalization lives in `locale.js` so a bad raw value can never poison the gate path. Everything try/catch'd; on failure write `detected: null`.
- [ ] **Step 4: Green, commit** (`feat(i18n): locale resolution chain + SessionStart OS-locale provisioning`).

### Task 3: Wire the gate family through `t()`

**Files:**
- Modify: `hooks/lib/action-gate.js` (the `userLine` strings at the verbal-ask, code-ask/limit, read-block, and check-block sites — model-facing `reason` strings on the same branches stay English), `hooks/lib/action-gate-cli.js` (failopen + degraded notices), `hooks/ownmind-iron-rule-check.js` (its two literal duplicates of the same notices)
- Not modified: `hooks/ownmind-iron-rule-check.sh` inline English fallbacks (add the why-comment), `hooks/lib/approve-action.js` (`APPROVED`/`REJECTED` are protocol literals)
- Test: `tests/action-gate-i18n.test.js`

**Interfaces:**
- Consumes: `t()` from Task 1. Keys: exactly the `gate.*` set from Task 1.

- [ ] **Step 1: Write failing tests**: with `OWNMIND_LOCALE_FORCE=zh`, `evaluateGate` block decisions carry the zh userLine with `{title}`/`{code}`/`{reason}` filled (cover all four block kinds + limit variant); with force=en output is byte-identical to the pre-change strings (regression pin — copy expected literals from the inventory); existing gate test suite still green.
- [ ] **Step 2: Run and verify fail.**
- [ ] **Step 3: Replace the literals** with `t('gate.…', { title: guard.title, code, reason: c.reason })`; the `kindLabel` ternary becomes a key choice (`gate.ask.code.limit` vs `gate.ask.code.action`). The three duplicate failopen/degraded literals all become the same two keys.
- [ ] **Step 4: Run the full existing gate suite + new tests to green, commit** (`feat(i18n): gate block/ask/degraded user lines localized`).

### Task 4: Wire the remaining user notices

**Files:**
- Modify: `hooks/ownmind-reply-lint.js`, `hooks/lib/compliance-step.js`, `hooks/ownmind-tty-echo.cjs` (CJS: use `createRequire`/`readFileSync` pattern, not ESM import), `hooks/ownmind-session-start.js` user-facing terminal lines
- Test: `tests/hook-notices-i18n.test.js`

**Interfaces:**
- Consumes: `t()`; adds `lint.*` / `compliance.*` / `session.*` keys to both dictionaries.

- [ ] **Step 1: Enumerate scope from the inventory** (`docs/superpowers/specs/2026-08-14-gate-i18n/string-inventory.json`): every remaining `audience: "user"` entry in these files. Excluded by constraint: `.sh`-only twins, `APPROVED`/`REJECTED`, strings that are themselves protocol tokens.
- [ ] **Step 2: Failing tests** per notice (force zh → zh string; force en → byte-identical regression pin), then implement key-by-key, keeping `[OwnMind v{version}]` prefixes via the `{version}` placeholder.
- [ ] **Step 3: Full hook test suite green, commit** (`feat(i18n): reply-lint/compliance/session user notices localized`).

### Task 5: Account preference — `ownmind_set_locale` end to end

**Files:**
- Modify: `src/routes/memory.js` (GET `/api/memory/init` payload adds `locale` read from `users.settings.locale`, same jsonb pattern as `onboarding_completed_at` at the `jsonb_set` site; add a write path setting/clearing `users.settings.locale`), `mcp/` server (new tool `ownmind_set_locale`, input `{locale: 'zh'|'en'|'ja'|'auto'}` — `auto` deletes the key so OS detection wins; follow the file/registration pattern of the smallest existing tool, e.g. `ownmind_session_off`)
- Test: server route test beside the existing memory-route tests; MCP tool test beside existing MCP tests.

**Interfaces:**
- Produces: init payload field `locale` — which `runConditionalSync` already persists verbatim inside `cache.data` (verified: the whole payload is stored), so `hooks/lib/locale.js` (Task 2) reads it with zero hook-side changes.
- Tool description text: English (MCP descriptions are a later track-A batch).

- [ ] **Step 1: Failing tests**: setting locale writes `users.settings.locale`; init payload echoes it; `auto` removes it; invalid input rejected with a clear error.
- [ ] **Step 2: Implement, green, commit** (`feat(i18n): account locale preference via ownmind_set_locale, riding the init payload`).

### Task 6: Translate pipeline for hook dictionaries (ja)

**Files:**
- Modify: `client/src/scripts/translate.mjs` (accept `--dir <path>` overriding the dictionary directory; default unchanged), root `package.json` (script `"translate:hooks": "cd client && node src/scripts/translate.mjs --dir ../../hooks/locales"`)
- Create: `hooks/locales/ja.json` (pipeline output, committed), `hooks/locales/en.override.json` + `hooks/locales/ja.override.json` (en.override pins every hand-written English string so the pipeline never rewrites them; ja.override empty scaffold with `_comment`)
- Test: `tests/translate-hooks-dir.test.js` (pure-logic parts: `--dir` resolution and override precedence; no live LLM call in tests)

- [ ] **Step 1: Failing test for `--dir` handling**, implement the argv parsing (dictionary dir, cache file, glossary/override paths all resolve relative to the chosen dir; hooks dir gets its own `.translate-cache.json`, gitignored like the client's).
- [ ] **Step 2: Run `npm run translate:hooks` once for real** to produce `ja.json`; eyeball that placeholders and protocol literals (`go`, `no`, `{code}`) survived; commit outputs with a note that ja wording awaits native review (README note in Task 7).
- [ ] **Step 3: Green, commit** (`feat(i18n): translate pipeline --dir support; generated hook ja dictionary`).

### Task 7: Shipping globs + docs

**Files:**
- Modify: `install.sh` (section 4b copy set) and `scripts/update.sh` (section 2 globs) so the `~/.claude/hooks` fallback location also receives `hooks/locales/*.json` and any new `lib/*.js` (they already take lib/*.js); `README.md`, `CHANGELOG.md`, `FILELIST.md` (document the feature, the resolution order, the supported languages, and that ja awaits native review)
- Test: extend whichever existing install-script test covers section 4b copies if one exists; otherwise a shell-level dry-run check listing copied files.

- [ ] **Step 1: Extend the copy globs**, keeping them extension-filtered and non-recursive in style (`$OWNMIND_DIR/hooks/locales/*.json → $HOOK_DIR/locales/`).
- [ ] **Step 2: Docs synced** (per the repo's commit-time README/CHANGELOG/FILELIST rule), full `npm test` green, commit (`feat(i18n): ship hook locale dictionaries to fallback hook dir; docs`).
- [ ] **Step 3: STOP.** No version bump, no tag, no deploy — report to Vin for release QA (the deferred visual check: Chinese in the live gate UI) and his go.

---

## Self-Review Notes

- Spec coverage: user's ask = "blocked/ask messages display in the user's habitual language, not sourced from the dashboard" → Tasks 1–4 (display), Task 2 (OS default), Task 5 ("tell the AI once", cross-machine), Task 6 (ja), Task 7 (ships everywhere + docs). Fallback-to-English for unsupported languages is the resolution chain's default.
- The dashboard localStorage language is deliberately NOT consulted anywhere (Vin's explicit choice).
- Type consistency: `t(key, params)` / `getLocale({homeDir})` / `provisionLocale({homeDir})` are used with these exact signatures in Tasks 2–5.
- Release QA checklist (post-merge, needs Vin): upgrade his install, trigger a gate ask, see Chinese on screen — closes the one unverified link in the evidence chain.
