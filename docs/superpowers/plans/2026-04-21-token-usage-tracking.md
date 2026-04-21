# Token 用量追蹤 — 實作計畫（v2 — 績效管理定位）

> 日期：2026-04-21（v2，adversarial review 後重寫）
> Spec：`docs/superpowers/specs/2026-04-21-token-usage-tracking-design.md`
> 版本：v1.15.4 → v1.16.0
> 預估：15–20 小時（分 9 phase）

## 執行守則

- 每 phase 完成後走品管三步驟（IR-012）：verification → code review → receive review
- IR-008：每個 commit 同步 CHANGELOG
- IR-031：合併到 main 時打 git tag
- IR-021：每個 phase 開工前 git pull
- IR-024：不加 Co-Authored-By
- Phase 之間的 commit 可 push，但 dashboard 上線（P9）前 **必須** 確認 P6 已 ship（覆蓋率強制）

---

## 依賴關係

```
P1 (DB) ──→ P2 (ingestion + aggregation)
              └──→ P3 (heartbeat + exemption)
                     └──→ P4 (Claude Code scanner)
                            └──→ P5 (Codex + OpenCode)
                                   └──→ P6 (always-on collector) ← Gate！
                                          ├──→ P7 (Cursor + Antigravity)
                                          └──→ P8 (個人 dashboard)
                                                 └──→ P9 (團隊 dashboard) ← 需先 P6
```

---

## P1：DB Migration + Pricing

**目標**：DB schema 完成，pricing 可 CRUD

### Tasks

1. `db/007_token_usage.sql` — 6 張新表 + Codex 專用欄位
   - `model_pricing`
   - `token_events`（append-only raw events）
     - **含 `cumulative_total_tokens BIGINT NOT NULL`**（D7 單調成長檢查依據，所有 Tier 1 tool 必填）
     - **含 `codex_fingerprint_material JSONB`**（Codex 專用，其他 tool NULL）
   - `token_usage_daily`（server 重算）
   - `collector_heartbeat`
   - `session_count`
   - `usage_tracking_exemption`
   - `usage_audit_log`

2. `src/routes/usage/pricing.js`
   - GET `/api/usage/pricing` — 所有 user
   - POST `/api/usage/pricing` — super_admin 新增 effective_date row

3. 初始定價插入：claude-code / codex 的 opus / sonnet / haiku / gpt-5 / gpt-5-mini

4. `tests/pricing.test.js` — CRUD + 歷史 pricing lookup

### 驗證
- DB 6 張新表存在，UNIQUE 索引正確
- `GET /pricing` 回傳正確
- Non super_admin `POST` 回 403

---

## P2：Ingestion + Aggregation

**目標**：Client 可送 raw events，server 重算 aggregate

### Tasks

1. `src/routes/usage/events.js`
   - `POST /api/usage/events`：
     - Auth（Bearer）
     - 驗證 `message_id` 和 `cumulative_total_tokens` 都 NOT NULL（Tier 1 必填），缺則 400
     - Codex 專用流程（tool='codex'）：見 P3 D13（material 必填、canonicalize、override message_id 為 expectedId）
     - Model allowlist 檢查，未知 → audit log
     - **D7 token_regression 檢查**：查 `SELECT MAX(cumulative_total_tokens) FROM token_events WHERE user_id=? AND tool=? AND session_id=?`。若新 event < max → `usage_audit_log.event_type='token_regression'`，details 含 `{ expected_min: max, actual: newCumulative }`；event 仍接收
     - Dedupe via UNIQUE (user_id, tool, session_id, message_id)
     - 寫入 `token_events`
     - Trigger aggregation job（同步執行，小 batch）

2. `src/jobs/usage-aggregation.js`
   - `recomputeDaily(userId, tool, sessionId, date)` — 從 `token_events` 重算
   - Cost 計算：查 `model_pricing` 取 effective
   - Wall / active seconds 計算
   - UPSERT `token_usage_daily`

3. `src/routes/usage/stats.js`
   - `GET /api/usage/stats`（個人）
   - Response 含 `user` 物件

