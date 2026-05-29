# v1.19 — Iron-rule tier spec (GIVEN / WHEN / THEN)

> This spec uses the BDD three-part description (plainly: precondition / action / expected result), per CONVENTIONS.md item 1 of OpenSpec.

---

## Scenario 1: migration doesn't break existing iron rules

**GIVEN (precondition)**

- The database already has 41 iron rules (IR-002 ~ IR-042), `memories.type = 'iron_rule'`
- The 014 migration has not been run yet

**WHEN (action)**

- Run `db/014_iron_rule_tier.sql`

**THEN (expected result)**

- The `memories` table adds a `tier VARCHAR(20) DEFAULT 'default'` field
- The `tier` of all 41 existing iron rules is `'default'`
- The `idx_memories_iron_rule_tier` index is created successfully, covering only rows with `type='iron_rule'` (PARTIAL INDEX)
- The existing title / content / code / status / metadata are completely untouched
- The migration is re-runnable (IF NOT EXISTS), no error on the second run

---

## Scenario 2: API writes tier

**GIVEN**

- The API server has deployed v1.19
- A logged-in admin account

**WHEN**

```http
PUT /api/memory/123
Authorization: Bearer <admin_api_key>
Content-Type: application/json

{ "tier": "critical" }
```

**THEN**

- Response 200
- The `memories.tier` field is updated to `'critical'`
- Writes `memory_history`, `change_type = 'update'`, `changed_by` is the admin user
- The API response body contains the updated tier value

---

## Scenario 3: tier value validation

**GIVEN**

- The API server has deployed v1.19

**WHEN**

```http
PUT /api/memory/123
{ "tier": "invalid_value" }
```

**THEN**

- Response 400 Bad Request
- The error message clearly states the allowed values: `tier must be one of: critical, default, advisory`
- The `memories` table is not changed

---

## Scenario 4: non-iron-rule cannot set tier

**GIVEN**

- The API server has deployed v1.19
- `memories.id=99` is a `type='project'` project memory

**WHEN**

```http
PUT /api/memory/99
{ "tier": "critical" }
```

**THEN**

- Response 400 Bad Request
- Error message: `tier can only be set on type='iron_rule' memories`
- `memories.id=99.tier` keeps its original value (NULL or default)

---

## Scenario 5: MCP tools support the tier parameter

**GIVEN**

- An AI tool connects via the OwnMind MCP server
- Authenticated

**WHEN**

```js
await ownmind_save({
  type: 'iron_rule',
  title: 'IR-099 範例鐵律',
  content: '...',
  tier: 'critical',
  trigger_tags: ['edit']
})
```

**THEN**

- The iron rule is created successfully
- Returns `memory.tier === 'critical'`
- Synchronously writes `~/.ownmind/cache/iron_rules.json` with the tier field
- When no `tier` parameter is passed, defaults to `'default'`

---

## Scenario 6: SessionStart load grouped by tier

**GIVEN**

- The user opens Claude Code, triggering the SessionStart hook
- The cloud has 10 critical, 20 default, 10 advisory iron rules

**WHEN**

- The SessionStart hook runs, runs `ownmind_init`, reads `iron_rules_digest`

**THEN**

Display order and format:

```
## 鐵律（必須嚴格遵守）

### 🔴 Critical（10 條）
IR-002: 不要 commit .env 或密碼 [觸發: commit/git]
IR-005: 不要 blind edit [觸發: edit]
...

### 🟡 Default（20 條）
IR-003: 修 bug 前先寫 reproduction test [觸發: edit]
...

### ⚪ Advisory（10 條）純參考提示
（這層級規則不顯示細節，需要時用 `ownmind_get("iron_rule")` 完整列出）
```

