# v1.19.20+ — Critical iron-rule enforcement spec (GIVEN / WHEN / THEN)

> BDD three-part description (premise / action / expected result), per OpenSpec CONVENTIONS.md.
> See proposal §2, §3, §6 for enforcement locations, detection logic, and the bypass mechanism.

---

## I. Git pre-commit hook enforcement scenarios

### Scenario 1: IR-002 detects a .env file staged → block

**GIVEN (premise)**

- The v1.19.20+ pre-commit hook is installed (`~/.ownmind/hooks/git-pre-commit` symlinked to the git hook dir)
- The working tree has a `.env.production` file
- The `OWNMIND_BYPASS` environment variable is **unset**

**WHEN (action)**

```bash
git add .env.production
git commit -m "feat: add env"
```

**THEN (expected result)**

- the pre-commit hook runs, exit code **1**
- stderr shows:
  ```
  ❌ IR-002 違反: 偵測到 .env 檔案進入 commit
    檔案: .env.production
    請改用 ownmind_set_secret 儲存敏感資料，或設定 OWNMIND_BYPASS=IR-002 強制 commit
  ```
- the commit is **not created** (`git log -1` shows the previous commit)
- writes an audit event: a new `action='block', rule_code='IR-002'` record in the `compliance` table

---

### Scenario 2: IR-002 detects a secret pattern staged → block

**GIVEN**

- The v1.19.20+ pre-commit hook is installed
- The staged diff contains a plaintext OpenAI API key (`sk-proj-1234...`)

**WHEN**

```bash
git commit -m "feat: add api integration"
```

**THEN**

- exit 1
- the stderr message contains `detected_by: regex:openai_api_key` (shares the v1.19.1 detector)
- the commit is not created

---

### Scenario 3: IR-008 src/ changed but the three docs didn't → block

**GIVEN**

- staged diff: `src/routes/memory.js` modified, no README.md / FILELIST.md / CHANGELOG.md changes

**WHEN**

```bash
git commit -m "fix: memory route"
```

**THEN**

- exit 1
- stderr:
  ```
  ❌ IR-008 違反: src/ 有改動但這三個文件沒同步
    src/routes/memory.js (+12 -3)
    缺少: README.md / FILELIST.md / CHANGELOG.md
  ```
- the commit is not created

---

### Scenario 4: IR-008 pure test / pure doc changes → don't block

**GIVEN**

- staged diff only touches `tests/**` or `docs/**`, not `src/**`

**WHEN**

```bash
git commit -m "test: add coverage"
```

**THEN**

- exit 0, commit succeeds
- README/FILELIST/CHANGELOG don't need to be synced

---

### Scenario 5: IR-009 git user.name ≠ Vin → block

**GIVEN**

- `git config user.name` is `Anthropic Claude` (wrong)

**WHEN**

```bash
git commit -m "feat: ..."
```

**THEN**

- exit 1
- stderr:
  ```
  ❌ IR-009 違反: contributors 必須是 Vin
    當前 git user.name: Anthropic Claude
    執行修正: git config --global user.name "Vin"
  ```

---

### Scenario 6: IR-024 commit message contains Co-Authored-By → block

**GIVEN**

- The pre-commit hook is installed
- commit message: `feat: add X\n\nCo-Authored-By: Claude <noreply@anthropic.com>`

**WHEN**

```bash
git commit -F /tmp/msg
```

**THEN**

- exit 1
- stderr:
  ```
  ❌ IR-024 違反: commit message 不可含 Co-Authored-By
    找到行: Co-Authored-By: Claude <noreply@anthropic.com>
  ```

---

### Scenario 7: IR-031 three version numbers out of sync → block (pre-tag)

**GIVEN**

- `package.json.version` = `1.20.0`
- `src/SERVER_VERSION` = `1.19.0` (out of sync)
- the user wants to create tag `v1.19.20`

**WHEN**

