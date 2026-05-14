# v1.18.0 — Tasks

執行清單。順序強制：依賴 → 後端 lint → 後端 sync → 前端升級助手 → 整合 → 驗證 → 三同步 → review → commit → deploy。

可拆 3 個 commit（v1.18.0-rc1 / rc2 / rc3）→ 整合 v1.18.0。

---

## 0. 前置（等 Vin 拍版剩 6 個決策）

- [ ] **決策 #1** 確認 Migration 策略：手動 + AI 輔助分批（透過 Web UI）
- [ ] **決策 #2** 確認 lint description warning < 50 字（不 reject）
- [ ] **決策 #3** 確認引入 `js-yaml` (~50KB)
- [ ] **決策 #4** 確認加 `previous_content` 備援欄位
- [ ] **決策 #5** 確認跨工具 sync 範圍（全部 6 個 / 只 Claude Code + Codex）
- [ ] **決策 #6** 確認 sync 衝突 DB 永遠贏

---

## 1. 依賴 + 工具 (rc1 開頭)

- [ ] `npm install js-yaml --save` 加進 root package.json
- [ ] 新檔 `src/utils/iron-rule-frontmatter.js`：
  - [ ] `detectFrontmatter(content)` → `{has: bool, frontmatter?: object, body?: string}`
  - [ ] 用 `js-yaml.load` 解析、catch parse error
  - [ ] tests/iron-rule-frontmatter.test.js（10+ cases：valid / 缺尾 / 非法 YAML / 純文字 / 空 frontmatter）

---

## 2. Schema lint (rc1)

- [ ] 改 `src/utils/iron-rule-quality.js`：
  - [ ] 重構 `lintIronRule(rule)` 開頭加 frontmatter 偵測
  - [ ] 新 `lintSkillMdRule(rule, frontmatter, body)` — 跑 spec.md §1.3 S1-S9
  - [ ] 沒 frontmatter 走原 v1.17.94 路徑（規則 #1-#7、不變）
  - [ ] return shape 加 `format: 'skill_md' | 'legacy_text'` + `warnings: string[]`（warning 不算 errors）
- [ ] tests/iron-rule-quality-skill-md.test.js（20+ cases、覆蓋 S1-S9 + warning + valid）
- [ ] tests/iron-rule-quality.test.js — 跑既有 35 條鐵律快照、保證向後相容（regression）

---

## 3. MCP API 接受 SKILL.md (rc1)

- [ ] 改 `src/routes/memory.js` POST /memory + PUT /memory/:id：
  - [ ] 走新 `lintIronRule` return shape
  - [ ] response 加 `format` 欄位
  - [ ] 寫 DB 時順便填 `previous_content`（若決策 #4 = yes）
- [ ] tests/memory-iron-rule-skill-md.test.js（POST + PUT、SKILL.md path / legacy fallback path）

---

## 4. DB migration（決策 #4 = yes 才做）

- [ ] 新檔 `db/013_iron_rule_previous_content.sql`：
  ```sql
  ALTER TABLE memories ADD COLUMN IF NOT EXISTS previous_content TEXT;
  ```
- [ ] update CHANGELOG migration 步驟

---

## 5. Commit rc1

- [ ] `npm test` 全綠（≥ 1080 條：1054 + 30+ 新增）
- [ ] code review (independent agent)
- [ ] commit + push（不 deploy、等 rc3 一票上）

---

## 6. Sync hook 後端 (rc2)

### 6.0 Conditional sync — 新 lightweight endpoint（後端）

- [ ] 改 `src/routes/memory.js`：新增 `GET /api/memory/sync-token`
  - [ ] auth middleware 同其他 endpoint
  - [ ] 內部呼叫既有 `generateSyncToken(req.user.id)` (helper 已存在)
  - [ ] 回 `{ sync_token: 'a1a785218482' }`
  - [ ] **不 query 任何 memory data**（lightweight、< 100 bytes response）
