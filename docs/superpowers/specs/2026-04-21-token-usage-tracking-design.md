# Token 用量追蹤與團隊績效 Dashboard 設計

> 日期：2026-04-21（v2 — adversarial review 後重寫）
> 範圍：跨 IDE 用量、成本、工時的「可信任」追蹤與團隊績效管理
> 版本影響：v1.15.4 → v1.16.0

## 背景

Vin 需要從 dashboard 掌握團隊成員在 7 種 AI IDE 的用量、成本、工時，用於**績效管理**。

這個定位（management/performance measurement）比一開始設想的「advisory self-observation」嚴格很多。經 Codex 對抗性審查，v1 的信任模型、覆蓋率、opt-out 都不足以支撐績效決策。v2 做根本性重構。

## 系統定位（決定信任模型）

**定位：管理用 / 績效評估系統**

| 意涵 | 實作要求 |
|------|---------|
| 資料要防偽 | Client 只轉送原始 event，Server 端重算所有 aggregate 和 cost |
| 覆蓋率要可量測 | Heartbeat 機制，admin 看得到誰失蹤 |
| 不允許隱形 opt-out | 無法在本地關閉，由 server 端管理（super_admin 可為個別 user 啟用） |
| 歷史資料可用 | 單一 ingestion path：offset 不存在就從 0 開始，與後續 scan 共用完全相同的 code path。**不宣稱「零遺漏」保證**——實際保證只有：dedupe + retry + 可觀測的 coverage panel。殘餘 gap 靠 audit log 偵測 |

---

## 範圍（已驗證 token 可取得性）

| IDE | 支援度 | 資料來源 |
|-----|--------|---------|
| **Claude Code** | Tier 1（完整 token + 成本） | `~/.claude/projects/*/*.jsonl` 每則 message 的 usage |
| **Codex** | Tier 1 | `~/.codex/sessions/*.jsonl` 的 `event_msg` 且 `payload.type=='token_count'`；model 從 `turn_context.model` 取；**無 native id**，fingerprint 見 S4 |
| **OpenCode** | Tier 1（token；cost 為 advisory） | `~/.local/share/opencode/opencode.db` SQLite message.data |
| **Cursor** | Tier 2（session 數 + 活躍時長） | `state.vscdb` telemetry marker + 檔案 mtime |
| **Antigravity** | Tier 2 | Electron Session Storage + 檔案 mtime |
| **Copilot** | 不支援 | 需要 GitHub org admin，Vin 不是 |

---

## 核心設計決策

| # | 決策 | 選項 | 理由 |
|---|------|------|------|
| D1 | 信任邊界 | Client 送 raw event，Server 重算 aggregate | 績效管理必須防偽，client 不可信 |
| D2 | Cost 計算 | 全部 server-side 重算（OpenCode native cost 只當 advisory） | 禁止 client 左右成本數字 |
| D3 | Opt-out | managed account 無 local opt-out；super_admin 可為個別 user 在 server 端設定 | 透明 + 強制 |
| D4 | 歷史資料處理 | 首次 scan 從 offset=0 讀歷史，走**單一 ingestion path**（與後續增量完全相同），無特殊 mode 或 state | 實作簡單統一、避免 backfill-vs-incremental 分支架構被重建。保證程度 = dedupe + retry，不宣稱零遺漏 |
| D5 | 覆蓋率 | Collector heartbeat + admin coverage panel | 缺資料不能 silent |
| D6 | Always-on collector | P7（launchd / systemd / Task Scheduler）升為必做 | 不能依賴「user 主動開 Claude Code」 |
| D7 | Token 單調成長驗證 | `token_events.cumulative_total_tokens` 為必填欄位。Ingestion 時 server 查同 `(user_id, tool, session_id)` 的 `MAX(cumulative_total_tokens)`，新 event 若小於歷史 max 則寫 `usage_audit_log.event_type='token_regression'`（仍接收，供稽核分析）| 偵測 client 端篡改。所有 Tier 1 都有 cumulative（Codex 原生有；Claude Code / OpenCode 由 scanner 維護 running total）|
| D8 | Model allowlist | 只收 `model_pricing` 表內的 model，未知 model 標 suspicious 入 audit log | 防止假 model name |
| D9 | 時區 | Asia/Taipei（IR-011） | 與現有 report 一致 |
| D10 | message_id 產生 | Claude Code / OpenCode 用 native id；Codex 無 native id，用 `codexMessageId(...)` = **full `sha256`（64 hex，不截斷）** of `tool + session_id + ts_iso + total_cumulative + last_total + input + output + cache_creation + cache_read + reasoning`（見 S4）| 保證 UNIQUE dedupe 可靠。**完整 sha256 碰撞機率 2^-256 實務上不會發生**，避免截斷版本會在真碰撞時 `DO NOTHING` 永久丟資料。Codex 殘餘 collision 風險仍靠 D13 audit 偵測（理論保險）|
| D13 | Fingerprint collision audit | 每筆 Codex event 在 `token_events` 持久化完整 `codex_fingerprint_material`（JSONB）。ON CONFLICT 時，server 比對**既存 row 的 server-canonicalize material** vs **新進 event 的 server-canonicalize material**；不同即寫 `usage_audit_log.event_type='fingerprint_collision'`，附兩筆 material snapshot。Canonicalization 規則（ts 統一 ISO 8601 毫秒精度、null→0、key 排序）由 server 執行，不信任 client | Codex 無 native id，48-event 實證不代表所有情境都 unique；碰撞可監控可追溯。Audit 比對僅依賴 server-persisted 資料，client 材料只當輸入不當 truth source |
| D11 | Ingestion 單一路徑 | **只有一個 `/api/usage/events` endpoint** — 首次與後續 scan 共用同一 code path、同一 offset store；client 端無 `first_run` 分支、無 completion marker；server 靠 UNIQUE (user_id, tool, session_id, message_id) 冪等 | 任何故障點都可 resume；不會因為 completion state 與實際資料脫勾而產生永久 gap |
| D12 | macOS Node 路徑 | install.sh 偵測實際 `node` 位置，寫入 plist；安裝後驗證可執行 | 避免 `/usr/local/bin/node` 在 Apple Silicon / nvm 環境 404 |

