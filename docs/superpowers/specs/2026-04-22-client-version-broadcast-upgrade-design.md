# Client 版本 Dashboard、廣播通知、互動升級 — 設計

> 日期：2026-04-22
> 範圍：Dashboard「裝機狀況」頁 + 通用廣播通知系統 + 所有 AI 工具的互動升級流程
> 版本影響：v1.16.x → v1.17.0
> 依賴：v1.16.0 的 `collector_heartbeat` 表

## 背景

v1.16.0 上線 token 用量追蹤後，需要解決三個互相關聯的問題：

1. **Admin 看不到團隊裝機版本** — `collector_heartbeat.scanner_version` 已有資料，但 dashboard 沒露出
2. **舊版 user 不知道要升級** — 目前沒有任何推播機制，user 要自己 git pull
3. **升級流程對一般 user 太難** — 要開 terminal、跑 script、確認 launchd/systemd、手動驗證

這不是三個獨立功能，而是一條完整的 client 生命週期管理 pipeline：**看到誰舊 → 推播提醒 → AI 幫裝**。

## 系統定位

| 角色 | 需求 |
|------|------|
| Admin / super_admin | 一眼看到團隊裝機覆蓋率、誰版本落後、誰失聯；能發任意廣播訊息 |
| 落後 user | 每次進入 AI 工具都會被提醒，說「我要升級」就有 AI 幫處理，不用看 README |
| 所有 user | 能看到 admin 發的公告（維護通知、新功能、規則變更） |

---

## 範圍（功能清單）

| # | 功能 | 使用者 |
|---|------|--------|
| F1 | Dashboard「裝機狀況」頁 | admin+ |
| F2 | 通用廣播系統（admin 發任意訊息） | admin+ 發、所有 user 收 |
| F3 | 自動升級提醒（廣播系統的內建 template） | 系統產生 |
| F4 | Claude Code SessionStart hook — 啟動跳通知 | Claude Code user |
| F5 | MCP response 注入 — 首次 / 隔 4h / 版本落後時跳通知 | 所有工具 user |
| F6 | 通用升級 script（bash + PowerShell） | 所有 OS user |
| F7 | 升級後本地 + server 驗測 script | 升級後自動跑 |
| F8 | 各 AI 工具的「我要升級」skill / prompt 接線 | 所有工具 user |
| F9 | Snooze 機制（「暫緩升級」「先不要」→ 24h） | 所有 user |

---

## 核心設計決策