```bash
git tag v1.19.20
```

**THEN**

- the pre-tag hook runs, exit 1
- stderr:
  ```
  ❌ IR-031 違反: 三處版號不同步
    package.json:   1.20.0
    SERVER_VERSION: 1.19.0
    tag:            v1.19.20
    請先把 SERVER_VERSION 更新到 1.20.0
  ```
- the tag is not created

---

### Scenario 8: IR-012 session log has no verification record → block

**GIVEN**

- The working tree has src/ changes already staged
- This session never called `superpowers:verification-before-completion`, and `ownmind_search` finds no verification compliance event

**WHEN**

```bash
git commit -m "feat: new feature"
```

**THEN**

- exit 1
- stderr:
  ```
  ❌ IR-012 違反: 沒找到本 session 的品管驗證紀錄
    執行 superpowers:verification-before-completion 後再 commit
  ```

---

### Scenario 9: IR-012 verification already run → pass

**GIVEN**

- This session already called verification and wrote the compliance event `rule_code='IR-012', action='comply'`

**WHEN**

```bash
git commit -m "feat: new feature"
```

**THEN**

- the IR-012 check passes, proceeding to the other iron-rule checks

---

### Scenario 10: all checks pass → commit succeeds

**GIVEN**

- Working-tree changes: src/ + README + FILELIST + CHANGELOG all synced
- git user.name = Vin
- commit message has no Co-Authored-By
- no secret into the commit
- this session has a verification record

**WHEN**

```bash
git commit -m "feat: legit feature"
```

**THEN**

- exit 0, commit created
- writes compliance events: all critical iron rules `action='comply'`
- shows `✓ 鐵律檢查通過（6 條 critical、耗時 67ms）`

---

## II. PreToolUse hook enforcement scenarios

### Scenario 11: IR-005 blind edit, Edit without having read the file → block

**GIVEN**

- The v1.19.20+ PreToolUse hook is installed (Claude Code `~/.claude/settings.json` adds a hook)
- The AI never called Read on `src/routes/auth.js`

**WHEN**

- The AI calls `Edit { file_path: "src/routes/auth.js", old_string: "...", new_string: "..." }`

**THEN**

- hook exit 2, Claude Code interrupts the tool call
- the message returned to the AI:
  ```
  ❌ IR-005 違反: 不可 blind edit
    這個 session 沒有 Read 過 src/routes/auth.js
    請先呼叫 Read 工具讀取後再 Edit
  ```
- the AI receives it and should call Read next turn

---

### Scenario 12: IR-005 already read, Edit passes

**GIVEN**

- The AI already Read `src/routes/auth.js` in this session
- The hook records read state: `~/.ownmind/state/session-<id>/read-files.json`

**WHEN**

- The AI calls `Edit { file_path: "src/routes/auth.js", ... }`

**THEN**

- exit 0, the tool call continues

---

### Scenario 13: IR-002 tool-layer interception of rm on a secret file

**GIVEN**

- The v1.19.20+ PreToolUse hook is installed

**WHEN**

- The AI calls `Bash { command: "rm .env.production" }`

**THEN**

- the hook detects the `rm .env*` pattern, exit 2
- message:
  ```
  ❌ IR-002 違反: 不可刪除 .env 檔案（可能含密碼、刪了不可復原）
    若真要刪、設 OWNMIND_BYPASS=IR-002 後重試
  ```

---

## III. Reply-lint hook enforcement scenarios

### Scenario 14: IR-037 mixed Chinese-English > 15% → block the reply

**GIVEN**

- The v1.19.20+ reply-lint hook is upgraded to exit 2 mode
- The AI draft reply has a 21.9% Chinese-English mix ratio

**WHEN**

- Claude Code runs the reply-lint hook before sending the reply

**THEN**