- [ ] tests/sync-token-endpoint.test.js
  - [ ] auth ok → 回 sync_token
  - [ ] auth fail → 401
  - [ ] response < 100 bytes
  - [ ] 鐵律寫入後再呼叫、sync_token 變
  - [ ] 同 user 兩次呼叫 idempotent

### 6.1 File system sync helper

- [ ] 新檔 `src/utils/iron-rule-sync.js`：
  - [ ] `buildBigSkillMd(rules)` → 組 `~/.claude/skills/ownmind-iron-rules/SKILL.md` 內容
  - [ ] `buildReferenceFile(rule)` → 單條鐵律的 reference 檔內容
  - [ ] `syncToFilesystem(rules, target)` — target 是平台 enum（claude / cursor / codex / ...）
  - [ ] 偵測目錄存在才寫（沿用 install.sh:300 pattern）
- [ ] tests/iron-rule-sync.test.js（mock fs、驗每個 target 寫對 / 不寫 / 衝突偵測）

---

## 7. MCP client 觸發 sync (rc2)

- [ ] 改 `mcp/index.js`：
  - [ ] `ownmind_save` / `ownmind_update` 寫鐵律成功後、呼叫新 helper `syncIronRulesLocal()`
  - [ ] sync helper 走 lib/sync-iron-rules.js（讓 MCP 跟 SessionStart hook 共用）
- [ ] 新檔 `mcp/lib/sync-iron-rules.js`：
  - [ ] `syncIronRulesLocal(apiUrl, apiKey)` — pull DB iron_rule list、跑 syncToFilesystem
  - [ ] 失敗 silent log warning、不 throw
- [ ] tests/sync-iron-rules.test.js

---

## 8. SessionStart hook conditional sync (rc2) — 核心

- [ ] 新檔 `hooks/lib/conditional-sync.js`：
  - [ ] `shouldRefreshCache(localCache, serverSyncToken)` → bool
    - 回 true if: cache 不存在 / cache.sync_token !== server / cache.saved_at > 24hr
  - [ ] `fetchSyncTokenLight(apiUrl, apiKey)` → server sync_token (~50 bytes、3s timeout)
  - [ ] `runConditionalSync(apiUrl, apiKey, cachePath)`
    - 1. read local cache
    - 2. if 24hr 過期 → 走全量 init path
    - 3. else GET /sync-token、比對
    - 4. token 相同 → no-op、return cache
    - 5. token 不同 → GET /init?compact=true、寫新 cache、return new data
    - 6. 失敗 fallback 用 local cache
- [ ] 改 `hooks/lib/sync-memory-files.js`：
  - [ ] 開頭跑 `runConditionalSync`、拿到鐵律 list
  - [ ] 鐵律有變才跑 `syncIronRulesLocal` 重寫本地 skill files
  - [ ] 沒變 → 完全跳過、不打雲端 init endpoint
- [ ] tests/conditional-sync.test.js
  - [ ] sync_token same → 不打 init endpoint（mock server）
  - [ ] sync_token different → 打 init + 寫新 cache
  - [ ] cache 24hr 過期 → 強制 init
  - [ ] sync-token endpoint 失敗 → fallback 走 init
  - [ ] init endpoint 失敗 → fallback 用 local cache
- [ ] tests/session-start-iron-rule-sync.test.js
  - [ ] 鐵律沒變 → SessionStart 跳過 skill file 重寫
  - [ ] 鐵律有變 → SessionStart 重寫 skill file

---

## 9. 跨工具 sync 路徑（決策 #5 範圍）

- [ ] 加 platform handlers in `src/utils/iron-rule-sync.js`：
  - [ ] Claude Code: 完整 skill folder
  - [ ] Cursor: inline 單檔（若決策 #5 = full）
  - [ ] Antigravity: 同 Cursor
  - [ ] Codex: AGENTS.md block append（marker `<!-- ownmind-iron-rules -->`）
  - [ ] OpenCode: 同 Codex
  - [ ] Windsurf: 同 Cursor
  - [ ] Gemini: 同 Codex