- Critical is always expanded, with a red emoji
- Default is always expanded, with a yellow emoji
- Advisory **does not list rule details**, only shows the count + how to get the detailed list (reduces initial load word count, avoids diluting the AI's attention)

---

## Scenario 7: compliance event for violating a Critical iron rule

**GIVEN**

- The user commits a `.env.production` file (violating IR-002, tier=critical)
- v1.19 is deployed

**WHEN**

- The pre-commit hook detects the violation
- Writes a compliance event to `~/.ownmind/logs/YYYY-MM-DD.jsonl`

**THEN**

The event object structure:

```json
{
  "ts": "2026-05-15T10:30:00.000Z",
  "event": "iron_rule_compliance",
  "tool": "claude-code",
  "source": "git-pre-commit",
  "details": {
    "action": "violate",
    "rule_code": "IR-002",
    "rule_title": "不要 commit .env 或密碼",
    "tier": "critical",
    "context": "嘗試 commit .env.production"
  }
}
```

- The `tier` field **must** appear in details
- Even when the network / spool write fails, tier must still be carried
- **This version does not block the commit** — the hook still returns exit 0 (v1.20 blocks it)

---

## Scenario 8: Admin UI edits tier

**GIVEN**

- The admin opens `https://example.com/ownmind/admin/memories`
- Opens the IR-002 edit page

**WHEN**

- The admin changes tier from `default` to `critical`
- Clicks "儲存"

**THEN**

- The page shows "儲存成功"
- The backend PUTs /api/memory/{id} with body carrying `tier: 'critical'`
- The list page immediately reflects the new tier, shown with a red dot
- The audit log records: who, when, tier from default → critical

---

## Scenario 9: old-client fallback

**GIVEN**

- The server has been upgraded to v1.19, the API returns iron rules with the `tier` field
- The user's Cursor is still an old client that doesn't recognize the tier field

**WHEN**

- The old client reads `GET /api/memory/type/iron_rule`

**THEN**

- The old client works normally (one extra JSON field doesn't break it)
- All iron rules are handled by the old logic (equivalent to default)
- No forced client upgrade needed

---

## Scenario 10: shared/iron-rule-tier.js helper

**GIVEN**

- The iron-rule cache array (obtained from the API or `~/.ownmind/cache/iron_rules.json`)

**WHEN**

```js
import { getTierFromRules } from '../shared/iron-rule-tier.js';
const tier = getTierFromRules(rules, 'IR-002');
```

**THEN**

- On a rule hit, returns that rule's `tier` (normalized, guaranteed to be a valid value)
- Not found / tier missing / tier invalid value / rules not an array → returns `'default'` (fallback)
- Does not throw an exception

---

## Scenario 11: behavior when rule_code is missing

**GIVEN**

- A custom iron rule has no `code` field (e.g. one the user created manually)

**WHEN**

- The compliance hook detects a violation of that iron rule

**THEN**

- The compliance event's `rule_code` is `null`, `tier` is still taken from `memories.tier`
- It doesn't throw an error due to the missing rule_code
- The log is written normally

---

## Scenario 12: release acceptance criteria

**GIVEN**

- v1.19.0 has been tagged, pushed, deployed to prod
- prod has run for 24 hours

**WHEN**

- Run the acceptance SQL:

```sql
SELECT tier, COUNT(*) FROM memories
WHERE type = 'iron_rule' AND status = 'active'
GROUP BY tier;
```

**THEN**

- `critical` count = 10 (manual tiering done)
- `default` count ≈ 30 ± 2 (remaining)
- `advisory` count = 0 (pending v1.19.1)
- No iron rule with a NULL tier
- The admin dashboard "iron-rule tiers" tab can display the distribution chart normally

---

## Non-scenarios (things explicitly not done)

- ❌ **AI auto-suggests tier**: not in v1.19, evaluated in v1.20+
- ❌ **per-user custom tiering**: never (violates cross-tool consistency)
- ❌ **Critical violation actually blocked**: handled in v1.20
- ❌ **Advisory section lists details**: v1.19 only shows the count + how to get them via `ownmind_get('iron_rule')` (SessionStart is text output, there's no "expand" button to do it)
