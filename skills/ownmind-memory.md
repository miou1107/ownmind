---
name: ownmind-memory
description: OwnMind 記憶管理。當使用者說「記起來」「學起來」「新增鐵律」「更新記憶」「載入記憶」「交接」「整理記憶」，或需要存取個人偏好、鐵律、專案 context 時觸發。
user_invocable: true
---

# OwnMind 記憶管理 Skill

你已連接 OwnMind 跨平台 AI 個人記憶系統。透過 MCP tools 操作使用者的雲端記憶。

## 版本與訊息格式（強制）

**當前版本：v1.7.1**

所有 OwnMind 訊息**一律**使用以下格式開頭：
```
【OwnMind v1.7.1】{訊息類型}：{內容}
```

**訊息類型對照表：**

| 訊息類型 | 使用時機 |
|----------|----------|
| 版本更新 | 啟動時偵測到新版本並自動更新 |
| 更新提醒 | 每日檢查發現遠端有更新 |
| 更新完成 | 使用者同意更新後完成 |
| 記憶載入 | 啟動時載入使用者記憶 |
| 記憶操作 | 讀取、寫入、更新、停用、搜尋記憶 |
| 行為觸發 | 鐵律主動防護攔截 |
| 學習回顧 | 使用者問「學到什麼」 |
| 彙整建議 | 主動彙整候選項 |
| 衝突偵測 | 與本地 memory/skill 矛盾 |
| 交接 | 建立或接手交接 |
| 密鑰存取 | 存取加密密鑰 |
| 鐵律確認 | Periodic re-check 鐵律 |
| 小技巧 | 每次操作後附上的隨機技巧 |

**規則：**
- 禁止使用舊格式（【OwnMind】、【OwnMind 觸發】等）
- 版本號從 skill 檔案頂部讀取，更新版本時只改一處
- 每次操作後附上一行：`【OwnMind v1.7.1】小技巧：...`

## 啟動流程

每次開始新的工作 session 時：
1. 檢查 ~/.ownmind/ 是否有更新（`cd ~/.ownmind && git fetch && git log HEAD..origin/main --oneline`）
2. 如果有更新 → 自動 pull + 更新 skill → 顯示更新了什麼：
   ```
   【OwnMind v1.7.1】版本更新：偵測到新版本，已自動更新：
      - 新增 xxx 功能
      - 修正 xxx 問題
   ```
   （根據 commit message 摘要，用使用者看得懂的語言）
3. 呼叫 `ownmind_init` 載入使用者記憶（包含 profile、principles、**iron_rules**、active_handoff）
4. 顯示載入摘要
5. **將所有 iron_rules 內化為工作準則**，在整個 session 中主動防護（不需列出給使用者，但即將違反時必須攔截）
6. 如果有待接手的交接（active_handoff），先摘要給使用者確認

## 每日更新檢查（強制）

每次 OwnMind 被觸發（任何操作：讀取、寫入、搜尋、彙整等），**必須先執行更新檢查**，但每天最多提醒一次：

**檢查流程：**
1. 讀取 marker 檔案：`cat ~/.ownmind/.last-update-check 2>/dev/null`
2. 比較 marker 日期與今天日期（格式 `YYYY-MM-DD`）
3. 如果 marker 日期 = 今天 → **跳過檢查**，直接執行操作
4. 如果 marker 日期 ≠ 今天（或檔案不存在）→ 執行以下步驟：
   ```bash
   cd ~/.ownmind && git fetch 2>/dev/null && git log HEAD..origin/main --oneline
   ```
5. 更新 marker：`date +%Y-%m-%d > ~/.ownmind/.last-update-check`
6. 如果有新 commit → 顯示提醒：
   ```
   【OwnMind v1.7.1】更新提醒：遠端有新版本（{N} 個 commit），建議更新：
      - {commit message 1}
      - {commit message 2}
   要我幫你更新嗎？
   ```
7. 如果沒有新 commit → 不顯示任何訊息，靜默繼續

