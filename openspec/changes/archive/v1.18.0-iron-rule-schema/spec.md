# v1.18.0 — Spec

GIVEN/WHEN/THEN 三段式正式規格 + 設計細節。對應 proposal.md 的 acceptance criteria。

---

## 1. SKILL.md 鐵律格式規格

### 1.1 frontmatter schema

```yaml
---
name: <kebab-case identifier>          # 必填、3-60 字、^[a-z0-9-]+$
description: <pushy trigger sentence>  # 必填、20-500 字、必須含觸發詞
---
```

只兩欄、對齊 Anthropic SKILL.md 標準、**不自創欄位**。

### 1.2 frontmatter 偵測

GIVEN 一筆鐵律 content
WHEN 開頭是 `---\n` 且後續有對應的 `\n---\n`
THEN 視為 SKILL.md 格式、走 schema lint

GIVEN 一筆鐵律 content
WHEN 開頭不是 `---\n` 或結尾找不到 `\n---\n`
THEN 視為純文字、走 v1.17.94 regex lint（向後相容）

### 1.3 schema lint（有 frontmatter 時）

| 規則 ID | 檢查 | 失敗行為 |
|---|---|---|
| S1 | YAML frontmatter 解析合法 | reject 400 |
| S2 | `name` 必填、kebab-case (`/^[a-z0-9-]+$/`) | reject 400 |
| S3 | `name` 字數 3-60 | reject 400 |
| S4 | `description` 必填、字數 20-500 | reject 400 |
| S5 | `description` 含觸發詞（`/when|whenever|use\s+when|triggers\s+on|何時|觸發|情境|準備|要做/i`） | reject 400 |
| S6 | body（frontmatter 後）字數 ≥ 100 | reject 400 |
| S7 | body 含規則段落關鍵字（`/規則|該做|不該做|禁止|必須|應該|不可|不要/`） | reject 400 |
| S8 | 中英混雜檢查（IR-037、沿用 v1.17.94） | reject 400 |
| S9 | `description` 字數 < 50 | warning（**不 reject**） |

### 1.4 regex lint（沒 frontmatter 時、向後相容）

GIVEN 鐵律 content 沒 frontmatter
WHEN server 跑 lintIronRule
THEN 走 v1.17.94 規則 #1-#7 完全不變

---

## 2. MCP API 規格

### 2.1 `ownmind_save` 接受 SKILL.md 格式

GIVEN MCP client 呼叫 `ownmind_save({ type: 'iron_rule', title, content, tags })`
WHEN content 是 `---\nname: ...\ndescription: ...\n---\n# 標題\n...`
THEN
- server 偵測 frontmatter、跑 schema lint
- 過 lint → 寫 DB（content 欄位完整存 frontmatter + body）
- 觸發 sync hook（見 §4）
- 回應含 `format: 'skill_md'`

### 2.2 `ownmind_save` 純文字 fallback

GIVEN MCP client 呼叫 `ownmind_save({ type: 'iron_rule', ..., content })` 沒 frontmatter
WHEN
THEN
- server 走 v1.17.94 regex lint
- 過 lint → 寫 DB
- 觸發 sync hook（也會 sync、但 reference 檔案直接放純文字、SKILL.md frontmatter 由 sync 自動補一個 minimal version）
- 回應含 `format: 'legacy_text'`

### 2.3 `ownmind_update` 同上

GIVEN client 改鐵律 content
WHEN
THEN
- 同 ownmind_save 規則：偵測 frontmatter → schema lint or regex lint
- 改後若有 `previous_content` 欄位（決策 #4）→ 把改前 content 備份進去

---

## 3. 升級助手 Web UI 規格

### 3.1 GET `/api/admin/iron-rules/upgrade-status`

GIVEN admin 登入後
WHEN 呼叫此 endpoint
THEN 回應：
```json
{
  "total": 35,
  "skill_md_format": 0,
  "legacy_text": 35,
  "rules": [
    {
      "id": 5,
      "code": "IR-002",
      "title": "不要 commit ...",
      "format": "legacy_text",
      "tags": ["trigger:commit", "trigger:git"]
    },
    ...
  ]
}
```

