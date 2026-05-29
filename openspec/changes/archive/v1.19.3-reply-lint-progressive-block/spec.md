# v1.19.3 — Reply-lint Progressive Block spec (GIVEN / WHEN / THEN)

> BDD three-part form. Covers progressive block, the 3 MODEs, session counter, whitelist expansion behavior.

---

## Scenario 1: MODE=warn (default) — violation only warns, never blocks

**GIVEN**
- `OWNMIND_REPLY_LINT_MODE` unset or set to `warn`
- The last turn's assistant text contains "我用 refactor 跟 hook 重寫整個 codebase 的 middleware" (an obvious violation)

**WHEN**
the hook is triggered

**THEN**
- stdout is **completely empty** (no block JSON, no text at all)
- /dev/tty writes a banner (with the IR-037/036 violation list)
- compliance event spool / POST
- exit 0

---

## Scenario 2: MODE=block + session's 1st violation — warn, don't block

**GIVEN**
- `OWNMIND_REPLY_LINT_MODE=block`
- The session counter shows 0 violations for this session
- assistant text violates

**WHEN**
the hook is triggered

**THEN**
- session counter +1 → becomes 1
- /dev/tty writes a banner (containing "目前 session 違規 1 次、累積 4 次會 block")
- stdout **doesn't write** block JSON
- exit 0

---

## Scenario 3: MODE=block + session's 4th violation — triggers block

**GIVEN**
- `OWNMIND_REPLY_LINT_MODE=block`
- The session counter shows 3 violations for this session
- assistant text violates

**WHEN**
the hook is triggered

**THEN**
- session counter +1 → becomes 4
- /dev/tty writes a banner (containing "⚠️ 已觸發 block、Claude 將收到重寫指令")
- stdout outputs `{"decision":"block","reason":"請重寫你剛才的回應..."}` JSON
- The reason content is instruction-style, contains the specific problem words, contains rewrite-format guidance
- exit 0

---

## Scenario 4: MODE=block + Claude violates again after rewriting — count keeps accumulating, Claude Code's built-in 8-time limit protects

**GIVEN**
- Already reached the 4th violation, the hook has blocked
- Claude received the reason, rewrote, and the new response still violates
- At this point `stop_hook_active` is set to true by Claude Code

**WHEN**
the hook is triggered

**THEN**
- Detecting `stop_hook_active: true` → **immediately exit 0, don't run lint, don't write banner, don't write stdout**
- session counter **does not increment** (this doesn't count as a user violation, it's caused by the hook's own retry)
- A subsequent genuine new user turn has stop_hook_active=false, and the count resumes accumulating

---

## Scenario 5: MODE=disable — fully skip

**GIVEN**
- `OWNMIND_REPLY_LINT_MODE=disable` (or `OWNMIND_REPLY_LINT_DISABLE=1`)

**WHEN**
the hook is triggered

**THEN**
- Doesn't read the transcript, doesn't run lint, doesn't write anything
- exit 0

---

## Scenario 6: MODE unknown value (fail-open) — treated as warn

**GIVEN**
- `OWNMIND_REPLY_LINT_MODE=foo` (a typo)

**WHEN**
the hook is triggered

**THEN**
- Treated as `warn`, behavior same as scenario 1
- /dev/tty banner adds a line "⚠️ MODE 值 'foo' 不認識、fallback 到 warn" (so the user notices)

---

## Scenario 7: Session counter file doesn't exist — treated as count 0

**GIVEN**
- `~/.ownmind/logs/reply-lint-session-counter.json` doesn't exist
- MODE=block, violation

**WHEN**
the hook is triggered

**THEN**
- The counter is treated as 0, after +1 it's written to a newly created file
- Behavior same as scenario 2 (1st violation, warn, don't block)

---

## Scenario 8: Session counter file corrupted — count reset to zero, doesn't block the flow

**GIVEN**
- The counter file content isn't valid JSON
- MODE=block, violation

**WHEN**
the hook is triggered

**THEN**
- Treated as count 0, overwrite the file (start fresh from a clean state)
- Behavior same as scenario 2

---

## Scenario 9: Whitelist expansion — the Top 30 violation words should all be absorbed by the whitelist

**GIVEN**
- assistant text contains "Google", "main", "branch", "worktree", "review", "hook" (Top 30 words)

**WHEN**
running `checkMixedLanguage`

**THEN**
- Returns `{ok: true, ratio: 0, mixedWords: []}` — all in the newly expanded whitelist

---

## Scenario 10: Proper noun detection — capitalized isolated words don't count as violations

**GIVEN**
- assistant text contains "Alice 跟 Carol 都同意" (personal names)

**WHEN**
running `checkMixedLanguage`

**THEN**
- `Alice`, `Carol` match the `^[A-Z][a-z]+$` pattern → treated as proper nouns, not violations
- Returns `{ok: true, ratio: 0, mixedWords: []}`

---

## Scenario 11: Context-aware threshold — with a code block, relaxed to 25%

**GIVEN**
- assistant text contains a ` ```code``` ` block
- Chinese-English mixing ratio 22% (would violate in a general context, with code should pass)

**WHEN**
running `checkMixedLanguage`

**THEN**
- Detecting ` ``` ` → threshold=0.25
- 22% < 25% → `{ok: true, ratio: 0.22}`

---

## Scenario 12: Code review exemption — containing the phrase "code review" passes directly

**GIVEN**
- assistant text begins with "## Code Review" or "code-review 結果"

**WHEN**
running `checkMixedLanguage`

**THEN**
- Detecting the code review phrase → returns `{ok: true, ratio: 0, mixedWords: []}` directly

---

## Scenario 13: IR-036 window expanded from 50 to 80 characters

**GIVEN**
- assistant text contains "我們的 dispatcher 設計、     也就是把訊息分派出去的元件"
(the first meaningful character after dispatcher is at distance > 50 but < 80)

**WHEN**
running `checkJargonExplanation`

**THEN**
- "也就是" found within 80 characters → not a violation
- The same text would violate under the old 50-character window, passes under the new 80

---

## Scenario 14: Session counter auto-clean — sessions older than 30 days are auto-removed

**GIVEN**
- The counter file contains 100 session records, of which 60 have `started_at` > 30 days ago
- MODE=block, new session violation

**WHEN**
the hook is triggered

**THEN**
- Auto-clean on write, the 60 stale records are deleted
- The final file has only 41 sessions left (40 not stale + 1 newly triggered)

---

## Scenario 15: Reason is written as an instruction, with rewrite-format suggestions

**GIVEN**
- MODE=block, 4th violation, violation words include "refactor", "codebase"

**WHEN**
the hook outputs block JSON

**THEN**
- The `reason` string begins with "請重寫" (an instruction verb)
- Contains "refactor", "codebase" listed as actual words
- Contains specific format examples such as "用括號附中文解釋", "：", "（）"
- Contains exception guidance like "如果你判斷上述詞已經有相關上下文、或屬於變數名 / 函式名等程式碼引用、可以保留不改"
- Doesn't contain report-style tone such as "你違反了", "你做錯了"