- hook exit 2, the reply is **not sent**
- the message returned to the AI:
  ```
  ❌ IR-037 違反: 中英混雜比例 21.9% > 15%
    找到 12 個非白名單英文詞（前 5：author, Authored, Sheet, ...）
    請改成白話中文後重新回應
  ```
- the AI receives it and should rewrite the reply

---

### Scenario 15: IR-036 jargon without plain-language → block

**GIVEN**

- The AI draft reply contains jargon like "sitemap" or "verify" without「（白話）」「：解釋」「即...」 within the following 50 characters

**WHEN**

- the reply-lint hook runs

**THEN**

- exit 2, message:
  ```
  ❌ IR-036 違反: 行話沒附白話說明
    sitemap, verify, drafts, ...
  ```

---

### Scenario 16: Reply-lint blocks 3 times in a row → downgrade to warning (avoid infinite loop)

**GIVEN**

- The AI is blocked by reply-lint 3 times in a row within the same turn

**WHEN**

- The 4th draft still violates

**THEN**

- the hook switches to exit 1 (warning), the reply is sent but shows a warning
- writes the compliance event `action='repeated_violation_softblock'`
- prompts the user: "reply-lint blocked 3 times in a row; downgraded to a warning to avoid an infinite loop; please review manually"

---

### Scenario 17: IR-041 detects national ID / email → block

**GIVEN**

- The AI reply contains `user@example.com` or a national-ID pattern

**WHEN**

- the reply-lint hook runs

**THEN**

- exit 2, the message lists the matched pattern
- Exception: when the user's own prompt contains the same data, treat it as the user proactively sharing and don't block (check whether the user message contains the same string)

---

## IV. Bypass mechanism scenarios

### Scenario 18: OWNMIND_BYPASS environment variable → skip a specific iron rule + write audit

**GIVEN**

- The staged diff has README.md out of sync (would violate IR-008)

**WHEN**

```bash
OWNMIND_BYPASS=IR-008 git commit -m "hotfix: emergency"
```

**THEN**

- the IR-008 check is skipped, other iron rules still run
- commit succeeds
- writes audit:
  ```json
  {
    "ts": "2026-05-22T...",
    "event": "bypass",
    "rule_code": "IR-008",
    "commit_sha": "abc1234",
    "commit_message": "hotfix: emergency",
    "user": "vin",
    "tool": "git-pre-commit"
  }
  ```
- the admin UI Bypass record tab shows this entry

---

### Scenario 19: OWNMIND_BYPASS=all → skip all critical (emergency escape)

**GIVEN**

- An emergency, all critical iron rules temporarily off

**WHEN**

```bash
OWNMIND_BYPASS=all git commit -m "emergency"
```

**THEN**

- all critical checks skipped, commit succeeds
- the audit log is marked `bypass_all`
- the admin UI shows a red warning "⚠️ ALL CRITICAL BYPASSED"

---

### Scenario 20: Bypass doesn't affect other sessions / machines

**GIVEN**

- Session A runs `OWNMIND_BYPASS=IR-008 git commit ...`

**WHEN**

- Session B (same machine, another terminal) runs `git commit`, staged content violates IR-008

**THEN**