### 3.2 POST `/api/admin/iron-rules/:id/suggest-skill-md`

GIVEN admin 點 [Suggest SKILL.md format]
WHEN POST `/api/admin/iron-rules/5/suggest-skill-md`
THEN
- server 用 LLM（Claude API、走 OWNMIND_SUGGEST_API_KEY env、若無則 disable button）把鐵律 title + content + tags 推 SKILL.md format
- 回應 `{ suggested: '---\nname: ...\n---\n...', warnings: [...] }`
- **不寫 DB**

### 3.3 PUT `/api/admin/iron-rules/:id/upgrade`

GIVEN admin 在 Web UI 看 diff、按 [Confirm & Save]
WHEN PUT `/api/admin/iron-rules/5/upgrade { content: '...' }`
THEN
- server 跑 schema lint（不過直接 reject 400）
- 過 → 把舊 content 備份到 `previous_content`、新 content 寫進 content
- 觸發 sync hook
- 回應 `{ ok: true, format: 'skill_md' }`

### 3.4 Web UI 行為規格

GIVEN admin 在 `/admin/iron-rule-upgrade` panel
WHEN 列表顯示
THEN
- 35 條鐵律列表、每條右側顯示 [Legacy] 或 [SKILL.md] tag
- 預設按格式排序（Legacy 在上）
- 每條有 [Suggest], [Edit], [Skip] 三按鈕

GIVEN admin 點 [Suggest]
WHEN
THEN
- 顯示 diff view（左 original / 右 proposed）
- 提供 [Edit Proposed] textarea 微調
- [Confirm & Save] 把當前 textarea 內容 PUT 上去

---

## 4. Sync 機制規格（conditional pull、sync_token hash check）

### 4.0 為什麼 conditional pull

OwnMind 已有 `sync_token` (`src/utils/syncToken.js`)：
- 公式：`sha256(user_id : max(memory.updated_at) : max(team.updated_at)).slice(0, 12)`
- 任何寫入操作會改 `updated_at` → `sync_token` 自動變
- 既有用途：MCP client **寫入**操作必須帶 sync_token、server 不一致退回（防 stale client）

v1.18.0 補完讀取端：SessionStart hook 用 `sync_token` 做 If-None-Match 風格 conditional pull。

### 4.1 新 endpoint：`GET /api/memory/sync-token`

GIVEN client 需要快速判斷本地 cache 是否 stale
WHEN `GET /api/memory/sync-token` with Authorization Bearer
THEN
- server 跑 `generateSyncToken(userId)` (既有 helper)
- 回 `{ "sync_token": "a1a785218482" }` (~50 bytes)
- **不 query 任何鐵律 / 記憶內容**（lightweight）

### 4.2 SessionStart hook conditional sync flow

GIVEN SessionStart hook 跑
WHEN
THEN
1. 讀 local cache `~/.ownmind/cache/memories.json`
2. 取出 `cache.sync_token` 跟 `cache.saved_at`
3. **過期保險**：若 `Date.now() - cache.saved_at > 24hr` → 直接走全量 download path
4. 否則：`GET /api/memory/sync-token`
5. 比對：
   - `local === server` → **跳過 init download**、用 local cache、no-op skill files（99% sessions 走這條）
   - `local !== server` → 走全量 `GET /api/memory/init?compact=true`、寫新 cache（含新 sync_token + saved_at）、重寫 `~/.claude/skills/ownmind-iron-rules/`
6. 失敗 fallback：sync-token endpoint 失敗 → 走全量 init（safe）；全量 init 失敗 → 用 local cache 跑（offline mode、`mcp/offline.js` 既有邏輯）

### 4.3 寫入觸發

GIVEN `ownmind_save` / `ownmind_update` 寫鐵律成功
WHEN MCP client 收到 server 200
THEN
- server 端 `updated_at` 自動改 → sync_token 變
- **不需 MCP client 主動 sync** — 下次 SessionStart 比 token 會發現變了、自動 refresh
- **可選優化**：MCP client 寫成功後直接重寫該鐵律本地 reference file（即時生效、不等下次 SessionStart）

