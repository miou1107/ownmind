---
title: Plan — 本地記憶 delta sync（A+C）
spec: 2026-04-24-local-memory-sync-design.md
date: 2026-04-24
---

# 實作順序

## P1. Server endpoint
- [ ] `src/routes/memory.js`: 新增 `GET /sync` handler（放在 `/:id` 之前，避免路由衝突）
- [ ] Types whitelist: `['iron_rule', 'project', 'feedback']` 可擴；其他值 400
- [ ] SQL: `updated_at > $since OR (disabled_at IS NOT NULL AND disabled_at > $since)` 或首次全量
- [ ] 首次（無 since）只回 active；帶 since 時 active + disabled 都回
- [ ] Response 欄位：`{ server_time, memories: [{id, type, title, content, tags, metadata, updated_at, status}] }`
- [ ] Auth: 同其他 memory endpoint，需 Bearer token

## P2. Tests: server endpoint
- [ ] `tests/memory-sync-endpoint.test.js`:
  - types whitelist 拒不合法值
  - 無 since → 只回 active
  - 有 since → 回 since 之後變化的（含 disabled）
  - auth header 必要
  - server_time 是 ISO8601

## P3. Client sync script
- [ ] `hooks/lib/sync-memory-files.js` — ES module，node --test 可 import
  - exports: `syncMemoryFiles({ memoryDir, data, last_sync_failed })`
  - CLI mode: 讀 stdin JSON or --fail flag → 呼叫 exported function
- [ ] slugify helper: `/Users/x/SourceCode/OwnMind` → `-Users-x-SourceCode-OwnMind`
- [ ] sanitize title → filename safe
- [ ] frontmatter 格式
- [ ] MEMORY.md 重算 by type grouping
- [ ] backup 機制

## P4. Tests: client sync script
- [ ] `tests/sync-memory-files.test.js` — 用 tmp dir:
  - 首次 sync 寫 md + MEMORY.md
  - 第二次 sync 含 disabled → 刪對應檔
  - 已存在的手寫 MEMORY.md 被備份
  - fail mode → MEMORY.md 插警告但不覆蓋檔
  - 多種 types 分組正確
  - filename sanitize（中文、特殊字元）

## P5. Wire SessionStart hook
- [ ] 改 `hooks/ownmind-session-start.sh`：
  - 取 last-sync timestamp
  - call sync endpoint
  - pipe 到 node script
  - fail-silent

## P6. Verification
- [ ] `node --test tests/memory-sync-endpoint.test.js tests/sync-memory-files.test.js` 全綠
- [ ] 全 test suite 不 regression: `npm test`
- [ ] 手動實測: 啟一個 OwnMind server（dev env），呼叫 sync API，用 curl pipe 到 node script，檢查 md 檔有寫入

## P7. Codex review
- [ ] Dispatch codex:codex-rescue 做 adversarial review（focus on SQL 安全、filename 安全、失敗處理）

## P8. Docs + Release
- [ ] README.md / docs/README.zh-TW.md / docs/README.ja.md 對齊（IR-032）
- [ ] FILELIST.md 新增檔案
- [ ] CHANGELOG.md v1.17.8 entry
- [ ] package.json + SERVER_VERSION 版號同步（IR-031）
- [ ] Commit + git tag v1.17.8
