# MCP Startup Heartbeat + Upgrade Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire a best-effort heartbeat on every MCP server startup (not only `ownmind_init`) so already-installed users appear as "installed" in Admin without any manual action; then broadcast an upgrade notice asking existing users to pull v1.17.4.

**Architecture:** One-line addition in `mcp/index.js` before `server.connect()`. The existing `sendMcpHeartbeat()` helper is already fire-and-forget (POST `/api/usage/events` with `heartbeat` body, silent on failure). No server-side change needed — `collector_heartbeat` uses UPSERT keyed by `(user_id, tool)`, so repeat calls just refresh `last_reported_at`. Then bump to v1.17.4 and create a `upgrade_reminder` broadcast via `POST /api/broadcast/admin` to nudge older clients to pull.

**Tech Stack:** Node.js MCP server (`@modelcontextprotocol/sdk`), `node --test`, PostgreSQL UPSERT, Express broadcast route.

---

## File Structure

**Code change (A)**
- Modify: `mcp/index.js:1090-1092` — add `sendMcpHeartbeat()` call before `server.connect()`
- Test: `tests/mcp-startup-heartbeat.test.js` (new) — verifies startup heartbeat is wired into the module's top-level side-effects

**Version bump**
- Modify: `package.json` (version → 1.17.4)
- `mcp/index.js` `CLIENT_VERSION` auto-syncs from `package.json` — no edit needed

**Docs (IR-008 + IR-032)**
- Modify: `CHANGELOG.md` — add v1.17.4 entry
- Modify: `README.md`, `docs/README.ja.md`, `docs/README.zh-TW.md` — bump version badge / latest notes
- Modify: `FILELIST.md` — add the new test file

**Broadcast (B)** — runtime artifact, not committed
- Execute: `curl` to `POST /api/broadcast/admin` with auth as super_admin

---

## Task 1: Add startup heartbeat to MCP server

**Files:**
- Modify: `mcp/index.js:1091` (inject line 1091 before `new StdioServerTransport()`)
- Test: `tests/mcp-startup-heartbeat.test.js`

**Context:** `sendMcpHeartbeat()` already exists at `mcp/index.js:298-309`. It posts to `/api/usage/events` with a `heartbeat` body and swallows errors. Currently it's only called from `ownmind_init` (line 645). We add one call at module top-level, just before transport connect, so every MCP boot (from any AI tool) fires one heartbeat.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-startup-heartbeat.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpSource = readFileSync(join(__dirname, '..', 'mcp', 'index.js'), 'utf8');

