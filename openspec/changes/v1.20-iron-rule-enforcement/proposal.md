# v1.20 — Critical 鐵律卡控（提醒層升級到邏輯層）

- **Author**: Vin
- **Date**: 2026-05-22（提案）
- **Status**: 待 Vin 拍板（7 件事）
- **Worktree**: `confident-heyrovsky-db0eb2`
- **Branch**: `vin/confident-heyrovsky-db0eb2`

---

## 0. 一句話總結

把 v1.19 標記為 `tier: critical` 的 10 條鐵律**從「提醒」升級到「卡控」**——違反時 hook 直接擋下動作（commit、工具呼叫、回應送出），而不是只跳警告。

> 白話：以前鐵律是「貼在牆上的告示」、AI 看到也可能照犯；這版改成「電子門禁」、違反就過不去。對應 IR-027「提醒無效、邏輯才有效」。

---

## 1. 設計緣由

### 1.1 提醒模式已驗證失效

直接觀察證據：

- **v1.19.0 啟動時就跳 13 條 reply-lint 警告**（IR-036、IR-037）——同一條規則在同一個 session 內反覆觸發
- **本次 session resume 時 SessionStart 一口氣顯示 8 段歷史回話品質警告**——AI 看到提醒、下次依然違反
- v1.19 iron-rule-tier 提案 §1.2 自己就用「告警疲勞」當設計緣由

這些都是 IR-027 的活樣本：**提醒沒擋住違反、只擋住使用者對警告的耐心**。

### 1.2 v1.19 留下的伏筆

v1.19 提案 §2.1 明確寫：

> | critical | 跟 default 相同（**本版不動執行邏輯**） | 直接卡控：pre-commit 擋 commit、PreToolUse 擋工具呼叫、reply-lint 中斷回應 |

v1.20 就是來填這個坑。10 條 critical 鐵律的標籤已經貼好、現在要讓標籤真的有意義。

### 1.3 OwnMind 的差異化定位

別人的記憶系統：「我幫你記住事情」。
OwnMind v1.20 後的記憶系統：「我幫你記住規則、而且會擋下違反」。

這是 OwnMind vs Mem0、ChatGPT memory、Cursor rules 的核心差異化。沒做這版、OwnMind 就只是另一個帶分級標籤的記憶 DB。

---

## 2. 卡控的三個落點

```
┌─────────────────────────────────────────────────────────┐
│ 1. PreToolUse hook（AI 呼叫工具前、本機 hook）            │
│    擋：危險的工具呼叫（Edit / Write / Bash / rm）         │
│    覆蓋：IR-005（blind edit）、IR-002（rm 密碼檔）        │
│    平台：Claude Code ✓ / Codex ✓ / Cursor ✗ / Gemini ?    │
└─────────────────────────────────────────────────────────┘
         ↓ 通過
┌─────────────────────────────────────────────────────────┐
│ 2. Reply-lint hook（AI 回應送出前、本機 hook）            │
│    擋：違反輸出品質規則的文字回應                          │
│    覆蓋：IR-036（行話）、IR-037（中英混雜）、IR-041（隱私） │
│    平台：Claude Code ✓ / Codex ✓ / 其他依各家 hook 點      │
└─────────────────────────────────────────────────────────┘
         ↓ 通過
┌─────────────────────────────────────────────────────────┐
│ 3. Git pre-commit hook（commit 前、git 層）              │
│    擋：違反 git 規則的 commit / push / tag                │
│    覆蓋：IR-002（密碼進 commit）、IR-008（README 沒同步）  │
│           IR-009（contributors）、IR-024（Co-Authored-By） │
│           IR-031（三處版號）                              │
│    平台：跨所有 AI 工具通用（git 在哪 hook 在哪）          │
└─────────────────────────────────────────────────────────┘
```

**設計重點**：git pre-commit 是**跨工具最穩的卡控點**——不管 AI 用哪個工具寫的程式碼、最後都要走 `git commit`。PreToolUse / reply-lint 是「擋在 AI 端、防範未然」、git pre-commit 是「擋在 git 端、保底防線」。兩層都要有。