4. `src/jobs/nightly-recompute.js` — 每天 3:00 AM 跑完整 recompute（處理 pricing 變更 / 漏算）

5. Tests
   - `tests/ingestion.test.js`：dedupe、validation、audit log
   - `tests/aggregation.test.js`：cost 計算、時長計算、冪等性

### 驗證
- POST 同樣 event 兩次，DB 只有一筆
- 篡改 cost 上傳 → DB cost 是 server 算的值
- Unknown model 上傳 → 進 audit log，cost=NULL
- Token 倒退 → 進 audit log

---

## P3：Heartbeat + Exemption（已移除獨立 backfill endpoint）

> D11 決策：不做獨立 backfill endpoint。`/api/usage/events` 接受任何 ts，client 靠檔案 offset 控制，server 靠 UNIQUE dedupe。首次 scan 從 offset=0 讀 → 分批送 → 成功才推進 offset。失敗永遠可續傳。

### Tasks

1. Heartbeat 邏輯加入 ingestion handler
   - UPSERT `collector_heartbeat`（last_reported_at = NOW()）
   - `scanner_version`、`machine` 一併更新

2. `src/routes/usage/exemptions.js`
   - GET / POST / DELETE — super_admin only
   - POST 要填 reason
   - DELETE 要記 audit log

3. Ingestion 對 exempt user：
   - 不寫 `token_events`
   - 寫 audit log（event_type='ingestion_suppressed_exempt'）
   - 回 200 但不 aggregate

4. Response 增強：`{ accepted: N, duplicated: M, rejected: [...] }`

5. **Codex fingerprint collision audit（D13）**
   - Server 引用 `shared/scanners/id-helper.js`（與 client 同一支）
   - Ingestion handler 對 `tool='codex'` event：
     1. **必填欄位檢查**：`codex_fingerprint_material` 缺任何 key 或值 null/undefined → 回 **400 bad_request**，寫 audit `codex_missing_material`。不做 null→0 自動填補
     2. Server 執行 `canonicalizeCodexMaterial(material)` 拿到 canonical 版
     3. Server 自己算 `expectedId = codexMessageId(session_id, canonical)`
     4. **一律用 `expectedId` 蓋掉 client 送的 message_id**（不管原值是什麼）。若 client 送的 ≠ expectedId → 額外寫 `usage_audit_log.event_type='fingerprint_mismatch'`（client 實作錯誤證據，仍接收但 insert 用 expectedId）
     5. INSERT 時 `message_id = expectedId` + `codex_fingerprint_material = canonical`
   - ON CONFLICT (UNIQUE `message_id` = `expectedId`) 時：
     - 讀既存 row 的 material（server-canonicalized）
     - 跟新進 event 的 server-canonicalized material 比對
     - 不同 → 寫 `usage_audit_log.event_type='fingerprint_collision'`，details 含兩筆 material + message_id
   - 關鍵原則：**Server 計算的 expectedId 是 唯一 truth source**，client 送的 message_id 只當「實作正確性 witness」。壞 client 永遠無法用自己的 id 雙寫
   - 增加 audit API：`GET /api/usage/admin/audit?event_type=(fingerprint_collision|fingerprint_mismatch|codex_missing_material)`（admin+）
   - 碰撞 / 錯配不 block ingestion（除了 missing material 才 block）；目的是「可觀測」