**使用者同意更新時（說「好」「更新」「update」等），執行完整更新流程：**
```bash
# Step 1: pull 最新程式碼
cd ~/.ownmind && git pull

# Step 2: 更新 MCP 依賴（如果 package.json 有變動）
cd ~/.ownmind/mcp && npm install

# Step 3: 同步 skill 到本地 Claude commands
cp ~/.ownmind/skills/ownmind-memory.md ~/.claude/commands/ownmind-memory.md

# Step 4: 同步各 AI client config（如果 configs/ 有變動）
# Claude Code: ~/.claude/CLAUDE.md 的 OwnMind 區塊
# 其他 client 的 config 由各自的 bootstrap 機制處理
```
更新完成後顯示：
```
【OwnMind v1.7.1】更新完成：已更新至最新版本
   - 程式碼：✅ git pull 完成
   - MCP 依賴：✅ npm install 完成
   - Skill 同步：✅ 已同步到本地
```

**規則：**
- marker 檔案路徑固定為 `~/.ownmind/.last-update-check`
- 即使 git fetch 失敗（離線等），也要更新 marker，避免重複嘗試
- 此檢查不阻塞操作 — 提醒完畢後繼續執行使用者要求的操作

## 存取提示（非常重要）

每次 OwnMind 有任何操作，**必須**顯示醒目的提示訊息，讓使用者清楚知道 OwnMind 一直在工作。

### 載入時
```
【OwnMind v1.7.1】記憶載入：已載入你的個人記憶
   - 個人偏好：繁體中文、Docker Compose 部署
   - 鐵律：7 條啟用中
   - 專案：6 個專案 context
   - 待接手交接：無
```

### 讀取特定記憶時
```
【OwnMind v1.7.1】記憶操作：已調閱「ring-linebot」專案記憶
```

### 搜尋時
```
【OwnMind v1.7.1】記憶操作：搜尋「SSH 相關規則」→ 找到 2 筆相關記憶
```

### 寫入時
```
【OwnMind v1.7.1】記憶操作：已儲存新鐵律 IR-008「部署前必須檢查環境變數」
```

### 更新時
```
【OwnMind v1.7.1】記憶操作：已更新「ring-linebot」專案進度
```

### 停用時
```
【OwnMind v1.7.1】記憶操作：已停用 IR-003（原因：改用其他測試策略）
```

### 交接時
```
【OwnMind v1.7.1】交接：已建立 → 目標：Codex
   - 狀態：webhook handler 重構做到一半
   - 待完成：error handling、測試
   - 注意：parser 的 signature 驗證不要動
```

### 接手交接時
```
【OwnMind v1.7.1】交接：接手 ← 來源：Claude Code @ MacBook Pro
   - 狀態：webhook handler 重構做到一半
   - 待完成：error handling、測試
   - 注意：parser 的 signature 驗證不要動
   確認接手嗎？
```

### 彙整時
```
【OwnMind v1.7.1】彙整建議：本次 session 有以下值得記錄的事項

   | # | 分類 | 標題 | 說明 |
   |---|------|------|------|
   | 1 | 🚫 鐵律 (iron_rule) | Docker build 要指定 platform | 跨架構部署踩坑 |
   | 2 | 📁 專案 (project) | ring-linebot 完成 webhook 重構 | 進度更新 |
   | 3 | 🔧 技術標準 (coding_standard) | 新增 ESLint 規則 | 統一 import 排序 |

   要記錄哪些？（輸入編號、「全部」、或「跳過」）
```

### 密鑰存取時
```
【OwnMind v1.7.1】密鑰存取：正在取得「line-channel-secret」...
```

### 更新記憶時
```
【OwnMind v1.7.1】記憶操作：已更新「檔案命名規則」
   舊版：檔案名稱要大寫
   新版：檔案名稱要小寫
   原因：統一 Linux 路徑規範
```

## 鐵律主動防護（非常重要）

工作過程中，如果發現當前操作可能違反已知的鐵律，**必須立即顯示提醒並停止違規操作**：