---

## S1：DB Schema

**原則：Raw events 不可變，aggregate 可重算**

```sql
-- Model 定價（支援歷史價格）
CREATE TABLE model_pricing (
  id SERIAL PRIMARY KEY,
  tool VARCHAR(32) NOT NULL,
  model VARCHAR(128) NOT NULL,
  input_per_1m NUMERIC(10,4),
  output_per_1m NUMERIC(10,4),
  cache_write_per_1m NUMERIC(10,4),
  cache_read_per_1m NUMERIC(10,4),
  effective_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_model_pricing ON model_pricing (tool, model, effective_date);

-- Raw events — 每則訊息一筆，不可變（append-only）
-- Client 只負責轉發這張表的資料，不做任何 aggregation
-- message_id 強制 NOT NULL 以確保 UNIQUE dedupe 正確（PostgreSQL NULL 不會觸發 UNIQUE 衝突）
CREATE TABLE token_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  tool VARCHAR(32) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  message_id VARCHAR(128) NOT NULL,   -- client 端穩定 id，必填；若原始來源無 id 則用 synthetic hash（見下）
  model VARCHAR(128),
  ts TIMESTAMPTZ NOT NULL,            -- 原 message 時間
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  cache_creation_tokens INT DEFAULT 0,
  cache_read_tokens INT DEFAULT 0,
  reasoning_tokens INT DEFAULT 0,
  native_cost_usd NUMERIC(10,6),      -- OpenCode 帶的，僅供比對
  source_file VARCHAR(512),           -- 哪個檔案讀出來的（debug 用）
  cumulative_total_tokens BIGINT,     -- D7 單調成長檢查依據（所有 Tier 1 tools 必填）
                                      -- Codex: event_msg/token_count 的 total_token_usage.total_tokens
                                      -- Claude Code: 累加到此 event 的 session 總 tokens（scanner 維護 running total）
                                      -- OpenCode: 同上；SQLite 無原生 cumulative 欄位，scanner 計算
  codex_fingerprint_material JSONB,   -- Codex 專用（其他 tool NULL），D13 audit 依據
                                      -- canonical 格式：{ ts_iso, total_cumulative, last_total,
                                      --                 input, output, cache_creation, cache_read, reasoning }
                                      -- null / 0 / timestamp 格式統一由 server canonicalize
  ingested_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, tool, session_id, message_id)   -- dedupe（靠 NOT NULL 保證生效）
);
CREATE INDEX ix_token_events_user_day ON token_events (user_id, ts);
CREATE INDEX ix_token_events_session ON token_events (tool, session_id);

-- Aggregated 每日統計（由 server 從 token_events 重算）
-- Materialized view 或定時 rebuild
CREATE TABLE token_usage_daily (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  tool VARCHAR(32) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  date DATE NOT NULL,
  model VARCHAR(128),
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_creation_tokens BIGINT,
  cache_read_tokens BIGINT,
  reasoning_tokens BIGINT,
  message_count INT,
  cost_usd NUMERIC(10,6),            -- 全部 server 重算
  wall_seconds INT,
  active_seconds INT,
  first_ts TIMESTAMPTZ,
  last_ts TIMESTAMPTZ,
  recomputed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, tool, session_id, date)
);
CREATE INDEX ix_tud_user_date ON token_usage_daily (user_id, date DESC);

-- Collector 心跳表
CREATE TABLE collector_heartbeat (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  tool VARCHAR(32) NOT NULL,
  last_reported_at TIMESTAMPTZ NOT NULL,
  last_event_ts TIMESTAMPTZ,          -- 這個 tool 最新 event 的原始 ts
  scanner_version VARCHAR(32),
  machine VARCHAR(128),
  status VARCHAR(16) DEFAULT 'active', -- active, stale, opted_out
  UNIQUE (user_id, tool)
);

-- Session 計數（Tier 2 的 Cursor/Antigravity 用；Tier 1 從 token_usage_daily 推算）
CREATE TABLE session_count (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  tool VARCHAR(32) NOT NULL,
  date DATE NOT NULL,
  count INT DEFAULT 1,
  wall_seconds INT DEFAULT 0,
  UNIQUE (user_id, tool, date)
);

-- User opt-out（super_admin 管理）
-- 無此列 = 強制追蹤；有此列 = 暫停追蹤
CREATE TABLE usage_tracking_exemption (
  user_id INT PRIMARY KEY REFERENCES users(id),
  granted_by INT REFERENCES users(id),
  reason TEXT,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- Audit log — 記錄異常 ingestion
CREATE TABLE usage_audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  tool VARCHAR(32),
  event_type VARCHAR(32),            -- unknown_model, token_regression, rate_anomaly
  details JSONB,
  ts TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ix_audit_user ON usage_audit_log (user_id, ts DESC);
```