6. Tests
   - 重複送同批 events → 第二次 `duplicated = N`
   - 模擬 client 送到一半斷線 → 從失敗點續送 → 總計無 double-count
   - Exempt user 的 data 不進統計
   - **D7 token_regression**：同 session 第二筆 event 的 `cumulative_total_tokens` < 第一筆 → audit log 有 token_regression，event 仍入 DB
   - **D7 missing cumulative**：Tier 1 event 缺 `cumulative_total_tokens` → server 400 reject
   - **Canonicalize 前後 hash 一致**：ts 用 `2026-04-21T09:00:00+08:00` vs `2026-04-21T01:00:00.000Z` → canonicalize 後相同 → 同 message_id → dedupe 成功
   - **Missing material**：Codex event 缺 `reasoning` 或 `cache_creation` 欄位 → 回 400，不進 DB
   - **壞 client override**：兩筆同 canonical material，一筆 client 送錯誤 message_id=abc，一筆送正確 id=xyz → server 兩筆都用 expectedId 存 → DB 只剩一筆（dedupe 成功），audit 有一筆 fingerprint_mismatch
   - **Client-side hash 算錯**：client 送正確 material 但算錯 message_id → server 用 expectedId 蓋掉 + audit `fingerprint_mismatch`
   - **Codex 真碰撞**：構造兩筆 material 完全不同但 hash 相同 → audit log 有 fingerprint_collision 紀錄
   - **Codex cache_creation 差異**：兩筆 event 只有 `cache_creation` 不同 → message_id 不同 → 都入 DB，不誤 dedupe
   - **Codex 部分欄位差異**：兩筆 message_id 相同但只有 `input` 不同 → 必須被偵測

### 驗證
- 故意 kill 中途上傳的 client → 下次 scan 繼續送 → DB 無重複也無遺漏
- 送缺 `message_id` 的 event → 400 reject
- Exempt user 打 events → 回 200 但 stats 查不到

---

## P4：Claude Code Scanner

### Tasks

1. `shared/scanners/base.js`
   - `class Scanner { async scan() }` — 單一流程，無 first-run 分支
   - Offset 管理：`~/.ownmind/cache/scanner-offsets.json`（atomic write）
   - Batching：500 events / 10s
   - 全部 batch 成功才推進 offset；中途失敗 offset 不動

2. `shared/scanners/id-helper.js` — Codex 專用 fingerprint（D10 / D13）**client 和 server 共用同一支**
   - 匯出 `canonicalizeCodexMaterial(raw)` + `codexMessageId(sessionId, canonicalMaterial)`
   - **hash 順序關鍵**：先 canonicalize、再 hash — `message_id` 從 canonicalized material 算，不從 raw 算
   - **完整 sha256（64 hex），不截斷** — 避免截斷後碰撞在 `DO NOTHING` 時丟資料；碰撞機率 2^-256 實務不會發生
   - Canonicalize 規則：
     - ts_iso → `new Date(raw).toISOString()`（統一 ISO 8601 毫秒精度 UTC）
     - 數字欄位 null/undefined → 0；非 finite Number → 拋錯
     - 必填 key 缺 ts_iso → 拋錯
   - 必填欄位完整清單（與 schema 五個 token 欄位對應）：`ts_iso, total_cumulative, last_total, input, output, cache_creation, cache_read, reasoning`
   - **只 Codex 用**。Claude Code / OpenCode 都有 native id，直接用，不經此 helper

3. `shared/scanners/claude-code.js`
   - 掃 `~/.claude/projects/*/*.jsonl`
   - 解析每行 `type=assistant` 且 `message.usage` 非空
   - 每則訊息一個 event（不 aggregate）
   - `message_id` = JSONL 原有的 `uuid` 欄位（一定有）
   - `ts` = JSONL 的 `timestamp`
   - Source cursor: 檔案路徑 → byte_offset
   - Tier 1 欄位都填入
   - **`cumulative_total_tokens`（D7 必填）**：
     - Scanner 啟動時 **load `session_cumulative['claude-code']` map**（從 offset 檔）
     - 每 event：`new_cumulative = (map[session_id] || 0) + input + output + cache_creation + cache_read`
     - event emit 後 in-memory 更新 map[session_id] = new_cumulative
     - 整批 upload 成功後，**offset 檔同時原子寫回** byte_offset **和** session_cumulative（兩者必須一起推進，否則失同步會造成 cumulative 錯位）
     - 重啟後 load map → running total 接續，不誤報 regression

4. `hooks/ownmind-usage-scanner.js`
   - 主 entry：依序 call 各 adapter，全部走同一個 `scan()` 流程
   - 無「backfill / incremental」判斷，無 completion marker
   - 送 events + heartbeat 到 server
   - 失敗寫 `~/.ownmind/logs/scanner.log`

5. 安裝整合：`scripts/update.sh` 把 scanner + adapters 同步到 `~/.ownmind/`