| # | 決策 | 選項 | 理由 |
|---|------|------|------|
| D1 | 廣播系統定位 | **通用訊息系統**，升級提醒只是內建 template | 日後維護通知、規則變更、新功能上線都能用同一套；避免為每個 use case 各做一份 |
| D2 | 版本落後判定 | Client `scanner_version` < server `SERVER_VERSION` 就算落後 | 單一 source of truth；server 升版後全員自動收到提醒（但有 snooze 緩衝） |
| D3 | 通知 Layer 1 | Claude Code SessionStart hook | 唯一有原生 hook 的工具；每次啟動強制跳 |
| D4 | 通知 Layer 2 | MCP response 注入 — 把廣播內容 **prepend 到 main response 的 `content[0].text`** 最前面（不用新增頂層欄位） | (a) 跨工具通用，不需 hook；(b) **舊版 MCP client 也看得到**（這就是主 text，不是 optional 欄位）；(c) 解決雞生蛋（舊 client 也能收到升級提醒） |
| D5 | 首次對話判定 | **每天第一次** call 該 tool 的 `ownmind_*` 算首次（day-boundary reset，Asia/Taipei）— 一律 inject（覆蓋 cooldown） | 避免「某 user 安裝後永遠只算一次首次」，也避免頻寬過度 |
| D6 | 隔久門檻 | 距離上次 MCP call **超過 4 小時** 算「隔了很久」— 一律 inject（覆蓋 cooldown） | 涵蓋午休、會議、下午茶，但過夜一定會跳 |
| D6a | Cooldown 機制 | 每則 broadcast 有 `cooldown_minutes` 欄位；同 (user, broadcast, tool) 在 cooldown 內不重複 inject。升級提醒預設 30 分鐘，一般廣播預設 1440 分鐘（一天一次）| 避免同一 session 狂 call MCP 時廣播刷屏；但 D5 / D6 條件可覆蓋 cooldown |
| D7 | Snooze 觸發詞 | user 說「暫緩升級」/「先不要」/「稍後再升級」/「skip」/「snooze」→ 24h 內不再顯示升級提醒 | 自然語言觸發（skill 負責辨識）；一般廣播不允許 snooze，升級廣播才可 |
| D8 | 升級 script 邊界 | **script 負責所有實際邏輯**（備份、pull、install、驗測、清理、回報），AI 只翻譯意圖 → 執行 script → 讀取 stdout | 避免每個工具各自實作升級邏輯；維護成本單一 |
| D9 | 升級失敗處理 | script 失敗時 stdout 印出結構化錯誤（`ERROR: <code> <指示>`），AI 負責把指示轉述給 user + 協助修復 | 讓 AI 在失敗時仍有結構可循，不會亂猜 |
| D10 | 驗測三層 | (1) 本地元件存在性（MCP binary / skill / hook） (2) Server round-trip（寫一筆測試 memory → 讀回 → 確認鐵律 trigger 有跳） (3) 清理（刪掉測試資料） | Vin 明確要求；且這個驗測模式未來可 reuse 做「健康檢查」slash command |
| D11 | 測試資料識別 | 測試 memory 的 `name` 固定為 `__upgrade_test__<timestamp>__<machine>`，`type='_test'`；僅刪這類 entry | 防止誤刪真實資料；即使清理失敗也能從 admin 手動清乾淨 |
| D12 | Snooze 資料存放 | DB 表 `user_broadcast_state (user_id, broadcast_id, tool, dismissed_at, snooze_until)`；**per-tool** 而非 global（避免在 Claude Code snooze 影響到 Codex） | Vin 要「所有工具都要跳」，但 snooze 決定要細到工具 |
| D13 | 廣播可見性過濾 | 每則 `broadcast_messages` 可設 `min_version` / `max_version` / `target_users`（NULL = 全員）；自動升級提醒 auto-populate `max_version=<current_server_version - 1>` | Vin 升 v1.17.1 時不該提醒已經在 v1.17.0 的 user 升級 |
| D14 | 舊 client 向後相容 | 因 D4 改用 text prepend，舊 client 自動看得到廣播；不需要任何 client 端升級就能收到「請升級」訊息 | 雞生蛋問題解決；v1.16 user 也能收到「升級到 v1.17」提醒 |
| D15 | 時區 | Asia/Taipei（IR-011） | 與 v1.16.0 token tracking / session_count 一致 |
| D16 | 驗測資料污染防護 | 本次驗測寫入的 test memory **不觸發任何記憶整理 / sync / admin alert**（在 memory 層加 `type='_test'` skip 邏輯） | 避免測試干擾正式資料流 |

---

## S1：DB Schema

### 新表：`broadcast_messages`（admin 發的廣播）

```sql
CREATE TABLE broadcast_messages (
  id                SERIAL PRIMARY KEY,
  type              VARCHAR(32) NOT NULL,  -- 'announcement' | 'upgrade_reminder' | 'maintenance' | 'rule_change'
  severity          VARCHAR(16) NOT NULL DEFAULT 'info',  -- 'info' | 'warning' | 'critical'
  title             VARCHAR(200) NOT NULL,
  body              TEXT NOT NULL,
  cta_text          VARCHAR(100),   -- 按鈕文字，例如「我要升級」
  cta_action        VARCHAR(100),   -- action key，例如 'upgrade_ownmind'
  min_version       VARCHAR(32),    -- 只對 client_version >= 此值 user 顯示（NULL = 不限）
  max_version       VARCHAR(32),    -- 只對 client_version <= 此值 user 顯示（NULL = 不限）
  target_users      INT[],          -- user_id array；NULL = 全員
  allow_snooze      BOOLEAN DEFAULT FALSE,  -- 是否允許 user 用「暫緩」snooze
  snooze_hours      INT DEFAULT 24,         -- snooze 時長
  cooldown_minutes  INT DEFAULT 1440,       -- D6a：同 (user, broadcast, tool) 在此期間內不重複 inject；D5/D6 可覆蓋
  starts_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at           TIMESTAMPTZ,   -- NULL = 永久
  created_by        INT NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  is_auto           BOOLEAN DEFAULT FALSE   -- 系統自動產生（例如升級提醒）
);
CREATE INDEX ix_broadcast_active ON broadcast_messages (starts_at, ends_at) WHERE ends_at IS NULL OR ends_at > NOW();
```