---

## S2：API 設計

### POST /api/usage/events（raw 轉發）

Client scanner 只送原始 event，不 aggregate。
`message_id` 必填（D10）：
- **Claude Code** → JSONL `uuid` 欄位（native）
- **OpenCode** → SQLite `message.id`（native integer 轉 string）
- **Codex** → `codexMessageId(...)`（見 S4，含完整 token breakdown）

Codex event 另需附 `codex_fingerprint_material`（完整 canonical material，見 D13），供 server audit。

```json
{
  "events": [{
    "tool": "claude-code",
    "session_id": "d86d1459-...",
    "message_id": "msg_abc123",         // 必填，dedupe 用
    "model": "claude-opus-4-7",
    "ts": "2026-04-21T09:00:00+08:00",
    "input_tokens": 6,
    "output_tokens": 1163,
    "cache_creation_tokens": 59352,
    "cache_read_tokens": 0,
    "cumulative_total_tokens": 60521,   // D7 必填，所有 Tier 1 tool 都要送
    "native_cost_usd": null,
    "source_file": "project.jsonl"
  }],
  "heartbeat": {
    "tool": "claude-code",
    "scanner_version": "1.16.0",
    "machine": "vin-mac"
  }
}
```

Server 端：
1. 驗證 `message_id NOT NULL` 和 `cumulative_total_tokens NOT NULL`（Tier 1 必填），否則 400 reject
2. Codex 專用流程（若 `tool='codex'`）：見 S4 D13 — 驗 material、canonicalize、override message_id 為 expectedId
3. Model 驗證：查 `model_pricing`，找不到記 `unknown_model` 到 audit log，但仍接收 event（cost 會是 NULL）
4. **單調成長檢查（D7）**：對 `(user_id, tool, session_id)` 查 `MAX(cumulative_total_tokens)`。新 event 的 `cumulative_total_tokens` 若 < 該 max，寫 `usage_audit_log.event_type='token_regression'`（details 含 expected_min / actual）。仍接收 event（供稽核），但資料會進入 aggregation
5. Dedupe：`INSERT ... ON CONFLICT (user_id, tool, session_id, message_id) DO NOTHING`
6. 更新 `collector_heartbeat`
7. Trigger aggregation job（見 S3）
8. Response 200 含 `{ accepted: N, duplicated: M }` 讓 client 知道本批結果

### Ingestion 單一路徑（D11）

**沒有 backfill endpoint，也沒有 first-run 分支**。所有 scan（含首次安裝）都透過 `/api/usage/events` 提交，靠 `UNIQUE (user_id, tool, session_id, message_id)` 冪等：

```
所有 scan 共用流程：
  1. 讀本地 offset（不存在 = 從頭）
  2. 從該 offset 讀資料，parse 成 events
  3. 分批 POST /api/usage/events（每批 500 筆）
  4. 任何一批失敗就 abort，offset 不推進 → 下次從同一位置重送
  5. 全部批次成功後原子寫入新 offset
  6. 送 heartbeat

Dedupe 純粹靠 UNIQUE；offset 僅作為 client 端讀取進度，server 永不信任。
```

Client 端 offset 檔格式：

