# v1.19.1 — Passwords/tokens not written to memory, AI auto-routes to set_secret

- **Author**: Vin
- **Date**: 2026-05-18 (proposal)
- **Status**: Awaiting Vin's decision
- **Worktree**: `confident-heyrovsky-db0eb2`
- **Branch**: `vin/confident-heyrovsky-db0eb2`

---

## 0. One-line summary

When the AI tries to write a password / token / API key into `ownmind_save` / `ownmind_update` (memory), **block it via code and guide it to `ownmind_set_secret` (secret management)**, rather than letting the AI "only realize it went the wrong way after hitting a 500".

> In plain terms: write the routing rule into the server logic + MCP tool descriptions + an iron rule, instead of just verbally reminding the AI. Corresponds to IR-027 "reminders don't work, only logic does".

---

## 1. Design rationale

### 1.1 Real incident (2026-05-18)

Vin asked the AI to store ExampleClient's WP Application Password. The AI used `ownmind_update` trying to write it into memory → the API returned **500 "更新記憶失敗"**. Vin saw the error message but didn't know why it failed, and the AI didn't know what to do next, so it just guessed from experience "try `ownmind_set_secret` instead".

The failure modes in the actual process:

1. The AI **didn't know** that password-type data should go through `ownmind_set_secret` (the tool description didn't say so)
2. The server tried to write **without detection**, then returned 500 on some internal error (generic catch-all)
3. The **500 message** only said "更新記憶失敗", didn't tell the caller what the problem was, nor pointed to the correct tool
4. No iron rule hinted at this routing rule

### 1.2 Why this is a classic IR-027 failure

IR-027 "reminders don't work, only logic does" describes exactly this situation:

- A reminder like "please remember to use set_secret for sensitive data" — the AI doesn't see it, and even if it does it may not follow it
- Logic like "the server detects it and directly blocks + suggests the alternative tool" — the AI can't even make the mistake

This version upgrades the entire "reminder layer" into a "logic layer".

### 1.3 Why v1.19.1 instead of waiting for v1.20

- v1.20's scope is "Critical iron-rule enforcement", a general mechanism
- This version's scope is very narrow (a single API + a single tool description + a single iron rule), small change, clear impact
- The real incident has already happened, the AI has already written it wrong once, shouldn't wait for the next version

---

## 2. Design (three layers of defense)

| Layer | What it does | Why this layer blocks it |
|----|--------|------------------|
| **A. Server logic enforcement** | `PUT /api/memory/:id` and `POST /api/memory` detect a value that looks like a password/token/API key → return 400 + hint `{ error, hint: "請改用 /api/secret API（或 ownmind_set_secret 工具）", redirect_tool: "ownmind_set_secret" }` | No matter how the AI writes it, it gets blocked. Corresponds to IR-027 |
| **B. MCP tool-description warning** | the description of `ownmind_save` / `ownmind_update` adds at the start "⚠️ 含密碼／token／API key 請改用 `ownmind_set_secret`，不要寫進記憶" | The AI sees it at the tool-selection stage, no need to hit a 500 to find out |
| **C. New IR-XXX iron rule** | "Sensitive data always goes through `ownmind_set_secret`, not into memory / not into conversation / not committed" | Auto-loaded at SessionStart, as the last layer of backup; also gives iron-rule violation records a corresponding entry to attribute |

Each of the three layers alone can block this incident; together they form defense-in-depth.

### 2.1 Detection rules (layer A details)

Use **conservative detection** — better to miss (false negative) than to over-block (false positive). Treat as sensitive when any of the following is matched:

1. **value length ≥ 20** and **no CJK characters other than whitespace** — ordinary memory content is rarely a pure alphanumeric long string
2. **description or title contains keywords** (case-insensitive): `password`, `passwd`, `token`, `api[-_ ]?key`, `secret`, `credential`, `auth.*key`, `bearer`, `客戶端密鑰`, `存取金鑰`, `應用程式密碼`
3. **value matches a common secret-format regex**:
   - WP Application Password: `^[A-Za-z0-9]{4}(\s[A-Za-z0-9]{4}){5,}$` (groups of 4 chars, ≥6 groups)
   - JWT: `^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`
   - GitHub PAT: `^gh[opsu]_[A-Za-z0-9]{36,}$`
   - AWS Access Key: `^AKIA[A-Z0-9]{16}$`
   - OpenAI API Key: `^sk-[A-Za-z0-9]{20,}$`

When any condition matches → return 400:

```json
{
  "error": "偵測到此內容看起來是敏感資料（密碼／token／API key）",
  "hint": "敏感資料請改用 ownmind_set_secret（MCP 工具）或 POST /api/secret（HTTP API）。記憶系統只應該存非敏感的 user/project/feedback/reference 等內容。",
  "redirect_tool": "ownmind_set_secret",
  "detected_by": "<哪個 rule 命中（regex_name / keyword / length_heuristic）>"
}
```

`detected_by` is for the AI to see why it was blocked; also used for future debugging.

### 2.2 Exception: bypass flag

In very rare cases one might want to record a **pointer-type memory** like "I stored key=foo in the vault", which is not itself a password. Provide an opt-in bypass:

- Add `"allow_secret_like": true` to metadata → the server skips detection and writes anyway
- Write to metadata.lint_warnings: `"bypass: allow_secret_like=true at <timestamp>"`, for audit
- A bypassed memory shows a warning badge "⚠️ 跳過敏感偵測" in the admin UI

Design reason: plugging the leak isn't about catching spies; keeping a conscious opt-out is better than hard-coding the rule.

### 2.3 500 → 4xx rework (incidental fix in layer A)