### 新表：`user_broadcast_state`（user × tool 的 dismiss / snooze 狀態）

```sql
CREATE TABLE user_broadcast_state (
  id                SERIAL PRIMARY KEY,
  user_id           INT NOT NULL REFERENCES users(id),
  broadcast_id      INT NOT NULL REFERENCES broadcast_messages(id) ON DELETE CASCADE,
  tool              VARCHAR(32) NOT NULL,   -- D12：per-tool
  dismissed_at      TIMESTAMPTZ,
  snooze_until      TIMESTAMPTZ,
  last_injected_at  TIMESTAMPTZ,            -- D6a cooldown：上次 inject 這則 broadcast 的時間
  UNIQUE (user_id, broadcast_id, tool)
);
CREATE INDEX ix_ubs_active ON user_broadcast_state (user_id, tool, snooze_until);
```

### 新表：`user_tool_last_seen`（首次 / 隔久判定）

```sql
CREATE TABLE user_tool_last_seen (
  user_id        INT NOT NULL REFERENCES users(id),
  tool           VARCHAR(32) NOT NULL,
  last_mcp_call_at  TIMESTAMPTZ NOT NULL,
  last_day_seen_tpe DATE NOT NULL,  -- Asia/Taipei 日期，D5 判定首次用
  PRIMARY KEY (user_id, tool)
);
```

### 現有表變更：`collector_heartbeat`（無變更）

已有 `scanner_version` / `last_reported_at` / `machine` / `status` 四個欄位，F1 直接讀即可。

### 現有表變更：`memories`（加 skip flag）

```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS ix_memories_is_test ON memories (is_test) WHERE is_test = TRUE;
```
D16：type='_test' 或 name LIKE `__upgrade_test__%` 時 is_test=TRUE，不進 sync、不 trigger 任何 alert。

---

## S2：API 設計

### F1：裝機狀況

```
GET /api/usage/admin/clients   (admin+)
  # 掛在 /api/usage/* 命名空間，與既有 /api/usage/admin/audit 一致

Response: {
  server_version: '1.17.0',              // 頂層一次，避免每 user 重複
  coverage: {
    total_users, installed, active, stale, offline, not_installed,
    needs_upgrade                        // 供 dashboard summary 直接顯示
  },
  users: [{
    user_id, user_name, email, role,
    installed,                           // bool，是否有任何 heartbeat
    any_active,                          // bool，任一 tool 在 24h 內
    needs_upgrade,                       // bool，任一 tool 版本落後
    clients: [
      { tool, version, machine, last_heartbeat_at, status, needs_upgrade }
      // status: 'active' (<24h) | 'stale' (24-48h) | 'offline' (>48h) | 'unknown'
    ]
  }]
}
```

### F2：廣播系統

```
# Admin 管理
POST   /api/admin/broadcast           super_admin   新增廣播
GET    /api/admin/broadcast           admin+        列出所有廣播（含歷史）
PATCH  /api/admin/broadcast/:id       super_admin   更新 ends_at / target_users
DELETE /api/admin/broadcast/:id       super_admin   撤銷（set ends_at=NOW()）

# User 端
GET    /api/broadcast/active?tool=X   all           取得該 user+tool 當前應顯示的廣播
POST   /api/broadcast/dismiss         all           { broadcast_id, tool, snooze_hours? }
```

### F3：自動升級提醒生成