```json
{
  "claude-code:/abs/path/project.jsonl": { "byte_offset": 12345, "last_scan": "..." },
  "codex:/abs/path/session.jsonl": { "byte_offset": 6789, "last_scan": "..." },
  "opencode": { "high_water_id": 12345, "last_scan": "..." },

  "session_cumulative": {
    "claude-code": {
      "d86d1459-...": 60521,
      "a1b2c3d4-...": 12388
    },
    "opencode": {
      "sess_abc123": 45200,
      "sess_def456": 8900
    }
  }
}
```

**session_cumulative 規則（解決 scanner 重啟）**：
- Key = `tool` → `{ session_id: last_emitted_cumulative_total }`
- Scanner **啟動時 load**、**每 event emit 後 in-memory 更新**、**批次 upload 成功後一併 atomic 寫回**
- OpenCode 按 global `id` 讀時，用這個 map 維護**每個 session 獨立 cumulative**，不因 session 切換 reset
- Claude Code 同理（per-file 讀但 cumulative by session_id）
- 新 event 的 `cumulative_total_tokens` = `(map[session_id] || 0) + event_tokens`，然後 update map
- 重啟後：map 從檔案 load → running total 恰好接上，不會誤報 regression
- Codex 不需要這個 map（它有原生 total_token_usage.total_tokens）

### GET /api/usage/stats（個人）

Query: `from`, `to`, `group_by=day|tool|model|session`

### GET /api/usage/team-stats（admin+）

Response 必須包含 `coverage`：

```json
{
  "period": { "from": "...", "to": "..." },
  "coverage": {
    "total_users": 10,
    "reporting_today": 8,              // 24h 內有 heartbeat
    "stale": 1,                         // 48h+ 無 heartbeat
    "opted_out": 1,                     // 有 exemption 紀錄
    "per_tool": {
      "claude-code": { "reporting": 7, "stale": 2 },
      ...
    }
  },
  "data": [...]
}
```

Dashboard 必須在頂部顯示 coverage 狀態，團隊比較前要提醒「N 個 user 未回報，數據不完整」。

### /api/usage/admin/exemptions（super_admin only）

CRUD 管理 `usage_tracking_exemption` 表。

### /api/usage/pricing（super_admin for PUT）

GET 所有 user 可呼叫，PUT 僅 super_admin。

---

## S3：Server-side Aggregation Job

**為何在 server 做**：D1 決策 — 不信任 client 的 aggregate

```
每次 /api/usage/events 成功 ingest 後：
  1. 找出該批次涉及的 (user_id, tool, session_id, date) 組合
  2. 對每個組合，從 token_events 重新 SUM / COUNT / MIN / MAX
  3. 計算 cost:
     - 查 model_pricing WHERE tool=? AND model=? AND effective_date <= date
       ORDER BY effective_date DESC LIMIT 1
     - cost = input/1M * input_per_1m + output/1M * output_per_1m + ...
  4. 計算 wall_seconds = EXTRACT(EPOCH FROM (last_ts - first_ts))
  5. 計算 active_seconds:
     SELECT ts FROM token_events WHERE session_id=? ORDER BY ts
     → 相鄰差 ≤ 600s 的累加
  6. UPSERT token_usage_daily
```

設計為「冪等」：重新執行不會 double count。

備援：每天 3:00 AM 跑一次完整 recompute（處理定價變更、漏算）。

---

## S4：Scanner（Client 端僅轉發）

**單一 ingestion 路徑**：所有 scan 走同一支 code，讀 offset → 讀資料 → 送 `/api/usage/events` → 成功才推進 offset。沒有「首次 vs 後續」區分，沒有 completion marker。

```
shared/scanners/
├── base.js              # Scanner interface + heartbeat + offset 管理
├── id-helper.js         # codexMessageId() — Codex 專用 fingerprint（唯一需要的 source）
├── claude-code.js       # JSONL → raw events
├── codex.js             # JSONL → raw events
├── opencode.js          # SQLite → raw events
├── cursor.js            # state.vscdb → session_count only
└── antigravity.js       # Session Storage → session_count only
```

**核心規則**：
- 不做 aggregation — 每則訊息一個 event
- 不做 first-run 特殊處理 — offset 未知 = 從頭開始，有 offset = 從那裡開始
- Batching：每 500 events 或 10 秒送一次
- 每次 scan 結束都送 heartbeat（即使沒新 event）
- 不再支援 local opt-out sentinel（D3）

**Offset 管理（單一流程）**：

```js
// 任何 scan（首次或第 N 次）都走這條
async function runScanner(adapter) {
  const offset = readOffset(adapter.source_key) ?? adapter.initialOffset();  // undefined → 從頭
  const { events, nextOffset } = await adapter.readSince(offset);

  for (const batch of chunk(events, 500)) {
    const resp = await postEvents(batch);               // server UNIQUE 做 dedupe
    if (!resp.ok) throw new Error(`batch failed`);      // 不推進 offset，下次重送
  }

  writeOffsetAtomic(adapter.source_key, nextOffset);     // 全部成功才推進
  await postHeartbeat(adapter.tool);
}
```

