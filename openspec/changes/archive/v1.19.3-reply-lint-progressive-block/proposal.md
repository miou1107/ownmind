# v1.19.3 — Reply-lint progressive block + whitelist expansion + context-aware threshold

- **Author**: Vin
- **Date**: 2026-05-22
- **Status**: In progress
- **Worktree**: None (main, change is controllable)
- **Branch**: `main`

---

## 0. One-line summary

The reply-lint hook (IR-037 Chinese-English mixing / IR-036 jargon without explanation) is upgraded from "warn only" to "progressive enforcement": the first 2 times warn, the 3rd previews, the 4th blocks + asks Claude to rewrite. At the same time, based on 30 days of audit data the whitelist is expanded to 200+ words, the threshold is made context-aware (pure conversation 15%, with code 25%, pure code review exempt), and an `OWNMIND_REPLY_LINT_MODE` opt-in is added. Maps to IR-027 "only logic works".

> Plain language: previously reminders did nothing, Claude couldn't see them and wouldn't change. Now once violations accumulate to a certain count it gets blocked, and Claude receives an instruction to rewrite. But there's a buffer first (to avoid wrecking the conversation on the first false positive) + warn by default (the user has to opt in to turn on block).

---

## 1. Design rationale

### 1.1 Real incident (ongoing)

OwnMind carries 5 "must-heed" items in the SessionStart hook, of which 3 (IR-037 100%, IR-036 100%, explanation preference 100%) have a 100% violation rate against the current AI — warnings are completely useless against the AI, and the user seeing the warning can only do better next time.

### 1.2 Why this is a classic IR-027 failure