**Server 側每日排程（03:00 Asia/Taipei）或手動觸發**：
1. 查 `SERVER_VERSION`
2. 檢查是否已有 `is_auto=true, type='upgrade_reminder', max_version=<SERVER_VERSION-1>` 的廣播
3. 沒有就插一筆：
   - title: `OwnMind v{SERVER_VERSION} 已發布`
   - body: `你的版本 {{client_version}} 落後，輸入「我要升級」讓 AI 幫你升級`
   - cta_action: `upgrade_ownmind`
   - allow_snooze: TRUE
   - snooze_hours: 24
   - max_version: `<SERVER_VERSION-1>`

### F5：MCP response 注入（改 server 的 MCP router）

所有 `ownmind_*` tool 的 response 統一經過 `injectBroadcast(response, user_id, tool)` middleware。**採用 text prepend 策略**（D4）：把廣播內容塞到 `content[0].text` 最前面，舊 client 也能看到。

```typescript
// Pseudo-code
async function injectBroadcast(resp, user_id, tool) {
  const now = new Date();
  const last = await getUserToolLastSeen(user_id, tool);
  const isFirstOfDay = !last || last.last_day_seen_tpe < today_tpe();
  const isLongGap = last && (now - last.last_mcp_call_at) > 4 * 3600 * 1000;
  const forceInject = isFirstOfDay || isLongGap || !last;  // D5/D6 覆蓋 cooldown

  upsertUserToolLastSeen(user_id, tool, now);  // 非 blocking

  // 取該 user+tool 應看到的廣播（已過濾 snooze / dismiss / version / target_users）
  const candidates = await filterVisibleBroadcasts(user_id, tool, client_version);

  // D6a cooldown 過濾：非 forceInject 時，距離上次 inject < cooldown_minutes 的廣播跳過
  const toInject = candidates.filter(bc => {
    if (forceInject) return true;
    const state = bc.user_state;
    if (!state?.last_injected_at) return true;
    const elapsed = (now - state.last_injected_at) / 60000;
    return elapsed >= bc.cooldown_minutes;
  });

  if (toInject.length === 0) return resp;

  // D4：prepend 到 main text，不新增欄位
  const broadcastText = toInject.map(bc =>
    `📢 [OwnMind ${bc.severity}] ${bc.title}\n${bc.body}` +
    (bc.cta_text ? `\n👉 說「${bc.cta_text}」讓 AI 幫你` : '')
  ).join('\n\n');

  resp.content[0].text = `${broadcastText}\n\n---\n\n${resp.content[0].text}`;

  // 更新 last_injected_at（非 blocking，避免阻塞 response）
  toInject.forEach(bc =>
    upsertUserBroadcastState(user_id, bc.id, tool, { last_injected_at: now })
  );

  return resp;
}
```

### F9：Snooze 處理

`POST /api/broadcast/dismiss { broadcast_id, tool, snooze_hours: 24 }`:
- 檢查該 broadcast `allow_snooze=TRUE` 才接受
- UPSERT `user_broadcast_state (user_id, broadcast_id, tool, snooze_until=NOW()+24h)`

---

## S3：Upgrade Script 設計

### `~/.ownmind/scripts/interactive-upgrade.sh`（Mac / Linux）

```bash
#!/bin/bash
# 結構化 stdout，每行 ^(INFO|OK|ERROR|ASK):<code>:<message>$
# AI 靠這個 prefix 判斷要怎麼跟 user 互動

set -e
STEP() { echo "INFO:$1:$2"; }
OK()   { echo "OK:$1:$2"; }
FAIL() { echo "ERROR:$1:$2"; exit 1; }
ASK()  { echo "ASK:$1:$2"; }

STEP "backup" "備份當前 ~/.ownmind 到 ~/.ownmind.bak.<timestamp>"
cp -r ~/.ownmind ~/.ownmind.bak.$(date +%Y%m%d-%H%M%S)

STEP "pull" "拉取最新 OwnMind"
cd ~/.ownmind && git pull --ff-only || FAIL "git_pull" "git pull 失敗，請確認網路或 git 狀態"

STEP "install" "重跑 install.sh --update"
bash install.sh --update || FAIL "install" "安裝失敗，見上方錯誤"

STEP "reschedule" "重新註冊排程（launchd / systemd）"
# (macOS) launchctl unload; launchctl load
# (Linux) systemctl --user daemon-reload; restart timer

STEP "verify_local" "本地驗測：MCP / skill / hook"
bash ~/.ownmind/scripts/verify-upgrade.sh --local || FAIL "verify_local" "本地驗測失敗"

STEP "verify_server" "Server 驗測：寫入/讀取/鐵律觸發"
bash ~/.ownmind/scripts/verify-upgrade.sh --server || FAIL "verify_server" "Server 驗測失敗"

STEP "cleanup" "清理測試資料"
bash ~/.ownmind/scripts/verify-upgrade.sh --cleanup || FAIL "cleanup" "測試資料清理失敗"

OK "done" "升級完成，版本：$(cat ~/.ownmind/VERSION)"
```

