# v1.17.66 — Windows 平台硬化 + 觀測管道修補

- **Author**: Vin
- **Date**: 2026-05-08
- **Status**: Draft（等 Eric 工作排程器歷程截圖驗證 Bug #7 假設）
- **Worktree**: `objective-shamir-162fe2`
- **Branch**: `vin/objective-shamir-162fe2`

---

## 1. 為什麼要做這次改動

2026-05-07 ~ 05-08 連續兩天，Eric（莊宗庭）和 Adam 在 Windows 上跑 `bootstrap.ps1` 升級到 v1.17.65 都遭遇相同失敗劇本：

1. `git pull` / `npm install` / `install.ps1` / `Task Scheduler 重註冊` 全 OK
2. 走到 `verify_local` 步驟突然失敗
3. 連帶觸發 `rollback`，但 rollback 也因目錄被佔用失敗
4. 兩次失敗 ironically 反而保住了新版本

外加 Eric 額外回報：「OwnMind 觸發時會不定時跳出 PowerShell 視窗，沒在用 Claude 也會跳」，影響工作體驗。

進一步調查後發現這**不是單一 bug**，而是一連串 Windows 平台處理不當的累積，且這已經是**第三波同類踩坑**：

| 版本 | Windows 相關 bug |
|---|---|
| v1.17.62 | Windows EINVAL + MCP 心跳卡舊版 |
| v1.17.65 | autostash fallback 死路徑 |
| **v1.17.66**（本次） | 七個獨立 bug，根因都在「shell / path / process spawn 假設了 Unix 行為」 |

依 systematic-debugging skill 的 Phase 4.5：**3+ 個同類修補失敗 = 架構性問題，不能再貼 OK 繃**。

---

## 2. 七個 bug 與根因（從真實 log + 程式碼證據）

### Bug #1 — PowerShell 直接呼叫 `bash` 解到 WSL relay
- **觸發點**：[scripts/interactive-upgrade.ps1:120,125,130](../../../scripts/interactive-upgrade.ps1)（共 3 處）
- **證據**：Eric log line 79–86：`<3>WSL ERROR: CreateProcessEntryCommon:505: execvpe /bin/bash failed 2`；Adam log 同
- **根因**：Windows 10/11 內建 `C:\Windows\System32\bash.exe` 是 WSL relay（沒裝 distro 也存在）；PowerShell 的 PATH 解析優先 System32，所以 bare `bash` 必定中
- **嚴重度**：🔴 P0（自動升級失敗主因）

### Bug #2 — `execFile + shell:true` 在 Windows 被 cmd 包，吃掉 PowerShell pipeline
- **觸發點**：[scripts/install-helpers/self-check.cjs:195-197](../../../scripts/install-helpers/self-check.cjs)
  ```js
  await execFileAsync('powershell.exe',
    ['-NoProfile', '-Command', "Get-ScheduledTask ... | Select-Object ..."],
    { timeout: TIMEOUT_MS, shell: true });   // ← 真因
  ```
- **證據**：兩台一字不差的錯誤訊息：`'Select-Object' is not recognized as an internal or external command`；外加 DEP0190 deprecation warning
- **根因**：Node `execFile` 加 `shell:true` 在 Windows 包 `cmd.exe`；cmd 把 args 重組後吃 `|`，把 `Get-ScheduledTask ...` 的 stdout pipe 給「`Select-Object`」這個它不認識的外部命令
- **嚴重度**：🔴 P0（self-check scheduler 永遠 false fail）

### Bug #3 — `verify-upgrade.sh:49` 餵 MSYS path 給 native `node.exe`
- **觸發點**：[scripts/verify-upgrade.sh:49](../../../scripts/verify-upgrade.sh)：`node -p "require('${OWNMIND_DIR}/package.json').version"`
- **證據**：Adam 在 Git Bash 手跑：`Cannot find module '/c/Users/Adam/.ownmind/package.json'`
- **根因**：Git Bash 的 `$HOME=/c/Users/...`（MSYS 格式），Win32 `node.exe` 不認 `/c/` 開頭
- **嚴重度**：🟡 P1（次要 bug，要 #1 修好之後才浮出 → 延 v1.17.67）