- Session B is still blocked (the environment variable is process scope, doesn't leak)
- Session A's bypass doesn't pollute the global state

---

## V. Cross-tool and upgrade scenarios

### Scenario 21: Cursor users fall back to git pre-commit

**GIVEN**

- The user works in Cursor (no PreToolUse hook)
- Changed src/ without syncing README

**WHEN**

- The user runs `git commit` in Cursor's integrated terminal

**THEN**

- git pre-commit still runs, IR-008 blocks
- IR-005 (the PreToolUse layer) didn't block in Cursor = an accepted design compromise
- The docs clearly state "Cursor users only have git-layer enforcement"

---

### Scenario 22: v1.19 existing users upgrade to v1.19.20+

**GIVEN**

- An existing v1.19.0 user, pre-commit hook not installed
- Runs `ownmind` SessionStart

**WHEN**

- SessionStart detects v1.19.20+ is deployed but the local hook isn't connected yet

**THEN**

- shows a one-time guidance message:
  ```
  【OwnMind v1.19.20+】Critical 卡控已上線、請跑：
    ownmind migrate-hooks
  把 pre-commit / PreToolUse / reply-lint hook 接上。
  ```
- after the user runs migrate-hooks, `.git/hooks/pre-commit` symlinks to `~/.ownmind/hooks/`
- subsequent SessionStart no longer shows the guidance

---

### Scenario 23: Hook performance SLA acceptance

**GIVEN**

- The local machine has 50 staged files, a 100-line commit message

**WHEN**

- Run `time git commit`

**THEN**

- total pre-commit hook execution time **< 100ms (p95)**
- each iron-rule check runs in parallel, not serially accumulated
- a benchmark test in CI ensures no regression

---

## VI. Audit log and admin UI

### Scenario 24: all violations, bypasses, and complies go into the compliance table

**GIVEN**

- v1.19.20+ has run for a week

**WHEN**

- The admin opens the admin UI "Bypass records" tab

**THEN**

- shows a timeline: each bypass's time, rule, commit sha, reason (optionally filled by the user)
- supports filtering: by iron-rule number, by date range
- count summary: "this week IR-008 bypassed 3 times, IR-024 bypassed 0 times"
- links to the corresponding commit (GitHub URL)

---

### Scenario 25: Bypass records cannot be deleted (audit integrity)

**GIVEN**

- The admin UI Bypass record tab

**WHEN**

- The admin tries to delete a record

**THEN**

- there is no "delete" button
- the API `DELETE /api/compliance/:id` always returns 403
- a record can only be marked `reviewed=true`, it cannot disappear

---

## VII. Edge cases

### Scenario 26: Hook crashes itself (internal error)

**GIVEN**

- A pre-commit hook internal error (e.g. a detector function throws an exception)

**WHEN**

- The user runs `git commit`

**THEN**

- hook exit code **0** (fail-open, doesn't block the user)
- stderr shows a warning:
  ```
  ⚠️ OwnMind hook 跑錯、暫時跳過卡控
    error: <message>
    請通報 ownmind issue
  ```
- writes an error log to `~/.ownmind/logs/hook-errors.log`
- the compliance event is marked `action='hook_internal_error'`
- **Design reason**: a broken hook shouldn't block the normal workflow; fail-open while notifying the maintainer

---

### Scenario 27: Offline environment (OwnMind server unreachable)

**GIVEN**

- The local network is down, the OwnMind server is unreachable

**WHEN**

- The pre-commit hook runs

**THEN**

- regex / pattern detection (IR-002, IR-024, IR-009) runs normally (purely local)
- detection that needs the server (IR-012 checking the session log) → falls back to fail-open + warning
- the audit log is buffered to `~/.ownmind/queue/` and auto-flushes when online (the existing offline queue mechanism)

---

### Scenario 28: False-positive fallback path

**GIVEN**

- pre-commit blocks a normal commit because some regex is too strict

**WHEN**

- The user tries repeatedly, failing 3 times

**THEN**

- on the 3rd time the hook adds a prompt:
  ```
  💡 如果這是誤判、用：
    OWNMIND_BYPASS=<rule_code> git commit ...
    並到 Admin UI 回報誤判改善 detector
  ```

---

## Non-scenarios (explicitly not done)

- ❌ **Advisory tier logic**: handled in v1.21+
- ❌ **Dynamic promotion/demotion**: handled in v1.22+
- ❌ **Silently rewriting user code / commit message**: not done, let the user/AI fix it themselves
- ❌ **Cursor PreToolUse enforcement**: Cursor has no corresponding hook point, not done this version
- ❌ **AI auto-suggesting bypass**: bypass must be the user's explicit intent, not left to the AI to decide