Windows 版 `interactive-upgrade.ps1` 一致結構，只是用 PowerShell 語法 + Task Scheduler 重註冊。

### `~/.ownmind/scripts/verify-upgrade.sh`（驗測）

```bash
#!/bin/bash
case "$1" in
  --local)
    # 1. MCP binary 存在且可執行
    test -x ~/.ownmind/mcp/server.js || FAIL "mcp_missing" "MCP server 不存在"
    # 2. Skill 檔案存在
    test -f ~/.claude/skills/ownmind-memory/SKILL.md || FAIL "skill_missing" "skill 未安裝"
    # 3. Hook 檔案存在且可執行
    test -x ~/.claude/hooks/ownmind-session-start.sh || FAIL "hook_missing"
    # 4. 版本檔有內容
    test -s ~/.ownmind/VERSION || FAIL "version_missing"
    OK "local" "本地元件都在"
    ;;
  --server)
    TEST_NAME="__upgrade_test__$(date +%s)__$(hostname)"
    # 1. 寫入 test memory（is_test=true，不觸發 sync）
    curl -X POST $OWNMIND_URL/api/memories \
      -H "Authorization: Bearer $TOKEN" \
      -d "{\"name\":\"$TEST_NAME\",\"type\":\"_test\",\"content\":\"upgrade verification\"}" \
      || FAIL "server_write" "寫入失敗，可能 token 過期"
    # 2. 讀回
    curl $OWNMIND_URL/api/memories?name=$TEST_NAME | grep -q "$TEST_NAME" || FAIL "server_read" "讀不到剛寫入的資料"
    # 3. 鐵律 trigger — 嘗試觸發一個已知鐵律（例如 write with trigger_tags=['edit']）
    curl -X POST $OWNMIND_URL/api/memories/trigger-check \
      -d '{"tool":"claude-code","trigger":"edit"}' \
      | grep -q 'iron_rule' || FAIL "iron_rule_not_triggered"
    OK "server" "連線、寫入、讀取、鐵律觸發都正常"
    ;;
  --cleanup)
    # 刪所有 __upgrade_test__ 開頭的記憶
    curl -X DELETE $OWNMIND_URL/api/memories?name_prefix=__upgrade_test__ \
      || FAIL "cleanup_failed" "請 admin 手動清理"
    OK "cleanup" "測試資料已清"
    ;;
esac
```

---

## S4：各 AI 工具的接線

### F4：Claude Code SessionStart hook

`hooks/ownmind-session-start.sh`（已存在）擴充：
```bash
# 取得廣播
BROADCASTS=$(curl -s $OWNMIND_URL/api/broadcast/active?tool=claude-code)
if [ -n "$BROADCASTS" ]; then
  echo "$BROADCASTS" | jq -r '.[] | "⚠️  [\(.severity)] \(.title)\n\(.body)\n"'
fi
```
SessionStart hook 本來就會 inject `additional context`，這段文字會出現在 user 第一次看到的訊息中。

### F5：MCP client 端不需額外處理

因 D4 的 text prepend 策略，server 直接把廣播寫到 main response 的 `content[0].text` 最前面。MCP client 端（不論版本新舊）收到什麼 response 就顯示什麼，**零修改**。這就是 D14 舊 client 相容的關鍵：「廣播就是 response 的一部分」。

### F8：各工具的 skill / prompt