Currently the catch-all at `src/routes/memory.js:1255` returns 500 "更新記憶失敗" for all errors.
This time we fix it along the way: route by error class inside the catch:

| Error class | HTTP status | Message |
|---------|-----------|------|
| validation error (schema mismatch, invalid tier, the newly-added secret-like detect) | **400** | with hint and detected_by |
| auth/permission error | **403** | "無權限修改此記憶" |
| not found | **404** (already existed, the check is still earlier) | "找不到該記憶" |
| **a real internal error** (DB, JSON parse, unhandled) | **500** | keep "更新記憶失敗" but log carries error.stack |

POST `/api/memory` is handled the same way.

---

## 3. In scope vs out of scope

### 3.1 In scope (v1.19.1)

- ✅ Server `src/utils/secret-detect.js` (new file): detection function + unit tests
- ✅ Server `src/routes/memory.js`: POST + PUT wire up the detector, catch routes 4xx/5xx
- ✅ MCP `mcp/index.js`: `ownmind_save` / `ownmind_update` description adds a warning
- ✅ New iron rule: "Sensitive data always goes through `ownmind_set_secret`, not into memory / conversation / commit" (created via the admin UI or ownmind_save)
- ✅ Tests: add 6~8 tests covering detection, bypass, 4xx routing
- ✅ Sync update: README (trilingual), FILELIST, CHANGELOG (IR-008, IR-032)

### 3.2 Out of scope

- ❌ **Hook-side detection**: reply-lint detecting passwords in the AI's replies — separate scope, this version only blocks writes to memory
- ❌ **Repo scan**: scanning the existing memory DB for passwords already written in — handled in v1.19.2 (be careful, may have many false positives)
- ❌ **Critical iron-rule enforcement general mechanism**: handled in v1.20; this version's "block" for this rule is done at the server API layer, not dependent on v1.20

---

## 4. Impact

### 4.1 Server

| File | Change |
|------|------|
| `src/utils/secret-detect.js` | **new file** — `detectSecretLike(value, { title, description, allow_bypass }): { detected, rule, reason }` |
| `src/routes/memory.js` | POST + PUT call the detector before writing; the 500 catch is split into 4xx/5xx |

### 4.2 MCP

| File | Change |
|------|------|
| `mcp/index.js` | `ownmind_save` and `ownmind_update` description adds a warning at the start; schema unchanged |

### 4.3 Docs

| File | Change |
|------|------|
| `README.md` | the "Memory vs Secret" section adds the routing rule |
| `docs/README.zh-TW.md` | same, Traditional Chinese version |
| `docs/README.ja.md` | same, Japanese version |
| `CHANGELOG.md` | add a v1.19.1 entry |
| `FILELIST.md` | add `src/lib/secret-detect.js` and the new test files |

### 4.4 Iron rule

Add 1 (created via the admin UI or `ownmind_save`, not in the repo):

- **Title**: 敏感資料一律走 ownmind_set_secret，不寫進 memory／對話／commit
- **tier**: `critical` (an extension scenario of IR-002 "不要 commit .env 或密碼")
- **Triggers**: `trigger:credential`, `trigger:password`, `trigger:secret`
- **Content**: a brief description of the failure mode (as in this proposal's 1.1) + the correct path (`ownmind_set_secret`)

### 4.5 Tests

| File | Coverage |
|------|------|
| `tests/secret-detect-unit.test.js` | detector various inputs → expected outputs |
| `tests/memory-api-secret-detect.test.js` | POST/PUT hit → 400; bypass flag → skip |
| `tests/memory-api-error-codes.test.js` | 500-split-into-4xx/5xx behavior (validation→400, auth→403, internal→500) |

---

## 5. Risks and mitigations

| Risk | Probability | Impact | Mitigation |
|------|------|------|------|
| Detector false positive blocks a normal memory | Medium | Medium | conservative rule design, provide `allow_secret_like` bypass, the admin UI shows a detection-hit badge for easy manual review |
| Detector false negative, the password still gets written in | Medium | Large | of the three layers, the "MCP description warning" + "iron rule" two still remain; don't pursue 100% perfection, pursue the incident not recurring |
| Old client doesn't understand 4xx → shows "unknown error" | Low | Small | the hint string is surfaced directly to the AI; the old client just doesn't see the classification, it won't break |
| Bypass flag abused | Low | Medium | bypass is written to the audit log; the admin UI shows a warning badge |
| What about existing memory that already has passwords | High | Large | **out of scope** — v1.19.2 adds scan + remediation; first stop the bleeding on future additions |

---

## 6. Decision record

| # | Issue | Options pending decision |
|---|------|-----------|
| 1 | Detector regex scope | A. the 5 above (conservative) / B. also add Slack token / Stripe key / etc. |
| 2 | Bypass design | A. metadata `allow_secret_like: true` (recommended) / B. URL query `?allow_secret_like=1` / C. no bypass |
| 3 | 4xx granularity | A. all validation uses 400 (recommended) / B. split secret-like → 422 / other validation → 400 |
| 4 | Whether the iron rule is created via the admin UI | A. created by Vin via the admin UI (recommended, has audit) / B. the proposal directly writes a script to create it |

---

## 7. Next steps

1. Vin decides on the 4 points above
2. Write `spec.md` (GIVEN/WHEN/THEN scenarios)
3. Write `tasks.md` (task list)
4. Follow TDD (IR-003): write tests first → run red → implement → run green
5. Three quality-gate steps (IR-012): verification → request review → handle review
6. Sync README / FILELIST / CHANGELOG (IR-008, IR-032)
7. Sync the version in three places (IR-031): package.json, SERVER_VERSION, git tag
8. Create the new iron rule via the admin UI
9. Tag v1.19.1, push, deploy prod