6. Tests
   - Fixture JSONL 解析
   - Offset 增量行為
   - **Crash-resume**：中途 kill，下次重跑最終 DB 結果與單次完整跑一致
   - **Replay safety**：同 fixture 跑兩次，DB event 數相同，無 double-count

### 驗證
- 手動跑 scanner → DB 有 Claude Code raw events
- 第二次跑 → offset 推進，不 double count
- 跟 JSONL `/cost` 指令數字比對誤差 < 1%
- 中途 `kill -9` scanner → 下次跑沒漏沒重

---

## P5：Codex + OpenCode Scanner

### Tasks

1. `shared/scanners/codex.js`
   - 掃 `~/.codex/sessions/*.jsonl` + `~/.codex/archived_sessions/*.jsonl`
   - **Codex JSONL 的 token 資料在 `event_msg/token_count`，不是 `response_item`**（response_item 無 usage 欄位）
   - 解析策略：
     - 維護 `currentModel` 狀態：遇 `turn_context` 時從 `payload.model` 更新
     - 遇 `event_msg` 且 `payload.type === 'token_count'` 且 `payload.info.total_token_usage` 存在 → 產 event
     - 不用 `info.total_token_usage`（cumulative），**用 `info.last_token_usage` 當該 event 的 tokens**（增量；若無則跳過）
     - `session_id` = 檔名 UUID（rollout-{ts}-{uuid}.jsonl）
     - `ts` = 該行的 top-level `timestamp`
     - 先 `material = canonicalizeCodexMaterial({ ts_iso, total_cumulative, last_total, input, output, cache_creation, cache_read, reasoning })`
     - 再 `message_id = codexMessageId(session_id, material)`
     - Event payload 含 `message_id`、`codex_fingerprint_material = material`、`cumulative_total_tokens = material.total_cumulative`（D7 必填）
   - **禁止用 line_offset** — 檔案 compact/rewrite 會破壞 dedupe
   - Source cursor: 檔案路徑 → byte_offset（INT）

2. `shared/scanners/opencode.js`
   - 讀 `~/.local/share/opencode/opencode.db`（sqlite3 CLI，不加新 deps）
   - Query：
     ```sql
     SELECT id, session_id, time_created, data
     FROM message
     WHERE id > ? AND data LIKE '%"role":"assistant"%'
     ORDER BY id ASC
     ```
   - **`?` 必須是 INTEGER 型態，不是 string**
   - **cursor 名稱**：`high_water_id`（INTEGER）；全檔不出現 `last_seen_message_id` / `字典序` 等措辭
   - Offset 檔格式：
     ```json
     "opencode": { "high_water_id": 12345, "last_scan": "..." }
     ```
   - Resume 比較只用數字：`id > high_water_id`，對字串類型會造成 `"9" > "10"` 錯誤
   - Parse `data` JSON 取 tokens + cost + modelID
   - `message_id` = SQLite 的 `id`（INTEGER，轉 string 存入 server `message_id` 欄位）
   - **`cumulative_total_tokens`（D7 必填）**：
     - Scanner 啟動時 load `session_cumulative['opencode']` map（從 offset 檔）
     - 按 global `id ORDER BY id` 讀時，用 session_id → running_total map 維護**每個 session 獨立 cumulative**，**不因 session 切換 reset**
     - 每 event：`new_cumulative = (map[session_id] || 0) + input + output + cache_read + cache_write + reasoning`
     - 整批 upload 成功後 atomic 寫回 high_water_id + session_cumulative
   - 填 `native_cost_usd`（server 會 ignore，用自算）

3. 加入主 scanner 依序呼叫

4. Tests 用 fixtures 驗證
   - 各欄位對應
   - **Codex fixture** 包含 48 筆 token_count events → 全進 DB，無重複、無漏
   - **Codex 壓力測試**：同 ts 但不同 token 數 → 不同 message_id（不碰撞）
   - **OpenCode 數字 cursor**：id=9 的 event 處理完後，id=10 不會因字串比較被跳過
   - 檔案 rewrite / compact 模擬：同一 session 插入更早的行 → Codex message_id 不因位置改變而重複
   - **Scanner 重啟 cumulative resume**：跑完 session A（cumulative=100）+ session B（cumulative=50） → kill scanner → 重啟 → 新 event 進來 cumulative 從 100/50 累加，**不重置**
   - **OpenCode 交錯 session**：global id=1(A),2(B),3(A),4(B),5(A) → 每個 session 各自 running total（A: 1,3,5 累加；B: 2,4 累加），不因 session 切換 reset