失敗就下次重跑；送出的 events 已經在 server UNIQUE 擋了重複；新的 offset 只在整批成功後才寫入。無論什麼時機、什麼故障點介入，最終收斂到「server 擁有 ≥ 本地 offset 以前所有 events」。

**Cursor 與 message_id 規則**：

| 來源 | source offset（local，只給 client 用）| event id（server UNIQUE key 一部分）|
|------|--------------|---------------|
| Claude Code JSONL | 檔案路徑 → byte_offset（INT）| 原 JSON 的 `uuid` 欄位（每則必有，native） |
| Codex JSONL | 檔案路徑 → byte_offset（INT）| **無 native id**；用 `codexMessageId(...)` = **full `sha256`（64 hex 不截斷）** of `tool + session_id + ts_iso + total_cumulative + last_total + input + output + cache_creation + cache_read + reasoning`（見下方 id-helper.js）|
| OpenCode SQLite | 全域 → `high_water_id`（**INTEGER**，SQLite `message.id` rowid）| `message.id`（原生 INTEGER，直接當 string 存 message_id 欄位）|
| Cursor / Antigravity | 每日 session marker 的 mtime | N/A（只記 session_count）|

**硬性要求**：
- `message_id` 必須能從 event 內容 deterministic 推出，**不能依賴檔案位置**（byte_offset、line_offset）
- OpenCode resume 規則：`WHERE id > ? ORDER BY id ASC`，其中 `?` 是 **integer**，不是 string。cursor 存取必須用數字型態。Invariant：「resume 比較只用數字，無字典序」
- 同一筆 event 在不同掃描中產生的 `message_id` 必須相同

### Codex fingerprint 設計

Codex JSONL **無 native message_id**，所以 message_id 只能用 content-based fingerprint。

**設計公式**（見下方 `codexMessageId`）：
`sha256(tool + session_id + ts_iso + total_cumulative + last_total + input + output + cache_creation + cache_read + reasoning)` — **完整 64 hex，不截斷**

**必須涵蓋 schema 所有 cost-relevant token 欄位**（`token_events` 表有 `input/output/cache_creation/cache_read/reasoning` 五個 token 欄位），否則若兩 event 只差 cache_creation 會產生同 hash。

**為什麼這個組合**：
- `session_id`：跨 session 隔離
- `ts_iso`（毫秒精度）：時間點鑑別
- `total_cumulative`：cumulative 序列，同 session 內多為嚴格遞增
- `last_total`：該次增量的 total tokens
- `input/output/cache_creation/cache_read/reasoning`：完整 token breakdown（schema 所有 cost-relevant token 欄位）

**實證結果**：單一 fixture 48 個 token_count events → 48/48 unique。若只用 `total_cumulative` 單獨判別則 37/48（會碰撞，因 Codex 有時發 token_count 但 total 無變化）。

**誠實聲明殘餘風險**：
- 48/48 只是**單一樣本觀察**，不是數學證明
- 理論碰撞情境：同一毫秒發兩個 token_count 且 total/last/所有 token fields 完全相同（極罕見，但不是零）
- 某些情境下 Codex 可能輸出 `last_token_usage = null` → 必須對這類事件走 fallback 或 reject 流程（實作時決定）

**偵測機制（D13）**：

**Client scanner 流程**（Codex 專用）：
1. 從 JSONL parse 出 raw 欄位（ts, token breakdown…）
2. `material = canonicalizeCodexMaterial(raw)` ← **先 canonicalize**
3. `message_id = codexMessageId(session_id, material)` ← **從 canonicalized material 算 hash**
4. Event payload 含 `message_id` + `codex_fingerprint_material=material`

**Server 流程**（POST /api/usage/events）：
1. 若 `tool='codex'` 且缺任何 fingerprint 欄位 → 回 **400 bad_request**（不做 null→0 自動填補）
2. Server 對 client 送來的 material 執行 `canonicalizeCodexMaterial`
3. Server 自己算 `expectedId = codexMessageId(session_id, canonical)`
4. **Override**：不管 client 送什麼 `message_id`，一律用 `expectedId` 蓋掉。若原 client 送的 message_id ≠ expectedId，額外寫 `usage_audit_log.event_type='fingerprint_mismatch'`（client 實作錯誤的證據），但 insert 永遠用 `expectedId`
5. 把 **server canonicalize 過的 material** 存入 `token_events.codex_fingerprint_material`（不直接存 client 的 raw）
6. ON CONFLICT (UNIQUE `message_id` = `expectedId`)：
   - 讀既存 row 的 server-stored material
   - 跟新進 event 的 server-canonicalize material 比對
   - 不同 → 寫 `usage_audit_log.event_type='fingerprint_collision'`，附兩筆 material + message_id