---

## 3. 10 條 Critical 鐵律的具體卡控策略

| 鐵律 | 主要落點 | 偵測邏輯 |
|------|---------|----------|
| **IR-002** 不要 commit .env/密碼 | git pre-commit | 掃 staged diff 找 `.env*` 檔案名 + gitleaks / 內建 secret-detect（v1.19.1 同款） |
| **IR-005** 不要 blind edit | PreToolUse | 檢查目標檔案在本 session 有沒有 Read 過（hook 紀錄 read 過的檔案路徑） |
| **IR-008** commit 同步 README/FILELIST/CHANGELOG | git pre-commit | staged diff 含 `src/**` 但這三個檔案沒在 staged → 擋 |
| **IR-009** contributors = Vin | git pre-commit | `git config user.name` ≠ Vin → 擋（提示改 `git config`） |
| **IR-012** 品管三步驟 | git pre-commit + session log 查 | 比對 session log 有沒有對應 verification-before-completion 紀錄；無 → 擋（或 warn） |
| **IR-024** commit 不加 Co-Authored-By | git commit-msg | grep commit message 含 `Co-Authored-By` → 擋 |
| **IR-027** 提醒無效、邏輯才有效 | 後設規則 | 不直接擋；是 v1.20 整個架構的設計指引（自我引用） |
| **IR-031** 三處版號同步 | git pre-commit + pre-tag | 比對 `package.json.version` / `SERVER_VERSION` / 即將打的 tag → 不一致就擋 |
| **IR-038** 修 bug 前先有觀測資料 | PreToolUse（軟擋） | 偵測 Edit 含 `fix` / `bug` 字樣 → 提示「有先看 log/trace 嗎」（這條很難硬擋、本版維持警告） |
| **IR-041** 不收集使用者隱私 | reply-lint + pre-commit | regex 偵測身分證／email／電話 pattern；reply-lint 擋回應、pre-commit 擋 commit |

**例外處理**：每條卡控都要有 bypass 機制（討論在 §6）、避免誤擋卡死工作流。

---

## 4. 範圍 vs 不範圍

### 4.1 範圍內（v1.20）

- ✅ **Pre-commit hook 套件**：覆蓋 6 條 git 類 critical 鐵律（IR-002 / 008 / 009 / 012 / 024 / 031）
- ✅ **PreToolUse hook**：覆蓋 IR-005、IR-002（rm 密碼檔的工具層攔截）
- ✅ **Reply-lint 升級**：從「警告」改「擋下回應送出」（覆蓋 IR-036 / 037 / 041）
- ✅ **Bypass 機制**：明確的 user override + audit log
- ✅ **共用核心**：`shared/rule-enforcer.js`（純函式、被三種 hook 共用）
- ✅ **跨工具支援**：Claude Code + Codex；Cursor / Gemini 走 git pre-commit 那層
- ✅ **Tests**：30~50 個測試覆蓋上述邏輯
- ✅ **同步更新**：README 三語系、FILELIST、CHANGELOG（IR-008、IR-032）

### 4.2 不範圍（v1.21+ 處理）

- ❌ **Advisory tier 邏輯**：本版只動 critical；advisory「只寫紀錄、不跳警告」等 v1.21
- ❌ **動態升降級**：「default 連續違反 N 次自動升 critical」等 v1.22
- ❌ **AI 輔助分類**：用 LLM 自動建議鐵律分級
- ❌ **per-user 客製分級**：永遠不做（違反跨工具一致性、v1.19 已明確排除）

### 4.3 不範圍（永遠不做）

- ❌ **無 bypass 的硬擋**：critical 鐵律一定要能 override（user 是最終裁判）
- ❌ **靜默修改 user 程式碼**：reply-lint 擋下回應後不自動改寫、要讓 AI 自己重做

---

## 5. 影響範圍

### 5.1 Hooks（最大改動）