```
【OwnMind v1.7.1】行為觸發：你提醒過「SSH 不要頻繁登入登出」，已強制遵守
```

這是 OwnMind 最核心的價值 — AI 要在**即將違反鐵律的那一刻**主動攔截自己。

## 什麼時候該記

### 立即儲存（不用問使用者）
- 使用者說「記起來」「學起來」「新增鐵律」
- 使用者說「不要遵守這條」→ 先問原因，確認後 disable（不刪除）

### 「今天學到什麼」（使用者主動問）
當使用者問「你今天學到什麼」「這次學到什麼」「有什麼新發現」「學到哪些」時：

**必須使用中文分類名 + OwnMind type 對照格式**，讓使用者一眼看出會記到哪個分類：
```
【OwnMind v1.7.1】學習回顧：本次 session 學到以下新東西

   | # | 分類 | 標題 | 說明 |
   |---|------|------|------|
   | 1 | 🚫 鐵律 (iron_rule) | SSH 連線規則 | 踩到被 ban 的坑 |
   | 2 | 🔧 技術標準 (coding_standard) | ESLint 新規則 | 統一 import 排序 |
   | 3 | 📁 專案 (project) | RING v2.3 進度 | 完成對話測試模組 |
   | 4 | 👤 個人偏好 (profile) | 報告語言偏好 | 圖表英文、文字中文 |
   | 5 | 💡 原則 (principle) | 數據先行 | 先看數字再下結論 |
   | 6 | 🖥️ 環境 (env) | MCP worktree 問題 | OwnMind 在 worktree 不載入 |

   以上哪些要記下來？（輸入編號、「全部」、或「跳過」）
```

**中文分類對照表（強制使用）：**

| 中文分類 | OwnMind type | emoji |
|----------|-------------|-------|
| 鐵律 | iron_rule | 🚫 |
| 原則 | principle | 💡 |
| 技術標準 | coding_standard | 🔧 |
| 團隊規範 | team_standard | 📋 |
| 專案 | project | 📁 |
| 個人偏好 | profile | 👤 |
| 作品集 | portfolio | 🏆 |
| 環境 | env | 🖥️ |
| Session 紀錄 | session_log | 📝 |

只列出**還沒寫進 OwnMind 的**，已經記過的不要重複。已經記過的可附註「✅ 已記錄」。

### 主動彙整觸發（列出候選項讓使用者確認）
1. 完成一個 feature 或 milestone
2. 踩坑並解決了
3. 做了重要技術決策
4. 工作超過 2 小時沒彙整
5. Context window 使用超過 50%
6. 使用者要開新對話或清空對話前

彙整時（同樣使用中文分類 + type 對照）：
```
【OwnMind v1.7.1】彙整建議：本次 session 有以下值得記錄的事項

   | # | 分類 | 標題 | 說明 |
   |---|------|------|------|
   | 1 | 🚫 鐵律 (iron_rule) | Docker build 要指定 platform | 跨架構部署踩坑 |
   | 2 | 📁 專案 (project) | ring-linebot 完成 webhook 重構 | 進度更新 |

   要記錄哪些？（輸入編號、「全部」、或「跳過」）
```

## 怎麼記

### 判斷記憶類型
| 類型 | 什麼時候用 |
|------|-----------|
| iron_rule | 踩坑後的教訓、不可違反的規則 |
| principle | 核心信念、工作方法論 |
| coding_standard | 技術偏好、編碼風格 |
| team_standard | 公司/團隊協作規範：code review 規則、git 治理、目錄結構、開發流程、引用框架、命名慣例等（⚠️ 僅管理員可新增/修改） |
| project | 專案進度、架構、待辦 |
| profile | 個人偏好、溝通方式 |
| portfolio | 完成的作品 |
| env | 環境資訊 |

### 團隊規範（team_standard）設計

**核心概念：** 組織層級的規範，由 admin 建立，自動套用到所有成員。優先級高於個人規則。