7. 比對與 insert 的 message_id 來源永遠是 server 計算，client 只當輸入不當 truth source

**效益**：
- Canonicalize 在 hash **之前**，client 格式飄動不破壞 UNIQUE（真正 dedupe 保證）
- 真碰撞看得見（完整 material 都存 + 完整比對）
- 格式差異不誤報（canonicalize 吸收）
- Partial material 被 hard reject（不污染 stored truth）
- 升級空間：日後可從 audit log 回溯真碰撞模式

### id-helper.js — canonicalize 優先，hash 吃 canonical 輸出

**關鍵原則**：`message_id` 必須從 **canonicalized** material 計算，絕不用 raw client 輸入直接 hash。否則 client 格式飄動（ts 精度、null 表示、數字型別）會產生不同 hash，繞過 UNIQUE 雙寫。

`shared/scanners/id-helper.js`（client 和 server 共用同一支檔）：

```js
import crypto from 'crypto';

/**
 * Canonicalize Codex fingerprint material — client 和 server 必須用同一份
 *   - ts_iso 解析並重 format 為 ISO 8601 毫秒精度 UTC（例：2026-04-21T09:00:00.000Z）
 *   - null / undefined → 0（數字欄位）或拋錯（必填 key）
 *   - 數字欄位強制為 integer
 *   - JSON.stringify 時 key 按字母排序
 * 若任一必填 key 缺失，拋 Error（上層決定 client reject 還是 server 400）
 */
export function canonicalizeCodexMaterial(raw) {
  const required = ['ts_iso', 'total_cumulative', 'last_total',
                    'input', 'output', 'cache_creation', 'cache_read', 'reasoning'];
  const out = {};
  for (const k of required) {
    if (raw[k] === undefined || raw[k] === null) {
      if (k === 'ts_iso') throw new Error(`canonicalize: missing required ${k}`);
      out[k] = 0;  // 數字欄位：null/undefined → 0
    } else {
      out[k] = k === 'ts_iso'
        ? new Date(raw[k]).toISOString()
        : Math.trunc(Number(raw[k]));
    }
    if (k !== 'ts_iso' && !Number.isFinite(out[k])) {
      throw new Error(`canonicalize: invalid ${k}=${raw[k]}`);
    }
  }
  return out;
}

/**
 * Codex 專用 message_id — 從 canonicalized material 算出
 * Client 和 server 任一方都應該能用同一 material 算出同一個 id
 */
export function codexMessageId(sessionId, canonicalMaterial) {
  const m = canonicalMaterial;
  const payload = [
    'codex', sessionId, m.ts_iso,
    m.total_cumulative, m.last_total,
    m.input, m.output, m.cache_creation, m.cache_read, m.reasoning
  ].join(':');
  // 使用完整 sha256 hex（64 字），不截斷
  // 理由：截斷後碰撞空間縮小，collision 時 DO NOTHING 會永久丟資料
  //      完整 sha256 的碰撞機率 2^-256，實務上不會發生
  //      token_events.message_id VARCHAR(128) 足以容納
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * 用法範例（client scanner）：
 *   const material = canonicalizeCodexMaterial({ ts_iso, total_cumulative, ... });
 *   const message_id = codexMessageId(sessionId, material);
 *   events.push({ ..., message_id, codex_fingerprint_material: material });
 */
```

**硬性規則**：
- **Codex event 缺任何 fingerprint 欄位 → server 回 400**（不做 null→0 自動填補）。這防止舊/壞 client 把 partial material 當作 truth 存進 DB 污染 audit
- **`canonicalizeCodexMaterial` 是唯一 canonical 來源**。client scanner 算 hash 前必須先 canonicalize；server 接到時重新 canonicalize 驗證結果一致（若 client 做錯了 server 自己算正確的）
- **Schema 驗證**：`POST /api/usage/events` 遇 Codex event 時執行 JSON schema 檢查 + 必填欄位檢查，失敗即 400

其他 Tier 1 來源（Claude Code / OpenCode）**都有 native id**，不需要 synthetic hash。
Codex 是目前已知唯一需要 fingerprint 的情境。

---

## S5：Always-on Collector

**D6：P7 升為必做**

### macOS — launchd agent

採 **wrapper script** 策略（D12）：plist 指向固定路徑的 shell script，shell 再自己找 node。不寫死 Node 路徑。

`~/.ownmind/bin/run-scanner.sh`（install.sh 生成，可執行）：