- [ ] install.sh / install.ps1：
  - [ ] 安裝時跑一次 syncIronRulesLocal、初始化所有目錄
- [ ] tests/cross-tool-sync.test.js（mock fs、驗每個工具獨立判斷）

---

## 10. Commit rc2

- [ ] `npm test` 全綠（≥ 1110 條）
- [ ] code review
- [ ] commit + push

---

## 11. 升級助手後端 (rc3)

- [ ] 改 `src/routes/admin.js`（或新檔 `src/routes/admin-iron-rule-upgrade.js`）：
  - [ ] GET `/api/admin/iron-rules/upgrade-status`
  - [ ] POST `/api/admin/iron-rules/:id/suggest-skill-md` （call LLM API）
  - [ ] PUT `/api/admin/iron-rules/:id/upgrade`（lint + 寫 DB + 觸發 sync）
- [ ] LLM suggest helper：
  - [ ] 用 OWNMIND_SUGGEST_API_KEY env、若無 → endpoint disabled
  - [ ] prompt template：「請把這條 iron_rule 改寫成 SKILL.md 格式...」
  - [ ] 回應 server 端跑 lint、若 fail 也回給前端附 warnings
- [ ] tests/admin-iron-rule-upgrade.test.js（fake LLM stub）

---

## 12. 升級助手前端 (rc3)

- [ ] 新 admin page `/admin/iron-rule-upgrade`（看 admin static folder）：
  - [ ] List view：35 條 + format tag
  - [ ] Per-row buttons: [Suggest] [Edit] [Skip]
  - [ ] Diff view modal：左 original / 右 proposed、textarea 可編
  - [ ] [Confirm & Save] PUT 上去
- [ ] UI test（puppeteer / playwright if 既有 framework，否則 manual）

---

## 13. 文件 + 三同步 (rc3)

- [ ] CHANGELOG.md v1.18.0 條目
- [ ] README.md / docs/README.zh-TW.md / docs/README.ja.md：
  - [ ] 版號 1.17.99 → 1.18.0
  - [ ] 加段「鐵律 SKILL.md 標準化 + 本地 sync」
- [ ] FILELIST.md 新檔列入

---

## 14. Commit rc3 + 整合

- [ ] `npm test` 全綠（≥ 1140 條）
- [ ] code review
- [ ] commit
- [ ] tag v1.18.0
- [ ] push

---

## 15. Deploy + 驗證

- [ ] SSH prod：
  - [ ] git pull
  - [ ] migration（若決策 #4 = yes）：`docker compose exec -T db psql ... < db/013_iron_rule_previous_content.sql`
  - [ ] `docker compose build --no-cache api && docker compose up -d api`
  - [ ] 驗版號 → 1.18.0
- [ ] Browser 實測：
  - [ ] admin 開 /admin/iron-rule-upgrade、看 35 條列表
  - [ ] 選一條按 [Suggest]、看 diff
  - [ ] [Confirm] 一條、看 DB 寫入 + format='skill_md'
  - [ ] 開新 Claude Code session、看 ~/.claude/skills/ownmind-iron-rules/ 已建
  - [ ] AI 觸發鐵律時看是否有從 ownmind-iron-rules skill 取細節

---

## 16. 收尾

- [ ] OpenSpec proposal status: Draft → Implemented
- [ ] OwnMind memory 加 project entry「v1.18.0 鐵律 SKILL.md 標準化」
- [ ] handoff 文件（給下個 session 用）

---

## 17. Vin 手動 migration（不算開發、Vin 自己分批）

- [ ] 開 admin /iron-rule-upgrade
- [ ] 35 條 × ~1 min = 35 分鐘
- [ ] 可分多次、不想轉的留純文字（永遠 graceful）
