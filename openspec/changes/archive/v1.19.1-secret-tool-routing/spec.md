# v1.19.1 — Passwords/tokens not written to memory spec (GIVEN / WHEN / THEN)

> BDD three-part description (precondition / action / expected result), per OpenSpec CONVENTIONS.md.
> The detector rules and routing logic are defined in proposal §2; this file only describes externally observable behavior.

---

## Scenario 1: WP Application Password format detected → blocked

**GIVEN (precondition)**

- The API server has deployed v1.19.1
- A logged-in user account

**WHEN (action)**

```http
POST /api/memory
Content-Type: application/json

{
  "type": "reference",
  "title": "Example Client WP password",
  "content": "<a WordPress application password: six groups of four>",
  "description": "WordPress Application Password"
}
```

**THEN (expected result)**

- Response **400 Bad Request**
- body:
  ```json
  {
    "error": "偵測到此內容看起來是敏感資料（密碼／token／API key）",
    "hint": "敏感資料請改用 ownmind_set_secret（MCP 工具）或 POST /api/secret（HTTP API）。",
    "redirect_tool": "ownmind_set_secret",
    "detected_by": "regex:wp_application_password"
  }
  ```
- The `memories` table writes **no** new row
- No history record written

---

## Scenario 2: JWT format detected → blocked

**GIVEN**

- The API server has deployed v1.19.1

**WHEN**

```http
POST /api/memory
{
  "type": "reference",
  "title": "API token",
  "content": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
}
```

**THEN**

- 400 + `detected_by: "regex:jwt"`
- Same structure as scenario 1

---

## Scenario 3: keyword hit (title/description contains "password") → blocked

**GIVEN**

- The API server has deployed v1.19.1

**WHEN**

```http
POST /api/memory
{
  "type": "reference",
  "title": "Stripe production password",
  "content": "abc123XYZ789longRandomString"
}
```

**THEN**

- 400 + `detected_by: "keyword:password"`
- Even if content matches no regex, it's still blocked as long as title/description contains a sensitive keyword

---

## Scenario 4: length heuristic (length ≥ 20 pure alphanumeric, no Chinese) → blocked

**GIVEN**

- The API server has deployed v1.19.1

**WHEN**

```http
POST /api/memory
{
  "type": "reference",
  "title": "key for service",
  "content": "abcDEF1234567890XYZ9876543210"
}
```

**THEN**

- 400 + `detected_by: "heuristic:long_alnum"`

---

## Scenario 5: normal memory (contains Chinese) → not blocked

**GIVEN**

- The API server has deployed v1.19.1

**WHEN**

```http
POST /api/memory
{
  "type": "project",
  "title": "Example Client 接手後緊急事項",
  "content": "2026-05-07 接手後第一週需要處理的緊急事項清單：1. WP backup ..."
}
```

**THEN**

- Response **201 Created**
- Because content contains CJK characters, the detector doesn't enter the length-heuristic check
- It also matches no regex or keyword
- Normally written to `memories` + `memory_history`

---

## Scenario 6: bypass flag → allow write but record audit

**GIVEN**

- The API server has deployed v1.19.1
- The user explicitly wants to record a pointer-type memory like "I stored the key in the vault"

**WHEN**

```http
POST /api/memory
{
  "type": "reference",
  "title": "ExampleClient WP password 存放位置",
  "content": "存在 1Password 的 'example-prod' vault、entry name='wp-user'",
  "metadata": { "allow_secret_like": true }
}
```

**THEN**

- Response 201
- `memories.metadata.lint_warnings` contains one entry:
  ```json
  { "type": "bypass_secret_detect", "ts": "<ISO timestamp>" }
  ```
- Even if content hits the keyword "password" (appearing in the title), it's still written
- The admin UI list page shows a warning badge "⚠️ 跳過敏感偵測"

---

## Scenario 7: PUT (update) also goes through the same detector

**GIVEN**

- An existing memory id=200, type=`reference`, content="研究 OAuth 流程"
- The API server has deployed v1.19.1