```bash
#!/bin/bash
# 動態找 node + 驗版本，避免跑到過舊的 runtime
MIN_MAJOR=20
ERR_LOG="$HOME/.ownmind/logs/scanner.err"
OUT_LOG="$HOME/.ownmind/logs/scanner.log"
mkdir -p "$HOME/.ownmind/logs"

# 候選：install 記錄的 path → PATH 裡的 node → 常見位置（按版本排序取大者）
candidates=()
[ -f "$HOME/.ownmind/.node-path" ] && candidates+=("$(cat "$HOME/.ownmind/.node-path")")
if cmd_node="$(command -v node 2>/dev/null)"; then candidates+=("$cmd_node"); fi
for p in $(ls -1 /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null) \
         $(ls -1d "$HOME/.nvm/versions/node"/*/bin/node 2>/dev/null | sort -rV); do
  candidates+=("$p")
done

# 找第一個版本合格的
NODE_BIN=""
for c in "${candidates[@]}"; do
  [ -x "$c" ] || continue
  ver="$("$c" --version 2>/dev/null)"
  major="$(echo "$ver" | sed -E 's/^v([0-9]+).*/\1/')"
  if [ -n "$major" ] && [ "$major" -ge "$MIN_MAJOR" ] 2>/dev/null; then
    NODE_BIN="$c"
    echo "$(date): [scanner] using node=$c version=$ver" >> "$OUT_LOG"
    break
  else
    echo "$(date): skip $c (version=$ver < v$MIN_MAJOR)" >> "$ERR_LOG"
  fi
done

if [ -z "$NODE_BIN" ]; then
  echo "$(date): ERROR no node >= v$MIN_MAJOR found. Candidates tried: ${candidates[*]}" >> "$ERR_LOG"
  exit 1
fi

exec "$NODE_BIN" "$HOME/.ownmind/hooks/ownmind-usage-scanner.js"
```

**關鍵差異**：
- 不只檢查「有沒有 node」，還要**版本 >= 20**
- 每次跑都 log 所選路徑+版本，方便查 heartbeat 失敗原因
- nvm glob 用 `sort -rV` 確保拿到最新版本
- 任何候選版本不合格都寫入 err log 而非靜默 skip

`scripts/launchd/com.ownmind.usage-scanner.plist`（不碰 node 路徑）：

```xml
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ownmind.usage-scanner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>{HOME}/.ownmind/bin/run-scanner.sh</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>  <!-- 30 分鐘 -->
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>{HOME}/.ownmind/logs/scanner.log</string>
  <key>StandardErrorPath</key><string>{HOME}/.ownmind/logs/scanner.err</string>
</dict>
</plist>
```

`install.sh` 安裝 agent 時：
1. `NODE_BIN=$(command -v node)` 偵測當前可用 node
2. 驗證 `"$NODE_BIN" --version` 能跑（不能就 fail fast，提醒裝 Node 20+）
3. 寫入 `~/.ownmind/.node-path`
4. 生成 `run-scanner.sh` + plist
5. `launchctl load -w ~/Library/LaunchAgents/com.ownmind.usage-scanner.plist`
6. 觸發一次測試執行，30 秒後檢查 `~/.ownmind/logs/scanner.log` 有輸出才算成功

### Linux — systemd user timer

`scripts/systemd/ownmind-usage-scanner.timer` + `.service`

Service 同樣呼叫 `~/.ownmind/bin/run-scanner.sh`（同一個 wrapper）。install 時寫入 `~/.ownmind/.node-path` + 驗證 + `systemctl --user enable --now`。

### Windows — Task Scheduler

`scripts/windows/register-scanner-task.ps1`

PowerShell 先 `Get-Command node -ErrorAction SilentlyContinue` 拿路徑，找不到 fail fast。`schtasks /create` 時帶入實際 node 路徑。

三者都：每 30 分鐘執行一次；即使 user 沒開 IDE 也會跑。

另外保留觸發：
- Claude Code SessionStart hook（補強，快 response）
- MCP init（補強）

---

## S6：強制追蹤 + 透明 opt-out

**Client 端不再有 `~/.ownmind/.no-usage-tracking` sentinel**（D3）

Server 端：
- 每次 `/api/usage/events` 被呼叫時檢查 `usage_tracking_exemption`
- 有 exemption → 接收資料但不寫入 `token_events`（僅記一筆「被豁免」到 audit log）
- 無 exemption → 正常寫入
- Dashboard 上 opt-out 用戶顯示為「tracking exempt」，admin 看得到誰 + 為什麼 + 誰批准

申請流程（選配）：
- user 在 dashboard 送出 opt-out request
- super_admin 在 admin panel 批准 / 拒絕
- 批准後寫入 `usage_tracking_exemption`

本期簡化：不做 request 流程，super_admin 直接在 admin panel 新增列即可。

---

## S7：資料完整性機制（非保證）