### Bug #4 — 升級失敗時 self-check 不被觸發、上傳失敗不重試
- **觸發點**：[scripts/interactive-upgrade.ps1:122](../../../scripts/interactive-upgrade.ps1) `Fail` exit 早於 line 172 self-check.cjs 呼叫
- **證據**：Adam 401 → self-check.cjs 上傳失敗即丟，server `install_check_logs` 表沒收到任何資料
- **根因**：失敗路徑沒走 `try/finally` 結構保證觀測；self-check.cjs:291-316 沒 retry / 沒 spool
- **嚴重度**：🔴 P0（最該收資料的時候反而靜默 = 反向觀測）

### Bug #5 — Windows rollback 被檔案鎖卡住
- **觸發點**：interactive-upgrade.ps1 內 `Rollback` function
- **證據**：兩台都看到 `Cannot remove ... because it is in use`
- **根因**：MCP server / Task Scheduler / 開著的 Claude Code 持有 `.ownmind` 內 file handle；rollback 沒先停這些 process
- **嚴重度**：🟢 P2（修了 #1 之後不會被觸發 → 延 v1.17.67）

### Bug #6 — PowerShell `Out-File` 預設 UTF-16 BOM
- **觸發點**：[scripts/interactive-upgrade.ps1:120,125,130](../../../scripts/interactive-upgrade.ps1) `| Out-File -Append $LogFile`
- **證據**：Eric log 中文 garbled，每個字元之間 0x00（UTF-16 LE BOM 特徵）
- **根因**：PowerShell `Out-File` 預設編碼是 Unicode（UTF-16 LE），現代工具預期 UTF-8
- **嚴重度**：🟡 P1（觀測管道污染 — log 上傳到 server 也會壞資料）

### Bug #7 — Scanner Task Scheduler 跳 console 視窗
- **觸發點**：[scripts/windows/register-scanner-task.ps1:78-100](../../../scripts/windows/register-scanner-task.ps1)
- **證據**：Eric 回報「不定時跳出視窗，沒用 Claude 也會跳」；歷程截圖待補
- **根因**：
  - `-LogonType Interactive` + console subsystem binary `node.exe` = Windows 必開 console window
  - `-StartWhenAvailable` + 9999 天 RepetitionDuration → Windows 對錯過的 trigger 會 catch-up 補跑（電腦休眠醒來、闔上筆電開回來都會連續跳幾個視窗）
- **嚴重度**：🔴 P0（直接傷害日常 UX，每天閃幾十次）

---

## 3. 架構性發現（Phase 4.5）

七個 bug 的共通模式：

> **Shell / path / process spawn 假設了 Unix 行為，在 Windows 環境系統性失敗。**

OwnMind 缺三個 Windows 共用層：

1. **`find-git-bash` 偵測 helper** — 避開 WSL relay，所有需要呼叫 bash 的 PowerShell 腳本都用同一支
2. **`safe-spawn` Node 包裝** — Win32 `execFile` 預設禁 `shell:true`、強制 `windowsHide: true`、自動 timeout
3. **`path-to-win32` Node helper** — MSYS `/c/...` ↔ Win32 `C:\...` 統一轉換，餵 native binary 前先正規化

不建這三個 helper，下一個版本會踩第八個雷。本次必須一起做。

---

## 4. 範圍

### v1.17.66 包含

| 項目 | 對應 Bug | 修法概要 |
|---|---|---|
| **Helper #1** `find-git-bash.ps1` | #1 | 三段式偵測：`.git-bash-path` cache → 常見路徑 → `where bash` 過濾 WSL relay |
| **Helper #2** `safe-spawn.cjs` | #2, #6 | 包 execFile，預設 `shell:false` + `windowsHide:true` + 5s timeout |
| **Helper #3** `path-to-win32.cjs` | (預留 #3 v1.17.67 用) | `/c/X` → `C:\X` 雙向 |
| **Helper #4** `run-hidden.vbs` | #7 | wscript GUI subsystem launcher，徹底隱藏 console |
| **Bug #1 修** | #1 | interactive-upgrade.ps1 三處 bare `bash` → `& (Find-GitBash)` |
| **Bug #2 修** | #2 | self-check.cjs:197 拿掉 `shell:true` |
| **Bug #4 修** | #4 | interactive-upgrade.ps1 self-check 改 `try/finally` 保證執行；self-check.cjs 上傳失敗寫 spool（next run retry） |
| **Bug #6 修** | #6 | 全部 `Out-File` 加 `-Encoding utf8` |
| **Bug #7-a 修** | #7 | scanner task action 改 `wscript.exe run-hidden.vbs node.exe scanner.js` |
| **Bug #7-b 修** | #7 | task settings 加 `-DontStartOnBatteries -StopIfGoingOnBatteries`；頻率 30 → 120 分 |
| **環境資訊收集** | (Vin 指定) | `install_check_logs.full_log` 擴充 schema（見 spec.md §3） |
| **Admin dashboard view** | (Vin 指定) | `/ownmind/admin/install-check` 列每個 user 最近 5 次 self-check + 失敗高亮 |