### 4.4 cache 檔格式

```json
{
  "sync_token": "a1a785218482",
  "saved_at": "2026-05-13T04:50:17.875Z",
  "data": {
    "iron_rule": [...],
    "profile": [...],
    ...
  }
}
```

跟既有 `~/.ownmind/cache/memories.json` 格式完全一致（**不需新檔案、不需 ALTER**）— 只是 SessionStart hook 開始用它。

### 4.5 對帳保險

GIVEN local cache `saved_at` 超過 24 hr
WHEN SessionStart hook 跑
THEN
- 強制走全量 download path、即使 sync-token 比對相同
- 防 sync_token 算錯導致永久 stale cache
- 24 hr threshold 寫進 `hooks/lib/sync-iron-rules.js` 常數

### 4.2 本地檔案結構

```
~/.claude/skills/ownmind-iron-rules/
├── SKILL.md                                    # big skill metadata
└── references/
    ├── IR-001-XXX.md                            # 每條鐵律一檔
    ├── IR-002-no-commit-secrets.md
    ├── IR-003-bug-reproduction-test.md
    └── ... (35 個)
```

### 4.3 SKILL.md (big skill) 內容

```yaml
---
name: ownmind-iron-rules
description: |
  Use whenever you do ANY action that touches code, commits, deploys, edits, debugs,
  or any work covered by Vin's iron rules. OwnMind has N iron rules covering
  git workflow, deploy safety, secret management, debugging discipline, doc sync,
  and AI work quality. ALWAYS consult this when you're about to commit, deploy,
  delete, edit code, or write any user-facing response.
---

# OwnMind Iron Rules

Vin 的個人鐵律集合 — 從歷史踩坑學來的、必須嚴格遵守的工作規則。

## 觸發索引（按 trigger 分類）

### trigger: edit
- IR-003: 修 bug 前先寫 reproduction test → references/IR-003-bug-reproduction-test.md
- IR-005: 不要 blind edit → references/IR-005-no-blind-edit.md
- ...

### trigger: commit / git
- IR-002: 不要 commit .env 或密碼 → references/IR-002-no-commit-secrets.md
- IR-008: commit 必須同步 README/FILELIST/CHANGELOG → references/IR-008-three-doc-sync.md
- ...

### trigger: deploy
- IR-018: Docker build 要加 --no-cache → references/IR-018-docker-no-cache.md
- IR-023: 部署必須用 docker compose build → references/IR-023-compose-not-docker.md
- ...

(N 個 trigger 分類)

## 如何使用

當你要做某個 trigger 對應的動作時、查上方索引找到相關鐵律、讀 references/ 對應檔案
拿到完整 do/dont 細節。
```

### 4.4 references/IR-XXX.md 內容

每個 reference 檔就是該鐵律的完整 SKILL.md format：

```yaml
---
name: ir-002-no-commit-secrets
description: |
  Use when about to git commit / push any change. Required for ALL commits...
---

# IR-002: 不要 commit .env 或密碼

(完整 body)
```

或對於 legacy 鐵律、直接放純文字 + 自動補 minimal frontmatter：

```yaml
---
name: ir-011-timezone-standard
description: |
  IR-011: 時區強制定標準
  Triggers on: edit. (auto-generated from legacy text rule)
---

(原 content 純文字)
```

### 4.5 衝突處理

GIVEN 本地 `references/IR-002-no-commit-secrets.md` 被 user 手改
WHEN sync hook 偵測到本地內容跟 DB 不一致
THEN
- DB 永遠贏、覆蓋本地（決策 #6）
- log warning 到 `~/.ownmind/logs/sync-conflicts.jsonl` 記錄被覆蓋的內容
- **不打斷 sync**

### 4.6 跨 AI 工具同步（沿用 install.sh:300 pattern）

GIVEN 鐵律寫入觸發 sync
WHEN sync hook 跑
THEN 對下列工具、目錄存在才寫：