**權限控制：**
- **新增/修改/停用**：僅限 `admin` role（後端 API 強制檢查，非 admin 會收到 403）
- **讀取**：所有人（init 時自動載入，不需額外操作）
- **個人關閉（opt-out）**：任何使用者都可以關閉某條團隊規範（僅影響自己，不影響他人）

**優先級規則（強制）：**
```
team_standard > iron_rule > principle > coding_standard > profile
```
- 團隊規範與個人鐵律衝突時，**團隊規範優先**
- 顯示衝突時標明：
  ```
  【OwnMind v1.7.1】衝突偵測：團隊規範「{title}」與你的個人鐵律 IR-{XXX} 衝突，依規定團隊規範優先
  ```

**使用者關閉團隊規範（雙重確認，強制）：**
當使用者說「關閉這條團隊規範」「不要套用這條」時：
1. 顯示警告：
   ```
   【OwnMind v1.7.1】記憶操作：⚠️ 你即將關閉團隊規範「{title}」
      - 此規範由管理員設定，優先級高於個人規則
      - 關閉後只影響你自己，不影響其他成員
      請輸入「我確認關閉團隊規範」以確認操作
   ```
2. **必須等使用者完整輸入「我確認關閉團隊規範」才可執行**，任何其他回覆（包括「好」「確認」「yes」）都不算確認，需再次提示
3. 確認後，透過 API 建立個人 opt-out 記錄
4. 顯示：
   ```
   【OwnMind v1.7.1】記憶操作：已關閉團隊規範「{title}」（僅限你個人，團隊其他人不受影響）
   ```

**非 admin 嘗試寫入時：**
```
【OwnMind v1.7.1】記憶操作：無法新增團隊規範，此類型僅限管理員操作
```

### 更新記憶（有時間演變的規則）
規則改變時，用 `ownmind_update` 並**必須填寫 `update_reason`**，舊版本會自動保留在歷史紀錄。

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

### 交接回來（init 發現有 pending handoff）
1. 顯示交接摘要
2. 問使用者「確認接手嗎？」
3. 確認後呼叫 `ownmind_handoff_accept`

## 停用規則

使用者說「不要遵守這條鐵律」時：
1. 先問：「這條鐵律是因為 [背景] 訂的，你確定要停用嗎？還是調整適用範圍？」
2. 確認停用 → 呼叫 `ownmind_disable`，帶上停用原因
3. 不刪除，只標記 disabled

## 衝突偵測（非常重要）

當 OwnMind 的記憶與以下來源發生矛盾或衝突時，**不要自行決定，必須主動問使用者**：

- **本地 memory**（~/.claude/memory/ 等）與 OwnMind 記憶不一致
- **本地 skill / workflow**（如 superpowers、openspec、其他已安裝的 skill）與 OwnMind 鐵律或偏好衝突
- **專案級設定檔**（CLAUDE.md、AGENTS.md、.cursorrules）與 OwnMind 記憶矛盾

偵測到衝突時的格式：
```
【OwnMind v1.7.1】衝突偵測：偵測到以下不一致
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

## 鐵律 Trigger 機制（強制）

iron_rule 的 tags 中若有 `trigger:xxx` 標記，代表執行該類操作前必須主動 re-check：
- 看到 `trigger:git` 或 `trigger:commit` → 執行任何 git 指令前先確認相關鐵律
- 看到 `trigger:deploy` → 部署前確認
- 看到 `trigger:delete` → 刪除操作前確認
- 看到 `trigger:edit` → 修改程式碼前確認

**流程：** 即將執行上述操作 → 心裡確認有無相關鐵律 → 有則遵守，無則繼續

## Periodic Re-check（強制）

以下任一條件成立時，主動呼叫 `ownmind_get('iron_rule')` 刷新鐵律記憶：
- 對話超過 20 輪
- 感覺 context 已消耗大量（長對話、大量程式碼）
- 即將執行不可逆操作（commit、deploy、刪除）

刷新後顯示：
```
【OwnMind v1.7.1】鐵律確認：鐵律已重新載入，防護持續中
```
