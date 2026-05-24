# v1.19 — 鐵律分級規格（GIVEN / WHEN / THEN）

> 本檔規格採用 BDD 三段式描述（白話：前提 / 動作 / 預期結果），對應 OpenSpec CONVENTIONS.md 第 1 條。

---

## 場景 1：migration 不破壞既有鐵律

**GIVEN（前提）**

- 資料庫已有 41 條鐵律（IR-002 ~ IR-042）、`memories.type = 'iron_rule'`
- 尚未跑 014 migration

**WHEN（動作）**

- 跑 `db/014_iron_rule_tier.sql`

**THEN（預期結果）**

- `memories` 表新增 `tier VARCHAR(20) DEFAULT 'default'` 欄位
- 既有 41 條鐵律的 `tier` 全部為 `'default'`
- `idx_memories_iron_rule_tier` 索引建立成功、只覆蓋 `type='iron_rule'` 的列（部分索引 PARTIAL INDEX）
- 既有的 title / content / code / status / metadata 完全沒被動到
- migration 可重跑（IF NOT EXISTS）、跑第二次無 error

---

## 場景 2：API 寫入 tier

**GIVEN**

- API server 已部署 v1.19
- 已登入的管理員帳號

**WHEN**

```http
PUT /api/memory/123
Authorization: Bearer <admin_api_key>
Content-Type: application/json

{ "tier": "critical" }
```

**THEN**

- 回應 200
- `memories.tier` 欄位被更新為 `'critical'`
- 寫入 `memory_history`、`change_type = 'update'`、`changed_by` 為管理員 user
- API 回應 body 包含更新後的 tier 值

---

## 場景 3：tier 值驗證

**GIVEN**

- API server 已部署 v1.19

**WHEN**

```http
PUT /api/memory/123
{ "tier": "invalid_value" }
```

**THEN**

- 回應 400 Bad Request
- 錯誤訊息明確指出可用值：`tier must be one of: critical, default, advisory`
- `memories` 表沒被改動

---

## 場景 4：非鐵律不能設 tier

**GIVEN**

- API server 已部署 v1.19
- `memories.id=99` 是 `type='project'` 的專案記憶

**WHEN**

```http
PUT /api/memory/99
{ "tier": "critical" }
```

**THEN**

- 回應 400 Bad Request
- 錯誤訊息：`tier can only be set on type='iron_rule' memories`
- `memories.id=99.tier` 維持原值（NULL 或 default）

---

## 場景 5：MCP 工具支援 tier 參數

**GIVEN**

- AI 工具透過 OwnMind MCP server 連線
- 已認證

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

- 鐵律建立成功
- 回傳 `memory.tier === 'critical'`
- 同步寫入 `~/.ownmind/cache/iron_rules.json` 帶 tier 欄位
- 沒帶 `tier` 參數時、預設為 `'default'`

---

## 場景 6：SessionStart 載入按 tier 分組

**GIVEN**

- 使用者開啟 Claude Code、觸發 SessionStart hook
- 雲端有 10 條 critical、20 條 default、10 條 advisory 鐵律

**WHEN**

- SessionStart hook 執行、跑 `ownmind_init`、讀 `iron_rules_digest`

**THEN**

顯示順序與格式：

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

- Critical 永遠展開、加紅色 emoji
- Default 永遠展開、加黃色 emoji
- Advisory **不列規則細節**、只顯示計數 + 取得詳細列表的方式（減少初始載入字數、避免稀釋 AI 注意力）

---

## 場景 7：違反 Critical 鐵律的 compliance event

**GIVEN**

- 使用者 commit 包含 `.env.production` 檔案（違反 IR-002，tier=critical）
- v1.19 已部署

**WHEN**

- pre-commit hook 偵測到違反
- 寫 compliance event 到 `~/.ownmind/logs/YYYY-MM-DD.jsonl`

**THEN**

event 物件結構：

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

- `tier` 欄位**必須**出現在 details
- 寫不出網路 / spool 也要把 tier 帶上
- **本版不擋 commit**——hook 仍然回 exit 0（v1.20 才擋）

---

## 場景 8：Admin UI 編輯 tier

**GIVEN**

- Admin 開啟 `https://kkvin.com/ownmind/admin/memories`
- 點開 IR-002 編輯頁面

**WHEN**

- Admin 把 tier 從 `default` 改為 `critical`
- 按「儲存」

**THEN**

- 頁面顯示「儲存成功」
- 後台 PUT /api/memory/{id}、body 帶 `tier: 'critical'`
- 列表頁立即反映新 tier、紅點顯示
- audit log 記錄：誰、何時、tier 從 default → critical

---

## 場景 9：舊客戶端 fallback

**GIVEN**

- Server 已升級到 v1.19、API 回傳鐵律帶 `tier` 欄位
- 使用者的 Cursor 還是舊版客戶端、不認得 tier 欄位

**WHEN**

- 舊客戶端讀 `GET /api/memory/type/iron_rule`

**THEN**

- 舊客戶端正常運作（JSON 多一個欄位不會壞）
- 鐵律全部按舊邏輯處理（等同 default）
- 不需要強制升級客戶端

---

## 場景 10：shared/iron-rule-tier.js helper

**GIVEN**

- 鐵律快取陣列（從 API 或 `~/.ownmind/cache/iron_rules.json` 取得）

**WHEN**

```js
import { getTierFromRules } from '../shared/iron-rule-tier.js';
const tier = getTierFromRules(rules, 'IR-002');
```

**THEN**

- 命中規則時回傳該規則的 `tier`（已 normalize 過、保證是合法值）
- 找不到 / tier 缺失 / tier 非法值 / rules 非陣列 → 回傳 `'default'`（fallback）
- 不會丟 exception

---

## 場景 11：rule_code 缺失時的行為

**GIVEN**

- 自訂鐵律沒有 `code` 欄位（例如使用者手動建的）

**WHEN**

- compliance hook 偵測到該鐵律違反

**THEN**

- compliance event 的 `rule_code` 為 `null`、`tier` 仍取自 `memories.tier`
- 不會因為 rule_code 缺失而丟錯
- log 正常寫入

---

## 場景 12：發版完成的驗收條件

**GIVEN**

- v1.19.0 已 tag、push、部署 prod
- prod 跑了 24 小時

**WHEN**

- 跑驗收 SQL：

```sql
SELECT tier, COUNT(*) FROM memories
WHERE type = 'iron_rule' AND status = 'active'
GROUP BY tier;
```

**THEN**

- `critical` 計數 = 10（人工分級完成）
- `default` 計數 ≈ 30 ± 2（剩餘）
- `advisory` 計數 = 0（待 v1.19.1）
- 沒有 NULL tier 的鐵律
- admin dashboard 「鐵律分級」分頁可正常顯示分佈圖

---

## 非場景（明確不做的事）

- ❌ **AI 自動建議 tier**：v1.19 不做、v1.20+ 評估
- ❌ **per-user 客製分級**：永遠不做（違反跨工具一致性）
- ❌ **Critical 違反真的擋下來**：v1.20 處理
- ❌ **Advisory 段列出細節**：v1.19 只顯示計數 + `ownmind_get('iron_rule')` 取得方式（SessionStart 是文字輸出、沒有「點開」按鈕能做）
