---
name: ownmind-memory
description: OwnMind 記憶管理。當使用者說「記起來」「學起來」「新增鐵律」「更新記憶」「載入記憶」「交接」「整理記憶」，或需要存取個人偏好、鐵律、專案 context 時觸發。
user_invocable: true
---

# OwnMind 記憶管理 Skill

你已連接 OwnMind 跨平台 AI 個人記憶系統。透過 MCP tools 操作使用者的雲端記憶。

## 啟動流程

每次開始新的工作 session 時：
1. 呼叫 `ownmind_init` 載入使用者記憶
2. 顯示 `📥 OwnMind 載入：profile, principles, [pending handoff if any]`
3. 如果有待接手的交接（active_handoff），先摘要給使用者確認

## 存取指示器

每次存取 OwnMind 時，**必須**在回應中顯示：
- 📥 讀取記憶（init, get, search）
- 📤 寫入記憶（save, update, disable）
- 🔄 交接操作（handoff_create, handoff_accept）

## 什麼時候該記

### 立即儲存（不用問使用者）
- 使用者說「記起來」「學起來」「新增鐵律」
- 使用者說「不要遵守這條」→ 先問原因，確認後 disable（不刪除）

### 主動彙整觸發（列出候選項讓使用者確認）
1. 完成一個 feature 或 milestone
2. 踩坑並解決了
3. 做了重要技術決策
4. 工作超過 2 小時沒彙整
5. Context window 使用超過 50%
6. 使用者要開新對話或清空對話前

彙整時：
```
🔄 OwnMind 彙整建議：
1. [類型] 標題 — 簡述
2. [類型] 標題 — 簡述
要記錄哪些？
```

## 怎麼記

### 判斷記憶類型
| 類型 | 什麼時候用 |
|------|-----------|
| iron_rule | 踩坑後的教訓、不可違反的規則 |
| principle | 核心信念、工作方法論 |
| coding_standard | 技術偏好、編碼風格 |
| project | 專案進度、架構、待辦 |
| profile | 個人偏好、溝通方式 |
| portfolio | 完成的作品 |
| env | 環境資訊 |

### 鐵律格式
```markdown
## IR-XXX：標題
- 建立時間：YYYY-MM-DD HH:mm
- 環境：機器 / 工具 / 模型
- 背景：為什麼訂這條（踩了什麼坑、發生什麼事）
- 規則：具體的規則內容
- 適用範圍：全域 / 特定專案 / 特定語言
```

新增鐵律時，先查現有的 iron_rules 確認最新編號，+1 作為新編號。

### Metadata
每次寫入都帶：
```json
{
  "machine": "機器名稱",
  "tool": "claude-code",
  "model": "claude-opus-4-6",
  "timestamp": "2026-03-26T14:30:00+08:00"
}
```

## 交接流程

### 交接出去（使用者說「交接給 XXX」）
1. 呼叫 `ownmind_handoff_create`，內容包含：
   - 目前做到哪裡
   - 還沒做完的事
   - 需要注意的坑
   - 關鍵檔案路徑
2. 顯示摘要給使用者確認
3. `🔄 OwnMind 交接已建立，XXX 接手時會看到`

### 交接回來（init 發現有 pending handoff）
1. 顯示交接摘要
2. 問使用者「確認接手嗎？」
3. 確認後呼叫 `ownmind_handoff_accept`
4. `🔄 OwnMind 交接已接手`

## 停用規則

使用者說「不要遵守這條鐵律」時：
1. 先問：「這條鐵律是因為 [背景] 訂的，你確定要停用嗎？還是調整適用範圍？」
2. 確認停用 → 呼叫 `ownmind_disable`，帶上停用原因
3. 不刪除，只標記 disabled
4. `📤 OwnMind 更新：IR-XXX 已停用（原因：...）`

## 持續進化

工作中主動反思：
- 現有鐵律是否涵蓋新情境 → 補充或修正
- 發現更好的做法 → 更新 coding_standard
- 專案有重大進展 → 更新 project
- 記憶過時 → disable 並記錄原因

## MCP Tools 速查

| Tool | 用途 |
|------|------|
| `ownmind_init` | 開始時載入記憶 |
| `ownmind_get(type)` | 取得特定類型 |
| `ownmind_search(query)` | 語意搜尋 |
| `ownmind_save(type, title, content, ...)` | 新增記憶 |
| `ownmind_update(id, content, ...)` | 更新記憶 |
| `ownmind_disable(id, reason)` | 停用記憶 |
| `ownmind_handoff_create(...)` | 建立交接 |
| `ownmind_handoff_accept(id, accepted_by)` | 接受交接 |
| `ownmind_log_session(summary, ...)` | 記錄 session |
| `ownmind_get_secret(key)` | 取得密鑰 |
| `ownmind_list_secrets` | 列出密鑰 |
| `ownmind_set_secret(key, value, ...)` | 儲存密鑰 |
