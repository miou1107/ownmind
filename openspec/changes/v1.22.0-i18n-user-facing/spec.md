# v1.22.0 — Spec

## Surfaces Translated

### MCP tool descriptions (`mcp/index.js`)

The `TOOLS` array (currently lines 420-734) holds 19 tool definitions. Each entry has:

- A top-level `description` (some are short, some are multi-paragraph including safety warnings)
- An `inputSchema.properties.<field>.description` for each input field

All `description` string values that currently contain Han characters MUST become English. Field types, enum values, and `required` lists are unchanged.

### Hook console messages

Two hook scripts produce Chinese terminal output:

- `hooks/ownmind-git-pre-commit.js` — runs before every commit; the most visible OwnMind output to the user.
- `hooks/ownmind-git-post-commit.js` — runs after every commit; surfaces version-tag drift and audit summary.

Every `console.log` / `console.warn` / `console.error` call argument that contains Han characters MUST become English. Template-literal substitutions (`${VERSION}`, `${commitHash}`, `${pkgVersion}`, `${expectedTag}`) MUST be preserved verbatim.

## Translation Behavior Contract

### GIVEN/WHEN/THEN

**Scenario: A foreign AI client connects to OwnMind MCP**

- GIVEN a Claude Code session running an English-locale system prompt
- WHEN the AI lists OwnMind's MCP tools
- THEN the AI sees tool descriptions in English
- AND the AI correctly identifies `ownmind_save` as "Save a new memory" without language guessing
- AND the AI follows the imperative in `ownmind_report_bug`: does NOT auto-fill `confirm_string`

**Scenario: A non-Chinese-speaking user runs `git commit`**

- GIVEN a user with English locale on macOS / Linux / Windows
- WHEN they run `git commit` while OwnMind hooks are installed
- THEN any warning, version reminder, or audit message printed to the terminal is in English
- AND the message includes the actionable next step in English (e.g., "→ run: git tag v1.22.0")

**Scenario: A user with OwnMind temporarily disabled runs `git commit`**

- GIVEN `session-off.json` exists and is within its 24-hour window
- WHEN `git commit` triggers the pre-commit hook
- THEN the hook prints (in English): `[OwnMind v<VERSION>] ⚠️ OwnMind is temporarily disabled — commit hook skipped all iron rule checks. Re-enable with /ownmind-on or open a new conversation.`
- AND the hook exits 0 (skip-success path), unchanged from prior behavior

**Scenario: Behavior is unchanged**

- GIVEN any input that previously caused a behavior (block, allow, warn, log)
- WHEN the same input flows through v1.22.0
- THEN the same behavior occurs, only the displayed strings differ

## Preservation Rules

- All emoji prefixes (⚠️) are kept at the start of their string, unchanged.
- The `[OwnMind v${VERSION}]` banner format is unchanged (do not localize the brand or version).
- Iron rule codes (`IR-037`, `IR-007`) in examples are kept as-is.
- Action verbs in tool descriptions become imperative present-tense English ("Save a memory", "Retrieve a memory by type").
- Sub-field descriptions are short noun phrases or one short sentence ("Memory ID", "Reason for disabling.").

## Style Examples

| Before | After |
|---|---|
| `"記憶 ID"` | `"Memory ID"` |
| `"停用原因"` | `"Reason for disabling"` |
| `"依類型取得記憶列表。"` | `"Retrieve memories of a given type."` |
| `"⚠️ 含密碼／token／API key／credential 等敏感資料請改用 ownmind_set_secret…"` | `"⚠️ For sensitive data (passwords, tokens, API keys, credentials) use ownmind_set_secret instead — do not write secrets into memories (the memory API detects and rejects them with HTTP 400)."` |
| `"【OwnMind v${VERSION}】⚠️ 驗證引擎不可用，跳過 post-commit 檢查"` | `"[OwnMind v${VERSION}] ⚠️ Validator engine unavailable — skipping post-commit check"` |

## Non-Goals

- No structural change to the TOOLS array.
- No new fields, no removed fields.
- No change to `handleTool` dispatcher or any tool's runtime behavior.
- No change to the MCP transport or protocol negotiation.