The same situation as IR-027 "only logic works": reply-lint detected it, wrote a banner, the AI knows nothing (the hook deliberately doesn't write stdout to avoid being consumed by the AI channel). It produced something that "was regulated but never landed", pure decoration.

To break this: upgrade the banner from "notify the user after the fact" to "enforce up front + feed Claude a rewrite instruction".

### 1.3 Why v1.19.3 + progressive + opt-in (not block-by-default directly)

**Three big holes found by Codex adversarial review, the corrected plan**:

1. **High false-positive rate**: the 30-day audit shows 80% of the Top 30 violation words are "project names / big-company names / standard technical terms" rather than real jargon. Going straight to block would kill normal conversations
2. **stop_hook_active safeguard insufficient**: we originally thought "if Claude rewrites and violates again the safeguard lets it through", but in fact "stop_hook_active only prevents recursion within the same Stop event, not Claude violating again after a rewrite"
3. **Cross-tool compatibility**: the Stop hook only runs in Claude Code, Codex / Cursor / Antigravity won't trigger it. Block mode gives the illusion of "all AIs enforced" while actually only blocking 1 vendor

**After Codex verified the Claude Code Stop hook spec**:
- Confirmed that writing `{decision:'block', reason}` JSON to stdout is the standard approach
- Confirmed Claude Code has a built-in **limit of 8 consecutive blocks** that automatically prevents infinite loops
- Confirmed the reason is fed to Claude as "the next prompt" → the reason should be written as an **instruction** ("please rewrite") rather than a **report** ("you violated")

---

## 2. Design

### 2.1 Progressive block (accumulation behavior when mode=block)

Maintain a violation count within the session, +1 on each violation:

| Count | Behavior |
|---|---|
| 1 | Write tty banner, write compliance event, **don't block** (buffer for the first false positive) |
| 2 | Write tty banner, write compliance event, **don't block** |
| 3 | Write tty banner (with a "next violation will block" preview), write compliance event, **don't block** |
| 4+ | Write tty banner, write compliance event, **output block JSON to stdout**, Claude receives the rewrite instruction |

The count is stored in `~/.ownmind/logs/reply-lint-session-counter.json`:
```json
{
  "<session_id>": {
    "count": 3,
    "last_violation_ts": "2026-05-22T12:00:00Z",
    "started_at": "2026-05-22T11:30:00Z"
  }
}
```
- session_id is obtained from the Stop hook stdin
- Sessions older than 30 days are auto-cleaned (the runner self-cleans)

### 2.2 Three MODEs (OWNMIND_REPLY_LINT_MODE environment variable)

| MODE | Behavior |
|---|---|
| `warn` (default) | Exactly as before: only write tty banner + compliance event, never block |
| `block` | Progressive: count < 4 same as warn, count ≥ 4 write block JSON |
| `disable` | Skip lint entirely (equivalent to OWNMIND_REPLY_LINT_DISABLE=1) |

Values not in the whitelist are treated as `warn` by default (fail-open).

### 2.3 Block reason written as an instruction

Codex warning: the reason is "the next prompt", not "a correction instruction". So:

❌ Don't write: "you violated IR-037, ratio 32%, found 5 English words"
✅ Do write: "please rewrite that response, in plain Chinese, with English technical terms annotated in parentheses with a Chinese explanation"

Actual format (verbatim product string fed to Claude — preserved in Chinese):
```
請重寫你剛才的回應、改善以下品質問題（不改變原意、只改語言風格）：

1. 用白話中文取代以下英文詞（或在第一次出現時用括號附中文解釋）：
   {問題詞列表}

2. 對「{行話詞}」這類技術詞、第一次出現時要附白話說明、例如：
   - hook（攔截器、特定時機自動跑的小程式）
   - middleware（中間處理層）
   - 用「：」「（）」「即...」「也就是」等格式

如果你判斷上述詞已經有相關上下文、或屬於變數名 / 函式名等程式碼引用、可以保留不改。重寫時請回到原本的對話脈絡、不要重新確認問題、直接給新答案。
```

### 2.4 Whitelist expansion (based on the 30-day audit)

Expand from 80 words to ~200, categorized:

**New category A: big-company / big-platform names (not jargon)**
Google, Meta, OpenAI, Chrome, OAuth, YouTube, Podcast, Imagen, Llama, Perplexity, Remotion, Evernote, Sheets, GitHub Actions, Jenkins... (35+ words)

**New category B: Vin's personal project names**
Google, Acme, ownmind, ... (10+ words)

**New category C: Git / dev-flow words**
main, origin, branch, worktree, commits, rebase, merge, conflict, stash, cherry-pick, hook, Hook, review, reviewer, prod, staging, spec, prompt, tasks, task, tests, pipeline, Pipeline, Stage, stage, chunk, monorepo, redirect, apply, archive, container, fresh, trigger, success, container, render, retry, batch, topic, server, handoff, project, brand, plan, publish, Research, Notes, redirect, payload, handler, router, service, factory, singleton, instance, function, class, interface, schema, array, string, boolean, number, error, exception, timeout... (80+ words)

**New category D: common technical concepts**
async, await, callback, promise, middleware, endpoint, dispatcher, websocket, sse, polling, throttle, debounce, cache, queue, lock, mutex... (25+ words)

### 2.5 Context-aware threshold

`checkMixedLanguage(content, options)` behavior:

```js
const hasCodeBlock = /```|`[^`]+`/.test(content);
const isCodeReview = /code review|code-review/.test(content);

let threshold = 0.15;
if (isCodeReview) {
  return { ok: true, ratio: 0, mixedWords: [] }; // exempt
}
if (hasCodeBlock) {
  threshold = 0.25;
}
```

### 2.6 IR-036 window expanded from 50 to 80 characters

Codex pointed out: in a Chinese context 50 characters is roughly 25 Chinese characters, and the explanation often gets cut off outside the parentheses. Changing to 80 characters lets the immediately following supplement be caught.

### 2.7 Proper noun detection (capitalized isolated words)

New rule: a word with a capitalized first letter that matches the common pattern of English surnames / company names is treated as a proper noun, not a violation:

```js
function looksLikeProperNoun(word) {
  return /^[A-Z][a-z]+$/.test(word);  // e.g. Google, Alice, Carol
}
```

Note: all-caps words (AWS, IDE) are already in the whitelist.

---

