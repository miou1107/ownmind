---
title: 本地記憶與雲端 delta sync（A+C）
date: 2026-04-24
status: approved
owner: Vin
---

# 問題

`~/.claude/projects/<slug>/memory/*.md` 是 Claude Code 每次 session 載入的「auto memory」，但這些檔案是一次性快照：當 Vin 用 `ownmind_save` 或從 Admin UI 更新雲端記憶時，本地 md 不會自動刷新。每次 SessionStart 載入 MEMORY.md 的過期內容當 context，AI 容易根據 24 天前的快照下結論（最近實際案例：本地 `project_ownmind_p2_p5_reminder.md` 寫 P2-P5 roadmap，但雲端已推進到 token-usage-tracking 為主線）。

# 目標

讓 AI 看到的永遠是**新鮮**的雲端記憶。

# 決策

| # | 決策 | 選項 |
| - | ---- | ---- |
| 1 | Delete 處理 | **(a) 每次 sync 從雲端完整重算 MEMORY.md index** |
| 2 | 同步哪些類型 | **(b) 只同步 iron_rule / project / feedback 三類**（最痛） |
| 3 | Sync 失敗 UX | **(b) MEMORY.md 頂端插警告 + 舊內容保留** |

# 設計

## Server: `GET /api/memory/sync`

**Query params**
- `types` — 逗號分隔，預設 `iron_rule,project,feedback`。允許值只能是 memory types 列舉，其他拒 400
- `since` — ISO8601 timestamp，可選；若省略視為首次同步（回傳全部 active）

**Response**
```json
{
  "server_time": "2026-04-24T14:00:00+08:00",
  "memories": [
    {"id": 261, "type": "project", "title": "...", "content": "...", "tags": [...], "updated_at": "2026-04-21T03:58:07.682Z", "status": "active"},
    {"id": 200, "type": "project", "title": "...", "updated_at": "2026-04-10T...", "status": "disabled"}
  ]
}
```

**SQL**
```sql
SELECT id, type, title, content, tags, metadata, updated_at, status
FROM memories
WHERE user_id = $1
  AND type = ANY($2::text[])
  AND (
    ($3::timestamptz IS NULL AND status = 'active')
    OR (updated_at > $3 OR disabled_at > $3)
  )
ORDER BY updated_at DESC
```

Disabled 項目是 tombstone — client 收到要刪掉對應 md。

## Client: `hooks/lib/sync-memory-files.js`

**Input (stdin JSON)**: `{ server_time, memories }`

**Flow**
1. 取 `CLAUDE_PROJECT_DIR`（必要，未設就 exit 0 — 不是 Claude Code 情境）
2. 組 `MEMORY_DIR=$HOME/.claude/projects/<slug>/memory`（slug = project path `/` 換 `-`）
3. `mkdir -p $MEMORY_DIR`
4. 若 `MEMORY.md` 存在且無 `<!-- ownmind-auto-synced -->` marker → rename 為 `MEMORY.md.pre-sync-backup` 一次
5. For each memory：
   - 計算 filename：`<type>_<sanitized_title>.md`
   - `status='disabled'` → 若檔存在就刪除
   - `status='active'` → 寫 frontmatter `--- name, description, type, updated_at ---` + content
6. 重算 `MEMORY.md`：
   ```md
   <!-- ownmind-auto-synced at <server_time> -->
   <!-- ⚠️ last sync FAILED, local may be stale --> (只在 sync_failed 時)

   # Memory Index

   ## Iron Rules
   - [IR-001 ...](iron_rule_xxx.md) — updated 2026-04-20

   ## Projects
   - ...

   ## Feedback
   - ...
   ```
7. 寫 `~/.ownmind/.memory-last-sync` = `server_time`

## SessionStart hook 改動

`ownmind-session-start.sh` 在 init 之後加一段（非阻塞、失敗不擋）：
```bash
SINCE=$(cat "$HOME/.ownmind/.memory-last-sync" 2>/dev/null || echo "")
SYNC_DATA=$(curl -sf --max-time 4 \
  -H "Authorization: Bearer $API_KEY" \
  "${API_URL}/api/memory/sync?types=iron_rule,project,feedback${SINCE:+&since=$SINCE}" 2>/dev/null)

if [ -n "$SYNC_DATA" ]; then
  echo "$SYNC_DATA" | node "$SCRIPT_DIR/lib/sync-memory-files.js" 2>/dev/null
else
  # sync fail: 寫 fail marker 讓 node script 知道在 MEMORY.md 插警告
  node "$SCRIPT_DIR/lib/sync-memory-files.js" --fail 2>/dev/null
fi
```

## Staleness badge（C）

寫進每個 md 的 frontmatter `updated_at: <ISO>`，寫進 MEMORY.md 每行 `— updated YYYY-MM-DD`。AI 讀到某筆超過 X 天時已受鼓勵去 `ownmind_get` 拉最新（不硬擋）。

# 非目標

- 不處理 profile / principle / coding_standard 同步（init API 已載入）
- 不處理跨 project 的 memory dir 合併（一個專案一份快取）
- 不保證即時同步（只在 SessionStart 刷；同一 session 中雲端有更新不會 mid-session 刷新）

# 風險

1. **首次覆蓋使用者手寫 MEMORY.md** — mitigation: backup 到 `MEMORY.md.pre-sync-backup`
2. **CLAUDE_PROJECT_DIR 在其他 AI 工具（Cursor/Codex）可能沒設** — skip 即可，其他工具本來也沒用 Claude Code 的 auto-memory 路徑
3. **Sync endpoint 被高頻呼叫** — SessionStart 頻率 ≈ MCP heartbeat 頻率，和現有 init API 同級，不用特別 rate-limit

# 測試計畫（TDD）

- `tests/memory-sync-endpoint.test.js` — server endpoint: types whitelist、since 過濾、tombstone 回傳、auth
- `tests/sync-memory-files.test.js` — Node script 單元：寫檔、tombstone 刪檔、MEMORY.md 重算、fail 警告、backup 機制