| 檔案 | 改動 |
|------|------|
| `hooks/ownmind-git-pre-commit.js` | **新檔**（目前只有 post-commit） — 整合 6 條 git 類規則 |
| `hooks/ownmind-pre-tool-use.js` | **新檔** — Claude Code / Codex 共用的 PreToolUse hook |
| `hooks/ownmind-reply-lint.js` | 升級：從「警告」改「ExitStatus=2 中斷回應」 |
| `hooks/lib/rule-enforcer.js` | **新檔** — 三種 hook 共用的判定核心（純函式） |
| `hooks/lib/bypass-handler.js` | **新檔** — bypass 機制 + audit log |

### 5.2 Server

| 檔案 | 改動 |
|------|------|
| `src/routes/compliance.js` | 接 bypass audit log；查詢 bypass 紀錄的 API |
| `src/public/index.html` | admin 介面新增「Bypass 紀錄」分頁 |

### 5.3 Shared

| 檔案 | 改動 |
|------|------|
| `shared/iron-rule-tier.js` | 加 `getCriticalRules(rules)` helper |
| `shared/secret-detect.js` | v1.19.1 引入的 detector、本版直接借用 |

### 5.4 安裝腳本

| 檔案 | 改動 |
|------|------|
| `install.sh` / `install.ps1` | 增加 `git pre-commit hook` 自動安裝步驟（symlink 到 `~/.ownmind/hooks/`） |
| `scripts/migrate-hooks.sh` | **新檔** — 既有 user 升級時把 hook 接上 |

### 5.5 文件

- `README.md`：「Iron Rule Enforcement Engine」段大幅擴充、加 v1.20 卡控說明
- `docs/README.zh-TW.md` / `docs/README.ja.md`：同步
- `CHANGELOG.md`：加 v1.20 條目
- `FILELIST.md`：加新 hook + lib 檔

---

## 6. 待 Vin 拍板（7 件事）

### 6.1 跨工具範圍

| 選項 | 說明 |
|------|------|
| **A. Claude Code + Codex 先做、Cursor/Gemini 後補**（建議） | 兩家有 PreToolUse hook、能完整覆蓋三層；Cursor 沒有相容 hook 點、只能走 git pre-commit |
| B. 全部一次做完 | 等 Cursor 推出 hook 機制再開始 |
| C. 只做 Claude Code | 範圍最小、最快出貨 |

### 6.2 Bypass 機制

| 選項 | 說明 |
|------|------|
| **A. 環境變數 + audit log**（建議） | `OWNMIND_BYPASS=IR-008 git commit -m "..."` → 跳過 + 寫 audit；明確、易追溯 |
| B. 互動式確認 | hook 偵測到違反 → 跳訊息「真的要跳過嗎」→ user 輸入 y/N |
| C. Admin UI 預先核准 | 透過 admin 介面預先核准某條鐵律暫時關閉 N 小時 |

### 6.3 Reply-lint 卡控模式

| 選項 | 說明 |
|------|------|
| **A. 硬擋（exit 2）讓 AI 重做**（建議） | 違反時 hook 回 exit 2、Claude Code 把錯誤訊息回 AI、AI 自己修正再送 |
| B. 軟擋（exit 0 + warning） | 維持現況、只是警告升級得更顯眼 |
| C. 自動改寫 | AI 寫完後 hook 用另一個 LLM 自動改寫成符合規範的版本 |

### 6.4 IR-012 品管三步驟怎麼偵測

| 選項 | 說明 |
|------|------|
| **A. 看 session log 有沒有 verification 紀錄**（建議） | hook 跑 `ownmind_search` 查本 session 的 compliance event |
| B. 看本機檔案標記 | 跑完 verification 寫 `.ownmind/verification-passed` flag、commit 時檢查 |
| C. 不擋、改 warning | 太難偵測、改成 default tier |

### 6.5 IR-038 觀測資料怎麼偵測