test('MCP server fires sendMcpHeartbeat() at startup (before transport connect)', () => {
  // Find the transport connect line
  const connectIdx = mcpSource.indexOf('await server.connect(transport)');
  assert.ok(connectIdx > 0, 'expected await server.connect(transport) in mcp/index.js');

  // Find the module-level sendMcpHeartbeat() call (not the one inside ownmind_init handler)
  // We require at least one top-level call that appears before server.connect.
  const beforeConnect = mcpSource.slice(0, connectIdx);

  // Walk backwards from connect line to find a non-indented sendMcpHeartbeat() call
  const lines = beforeConnect.split('\n');
  const startupCall = lines.find(
    line => /^sendMcpHeartbeat\(\);?\s*(\/\/.*)?$/.test(line)
  );
  assert.ok(
    startupCall,
    'expected a top-level `sendMcpHeartbeat();` call before `await server.connect(transport)` so every MCP startup reports a heartbeat'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mcp-startup-heartbeat.test.js`
Expected: FAIL with "expected a top-level `sendMcpHeartbeat();` call..."

- [ ] **Step 3: Add the startup heartbeat line**

Open `mcp/index.js` and change:

```javascript
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => emergencySessionLog());
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

to:

```javascript
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => emergencySessionLog());
}

// Fire-and-forget heartbeat on every MCP startup so already-installed users
// appear as "installed" in Admin without manually running `ownmind_init`.
// UPSERT keyed by (user_id, tool) — repeat calls just refresh last_reported_at.
sendMcpHeartbeat();

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mcp-startup-heartbeat.test.js`
Expected: PASS (1 test, 0 fail)

- [ ] **Step 5: Run full test suite to confirm no regression**

Run: `node --test tests/`
Expected: All existing tests still pass. If anything heartbeat-related breaks (unlikely since we added a fire-and-forget call), inspect `tests/clients.test.js` and `tests/ingestion.test.js` for mocks expecting zero heartbeats.

- [ ] **Step 6: Commit**

```bash
git add mcp/index.js tests/mcp-startup-heartbeat.test.js
git commit -m "feat(mcp): fire heartbeat on every MCP startup, not only ownmind_init

Installed users who never hit ownmind_init (e.g. they only use ownmind_get/save)
never reported a heartbeat, so Admin showed them as '未裝'. Now every MCP boot
fires one best-effort heartbeat — any AI tool that loads the MCP gets counted."
```

---

## Task 2: Bump version to 1.17.4 and sync docs

**Files:**
- Modify: `package.json` (version field)
- Modify: `CHANGELOG.md` (prepend v1.17.4 entry)
- Modify: `README.md`, `docs/README.ja.md`, `docs/README.zh-TW.md` (version mentions if present)
- Modify: `FILELIST.md` (add new test file)

**Context:** IR-031 — `package.json` is the single source of truth; `mcp/index.js` reads from it at runtime, so no separate edit. IR-032 — README 三語系同步. IR-008 — CHANGELOG + README + FILELIST.

- [ ] **Step 1: Bump `package.json`**

Change `"version": "1.17.3"` to `"version": "1.17.4"`.

- [ ] **Step 2: Prepend v1.17.4 entry to `CHANGELOG.md`**

Insert at top (before the existing latest entry):

```markdown
## v1.17.4 — 2026-04-23

### Fixed
- **MCP startup heartbeat**：原本只有 `ownmind_init` 觸發 heartbeat，導致已裝但從未呼叫 init 的使用者在 Admin 顯示「未裝」。現在每次 MCP server 啟動都 fire-and-forget 一次 heartbeat（UPSERT，不會產生重複記錄）。
- 影響：所有支援 MCP 的 AI 工具（Claude Code / Cursor / Codex / Antigravity / OpenCode）啟動時自動回報，無需手動動作。

### Notes
- 舊 client（< v1.17.4）需要升級後才能享受此自動回報。使用者可跑 `bash ~/.ownmind/scripts/interactive-upgrade.sh` 一鍵升級。
```

- [ ] **Step 3: Update README tri-lingual version mentions**

If `README.md` / `docs/README.ja.md` / `docs/README.zh-TW.md` have a "latest version" line, bump all three consistently. If there's no version mention (these READMEs don't currently reference 1.17.3 per earlier grep), skip this step but still verify with:

Run: `grep -n "1\.17\." README.md docs/README.ja.md docs/README.zh-TW.md || echo "no version refs — ok"`

- [ ] **Step 4: Add new test to `FILELIST.md`**

Find the "Tests" section and add:
```
- tests/mcp-startup-heartbeat.test.js — verifies MCP fires heartbeat on startup (v1.17.4)
```

- [ ] **Step 5: Verify version flow end-to-end**

Run: `node -e "import('./mcp/index.js').catch(()=>{}); setTimeout(()=>{}, 100)"` — too invasive; instead just read the constant:

Run: `node -e "const p=JSON.parse(require('fs').readFileSync('./package.json','utf8')); console.log(p.version)"`
Expected output: `1.17.4`

- [ ] **Step 6: Commit**

```bash
git add package.json CHANGELOG.md README.md docs/README.ja.md docs/README.zh-TW.md FILELIST.md
git commit -m "chore: bump to v1.17.4 with startup-heartbeat fix"
```

- [ ] **Step 7: Tag**

```bash
git tag v1.17.4
```

---

## Task 3: Run verification-before-completion

- [ ] **Step 1: Invoke the verification skill**

Use: `Skill("superpowers:verification-before-completion")` — follow its gate before declaring done.

- [ ] **Step 2: Confirm full test suite green**

Run: `node --test tests/`
Expected: all tests pass (including the new `mcp-startup-heartbeat.test.js`).

- [ ] **Step 3: Manual smoke — MCP boots without error**

Run: `OWNMIND_API_URL=http://localhost:3100 OWNMIND_API_KEY=dummy node mcp/index.js < /dev/null &`
Expected: process starts (will exit when stdin closes, that's fine). No stack trace. Kill with `kill %1` if still running.

---

## Task 4: Broadcast the upgrade notice (manual runtime action)

**Context:** This is **not** code — it's a one-shot API call Vin runs after merging. The broadcast tells older clients (< v1.17.4) to pull the new version so they start auto-reporting.

- [ ] **Step 1: Compose the broadcast payload**

```json
{
  "type": "upgrade_reminder",
  "severity": "warning",
  "title": "v1.17.4 — 啟用自動安裝回報",
  "body": "已安裝 OwnMind 但在 Admin 顯示「未裝」？升級到 v1.17.4 後，每次 AI 工具啟動會自動回報，以後無需手動動作。跑一行指令即可升級。",
  "cta_text": "升級 OwnMind",
  "cta_action": "upgrade_ownmind",
  "max_version": "1.17.3",
  "allow_snooze": true,
  "snooze_hours": 24,
  "cooldown_minutes": 1440,
  "ends_at": null
}
```

Key choices:
- `max_version: "1.17.3"` — only show to clients running ≤ 1.17.3 (new 1.17.4 users don't need to see it)
- `allow_snooze: true` — let users defer 24h
- `ends_at: null` — keep broadcasting until everyone is on 1.17.4

- [ ] **Step 2: Send via curl (Vin runs this from his machine)**

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $OWNMIND_SUPER_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d @broadcast-payload.json \
  https://kkvin.com/ownmind/api/broadcast/admin
```

Expected: 201 Created with the broadcast row as JSON.

- [ ] **Step 3: Verify in Admin UI**

Open `https://kkvin.com/ownmind/admin`, scroll to 廣播管理, confirm the new row appears with severity=warning.

- [ ] **Step 4: Optional — wait 24h and re-check `裝機狀況`**

Within 1–2 days, colleagues should see the warning on their next AI session, pull the upgrade, and show up as "已裝" in Admin heartbeat list.

---

## Task 5: Request code review

- [ ] **Step 1: Invoke the requesting-code-review skill**

Use: `Skill("superpowers:requesting-code-review")` before opening a PR or merging to `main`.

---

## Self-Review (run after writing)

**Spec coverage**
- A (MCP startup heartbeat) → Task 1 ✓
- B (broadcast) → Task 4 ✓
- IR-022 (Server+Client 兩端) — no server change needed (UPSERT idempotent), client change in Task 1 ✓
- IR-031 (三處版號) — `package.json` is single source; `mcp/index.js` reads from it; git tag in Task 2 ✓
- IR-032 (README 三語系) — Task 2 Step 3 ✓
- IR-008 (CHANGELOG + README + FILELIST) — Task 2 ✓
- IR-024 (no Co-Authored-By) — commit messages comply ✓
- 品管三步驟 — verification (Task 3) + request review (Task 5) ✓

**Placeholder scan** — no TBDs, complete code in all steps.

**Type consistency** — no new types introduced; `sendMcpHeartbeat()` already defined at `mcp/index.js:298`.