### 驗證
- Codex 資料入 DB（從 `event_msg/token_count` 讀，非 `response_item`）
- OpenCode cursor 明確 INTEGER，resume 跨 id 9/10/11 正確
- 刪掉 offset 檔重跑 → DB events 數不變（靠 UNIQUE dedupe）
- 模擬 JSONL 檔尾被 truncate 再寫 → 重掃不會 double-count

---

## P6：Always-on Collector（GATE — P9 前必須完成）

> D12 決策：用 wrapper script 動態找 node，plist/service 不寫死路徑。

### Tasks

1. **Wrapper script** `scripts/install-helpers/run-scanner.sh`
   - Install 時複製到 `~/.ownmind/bin/run-scanner.sh`
   - 候選路徑順序：
     a. `~/.ownmind/.node-path`（install 時寫入）
     b. `command -v node`（當前 PATH）
     c. Glob fallback：`/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.nvm/versions/node/*/bin/node`（glob 結果**排序取最大版本**，非 OS 回傳順序）
   - **每個候選都必須通過「版本檢查」才可用**：
     - `"$NODE" --version` 能執行
     - 輸出符合 `v20+`（`MIN_NODE_MAJOR=20`，可調）
     - 版本不符 → 跳下一候選，寫 err log 註記
   - 所有候選都失敗 → exit 1 + 明確錯誤寫 err log
   - 成功選用某候選 → 在 stdout log 印 `[scanner] node=<path> version=v20.x.x`，方便 heartbeat 故障時追
   - Exit code ≠ 0 時 launchd/systemd 會有 flag，加上 log，能直接 debug

2. **Install node 偵測邏輯**（加到 `install.sh` / `install.ps1`）
   - `NODE_BIN=$(command -v node)`，驗證 `$NODE_BIN --version` 可執行
   - 無效就 fail fast，告知使用者先裝 Node 20+
   - 寫入 `~/.ownmind/.node-path`

3. macOS：`scripts/launchd/com.ownmind.usage-scanner.plist`（bash → wrapper）
   - 30 分鐘一次
   - `install.sh` 自動 `launchctl load -w ~/Library/LaunchAgents/...`
   - 安裝後跑一次測試 scan，30 秒後檢查 `~/.ownmind/logs/scanner.log` 有輸出才算成功
   - `uninstall.sh` 自動 unload + 刪 plist

4. Linux：`scripts/systemd/ownmind-usage-scanner.{timer,service}`（呼叫同一個 wrapper）
   - `install.sh` 偵測 systemd 後 `systemctl --user daemon-reload && systemctl --user enable --now`

5. Windows：`scripts/windows/register-scanner-task.ps1`
   - `Get-Command node` 偵測路徑，無則 fail fast
   - `schtasks /create` 帶入實際 node 路徑 + scanner 路徑

6. `ownmind-usage-scanner.js` 加入自我 lock（`~/.ownmind/cache/scanner.lock`）防多實例同跑

7. 文件：README 加「Always-on Collector」章節

8. Tests
   - wrapper 在沒 `.node-path` 時能 fallback 成功
   - wrapper 找不到 node 時 exit 1 + 寫 err log
   - 啟動腳本可執行

### 驗證
- Apple Silicon Mac（`/opt/homebrew/bin/node`）+ Intel Mac（`/usr/local/bin/node`）+ nvm 環境，**三種都要實測過 agent 能啟動**
- `launchctl list | grep ownmind` 有對應 agent
- 停用 Claude Code 30 分鐘，scanner 仍跑，heartbeat 更新
- 第二次手動跑 → 被 lock 擋下
- 手動移除 `.node-path` → wrapper 仍能 fallback 找到 node