| 選項 | 說明 |
|------|------|
| **A. 維持警告、不硬擋**（建議） | 偵測 Edit 含 `fix` 字樣 → 顯眼提示「有先看 log 嗎」、但不擋 |
| B. 嘗試硬擋 | 偵測「修改前 30 秒內沒讀過任何 log/trace 檔案」→ 擋；可能誤判很多 |
| C. 從 critical 降為 default | 承認這條難以邏輯化、回歸提醒模式 |

### 6.6 Hook 執行的效能 SLA

| 選項 | 說明 |
|------|------|
| **A. < 100ms p95**（建議） | 跟業界 git hook 慣例對齊、user 感覺即時 |
| B. < 500ms p95 | 寬鬆、給複雜 detector 空間 |
| C. 不設 SLA | 看實際情況 |

### 6.7 既有 user 升級流程

| 選項 | 說明 |
|------|------|
| **A. SessionStart 偵測 + 引導手動跑 migrate**（建議） | SessionStart 偵測 hook 沒裝、跳訊息「跑 `ownmind migrate-hooks`」 |
| B. 自動安裝 | install.sh / OwnMind upgrade 時自動 symlink hook、有風險（覆蓋既有 hook） |
| C. 不自動、純文件 | README 寫一段「升級到 v1.20 要手動跑這個」 |

---

## 7. 風險與緩解

| 風險 | 機率 | 影響 | 緩解 |
|------|------|------|------|
| Hook 誤擋、卡死工作流 | 中 | 高 | Bypass 機制（§6.2）+ 完整 audit log + 每條鐵律有明確 detect 邏輯說明 |
| Hook 跑得慢、commit 變難用 | 中 | 中 | 效能 SLA（§6.6）+ benchmark 測試 + 並行偵測 |
| 跨工具不一致 | 高 | 中 | git pre-commit 當保底防線（跨所有工具）+ 接受「Cursor 只走 git 層」這個現實 |
| Reply-lint 硬擋造成對話卡死 | 中 | 高 | 配 retry 上限（連續擋 3 次後降為 warning） |
| 既有 user 升級炸 | 中 | 高 | §6.7 引導手動跑、不自動覆蓋既有 hook |
| Bypass 被濫用、變成形式擋控 | 高 | 中 | Bypass audit log + admin UI 可視化 + 每週 review |

---

## 8. 跟既有專案的關係

| 項目 | 關係 |
|------|------|
| **v1.19 iron-rule-tier** | 直接接續、v1.20 是 v1.19 的執行邏輯實作 |
| **v1.19.1 secret-tool-routing** | 共用 `shared/secret-detect.js`、IR-002 的 pre-commit 偵測直接 reuse |
| **project_373（v3 路線 C）** | 不衝突；路線 C 是鐵律品質指標、v1.20 是執行；兩個是同一個願景的不同層 |
| **project_342（LLM 鐵律 lint）** | 不衝突；LLM lint 是 default tier 的升級、不在本版 |
| **IR-027（提醒無效）** | 本版是 IR-027 的長期解 |

---

## 9. 下一步

1. **Vin 拍板 §6 的 7 件事**
2. 寫 `spec.md`（GIVEN/WHEN/THEN 場景，預估 20~30 個）
3. 寫 `tasks.md`（任務清單，預估 5~6 週工作量）
4. 走 TDD（IR-003）：每個 hook 先寫測試
5. 品管三步驟（IR-012）：verification → request review → handle review
6. 同步 README / FILELIST / CHANGELOG（IR-008、IR-032）
7. 三處版號同步（IR-031）：package.json、SERVER_VERSION、git tag
8. Browser 實測（IR-020）：admin UI Bypass 紀錄分頁
9. Tag v1.20.0、push、部署 prod、跑兩週看誤擋率
10. v1.20.1：根據兩週觀察調 detect 規則

---

## 10. 一句話定位

> v1.19 給鐵律掛了等級標籤。v1.20 讓標籤真的有意義。

沒做這版、OwnMind 的鐵律系統等於「貼在牆上的告示」——AI 看到了、然後該違反還是違反。