**WHEN**

```http
PUT /api/memory/200
{
  "content": "client_secret: sk-proj-1234567890abcdefghij1234567890",
  "update_reason": "補上實際密鑰"
}
```

**THEN**

- Response **400**, `detected_by: "regex:openai_api_key"`
- The existing id=200 content is **not changed** (still "研究 OAuth 流程")
- No history written (because the update failed)

---

## Scenario 8: MCP tool description contains a warning

**GIVEN**

- The AI connects via OwnMind MCP and queries available tools

**WHEN**

- The AI calls `tools/list`

**THEN**

- The description of `ownmind_save` starts with "⚠️ 含密碼／token／API key 請改用 `ownmind_set_secret`，不要寫進記憶"
- `ownmind_update` same
- The description of `ownmind_set_secret` is unchanged
- The AI reads the warning before selecting a tool and prefers the right one

---

## Scenario 9: 500 → 4xx rework (validation error)

**GIVEN**

- The API server has deployed v1.19.1

**WHEN**

```http
PUT /api/memory/123
{ "tier": "invalid_value" }
```

**THEN**

- Response **400** (it was a "validation early-return", already 400; this scenario verifies the catch-all rework **does not regress**)
- The existing tier validation 400 behavior is preserved

---

## Scenario 10: 500 → 4xx rework (internal DB error)

**GIVEN**

- The API server has deployed v1.19.1
- The DB is temporarily down, the PUT triggers a query that throws `DatabaseConnectionError`

**WHEN**

```http
PUT /api/memory/123
{ "content": "正常內容", "update_reason": "正常更新" }
```

**THEN**

- Response **500** + body `{ "error": "更新記憶失敗" }`
- The server log writes error.stack (for debugging)
- **Does not regress** to misclassifying the DB error as 400

---

## Scenario 11: 500 → 4xx rework (auth error)

**GIVEN**

- The API server has deployed v1.19.1
- The user tries to modify memory id=999 that doesn't belong to them

**WHEN**

```http
PUT /api/memory/999
{ "content": "...", "update_reason": "..." }
```

**THEN**

- Response **404 "找不到該記憶"** (existing behavior, this proposal doesn't change it)
- Or 403 (if team_standard, non-admin) (existing behavior, this proposal doesn't change it)
- This proposal's catch-all rework doesn't affect these two existing early-return paths

---

## Scenario 12: new iron rule takes effect

**GIVEN**

- v1.19.1 is deployed
- The new iron rule "敏感資料一律走 ownmind_set_secret、不寫進 memory／對話／commit" has been created via the admin UI, `tier='critical'`

**WHEN**

- The AI starts a new session, the SessionStart hook runs `ownmind_init`

**THEN**

- The iron rule appears under the Critical group
- Contains a clear trigger-scenario description and the extension relationship to IR-002
- When the AI later calls `ownmind_save`/`update` trying to write a password, it's blocked by the server, and the iron rule reminds it to use `ownmind_set_secret`

---

## Scenario 13: the detection rule does not apply to the secret API itself

**GIVEN**

- The API server has deployed v1.19.1

**WHEN**

```http
POST /api/secret
{
  "key": "exampleclient_wp_app_password",
  "value": "<a WordPress application password: six groups of four>"
}
```

**THEN**

- Response 200
- The secret is stored normally
- The detector **does not apply** to the `/api/secret` route (this is "the correct tool", designed for storing sensitive data)

---

## Non-scenarios (explicitly not done)

- ❌ **AI reply detection**: reply-lint scanning AI replies for passwords — separate scope in v1.19.2
- ❌ **Existing memory DB scan**: finding passwords already written in and redacting them — handled in v1.19.2
- ❌ **Encrypted storage**: the secret API still uses the existing storage path (plaintext + RLS) — encryption is a separate project
- ❌ **Detector 100% perfection**: this proposal accepts false negatives; the goal is "this incident doesn't recur + most common formats are blocked"