| 工具 | 寫法 |
|---|---|
| Claude Code | `~/.claude/skills/ownmind-iron-rules/` 完整 skill folder（主路徑） |
| Cursor | `~/.cursor/rules/ownmind-iron-rules.md` 把 SKILL.md + 35 reference inline 成單檔 |
| Antigravity | `~/.antigravity/rules/ownmind-iron-rules.md` 同 Cursor |
| OpenCode | `~/.opencode/AGENTS.md` 加 `<!-- ownmind-iron-rules -->` block 含 skill summary |
| Codex | `~/.codex/AGENTS.md` 同 OpenCode |
| Windsurf | `~/.windsurf/rules/ownmind-iron-rules.md` 同 Cursor |
| Gemini | `~/.gemini/GEMINI.md` 同 OpenCode |

決策 #5 若選縮減範圍、只實作 Claude Code + Codex / Gemini AGENTS.md style。

---

## 5. DB schema 動向

### 5.1 不動 `memories.content`

content 仍是 TEXT 欄位、塞 SKILL.md frontmatter + body 也塞得進、不需 ALTER。

### 5.2 加 `previous_content` 備援欄位（若決策 #4 = yes）

```sql
-- db/013_iron_rule_previous_content.sql
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS previous_content TEXT;
```

### 5.3 `format` 欄位（選填、不一定要）

加 `format VARCHAR(20)` 紀錄 'skill_md' / 'legacy_text'？
**v1.18.0 不做** — 直接由 content 偵測 frontmatter、避免 DB 跟 content 雙寫不一致。

---

## 6. Lint 行為總覽

```
client write iron_rule
    ↓
server: lintIronRule(content)
    ↓
偵測 frontmatter？
  ├─ 有 → schema lint (S1-S9) → 過/退
  └─ 沒 → v1.17.94 regex lint (#1-#7) → 過/退
        ↓
       過 → 寫 DB → 觸發 sync hook
            ↓
           sync 寫本地 + 跨工具
```

---

## 7. 測試規格

### 7.1 schema lint 測試

- frontmatter parse 失敗 → reject
- name 缺 / 太短 / 太長 / 非 kebab-case → reject
- description 缺 / 太短 / 太長 / 沒觸發詞 → reject
- body 太短 / 沒規則關鍵字 → reject
- description 字數 < 50 → warning（不 reject）
- 完整 valid SKILL.md → pass

### 7.2 regex lint 向後相容測試

- 既有 35 條鐵律每一條跑過 v1.17.94 lint 都不該被新版退（regression test）
- 純文字鐵律寫入過得了 → 跑 schema lint 就不該被觸發

### 7.3 Sync 測試

- 寫鐵律 → 本地 reference 檔自動建
- 改鐵律 → 本地 reference 檔自動更新
- disable 鐵律 → 本地 reference 檔自動刪
- SessionStart 跑、本地 vs DB 不一致 → 對帳更新
- 本地手改 → DB 為準覆蓋 + log warning

### 7.3b Conditional sync 測試（重要）

- `GET /api/memory/sync-token` 回 12 字 hex sync_token、< 100 bytes
- SessionStart：local cache token === server token → **不打 init endpoint**（用 mock server 驗）
- SessionStart：local cache token !== server token → 打 init + 重寫 cache + 重寫 skill files
- SessionStart：local cache `saved_at` > 24hr → 強制走 init path、即使 token 相同
- SessionStart：sync-token endpoint 失敗 → fallback 走全量 init
- SessionStart：全量 init 失敗 → fallback 用 local cache（既有 `mcp/offline.js` 邏輯）
- 寫鐵律 → 下次 SessionStart 該偵測到 sync_token 變

### 7.4 升級助手測試

- GET upgrade-status → 回 35 條 status
- POST suggest-skill-md → 回 SKILL.md proposal（mock LLM）
- PUT upgrade（valid SKILL.md）→ 過 lint + 寫 DB + 備份 previous_content + 觸發 sync
- PUT upgrade（invalid）→ reject 400 + 不動 DB

### 7.5 跨工具 sync 測試

- Cursor 目錄存在 → 寫 ownmind-iron-rules.md
- Cursor 目錄不存在 → skip
- Codex `AGENTS.md` 已存在 → 加新 block、保留既有內容
- Codex `AGENTS.md` 不存在 → 不寫（避免污染未裝工具）