---

## P7：Cursor + Antigravity（Tier 2）

### Tasks

1. `shared/scanners/cursor.js`
   - 讀 `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
   - Query `telemetry.currentSessionDate / lastSessionDate`
   - 產 `session_count` record（無 token）

2. `shared/scanners/antigravity.js`
   - 讀 Session Storage 最新 mtime
   - 或讀 state.vscdb telemetry
   - 產 `session_count` record

3. Server 端 `POST /api/usage/events` 接收 `sessions` array，寫入 `session_count` 表

### 驗證
- Cursor / Antigravity 在 DB 有 session_count 記錄
- Dashboard 明確標示「無 token 資料」

---

## P8：個人 Dashboard

### Tasks

1. `src/public/index.html` 新增「用量」頁籤（非 admin）

2. 卡片：
   - 今日 / 本週 / 本月 cost
   - 工時（wall / active 可切）
   - Session 數
   - Tracking status（啟用 / 豁免 / 心跳異常）

3. 圖表：
   - 每日 cost line，stack by tool
   - 每日工時 bar（wall vs active）

4. 表格：
   - Session 列表，可下鑽看 events

5. 篩選：date range, tool

### 驗證
- 瀏覽器實測數字跟 DB 一致
- Tracking 豁免時 badge 正確顯示

---

## P9：團隊 Dashboard + Pricing 管理 + Audit Log（GATE — 需 P6 完成）

### Tasks

1. `src/public/index.html` 新增「團隊用量」頁籤（admin+ 可見）

2. **頂部 coverage panel**（必備）：
   ```
   📊 覆蓋率：10 位成員中 8 位活躍
   ⚠️  2 位未回報：Alice, Bob
   ✋ 1 位已豁免：Charlie
   ```

3. Coverage < 80% 時加浮水印「資料不完整」

4. 內容：
   - 每日總量 line（stack by user）
   - 排行榜（sort by cost / tokens / hours）
   - Tool 分佈圓餅
   - User 詳細頁：下鑽看個人

5. **Pricing 管理** 子頁（super_admin）
   - 列出所有 pricing
   - 新增 effective_date row（不能刪）

6. **Audit log** 子頁（admin+）
   - 最近 100 筆異常 events
   - 可依 event_type 篩選

### 驗證
- super_admin 看得到所有 user 數據
- admin 看得到 team 但不能改 pricing
- user 看不到團隊頁
- Coverage panel 正確顯示失蹤 user

---

## Worktree 策略

**建議另開新 worktree**：`vin/token-usage-tracking`（用 superpowers:using-git-worktrees）

理由：
- 預估 9 phase，可能跨多天，需要乾淨工作區
- P1–P3 純後端可並行其他工作
- P4 開始依賴 scanner 測試，可能改 iron-rule-check 等現有 hook
- 完整 feature 合併回 main 用一個 PR

Branch 命名：`vin/token-usage-tracking`
每 phase 一個 commit，方便 revert。

---

## 首次上線流程

1. P1–P3 後端 ship 到 prod（沒有 client 時無影響）
2. P4–P5 Vin 自己先試用，看本機資料能不能正確上傳
3. P6 先在 Vin 的 Mac 安裝 launchd agent，觀察 1 週
4. P7 Cursor/Antigravity scanner 加進來
5. P8 個人 dashboard 全團隊 opt-in 測試（但不啟用團隊頁）
6. P6 確認無 gap 後 P9 才上線團隊 dashboard
7. 團隊成員需要重跑一次 `install.sh` 啟用 always-on collector

---

## Rollback

- DB：`DROP TABLE token_events, token_usage_daily, collector_heartbeat, session_count, usage_tracking_exemption, usage_audit_log, model_pricing`
- Scanner：移除 `~/.ownmind/hooks/ownmind-usage-scanner.js` + 相關 adapter
- launchd / systemd / Task Scheduler：uninstall 腳本
- API：註解 `src/app.js` 的 `/api/usage` 掛載
- 緊急停收：`POST /api/usage/admin/pause`（要新增，super_admin 可用）— 本期先不做，靠 code 部署即可
