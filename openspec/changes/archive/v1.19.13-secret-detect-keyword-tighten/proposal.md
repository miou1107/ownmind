# v1.19.13 — Tighten secret-scan keyword detection, reduce false positives

- **Author**: Vin
- **Date**: 2026-05-24
- **Status**: Awaiting Vin's decision
- **Branch**: TBD (follow the main workflow, commit after TDD is complete)

---

## 0. One-line summary

Change the value-side keyword detection in `shared/secret-detect.js` (plain language: scanning the content for words like "password / token / secret") from "**block on any appearance**" to "**only block when it appears in a KEY: VALUE or KEY=VALUE pattern and the VALUE looks like a value**", and along the way add `matched_text` to the 400 response (plain language: which segment triggered it), so the AI can fix it correctly on the first try instead of needing 3 attempts.

> Why: maps to project 469 "OwnMind content secret-scan false-positive improvement"; by 2026-05-23 there were 3 consecutive false blocks recorded, plus a 4th on 2026-05-24, triggering the project's "if the same content is blocked 3 times in a row, start work" condition.

---

## 1. Design rationale

### 1.1 Real incident (2026-05-23 → 2026-05-24)

The AI tried to save a type=`env` memory "bot.example.com 遠端訪問方式總覽", whose content contained:

- AnyDesk connection number `123456789` (public info, not a password)
- Tailscale private-network address `100.64.0.1` (plain language: a virtual address only visible on the company intranet)
- The secret **name** string `anydesk.bot_example.unattended_password` (plain language: "the name of the key" rather than the key itself; the real key is in the OwnMind secret manager)

The API returned 400 "偵測到此內容看起來是敏感資料（密碼／token／API key）" 3 times in a row, and blocked a 4th time (2026-05-24). Vin assessed "it seems too easy to block" and wanted it fixed.

### 1.2 Root cause: which logic actually blocked it?

Stepping through `detectSecretLike()` one step at a time:

| Step | Result |
|------|------|
| The 7 regexes (WP / JWT / GH PAT / AWS / OpenAI / OwnMind reserved key / default password literal) | **None matched** |
| Title / description keyword | No match (the title is just "bot.example.com 遠端訪問方式總覽", no password wording) |
| **Value keyword scan** | **Matched `keyword:password`** — the `anydesk.bot_example.unattended_password` in the value contains the word `password` |
| Length heuristic | Not reached |

`type=env` is not in the "skip keyword detection" whitelist (the whitelist only contains narrative types like iron_rule, principle, coding_standard, team_standard, session_log, standard_detail, project, portfolio), so the keyword check ran the whole way and blocked it.

### 1.3 Why the previously planned whitelist approach missed

Project 469 planned three whitelists:

| Planned whitelist | Was it actually this incident's trigger? |
|---|---|
| CGNAT private IP range (100.64-127.x.x) | ❌ No — the IP is only 12 chars, the length heuristic needs ≥ 20, it never reached the heuristic step |
| 9-10 digit pure numbers (AnyDesk ID pattern) | ❌ No — same reason, not long enough |
| Dot-separated reference containing a password/token identifier | ✅ Yes — the real culprit |

Adding IP / pure-number whitelists won't solve the current false positive (because neither of those was blocked in the first place), it just guards against a nonexistent future problem. **This counts as a planning miss, and this proposal refocuses.**

### 1.4 Why the keyword logic is changed this way

Current state: if the value contains any of `password / passwd / token / api_key / apikey / secret / credential / bearer`, it's treated as sensitive.

Problem: everyday documents, explanations, and references (plain language: descriptions pointing to where the real key is stored) mention these words heavily, leading to a high false-positive rate.

New rule: value-side keyword detection **only matches in one of these two situations**:

1. **Assignment pattern**: `<keyword>` followed by `:` or `=` or `=>`, then something "that looks like a value" (length ≥ 8)
2. **Literal key** (already caught via regex) — not handled at the keyword layer

If the assignment pattern isn't satisfied, pass it, with the other detections (regex, length heuristic) as a backstop.