### v1.17.67 / v1.18.0 留

- Bug #3（verify-upgrade.sh MSYS path）— 等 v1.17.66 部署 24~48h 收真實樣本
- Bug #5（rollback 鎖檔）— 同上，需要先設計「停 MCP / Task Scheduler 再 rollback」的 protocol
- Scanner 事件驅動架構（MCP fs.watch + 一天一次 catch-up） — 重大重構

### Rollback 觸發矩陣（review fix — 釐清升級各步驟的失敗策略）

**走 Rollback + Fail（升級必要條件失敗 → 還原舊版）**：
| 步驟 | 為什麼必要 |
|---|---|
| `git_pull` | 沒拉到新版本，後續所有改動都白做 |
| `npm_install` | MCP 依賴沒裝，runtime 直接壞 |
| `install` | skill / hook / git-hooks 沒同步，鐵律執行引擎失效 |

**走 Step warning，不 Rollback（事後體檢，不擋升級）**：
| 步驟 | 為什麼不必要 |
|---|---|
| `reschedule` | Task Scheduler 沒重註冊，scanner 仍可用舊註冊 |
| `verify_local` | 本地元件 grep — 體檢用，不影響 runtime |
| `verify_server` | server 連線體檢，可能僅網路暫斷 |
| `cleanup` | 測試資料殘留不影響功能 |
| `dismiss` | 升級廣播沒清，只是 UI 殘留 |

**核心原則**：Rollback 只用於「不還原 = 系統壞掉」，verify 是事後觀測，失敗時走 self-check 上傳 server 留證據（IR-038），而非把使用者拖回舊版。

---

## 5. 觸發的鐵律

| 鐵律 | 怎麼落實 |
|---|---|
| **IR-003** 修 bug 前先寫 reproduction test | tasks.md 第 1 階段：先寫 7 條 reproduction test |
| **IR-004** 使用 OpenSpec 開發流程 | 本份 OpenSpec 即為落實 |
| **IR-005** 不要 blind edit | Phase 1 hypothesis tree + Eric/Adam 真實 log 為證據 |
| **IR-007** Persistent Bug Protocol | 同類雷第三次，啟動正式流程 + Phase 4.5 架構重構 |
| **IR-008** commit 必須同步 README/FILELIST/CHANGELOG | tasks.md 收尾階段 |
| **IR-022** OwnMind 功能修改必須 Server + Client 兩端 | 環境資訊收集 = client 收 + server 存 + admin 看 |
| **IR-027** 提醒無效，邏輯才有效 | self-check 上傳改邏輯卡控（try/finally + spool），不依賴使用者「記得跑」 |
| **IR-031** 三處版號必須同步 | tasks.md 收尾：`package.json` + `SERVER_VERSION` + git tag |
| **IR-032** OwnMind README 三語系必須同步 | tasks.md 收尾：README.md + README.en.md + README.ja.md（或實際存在的語系） |
| **IR-038**（候選）修 bug 前必須先確保有足夠的觀測資料 | 環境資訊收集擴充 + admin view 即為落實；commit 後 `ownmind_save` 寫入 |

---

## 6. Out of scope

- 重構 scanner 為事件驅動（MCP `fs.watch`）— v1.18.0
- 把 MCP 改 Windows Service（避開 Task Scheduler）— 沒必要，v1.17.66 修法已經夠
- 取消 30/120 分鐘輪詢，改純事件 — 需要先驗證 fs.watch 在 Windows 下穩定性
- WSL 真正使用者支援（有裝 distro 想用 WSL bash）— 沒人提過，先不做

---

## 7. 風險