## 3. In scope vs out of scope

### 3.1 In scope

- ✅ `shared/language-lint.js`: expand whitelist to 200+ words, context-aware threshold, IR-036 window 80 chars, proper noun detection
- ✅ `hooks/ownmind-reply-lint.js`: add `OWNMIND_REPLY_LINT_MODE` env, progressive counting, session counter persistence, block JSON output
- ✅ Add `hooks/lib/session-counter.js`: pure functions, counter read/write + auto-clean sessions older than 30 days
- ✅ Update tests + add mode / counter / block tests
- ✅ Banner adds "current count / how many more until block" info
- ✅ Sync the docs trio (IR-008 + IR-026 + IR-032)
- ✅ Version number v1.19.3 (IR-031)

### 3.2 Out of scope

- ❌ Cross-tool compatibility (Codex / Cursor etc. have different hook mechanisms, left for a later version)
- ❌ Pre-tool hook alternative (architectural overhaul, this version only touches the Stop hook)
- ❌ Writing the session count into the DB (a plain file is enough, avoids depending on the server)
- ❌ Admin UI showing lint trigger history (the activity log already exists, sufficient)

---

## 4. Blast radius

| File | Change |
|------|------|
| `shared/language-lint.js` | Expand whitelist, context-aware threshold, window 80, proper noun detection |
| `hooks/ownmind-reply-lint.js` | MODE env, progressive count, block JSON, instruction-style reason |
| `hooks/lib/session-counter.js` | **New file** — pure-function session counter read/write + auto-clean |
| `tests/language-lint.test.js` (if it exists) / new file | Whitelist, threshold, proper noun tests |
| `tests/reply-lint-hook.test.js` | 14+ status===0 spots changed to mode-aware; add block / counter / no-loop tests |
| `tests/session-counter.test.js` | **New file** — counter pure-function tests |
| README / docs/zh-TW / docs/ja | Add "progressive block + MODE" to the Reply Lint section |
| CHANGELOG / FILELIST | v1.19.3 entry |
| package.json | v1.19.3 |

---

## 5. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------|------|------|
| Whitelist expanded to 200 words, misses real jargon | Medium | Medium | Warn by default, run for 1 week and check the audit before deciding whether to shrink the whitelist again |
| Session counter file corrupted | Low | Small | Wrapped in try/catch, corruption is treated as count zero, doesn't affect other flows |
| Poor Claude rewrite quality / infinite loop | Low | Medium | Claude Code has a built-in limit of 8 consecutive blocks; the instruction-style reason reduces quality risk |
| Poor experience after a user opts into block | Medium | Medium | Warn by default, the user has to change the env themselves to turn on block, zero exit cost |
| Session counter inconsistent across machines | Medium | Low | The counter is per-machine, no cross-machine sync needed, reasonable |

---

## 6. Decision record

| # | Topic | Options to decide | Vin's decision |
|---|------|-----------|----------|
| 1 | Progressive thresholds | A. 2/3/4 (recommended) / B. 1/2/3 / C. 3/5/7 | A |
| 2 | Default MODE | A. warn, opt-in block (recommended) / B. block straight away | A |
| 3 | Session counter storage | A. ~/.ownmind/logs/json file (recommended) / B. SQLite / C. DB | A |
| 4 | Proper noun detection | A. `^[A-Z][a-z]+$` simple rule (recommended) / B. don't do it | A |
| 5 | reason style | A. instruction (recommended) / B. report | A |

---

## 7. Next steps

1. ✅ Audit 30 days of log + Codex adversarial review + verify the hook spec (done)
2. ⏳ Write `spec.md` + `tasks.md`
3. ⏳ Follow TDD: write test first, run red, implement, run green
4. ⏳ Local install + dogfooding to confirm no false kills
5. ⏳ Sync the docs trio
6. ⏳ Commit + tag v1.19.3 + push (client-side hook, no server deploy needed)
7. ⏳ Run 1 week of warn mode audit, confirm the false-positive rate has dropped to acceptable before considering flipping block to default
