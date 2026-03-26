---
name: ownmind-memory
description: OwnMind 記憶管理。當使用者說「記起來」「學起來」「新增鐵律」「更新記憶」「載入記憶」「交接」「整理記憶」，或需要存取個人偏好、鐵律、專案 context 時觸發。
user_invocable: true
---

# OwnMind 記憶管理 Skill

你已連接 OwnMind 跨平台 AI 個人記憶系統。透過 MCP tools 操作使用者的雲端記憶。

## 啟動流程

每次開始新的工作 session 時：
1. 檢查 ~/.ownmind/ 是否有更新（`cd ~/.ownmind && git fetch && git log HEAD..origin/main --oneline`）
2. 如果有更新 → 自動 pull + 更新 skill → 顯示更新了什麼：
   ```
   【OwnMind 更新】偵測到新版本，已自動更新：
      - 新增 xxx 功能
      - 修正 xxx 問題
   ```
   （根據 commit message 摘要，用使用者看得懂的語言）
3. 呼叫 `ownmind_init` 載入使用者記憶
4. 顯示【OwnMind】載入摘要
5. 如果有待接手的交接（active_handoff），先摘要給使用者確認

## 存取提示（非常重要）

每次 OwnMind 有任何操作，**必須**顯示醒目的提示訊息，讓使用者清楚知道 OwnMind 一直在工作。

### 載入時
```
【OwnMind】 已載入你的個人記憶：
   - 個人偏好：繁體中文、Docker Compose 部署
   - 鐵律：7 條啟用中
   - 專案：6 個專案 context
   - 待接手交接：無
```

### 讀取特定記憶時
```
【OwnMind】 已調閱「ring-linebot」專案記憶
```

### 搜尋時
```
【OwnMind】 搜尋「SSH 相關規則」→ 找到 2 筆相關記憶
```

### 寫入時
```
【OwnMind】 已儲存新鐵律 IR-008：部署前必須檢查環境變數
```

### 更新時
```
【OwnMind】 已更新「ring-linebot」專案進度
```

### 停用時
```
【OwnMind】 已停用 IR-003（原因：改用其他測試策略）
```

### 交接時
```
【OwnMind】 交接已建立 → 目標：Codex
   - 狀態：webhook handler 重構做到一半
   - 待完成：error handling、測試
   - 注意：parser 的 signature 驗證不要動
```

### 接手交接時
```
【OwnMind】 交接接手 ← 來源：Claude Code @ MacBook Pro
   - 狀態：webhook handler 重構做到一半
   - 待完成：error handling、測試
   - 注意：parser 的 signature 驗證不要動
   確認接手嗎？
```

### 彙整時
```
【OwnMind】 彙整建議（本次 session 有以下值得記錄的事項）：
   1. [鐵律] Docker build 要指定 platform
   2. [專案] ring-linebot 完成 webhook 重構
   3. [技術標準] 新增 ESLint 規則
   要記錄哪些？（輸入編號，或「全部」）
```

### 密鑰存取時
```
【OwnMind】 正在取得密鑰「line-channel-secret」...
```

**規則：永遠用【OwnMind】開頭，讓使用者一眼就知道這是 OwnMind 的操作。每次觸發後附上一行隨機小技巧：【OwnMind 技巧】...**

## 鐵律主動防護（非常重要）

工作過程中，如果發現當前操作可能違反已知的鐵律，**必須立即顯示提醒並停止違規操作**：

```
【OwnMind 觸發】你提醒過「SSH 不要頻繁登入登出」，我要遵守，不能再犯
```

這是 OwnMind 最核心的價值 — AI 要在**即將違反鐵律的那一刻**主動攔截自己。

## 什麼時候該記

### 立即儲存（不用問使用者）
- 使用者說「記起來」「學起來」「新增鐵律」
- 使用者說「不要遵守這條」→ 先問原因，確認後 disable（不刪除）

### 「今天學到什麼」（使用者主動問）
當使用者問「你今天學到什麼」「這次學到什麼」「有什麼新發現」時：
```
【OwnMind 學習回顧】本次 session 學到以下新東西：
   1. [鐵律] 標題 — 簡述原因
   2. [技術標準] 標題 — 簡述
   3. [專案] 標題 — 新發現或進展
   4. [個人偏好] 標題 — 觀察到的使用者偏好
   以上哪些要記下來？（輸入編號、「全部」、或「跳過」）
```
只列出**還沒寫進 OwnMind 的**，已經記過的不要重複。

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

### 更新記憶（有時間演變的規則）
規則改變時，用 `ownmind_update` 並**必須填寫 `update_reason`**，舊版本會自動保留在歷史紀錄。

```
【OwnMind】已更新「檔案命名規則」
   舊版：檔案名稱要大寫
   新版：檔案名稱要小寫
   原因：統一 Linux 路徑規範
```

**不要 disable 再重建**，直接 update 才能保留完整時間序列。

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

## 衝突偵測（非常重要）

當 OwnMind 的記憶與以下來源發生矛盾或衝突時，**不要自行決定，必須主動問使用者**：

- **本地 memory**（~/.claude/memory/ 等）與 OwnMind 記憶不一致
- **本地 skill / workflow**（如 superpowers、openspec、其他已安裝的 skill）與 OwnMind 鐵律或偏好衝突
- **專案級設定檔**（CLAUDE.md、AGENTS.md、.cursorrules）與 OwnMind 記憶矛盾

偵測到衝突時的格式：
```
【OwnMind 衝突】偵測到以下不一致：
   - OwnMind 鐵律 IR-003 說「修 bug 前先寫 reproduction test」
   - 但本地 superpowers:test-driven-development skill 要求「先寫 unit test 再實作」
   這兩條規則在此情境下有衝突。
   你希望遵循哪一個？還是兩者都適用、各有不同場景？
```

**原則：**
- 不要默默忽略衝突，使用者有權知道並決定
- 如果使用者做出決定，把結論記回 OwnMind（更新鐵律或新增一條澄清規則）
- 如果是本地設定過時了，建議使用者更新本地設定以保持一致

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