以下是實作機制，不是無條件保證。實際可達成的是：dedupe + retry + 可觀測 coverage。殘餘 gap 靠 audit log 偵測。

| 機制 | 防範 |
|------|------|
| Raw event + message_id dedupe | 重複上傳 |
| UNIQUE 約束 (user, tool, session, msg) | 同一 event 不會 double count |
| Server-side cost 重算 | Client 不能改 cost |
| 單調成長檢查（audit） | Client 竄改 token 數 |
| Model allowlist（audit） | 假 model 名 |
| Heartbeat 24h TTL | 掉線無感偵測 |
| Coverage panel gate | 團隊統計不誤用殘缺資料 |
| 首次 scan offset=0（單一 path）| 安裝前歷史可擷取；不引入分支架構；retry 可重跑 |
| Codex fingerprint audit | 偵測 Codex synthetic hash 碰撞（理論風險，非 48-sample 保證）|
| Server-side scheduled recompute | pricing 更新後歷史 cost 重算 |

---

## S8：Dashboard 改動

### 個人頁（所有 user）

- 今日 / 本週 / 本月 cost + token + 工時
- 每日 line chart（cost / token / 工時各一條 series 可切換）
- Session 列表可下鑽
- **Tracking status 指示燈**：顯示「已啟用 / 已豁免追蹤 / 心跳異常」

### User 顯示（所有 API response）

所有統計 endpoint 回傳結果含 `user` 物件（JOIN `users` 表）：

```json
{
  "user": { "id": 1, "name": "Vin Kao", "email": "vincent@fontrip.com" },
  "tokens": { ... },
  "cost_usd": 2.45
}
```

Dashboard 用 `name`（若空則 fallback `email`）顯示，絕不用內部 `user_id`。

### 團隊頁（admin+）

**頂部必展示 coverage 狀態**（D5）：

```
📊 覆蓋率：10 位成員中 8 位活躍（24h 內有回報）
⚠️  2 位未回報超過 48 小時：Alice, Bob
✋ 1 位已豁免：Charlie（原因：休假）
```

只有 coverage > 80% 時才能切到「績效比較」模式。覆蓋不足時強制顯示「資料不完整，僅供參考」浮水印。

內容：
- 每日總量 / 成本 / 工時（stacked by user）
- 用戶排行榜（可按 cost / tokens / hours 排序）
- Tool 分佈、model 分佈
- 每個 user 詳細頁：同個人頁但看他人

### Pricing 頁（super_admin only）

- 顯示現行所有 (tool, model) 的 pricing
- 新增 row 要填 effective_date
- 不允許刪除，只能 append

### Audit log 頁（admin+）

顯示最近的 unknown_model / token_regression / rate_anomaly events，幫助識別異常。

---

## 開發階段（重排）

| Phase | 內容 | 可 ship 點 |
|-------|------|-----------|
| **P1** | DB migration（全部 6 張表）+ pricing API + 初始 pricing 資料 | 後端骨架 |
| **P2** | `/api/usage/events` + server-side aggregation job + dedup + validation | 可接收並 aggregate raw events |
| **P3** | Heartbeat + exemption API（無獨立 backfill endpoint）| 完整 ingestion layer |
| **P4** | Claude Code scanner（raw event forwarder + 單一 ingestion path） | Tier 1 啟動 |
| **P5** | Codex + OpenCode scanner | Tier 1 完整 |
| **P6** | Always-on collector（macOS launchd + Linux systemd + Win Task Scheduler） | 覆蓋率保證 |
| **P7** | Cursor + Antigravity scanner（session_count only） | Tier 2 |
| **P8** | 個人 dashboard + tracking status | User 可自助查 |
| **P9** | 團隊 dashboard + coverage panel + pricing 管理 + audit log 頁 | 績效管理就緒 |

**預估**：15–20 小時（比 v1 的 8–12h 多）

**關鍵 gate**：**P9 上線前，P6 必須完成**（沒有 always-on collector 就不能讓 admin 看團隊統計，不然資料殘缺會誤導績效判斷）

---

## Rollback

- Migration 全是 CREATE TABLE → 回滾 = DROP 全部新表
- Scanner 只讀本地檔案 + POST → 失敗不影響 IDE
- launchd/systemd/Task Scheduler：uninstall 腳本移除
- Server-side aggregation job：可選擇暫停，讀取仍用最後一次結果

---

## 安全 / 隱私

- `token_events` / `token_usage_daily` 不含對話內容，只有聚合數字與 metadata
- `source_file` 僅存相對路徑供 debug，不外流
- 團隊 dashboard 的敏感資料（其他人用量）僅 admin+ 可見
- Exemption 列表 super_admin 才能看完整 reason
- 所有 API 走現有 auth middleware（Bearer token）