**Claude Code**：skill `ownmind-upgrade`（slash command `/ownmind-upgrade` 也可）
**Codex**：在 codex system prompt 加一段規則「若 user 說『我要升級』→ 跑 `~/.ownmind/scripts/interactive-upgrade.sh`」
**Cursor / Antigravity / OpenCode / Windsurf**：放一份 `rules.md` 或 `AGENTS.md` 在 user 常開的 workspace，內容同上
**OpenClaw**：有 skill 系統（跟 Claude Code 類似），裝同一份 skill

所有工具的 skill 本體內容一致（~30 行），只是放的位置不同。

---

## S5：決策邏輯 — 哪個廣播該顯示

```
FOR EACH broadcast in active_broadcasts:
  IF broadcast.target_users IS NOT NULL AND user.id NOT IN broadcast.target_users: skip
  IF broadcast.min_version AND client_version < broadcast.min_version: skip
  IF broadcast.max_version AND client_version > broadcast.max_version: skip
  IF user_broadcast_state(user, broadcast, tool).snooze_until > NOW(): skip
  IF user_broadcast_state(user, broadcast, tool).dismissed_at IS NOT NULL: skip
  → 顯示
```

---

## S6：GIVEN / WHEN / THEN Scenarios

### Scenario A：Admin 看到團隊裝機狀況
```
GIVEN Vin 是 super_admin，團隊有 5 人，3 人裝了 v1.16 scanner，1 人 v1.15，1 人沒裝
WHEN  Vin 進 Dashboard > 裝機狀況 tab
THEN  看到 5 個 user、每人的 scanner_version、最後 heartbeat、狀態
 AND  v1.15 那人標黃色「需升級」，沒裝那人標灰色「未裝」
 AND  看到「團隊覆蓋率 60%」的警示
```

### Scenario B：Admin 發廣播
```
GIVEN Vin 是 super_admin
WHEN  Vin 進 Dashboard > 廣播管理，新增一則「本週五晚 10 點維護」廣播，target_users=NULL，allow_snooze=FALSE
THEN  廣播存入 broadcast_messages
 AND  5 分鐘內所有 user 在任何工具 call ownmind_* 都會收到這條訊息
```

### Scenario C：Server 自動產生升級提醒
```
GIVEN Server 升到 v1.17.0，有 3 個 user 仍在 v1.16
WHEN  03:00 排程 job 跑
THEN  insert 一筆 broadcast_messages (type='upgrade_reminder', max_version='1.16.x', allow_snooze=TRUE)
 AND  那 3 個 user 下次 call ownmind_* 就收到
 AND  已經升到 1.17.0 的 user 不會收到（max_version 過濾）
```

### Scenario D：User 每天第一次使用
```
GIVEN User A 昨天（Asia/Taipei）有 call 過 ownmind，今天早上第一次打開 Codex
WHEN  Codex 裡 call ownmind_search
THEN  server 判定 isFirstOfDay=TRUE
 AND  response 附上 _broadcast 欄位
 AND  Codex UI 顯示升級提醒
 AND  user_tool_last_seen 更新為今天
```

### Scenario E：User 4 小時後回來
```
GIVEN User A 早上 10:00 call 過 ownmind_get，現在是下午 2:30
WHEN  User A call ownmind_search
THEN  server 判定 isLongGap=TRUE（4.5h > 4h）
 AND  再次顯示廣播（即使今天已經看過）
```

### Scenario F：User snooze 升級提醒
```
GIVEN User A 在 Claude Code 看到升級提醒
WHEN  User A 說「暫緩升級」
 AND  skill 辨識到 snooze 意圖，呼叫 POST /api/broadcast/dismiss (snooze_hours=24)
THEN  user_broadcast_state 寫入 snooze_until=NOW()+24h, tool='claude-code'
 AND  24h 內在 Claude Code 不再看到此提醒
 AND  但在 Codex 仍會看到（per-tool snooze, D12）
```