| 風險 | 緩解 |
|---|---|
| VBS launcher 被 Windows Defender / 企業防毒誤判 | 用 `wscript.exe` 是社群最廣標準解；若仍誤判，加 README 說明白名單 |
| `find-git-bash` 偵測不到、user 沒裝 Git Bash | fallback `& powershell.exe` 跑 .ps1 版的 verify-upgrade（待 v1.17.67 做 .ps1 版本，本版只 fail-loud） |
| 改 Out-File 編碼後既有 log parser 看不懂 | 既有 parser 已是 UTF-8 expectations（Eric log 證實）；改完反而正常 |
| 環境資訊收集涉及 PII（hostname、PATH） | self-check.cjs 已有 `sanitizePath`；新增欄位走同 redaction 路徑 |
| Task 頻率 30→120 分鐘讓資料變稀疏 | scanner 撈的是過去 log，2hr 延遲不影響準確度；admin dashboard 已有「資料延遲」標示 |

## 8. Code Review 處理紀錄（superpowers:code-reviewer，2026-05-08）

reviewer 提了 6 個風險點 + 2 個額外發現。技術評估後處理：

### 已採納並修正

| # | 問題 | 修法位置 |
|---|---|---|
| #2 | `safeSpawn shell:true override` 只 log warning（Task Scheduler stderr 沒人看） | [safe-spawn.cjs](../../../scripts/install-helpers/safe-spawn.cjs) 改強制 `throw`，caller 真要過 shell 自己用 `child_process.execFile` |
| #3 | spool 並行 race condition（read-then-write 會丟資料） | [self-check.cjs retrySpool](../../../scripts/install-helpers/self-check.cjs) 改 rename pattern：`spool` atomically rename 到 `.processing.<ts>.<pid>` 處理，新 appendSpool 寫到新建立的 spool；失敗 entries 用 `appendFileSync`（O_APPEND atomic）回主 spool |
| #4 | `WSL_DISTRO_NAME` 可含使用者命名（"Adam-Ubuntu"），洩 PII | [detectShellChain](../../../scripts/install-helpers/self-check.cjs) 改 boolean `'wsl'` 標記，不傳實際 distro 名稱 |
| **#5** | **PowerShell `exit` 在 try 內可能跳過 finally**（MS docs 說會跑，但實測有 bug 報告） | [interactive-upgrade.ps1 Fail()](../../../scripts/interactive-upgrade.ps1) 改 `throw "ERROR:..."`，外層加 `catch { print + exitCode=1 } finally { Run-SelfCheckOnce } ; exit $exitCode`。確保 IR-038 觀測管道在最該收料的失敗路徑也能執行 |
| #6 | spec 沒明文哪些步驟 Rollback、哪些 warning，下次 reviewer 會踩同問題 | proposal.md §4 加「Rollback 觸發矩陣」明確列：git_pull/npm_install/install → Rollback；reschedule/verify_local/verify_server/cleanup/dismiss → warning |
| 附 | `register-scanner-task.ps1:118 description` 還寫「every 30 minutes」(IR-008 三同步) | 改為 `every 120 minutes` |

### 拒絕（push back，理由附證據）

| # | reviewer 建議 | 拒絕理由 |
|---|---|---|
| #1 EDR auto-fallback | 註冊後立即 `Start-ScheduledTask` 驗 `LastTaskResult`，非 0 fallback 直跑 node.exe | **YAGNI** — 沒任何 user 回報 wscript 被 EDR 擋；fallback 增加複雜度（要區分「真失敗」vs「EDR 擋」）；若未來真有 case，再走 v1.17.67。本版只在 README 加白名單建議（待後續 commit） |
| 附 | `find-git-bash.ps1` cache hit 仍跑 `bash --version`，每次多 50ms | reviewer 自承 low risk + 留 v1.17.67；Find-GitBash 不在 hot path（一次升級一次呼叫），50ms 開銷可接受 |

### 已澄清（reviewer 認知偏差）

| reviewer claim | 實際情況 |
|---|---|
| 「IR-031 三處版號要檢查 `mcp/index.js` SERVER_VERSION」 | repo 沒有 `SERVER_VERSION` 常數。實際是 [mcp/index.js:154 `CLIENT_VERSION`](../../../mcp/index.js)，從 `package.json` **動態讀**，改 `package.json` 即同步。三處版號 IR-031 落實點是 `package.json` + 三個 README，已全改 |
| 「三語 README 確認檔名」 | 實際存在：`README.md`（英）+ `docs/README.zh-TW.md` + `docs/README.ja.md`，全已同步 |