> **Design decision — don't add a "the value isn't a common English phrase" condition**: an early draft considered adding another "the value doesn't look like an English phrase" filter (to avoid false positives like `password: hello world this is fine`), but it's too brittle in implementation (you'd have to maintain a list of common English phrases), and the existing constraint of "value ≥ 8 chars and contains no whitespace / quotes / commas / semicolons" already filters out most short sentences, so it's not a must-have. The shipped version of this proposal doesn't include this condition, left in the backlog.

> The title / description keyword scan **keeps the original "match on appearance" logic**, unchanged. Reason: the title/description is a summary of "what this memory is about", so password wording appearing there means the memory's topic involves something sensitive, and being conservative is reasonable; the narrative types already have a `skip_keyword` opt-in exception.

---

## 2. Design

### 2.1 Change the value-side keyword logic in `shared/secret-detect.js`

```js
// before:
const valueLower = value.toLowerCase();
for (const keyword of SECRET_KEYWORDS_EN) {
  if (valueLower.includes(keyword)) {
    return { detected: true, rule: `keyword:${keyword}`, ... };
  }
}

// after: only match on assignment pattern
const ASSIGNMENT_REGEX =
  /\b(password|passwd|token|api[_\- ]?key|apikey|secret|credential|bearer)\s*[:=]\s*["']?([^\s"'`,;]{8,})["']?/i;
const match = value.match(ASSIGNMENT_REGEX);
if (match) {
  return {
    detected: true,
    rule: `keyword:${match[1].toLowerCase().replace(/[-_ ]/g, '_')}`,
    reason: `value 含 ${match[1]} 賦值樣式（值長度 ${match[2].length}）`,
    matched_text: match[0].slice(0, 80),  // truncate to 80 chars, show the AI which segment triggered
  };
}
```

### 2.2 Add `matched_text` to the detection return body

When detected=true, `detectSecretLike()` additionally returns `matched_text`:

- Regex match → `match[0]` truncated to 80 chars
- Keyword match → the assignment fragment truncated to 80 chars
- Length heuristic → the first 80 chars of value

Reason for the length truncation: avoid echoing a whole real key back into the log or console, preventing sensitive data from leaking to a second place.

### 2.3 Change `src/utils/memory-secret-guard.js` to carry matched_text into the 400 response

```js
return {
  ok: false,
  status: 400,
  body: {
    error: '偵測到此內容看起來是敏感資料（密碼／token／API key）',
    hint: '...',
    redirect_tool: 'ownmind_set_secret',
    detected_by: detection.rule,
    matched_text: detection.matched_text,  // new
  },
};
```

When the AI sees "`anydesk.bot_example.unattended_password` triggered" it can judge "this is a reference, not a password, change the wording" and fix it correctly on the first try.

### 2.4 Test coverage

Add the following tests to `tests/secret-detect-unit.test.js`:

1. **Positive (still block)**:
   - `password: MyP@ssw0rd123` → block
   - `API_TOKEN=abc123XYZ987` → block
   - `bearer eyJhbGc...` → already caught by the jwt regex, not in the keyword scope
   - `secret = "supersecretvalue"` → block
2. **Negative (previously falsely blocked, now should pass)**:
   - `anydesk.bot_example.unattended_password` → pass
   - `hermes.telegram.bot_token` → pass
   - `process.env.MY_PASSWORD` → pass
   - `the password is in the vault` → pass
   - `見 ssh.bot.example.com.vin.password` → pass
3. **Boundary**:
   - `password: hi` (value < 8 chars) → pass (avoid misjudging a form label)
   - `password:abc12345` (no whitespace) → block
4. **Full original-case regression**: feed in the bot.example.com content, pass

---

## 3. In scope vs out of scope

### 3.1 In scope

- ✅ Rewrite the value-side keyword logic in `shared/secret-detect.js`
- ✅ Add `matched_text` to the `detectSecretLike()` return body
- ✅ Add `matched_text` to the 400 response in `src/utils/memory-secret-guard.js`
- ✅ Add positive / negative / boundary / regression tests to `tests/secret-detect-unit.test.js`
- ✅ Sync update: README three languages, FILELIST, CHANGELOG, package.json version → 1.19.13

### 3.2 Out of scope

- ❌ Title / description keyword scan logic (kept as-is, skipped by narrative types via opt-in)
- ❌ Length heuristic (no false-positive record, unchanged)
- ❌ The 7 regexes (no false-positive record, unchanged)
- ❌ CGNAT IP / AnyDesk ID whitelist (root-cause analysis confirmed it wasn't this incident's trigger, not done)
- ❌ Changing pre-commit hook behavior (the hook already uses `skip_keyword: true`, doesn't run keyword in the first place, unaffected)

---

## 4. Blast radius

### 4.1 Code

| File | Change |
|------|------|
| `shared/secret-detect.js` | value-side keyword changed from includes to an assignment regex, matched_text added to the return body |
| `src/utils/memory-secret-guard.js` | matched_text added to the 400 body |
| `tests/secret-detect-unit.test.js` | add 8~12 tests |

### 4.2 Cross-end impact (IR-022 check)

| End | Affected? | Notes |
|----|-------|------|
| Server `src/routes/memory.js` | No — connects indirectly via memory-secret-guard, doesn't call directly | |
| Pre-commit hook `hooks/ownmind-git-pre-commit.js` | No — already uses `skip_keyword: true`, value-side keyword doesn't run anyway | |
| MCP `mcp/index.js` tool descriptions | No — description text unchanged | |
| Admin UI | Slightly positive — the 400 response gains a matched_text field, optionally shown to the admin; not showing it won't break anything | |
| Iron rules / Skills | No | |

### 4.3 Docs

| File | Change |
|------|------|
| `README.md` / `docs/README.zh-TW.md` / `docs/README.ja.md` | Add a section across all three languages: "secret-detect v1.19.13: value-side keyword detection tightened" |
| `CHANGELOG.md` | Add v1.19.13 entry |
| `FILELIST.md` | Unchanged (no new files) |
| `package.json` | version 1.19.12 → 1.19.13 |

---

## 5. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------|------|------|
| A real password pasted in a non-assignment pattern (e.g. `「密碼是 qwerty12345」`) would pass | Low | Medium | The length heuristic still catches ≥20-char alphanumerics; regex still catches common key formats; narrative topics are opt-in not-keyword anyway and aren't blocked currently either |
| matched_text echoes a real key back | Low | Medium | Truncated to 80 chars + it's already a 400 error, which was always meant to tell the caller what's wrong; rate-limit and audit log unchanged |
| The assignment regex misses some separator (e.g. `password\nabc12345`) | Medium | Small | Write tests covering common variants; missed cases fall to the length heuristic or get fixed next round |
| Existing tests break | Low | Small | The TDD flow runs red first, to see whether existing tests should be adjusted because of this change |

---

## 6. Decision record

| # | Topic | Options to decide |
|---|------|-----------|
| 1 | value-side keyword detection strength | **A. recognize only the assignment pattern (recommended by this proposal)** / B. also add a dot-separated identifier whitelist (double protection) / C. unchanged |
| 2 | matched_text truncation length | **A. 80 chars (recommended, enough to see context)** / B. 40 chars (more conservative) / C. don't truncate (simple but higher risk) |
| 3 | whether to tighten the title / description keyword too | A. tighten together / **B. unchanged (recommended, different responsibility)** |

---

## 7. Next steps

1. Vin decides the 3 points above
2. Write `spec.md` (GIVEN/WHEN/THEN scenarios)
3. Write `tasks.md` (task list)
4. Follow TDD (IR-003): write the red test first → run red → implement → run green
5. Quality gate three steps (IR-045): verification → request review → handle review
6. Sync README / FILELIST / CHANGELOG (IR-008, IR-032)
7. Sync version in three places (IR-031): package.json + git tag + (no SERVER_VERSION constant, package.json is authoritative)
8. Tag v1.19.13, push, Vin decides whether to deploy prod