### Scenario G：User 說「我要升級」，AI 自動完成
```
GIVEN User A 版本落後，在 Claude Code 看到升級提醒
WHEN  User A 說「我要升級」
 AND  Claude Code 觸發 ownmind-upgrade skill
 AND  skill 執行 `bash ~/.ownmind/scripts/interactive-upgrade.sh`
THEN  Claude Code 依 stdout 的 INFO/OK/ERROR 逐步回報進度給 user
 AND  所有步驟 OK 後，user 看到「升級完成，版本 v1.17.0」
 AND  user_broadcast_state 自動 dismiss 升級提醒
```

### Scenario H：升級失敗的引導
```
GIVEN User A 跑升級，但 git pull 失敗（網路問題）
WHEN  script 輸出 `ERROR:git_pull:git pull 失敗，請確認網路或 git 狀態`
THEN  AI 不該繼續跑後續步驟
 AND  AI 跟 user 說「升級卡在 git pull，可能網路有問題」
 AND  AI 提議：重新連線後再試？還是手動 cd ~/.ownmind && git pull？
 AND  user 決定 retry 後，AI 重新 call script
```

### Scenario I：升級測試資料不污染
```
GIVEN User A 升級過程寫入 test memory
WHEN  cleanup 步驟跑
THEN  所有 name LIKE '__upgrade_test__%' 的 memory 被刪
 AND  過程中不觸發 sync
 AND  memory_sync_log 沒有這筆 memory 的紀錄
```

### Scenario J：舊版 MCP client 自動收到廣播（text prepend 策略）
```
GIVEN User B 用的 ownmind MCP client 是 v1.15.x（沒有任何廣播處理邏輯）
WHEN  User B 在 Claude Code 裡 call ownmind_search
 AND  server 注入廣播到 content[0].text 最前面
THEN  v1.15 client 把整段 text 交給 Claude Code 顯示
 AND  User B 看到「📢 [OwnMind warning] 你的版本 v1.15.x 落後最新 v1.17.0...」
 AND  下面才是 search 結果
 AND  AI 自然會把前面的系統訊息先告知 User B → 雞生蛋問題解決
```

### Scenario K：Cooldown 機制防止刷屏
```
GIVEN User A 在 Claude Code 看到升級提醒（cooldown_minutes=30）
 AND  User A 在 10 分鐘內又 call 5 次 ownmind_search
WHEN  每次 call 進到 server
THEN  第一次 inject 了廣播，last_injected_at = 10:00
 AND  後續 5 次都在 10:01~10:09，elapsed < 30 min → 不 inject
 AND  10:31 再 call 一次 → elapsed > 30 min → 再次 inject
 AND  但若 10:05 正好跨日或距離上次 call 超過 4h → forceInject 覆蓋 cooldown
```

---

## S7：已知限制 / 不做的事

1. **廣播不即時 push** — 靠 user 下次 call MCP 或 SessionStart 才看到；不做 WebSocket / SSE
2. **Snooze 只到工具層** — 不做「全域 snooze」，user 換工具要重 snooze（D12）
3. **升級 script 不處理 submodule / 自訂 fork** — 若 user 有改 `~/.ownmind` 原始碼，git pull 可能 conflict，script 失敗後要 user 自己解
4. **驗測鐵律 trigger 只測一條**（`edit`），不窮舉所有鐵律；詳細測試留給 CI
5. **不支援 Windows 家用版沒 PowerShell 的情境**（已算少見）
6. **MCP response 注入只對 OwnMind MCP tool 生效**，不碰其他 MCP（例如 Figma / Gmail）
7. **廣播長度限制** body ≤ 2000 字，避免 MCP response 太長
8. **user_tool_last_seen 不做歷史** — 只保留最新一筆，不拿來做「user 活躍度」分析（那是另一個 feature）

---

## S8：版本 & 部署

- v1.17.0（跨 7 phase）
- 部署需求：
  - DB migration `008_broadcast.sql`
  - 新排程：Server side daily `nightly-upgrade-reminder.js`（03:30 Asia/Taipei，避開 token recompute 03:00）
  - Dashboard 新頁面 + 廣播管理
  - 各 AI 工具 skill / rules 檔需推到 user（靠升級流程本身 deliver，形成自動更新閉環）
- 向後相容：D14 保證舊 client 不會 crash
- Rollback：撤銷 migration + revert main branch 即可；無破壞性變更
