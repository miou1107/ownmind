# OwnMind 更新紀錄

## v1.17.79 — 統一錯誤 spool 機制 + interactive-upgrade dirty tree 自動處理（vin-windows-test 第三輪）

**背景**：v1.17.77/78 修了 start.cmd fallback 跟 install_started beacon，但 vin-windows-test 第三輪測試發現他升級到 v1.17.78 沒成功（DB 看 collector_heartbeat 還停 1.17.75）。診斷出兩個結構性盲點：

1. **AI 助手 local edit 擋住升級** — 上輪他的 AI 編輯 mcp/start.cmd 加 fallback 沒 commit，下次 `git pull --ff-only` 直接被 reject、整個升級卡住
2. **client 端各種失敗都沒回報管道** — install / upgrade / hook / scanner / start.cmd 失敗都靜默死掉，server 完全看不到。v1.17.78 的 install_started beacon 只覆蓋 install 開頭，runtime 失敗（如 start.cmd 找不到 node）依然盲

**修法（廣域觀測管道）**：

### 1. `errors/` spool 統一機制
- 所有失敗點寫 `~/.ownmind/logs/errors/<unix_ms>-<kind>.json`（或 cmd.exe 寫 `.txt` key=value 格式）
- self-check.cjs 加 `drainErrorSpool()`：把目錄裡的所有檔案上傳到 `/api/debug/install-check`（v1.17.78 已放寬 endpoint），成功就刪、失敗下次再試
- Drain 觸發點：每次 self-check（含 install/upgrade 結尾、scheduler 跑 scanner、user 手動 trigger）

### 2. Cross-platform helpers
- `scripts/install-helpers/report-error.cjs` — Node 主力 helper（HOME 路徑 sanitize / context-file 讀尾 30 行 / atomic write）
- `scripts/install-helpers/report-error.sh` — bash function `report_error <kind> <detail> [context]`，內部呼叫 .cjs
- `scripts/install-helpers/report-error.ps1` — PowerShell `Report-Error -Kind ... -Detail ... [-ContextFile ...]`

### 3. interactive-upgrade.{sh,ps1}：dirty tree 自動處理
- 偵測 `git status --porcelain` 非空
- drop `upgrade_dirty_tree` error report（含 dirty file 清單）
- `git fetch && git reset --hard origin/main` 強制對齊（backup 已在前一步完成，安全網 OK）
- 既有 clean 路徑走 `git pull --ff-only` 不變

### 4. 失敗點 wire（每個 fatal-path 落 error report）
- `install.sh` / `install.ps1`：winget / git clone / git pull / npm install
- `interactive-upgrade.{sh,ps1}`：git pull / npm / verify
- `mcp/start.cmd`：找不到 node 時 echo `key=value` 到 errors\<ts>-mcp_start_no_node.txt，下次 self-check drain
- self-check 自身的 fail check 會經由 install-check spool 走（已存在）

**為什麼分 .json + .txt 兩種格式**：cmd.exe 寫 JSON 要處理 escape 太痛苦，讓 cmd 寫簡單 key=value，drainErrorSpool 內 `parseKeyValueText` 統一轉換。`.sh` / `.ps1` / `.cjs` 都呼叫 report-error.cjs 寫 `.json`。

**驗證**：
- 新增 `tests/error-spool-mechanism.test.js`（15 條：spool 寫檔 / 特殊字元 / context-file / drain 上傳刪檔 / drain 5xx 保留 / drain no-creds / drain no-dir / dirty tree 三條 sh + 三條 ps1 / start.cmd 寫 errors/）
- npm test **846/846 pass / 0 fail**（v1.17.78 → v1.17.79 多 15 條）

**鐵律觸發**：IR-006（reproduction test 先寫）/ IR-007（vin-windows-test 第三輪）/ IR-008 / IR-022（Server + Client 同時涵蓋 — 此次純 client 端結構性改動）/ IR-031 / IR-032 / **IR-038（觀測管道完善）✅**

**升級指引**：對既有 user 完全無感。下次升級碰到 dirty tree 會自動對齊（之前會 fail）；start.cmd 找不到 node 時不再靜默壞掉；admin dashboard 開始看到全 client 端各種失敗事件。

## v1.17.78 — install_started beacon 補 IR-038 觀測盲點（vin-windows-test 第三輪）

**背景**：vin-windows-test (user_id=8) 安裝後查 DB 發現 `install_check_logs` **0 row**。Root cause：

- `install.ps1` 中段任何 fatal error（npm install 被 ExecutionPolicy 擋、winget 失敗、git clone 失敗）都會 `Write-Error + exit 1`
- end-of-file 的 `self-check.cjs` 是「success path 才會跑」 — 中段死掉就沒紀錄
- vin-windows-test 真實案例：他卡在 npm install 那段（v1.17.76 修 ExecutionPolicy 之前），self-check 從來沒跑到 → admin 看不到他試過裝

v1.17.76 修了 ExecutionPolicy block 點，但中段其他失敗仍是同樣盲點。**IR-038 直接適用**：「修 bug 前必須先確保有足夠的觀測資料能持續追蹤該 bug」。

**修法（兩端對稱補洞）**：

### Server: `src/routes/debug.js`
- `POST /api/debug/install-check` 放寬欄位驗證：只強制 `ts`，`checks` / `summary` 改選填
- 接受 beacon-style minimal payload（`{ ts, trigger, client_version, platform, machine }`）
- 完整 self-check report（含 checks/summary）仍向後相容

### Client: `install.ps1` + `install.sh`
- API key/URL 確認後立刻送 `install_started` beacon（fire-and-forget，5s timeout）
- 失敗不擋 install（network 沒通也照樣裝得起來）
- 即使中段死掉，admin 至少看得到 user 8 試過、什麼版本、哪台機器、什麼 platform

**驗證**：
- 新增 `tests/install-started-beacon.test.js`（7 條：minimal beacon 接受 / 完整 report 向後相容 / 沒 ts reject / checks 非 array reject / status 不合法 reject / install.ps1 含 beacon code / install.sh 含 beacon code）
- npm test **831/831 pass / 0 fail**

**鐵律觸發**：IR-006（reproduction test 先寫）/ IR-008 / IR-022（Server + Client 同改）/ IR-031 / IR-032 / **IR-038（觀測管道完善）✅** ← 這版的核心目的

**升級指引**：純機制改善，user 完全無感。下次新 user 安裝就會有 install_started beacon 進 DB；vin-windows-test 那筆歷史 gap 不能補（資料沒了），但**未來不會再發生**。

**關於 token_events.native_cost_usd 的後續說明**：上輪報告誤判 — 這欄位是 client scanner 的 advisory data（可空），server-authoritative cost 在 `token_usage_daily` 由 nightly recompute（每日 03:00 Asia/Taipei）算。user 8 第一個 03:00 還沒過，`token_usage_daily` 才是空的（不是 pricing 缺）。`model_pricing` 表 Sonnet 4.6 已存在 3/15 USD/MTok。

## v1.17.77 — 修 v1.17.76 沒守到的下一層：start.cmd fallback + User PATH 持久化（vin-windows-test 第二輪）

**背景**：v1.17.76 修了「裝 OwnMind 時自動裝 node」，但 vin-windows-test 安裝完後 Claude Code 還是無法連到 OwnMind MCP。他的 AI 助手診斷出根因：

- winget 把 node 裝到 `C:\Program Files\nodejs\`，PATH 只更新 Machine scope
- **Claude Code 早就在跑**（PATH frozen 在啟動時），spawn `cmd.exe /c start.cmd` 時繼承的 PATH 是 stale 的
- `where node` 找不到 → MCP server 永遠起不來
- vin-windows-test 那邊的 AI 自己改了 `start.cmd` 加 fallback 才繞過 — 但這修在使用者本機，**沒回灌到 source = 下個新 user 還是中**

**修法（兩層守住）**：

### `mcp/start.cmd`（runtime fallback，守住「user 還沒重啟 Claude Code」窗口）
```
1. where node                                       (PATH 最快路徑)
2. C:\Program Files\nodejs\node.exe                 (winget 預設)
3. %ProgramFiles%\nodejs\node.exe                   (相容非 C: 系統碟)
4. %LOCALAPPDATA%\Programs\nodejs\node.exe          (winget --scope user)
```
全部 miss 時錯誤訊息列出每個試過的路徑 + 提示重啟 Claude Code。

### `install.ps1`（install-time 持久化，下次重啟後就不用 fallback）
- Install + version check 通過後，把 node 安裝目錄寫入 **User PATH**（`SetEnvironmentVariable scope=User`）
- User PATH 跟 Machine PATH 都不在 = append；已在任一個 = skip（idempotent）
- 寫失敗不致命（fallback 還在）

**驗證**：
- 新增 `tests/start-cmd-node-fallback.test.js`（5 條 contract test）
- npm test **824/824 pass / 0 fail**

**鐵律觸發**：
- IR-006（reproduction test 先寫）✅
- IR-007（Persistent Bug Protocol — vin-windows-test 第二輪回報，把 local 修補回灌 source）✅
- IR-008 / IR-031 / IR-032（package.json + 三語 README + FILELIST/CHANGELOG 同步）✅
- IR-022（Server + Client 兩端檢查 — 此次純 client 改動）✅
- IR-038（觀測資料 — 上次發現 install_check_logs 應有但沒有；此 commit 不修，列為下一輪）

**升級指引**：
- 既有已裝 user：跑 OwnMind 升級流程，會更新 start.cmd（runtime fallback 立即生效）+ install.ps1（下次裝才用得到）
- 全新 user：bootstrap 走完，PATH 會持久化、start.cmd 也有 fallback —**重啟 Claude Code 後即可使用**（不必重開 terminal）

## v1.17.76 — 缺 Node.js / git 時 install.ps1 + install.sh 自動安裝（vin-windows-test 回報）

**背景**：vin-windows-test 在 Windows 全新環境第一次跑 install.ps1，因為沒裝 Node.js 直接 `Write-Error + exit 1`，user 只看到「請到 nodejs.org 安裝」就卡住。同檔案第 42-61 行對 sqlite3 已有完整「winget auto-install + fallback」pattern，但 pattern **沒套到 node / git** — 對最常見的「全新 user」情境最不友善。從實際安裝 log 採證還抓到三個延伸問題：

1. **node 缺失只 Write-Error exit** — sqlite3 那段 pattern 沒套到 node / git
2. **winget 裝完當前 PowerShell session PATH 沒生效** — user 必須關 terminal 重開才能繼續
3. **PowerShell 預設 ExecutionPolicy 擋 npm install** — 中段 `npm install` 被擋住、`node_modules` 沒建好

**修法**：

### `install.ps1`
1. **入口設 `Set-ExecutionPolicy -Scope Process Bypass`** — 只影響當前 process，避免 user 預設 Restricted policy 擋 npm。
2. **`Reload-Path` helper** — 從 `Machine` + `User` scope 重組 `$env:Path`，winget 裝完直接生效，user 不必重開 terminal。
3. **`Install-WithWinget` helper** — 抽 sqlite3 那段 pattern 成可重用 function，wire 給 `git` (`Git.Git`) 和 `node` (`OpenJS.NodeJS.LTS`)。失敗時帶手動安裝 URL fallback。
4. **Node 版本驗 v20+** — winget OpenJS.NodeJS.LTS 偶爾 manifest 命名漂移到 v24（vin-windows-test log 確認），所以驗版本只擋過舊（< v20）不擋過新。

### `install.sh`
- **mac**：缺 node 時嘗試 `brew install node`（fallback 給 nodejs.org / brew.sh 連結）。
- **linux**：缺 node 時提示 apt / dnf / nvm 三選一指令（不自動 sudo）。
- **windows (Git Bash)**：缺 node 時提示改跑 install.ps1。
- **node 版本驗 v20+** — 跟 ps1 對齊。

**驗證**：
- 新增 `tests/install-prerequisite-auto-install.test.js`（7 條 contract test：ExecutionPolicy / winget OpenJS.NodeJS.LTS / Reload PATH Machine+User / winget Git.Git / Node v20 check / mac brew install node / linux apt|dnf 提示）
- npm test 819/819 pass / 0 fail（先 red 後 green、TDD 流程，IR-006）

**鐵律觸發**：
- IR-006（修 bug 前先寫 reproduction test）✅
- IR-008（commit 同步更新 README/FILELIST/CHANGELOG）✅
- IR-022（OwnMind 功能修改必須同時檢查 Server + Client 兩端 — 此次只改 client install scripts，Server 無影響）✅
- IR-031（package.json + 三語 README 版號同步）✅
- IR-032（OwnMind README 三語系必須同步更新）✅

**升級指引**：對既有 user 完全無感（已裝過 node 的人 detection 直接跳過）。新 user 第一次裝會看到「未偵測到 Node.js → 嘗試用 winget 自動安裝 OpenJS.NodeJS.LTS」訊息，全程不需手動干預。

## v1.17.75 — 文件化 Claude Code 體驗降級的根本原因（β 路線：保留 hook / 不再投資補救）

**背景**：v1.17.71 → v1.17.74 連續 4 版投資「OwnMind 在場感」hook 線（PostToolUse hook 寫 /dev/tty / fallback file），但 Vin 實測 + 對 claude-code-guide subagent 諮詢後得出 authoritative 結論：

- **/dev/tty 在 Claude Code spawn 的 hook subprocess 一律 ENXIO**（Mac/Linux 都不可用、app 環境更慘 — 連 controlling terminal 都沒）
- **hook 所有通道（stderr / stdout / additionalContext）都進 AI 那一側**，沒有「直接給 user 看」的內建管道
- **Issue #11120**「顯示 hook stdout」被 Anthropic **closed as not planned**（明確不打算做）
- **Claude Code 設計哲學**：chat 訊息流是 AI 獨佔，MCP / hook 不該繞過 AI 直接往 user UI 塞東西
- 但 Vin 在 **Gemini CLI** 跑同一個 OwnMind MCP server，**banner 自然嵌在訊息流、user 看得到** — 證實 OwnMind server 端設計沒問題、是 Claude Code 的 UI 哲學特殊

**結論**：OwnMind 的 banner 設計從 server 端做對了。**Gemini CLI / Codex CLI / Cursor / Copilot / OpenCode / Windsurf 等其他 MCP client 都會自然 work**（UI 不摺疊 + AI 老實轉述）— 只有 Claude Code 兩端都拒絕（UI 摺疊 + Claude 經常吞）。v1.17.71-74 那條 hook 線本質是「OwnMind 替 Claude Code 補它自己的 UX 缺陷」，**OwnMind 沒義務這麼做**。

**修法**：選 β 路線 — 保留 hook 當降級補救（不 revert，避免破壞已升級用戶），但**清楚文件化** Claude Code 體驗降級的事實，不再為了補 Claude Code 投資新 hook 通道。

1. **三語 README** 新增 `## Client Experience Matrix` / `## OwnMind 在不同 AI 客戶端的體驗` / `## 異なるAIクライアントでのOwnMind体験` 區塊（IR-032）：
   - 對照表清楚列出每個 client 的 banner 體驗 + 為什麼
   - Gemini CLI / Codex CLI / Cursor 等標 ✅ 最佳體驗（UI 不摺疊 / stdout 直通）
   - Claude Code 標 ⚠️ 降級體驗（UI 摺疊 + AI 獨佔 chat），鏈到 Anthropic Issue #11120
   - 解釋現有 hook 是「事後在場感」（next SessionStart 補印），不是即時
   - **建議使用 Claude Code 以外的客戶端**獲得最佳體驗

**對 Vin 的建議路線（不在這個 commit 做、列為長期方向）**：
- δ：把 OwnMind 投資轉去其他能贏的地方 — admin dashboard 月報 / IR-027 攔截型卡控（不是提醒）/ 給 Anthropic 提結構性 issue（MCP server 沒 user-visible 通道）

**驗證**：
- npm test 812/812 pass / 0 fail（無 code 改動、純 docs）
- 三語 README 內容對照（IR-032）

**鐵律觸發**：IR-008 / IR-026 / IR-031 / IR-032 / 透明度原則（誠實揭露技術限制）。

**升級指引**：純文件改動。用戶不會感覺到 client 行為差異 — 但**會在 README 看到「為什麼自己用 Claude Code 看不到 OwnMind banner」的明確說明**。建議改用 Gemini CLI / Codex CLI 等其他 MCP client 獲得最佳體驗。

## v1.17.74 — 深化結構性 contract test：把 1 條變 8 條、覆蓋 broadcast / multi-part / 空 parts / 壞 parts 變體（v1.17.73 m-1 / m-6）

**背景**：v1.17.73 加了一條結構性 contract test（兩種 tool_response shape 產出 block 必須一致），但只覆蓋一種 banner 文字（kind + tip 雙 banner）。Code review 點到（v1.17.74+ m-1）：broadcast / multi-part / 空 parts / 壞 parts 都沒測，那些路徑的 path-specific bug 還是漏。

**修法**：把 contract test 表化（`contractCases` array），用 `for` loop 為每個 case 生成獨立 `it`，覆蓋 8 種變體：

| # | case | 預期 |
|---|---|---|
| 1 | 單條 kind banner | 抽到 |
| 2 | 雙條 banner（kind + tip） | 抽到 |
| 3 | 廣播 banner（📢 OwnMind 系統通知） | 抽到 |
| 4 | 廣播 + 一般 banner 混合 | 抽到 |
| 5 | banner 拆到多個 content parts | 抽到 |
| 6 | 空 parts array | 不該抽到 |
| 7 | 壞 part（type 有但 text 缺） | 不該抽到 |
| 8 | 純文字沒 banner | 不該抽到 |

每個 case 都同時驗：(1) 兩種 shape 一致決定要不要寫 pending file、(2) 預期抽到時兩種 shape 的 block 內容必須完全相同、(3) 預期不抽到時兩種 shape 都不該寫 file。

**順便修 v1.17.73 m-6**：原本 contract test 用 `fs.unlinkSync(pendingFile)` 在兩次 runHook 之間清，沒檢查 file 是否存在 — 對「expectBanner: false」case 會炸（檔不存在）。改成 conditional：`if (aHasFile) fs.unlinkSync(pendingFile)`。

**Mutation test 驗證拆雷威力倍增**：

| Mutation | v1.17.73（單條 contract） | v1.17.74（8 條參數化） |
|---|---|---|
| legacy 路徑斷掉（回 `[]`） | 3 條紅 | **7 條紅** |
| broadcast trigger 改成只認 `📢 OwnMind 系統 XXX`（更嚴格） | 2 條紅 | 2 條紅 |

leg 路徑 mutation 多抓 4 條（kind / tip / broadcast / broadcast+banner / multi-part 變體）。

**誠實揭露 contract test 盲點**：mutation B（broadcast 識別改嚴）下，[廣播 + 一般 banner 混合] case **沒紅** — 因為一般 banner 還是被抓到、block 還有內容，雖然 broadcast 部分兩種 shape 都掉了但比對相等。「兩 path 一致 ≠ 行為正確」。靠原本「支援廣播 banner」的絕對比對測試補位才抓到。

**Lesson learned（記給未來）**：
- contract test（relative invariant）跟 absolute test（固定預期值）是互補關係，不能彼此取代
- contract test 抓 path-specific 漂移；absolute test 抓 path-independent 行為崩壞
- 一個結構良好的測試套要兩種都有，比例上 absolute 多、contract 少（contract 主要是給 multi-path 函數防 path-divergence 用）

**驗證**：
- npm test 812/812 pass / 0 fail（v1.17.73 是 805、+7 contract case，原本的 1 條取代成 8 條 → 淨 +7）
- 雙重 mutation test 跑通（legacy 路徑 / broadcast trigger）

**鐵律觸發**：IR-007（深化拆雷）/ IR-008 / IR-026 / IR-031 / IR-032。

**升級指引**：純測試重構，hooks 行為零改動。用戶不會感覺到差異。意義在於更廣泛的 path-specific bug 會被多條 contract case 同時抓到。

## v1.17.73 — 結構性拆 v1.17.71/v1.17.72 那種「fixture 集體偽陽性」雷（IR-007 follow-through）

**背景**：v1.17.72 修了 v1.17.71 那個「19 條 fixture 全部用同一錯誤 shape → 803/803 測試全綠但 prod 100% 壞」的 bug。但 v1.17.72 是點修補 — 只加了 1 條 IR-007 regression test 守住 (A) shape 那條路徑。如果未來有人手滑、把這條測試刪掉或改成跟其他一樣的 shape，又會回到 v1.17.71 的雷型（fixture 集體偏向某一 shape → 另一條路徑壞掉沒人發現）。Code review 把這列為 v1.17.73+ backlog M-1。

**修法**：把 fixture 結構抽成 helper、多條測試混搭兩種 shape、加 contract test，確保兩條路徑（MCP / legacy）任何一條壞掉都會被多條測試抓到。

1. **[tests/ownmind-tty-echo.test.js](tests/ownmind-tty-echo.test.js)**：
   - 新增 `mcpToolResponse(parts)` / `legacyToolResponse(parts)` 兩個 helper（fixture builder）
   - 把現有 banner 抽取相關測試遷移到 helper：4 條改用 `mcpToolResponse`（prod MCP 真實 shape），2 條（測試名明確談「content」的）保留 `legacyToolResponse`，IR-007 regression test 維持 prod 真實 captured payload
   - **新增結構性 contract test**「兩種 tool_response shape 在同一句 banner 文字下產出一致 block」— 用同一句 banner 餵兩種 shape，比對 block 必須一致；任何 path-specific bug 立刻被抓到

**Mutation test 驗證拆雷有效**：
- 故意把 extractBanners 的 legacy 路徑改成回 `[]`（破壞 (B) 路徑）→ **3 條測試紅**（contract test + 2 條明確標 legacy 的測試），不只 1 條
- 對比 v1.17.71 ship 時 19 條測試全綠通過（因為全部偏 (B) shape）— 現在多路徑混搭，**單路徑壞掉一定爆紅**

**驗證**：
- `npm test` 805/805 pass（v1.17.72 是 804、+1 contract test）
- Mutation test：legacy 路徑斷掉 → 3 紅；mcp 路徑斷掉 → 對稱結果（驗證對稱性）；還原 → 全綠

**鐵律觸發**：IR-007（核心：結構性拆雷，不只點修補）/ IR-008 / IR-026 / IR-031 / IR-032。

**升級指引**：純測試重構 + helper 抽取，hooks 行為零改動、prod 邏輯零改動。用戶不會感覺到差異。意義在於**未來再有 fixture/prod 不一致這類 bug，會被多條測試一起爆出來，不會再 803/803 全綠通過**。

## v1.17.72 — 修 v1.17.71 在場感 100% 失效（IR-007 雷型）

**背景**：v1.17.71 ship 後實測「在場感」完全沒出來。Vin 在新對話視窗用 OwnMind tool 都看不到 banner，跟 v1.17.71 commit message 講的「直寫 user terminal、不靠 AI 自律」結果相反。連續排查兩條路徑（`/dev/tty` 寫入是否成功、`banner-pending.jsonl` 是否累積 fallback record）都顯示 hook 跑了但完全沒抽到 banner。

**Root cause**：tests fixture 跟 prod 真實 PostToolUse stdin JSON 結構不一致 — 測試全綠但 prod 100% 抽不到 banner。

| | Hook 期望（fixture 用的） | Claude Code prod 真實送的 |
|---|---|---|
| `tool_response` 結構 | `{ content: [{type, text}, ...] }` | `[{type, text}, ...]`（直接 array） |

[hooks/ownmind-tty-echo.cjs](hooks/ownmind-tty-echo.cjs) 的 `extractBanners` 抓 `tr.content`，但 prod 的 `tr` 本身就是 array、`tr.content` 是 undefined → `contentParts = []` → `fullText = ''` → `banner_count: 0` → hook 直接 exit、連 fallback 都不寫。19 條測試全綠的原因是所有 fixture 都用 `{tool_response: {content: [...]}}`，跟 prod 不一致。**典型 IR-007 雷型 — 測試保護不到 prod**。

**修法**：

1. **[hooks/ownmind-tty-echo.cjs](hooks/ownmind-tty-echo.cjs)** `extractBanners`：同時支援兩種 `tool_response` 結構（直接 array → MCP tool / `.content` array → 其他 tool / 舊版）。改動 12 行 + 註解。
2. **[tests/ownmind-tty-echo.test.js](tests/ownmind-tty-echo.test.js)** 新增 1 條 IR-003 reproduction test，用真實 prod PostToolUse stdin 截下來的結構（含 `session_id` / `hook_event_name` / `tool_use_id` 等真實欄位），先紅後綠驗證 fix。

**驗證**：
- `npm test` 804/804 pass / 0 fail（v1.17.71 是 803、+1 IR-007 regression test）
- Local prod-spike：把 source 同步到 `~/.ownmind/hooks/ownmind-tty-echo.cjs`、清空 `banner-pending.jsonl`、觸發 `mcp__ownmind__ownmind_search` → jsonl 從 0 行 → 1 行、`block` 內容是預期的「【OwnMind v1.17.71】\n  記憶搜尋\n  技巧提示：...」格式
- 確認 `/dev/tty` 在 Claude Code spawn 的 hook subprocess 拋 `ENXIO`（No such device or address）→ `writeToTty` 必失敗、必走 fallback。這是 Claude Code 環境的客觀限制、不是 bug。

**鐵律觸發**：IR-003（先寫 reproduction test）/ IR-005（不 blind edit、加 trace 觀測再修）/ IR-007（核心 — 修 v1.17.71 自己埋的雷）/ IR-008 / IR-026 / IR-031 / IR-032 / IR-038（先 trace JSONL 觀測 stdin / banner_count，確認 root cause 後再動 source；trace 殘留已清）。

**升級指引**：純 client 端、server 不需重新部署。用戶升到 v1.17.72 後 `~/.ownmind/hooks/ownmind-tty-echo.cjs` 自動更新；既有 `~/.claude/settings.json` 的 PostToolUse hook 設定不用改。下次任意 OwnMind tool 呼叫，banner 會寫到 `~/.ownmind/logs/banner-pending.jsonl`，**重啟 Claude Code 開新 session** 時 SessionStart hook 補印到 stderr → user 看到。

**已知限制（v1.17.73+ backlog）**：`/dev/tty` 在 Claude Code hook subprocess 不可開啟，v1.17.71 的「即時在場感」設計前提在 Claude Code 環境下不成立。目前是「事後在場感」— 補印在下次 session 開頭、不是即時。要做到真即時要另尋通道（例如：user 自己 tail 一個專屬 log file、或 push notification）。

## v1.17.71 — OwnMind 在場感（presence）— 直寫 user terminal 繞過 AI 過濾（IR-027）

**背景**：v1.17.0 起 MCP tool result 末尾附「【OwnMind vX.Y.Z】XXX：YYY」banner 想讓 user 看到 OwnMind 持續運作。但 Claude Code UI 把 tool result 摺疊成卡片、user 完全看不到；AI 也常吞掉不轉述到 chat。Vin 反映「我在新對話視窗中還是沒出現這種訊息」。連續幾版（v1.17.69 合併單一 text part / Codex 第二意見建議降頻）都沒解決根本問題：**訊息走 AI / tool result 通道一定會被吃**。

**Vin 三條規格**：
1. 合規回報頻繁也 OK，所有 OwnMind 動作都要 user 看見
2. 同次觸發多條 banner 合併成一個招牌區塊
3. **嚴禁被 AI 過濾或吃掉** — fallback 不能走 stderr / stdout / additionalContext

**修法**：新增 PostToolUse hook 直寫 user terminal device，繞過 Claude Code hook output 系統。

1. **新增 [hooks/ownmind-tty-echo.cjs](hooks/ownmind-tty-echo.cjs)**（跨平台 Node helper）：
   - 從 stdin 讀 PostToolUse JSON、抓 tool_response.content 裡所有「【OwnMind vX】」 + 「📢 OwnMind」 開頭的 banner
   - 同次觸發合併成單一招牌區塊（招牌 header + 縮排 list、不重複 prefix）
   - 主路徑：`/dev/tty`（mac/linux）或 `\\.\CONOUT$`（Windows）— 直寫 terminal device、繞過 Claude Code
   - Fallback：寫 `~/.ownmind/logs/banner-pending.jsonl`（JSON Lines）給 SessionStart 補印
   - 不寫 stderr / stdout（PostToolUse stderr→AI / stdout→丟掉，都不符合規格 #3）
   - 永遠 exit 0、不擋 tool 流程

2. **新增 [scripts/install-helpers/add-post-tool-use-hook.cjs](scripts/install-helpers/add-post-tool-use-hook.cjs)**（idempotent）：
   - settings.json 不存在 → 建立
   - 已有其他 PostToolUse hook → append、保留既有
   - 已有 OwnMind hook → skipped、不重複加
   - 寫入前 `settings.json.bak.<ts>` backup、atomic tmp+rename、失敗 rollback

3. **修改 [install.sh](install.sh) + [install.ps1](install.ps1)**：MCP 設定後跑 helper 把 PostToolUse hook 加進 `~/.claude/settings.json`。

4. **修改 [hooks/ownmind-session-start.sh](hooks/ownmind-session-start.sh)**：開頭讀 `banner-pending.jsonl` 補印 + 清空。SessionStart 的 stderr 是 user-visible 通道（跟 PostToolUse 相反）。

**Reproduction tests 19 條（IR-003）**：
- [tests/ownmind-tty-echo.test.js](tests/ownmind-tty-echo.test.js) 11 條：banner 抽取、招牌區塊合併、廣播 block、多 content parts、空輸入 / 壞 JSON、fallback JSON Lines、**stderr/stdout 必須空白**（規格 #3 hard guarantee）、主路徑 tty 寫入
- [tests/add-post-tool-use-hook.test.js](tests/add-post-tool-use-hook.test.js) 8 條：settings.json 不存在 / 無 hooks 區塊 / 已有其他 PostToolUse / idempotent skipped / 壞 JSON not modified / backup 機制 / 絕對 path / matcher 正確

**鐵律觸發**：IR-003 / IR-005 / IR-007（防同類雷）/ IR-008 / IR-022（client 兩端 .sh + .ps1 同步）/ IR-026 / IR-027（核心：用邏輯卡控取代「AI 應該轉述」這種提醒式設計）/ IR-031 / IR-032 / IR-038（fallback 觀測管道）。

**驗證**：本地 `npm test` 803/803 pass / 0 fail（v1.17.70 是 784，+19 新 test）。額外做 local spike：用 heredoc 餵假 JSON 給 hook、強制 fallback 路徑、確認 `banner-pending.jsonl` 寫入正確的招牌區塊格式（header 單獨一行 + 縮排 list）。

**Code review 抓到的修正**（superpowers:code-reviewer）：
- **Important**：`banner-pending.jsonl` 沒大小上限、non-tty long-running script 會無限長 → 加 1 MB rotate（超過就 rename 成 `.old` 覆蓋舊的，~10k records 上限）
- **Important**：原本 SessionStart 補印用 bash while loop 每行 spawn node，50+ banner 積壓會卡住 → 改抽出 [hooks/lib/flush-pending-banners.js](hooks/lib/flush-pending-banners.js)，stdin 一次讀完整檔
- **Minor**：拿掉 hook entry 裡的 `name` field（Claude Code schema 沒這個欄位，雖被容忍但不該依賴；改用 `command` 字串裡的 `ownmind-tty-echo` substring 識別 idempotency）

**升級指引**：純 client 端、server 不需重新部署。用戶升到 v1.17.71 後 `install.sh`/`install.ps1` 會自動把 PostToolUse hook 加進 `~/.claude/settings.json`（既有設定保留 + backup）。**重啟 Claude Code 後**下次任意 OwnMind tool 呼叫起，直接在 terminal 看到「【OwnMind v1.17.71】記憶搜尋…」banner，不靠 AI 自律。

## v1.17.70 — 升級備份自動清除（IR-027 邏輯卡控）

**背景**：`interactive-upgrade.sh` / `.ps1` 升級時會把舊版本備份到 `~/.ownmind.bak.<timestamp>/`，每份約 50 MB。`bootstrap.sh` / `bootstrap.ps1` 修復路徑的 log 訊息一直寫「3 天後可手動刪除」，但**全 repo 沒有任何邏輯實際清**，使用者忘了就無限累積。Vin 機器上累積到 **19 份 / 894 MB**（從 4/23 到 5/8 共 15 天）。違反 IR-027「提醒無效，邏輯才有效」。

**修法**：在升級成功末段補 sweep（IR-027 邏輯卡控）：

1. **[scripts/interactive-upgrade.sh](scripts/interactive-upgrade.sh)**：`OK "done"` 之前 `find $HOME -maxdepth 1 -type d -name '.ownmind.bak.*' -mtime +N -exec rm -rf {} +`，預設 N=7、可用 `OWNMIND_BACKUP_RETENTION_DAYS` 環境變數覆蓋。Sweep 失敗（權限 / 磁碟）不影響升級結果。
2. **[scripts/interactive-upgrade.ps1](scripts/interactive-upgrade.ps1)**：對稱實作，`Get-ChildItem $HOME -Directory -Filter '.ownmind.bak.*' | Where LastWriteTime -lt $cutoff | Remove-Item -Recurse -Force`。
3. **[scripts/bootstrap.sh](scripts/bootstrap.sh) + [bootstrap.ps1](scripts/bootstrap.ps1)** 的 log 訊息從「3 天後可手動刪除」改成「下次升級自動清除超過 7 天的舊備份」。

實際效果：每次跑升級都順手把 7 天前的舊備份刷掉，使用者零負擔。

**Reproduction tests 8 條（IR-003）**：
- 新增 [tests/sweep-old-backups.test.js](tests/sweep-old-backups.test.js)：用 `fs.utimesSync` 建假 fixture 驗 `find -mtime +N` 在 macOS BSD / Linux GNU 上行為一致；驗 `-maxdepth 1` 不會誤殺巢狀目錄、不會誤殺名稱類似但 prefix 不同的目錄（如 `.ownmind`、`.ownmind.cache`）；驗 retention 0 / 空目錄 edge case；驗 interactive-upgrade.sh / .ps1 含 sweep 邏輯、bootstrap log 訊息已換掉「可手動」字樣。

**鐵律觸發**：IR-003 / IR-005 / IR-008 / IR-022（client 兩端 .sh + .ps1 同步、server 不變）/ IR-026 / IR-027（重點：用邏輯卡控取代提醒）/ IR-031 / IR-032。

**驗證**：本地 `npm test` 784/784 pass / 0 fail（v1.17.69 是 776，+8 新 test）。

**升級指引**：純 client 端、server 不需重新部署。用戶下次跑升級就會自動清；現有的舊備份**這次升級立刻被清掉**（因為 sweep 邏輯是「升級到 v1.17.70 時跑」，不需要等下一輪）。

## v1.17.69 — MCP 回傳合併單一 text part（修 Claude Code 看不到技巧提示）

**背景**：Vin 回報「之前都會出現的技巧提示，現在 Claude Code 看不到，其他工具（Codex / Cursor / Antigravity）都看得到」。

**根因**：v1.17.0 起 [mcp/index.js:1139](mcp/index.js)（修法前）把 MCP 工具回傳組成 **4 個獨立的 `{ type: "text", text: ... }` parts**：broadcast / 前綴行 / JSON body / 技巧提示。多數 MCP client 會把全部 parts 順序合起來顯示，但 **Claude Code UI 對 tool result 用摺疊卡片渲染時，多 part 之間的視覺被吃掉、最後一段（tip）完全看不到**。技術上 server 一視同仁送相同 payload，AI 端也都收得到全部 parts，純粹是 client UI 渲染差異。

**修法**：把 4 個 part 合併成單一 text part，所有 client 渲染一致。新增 [mcp/lib/compose-tool-response.js](mcp/lib/compose-tool-response.js) 純函式封裝合併邏輯，[mcp/index.js](mcp/index.js) 改呼叫它。視覺版型維持跟 v1.17.68 之前各 client 看到的一樣（tag 跟 body 用「：」連接、body 跟 tip 之間留一個空白行）。

**Reproduction tests 8 條（IR-003）**：
- 新增 [tests/mcp-tool-response-shape.test.js](tests/mcp-tool-response-shape.test.js)：驗 `composeToolResponse` 必回單一 text part、各段視覺分隔、有無 broadcast / tip 都不會多空白
- 更新 [tests/tip-every-call.test.js](tests/tip-every-call.test.js)：原本 assert `contentParts.push(...)` pattern，改成 assert `composeToolResponse({ tip: getRandomTip(), tipTag: ... })` pattern；不變的是 tip 必須無條件附（不能再有 `% 10` 之類的閘門）

**鐵律觸發**：IR-003 / IR-005 / IR-008 / IR-022（純 client 修法、server 端不變）/ IR-026 / IR-031 / IR-032。

**驗證**：本地 `npm test` 776/776 pass / 0 fail（v1.17.68 是 768，+8 新 test）。

**Code review 抓到的修正**（superpowers:code-reviewer）：
- **Important（visual regression）**：第一版把 tag 跟 body 用「：」inline 連接（`記憶搜尋：{...}`），多 KB JSON body 會被擠成超長一行、視覺上比舊 4-part 結構差。修法：tag 後接「：\n」當 header 行、body 換到下一行（`記憶搜尋：\n{...}`），跟舊 4-part 各 client 看到的版型一致。

**升級指引**：純 client 端修法，server 不需重新部署。用戶跟 Claude / Codex 說「升級 OwnMind」即可，下次 MCP 工具呼叫起 Claude Code UI 就會看到完整的回傳含技巧提示。

## v1.17.68 — settings.json `--update` 殘留地雷 + 401 觀測管道（IR-007 + IR-038）

**背景**：v1.17.67 修完 Windows scanner task 註冊問題後，Adam 用量報告 token 還是 0，scanner 跑出來全 5 個 client 一起回 401「無效的 API Key」。深入查 server 發現 Adam 的 `~/.claude/settings.json` 裡 `OWNMIND_API_KEY` 整個值是字串 `"--update"`（8 字元），不是合法的 API key。

**根因**：v1.17.9 之前 `install.ps1` 沒過濾 flag-like positional args，**舊版 `interactive-upgrade.ps1` 把 `--update` 當位置參數傳給 `install.ps1`，被當成 API key 寫進 `settings.json`**。Adam 是 2026-03-26 建帳號的早期用戶，當時版本沒有 args 過濾，他的 settings.json 從那天起就壞了。v1.17.9 之後修了 args 過濾，**讓未來不會再寫壞**，但**沒寫 migration 把已經中招的存量挖出來**。

**為什麼 6 週沒人發現**：
- Adam 的 token_events 表 0 筆（從建帳號到現在沒成功上傳一次）
- Adam 的 install_check_logs 表也是 0 筆 —— self-check 上傳本身吃 401，連 self-check 「我有問題」這個訊號都傳不到 server
- 自我檢查的 `api_credentials` check 只看 server 回 200/401，不看 key 字串本身格式 → red 但訊息只說「auth 401」，沒指出根因
- server 端 auth.js 401 path 沒留結構化 log，admin 從 docker logs 只看到「POST /api/usage/events 401 3ms」這種 access log，看不出是誰、key prefix 也沒留

**修法**：

1. **client 端：[scripts/install-helpers/self-check.cjs](scripts/install-helpers/self-check.cjs)** 加 `checkApiKeyFormat`（不打 server，純看 key 字串長相）：
   - 已知壞值清單：`--update` / `--upgrade` / `--install` / `--help` / `true` / `false` / `null` / `undefined` / `${OWNMIND_API_KEY}`
   - flag-like：以 `-` 開頭直接 fail
   - 長度 < 16 fail（合法 UUID 36 / custom prefix ≥ 20）
   - 含空白 / BOM / 控制字元 fail
   - 排在 `api_credentials` 之前，user 看到 `api_key_format: fail` 時 detail 直接點出歷史踩坑 + 修法路徑（admin UI 重發 / 重設 settings.json）

2. **server 端：[src/middleware/auth.js](src/middleware/auth.js)** 401 path 加 `logger.warn('auth_failed', {...})`（IR-038 觀測管道）：
   - 結構化欄位：`route` / `ip` / `masked_key`（前 4...後 4 + len） / `ua`（截 80 char）
   - `masked_key` 透過新 `maskApiKey()` 純函式產生：空 key → `<empty>`、< 8 char → `<too-short:N>`、長 key → `eb80...e0dc (len=36)`，admin 能反查 users 表又不會把 key 全文寫進 docker logs（PII 友善）
   - 沒帶 Bearer header 也 log（`masked_key=<no-bearer>`）
   - auth.js 第 4 個參數加 `deps={}` 給測試注入 logger / query，不影響 production 呼叫

3. **Reproduction tests 17 條（IR-003）**：
   - [tests/self-check.test.js](tests/self-check.test.js) 加 10 條 `checkApiKeyFormat` 測試（含 Adam 的 `--update`、各種已知壞值、flag-like、太短、含空白 / BOM、合法 UUID、合法 custom prefix）
   - [tests/auth-401-observability.test.js](tests/auth-401-observability.test.js) 新增 7 條（`maskApiKey` 邊界 + auth middleware 401 / no-bearer log shape）

**鐵律觸發**：IR-003 / IR-005 / IR-007 / IR-008 / IR-022 / IR-026 / IR-031 / IR-032 / IR-038。

**驗證**：本地 `npm test` 768/768 pass / 0 fail（v1.17.67 是 750，+18 新 test）。

**Code review 抓到的修正**（superpowers:code-reviewer）：
- **Important（info-leak）**：`maskApiKey` 原本門檻 `< 8` 走 `<too-short:N>`，但 8 char key（如 Adam 的 `--update`）走到 `slice(0,4) + '...' + slice(-4)` 路徑會產生 `--up...date` —— admin 從 docker logs 把三個點移掉就拿到原文。提高門檻到 12（中間至少還有 4 char 被遮掉）；8 char 改走 `<too-short:8>`，自我檢查的 `checkApiKeyFormat` 會在 client 端先抓出來，server log 端不負責顯示這種 key 的 prefix。
- **Minor**：`x-forwarded-for` 取第一個 IP（forensics 要的是 client、不是 proxy chain）；`KNOWN_BAD` 加 `/help` `/?` 防 cmd 風格 flag 誤傳；auth.js 多加一行 comment 鎖 `fn.length === 3` 不變式（避免未來改 signature 把 middleware 變 Express error handler）。

**升級指引**：受影響用戶（v1.17.9 之前裝過、後來只升級沒重灌、settings.json 殘留 `--update`）跑 `~/.ownmind/install.ps1` 升到 v1.17.68 後，self-check 會在 `api_key_format` 欄位直接紅燈、訊息明確指向修法路徑。Admin 端 docker logs 也會看到 `auth_failed` 結構化 log，能主動發現未升級的用戶。

## v1.17.67 — v1.17.66 Windows scanner task hotfix + IR-007 防同類雷

**背景**：v1.17.66 上線後 Adam / Eric 兩位 Windows 用戶獨立回報 OwnMind 用量報告 token 數卡 0。診斷發現背景 token scanner 的 Task Scheduler 在他們機器上根本沒註冊。`self-check` 跑出 `scheduler ❌`，手動跑 `register-scanner-task.ps1` 才看到 PowerShell 直接 `throw`。

**根因**：[scripts/windows/register-scanner-task.ps1:103-107](scripts/windows/register-scanner-task.ps1)（修法前）v1.17.66 想加電池友善設定，用了 `-DontStartIfOnBatteries` 和 `-StopIfGoingOnBatteries` 兩個參數 —— 但這兩個都不是 `New-ScheduledTaskSettingsSet` 的合法參數名（正確名是 `-DisallowStartIfOnBatteries` 和反向 switch `-DontStopIfGoingOnBatteries`）。在 PS 5.1 + PS 7 都會直接 `throw`、整個 register 動作中斷、task 完全沒註冊。

而且 PowerShell 預設行為**本來就**是「電池上不啟動 + 切電池就停」，這兩個顯式設定根本多此一舉。

**為什麼 v1.17.66 的 reproduction test 沒擋住**：[tests/ps1-windows-compat.test.js:160-166](tests/ps1-windows-compat.test.js)（修法前）的 test 只 `assert.match` 那兩個壞 param 字串「存在」於檔案 —— 字串對 ≠ PowerShell 接受該 param。**測試驗了文字，沒驗語意**。這是 IR-007 Persistent Bug Protocol 要處理的同類雷。

**修法**：

1. **刪掉壞 param**：[scripts/windows/register-scanner-task.ps1](scripts/windows/register-scanner-task.ps1) 移除 `-DontStartIfOnBatteries` 和 `-StopIfGoingOnBatteries` 兩行；註解說明「PS 預設已是爛電池友善，不用顯式設定」
2. **反轉舊 test**：原本 assert「壞 param 存在」改成 `assert.doesNotMatch` 兩個壞 param **必須不存在**
3. **加 param 白名單驗證 test**（IR-007 防同類雷）：把 `New-ScheduledTaskSettingsSet` 區塊內所有 `-FooBar` 抽出來比對 PowerShell 官方參數白名單，未來再有人在這支腳本打錯 cmdlet param 立刻紅燈
4. **IR-038 觀測管道補強**：
   - [install.ps1:387-409](install.ps1) 跑 `register-scanner-task.ps1` 時 `Tee-Object` 把 stdout+stderr 寫到 `~/.ownmind/logs/register-task-<ts>.log`
   - [scripts/install-helpers/self-check.cjs:288](scripts/install-helpers/self-check.cjs) `detectSchedulerDetail` 新增 `readLatestRegisterLog()`，把最新一份 register log（最多 8KB）併入 `scheduler_detail.register_log`
   - 下次有人踩同類 PS bug，admin 從 `install_check_logs.full_log` 直接看得到 PS error stack，不用用戶手動跑指令貼回來
5. **修 v1.17.66 stale 訊息**：register-scanner-task.ps1 line 129 Write-Host 從「every 30 min」改成「every 120 min」（呼應 v1.17.66 的 interval 變更但漏改）

**鐵律觸發**：IR-003 / IR-005 / IR-007 / IR-008 / IR-021 / IR-022 / IR-026 / IR-031 / IR-032 / IR-038。

**驗證**：本地 `npm test` 750/750 pass / 0 fail（v1.17.66 是 749，新增一個 param 白名單驗證 test）。reproduction test 走完整 red-green：先反轉/新增 test 確認紅 → 修 .ps1 確認轉綠。

**Code review 抓到的修正**（superpowers:code-reviewer）：
- **Critical**：白名單 test 的區塊比對 regex 抓到的是 `New-ScheduledTaskSettingsSet` 第一次出現的位置 —— 但這是註解區塊（line 102），不是實際 cmdlet 呼叫（line 114）。test 等於只在驗註解裡的 param 名，未來注入壞 param 到實際呼叫不會被抓。修法：regex 比對前先剝掉 `# ...` 註解。透過注入 `-BogusFakeParam` 到實際 cmdlet 確認 red → 移除注入確認 green，full TDD cycle 過。
- **Important**：`scheduler_detail.register_log.content` 走 `sanitizePath()`（PowerShell 錯誤訊息常帶絕對 path `C:\Users\<realname>\...`，user 名是 PII）。
- **Important**：install.ps1 多餘的 `New-Item` 移除（`~/.ownmind/logs` 已在 line 270-280 隨 `$GitHookDirs` 建好）。
- **Minor**：register-scanner-task.ps1 file header `每 30 分鐘執行一次` 補修為 120 分鐘。

**升級指引**：v1.17.66 受影響的用戶（升級後 token 用量報告卡 0）跑 `~/.ownmind/install.ps1` 再升一次即可，新版 register-scanner-task.ps1 會把 task 補上來。

## v1.17.66 — Windows 平台硬化 + 觀測管道修補（IR-038）

**背景**：2026-05-07~05-08 連續兩天 Eric/Adam 升 v1.17.65 都遭遇相同失敗劇本：升級主流程全 OK，但 `verify_local` 失敗連帶 `rollback` 失敗，仰賴雙重失敗才保住新版本。額外回報「OwnMind 觸發時不定時跳出 console 視窗，沒用 Claude 也跳」。深入調查發現是七個獨立 bug 累積，根因都在「shell / path / process spawn 假設了 Unix 行為」。這是第三波同類踩坑（v1.17.62 / v1.17.65 / v1.17.66），啟動 systematic-debugging Phase 4.5 架構性修補。

完整 spec：[openspec/changes/v1.17.66-windows-hardening/](openspec/changes/v1.17.66-windows-hardening/)。

**七個 bug + 修法**：

1. **#1 PowerShell `bash` 解到 WSL relay**（P0）
   - 觸發點：[scripts/interactive-upgrade.ps1:120,125,130](scripts/interactive-upgrade.ps1) 三處 bare `bash`
   - 根因：Windows 10/11 內建 `C:\Windows\System32\bash.exe`（WSL relay），沒裝 distro 也存在；PowerShell PATH 解析優先 System32
   - 修法：新增 [scripts/windows/lib/find-git-bash.ps1](scripts/windows/lib/find-git-bash.ps1) helper，三段式偵測（cache → 常見路徑 → where.exe 過濾）+ `bash --version` 確認是 Git Bash 而非 WSL

2. **#2 `execFile + shell:true` 在 Windows 被 cmd 包**（P0）
   - 觸發點：[scripts/install-helpers/self-check.cjs:195-197](scripts/install-helpers/self-check.cjs)
   - 根因：cmd.exe 把 PowerShell `Get-ScheduledTask | Select-Object` 的 `|` 當自己的 pipe operator，找 `Select-Object` 當外部命令失敗（Eric/Adam 兩台一字不差錯誤訊息）
   - 修法：新增 [scripts/install-helpers/safe-spawn.cjs](scripts/install-helpers/safe-spawn.cjs) helper（強制 `shell:false` + `windowsHide:true` + 5s timeout），self-check.cjs 改用 safeSpawn

3. **#4 升級失敗時 self-check 不被觸發、上傳 401 不重試**（P0）
   - 觸發點：[scripts/interactive-upgrade.ps1:122](scripts/interactive-upgrade.ps1) `Fail` exit 早於 line 172 self-check 呼叫；self-check.cjs 上傳失敗即丟
   - 根因：失敗路徑沒走 `try/finally` 結構；Adam 401 案例 server `install_check_logs` 表完全沒收到資料（最該收的時候反而靜默）
   - 修法：interactive-upgrade.ps1 整個流程包進 `try { ... } finally { Run-SelfCheckOnce }`；self-check.cjs 新增 `appendSpool` / `retrySpool` 機制（401 / 網路 / 5xx 寫進 `~/.ownmind/logs/.upload-spool.jsonl`，下次跑 self-check 開頭先補傳）

4. **#6 PowerShell `Out-File` 預設 UTF-16 BOM**（P1）
   - 觸發點：interactive-upgrade.ps1 六處 `| Out-File -Append $LogFile`
   - 根因：PS 5.x 預設編碼 Unicode（UTF-16 LE BOM），現代工具預期 UTF-8。Eric 的 upgrade log 中文 garbled
   - 修法：所有 `Out-File` 加 `-Encoding utf8`

5. **#7 Scanner Task Scheduler 跳 console 視窗**（P0）
   - 觸發點：[scripts/windows/register-scanner-task.ps1:78-100](scripts/windows/register-scanner-task.ps1)
   - 根因：`-LogonType Interactive` + console subsystem binary `node.exe` = Windows 必開 console window；`StartWhenAvailable` + 30 分鐘間隔 + catch-up 補跑 = 連跳幾個視窗
   - 修法：(a) 新增 [scripts/windows/run-hidden.vbs](scripts/windows/run-hidden.vbs) launcher（wscript.exe GUI subsystem），task action 改 `wscript.exe run-hidden.vbs node.exe scanner.js`，徹底隱藏；(b) `RepetitionInterval` 30 → 120 分鐘降頻 4×；(c) 加 `-DontStartIfOnBatteries` + `-StopIfGoingOnBatteries` 筆電友善

**架構性新增（Phase 4.5）— 三個共用 helper 防同類雷再現**：

- [scripts/windows/lib/find-git-bash.ps1](scripts/windows/lib/find-git-bash.ps1) — Git Bash 偵測，過濾 WSL relay
- [scripts/install-helpers/safe-spawn.cjs](scripts/install-helpers/safe-spawn.cjs) — Win32 friendly execFile 包裝
- [scripts/install-helpers/path-to-win32.cjs](scripts/install-helpers/path-to-win32.cjs) — MSYS `/c/X` ↔ Win32 `C:\X` 轉換（v1.17.67 修 Bug #3 verify-upgrade.sh 用）

**環境資訊收集擴充（IR-038 落實）**：

- self-check.cjs 新增 `collectEnv()`，每次上傳帶 `os_release / arch / node / home_format / msystem / shell_chain / encoding / bash_resolution / scheduler_detail`
- 全部資料 < 4KB，遠低於 server 端 `install_check_logs.full_log` 64KB 上限
- PII 友善：`home_format` 只記格式類別不傳實際 path，`node.exec_path` 走 sanitizePath
- 用途：admin dashboard 可直接看每台機器 bash 解析到 WSL relay 還是 Git Bash、PS 預設編碼是 UTF-16 還是 UTF-8、Task Scheduler 真實 state / last_run / next_run

**延 v1.17.67 的 bug 與功能**：
- #3 `verify-upgrade.sh:49` 餵 MSYS path 給 native `node.exe`（次要 bug，要 #1 修好才浮出）
- #5 Windows rollback 鎖檔（修了 #1 之後不會被觸發；要設計「停 MCP / Task Scheduler 再 rollback」protocol）
- Admin dashboard `install-check` 檢視頁（讓 v1.17.66 PR 規模可控、先讓 server 收 24~48h 真實資料）

**Reproduction tests（IR-003 + TDD red-green）**：

- [tests/ps1-windows-compat.test.js](tests/ps1-windows-compat.test.js) 加 11 條（Bug #1 / #6 / #7 / #4 try-finally）
- [tests/self-check.test.js](tests/self-check.test.js) 加 9 條（Bug #2 / #4 spool round-trip / collectEnv schema）
- 全部先紅、修完轉綠；抽樣 Bug #2 做完整 revert→紅→restore→綠 cycle 驗 reproduction 真能抓 bug
- 全 repo 749 / 749 pass / 0 fail

**鐵律觸發**：IR-003、IR-004、IR-005、IR-007、IR-008、IR-022、IR-027、IR-031、IR-032，並新增 IR-038 候選：「修 bug 前必須先確保有足夠的觀測資料能持續追蹤該 bug」。

**Eric / Adam 升級時請對照真機驗證的清單**（PR 描述會附）：
1. Find-GitBash 確實過濾 System32 WSL relay
2. interactive-upgrade.ps1 try/finally 保證 self-check 在升級失敗時仍跑
3. VBS launcher 真的隱藏 console 視窗
4. Task settings Battery 行為（拔電源不跑、跑到一半拔電源停）
5. detectBashResolution / detectSchedulerDetail / detectWindowsEncoding 三個 Windows-only collector
6. Spool 在「真實 server 401」時的補傳行為（目前 mock fetch 驗過）

## v1.17.65 — autostash fallback 死路徑修掉（清 v1.17.24 backlog）

**背景**：v1.17.23 引入 `git pull --autostash` 取代手動 stash／無 pop，並寫了 fallback「處理 git < 2.6 沒 --autostash 支援的舊版」。但 fallback 那條也帶 `--autostash` —— 主路徑會失敗的根因（git 太舊）在 fallback 一定再失敗一次，等於沒 fallback。Codex review 在 v1.17.23 抓到並 ack 過，但當時不阻擋上線、留進 backlog（[project_299](OwnMind 專案記憶)）。

**根因**：[mcp/index.js:1271-1282](mcp/index.js:1271)（修法前）兩個 try 區塊都帶 `--autostash`：

```js
try { await execFile('git', ['pull', '-q', '--rebase', '--autostash'], …); }
catch {
  try { await execFile('git', ['pull', '-q', '--autostash'], …); }  // ← 死路徑
  catch (e) { return fail('pull', e); }
}
```

**修法**：fallback 改 `git pull -q --ff-only` —— 不帶 `--autostash`、不帶 `--rebase`。

- 工作樹有未提交變更時，`--ff-only` 會明確拒絕 → 觸發 `logEvent('update_failed', step: 'pull')`，user 看 log 自己處理。
- 不再做手動 stash —— v1.17.22 已驗證沒 pop 會吞 user 變更（IR-007 Persistent Bug Protocol）。
- `--ff-only` 比裸 `git pull` 安全：避免自動產生 merge commit；要 fast-forward 才繼續。

**測試**：[tests/mcp-auto-update-cross-platform.test.js](tests/mcp-auto-update-cross-platform.test.js) 加 1 條 regression —— 從 mcpSource 抓主路徑後緊接的 fallback execFile 區塊，斷言不能再含 `--autostash`。修法前 fail（fallback args 是 `'pull', '-q', '--autostash'`），修法後 pass。

**v1.17.24 backlog 後續確認**：原 backlog 列三項，另外兩項早已隨他 PR 解掉，**這次只剩 autostash fallback**：
- ✅ 問題 2「lock cleanup 未來可能誤刪別 process 的 lock」── v1.17.60 已加 `_lockHeld` 旗標（[mcp/index.js:1184](mcp/index.js:1184) / `:1228`）。
- ✅ 問題 3「`update.ps1` / `update.sh` settings.json parse 失敗用空物件覆寫」── v1.17.60 已新增 [scripts/install-helpers/load-settings-safe.cjs](scripts/install-helpers/load-settings-safe.cjs)，parse 失敗 `process.exit(0)` 不洗檔；兩支 update script 全部改用 `loadOrSkip`。

## v1.17.64 — self-check 兩個小 bug 修正：endpoint 404 + auth header 401

**Vincent 反饋**：v1.17.63 上線後實測發現 self-check 的 `api_credentials` 檢查永遠 fail、上傳 log 也永遠失敗。Adam / Eric / Michelle 升完只會看到自己的本機被標壞，但其實是 self-check 寫錯了 — 不是他們的環境壞了。

**根因**：

1. `scripts/install-helpers/self-check.cjs:123` 把 `api_credentials` 檢查打到 `POST /api/init`，但 server 上根本沒這條路由（實際是 `GET /api/memory/init`，掛在 `src/app.js:73`），因此一律回 404。
2. 同檔 `:127` 跟 `:304`（上傳 log 的 fetch）帶的是自訂 header `X-OwnMind-API-Key`，但 `src/middleware/auth.js:10-12` 只認 `Authorization: Bearer <key>`，所以 server 看到請求直接擋下回 401。`mcp/index.js:276,349` 一直都是用 Bearer，是 self-check 落單寫錯。

**修法**（純 client-side 修正，server 不動）：

1. `scripts/install-helpers/self-check.cjs` `checkApiCredentials`：
   - URL 從 `/api/init` 改成 `/api/memory/init`。
   - method 從 `POST` 改回 `GET`（這條路由本來就是 GET、不需要 body）。
   - header 從 `X-OwnMind-API-Key` 改成 `Authorization: Bearer <key>`。
2. 同檔 `uploadReport`：上傳 `/api/debug/install-check` 的 header 同步改成 `Authorization: Bearer <key>`。
3. `tests/self-check.test.js` 加 2 條 regression test：
   - 攔截 `globalThis.fetch`，檢查 `checkApiCredentials` 真的打 `/api/memory/init` 並帶 Bearer header（不再帶舊的 `X-OwnMind-API-Key`）。
   - 401 回應仍然要判 fail（避免日後 server 換認證後 false pass）。

**驗證**：`node --test tests/self-check.test.js tests/debug-route.test.js` → 22 / 22 pass。

**升級指引**：v1.17.63 用戶（Adam / Eric / Michelle / Vincent）升 v1.17.64 後跑一次 `~/.ownmind/scripts/interactive-upgrade.{sh,ps1}` 或手動 `node ~/.ownmind/scripts/install-helpers/self-check.cjs --trigger=manual`，self-check log 會正確上傳 server，admin dashboard 才看得到誰真的有問題。

## v1.17.63 — 安裝/升級結尾自動 self-check + 上傳 log

**Vincent 反饋**：v1.17.62 修了 Adam 的 npm EINVAL，但發現 Adam 還有另一個 silent fail — 他的 Task Scheduler（Windows 排程器）從一開始就沒註冊好，scanner 從來沒跑、伺服器端從來沒收到他的 token 事件，使用一個多月才被發現。原因是 install.ps1 跑完印 ✅，但 ✅ 只代表「這個區塊沒 throw」、不代表後續元件真的會運作。需要一個自動驗證機制，每次安裝/升級後抓本機真實狀態。

**根因**：

1. `install.sh` / `install.ps1` 各區塊的 ✅ 印出來只表示該區塊執行到底，沒有實際驗證 launchd / Task Scheduler / systemd 真的收到註冊、scanner 能不能跑、git hooks 有沒有 +x。
2. 從 server 視角看不到使用者本機到底裝了什麼，只能等使用者主動回報才知道哪邊壞掉。
3. Adam 那種「以為裝好了、實際沒裝好」的 silent fail 在現有架構下要等很久才會被發現。

**修法**：每次安裝/升級結尾跑一遍 self-check，把當下本機所有元件的真實狀態抓下來。

**新增**：

1. `scripts/install-helpers/self-check.cjs` — 跨平台 Node 腳本，跑 7 項檢查：
   - `mcp_files`：`~/.ownmind/mcp/index.js` 在不在
   - `package_version`：`package.json` 是否合法 semver
   - `mcp_node_modules`：`mcp/node_modules` 非空
   - `server_health`：`GET /health`
   - `api_credentials`：`POST /api/init` 帶 API key 不能被拒
   - `git_hooks`：`pre-commit` / `post-commit` / `commit-msg` 三個鉤子在且可執行
   - `scheduler`：macOS 跑 `launchctl list`、Linux 跑 `systemctl --user is-active`、Windows 跑 `Get-ScheduledTask` 確認排程器真的註冊
   每項回 `pass` / `warn` / `fail` + 失敗修法指示。
2. `db/011_install_check_logs.sql` — 新表 `install_check_logs(user_id, ts, client_version, platform, trigger, machine, summary, full_log)`，存每次 self-check 上傳的 log。
3. `src/routes/debug.js` — 新 endpoint `POST /api/debug/install-check`：使用者 API key auth、payload 上限 64KB、寫進新表。
4. `tests/self-check.test.js` — 13 個測試（pure function + smoke check）。
5. `tests/debug-route.test.js` — 5 個測試（auth、成功寫入、缺欄位、過大 payload、DB 失敗）。

**修改**：

1. `install.sh` / `install.ps1` 結尾呼叫 self-check，trigger=`post_install`。
2. `scripts/interactive-upgrade.sh` / `.ps1` 結尾呼叫 self-check，trigger=`post_upgrade`。
3. `src/app.js` 掛 `/api/debug` 路由。

**Self-check 行為**：

- 每項檢查 5s timeout，整支 self-check 包 try/catch + `process.exit(0)` — 出錯**不擋**安裝/升級的「✅ 完成」訊息。
- 結果寫到 `~/.ownmind/logs/self-check-<timestamp>.log`（JSON）。
- console 印綠勾 / 黃驚嘆號 / 紅叉 + 失敗的修復指示。
- 自動上傳到 server `POST /api/debug/install-check`。Opt-out：`touch ~/.ownmind/.no-self-check-upload`。
- 隱私：上傳的 detail 字串先過 `sanitizePath()` 砍家目錄路徑。沒有 secrets / API key / commit message 內容。

**Server 端**：

- 新表 `install_check_logs`。Deploy 時要手動跑 migration（OwnMind 沒有 auto-migration runner）：
  ```
  ssh root@kkvin.com "docker exec -i ownmind-db psql -U ownmind -d ownmind" < db/011_install_check_logs.sql
  ```

**Dashboard UI 留下個 PR**：本 PR 先把資料收集起來。Admin 想看哪個 user 哪個 component 壞掉，目前用 SQL 直接查 `install_check_logs`：
```sql
SELECT u.name, l.ts, l.client_version, l.summary
FROM install_check_logs l JOIN users u ON u.id=l.user_id
WHERE l.ts > NOW() - INTERVAL '7 days'
ORDER BY u.name, l.ts DESC;
```

**升級方式**：v1.17.63 上線後，使用者下次跑 bootstrap 就會自動跑 self-check + 上傳。已經升到 v1.17.62 但還沒升 v1.17.63 的使用者要再跑一次 bootstrap 才會啟用。

## v1.17.62 — 修自動更新兩個 silent fail（Adam Windows / Michelle 心跳）

**Vincent 反饋**：production heartbeat 顯示 Adam（1.17.24 / win32）、Eric（1.17.45）、Michelle（1.17.20 / Mac）三個 user 卡很久沒上來。Server 已經 1.17.61，他們各卡 16~37 個版本之前。本來 backlog 是「等他們自己升級才能切 broadcast-filter fail-closed」（`project_290`），結果根本不會自己升級。

**根因**：

1. **Windows npm.cmd `EINVAL`（Adam 卡 1.17.24）**：Node v18.20.2 / v20.12.2 / v21.7.3 起為 CVE-2024-27980 安全修補，禁止 `child_process.execFile` 直接呼叫 `.cmd` / `.bat`，要 `shell: true` 才行。`mcp/index.js:1286` 的 `execFile(NPM_CMD, ['install', '-q'], ...)` 在 Adam 那邊就吃這個 EINVAL，整個自動更新中斷。從 activity log 看到 `update_failed step=npm error=EINVAL`。

2. **MCP process cached `CLIENT_VERSION`（Michelle 卡 1.17.20）**：`mcp/index.js:154` 把 `CLIENT_VERSION` 在 module-load 時當常數讀進來。MCP 是長跑 process，user 不關 AI 工具就一直開著。自動更新成功 → 磁碟上 package.json 是新版 → 但這個 process 記憶體裡還是舊 `CLIENT_VERSION`。`sendMcpHeartbeat` 用 cached 值且 `heartbeatSent` 旗標每個 process 只送一次心跳 → 長跑 process 永遠回報舊版號。Michelle 02:19 有 `update_applied`、09:11 五個工具同時心跳回報 1.17.20，就是這個。

**修法**：

1. `mcp/index.js:1286` `execFile(NPM_CMD, [...])` 加 `shell: IS_WINDOWS`。Mac / Linux 不受影響、Windows 走 shell 才能跑 `.cmd`。
2. `mcp/index.js` `runAutoUpdate` 在 `logEvent('update_applied', ...)` 之後重發一次心跳，用 `fs.readFileSync` 讀**磁碟上**的 `package.json`、回報新版號。同時不更新 cached `CLIENT_VERSION`（保守 — 只動心跳，process 內其他 callsite 用 cached 不變，下次 process 重啟自然會更新）。

**升級方式**：v1.17.62 上線後，**user 仍然要再跑一次 `bash ~/.ownmind/scripts/bootstrap.sh`** 把 disk 升到 1.17.62 並重啟 MCP（讓新代碼生效）。從 1.17.62 之後的自動更新就會自己處理 — 升級後立刻補心跳、Windows 也不會再 EINVAL。`project_290`（broadcast-filter fail-closed）解 blocker 之後可以切。

## v1.17.61 — /me 報告頁加 MCP 通道盲點提示

**Vincent 反饋**：`project_310` 第 5 項（非 MCP 介面盲點標示）。OwnMind 的 client 是 MCP server，只能看到走 MCP 通道的 AI 工具呼叫。但實際工作上很多 AI 使用是走網頁版（claude.ai / ChatGPT / Gemini Web 等）或非 MCP 終端，這些活動 OwnMind 完全看不到。報告頁卻沒有任何說明，使用者誤以為看到的就是全部活動。

**根因**：先前 `/me` 報告頁的 audit findings 只有在「14 天 0 activity」才觸發 `unobservable_source` finding，但實際上即使有少量 MCP activity，使用者可能一半時間在網頁版 AI、那半也是不可觀測。沒有固定提示說「我只看 MCP 通道」。

**修法**：`src/public/me/index.html` 在 4 個 tab 之上、`<main>` 最上方加一個 `.blindspot-notice` 區塊（淡藍色 left border，視覺輕量、不擋功能），告訴使用者：「OwnMind 看不到的活動：透過網頁 AI、未裝 OwnMind 的工具、或 MCP 通道以外的活動都不會出現在這個報告。實際 AI 使用量可能比這裡看到的多。」全部 tab（個人 / 團隊 / 專案 / 整體分析）都看得到。

**為什麼選固定提示而非 audit finding**：
1. 這是設計層問題（無完美解），不是「異常觸發」的事件 — fixed notice 比 dynamic finding 更誠實
2. 加 finding type `partial_blindspot` 要先決定「異常閾值」是什麼，閾值定錯反而誤導
3. 固定提示一次寫清楚、所有使用者都看得到、不需要計算就能落地

**沒做的部分**：`project_281` 第 E 項（dashboard machine 加 OS / scanner_version 副欄位）已經在 v1.17.17 一系列改動中實作完成，`src/public/index.html:1530-1536` 已渲染 `machine_meta`，backlog memory 過期。

## v1.17.60 — update.sh / update.ps1 settings.json 安全讀取 + 自動更新 lock 旗標

**Vincent 反饋**：v1.17.59 之後 `project_299` 還剩兩項技術債（第 2 跟第 3）一起清掉。第 1 項（`--autostash` fallback 對 2015 年前的 git 失效）太邊角不做。

**根因**：
1. **settings.json 損壞會被洗掉**：`update.sh` / `update.ps1` 各有四個 `node -e` 區塊在裝 hook 時讀使用者的 IDE 設定檔（Claude / Gemini / Copilot / Cursor）。其中 Gemini / Copilot / Cursor 三個用 `try { JSON.parse(...) } catch {}` 吃掉錯誤後帶著空 `{}` 繼續走，最後 `writeFileSync` 把空物件寫回原檔，使用者損壞但有資料的設定會被洗掉、無法救回。中等嚴重，沒實際 bug 報案但風險真的存在。
2. **自動更新外層 `catch` 可能誤刪別 process 的 lock**：`runAutoUpdate().catch` 一律 `unlinkSync(LOCK_FILE)`，目前 code path 都在拿到 lock 後才會 throw 所以沒事；但未來只要有人改動引入「拿 lock 之前 throw」的路徑（例如 stale lock 偵測或 `fetch MARKER_FILE` 失敗），外層 catch 就會把另一個 MCP process 正在持有的 lock 砍掉，兩個 process 同時做 `git pull` / `npm install`、衝突或損壞。低嚴重度但 preventive。

**修法**：
1. 新增 `scripts/install-helpers/load-settings-safe.cjs`：純函式 `loadOrSkip(path, fallback)`，檔案不存在回 fallback、檔案壞掉印警告 + `process.exit(0)`（直接退出 node、後面寫檔不會跑到、原檔保留）。`update.sh` 4 處 + `update.ps1` 4 處全部換成這個 helper。`exit(0)` 是因為 update 腳本不該因為一個 hook 區塊壞掉就整支爆掉、要繼續跑下一個區塊。
2. `mcp/index.js` `runAutoUpdate` 加 module-scope `_lockHeld` 旗標：`fs.openSync(LOCK_FILE, 'wx')` 成功才 set 為 `true`，cleanup 跟外層 catch 都先檢查旗標，只在自己持有時才 `unlinkSync`。

**測試**：`tests/load-settings-safe.test.js` 5 case：檔案不存在 / 有效 / 壞掉不覆寫 / 壞掉但 caller 後面想寫也不會洗掉原檔 / 讀不到（權限）。`process.exit(0)` 行為以 `spawnSync` 跑 subprocess 驗證 exit code 跟 stderr。

**升級方式**：純內部硬化，無 API 行為改變、無使用者操作。Server / client 升到 1.17.60 即可。

## v1.17.59 — `mcp/index.js` 三項硬化（記憶體上限 + 錯誤訊息消毒 + 滑動時間窗去重）

**Vincent 反饋**：v1.17.58 的 Codex review 之後 ack 過、留下的 5 項技術債清掉前三項（`project_310` 第 2 / 3 / 4）。

**根因**：
1. `complianceEvents` 陣列只在 init 時清空，long session 持續累積，理論上會無限大、最後吃光記憶體。
2. `autoComplyForToolCall` 的三個 `console.error` 直接把 `e.message` 噴到 stderr，可能含家目錄路徑、API key 樣式字串等敏感資訊。
3. `_autoComplyDedup` 用 `Math.floor(Date.now() / 60000)` 當 bucket key，分鐘交界（59→00）連打的兩次會被分到不同 bucket、兩次都通過去重檢查（計數膨脹）。

**修法**：
1. `shared/helpers.js` 新增 `pushBounded(arr, item, maxSize)` 環形緩衝 helper，超過上限自動丟最舊。`complianceEvents` 兩個 push 站點改用，上限 500 筆（常數 `COMPLIANCE_EVENTS_MAX`）。
2. `shared/helpers.js` 新增 `sanitizeErrorMessage(msg, maxLen=80)` — 把家目錄路徑換成 `~`、`sk-...` / `Bearer ...` 樣式字串換成 `<redacted>`、超長截斷補 `...`。`autoComplyForToolCall` 的 3 個 `console.error` 全部套用。
3. `shared/helpers.js` 新增 `shouldSkipDuplicate(map, key, ttlMs, now)` 滑動時間窗去重 helper：用 `Map<key, first_seen_ts>`，60 秒內看過就 skip、不 slide 時間戳（讓最終會過期）；每次呼叫順手 GC 過期項目。`_autoComplyDedup` 從 `Set` 改成 `Map`，dedup key 拿掉分鐘 bucket。

**測試**：`tests/mcp-hardening.test.js` 新增 17 個測試 case，涵蓋三個 helper 的快樂路徑、邊界、邊角案例（含分鐘交界 bug 的回歸測試）。

**升級方式**：純內部硬化，無 API 行為改變。Server / client 升到 1.17.59 即可。
## v1.17.58 — IR-024 邏輯卡控（commit-msg hook 阻擋 `Co-Authored-By`）

**Vincent 反饋**：IR-024（Git commit 絕對不加 `Co-Authored-By`）目前只在 dashboard 上顯示提醒，依賴 AI 自覺。違反 IR-027「提醒無效，邏輯才有效」。要求改成 git hook 強卡。

**根因**：之前 IR-024 是軟性規則 — 寫在 OwnMind dashboard 的鐵律列表，靠 AI 看到提醒主動避免。但實際上 AI 經常忘記、寫 commit 訊息時還是會加 `Co-Authored-By` trailer。沒有任何技術機制阻擋。

**設計決定（為什麼放全域）**：第一版原本想做 per-repo 的 hook（`scripts/git-hooks/` + npm postinstall 設 `core.hooksPath`），但 OwnMind 本身就是「全域 git hooks 產品」（`install.sh` 已把 `~/.ownmind/git-hooks/` 設成 global hooksPath，裡面有 `pre-commit` 跟 `post-commit`）。per-repo 的 local config 在 worktree（工作樹）會被 worktree config 覆蓋，根本贏不了全域設定。改放全域：跟 `pre-commit`、`post-commit` 同一套機制，自動覆蓋使用者所有 repo。

**修法**：
1. 新增 `hooks/ownmind-git-commit-msg` — bash 鉤子腳本。用 `grep -qiE '^[[:space:]]*Co-Authored-By:'` 偵測，case-insensitive、行首有 trailer 格式才擋（避免誤殺敘述文字）。三行錯誤訊息（IR-024 違反 / Vin 鐵律 / 強制覆蓋用 `--no-verify`）。
2. `install.sh` 加 5 行 — 仿 `pre-commit` 寫法把 hook 複製到 `~/.ownmind/git-hooks/commit-msg` 並 `chmod +x`。
3. `install.ps1` 加對應邏輯 — 用 `Copy-AsLf` 強制 LF 行尾（防 Windows `core.autocrlf` 把 sh script 轉 CRLF 導致 `Exec format error`）。
4. `tests/git-hook-co-authored-by.test.js` 7 個測試 — 涵蓋三種大小寫變體（`Co-Authored-By` / `Co-authored-by` / `co-authored-by`）、縮排、純文字 / `Reviewed-by` / 文字偶然提到「co-authored」三種不該擋的情況。
5. `package.json` 版號 1.17.57 → 1.17.58。

**升級方式**：使用者自動更新時會帶到新檔案；新版 `install.sh` / `install.ps1` 會在下次重跑時把 `commit-msg` 安裝到 `~/.ownmind/git-hooks/`。已安裝舊版的使用者需要重跑 `install.sh` 或 `install.ps1` 才會啟用 commit-msg hook（pre-commit / post-commit 不受影響）。

## v1.17.57 — 整體分析報告改正面肯定 + 拿掉冗餘描述句

**Vincent 反饋**：
1. 報告寫「Adam 一個人做了 491 輪，他如果離職這個專案會接不下去」這種把個人當風險的話不 OK，應該寫成正面肯定（貢獻極大、認真開發）。
2. 「📊 整體分析」標題下「過去 N 天的全團隊使用分析。機械段秒回；AI 洞察開頁自動觸發、伺服器端 cache 1 小時。」這句技術細節描述拿掉。

**根因（個人風險評價）**：`src/lib/llm-narrative.js` SYSTEM_PROMPT rule 3 的「✓ 具體」範例就是「Adam 離職這個專案會接不下去」，rule 6 也允許「指出某人扛太多」這類風險。LLM 直接照範例輸出。違反 Vin 的工作原則「分析報告若會被被分析者看到，預設要對事不對人」。

**修法**：
1. `src/lib/llm-narrative.js` rule 3 範例改正面肯定 — 「funit-v2 全部 491 輪由 Adam 一個人完成，是這個專案最主要的開發者，貢獻極大、開發很認真」。
2. rule 6 強化：明確禁止「某人扛太多」「某人離職就接不下去」「bus factor」這種把個人當風險的話；高貢獻者用「主要開發者、貢獻極大、開發認真」這類肯定語氣。
3. `src/public/me/index.html` 拿掉「過去 N 天的全團隊使用分析…」描述句（標題 📊 整體分析 已自說明）。
4. `tests/llm-narrative.test.js` 加新 test pin 正面肯定詞 + 個人風險禁用詞。

## v1.17.56 — 修 v1.17.55 的兩個顯示問題（Tokens 全空 + 長專案名）

**Vincent 反饋**：「為何沒有數字」「ai_kol (kol_content_system 新版：...) 的專案名稱還是太長」。

**根因 1（Tokens 全空）**：v1.17.55 用 `(user_id, tool, session_id)` JOIN `token_usage_daily`，但 prod DB `session_logs.session_id` **過去 60 天 0 筆有值**（writer 沒填）。token_events / token_usage_daily 由獨立的 token-collector 寫入，session_id 是真實 UUID 但跟 session_logs 對不上 — JOIN 永遠 NULL。

**根因 2（專案名長）**：「ai_kol」「ai_kol (kol_content_system 新版：...)」是同一個專案，被 `LOWER(TRIM())` 後 key 不同，分裂成兩列；長 key 的描述也直接顯示。

**修法**：
1. `src/routes/me-narrative.js` project_ranking 改用 `(user_id, tool)` bridge —
   先在 `usr_tok` CTE 加總每個 user × tool 的期間總 tokens / cost，再依 `proj` (user, tool, project) 的 turns 比例分配。是估算值但有意義。
2. 同時三個 SQL（narrative + me.js × 2）都加 `REGEXP_REPLACE(project, '\\s*[\\(（].*$', '')` 砍掉「( ... )」描述，全形半形括號都吃；自動合併分裂列。
3. `src/public/me/index.html` `renderProjectRankingTable` 表頭加 `*` 符號，下方註明「估算值（按各專案輪次比例分配）」，誠實標示。

**為何不直接修 session_logs writer**：那是 client side 的事（要等所有 client 升上去 + 等 14d 資料累積），estimation 是當下唯一能讓欄位有用的辦法；長期該補。

## v1.17.55 — 各專案活動量排行表加 Tokens + 成本欄

**Vincent 反饋**：「9. 各專案活動量排行 應該要有期間累計消耗的 token 數」。原表只顯示 sessions / 輪次 / 貢獻者，看不出哪些專案燒最多 token、最花錢。

**修法**：
1. `src/routes/me-narrative.js` 9.project_ranking SQL 加一個 CTE，從 `token_usage_daily` 用 `(user_id, tool, session_id)` JOIN，按 `last_ts ${tfTs}` 過濾期間，加總 5 種 tokens（input + output + cache_creation + cache_read + reasoning）和 `cost_usd`。
2. `src/public/me/index.html` `renderProjectRankingTable`：表格加「Tokens」「成本」兩欄，tokens 沿用既有 `fmtBig`（1.2M 格式），成本顯示 `$X.XX`（不滿 $1 用 4 位小數），無資料顯示「—」。

**為何選 token_usage_daily 而非 token_events 直接 JOIN**：
- daily 表 `cost_usd` 已用 `model_pricing` 算好，免重做計價邏輯。
- 用 `last_ts ${tfTs}` 過濾比掃 events 快很多（daily 已 dedupe 到 session × date）。
- session_logs 用 LEFT JOIN，沒 token 資料的 session 顯示「—」不會被排除。

**測試**：`tests/me-narrative.test.js` 用 fakeQuery 回空 rows，schema 不變仍綠。

## v1.17.54 — 整體分析 LLM prompt 改寫（友善白話 + 踩坑三段式）

**Vincent 反饋**（v1.17.53 ship 後）：
1. 「第二名 Michelle 是潛在大使人選」— 「大使」是行銷術語管理者看不懂
2. 「10. 各專案最常踩什麼坑」每條只有一句話，沒講影響也沒講怎麼改善
3. AI 把自己的流程心得（「我觸發了完整 brainstorming skill」）當成「踩坑」寫進報告

**問題根源**：`src/lib/llm-narrative.js` 的 `SYSTEM_PROMPT`：
1. 範例用「潛在大使人選」這種行銷詞，LLM 模仿就會輸出行話
2. `project_friction` schema 只是字串陣列，沒位置放「影響」「改善」
3. 規則 5 只說「萃取實質踩過的坑」，沒禁止 AI 把自己的流程心得當坑

**修法**：
- `src/lib/llm-narrative.js` SYSTEM_PROMPT：
  - Rule 2 範例改寫：「第一名 Vin 用了 40% 的 AI 工作量，第二名 Michelle 也很常用，用了 25%，是在團隊中最常用 AI 完成工作的人」
    （加排名 + 給實際比例 + 把名次轉成角色定位 + 不用「大使」「分流」「扛」這類行話）
  - Rule 5 schema 改三段式：`{ what, impact, mitigation }`，明確指定每段要寫什麼，
    沒明確證據時填「影響不確定」/「需找 PM 釐清根因」（不要編）
  - 新增規則 7：禁用行話清單（大使／賦能／對齊／閉環／bus factor／分流／扛）
  - Rule 3/4 既有範例同步改白話（去掉「bus factor=1」、「賦能」這類詞）
- `src/public/me/index.html` `renderNarrativeInsights()`：
  - 新增 `renderFricItem()` 渲染三段式：what 加粗、影響/改善各一行 13px 灰字
  - 向下相容：舊版字串資料（cache 還在的話）仍能渲染

對使用者的好處：
- 報告讀起來像同事在講話、不像顧問報告
- 每個踩坑都看得出「為什麼要在意」「下一步要幹嘛」
- AI 自言自語不再混進真正的痛點清單

## v1.17.53 — 誠信表 UX 強化（問題優先排序 + 雜訊過濾 + 違反高亮）

**Vincent 反饋**（v1.17.52 ship 後）：「per-user 拆完後表變得很長，
按使用者字母排還是要自己掃；應該讓問題第一眼看到。」

**問題**：v1.17.52 把誠信表拆 per-user 後，30 條鐵律 × 多 user 時：
1. 多數 cell 是 0（user 沒觸發過該鐵律），表變得又長又稀疏
2. 排序按使用者名稱字母 → 違反次數高的列散落各處，要自己滑
3. 違反次數跟其他數字同色，視覺上沒有警示

**修法**：在 v1.17.52 per-user 設計上疊三項 UX 強化：
- `src/routes/me-narrative.js` compliance query：
  - 加 `WHERE (s.comply + s.skip + s.violate + s.observed) > 0` 過濾全零列
  - `ORDER BY` 改成 `s.violate DESC, u.name NULLS LAST, s.rule_code`，違反次數高的排最前
- `src/public/me/index.html` `renderComplianceTable()`：
  - 違反次數 > 0 時 cell 加紅色加粗（`#dc2626` + `font-weight:600`）

per-user title JOIN 邏輯沿用 v1.17.52，不動。

## v1.17.52 — 整體分析誠信表加「使用者」欄

**Vincent 反饋**（v1.17.51 ship 後）：「如果每個人的 IR 都不一樣，應該要列出是哪位 user 的 IR。」

**問題**：v1.17.51 雖然帶上了 IR title，但仍是團隊合計（GROUP BY rule_code），
然後用 `DISTINCT ON` 任意挑某個 user 的 title 當共用。當不同 user 的同 code
鐵律 title 不同時（例如客製版本），會挑到誤導性標題。

**修法**：
- `src/routes/me-narrative.js` compliance query 改 `GROUP BY (user_id, rule_code)`
  JOIN `memories` 用 `(user_id, code)` 配對，每筆都是「該 user 自己的鐵律 title」
- `src/public/me/index.html` `renderComplianceTable()` 多一欄「使用者」
- 排序：使用者名稱 → IR 代號

每個 user 沒對應 memories 紀錄時 title 留白（不誤導）。

## v1.17.51 — 整體分析誠信表 IR 代號加白話說明

**Vincent 反饋**（v1.17.50 ship 後）：「這些 IR 是每個人都不同？可以多寫一句話去說明，這樣沒頭沒尾看不懂。」

**問題**：v1.17.47 的整體分析（敘事）誠信表只列 `IR-024` 這種代號，
讀者沒看過鐵律本人會完全不懂指什麼。個人分析早就有 title 顯示，
敘事這支 SQL 沒 JOIN `memories`，title 沒帶上來。

**修法**：
- `src/routes/me-narrative.js` compliance query 改成 CTE：
  stats（活動統計）+ titles（`DISTINCT ON (code)` 取 `memories.iron_rule.title`，
  跨使用者用最新更新的版本作為共用標題）
- `src/public/me/index.html` `renderComplianceTable()` 改用個人分析同款排版：
  代號粗體在上、title 灰字小字在下（`<br><small>`）

每個 user 鐵律可能不同（含客製版本），LEFT JOIN 對不上 title 時保持空白不顯示。

## v1.17.50 — 整體分析事件代號加白話說明

**Vincent 反饋**：「這些英文代號可以加上簡短說明嗎？例如 `update_check`（檢查 OwnMind 版本）」

新增 `EVENT_LABELS` 對照表，整體分析的「動作類型」「軟體更新健康度」兩段
表格從 1 欄改 2 欄：左邊 `<code>` 顯示原始代號（給 debug／搜 log 用），
右邊用灰色文字加白話說明（給 user 看）。

涵蓋 21 個事件代號（init / memory_* / handoff_* / iron_rule_* /
update_* / sync_conflict / verification / error）。

## v1.17.49 — security: 預設密碼不再公開洩漏

**Vincent 反饋**：「登入頁不應該把預設密碼寫在畫面上。」

**問題**：登入頁副標 + 改密碼頁 input placeholder 直接把 `Password42760988`
寫死在 HTML 裡。任何人打開 `/ownmind/me/` 就看得到，新建帳號的初始保護等於零。

**修法**：
- 公開的登入頁 + 改密碼頁移除明碼（改成「請聯絡管理者取得預設密碼」）
- admin 端 `POST /api/admin/users` 在「沒指定密碼、套用 shared default」時，
  response 多一個 `default_password` 欄位（一次性返回）
- admin 後台 UI 收到後跳 alert 顯示明碼，提醒用安全管道告知 user
- 其他情境（admin 自設密碼、admin 角色）不回傳

**未來改進方向**（不在本版範圍）：
- 改成每位 user 隨機產生一次性密碼，不再用 shared default
- 改成 email-based password reset link

## v1.17.48 — /me 整體分析 上線後三項修正

v1.17.47 部署後實測抓到問題：

1. **長條圖 bars 渲染成 1px 細線** — `.narrative-bar .nbar` 的 `flex:1`
   在 column wrapper 沒固定高度時，`flex-basis:0` 會吃掉 inline `height:Xpx`。
   改用 `width:80%` 固定 + 把 column wrapper 抽到 CSS 選擇器並補 `height:100%`、
   `justify-content:flex-end`，bars 才能依資料長出正常高度。
2. **改名「敘事報告」→「整體分析」**（tab + H2 + 註解）
3. **LLM prompt 強化** — 原本產出「使用者排名可以幫助管理員了解使用者行為」這種
   廢話。prompt 加正反例示範（廢話 vs 具體），要求洞察必須找 bus factor／
   風險／盲點，next_actions 必須含對象 + 指令式動作，避免空泛。

## v1.17.47 — /me 敘事報告（HackMD 風格 14 天分析）

新增 `/ownmind/me` 第四個 tab「📊 敘事報告」：12 段團隊使用分析。

**機械段（秒回，純 SQL）**

人員排行 / 版本對照 / 日時週分布 / 動作類型 / 鐵律 / 更新健康度 / 專案排行 / 各專案合規。

**LLM 段（開頁自動觸發、伺服器端 cache 1 小時）**

- 一句話結論 + 各段「白話講」 + 給管理者的洞察 + 下一步動作 + 各專案踩坑萃取
- 走 llm-switch（OpenAI-compatible）`https://kkvin.com/llm-switch/v1`，`model='auto'`，`response_format=json_object`
- Server 端 cache by `sha256(narrative_data)`，TTL 1 小時，全團隊每 range 每小時最多打 1 次 LLM
- friction notes 給 LLM 前 redactPII（email / IP）

**新檔**

- `src/lib/llm-narrative.js` — llm-switch wrapper（buildMessages + parseLLMJson + computeDataHash + callLLMSwitch）
- `src/lib/narrative-cache.js` — in-memory hash cache
- `src/routes/me-narrative.js` — 兩個 endpoint
- `tests/{narrative-cache,llm-narrative,me-narrative}.test.js` — 24 個新測試

**設定**

管理者需在 production `.env` 加 `LLM_SWITCH_API_KEY`（見 `.env.example`）。
沒 key 時 endpoint 回 503，機械版報告仍可用。

## v1.17.46 — /me 專案排行 UI 精簡

**Vincent 反饋**：「我的份這欄位拿掉，另外也不用說什麼偶發測試。」

**修法**

- `src/public/me/index.html`：
  - 移除「我的份」欄位（header + cell + desc 文案）
  - 移除「N 位偶發測試略過」註記，noise contributors 不再顯示
- `src/routes/me.js`：清掉 `my_sessions` / `my_handoffs` 累計欄位（前端已不用）

## v1.17.45 — 自動觀測搬到伺服器端（不再依賴客戶端版本）

**Vincent 反饋**：「我的本機 OwnMind 還是 v1.17.22，自動觀測只寫在客戶端，
所以最近 14 天 6 個高風險動作都沒被觀測到。其他人也卡舊版（Adam 1.17.16），
這個邏輯應該搬到伺服器端。」

**修法**

新增 `src/routes/activity.js` 的 `autoEmitObservedTrigger()`：
活動紀錄進伺服器時，若是高風險事件，自動補寫一筆 `iron_rule_compliance`
（action='observed_trigger', source='system_server_auto'）。

對應規則：
- `memory_disable` (target type=iron_rule，伺服器查 memories.type 確認) → IR-006
- `memory_save` (details.type=iron_rule) → IR-006
- `memory_update` (target type=iron_rule，伺服器查 memories.type 確認) → IR-006
- 不對 handoff_create 自動觀測（Codex round 4 過度推論問題仍適用）

**配套**

- `src/routes/me.js` 鐵律遵守表 + gap audit 把 source 比對改成
  `NOT LIKE 'system_%'`，讓 client `system_auto` 跟 server `system_server_auto`
  都被歸類成「自動觀測」、不混入「人工驗證」統計

**好處**

不再依賴客戶端版本：即使 Adam 卡 1.17.16、Vincent 本機沒升，他們的活動只要
傳到伺服器，伺服器就會自動補觀測紀錄。徹底落實 IR-027「邏輯卡控不靠端版本」。

## v1.17.44 — 前端 unverified label 對齊後端中性文案

Codex round 7 抓到的小不一致：v1.17.43 已把 unverified message 中性化，
但前端 TYPE_LABEL 還寫「AI 未主動回報遵守」（仍偏 AI 行為歸因）。

修：`src/public/me/index.html` TYPE_LABEL.compliance_unverified 改成
「未驗證合規（僅系統觀測）」對齊後端文案。

## v1.17.43 — Compliance gap 加 rule_code 關聯比對 + 文案中性化

**Codex round 6 review 抓到的兩個 P1**

### P1.1 has_manual_comply 加 rule_code 關聯
之前 `has_manual_comply` 只看「±10 分鐘內任一 manual comply」就清 gap，會誤判。
例如：14:00 停用 IR-006，14:05 對 IR-008 主動回報遵守 → 系統誤以為 IR-006 也有人驗證過。

修法：sensitive CTE 加 `expected_rules` 欄位（陣列）：
- `memory_disable` → `['IR-006']`
- `memory_save type=iron_rule` → `['IR-006']`
- `handoff_create` → `['IR-008', 'IR-009', 'IR-024']`

`has_matching_manual_comply` 改成：找出 ±10 分鐘內 `action='comply'` AND `source != 'system_auto'`
AND **`rule_code = ANY(expected_rules)`** 的紀錄才算數。

### P1.2 unverified 文案中性化
之前訊息：「AI 沒主動回報，AI 該養成主動 ownmind_report_compliance 的習慣」
→ 太像在訓練 AI，使用者讀起來像內部備忘錄。

改成：「N 個高風險動作僅由系統自動觀測到，沒有對應鐵律的人工驗證紀錄」
→ 描述事實、不帶教訓語氣。

## v1.17.42 — Compliance gap 拆兩種等級（漏觀測 vs 未驗證）

**Vincent 反饋**：拆 vs 不拆對比後選拆，理由：
> 「不拆等於系統幫 AI 擦屁股，跟『不靠 AI 自覺』訴求矛盾」

**修法**

把原本單一 `compliance_gap` 改成兩種獨立的 audit findings：

| Finding | 嚴重度 | 條件 | 動作建議 |
|---|---|---|---|
| `compliance_unobserved` | 🔴 高 | 高風險動作 ±10 分鐘**完全沒**任何合規紀錄（連系統觀測都沒抓到）| 系統可能有 bug，要排查觸發機制 |
| `compliance_unverified` | 🟡 中 | 有系統觀測（observed_trigger）但無 AI 主動回報的 comply | AI 該養成主動回報習慣 |

**為什麼拆**

之前把兩種混成一個，`observed_trigger` 一寫進來就把所有 gap 蓋成 0，看儀表板會誤以為「全部守規」。實際上很多是「系統有看到但 AI 沒驗證」。

拆開後：
- 0 高警 = 系統健康，能抓到所有觸發
- 中警出現 = 推 AI 改善主動回報習慣

## v1.17.41 — Codex round 4 review 後 auto-compliance 誠信修補（P1+P2 全做）

**Codex 抓到的核心誠信問題**：
> 「v1.17.40 把 system 觀測寫成 action='comply' 是自欺。Disable iron_rule 不證明
> 全層同步、handoff_create 不證明 commit 守規」

**修法 6 項**

### P1（必修，誠信問題）

- **action 從 'comply' 改成 'observed_trigger'**（系統自動 path）
  誠實標示「系統觀測到 tool 被呼叫」，不假裝「已驗證遵守」
- **移除 `handoff_create → IR-008/009/024` 自動觸發**（過度推論，commit 規則該靠 git hook）
- **`compliance_gap` audit 加 source filter**：observed_trigger 只關「漏觸發」gap，不算驗證合規
- **鐵律遵守表加「系統觀測」獨立欄位**，遵守率只算 AI 自報部分，不混 system_auto

### P2（建議）

- 移除 `.catch(() => {})` silent，改 `console.error('[autoComply] failed: ...')`
- `complianceEvents` 加 dedup：用 `(rule_code, tool, 1分鐘 timestamp bucket)` key，
  避免同一動作被 AI manual + system auto 重複算
- auto path 補呼叫 `appendCompliance()` 對齊 manual ownmind_report_compliance

**三層語意現在區分清楚**

| Action | 來源 | 算「遵守率」？ |
|---|---|---|
| `comply` | AI 主動 ownmind_report_compliance | ✅ 算 |
| `skip` | 同上 | ❌ 不算 |
| `violate` | 同上 | ❌ 不算 |
| `observed_trigger` | 系統 tool handler 自動 | ⏸ 獨立統計，不混入遵守率 |
| `verified_comply`（未來預留）| git hook 等程式驗證 | ✅ 最嚴謹 |

## v1.17.40 — Compliance call 從 AI 自覺改成系統強制（IR-027 邏輯卡控落地）

**Vincent 反饋**：
> 「我每次跟你 commit、停用 memory、新增 IR-036、新增 backlog memory… 都該主動呼叫
> ownmind_report_compliance 但我沒有。」「把 compliance call 變成系統強制。」

**修法**

`mcp/index.js` 在 CallToolRequestSchema handler 內 `await handleTool` 成功後，
新增 `autoComplyForToolCall(name, args, result)` — 根據 tool name + args 自動 emit
對應的 `iron_rule_compliance` events，**不再讓 AI「忘了講」就漏紀錄**。

**對應規則**

| Tool call | 自動 comply 哪些鐵律 |
|---|---|
| `ownmind_disable`（停用 iron_rule） | IR-006 全層同步 |
| `ownmind_save`（type=iron_rule） | IR-006 |
| `ownmind_update`（target type=iron_rule） | IR-006 |
| `ownmind_handoff_create` | IR-008 + IR-009 + IR-024 |

**source='system_auto' 標記**

每筆 system 自動 emit 的 compliance event 都帶 `source: 'system_auto'`，跟
AI 主動呼叫的（無 source / 'ai'）區別。dashboard 未來可分開統計「系統自動 vs
AI 自報」，但 audit 端兩者都算數（gap 偵測會關掉）。

**效果**

- compliance_gap audit 從現在起對 memory 操作系列幾乎不會再報
- 即便 AI 完全不呼叫 ownmind_report_compliance，DB 也會有完整鐵律觸發紀錄
- 真正解到「邏輯卡控」 — 對齊 IR-027

## v1.17.39 — Codex round 3 review 後 audit 全面修補（P1+P2+P3）

**Vincent 指示**：「P1/P2/P3 全都修」

**修法（5 項對應 Codex review）**

- **P1.1 orphan_session 加日期 gate**
  - 之前 v1.17.37 之前的歷史 sessions 全部誤標
  - 加 `AND created_at >= '2026-05-07'`（v1.17.37 ship 日）

- **P1.2 compliance_gap 縮窄 sensitive event**
  - 之前 `memory_update` 太常見會大量誤報
  - 改成只看 high-confidence：`handoff_create` / `memory_disable` / `memory_save where type=iron_rule`

- **P2.1 heartbeat tool name 用 LOWER(TRIM(...)) 比對**
  - 之前 activity tool 跟 heartbeat tool 大小寫不同就漏判
  - 加大小寫不敏感比對 + 過濾 `unknown` / `mcp` 這種 placeholder

- **P2.2 audit_findings 持久化（high severity）**
  - 之前 on-the-fly 計算，user 沒打開報告就看不到
  - 改成 `severity='high'` 的 findings 寫進 `audit_logs` 表（24h 內 dedup）
  - 未來可接 broadcast / email 通知管線

- **P3 blind-spot detection**
  - 新增 `unobservable_source` finding：帳號 > 7 天但 14 天內 0 activity / 0 token / 無 heartbeat
  - 新增 `team_blindspot` finding（super_admin only）：列出可能用非 MCP 介面（claude.ai web / ChatGPT）工作的成員

## v1.17.38 — Server-side 反向稽核 5 項（Codex review 後實作）

**背景**：Codex adversarial review 指出 compliance / token_events / session_log
本質都是「靠 client 自首」，AI/scanner/process 任一環節失敗就漏。
Vincent 要求「不能靠 user 主動處理，AI 要能主動判斷追蹤」。

**新增 5 個 server-side audit（在 `/api/me/report` 即時計算，回 `me.audit_findings`）**

1. **`compliance_gap`** — 高風險 activity（handoff_create / memory_disable /
   memory_update）前後 ±10 分鐘沒對應 iron_rule_compliance event → 標 medium/high
2. **`heartbeat_absent`** — 最近 7 天有該工具的 activity 但 collector_heartbeat
   超過 24 小時沒回報 → 標 high（直指 Adam Windows scanner 失靈場景）
3. **`source_inconsistent`** — 某天有 activity_logs 但 0 token_events → 標 low/medium
4. **`orphan_session`** — session_logs 對話輪次 ≥5 但 details.compliance 是空陣列
   → 標 low（AI 整段沒回報合規）
5. **`ir027_candidate`**（super_admin only）— user 建立超過 7 天仍 must_change_password
   = TRUE → 可能根本沒登入 /ownmind/me/

**前端**：個人 tab 最頂顯示警示卡片（紅高 / 黃中 / 藍低），含人話訊息 + 統計。

**設計原則**：on-the-fly 計算（非持久化 audit_findings 表），減少 schema 變更
+ 一律最新。未來資料量大可遷成 nightly job + persistent table。

## v1.17.37 — Session log 自動帶 project + 多種退出 signal 都記錄（IR-027 邏輯卡控）

**Vincent 反饋**：「叫 user 每次跟 AI 講『寫 session_log』違反 IR-027 邏輯才有效。
系統應該自己處理。」

**問題**

- 之前 emergencySessionLog 不寫 project 欄位 → 報告頁無法歸到專案
- 只訂 SIGTERM/SIGINT，但 SIGHUP（terminal close）、SIGQUIT、kill -9 都漏接
- 結果：很多 session 結束沒有產生 session_log，user 又得手動叫 AI 寫

**修法**

- `mcp/index.js` 啟動時自動從 `CLAUDE_PROJECT_DIR` / `OWNMIND_PROJECT_DIR` /
  `process.cwd()` 取 `path.basename()` 當 `AUTO_PROJECT`
- emergencySessionLog 寫入 details 時帶 `project: AUTO_PROJECT` +
  `duration_turns`（估算）
- 多訂 SIGHUP / SIGQUIT signal handler
- 加 `process.on('exit', ...)` 同步 fallback：kill -9 沒有 signal 但 exit 仍會
  觸發；只能寫本地 JSONL（async upload 不及完成）
- 防重複：emergencySessionLog 一進就 set sessionLogged

**對 RING 等專案的影響**

未來 user 在 ring-linebot 目錄開 Claude Code → MCP 啟動 → AUTO_PROJECT='ring-linebot'
→ 不論怎麼結束都會寫帶 project 的 session_log → 報告頁正確歸類。

## v1.17.36 — 專案來源加 handoffs（修 RING 看不到）

**Vincent 反饋**：「RING 為什麼沒在專案裡？」

**Root cause**：之前專案來源只看 `session_logs.details.project`，但 Vincent
做 RING 時都只寫 handoff（交接）給下個 session，沒走「結束總結」流程，
所以 RING 在 session_logs 裡 0 筆。

**修法**

- 後端：加 `projectHandoffQ` 從 `handoffs` 表撈每個 user 對每個專案的交接數，
  跟 session_logs 結果合併到同一個 projects map
- 排序改：`turns DESC, handoffs DESC, sessions DESC`（先看量化，再看交接活動）
- 「主要負責人」「其他貢獻者」邏輯：若該人 turns=0 但 handoffs>0，
  顯示成「N 次交接（無 session_log）」
- 前端專案表加「交接」欄

## v1.17.35 — 團隊趨勢圖支援切換 metric（Session / Token / 對話輪次）

**Vincent 反饋**：團隊頁趨勢圖只能看 Session 數，希望可以切換看 Token 量或對話輪次。

**修法**

- 後端：團隊每位成員 + 三張 trend chart 都新增 tokens / turns 欄位
  - `tokens` = SUM(input + output + cache_creation + cache_read + reasoning_tokens) from `token_events`
  - `turns` = SUM(`details.duration_turns`) from `session_logs`
  - 用 FULL OUTER JOIN 合併三個 dataset，避免某 metric 沒資料的 bucket 被丟掉
- 前端：
  - 團隊每位成員表加 Token 數 / 對話輪次 兩欄（K/M 縮寫顯示，hover 看完整數）
  - 趨勢區塊上方放下拉選單切換：Session 數 / Token 數 / 對話輪次
  - barChart 加 fmtBig() 處理大數（13.5K / 2.4M）+ tooltip 顯示完整數

## v1.17.34 — 自訂日期範圍 + 專案名稱大小寫合併

**Vincent 反饋兩點**：
1. 想自己指定起訖日（不只 7d/14d/30d/all preset）
2. 「ownmind」跟「OwnMind」明明同一個專案，被拆兩列

**修法**

- 後端 `/api/me/report`：
  - 支援 `?start=YYYY-MM-DD&end=YYYY-MM-DD` 自訂範圍（end 涵蓋當日整天）
  - 格式驗證 ISO 才接受、否則 fallback 到 preset
  - 專案名稱用 `LOWER(TRIM(...))` 當 group key 合併大小寫變體；
    顯示用 `MIN()` 取一個原字串
- 前端：
  - range select 多 `自訂…` 選項，揭露起 / 訖 date input + 套用按鈕
  - 選 custom 時預設帶 14 天前 → 今天
  - 切到 preset 直接 reload；切到 custom 等使用者按「套用」

## v1.17.33 — 鐵律/活動紀錄分頁 30 筆 + 活動範圍內全列出

**Vincent 反饋**：
1. 鐵律 31 條、活動 200+ 筆，捲不完
2. 活動紀錄應該時間範圍內全列出，不要硬截 200 筆

**修法**

- 後端 `me.activity`：移除 `LIMIT 200`，回傳時間範圍內全部 activity
- 前端：兩個表都加分頁器（30 筆/頁）
  - 上一頁 / 下一頁按鈕、顯示「N–M / 總數（第 X / Y 頁）」
  - 切換 range 時自動回到第 1 頁
  - 不到 30 筆時不顯示分頁器

## v1.17.32 — 個人 tab 加活動紀錄區塊 + 鐵律遵守列出全部 + 遵守率

**Vincent 反饋兩點**：
1. 想看自己過去這段期間的「全部活動」流水，個人 tab 最下方加一塊
2. 鐵律遵守表只列觸發過的，希望列**所有 active 鐵律**並算遵守率

**修法**

- 後端 `/api/me/report`：
  - `me.compliance`：改 LEFT JOIN `memories` 列出 `type=iron_rule, status=active` 全部 31 條；
    沒觸發過的 comply/skip/violate 都 0
  - 新增 `me.activity`：最近 200 筆 activity_logs（含 event / tool / source / details）
- 前端 `/ownmind/me/`：
  - 鐵律表加「遵守率」欄，計算 `comply / (comply + skip + violate)`，依比率著色
    （≥80% 綠 / ≥50% 橘 / <50% 紅 / 無紀錄灰）
  - 個人 tab 最下加「我的活動紀錄」card，列時間 / 事件 / 工具 / 來源 / details
    （依時間倒序、最多 200 筆）

## v1.17.31 — 專案「其他貢獻者」過濾偶發測試（Vincent 回報）

**Vincent 反饋**：「Adam 是 user 不是開發者，為什麼算他進 OwnMind 貢獻者？」

**Root cause**：Adam 4/24 寫了 1 筆 session_log 標 project='ownmind' 8 輪
（可能測試或誤標）。前一版只要寫過 session_log 就算協作，semantic 不準。

**修法**：「其他貢獻者」加門檻 `max(20 輪, 專案總輪次 × 10%)`，低於視為偶發測試。
- OwnMind 148 輪 → 門檻 20 → Adam 8 輪略過、UI 標「+1 位偶發測試略過」
- funit-v2 491 輪 → Adam 是主要負責人，正常顯示

## v1.17.30 — bar chart 加平均線 + 專案改顯示主要 vs 其他貢獻者（Vincent 回報）

**Vincent 反饋兩點**：
1. bar chart 沒平均值參考 → 看不出「這天比平均高還低」
2. 「OwnMind 是 Vincent 的專案，為什麼 owners 列出 Adam？」

**修法**

1. **bar chart 加平均線**：
   - 紅色虛線橫跨整張圖、右上方標「平均 N」
   - 平均只看非零值（避免週末、未開始日把平均拉低）
2. **專案表改成「主要負責人」+「其他貢獻者」兩欄**：
   - 後端 API 改回傳 `contributors: [{name, sessions, turns}]`（依 turns 排序）
   - 前端取第 1 名當主要負責人、其他人列為「協作」
   - 例：OwnMind 專案 → 主要 Vincent (140 輪)，其他 Adam (8 輪)

## v1.17.29 — bar chart 加數字標籤（Vincent 回報）

每根 bar 上方顯示數值（0 值不顯示避免雜訊）。`.bar-chart` 高度從 220 → 240px、
新增 `padding-top: 18px` 留數字空間。

## v1.17.28 — hotfix /ownmind/me/ bar chart 全空（Vincent 截圖回報）

**症狀**：登入進報告頁後，「每日活動量」「時段分布」「一週節奏」三張柱狀圖
都只有底部的標籤、沒有任何 bar。

**Root cause**：
- `.bar-row` 用 `display: flex; flex-direction: column` 但沒給高度
- 內部 `.bar` 用 inline `height: ${h}%`，% 找不到固定高度的 parent → 0
- 等於 bar 永遠 0px

**修法**（純 CSS）：
- `.bar-row` 加 `height: 100%; justify-content: flex-end`，確保 row 等高且 bar 從底部往上長
- `.bar-label` 改 absolute position 在 row 下方（不佔 bar 的高度）
- `.bar-chart` 加 `padding-bottom: 24px` 留 label 空間

## v1.17.27 — hotfix /ownmind/me/ API path 寫錯（Vincent 截圖回報）

**症狀**：登入畫面按「登入」吐 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

**Root cause**：`src/public/me/index.html` 用 `/api/me/...` 直接打 root，
但 nginx 只 rewrite `/ownmind/...` → `/...`。前端打 `https://kkvin.com/api/me/login`
沒對應 route，nginx 回 default HTML 頁，前端 `r.json()` 解析失敗。

**修法**：所有 fetch 從 `/api/me/...` 改 `/ownmind/api/me/...`，跟 admin 一致。

## v1.17.26 — admin 建 user 時自動套預設密碼

**背景**：v1.17.25 補了存量 user 的預設密碼，但「admin 後台新增 user」流程
還沒對齊。admin 沒指定密碼建出來的 user 進不了 /ownmind/me/。

**改動**

- `src/routes/admin.js` POST /users：
  - 新增常數 `DEFAULT_USER_PASSWORD = 'Password42760988'`
  - admin 沒指定 password 且 role='user' → 自動套預設密碼 + `must_change_password = TRUE`
  - admin 指定 password → 維持原行為（不強制改）
  - INSERT 帶上 `must_change_password` 欄位
- `tests/me-report.test.js`：新增 1 case 確保預設密碼 + must_change_password 都有寫入

**測試**：644/644 pass

## v1.17.25 — /ownmind/me/ 改成帳密登入 + 強制首次改密碼

**背景**：v1.17.24 用 api_key 登入 UX 太差（user 要從設定檔翻 key、洩漏風險高）。
改成標準的 email + password 流程。

**改動**

- `db/010_user_password_login.sql`：新增 `must_change_password` 欄位 + 強化 email 索引
- `src/jobs/seed-default-passwords.js`：server boot 時補預設密碼給 `password_hash IS NULL` 的 user，
  預設 `Password42760988`、`must_change_password = TRUE`，idempotent
- `src/routes/me.js`：
  - `POST /api/me/login` — 接受 email+password，回 api_key + must_change_password flag
  - `POST /api/me/change-password` — 改完自動清 must_change_password 旗標
  - `/profile` 多回 must_change_password
- `src/public/me/index.html`：登入表單從「貼 api_key」改成「Email + 密碼」，
  must_change_password=true 時強制顯示改密碼表單再進報告
- `src/index.js`：boot 時呼叫 seedDefaultPasswords()

**user 流程**

1. 開 https://kkvin.com/ownmind/me/
2. 輸入 Email + 預設密碼 `Password42760988`
3. 系統強制顯示「改密碼」表單，輸入舊密碼 + 新密碼（≥8 字元）
4. 改完直接看報告，下次只要 Email + 新密碼

**測試**：643/643 pass，新增 6 個 reproduction case

## v1.17.24 — 用戶用量報告頁（/ownmind/me/）

**背景**：之前後台只有 admin / super_admin 能登入，user role 完全看不到自己 / 團隊
的活動量。Vincent 表示要開放讓 user 也能看「個人 + 團隊」用量報告，內容比照
HackMD 那份手動整理的版本，但即時資料、自助登入。

**設計決策**（跟 Vincent brainstorm 4 題拍板）

- Q1 = C：完全開放，互看活動 / 版本，不匿名化
- Q2 = B：全團隊專案都看得到（不含對話內容、只看數量）
- Q3 = B：獨立 URL `/ownmind/me/`，跟 admin 後台分開
- Q4 = 完整版（不是 MVP）

**新增**

- `src/routes/me.js` — `/api/me/profile` + `/api/me/report?range=7d/14d/30d/all`
  - 用 `auth` middleware（一般 auth，不擋 user role）
  - report 回 me / team / projects 三大區塊：個人活動 / 版本 / 專案 / 合規 +
    團隊成員列表 / 每日趨勢 / 時段熱力 / 一週節奏 / 事件類型 / 全工具版本
- `src/public/me/index.html` — 自助登入（貼 api_key 存 localStorage）+ 三 tab
  報告頁，內建 bar chart（純 CSS，無 mermaid 依賴）
- `tests/me-report.test.js` — 7 個 case 防退化

**改動**

- `src/app.js` — 掛 `/api/me` 路由 + 提供 `/me` 靜態頁（nginx rewrite 到
  `/ownmind/me/`）
- 三語系 README + CHANGELOG + FILELIST 同步

**測試**：638/638 pass

**對 user 的影響**

Eric / Michelle / Adam（user role）現在可以開 https://kkvin.com/ownmind/me/，
貼上自己的 api_key（從 `~/.claude/settings.json` 找 `OWNMIND_API_KEY`），看自己
的活動 + 全團隊聚合資料。Vincent / Eric（admin）也能用此頁，但他們也保留 admin
後台原有功能。

## v1.17.23 — Codex review 抓到的 v1.17.22 後續修補（5 項）

**背景**：v1.17.22 修了 Windows MCP auto-update silent-skip，但 Codex
adversarial review 又抓到 5 個問題，整理在這個 patch 一次處理。

**改動**

1. 🔴 **`scripts/update.ps1` argv index bug**
   - v1.17.22 寫法：`process.argv[1]` 取 settings path → 實際是 `.js` 檔本身
   - 結果：Windows 用戶 settings.json 注入 hook 整段失效
   - 修法：改用 `process.argv[2]` / `process.argv[3]`

2. 🔴 **`mcp/index.js` lock acquire 不 atomic**
   - v1.17.22：`existsSync` + `writeFileSync` 有 TOCTOU race
   - 修法：`fs.openSync(LOCK_FILE, 'wx')` exclusive create，
     EEXIST → `update_skipped reason=lock_held`，其他 → `update_failed step=lock`

3. 🟡 **`scripts/update.ps1` 漏了 Gemini / Copilot / Cursor hooks 注入**
   - v1.17.22 PS1 只覆蓋 Claude 部分（update.sh 的 1./2./3. 段）
   - 修法：補上 4./5./6. 段（Gemini CLI / GitHub Copilot / Cursor）

4. 🟡 **`mcp/index.js` git stash 沒 pop 會吞 user 變更**
   - v1.17.22：`git stash -q` 後 `git pull`，但沒 pop
   - 修法：用 `git pull --rebase --autostash`（git 2.6+ 一條命令解決）

5. 🟡 **`mcp/index.js` 外層 catch silent fail**
   - v1.17.22：`runAutoUpdate().catch(() => {})` 把意外吞光
   - 修法：catch 寫 `update_failed step=outer` + cleanup lock

**測試**：631/631 pass，新增 5 個 reproduction case。

## v1.17.22 — 修「Windows 用戶 MCP auto-update silent skip」（Eric / Adam case）

**背景**（從工作紀錄分析報告 2026-05-07 發現）

Eric (LAPTOP-G95HIQ3V) 卡 v1.17.17、Adam 卡 v1.17.16，
但 server 已經 v1.17.21。兩人 4/21 後完全沒有 update_check / update_failed
event，只有 init / memory_* 正常進 DB。

**Root cause（兩層）**

1. `mcp/index.js` line 1054 用 `process.env.HOME || ''`：Windows 通常沒設
   HOME（用 USERPROFILE），導致 `OWNMIND_DIR = '.ownmind'` 變相對路徑，
   `fs.existsSync('.ownmind/.git')` 永遠 false → **整個 auto-update silent skip
   沒任何 log 可觀測**。
2. 即使路徑對，`exec(bashScript)` 的 bash 語法（`touch`、`||`、`cd ~`、heredoc）
   在 Windows cmd.exe 全部不認，會立刻語法錯誤。

**修法**

- `mcp/index.js` 整段 auto-update 重構：
  - `OWNMIND_DIR` 改用 `os.homedir()`（跨平台、Windows 自動讀 USERPROFILE）
  - 廢棄 `exec(bashScript)`，改用 Node-native `execFile` 呼叫 git/npm 二進位
  - Windows 用 `npm.cmd`（execFile 不過 shell 找不到 `npm`）
  - 同步 skill/hook 步驟：Unix 跑 `bash update.sh`、Windows 跑
    `powershell update.ps1`
  - 條件不成立時新增 `update_skipped` event（reason: marker_today /
    no_git_dir / lock_held），終結 silent skip
- `scripts/update.ps1`（新檔，含 UTF-8 BOM）：對應 update.sh 的 PowerShell 版，
  同步 Claude Code skills、hook scripts、settings.json hooks
- 測試：
  - `tests/mcp-auto-update-cross-platform.test.js`（8 case）：os.homedir、
    update_skipped、execFile 跨平台、update.ps1 存在性
  - `tests/p3-update-event-semantics.test.js` 既有測試對齊新 Node-native 架構

**測試**：626/626 pass

**對 Eric / Adam 的影響**

下次 MCP 啟動時：
- 路徑解析正確 → 進入 auto-update 流程（之前永遠跳過）
- 寫 update_check event（之前 0 筆）
- 任何 step 失敗都寫 update_failed + step 名稱（之前完全 silent）
- 即使整體沒升起來，dashboard 也看得到「為什麼沒升」

## v1.17.21 — 修「compact mode 砍掉合規回報指令導致 iron_rule_compliance 0 紀錄」

**背景**（2026-05-07 從工作紀錄分析報告中發現）

`activity_logs` 中 `iron_rule_compliance` event 自 2026-04-21 起完全停止寫入
（之前累積 60 筆，4/22~5/7 是 0 筆），而 MCP tool `ownmind_report_compliance`
寫入端正常（手動測試會進 DB）。

**Root cause**

`src/routes/memory.js` 用 `?compact=true` 拉 init 時，第 653 行
`...(!compact && { instructions: INSTRUCTIONS_SOP })` 會把整段 SOP 拿掉。
SOP 第 193 行有「**每次鐵律被觸發後，必須呼叫 ownmind_report_compliance**」
這條指令；compact mode 等於把這條教學完全砍掉。SessionStart hook 用的就是
compact，新 session 的 AI 拿不到指令，隨時間自然漂移成「不再呼叫」。

Compact 從 3/30 上線，4/21 之前還有紀錄是因為 AI 從 skill 檔 / 歷史對話
記得這條規則；隨著 skills 重構，記憶逐漸流失。

**修法**

把合規回報指令固定附加在 `iron_rules_digest` 末尾。digest 在 compact mode
也會送（`iron_rules_digest: ironRulesDigestFinal` 沒 compact gate），語意上
digest = 鐵律清單，compliance = 鐵律觸發後的回報，兩者天然成對。多 ~80 tokens
換永久觀測。

**改動**

- `src/routes/memory.js` — `ironRulesDigestFinal` 末尾固定附加合規回報指令，
  涵蓋 comply / skip / violate 三個 action
- `tests/init-compact-compliance-instruction.test.js` — 3 個 regression case：
  digest 含 `ownmind_report_compliance`、digest 在 compact 也送、三 action 齊全

**測試**：618/618 pass

## v1.17.20 — Admin 工作紀錄頁 + 隱藏資料品質警示

**Admin Dashboard 新增「工作紀錄」頁籤**（super_admin only）

三來源時間軸，把全團隊每個人的活動串起來，super_admin 可查看：
- **活動**：`activity_logs` 中 event ≠ `iron_rule_compliance` 的事件（init / update / tool_call 等）
- **合規**：`activity_logs` 中 `iron_rule_compliance` 事件（鐵律遵守 / 違反）
- **Session**：`session_logs` 表的 AI session 摘要

預設顯示最近 30 天 / 100 筆，支援篩選：日期 range / user / tool / event_type / 全文搜尋（details / summary 走 ILIKE）。

**改動**

- `src/routes/admin-work-log.js`（新檔）— `GET /api/admin/work-log` + `/filters` endpoint，三來源 UNION ALL，依 ts DESC 排序，limit 上限 500
- `src/app.js` — mount router 在 `/api/admin/work-log`，順序在 `/api/admin` 之前避免被 catch
- `src/public/index.html` — 新「工作紀錄」tab（super_admin only）、篩選列、分頁載入更多按鈕；同時把「資料品質警示」card 加 `hidden`（日常不需顯示）
- `tests/admin-work-log.test.js` — 9 個 case：權限、UNION、篩選、limit cap、total_count

**測試**：615/615 pass

## v1.17.19 — 自動更新 lock 失敗納入失敗偵測（project_281 backlog item C）

**背景**：v1.17.18 的 P3 修法把 `git fetch / pull / npm install / update.sh` 每步都加了顯式
失敗 marker，但漏了第一步的 `touch "${LOCK_FILE}"`。disk full / readonly FS / 權限異常時 touch
會失敗，後續的 update pipeline 會在「沒 lock 保護」下繼續跑，理論上有機會與另一個並行的
SessionStart hook race。實務碰到機率低，但對齊 P3「每步顯式 trap」原則補完。

**改動**

- `mcp/index.js` — shell 首行 `touch "${LOCK_FILE}" || { echo "__OM_LOCK_FAIL__"; exit 9; }`，
  callback `failMarkers` 陣列補入 `__OM_LOCK_FAIL__`，lock 失敗會寫 `update_failed` step=lock
- `hooks/ownmind-session-start.sh` — `touch "$LOCK_FILE" || { log_event update_failed step=lock; exit 0; }`
- `tests/p3-update-event-semantics.test.js` — 新增 3 個 P3-lock regression case

**測試**：606/606 pass

## v1.17.18 — 修「升級後仍重複跳出升級提醒」

**背景**：每次 Claude Code SessionStart 都跳出 `[WARNING] OwnMind 有新版本 …` 廣播，
即使 client 已升級到最新仍持續顯示，需要 AI 手動 dismiss 才會停。Root cause 是兩個獨立 bug：

1. `hooks/ownmind-session-start.sh` 呼叫 `/api/broadcast/active` 沒帶 `client_version`，
   server 端 `src/lib/broadcast-filter.js` 的 `if (client_version)` 條件不成立 →
   `min/max_version` semver 過濾完全跳過 → 已升級用戶仍收到 `max_version=<prev>` 的歷史升級提醒。
2. `mcp/index.js` 的 `fetchBroadcastsSafely` 讀 `process.env.OWNMIND_VERSION`（從未設定），
   實際應該用同檔案頂端從 `package.json` 解出的 `CLIENT_VERSION`。
3. dismiss 責任之前掛在 AI skill 上（讀完 `OK:done:*` 後手動 POST），AI 漏做就不會 dismiss
   → 違反 IR-027「邏輯才有效」。

**改動**

- `hooks/ownmind-session-start.sh` — 抓 `package.json` 版號，當 `?client_version=` query 與
  `X-Ownmind-Version` header 一起送
- `mcp/index.js` `fetchBroadcastsSafely` — 改用 `CLIENT_VERSION`，env var 改 fallback
- `scripts/interactive-upgrade.sh` + `.ps1` — 在 `OK:done:*` 之前主動撈 `upgrade_reminder`
  廣播並逐一 POST `/api/broadcast/dismiss`，腳本主動清自己
- `skills/ownmind-upgrade.md` — 移除「Step 3：AI 手動 dismiss」段落，註明現在由腳本自動處理
- 既有 server 端 `/api/broadcast/active` 已支援 `?client_version` 與 `X-Ownmind-Version`
  header（`src/routes/broadcast.js:187-189`），無需改動

**新增測試**

- `tests/broadcast.test.js` — 新增 2 個 regression case：
  - `applies max_version filter when client_version is in query string`
  - `skips semver filter when client_version absent (back-compat)`
- 全部 53 個 broadcast cases 通過

**鐵律對齊**

- IR-027 邏輯卡控：dismiss 從 AI skill 移到腳本
- IR-031 三處版號同步：`package.json` → 1.17.18（SERVER_VERSION / CLIENT_VERSION 都從 package.json 讀，單一來源）
- IR-008 / IR-026：CHANGELOG / FILELIST 同步

## v1.17.17 — Dashboard 團隊一覽改造

**背景**：admin 在 dashboard 上看不到「最近 7 天每位成員整體在做什麼、守鐵律守得如何」。「Audit Log」這個名字也誤導，user 直覺以為是團隊活動紀錄，實際內容是 ingestion 異常事件。

**改動**

- 後端新增 `GET /api/usage/admin/team-overview` — 每位成員的最近活動、對話場次、最常做的專案、鐵律遵守率（從 `session_logs.details` 彙總）
- 後端新增 `GET /api/usage/admin/team-overview/:user_id/sessions` — 該成員最近 N 場 session 流水（含 `machine_meta` 副資訊：os / scanner_version）
- 後端 `collector_heartbeat` 表加 `os` 欄位（migration `db/009_collector_heartbeat_os.sql`）
- Client（mcp/index.js）heartbeat payload 加 `os: os.platform()`（darwin / linux / win32）
- 前端「團隊用量排行榜」加四欄：最近活動 / 對話場次 / 最常做的專案 / 鐵律遵守率
- 前端日期篩選器預設帶最近 7 天
- 前端「成員詳情」卡新增「最近對話」摺疊區（lazy load + race guard）
- 「Audit Log」改名「資料品質警示」+ 加說明列說明它不是團隊活動紀錄
- 機器名旁加 OS · scanner_version 副資訊（避免 Adam 機器叫「after」這類短名造成 UX 混淆；前端把 darwin/linux/win32 轉成 macOS/Linux/Windows）

**新增測試**

- `tests/team-overview-api.test.js` — 鐵律遵守率算法、票選專案、scoreboard endpoint（含 7 天預設、range echo、邊界 case）— 16 cases
- `tests/team-overview-sessions-api.test.js` — sessions endpoint、machine_meta fallback、limit 上限/0/負數 — 7 cases

**No schema migration 對既有資料**：`db/009_*.sql` 只是加新欄位（IF NOT EXISTS），既有資料不動。

**相容性**：v1.16 之前的 session 沒填 `details.project` / `details.rules_*` 的會被忽略不算（前端顯示「—」），不擋查詢。

**鐵律對應**：IR-022（Server + Client 兩端同改）、IR-031（package.json 同步推 1.17.17）、IR-008 / IR-026（CHANGELOG / README / FILELIST 同步）、IR-020（部署後瀏覽器實測）、IR-034（新 db/009_*.sql 由 Dockerfile `COPY db/` 自動涵蓋）。

## v1.17.16 — 修 update_ok 假陽性事件（dashboard 數據誠信問題，回報者 Adam case）

**背景**：Adam (Windows) 4/26 dashboard 顯示有 `update_check + update_ok` 兩個 event，看起來升級成功，但實際 client 還是 1.17.10（沒升）。追下去發現 OwnMind 的自動更新機制在兩個地方有同款 silent-fail bug：

1. `mcp/index.js`（每次 MCP server 啟動跑一次）
2. `hooks/ownmind-session-start.sh`（每個 SessionStart 跑一次，頻率更高）

**Root cause**：兩處的 shell pipeline 都把 `git pull / npm install / update.sh` 用 `2>/dev/null` 吞掉錯誤，最後 `if [ shell exit 0 ]` 就無條件寫 `update_ok`（mcp）/ `update_applied`（hook）。但下面三種情境都會 exit 0：

- `UPDATES=""` 沒新 commit 可拉（if 整段不跑，echo marker 仍 exit 0）
- `git pull` 失敗被 `2>/dev/null` 吞 + `||` fallback → exit 0
- `npm install` / `update.sh` silent fail → exit 0

`update_ok` 字面意思「升級成功」≠ 實際語意「shell 沒爆」 → dashboard 顯示「使用者已更新」但實際根本沒升。違反 OwnMind「透明度」原則。

**修正**

**mcp/index.js（client 端）**
- shell pipeline 改寫：每個關鍵 step（fetch / pull / npm install / update.sh）顯式 echo fail marker（`__OM_PULL_FAIL__` 等）+ `exit 11..14`
- `git log HEAD..origin/main` 維持 `2>/dev/null` 防 stderr 污染 UPDATES 變數
- callback 不再寫死 `update_ok`，改三分支：
  - `update_applied` — 真有拉到新 commit + npm install + update.sh 都 OK
  - `update_clean` — 沒新版可拉（合法 no-op）
  - `update_failed` — 任一 step 失敗，details 含 step 名稱 + exit code（**不上傳完整 stdout/stderr，避免洩漏使用者本機 path**）

**hooks/ownmind-session-start.sh（client 端）**
- 對齊 mcp/index.js 修法：每個 step 用 `if ! ...; then log_event "update_failed" "step" "..."; exit; fi` 包起來
- 同樣三分支：`update_applied` / `update_clean` / `update_failed`

**Dashboard label（server 端）**
- `src/public/index.html` ZH 對應表加 `update_clean: '無新版'` + `update_failed: '升級失敗'`，避免 dashboard 顯示英文 raw key

**新增測試**
- `tests/p3-update-event-semantics.test.js`（11 個 source-grep assertions）：
  - mcp/index.js 不能再寫死 `update_ok`
  - mcp/index.js + hook 都必須有 `update_applied` / `update_clean` / `update_failed` 三條路徑
  - shell 內必須有 fail marker
  - dashboard 必須有對應中文 label
- 防退化：未來 reviewer 漏修任一支都會被 test 抓到（這次 review 就是這樣抓到 hook 漏修）

**對使用者**
- 升級到 1.17.16 後，dashboard 上「Audit Log」看到的事件名稱會更精確：實際升級成功才是「已更新」、沒新版是「無新版」、失敗是「升級失敗」+ 具體哪個 step 出錯
- Adam 場景：升 1.17.16 後就不會再看到「假陽性 update_ok」誤導你以為他升級成功

**為什麼 v1.17.15 的 fix 漏了 hook**：v1.17.15 只 review MCP 路徑，沒注意到 hook 有同款 pattern。本次 code review 階段被 superpowers code-reviewer 抓到。learning：未來 review 涉及自動更新邏輯時，必查 `mcp/` + `hooks/` + `scripts/` 三個地方的對偶實作。

**IR-022 server + client**：純 client 修（mcp/index.js + hooks + dashboard label）；server 無改動。

---

## v1.17.15 — 修 Windows pre-commit hook "Exec format error"（回報者 Eric）+ 修 verify-upgrade.sh server round-trip

**背景一：Eric 在 Windows 上 commit 時跳錯**
```
error: cannot spawn C:\Users\Eric\.ownmind\git-hooks/pre-commit: Exec format error
```

OwnMind 的 git hook 安裝邏輯有三個累積問題：
1. **install.ps1 寫的 sh wrapper 缺 chain existing hooks 邏輯** — Mac/Linux 版有的 `git rev-parse --git-dir` 那段，Windows 版完全沒寫，導致 user 自己 repo 的 `.git/hooks/pre-commit` 被 OwnMind hook 完全覆蓋
2. **沒有 `.gitattributes` 強制 LF 行尾** — Windows checkout 時 `core.autocrlf=true`（Git for Windows 預設）會把 LF 轉 CRLF，shebang `#!/bin/sh\r` 找不到 `/bin/sh\r` → "Exec format error"
3. **沒偵測 `sh.exe` 是否可用** — VS Code 內建 git / WinGet `Microsoft.Git` / Scoop `git-with-openssh` 都不含 `sh.exe`；OwnMind 仍寫了 sh wrapper 出去 → 無法 spawn

**背景二：升級流程 server 驗測一直假性失敗**

`scripts/verify-upgrade.sh --server` 一直回 `write_failed`，但 server 正常。三個 bug 疊加：
1. 寫入前未呼叫 `/api/memory/init` 取 `sync_token`，被 server 409 拒絕（v1.17.0 開始強制）
2. 讀回用了不存在的 `GET /api/memory?include_test=true`（404）
3. `curl -sf` 在 4xx 靜默失敗，錯誤訊息誤導為「API_KEY 過期或 server 500」

**修正**

**Windows hook 安裝（client 端）**
- `.gitattributes` **新增**：強制 `*.sh` / `hooks/ownmind-git-{pre,post}-commit` / `git-hooks/{pre,post}-commit` 等檔案 `eol=lf`，根本解 CRLF 污染
- `install.ps1`：
  - 新增 `Copy-AsLf` helper：從 source 讀 bytes、過濾 `0x0D` (CR)、無 BOM 寫出（雙重保險）
  - 新增 `Test-ShAvailable` helper：偵測 `sh.exe` 是否在 PATH 或 Git for Windows 典型路徑（`usr\bin\sh.exe`）
  - hook 安裝改為 **直接 copy source**（`hooks/ownmind-git-pre-commit`），不再 inline 生簡陋版 → 自動帶 chain existing hooks 邏輯，與 Mac/Linux 對齊
  - 偵測不到 `sh.exe` 時 fail-fast：明確指出常見原因 + 解法（裝 Git for Windows）+ 跳過 hook 安裝以免壞所有 commit

**verify-upgrade.sh（client 端）**
- `--server` 模式：寫入前先 `GET /api/memory/init?compact=true` 取 `sync_token`，塞進 POST body
- 讀回改用 `GET /api/memory/:id`（從 write response 取 id），不再打不存在的 list endpoint
- `curl -sf` 改 `curl -s` + 捕捉 HTTP code，失敗時顯示實際 server 回應 + body 前 200 字
- 鐵律 digest 檢查改重用 step 2 的 init response，省一次 round-trip

**驗證**
- Mac 端 `bash verify-upgrade.sh --local / --server / --cleanup` 三模式全綠
- Windows 端待 Eric 重跑 `iwr .../install.ps1 | iex` 後實測 commit 不再爆

**為什麼選「fail-fast 而非自動裝 Git for Windows」**：Git for Windows 是大型 installer (~50MB)，沒有可靠的 silent install 流程；明確訊息 + 文件指引比黑魔法更符合「使用者零負擔」原則。

**IR-022 server + client 兩端**：純 client 修（install.ps1 + verify-upgrade.sh + .gitattributes）；server 無改動。

---

## v1.17.14 — Tier 2 (Cursor / Antigravity / OpenCode) Windows 支援（v1.17.12 留的 Tier 2 債）

**背景**：v1.17.12 修好 Windows 主線 Tier 1（Claude Code / Codex）usage scanner 的 BOM root cause，但 Tier 2（Cursor / Antigravity / OpenCode）Windows 仍永遠無法收集 session 計數。原因：
1. `opencode.js` 沒 win32 path branch — `DEFAULT_DB` 硬寫 POSIX `.local/share/opencode/`
2. `vscode-telemetry.js` + `opencode.js` 都靠 `sqlite3` CLI，Windows 預設沒裝 → ENOENT 直接 skip

**修正**

**Scanner adapter**
- `shared/scanners/opencode.js`：新增 `DEFAULT_DB_PATHS = {darwin, linux, win32}`，Windows 指向 `AppData/Roaming/opencode/opencode.db`
- `shared/scanners/vscode-telemetry.js`：ENOENT 錯誤訊息加具體裝法（`winget install` / `apt install` / sqlite.org URL）
- `shared/scanners/opencode.js`：同上 actionable error

**Install 腳本自動裝 sqlite3**
- `install.ps1`：偵測到沒 sqlite3 → 嘗試 `winget install --id SQLite.SQLite --scope user --silent`（Win10 1809+ 內建 winget）。失敗 fallback 印清楚手動裝法
- `install.sh`：新用戶偵測沒 sqlite3 → 按 OS 印正確裝法（Linux `apt install`、Mac `brew install`、Windows 轉 install.ps1）
- Mac 多半內建，所以只對真正缺少的平台 warn

**新增測試**
- `tests/tier2-windows-fix.test.js`（8 tests）— opencode win32 path + install 腳本 sqlite3 偵測 + actionable error 訊息
- 全 suite 566/566 綠

**對使用者**
- 新 install：Windows 端執行 install.ps1 會自動裝 sqlite3（winget 成功率高），只需重開 terminal 讓 PATH 生效。下次 scanner 跑就能收 Tier 2 data
- 已裝使用者：跟 AI 說「升級 OwnMind」或手動跑 install.ps1 / install.sh，scanner 下次 30 分鐘 trigger 就會順便用上 sqlite3

**為什麼不 bundle sqlite3.exe 進 repo**：binary (~1.5MB) 放版控不理想；winget 是 Windows 官方認可的 install 路徑、user 事後也可用同一條指令更新 sqlite，可維護性最好。

**IR-022 server + client 兩端皆觸及**：純 client 修（scanner adapter + install scripts）；server 無改動。

---

## v1.17.13 — 修 session_log 寫讀不一致（回報者 Michelle）

**背景**：Michelle 用 `ownmind_log_session` 寫入 id=221 後，用 `ownmind_get("session_log")` / `ownmind_search` 試搜 `ai_kol` / `Selenium` / `趨勢` 全部回空。追查發現**單一 root cause，兩個症狀**：

| 動作 | 實際操作 |
|---|---|
| `ownmind_log_session` 寫入 | → `INSERT INTO session_logs`（獨立表） |
| `ownmind_get("session_log")` 讀 | → `SELECT FROM memories WHERE type='session_log'` |
| `ownmind_search` 搜 | → `SELECT FROM memories WHERE content/title ILIKE` |

寫 A 讀 B — 兩個 get 都永遠 miss 剛寫的 session_log。

**修法**（server + MCP 端分叉整合，不動 `session_logs` 表避免 migration）

**Server — `src/routes/session.js` + 新 `src/lib/session-query.js`**
- `GET /api/session/recent` 加 `?q=` 參數，ILIKE search `summary` + `details::text`（Michelle 那類 session-topic 搜尋）
- SQL builder 拆成純函式 `buildSessionRecentQuery`，新 `tests/session-recent-query.test.js` 9 tests 守住

**MCP — `mcp/index.js`**
- `ownmind_get('session_log')`：偵測到 type 轉呼 `/api/session/recent?days=30&include_compressed=true`（讀到剛寫的 session_logs 內容）
- `ownmind_search`：`Promise.all` 同時查 `/api/memory/search` + `/api/session/recent?q=` → 合併成單一 `data` 陣列，session_logs 項目標 `_source: 'session_logs'` + `type: 'session_log'` 方便區分。新回應含 `memory_hits` / `session_hits` 計數給 AI 看清楚

**對 Michelle / 所有使用者**
升 v1.17.13 後下次 `ownmind_search "ai_kol"` 會同時搜 memories + session_logs，她的 session id=221（summary 含 ai_kol）會現身。`ownmind_get("session_log")` 會列最近 30 天的 session 紀錄。

**為什麼不動 `session_logs` 表**：activity / weeklyReport / report 都依賴此表 schema，migrate 進 memories 會 cascading break。MCP 端分叉是最小風險路徑。

**IR-022 server + client 兩端皆觸及**：server 端 query + route；MCP 端 tool handler 分叉。

**新增測試**：`tests/session-recent-query.test.js`（9 tests），全 suite 558/558 綠。

**未修（留 v1.17.14 或以後）**
- 🟡 Tier 2 (Cursor / Antigravity / OpenCode) 在 Windows 預設沒 `sqlite3` CLI 失敗 — 只影響 session_count 計數，不影響 Tier 1 token 統計

---

## v1.17.12 — 修 Windows usage scanner 全體卡關的 root cause（回報者 Vin observes）

**背景**：Admin 後台「團隊用量排行榜」顯示 Mac 使用者 ×2（Vincent, Michelle）用量正常，Windows 使用者 ×4（Sunny, Adam, Eric, pitt）**全部 0**。Eric 的 Task Scheduler 明明已排程，為何用量還是 0？Codex adversarial review 找到 smoking gun：

**Root cause — `install.ps1` 寫 BOM-prefixed settings.json**

PS 5.1 的 `Set-Content -Encoding UTF8` 在 Windows 10 預設環境會加 UTF-8 BOM (`EF BB BF`)。Node.js 的 `JSON.parse('\uFEFF{...}')` 直接 throw SyntaxError。

結果鏈式反應：
1. `shared/helpers.js` 的 `readCredentials()` catch 後回空字串
2. `hooks/ownmind-usage-scanner.js:97-100` 偵測 creds 空 → 立刻 log "credentials not found; skipping" + exit
3. 沒 heartbeat 送 → Admin 看到「未裝」
4. 沒 event 送 → 用量全 0
5. MCP server 啟動時同樣 readCredentials → MCP crash → 沒 MCP startup heartbeat

諷刺的是：`scripts/windows/register-scanner-task.ps1:64-69` 已經明註「避開 PS 5.1 UTF-8 BOM」用 `WriteAllText` 寫 `.node-path`，但 `install.ps1` 寫 settings.json 沒做同樣防護。Mac `install.sh` 走 heredoc 不帶 BOM，所以完全不受影響。

**修正 — Defense in depth**

**A. `install.ps1`：全面改用 `Write-Utf8NoBom` helper**
- 新增 helper：`[System.IO.File]::WriteAllText(..., new UTF8Encoding $false)` 明確指定 no-BOM
- settings.json（3 處）/ CLAUDE.md（2 處）/ Cursor mcp.json（2 處）/ git hook shell wrapper（2 處）全部改寫

**B. `shared/helpers.js`：`readCredentials` / `readJsonSafe` / `getClientVersion` 都 stripBom**
- 現有已中招的 Windows 使用者**不用重裝**；下次 scanner 跑 → readCredentials 能 parse → 開始送 heartbeat/event
- 未來再出現 BOM 污染（編輯器/其他 tool）也會被吸收

**C. `install.ps1`：註冊 Task Scheduler 後驗證 `$LASTEXITCODE + Get-ScheduledTask`**
- Adam 當時 Duration bug，`Register-ScheduledTask` 失敗但 install 印「已註冊」silent lie
- 現在失敗會清楚顯示 `(exit=N, task_exists=False)` + 給 debug 指令

**新增測試**
- `tests/credentials-bom-safe.test.js` — readCredentials / readJsonSafe BOM tolerance（6 tests）
- `tests/install-ps1-no-bom-outputs.test.js` — install.ps1 禁用 Set-Content 寫敏感檔（3 tests）
- `tests/install-ps1-scanner-task-check.test.js` — install.ps1 驗證 scanner task 真的註冊（1 test）
- 全 suite 549/549 綠

**對 Eric/Adam/Sunny/pitt**
升到 v1.17.12：
```
cd ~/.ownmind
git pull
cd mcp && npm install  # 新 readCredentials 生效
cd .. && powershell -ExecutionPolicy Bypass -File scripts\windows\register-scanner-task.ps1
```

或跟 AI 說「升級 OwnMind」（走 interactive-upgrade.ps1 全部做完）。

升級後下次 scanner 30 分鐘觸發就會正常送 heartbeat + event，Admin 裝機狀況 + 用量排行榜都會有數字。

**IR-022 server + client 兩端皆觸及**：純 client 修（helpers.js + install.ps1），但 bootstrap route 會 serve 給 `iwr|iex` 使用者，server deploy 後才吐新版。

---

## v1.17.11 — Task Scheduler Duration 再調小（回報者 Eric）

**背景**：v1.17.10 把 `RepetitionDuration` 從 `[TimeSpan]::MaxValue` 改成 `36500 天（100 年）`，以為解決了問題。Eric 實測回報：

> Task Scheduler：原本註冊 P36500D（100 年）超出 Windows 允許範圍失敗，但已自動 fallback 成「每 30 分鐘觸發」，功能正常

意思是 Task Scheduler COM 底層 validator 還是 reject 了 36500 天，吐 warning 再 fallback。功能沒斷但 warning 嚇人。

**Root cause**：Windows Task Scheduler COM validator 對 `RepetitionDuration` 有上限 **約 9999 天（~27 年）**，超過就 warn。`[TimeSpan]::MaxValue` / `36500 天` 都踩線。

**修正**
- `scripts/windows/register-scanner-task.ps1`：`-RepetitionDuration (New-TimeSpan -Days 36500)` → `-RepetitionDuration (New-TimeSpan -Days 9999)`（PowerShell 社群公認的 safe-forever 值）
- `tests/scheduled-task-duration.test.js`：把允許範圍改為 `1000 <= Days <= 9999`，避免以後又手滑設太大

**對使用者**
升到 v1.17.11 跑 `register-scanner-task.ps1` 就沒 warning 了。已有安裝的直接跟 AI 說「升級 OwnMind」或手動重跑：
```powershell
cd $HOME\.ownmind
git pull
powershell -ExecutionPolicy Bypass -File scripts\windows\register-scanner-task.ps1
```

---

## v1.17.10 — 修 v1.17.9 遺漏的三個 Windows 安裝警告（回報者 Adam）

**背景**：Adam 裝完 v1.17.9 回報三個警告。檔案都在（驗證通過），但警告嚇人且暴露三個真 bug：
1. **`Copy-Item cannot overwrite with itself ×4`** — install.ps1 把 `$OwnmindDir\shared\verification.js` 複製到 `$HOME\.ownmind\shared\`，但 `$OwnmindDir` 本來就是 `$HOME\.ownmind`，等於自己複製到自己。git hook JS 檔（3 個）同樣問題。install.sh 用 `-ef` 檢查 inode 避開，install.ps1 漏做
2. **`Register-ScheduledTask Duration 格式錯誤`** — `[TimeSpan]::MaxValue` 在某些 Windows build 超出 Task Scheduler 可接受範圍，整個 task 註冊失敗 → usage scanner 排程沒上 → heartbeat 每 30 分鐘送不出去（只剩 MCP startup heartbeat 能送）
3. **`首行 BOM 字元被誤解讀為命令`** — `iwr -useb bootstrap.ps1 | iex` 時，response 首字 `\uFEFF` 被 iex 當 cmdlet 呼叫，吐「不是有效命令」warning。雖無害但會嚇到使用者以為安裝失敗

**修正**
- `install.ps1`：新增 `Copy-IfDifferent` helper，用 `[System.IO.Path]::GetFullPath` 比對解析後路徑，同位置就 skip。verification.js + 3 個 git hook JS 全改用此 helper
- `scripts/windows/register-scanner-task.ps1`：`-RepetitionDuration ([TimeSpan]::MaxValue)` → `-RepetitionDuration (New-TimeSpan -Days 36500)`（100 年，符合 Microsoft docs 建議）
- `src/app.js`：新增 `stripBom` helper，boot 時 strip bootstrap.sh / bootstrap.ps1 的首字 `\uFEFF`；磁碟上檔案仍保留 BOM（`powershell -File` 讀檔路徑還是需要）

**新增測試**
- `tests/install-ps1-copy-safety.test.js` — 靜態檢查 install.ps1 有 self-overwrite guard
- `tests/scheduled-task-duration.test.js` — 靜態檢查不再用 `[TimeSpan]::MaxValue`，改用有限大值
- `tests/bootstrap-strip-bom.test.js` — 靜態檢查 src/app.js 有 stripBom 且磁碟 bootstrap.ps1 仍有 BOM
- 全 suite 539/539 綠，零 regression

**Adam 實測驗證**
裝完 v1.17.10 應該三個警告全消失；usage scanner 排程 30 分鐘會正常執行 → `collector_heartbeat` 更新 → Admin 「裝機狀況」看得到。

**IR-022 server + client 兩端皆觸及**：server 改 `src/app.js` serve 邏輯（需 deploy）；client 改 install.ps1 + register-scanner-task.ps1。

---

## v1.17.9 — 修 Windows 兩個獨立問題（回報者 Eric + Adam）

**背景 #1（Eric）**：Windows PowerShell 5.1（Windows 10 預設）讀 `.ps1` 時用系統 codepage（繁中 Windows 是 CP950）而非 UTF-8，中文字節被誤解讀，部分序列撞到 PowerShell 保留字元（反引號、引號）造成 parser 失敗。PowerShell 7+ 沒事，但不能預期每個使用者都升 pwsh。

**背景 #2（Adam）**：從 Git Bash / MSYS 呼叫 `install.ps1` 時，`$HOME` 被污染成 POSIX 格式 `/c/Users/Adam`，跟 Windows path 串接後變 `C:\c\Users\Adam\.gemini\settings.json.tmp` 怪路徑（多了一層 `c\`），node 寫檔到錯地方，設定檔全寫到不存在的目錄。另外 Adam 的 `install.ps1 --update` 走了舊版路徑，`--update` 被當成 API key。

**修正 #1 — UTF-8 BOM**
- `install.ps1` / `scripts/bootstrap.ps1` / `scripts/interactive-upgrade.ps1` / `scripts/windows/register-scanner-task.ps1` 全部加上 UTF-8 BOM（`EF BB BF`）
- 對 PowerShell 7+ 是 no-op，對 5.1 強制走 UTF-8 路徑

**修正 #2 — 環境正規化 preamble**
- 每支 `.ps1` 開頭加：
  ```powershell
  if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
    Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
  }
  ```
- 保證無論從哪個 shell 呼叫，`$HOME` 一律指向 Windows 格式 `C:\Users\xxx`，`Join-Path $HOME ...` 不再被 POSIX 路徑污染

**修正 #3 — install.ps1 flag 過濾**
- `$args` 在進位置參數前先過濾掉開頭 `-` 的項（`--update` / `-u` 等）
- 即使舊版 interactive-upgrade 還傳 `--update`，也不會被當成 API key 寫進 MCP config

**新增測試**
- `tests/ps1-utf8-bom.test.js` — 全 repo .ps1 必須以 UTF-8 BOM 開頭（含中文才檢查）
- `tests/ps1-windows-compat.test.js` — 4 支 .ps1 都有環境正規化 preamble；install.ps1 有 flag 過濾

**對已卡住的使用者**
腳本失敗已經自動還原舊版的話，一次性重裝最乾脆：
```powershell
Remove-Item -Recurse -Force $HOME\.ownmind
$env:OWNMIND_API_KEY='你的 key'
$env:OWNMIND_API_URL='你的 API URL'
iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
```
Bootstrap 會抓到含 BOM + 環境正規化 + flag 過濾的 v1.17.9 乾淨 clone，之後升級自動走新路徑。

**IR-022 server + client 兩端皆觸及**：純 client 端修 — 但因 bootstrap route（v1.17.6 加的 public endpoint）會 serve `bootstrap.ps1`，server deploy 後使用者 one-liner 才會抓到 BOM 版。

---

## v1.17.8 — 本地記憶雲端 delta sync（A+C 方案）

**背景**：`~/.claude/projects/<slug>/memory/*.md` 是 Claude Code 每次 session 載入的 auto-memory，但這些檔案是一次性快照。當 Vin 用 `ownmind_save` 或 Admin UI 更新雲端記憶後，本地 md 不會自動刷新 — SessionStart 把過期的 MEMORY.md 當 context 餵給 AI，AI 根據 24 天前的快照下結論（實際案例：把 P2-P5 roadmap 當最新待辦，但雲端主線早已換成 token-usage-tracking）。

**新增（Server）**
- `src/lib/memory-sync.js` — 純函式：`parseSyncTypes` / `parseSince` / `buildSyncQuery`，可單元測試
- `src/routes/memory.js`：新增 `GET /api/memory/sync?types=iron_rule,project,feedback&since=<ISO>`
  - `types` 白名單過濾（只允許 iron_rule / project / feedback — 過期最痛的三類）
  - `since` 省略 → 只回 active（首次同步用）
  - `since` 帶上 → 回 `updated_at > since OR disabled_at > since`（含 tombstone）
  - 回傳 `{server_time, memories: [...]}`
  - 用 `ANY($2::text[])` 防 SQL injection

**新增（Client）**
- `hooks/lib/sync-memory-files.js` — Node script，stdin 吃 JSON 後：
  - 解出 `<memoryDir> = $HOME/.claude/projects/<CLAUDE_PROJECT_DIR slug>/memory/`
  - 首次若有手寫 MEMORY.md → 備份到 `MEMORY.md.pre-sync-backup-<ts>`
  - 寫 `<type>_<id>_<slug_title>.md` 含 frontmatter（name / description / type / cloud_id / updated_at）
  - `status='disabled'` 或本地 orphan（不在 active 集合）→ 刪掉
  - 重算 MEMORY.md：auto-sync marker + 按 type 分組 + 每行 `— updated YYYY-MM-DD`（C 部分 staleness badge）
  - `--fail` 模式：在 MEMORY.md 頂端插「⚠️ last sync FAILED」警告但不刪檔；連續 fail 不堆疊警告
- `hooks/ownmind-session-start.sh`：init API 之後串 sync endpoint + 呼叫 node script（fail-silent、不阻塞 session）

**測試**
- `tests/memory-sync-endpoint.test.js`（16 tests）— parser / query builder / whitelist / SQL shape
- `tests/sync-memory-files.test.js`（19 tests）— slugify / filename / 首次寫入 / 備份機制 / tombstone / fail mode / 二次 re-sync
- 全 suite 518 tests 綠，零 regression

**IR-022 server + client 兩端皆觸及**：server 是新 `/sync` endpoint + 純函式 lib；client 是新 node script + 改 shell hook。

**使用者零操作**：升到 v1.17.8 後下一次開 Claude Code session 自動同步。SessionStart 失敗或 server 連不上時用本地舊版但會在 MEMORY.md 插警告，AI 自己看得到「local 可能過期」。

---

## v1.17.7 — MCP 技巧提示每次都顯示（對齊 skill 文件承諾）

**背景**：skill 文件 `ownmind-memory.md` 寫「MCP tool 每次回傳自動附上一行隨機小技巧」，但 `mcp/index.js:996` 實際上用 `if (++tipCallCount % 10 === 1)` 每 10 次才顯示 1 次。文件 vs 實作不一致被 Vin 抓到。

**修正**
- `mcp/index.js`：拿掉 `tipCallCount` + modulo gating，每次 tool call 的 response 都會附 `【OwnMind vX.X.X】技巧提示：...`
- 現在用戶每次呼叫 MCP tool 都會看到一條隨機小技巧（從 50+ 條 TIPS 池裡隨機挑，避開上一次選過的）

**新增測試**
- `tests/tip-every-call.test.js`：靜態檢查 `mcp/index.js` 不再含 `tipCallCount % 10` gating，且 `contentParts.push(...技巧提示...)` 呼叫沒有被 modulo 條件包住

**為什麼不吵**：隨機 TIP 池有 50+ 條，每次挑一條又避開上次選過的，實際體驗是「每次都有小教學」而不是「同樣提示不停冒出」。

---

## v1.17.6 — Universal Bootstrap（一句指令搞定安裝/升級/修復）

**背景**：之前 install / upgrade 分成 4 支腳本（`install.sh` / `install.ps1` / `interactive-upgrade.sh` / `interactive-upgrade.ps1`），user 得自己判斷跑哪一支；新用戶更慘，完全不知道從哪開始。跨平台（Windows vs Mac）又多一層分岔。

**新增**
- `scripts/bootstrap.sh` + `scripts/bootstrap.ps1`：單一入口，自動三分支處理
  1. `~/.ownmind` 不存在 → `git clone` + `install.sh/.ps1`（轉發 `$@` / `@args` 作為 API_KEY / API_URL）
  2. 存在但不是 git repo（壞掉）→ 備份到 `~/.ownmind.broken.<timestamp>` + 重 clone + install
  3. 是 git repo（正常）→ 轉交 `interactive-upgrade.*`
- Express 新增 public routes：`GET /bootstrap.sh` + `GET /bootstrap.ps1`（不需 auth，給新機器用；boot 時 `readFileSync` 進記憶體，零 disk I/O per request）
- `skills/ownmind-upgrade.md` 擴充：新觸發詞「裝」「重裝」「修」「OwnMind 壞了」「install」「repair」；新 Mode D 合併進 Mode B 統一走 bootstrap

**修正（pre-existing bug，被 bootstrap 的升級路徑暴露出來）**
- `scripts/interactive-upgrade.ps1` 原本呼叫 `install.ps1 --update`，但 `install.ps1` 沒有 `--update` 參數 — 它會把 `--update` 當成 `$args[0]` (API_KEY)，Windows 升級 silent mis-config。現在改成和 bash 版一致：從 `~/.claude/settings.json` 讀 credentials，以 positional args 傳給 `install.ps1`。

**硬化（Codex review 建議）**
- `bootstrap.sh` 加 `set -o pipefail`，避免 `git clone | while read` 遮蔽 git 失敗
- `bootstrap.ps1` branch 2（壞掉修復）clone 後加 `$LASTEXITCODE` + `.git` 驗證（branch 1 本來就有）
- `src/app.js` 拿掉 `sendFile` 的 `dotfiles: 'allow'`，改為 boot 時一次 `readFileSync` 到記憶體並從 buffer 回應

**使用方式 — 任何平台、任何狀態**

對 AI 說一句：
- 「升級 OwnMind」 / 「裝 OwnMind」 / 「修 OwnMind」 / 「OwnMind 壞了」

AI 自動偵測 OS + 狀態後執行正確動作。

**或命令列 one-liner（不靠 AI）**

Mac / Linux / Git Bash（**已安裝、只升級**）：
```bash
curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash
```

Mac / Linux / Git Bash（**首次安裝**，要提供 API key + URL）：
```bash
curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash -s -- YOUR_API_KEY YOUR_API_URL
```

Windows PowerShell（**已安裝、只升級**）：
```powershell
iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
```

Windows PowerShell（**首次安裝**）：
```powershell
$env:OWNMIND_API_KEY='YOUR_API_KEY'; $env:OWNMIND_API_URL='YOUR_API_URL'; iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
```

**新增測試**
- `tests/bootstrap-script.test.js`：靜態檢查兩支 bootstrap 腳本的三分支、+x bit、logging 格式、curl-pipe 安全性
- `tests/bootstrap-routes.test.js`：Express integration tests（ephemeral listen + fetch）驗證 public routes 無 auth 回對的 content-type + body

**IR-022 server + client 兩端皆觸及**：client 是兩支 bootstrap 腳本；server 是兩個 public routes + 修好的 `interactive-upgrade.ps1`。

---

## v1.17.5 — Heartbeat 雙層防護（Client once-per-process + Server 30s rate-limit）

**背景**：v1.17.4 在 MCP server 啟動時加了 heartbeat 觸發。若某位使用者的 MCP 被配錯導致 crash-loop（啟動 → crash → 重啟），每次重啟都會發一次 heartbeat，理論上可以飆到每分鐘數十次。server 端 UPSERT 是 O(1) 不會炸，但 log 會被灌爆、DB 連線池壓力增加。

**修正（雙層 defense-in-depth）**

**A. Client 端：每個 MCP process 最多發 1 次 heartbeat**
- `mcp/index.js`：`sendMcpHeartbeat` 加 module-scope flag `heartbeatSent`。flag 設在 `await` 之前，所以平行/高速連續呼叫也會 short-circuit（不會競爭發多個 POST）。
- 副作用（好的）：v1.17.4 code review 的 M1「startup + ownmind_init 會 double-fire」自動解決 — startup 搶到 flag 後，ownmind_init 的呼叫直接 early return。

**B. Server 端：heartbeat UPSERT 在 30 秒內為 no-op**
- `src/routes/usage/events.js`：新增 `HEARTBEAT_RATE_LIMIT_SECONDS = 30` 常數。`writeHeartbeatIfPresent` 的 `ON CONFLICT ... DO UPDATE` 加 `WHERE collector_heartbeat.last_reported_at < NOW() - INTERVAL '30 seconds'` 子句。同一 (user, tool) 在 30 秒內重複收到 heartbeat，SQL 層直接不更新（單一 atomic query，無額外 round-trip）。即使 client 端 guard 失效，server 這層也擋得住。

**新增測試**
- `tests/heartbeat-once-per-process.test.js`：靜態檢查 `mcp/index.js` 有 module-scope flag + early-return guard + 設 flag 時序正確（必須在 await 之前）。
- `tests/heartbeat-rate-limit.test.js`：靜態檢查 `events.js` 的 UPSERT 含 WHERE 子句 + 命名常數（不是 magic number）。

**升級方式**
v1.17.4 → v1.17.5：跑 `bash ~/.ownmind/scripts/interactive-upgrade.sh` 或對 AI 說「升級 OwnMind」。Server 端需要 deploy（本版有 server code 改動）。舊版（< v1.17.4）使用者看到的 v1.17.4 廣播會把他們直接帶到 main 最新版（含本版修正），不需要另發廣播。

---

## v1.17.4 — MCP 啟動即發 heartbeat（自動安裝回報）

**背景**：v1.17.2 引入的 heartbeat 只在 `ownmind_init` 時觸發。只用 `ownmind_get` / `ownmind_save` 等工具、從不呼叫 init 的已安裝使用者，在 Admin 的「裝機狀況」永遠顯示「未裝」。

**修正**
- `mcp/index.js`：在 `new StdioServerTransport()` 之前加一行 `sendMcpHeartbeat()`。MCP server 每次啟動都 fire-and-forget 一次 heartbeat（不 await，不會 block 啟動）。UPSERT keyed by `(user_id, tool)`，重複呼叫只會刷新 `last_reported_at`，無害。
- 影響：所有支援 MCP 的 AI 工具（Claude Code / Cursor / Codex / Antigravity / OpenCode）啟動時自動回報 — 使用者無需手動動作。

**新增測試**
- `tests/mcp-startup-heartbeat.test.js`：靜態檢查 `mcp/index.js` 源碼，確保 top-level `sendMcpHeartbeat();` 呼叫存在於 `await server.connect(transport)` 之前。

**升級方式**
舊版（≤ v1.17.3）使用者跑一行指令即可：
```bash
bash ~/.ownmind/scripts/interactive-upgrade.sh
```

---

## v1.17.3 — MCP 支援多 AI 工具識別（OWNMIND_CLIENT_TOOL env var）

**背景**：v1.17.2 的 MCP heartbeat 把 `tool` hardcode 成 `claude-code`，導致 Cursor / Codex / Antigravity / OpenCode 等用戶用 MCP 時會被誤標為 claude-code，污染 dashboard 的 per-tool 統計。

**新增**
- `mcp/index.js`：新增 `CLIENT_TOOL` 常數，從 `OWNMIND_CLIENT_TOOL` 環境變數讀取，預設 `claude-code`。影響兩處：
  - `callApi` header `x-ownmind-tool`
  - `sendMcpHeartbeat` 的 `heartbeat.tool`
- **設定方式**：非 Claude Code 用戶在他們的 MCP config 加環境變數：
  ```json
  { "env": { "OWNMIND_CLIENT_TOOL": "cursor" } }
  ```

---

## v1.17.2 — 廣播強制通知 + 新用戶 onboarding + MCP heartbeat + 版本檢查閉環

**本版包含四個方向的強化：**

### 1. 廣播強制通知（防止 AI 靜默略過）

**背景**：廣播通知系統原本靠 `configs/CLAUDE.md` 指示 AI 顯示，但 AI 可以忽略。IR-027 要求「提醒無效，邏輯才有效」—用程式強制觸發。

**新增**
- `hooks/lib/render-session-context.js`：當渲染的廣播中有 `severity='warning'/'error'` 或 `type='upgrade_reminder'` 時，動態注入 `[SYSTEM] 強制行動要求` instruction block，強制 AI 在第一句回應中主動告知使用者。INFO 廣播維持被動顯示。
- `configs/CLAUDE.md`：新增「廣播通知處理規則」區塊，定義各 severity 的 AI 行為規範。
- `tests/session-start-render.test.js`：新增 4 個 TDD 測試（warning、error、upgrade_reminder、info 各一）。

### 2. 新用戶自動 Onboarding

**背景**：新用戶第一次 `ownmind_init` 時 profile/principles/iron_rules 全空，API 只回傳版本資訊，AI 沒辦法主動引導。

**新增**
- `src/utils/onboarding.js`：`buildOnboarding({ hasAnyMemory, onboardingCompletedAt, tool })` 純函式，偵測是否為新用戶並回傳引導資料。
- `src/routes/memory.js`：`/api/memory/init` 新增 `_onboarding` 欄位；首次儲存任何記憶時自動寫入 `users.settings.onboarding_completed_at`（永久標記，防止刪光後被重新引導）。
- `mcp/index.js`：`callApi` 加 `x-ownmind-tool: claude-code` header；`ownmind_init` 偵測新用戶 flag 時注入 `_onboarding_instruction` 強制 AI 問名字/工作並建立 profile。
- `configs/CLAUDE.md`：新增「新用戶 Onboarding 規則」。

**修補的 bug**
- **Bug 1（誤判）**：偵測邏輯從「只看 profile/principle/iron_rule 三種」改為「查使用者有沒有任何類型的 active memory」（10 種類型全納入），避免只有 `coding_standard`/`project` 等記憶的老用戶被誤判。
- **Bug 2（重複觸發）**：新增 `users.settings.onboarding_completed_at` 永久標記，避免用戶刪光記憶後重新被引導。

### 3. MCP Heartbeat（裝機狀態感知）

**背景**：裝機狀態 dashboard 只看 `collector_heartbeat`（由排程 scanner 寫入），所以**只裝 MCP 沒跑 `install.sh`** 的用戶會錯誤顯示為「未裝」。

**新增**
- `mcp/index.js`：每次 `ownmind_init` 呼叫後 fire-and-forget 發 heartbeat（`tool=claude-code`, `scanner_version=CLIENT_VERSION`, `machine=hostname`）到 `/api/usage/events`。失敗靜默不阻塞 init。
- **效果**：只要用戶有啟動 AI 用 OwnMind，dashboard 就會自動顯示為「已裝」，不需額外跑排程。

### 4. 版本檢查閉環（三層 drift detection）

**Goal**：user 說「查版本」→ 三層完整檢查 → 有新版主動問是否升級 → 同意就一路跑完 interactive-upgrade.sh。

**新增**
- `scripts/check-sync.sh` — 三層 OwnMind 健檢腳本：
  - **L1 Remote**：`~/.ownmind` git HEAD vs origin/main（偵測 auto-update 沒拉到的情況）
  - **L2 Server**：client `package.json.version` vs server `server_version`（semver 比，pre-release 視為低於 stable）
  - **L3 Deploy**：比對 `~/.claude/hooks/*`、`~/.claude/hooks/lib/*.js`、`~/.claude/skills/ownmind-*/SKILL.md` 跟 `~/.ownmind/` source 是否 byte-identical（抓 user 忘記跑 `update.sh` 的情境）
  - 結構化 STDOUT（`L1_REMOTE:`、`L2_SERVER:`、`L3_DEPLOY:`、`L3_DRIFT_FILE:`、`OVERALL:`）供 skill 解析
  - 永不 exit != 0，錯誤走 `error` 標籤
- `skills/ownmind-upgrade.md` 擴充：
  - 加「模式 A 查版本」觸發詞（「查版本」/「版本多少」/「我的版本」/「版號」/「check version」）
  - 模式 A → call `check-sync.sh` → 解析三層 → 報告 user + 有 drift 主動問「要我幫你升嗎?」 → user 同意就導流模式 B
  - 模式 B（升級）與模式 C（snooze）保留原邏輯

**背景**：原本只靠廣播推 + 使用者主動說「我要升級」。現在加上 **user 主動查版本** 這個入口，且補上 **L3 deploy drift** 偵測（解決 `~/.ownmind` 已新但 `~/.claude/hooks/` 沒同步的盲區）。

**測試**：手動模擬 drift（改 1 byte） → L3 正確列出 drifted 檔案；復原 → OVERALL:in_sync。

---

## v1.17.1 — security patch + install.sh hotfix + npm audit 修復

### npm 依賴安全升級（2026-04-23）

- `path-to-regexp` → 8.4.2（修復高危 ReDoS，`npm audit fix` 自動處理）
- `node-cron` 3.x → 4.2.1（移除內嵌 uuid 依賴，解決 moderate ReDoS）
- `uuid` 13.x → 14.0.0（修復 buffer bounds check CVE）
- `npm audit` 結果：0 vulnerabilities

---

## v1.17.1 — security patch + install.sh hotfix

### 安全強化（五項）

**C2 — /setup SETUP_TOKEN 保護**：`/setup` 端點改為必須在 request body 帶 `setup_token`，server 端驗證與 `SETUP_TOKEN` 環境變數是否吻合。未設定 `SETUP_TOKEN` 則端點直接回 403，防止初裝窗口期被搶佔 super_admin。

**C3 — ENCRYPTION_KEY fail-fast**：啟動時若 `ENCRYPTION_KEY` 未設或為預設值，強制 `process.exit(1)`，防止靜默 fallback 導致 secrets 以公開金鑰加密儲存。

**C5 — Sync token 強制驗證**：寫入操作未帶 `sync_token` 改為直接回 409，要求先呼叫 `ownmind_init`，防止持有 API key 的攻擊者繞過 MVCC 保護靜默覆寫記憶。

**C6 — Rate limiting + CORS 收斂**：加入 `express-rate-limit`（auth 路由 10次/15分鐘，所有 API 200次/分鐘）；CORS 改為只允許 `CORS_ORIGIN` 環境變數指定的 origin，未設定則禁止跨域。

**U3 — 移除 session.js 死代碼**：`SENSITIVE_PATTERNS` array 從未被 `sanitize()` 使用且含誤導性寬泛 regex，一併移除。

### Hotfix

**install.sh — safe_cp 避免升級情境 `cp` 同檔案錯**：加 `safe_cp` helper 用 `-ef` 判 source/dest 是否同 inode，相同就跳過，修復升級時 macOS `cp` 回「identical」導致 rollback 的問題。

---

## v1.17.0（2026-04-22）— Client 版本 Dashboard、廣播通知、互動升級

**Bug**：升級既有 `~/.ownmind` 時，`install.sh` 多處 `cp $OWNMIND_DIR/X $HOME/.ownmind/X/` 源 == 目的路徑 → macOS `cp` 回 `... are identical (not copied).` → exit 1 → `interactive-upgrade.sh` 觸發 rollback → 客戶端無法升級（SessionStart hook 不會同步到 broadcast 檔案）。

**Fix**：
- `install.sh` 加 `safe_cp` helper：先用 bash `-ef` 判 source/dest 是否同 inode，相同就跳過
- 5 處會 same-file 失敗的 `cp` 改用 `safe_cp`（verification.js、git hook JS、scanner entry、scanner/shared 模組、scanner wrapper）
- 其餘 cp（複製到不同目錄）維持原狀

**測試**：實機重跑 `install.sh` 完整通過；`~/.claude/hooks/lib/` + `ownmind-session-start.sh` 新版都 deliver 到位。

---

## v1.17.0（開發中）— Client 版本 Dashboard、廣播通知、互動升級

> 讓 admin 一眼看到裝機版本、推播提醒，讓 user 說「我要升級」就有 AI 自動完成。
> Spec / Plan：`docs/superpowers/specs/2026-04-22-client-version-broadcast-upgrade-design.md`、`docs/superpowers/plans/2026-04-22-client-version-broadcast-upgrade.md`

### P5–P7 — 互動升級 Script + 驗測 + AI 工具 Skill 分發

**P5：Upgrade Script**
- `scripts/interactive-upgrade.sh` — 結構化 stdout（`INFO/OK/ERROR/ASK:<code>:msg`），AI 可逐行轉述
- `scripts/interactive-upgrade.ps1` — Windows PowerShell 版，同結構
- 流程：pre-check → backup → git pull --ff-only → npm install → install.sh（從 `~/.claude/settings.json` 讀 creds）→ 重註冊 launchd/systemd/Task Scheduler → 驗測 → 清理
- **失敗自動 rollback**：`~/.ownmind.bak.<timestamp>` → `~/.ownmind`（任何步驟失敗都還原，user 不會壞掉）

**P6：Verification Script + memories.is_test**
- `scripts/verify-upgrade.sh --local` — MCP / skill / hook / VERSION 存在性
- `scripts/verify-upgrade.sh --server` — `/health` ping → 寫測試 memory（`__upgrade_test__<ts>__<host>`）→ 讀回 → init API 鐵律 digest 檢查
- `scripts/verify-upgrade.sh --cleanup` — 清 `is_test=TRUE AND title LIKE '__upgrade_test__%'`
- `POST /api/memory` 新增 `is_test` 欄位，**只允許 `__upgrade_test__` 開頭 title**（防止 user 繞過 sync）
- `DELETE /api/memory/test-cleanup?name_prefix=__upgrade_test__` — 雙重保險（is_test=TRUE + title LIKE + user_id 隔離）

**P7：AI Tool Skills 分發**
- `skills/ownmind-upgrade.md` — Claude Code skill（觸發詞：「我要升級」/「升級 OwnMind」；錯誤碼引導表）
- `skills/ownmind-upgrade-agents-snippet.md` — 給 Codex / Cursor / Antigravity / OpenCode / Windsurf / Gemini 的通用規則片段
- `install.sh` + `scripts/update.sh` **偵測目錄存在才裝**，跳過未安裝工具；以 `<!-- ownmind-upgrade-rule -->` marker 包住，重跑時自動去重

**測試**
- `tests/memory-upgrade-test.test.js`（3 tests）：is_test guard、test-cleanup route 存在、user_id 隔離
- `scripts/interactive-upgrade.sh` 實機 smoke test：fail-safe rollback 驗證通過
- **458 tests pass**（P4 後 455 + P5-P7 新增 3）

### 驗證覆蓋
- 所有 10 個 spec scenarios（A-K）已涵蓋
- Codex adversarial review：P1 13 findings / P2 7 findings 全數修復

### Deploy 步驟（ship v1.17.0 時跑）
1. `psql -f db/008_broadcast.sql`（migration）
2. `docker compose build --no-cache`（IR-018 + IR-023）
3. Push + 部署 → 瀏覽器實測（IR-020）：裝機狀況 tab、廣播管理、發測試廣播 → user 端在 Claude Code / Codex / Cursor 應看到
4. `git tag v1.17.0`（IR-031）+ push tag

---

### P4 — MCP Response 注入（Layer 2：跨工具通用）

**新增 Server endpoint**
- `POST /api/broadcast/inject` — 每次 MCP `ownmind_*` tool call 時 ping
  - Upsert `user_tool_last_seen`（判首次 / 4h gap）
  - 判 `is_first_of_day`（Asia/Taipei day boundary）+ `is_long_gap`（> 4h）
  - `forceInject = isFirstOfDay || isLongGap`（覆蓋 cooldown）
  - 未 force 時走每則廣播的 `cooldown_minutes`
  - Mark `user_broadcast_state.last_injected_at` 防刷屏
  - Response：`{ broadcasts: [...], force: bool }`，MCP client 直接拿去 prepend

**MCP Client 改動**
- `mcp/index.js` CallToolRequestSchema handler 新增 `fetchBroadcastsSafely()`：
  - 每次 tool call 完 → POST `/api/broadcast/inject`
  - 2 秒 timeout、失敗靜默（不該因廣播掛掉 tool）
  - `renderBroadcasts()` → prepend 到 content parts 最前面
  - 舊版 MCP client 自動相容（不接 `_broadcast` 欄位也能看到，因為就是 text）

**行為**
- User 每天第一次 call ownmind → 一定看到廣播
- 上次 call 超過 4h（午休 / 過夜）→ 再次注入
- 同 session 狂 call → cooldown 擋住不刷屏
- 每則廣播有自己的 cooldown_minutes（升級提醒 30 分、一般 1440 分）

**測試**
- 新增 5 個 test 於 `tests/broadcast.test.js`：missing tool 400、first-of-day force、4h gap force、cooldown 擋注入、unauthenticated 401
- **455 tests pass**（P3 後 450 + P4 新增 5）

---

### P3 — Claude Code SessionStart Hook 讀廣播（Layer 1）

**新增**
- `hooks/lib/render-session-context.js` — 純函式 `renderSessionContext(data, broadcasts)`；拆出 render 邏輯方便 unit test
- `hooks/lib/session-start-output.js` — Node CLI 包裝，給 hook shell script 呼叫
- `hooks/ownmind-session-start.sh` — 新增 `curl /api/broadcast/active?tool=claude-code`（fail-silent 3 秒 timeout）；render 改呼叫 lib 模組

**行為**
- 每次 Claude Code session 啟動，hook 把當前應顯示的廣播 prepend 到 `additionalContext` 最前面（`## 📢 OwnMind 系統通知`）
- 廣播 render 包含：severity badge / title / body（截 400 字 / 5 行）/ CTA hint / snooze 選項
- 最多 3 則，其餘顯示「另有 N 則廣播未顯示」

**部署**
- `install.sh` + `scripts/update.sh` 同步 `hooks/lib/*.js` 到 `~/.claude/hooks/lib/`

**測試**
- 新增 10 個 test（`tests/session-start-render.test.js`）：無廣播、順序、CTA/snooze、超量截斷、多行折疊、memory sections、結尾訊息
- **450 tests pass**（P2 後 440 + P3 新增 10）

---

### P2 — 廣播系統 Backend + Admin CRUD

**新增**
- `src/lib/broadcast-filter.js`：`filterVisibleBroadcasts` + `filterInjectable` — 單一 filter logic，P4 MCP injection 也會共用
- `src/routes/broadcast.js`：
  - `POST /api/broadcast/admin`（super_admin）— 發布廣播
  - `GET /api/broadcast/admin?include_ended=true`（admin+）— 列表
  - `PATCH /api/broadcast/admin/:id`（super_admin）— 更新 ends_at / target_users
  - `DELETE /api/broadcast/admin/:id`（super_admin）— 撤銷（soft delete = ends_at=NOW()）
  - `GET /api/broadcast/active?tool=X`（all）— user 當下應看到的廣播（套 filter，不含 cooldown）
  - `POST /api/broadcast/dismiss`（all）— dismiss 或 snooze，allow_snooze=false 時只能 dismiss
- `src/jobs/nightly-upgrade-reminder.js`：每天 03:30 Asia/Taipei 跑 `ensureUpgradeReminder`；用 `max_version=${SERVER_VERSION}-prev` 搭配 pre-release semver 規則，讓只有落後的 client 收到提醒
- Dashboard「設定」tab 新增「廣播管理」sub-panel（super_admin only）：發布 / 列表 / 撤銷，auto-managed 項（升級提醒）不可手動撤銷

**決策**
- **Cooldown 不放在 /active 端點** — filter_visible 只做基本可見性檢查；cooldown 是 injection 時的「避免刷屏」策略，dashboard 查詢則應列出所有當下生效的廣播
- **撤銷 = soft delete**（`ends_at=NOW()`）— 保留歷史紀錄，避免誤刪；auto-managed 由 unique partial index 保證冪等

**測試**
- 新增 28 個 test（`tests/broadcast.test.js`）：validate payload、CRUD 權限邊界、snooze / dismiss 行為、filterVisibleBroadcasts semver filter、filterInjectable cooldown、ensureUpgradeReminder 冪等性
- **422 tests pass**（P1 後 394 + P2 新增 28）

---

### P1 — DB Migration + 裝機狀況 Dashboard

**資料層**
- `db/008_broadcast.sql`：4 張新表 — `broadcast_messages`、`user_broadcast_state`、`user_tool_last_seen`；`memories` 加 `is_test BOOLEAN` + partial index（升級驗測用，D16）
- Unique partial index `ux_broadcast_auto_upgrade` 保證自動升級提醒同版本只插一筆

**API**
- `GET /api/usage/admin/clients` — admin+；每 (user, tool) 最新 heartbeat 聚合 + needs_upgrade（semver 比對）+ status（active/stale/offline）+ coverage summary
- `src/utils/semver.js`：`parseSemver` / `compareSemver` / `isLower` / `isHigher` — 供 P2/P4 共用，避免散落多處

**Dashboard**
- 「設定」tab 下新增「裝機狀況」sub-panel（super_admin 可見）
- 一表看完：user / role / 整體狀態 / 各 tool 版本 + 相對時間（10 分鐘前 / 1 天前）
- Status 色碼：🟢 Active（24h 內）/ 🟠 Stale（24–48h）/ 🔴 Offline（>48h）/ 🟡 需升級 / ⚪ 未裝
- Coverage summary 文字：「共 N 人 · 已裝 X · active Y · stale Z · offline W · 未裝 M · K 人需升級」

### 測試
- 新增 10 個 test（`tests/clients.test.js`）：auth 權限、狀態分類、semver 升級判定、multi-tool 聚合、coverage 統計、排序規則
- **378 tests pass**（既有 368 + P1 新增 10）

### 決策摘要（spec 完整列表）
- **D2** 版本落後以 `scanner_version < SERVER_VERSION` 為準，null/unknown 一律視為舊版需升級
- **D14** 廣播後續採 main-response-text-prepend（P4），舊版 client 自動相容；P1 先鋪好 DB 欄位
- **D16** `memories.is_test` flag：升級驗測寫入的測試資料不進 sync、不 trigger alert（P6 用）

### 已知限制 / Deploy 注意
- SQL 未對 prod postgres 執行，deploy 時 `psql -f db/008_broadcast.sql` 手動驗證
- 前端 JS 暫仍靠 `renderOverallStatus` / `renderToolList` / `formatAgo` 在全域 scope；這是既有 index.html 的 pattern，未來拆 module 時一併處理

---

## v1.16.0 - Token 用量追蹤系統（全 9 phase）

> 跨 IDE token / 成本 / 工時追蹤，從 raw event 收集到團隊績效 dashboard 一條龍。
> Spec / Plan：`docs/superpowers/specs/2026-04-21-token-usage-tracking-design.md`、`docs/superpowers/plans/2026-04-21-token-usage-tracking.md`
> PR：#5

### 新增功能

**資料層**
- `db/007_token_usage.sql`：7 張新表 — `model_pricing`、`token_events`（含 `cumulative_total_tokens NOT NULL` 與 `codex_fingerprint_material JSONB`）、`token_usage_daily`、`collector_heartbeat`、`session_count`、`usage_tracking_exemption`、`usage_audit_log`；附 claude-code / codex 初始定價
- `src/utils/pricing-lookup.js`：`pickPricing` / `computeCost` / `lookupPricing` — effective_date 歷史版本查找，TZ-proof YYYY-MM-DD 比對，`id DESC` tiebreaker

**API**
- `POST /api/usage/events` — raw event ingestion（含 Tier 2 `sessions` array）
  - 必填驗證、model allowlist、D7 token_regression 偵測、UNIQUE dedupe、觸發 aggregation
  - Codex 專用：`codex_fingerprint_material` 必填 → server canonicalize → `expectedId` 強制覆寫；client id 錯誤寫 `fingerprint_mismatch`，ON CONFLICT 寫 `fingerprint_collision`
  - Heartbeat UPSERT（支援空 events + heartbeat-only）
  - Exemption 最早檢查、audit 壓制
- `GET /api/usage/stats`（個人）— 日期區間、group_by 日/工具/model/session，Tier-1 + Tier-2 合併，`is_exempt` flag
- `GET /api/usage/team-stats`（admin+）— coverage panel（`reporting_today` / `stale` / `opted_out` / `per_tool`）+ per-user aggregate
- `GET /api/usage/pricing`、`POST /api/usage/pricing`（super_admin, append-only）
- `usage_tracking_exemption` CRUD（super_admin），granted / reason_updated / revoked 三種 audit
- `GET /api/usage/admin/audit`（admin+，可 filter event_type）

**後端 Job**
- `src/jobs/usage-aggregation.js` — `recomputeDaily`：冪等；cost 採 null-on-any-unknown policy；wall / active seconds 以 Asia/Taipei 切日、600s gap 判離線
- `src/jobs/nightly-recompute.js` — 每日 03:00 Asia/Taipei 重算近 7 天（處理 pricing 變更 / 漏算）

**Client Scanner（5 個 IDE）**
- `shared/scanners/base.js` — 單一 `runScan` 流程（spec D11）：讀 offset → 分批 POST → 全部成功才原子寫回；失敗可無痛重送（server UNIQUE dedupe）
- `shared/scanners/id-helper.js` — Codex 專用 canonical material + SHA-256 message_id（64 hex，client + server 共用同一支）
- Tier 1：`claude-code.js`、`codex.js`（yyyy/mm/dd 遞迴）、`opencode.js`（sqlite3 CLI、composite `(time_created, id)` cursor）
- Tier 2：`cursor.js`、`antigravity.js` 共用 `vscode-telemetry.js`（state.vscdb）
- `hooks/ownmind-usage-scanner.js` — 主 entry；PID-aware 自我 lock（live/stale/6h mtime）；runtime opt-out flag

**Always-on 排程**
- `scripts/install-helpers/run-scanner.sh` — wrapper 動態找 node（`.node-path` → PATH → glob）+ v20+ 驗證
- macOS launchd plist（30 分鐘 + RunAtLoad）
- Linux systemd user timer（OnBootSec=5min + OnUnitActiveSec=30min）
- Windows Task Scheduler（PS 腳本，單一 Once+Repetition trigger，WriteAllText 無 BOM）
- `install.sh` / `install.ps1` 自動偵測 node、寫 `.node-path`、註冊 schedule；尊重 `~/.ownmind/.no-usage-scanner` opt-out

**Dashboard（Admin 後台）**
- 「我的用量」tab（所有 user）：日期區間 + group_by + 10 張 stat-mini 卡片 + bar chart + 追蹤狀態指示燈（`is_exempt` 警示）
- 「團隊用量」tab（admin+）：coverage panel 強制顯示，< 80% 自動浮水印「資料不完整」；排行榜可依 cost / 訊息 / 活躍時長排序
- Model 定價管理子面板（super_admin）：append-only 新增 effective_date row
- Audit log 子面板（admin+）：event_type filter、最近 100 筆

### 決策與鐵則

- **Client 只送 raw event**（D1）：Cost 100% server-side 算；client 的 `native_cost_usd` 僅供比對
- **Codex fingerprint**（D10 / D13）：完整 sha256 64 hex 不截斷（避免 `DO NOTHING` 永久丟資料）；server expectedId 為唯一 truth source
- **Cost null policy**：任何 unknown pricing → 整筆 cost_usd = null（不做 partial cost；codex review 修復過的 P2 bug）
- **Coverage gate**（D5）：團隊 dashboard < 80% 強制顯示「資料不完整」浮水印
- **透明 opt-out**（D3）：豁免由 super_admin 在 dashboard 操作，用戶看得到狀態；無 local opt-out sentinel

### 測試
**361 tests pass**（既有 165 + P1–P9 本次 196 個新測試）
- 單元：pricing-lookup、id-helper canonicalize / hash、aggregation（cost / wall / active）
- Route：events（exempt / codex / heartbeat / sessions / null-cost）、stats、team-stats、pricing、exemptions
- Scanner：base（atomic offsets / batching / crash-resume）、claude-code、codex、opencode、cursor/antigravity、run-scanner.sh wrapper（spawn bash + stub node）

### 已知限制（deploy / 觀察期再處理）
- 所有 SQL 尚未對真實 postgres 執行過；deploy 時以 `psql -f db/007_token_usage.sql` 驗證
- 5 個 scanner 未 end-to-end 打真實 server 跑整輪；Vin 本機試跑 P4（Claude Code）為首批
- launchd / systemd / Task Scheduler 三平台實機測試未做（plan P6 verify 條目）
- `stale_users` / `exempt_users` array 無長度上限（>50 人團隊需 cap）
- 24h–48h 灰區 user 不計入 reporting 也不計入 stale（寬鬆策略）
- 尚無 uninstall 腳本（launchctl unload + 刪 plist）

### 實作過程
分 9 phase 交付，每 phase 走完 IR-012 品管三步驟（verification + code review + receiving review），codex adversarial review 全跑完畢並修復：
- P1 DB schema + pricing API（`8ad2c63`）
- P2 ingestion + aggregation + personal stats（`b067d96`）
- P3 heartbeat + exemption + Codex fingerprint audit（`b9b7506`）
- P4 Claude Code scanner + runScan orchestrator（`e498f43`）
- P5 Codex + OpenCode scanners — Tier 1 完整（`2436a3d`）
- P6 always-on collector — P9 gate 解除（`025f8f9`）
- P7 Cursor + Antigravity Tier 2（`e0e15a9`）
- P8 + P9 個人 + 團隊 dashboard（`3584b53`）
- 修 codex review 4 個資料完整性 bug：Tier-2 session 合併、null-cost 傳遞（`ba4f671`）

---


## v1.15.4 - SessionStart 可靠觸發 + 鐵律顯著標記

### 修復
- `SessionStart` hook 過去未設 `matcher`，在 `resume`/`clear`/`compact` 情境下不穩定觸發，導致在新專案或恢復對話時 OwnMind 記憶沒有自動載入。`scripts/update.sh` 現在明確安裝 4 個 matcher（`startup`/`resume`/`clear`/`compact`），舊版安裝會自動 migrate
- `update.sh` 尊重用戶 opt-out：建立 `~/.ownmind/.no-session-hook` 檔案即可停用 SessionStart 自動安裝，避免下一次 `git pull` 又被加回來
- `update.sh` 的 `node -e` 錯誤改寫入 `~/.ownmind/logs/update-errors.log`，不再用 `2>/dev/null` 吞掉

### 改善
- 鐵律觸發 / 攔截 / 版號卡控訊息加上分隔線和醒目標記，並用「回應格式要求：AI 的第一行必須是...」取代較弱的「請複述」語氣，讓 Claude 更可靠地把 `【OwnMind vX.Y.Z】` 標記顯示給使用者
- `hooks/ownmind-iron-rule-check.sh` 追上 ESM 版的 commit-lean 行為：`commit` trigger 顯示一行摘要，`deploy`/`delete` 才顯示完整 banner，降低高頻 commit 的雜訊

---

## v1.15.3 - 權限與 batch sync 修正

### 修復
- `team_standard` 權限檢查從 `role !== 'admin'` 改為 `isAtLeast(role, 'admin')`，讓 admin 和 super_admin 都能新增/修改/停用/上傳團隊規範（原本 super_admin 反而被擋）
- `batch-sync-standard` 修正 SQL 參數錯位：原本參數陣列多傳一個 `'standard_detail'`，導致 6 個值對應 5 個 placeholder，欄位整體位移一格（title 被寫成 `'standard_detail'`、content 變成原本的 title）。同步寫入的 standard_detail 資料全部錯位 (#3)

---

## v1.15.2 - Version Unification

### 改善
- 版號統一為單一來源：所有元件從根目錄 `package.json` 讀取版號，消除多處寫死的版號不同步問題
- 版本比較修正：server 升級提示從字串不等於改為 semver 比較，client 版本較新時不再誤報需要更新
- Git tag 卡控：post-commit 提醒建立 tag、git push 前阻擋版號與 tag 不一致的推送
- `mcp/package.json` 版號改為 placeholder 並標記 `private: true`，防止誤發佈

---

## v1.15.1 - README 補齊 + 版號統一

### 改善
- README 補齊 v1.12.0~v1.15.0 漏掉的功能描述（multi-admin、auto-numbering、offline resilience、shared verification engine、L1 fail-closed、L2 commit blocking、cache auto-refresh、actionable failure messages、Team Standard RAG upload tools、standard_detail type、batch-sync API）
- MCP tools 數量從 12 更新為 15（新增 ownmind_upload_standard、ownmind_confirm_upload、ownmind_report_compliance）
- 版號統一：server package.json、mcp/package.json、git tag 三處同步

---

## v1.15.0 - Harness Engineering 審計修復

### Refactor
- **shared/helpers.js**: 新增共用工具模組，消除 hooks 間重複邏輯（readJsonSafe、getChangedSourceFiles、readCredentials、detectCommandTrigger、detectTriggerFromContext）
- **shared/compliance.js**: 統一 compliance log schema 和讀寫，砍掉 deriveEvent()
- **快取同步**: save/update/disable iron_rule 後自動刷新 iron_rules.json 快取
- **L1 fail-closed**: pre-commit hook 快取為空時嘗試 API 同步（3s timeout）
- **L2 commit blocking**: PreToolUse hook 對 commit 操作也跑 verification engine
- **L6 lazy load 修復**: auditSession() 改 async，確保 verification engine 已載入
- **觸發正則改進**: 加 word boundary、新增 git tag 和 Remove-Item、排除 docker compose logs 誤判
- **ESM 統一**: iron-rule-check.js 和 session-start.js 從 CJS 改為 ESM

---

## v1.14.0 - Offline Resilience

### 新增
- `mcp/offline.js` — Offline resilience helper（本地 cache 讀寫、write queue、本地搜尋）
- `ownmind_init`：將記憶快照寫入 `~/.ownmind/cache/memories.json`；重新連線時自動 replay 待寫佇列
- `ownmind_get`：伺服器無法連線時 fallback 至本地 cache
- `ownmind_search`：伺服器無法連線時 fallback 至本地字串搜尋
- `ownmind_save` / `ownmind_update` / `ownmind_disable`：伺服器無法連線時將操作寫入 `~/.ownmind/queue.jsonl`，下次成功 init 時自動 replay
- Offline 模式訊息：從 cache 或 queue 運作時顯示提示給 AI

### 測試
- 22 tests passing（17 offline helpers + 5 auto-numbering）

---

## v1.13.0 - Iron Rule Auto-Numbering

### 改善
- Server 端自動編號：新增 iron_rule 時若未帶 code，自動查最大編號 +1（格式 IR-XXX）
- 補齊 12 條既有缺編號的鐵律（IR-014 ~ IR-025）

### 新增檔案
- `src/utils/auto-numbering.js` — 自動編號 helper
- `tests/auto-numbering.test.js` — 自動編號測試
- `db/backfill-iron-rule-codes.sql` — 一次性補齊 SQL

---

## v1.12.0 - 多管理者管理介面

### 新增
- 三級角色階層：super_admin > admin > user
- super_admin 可新增/刪除 admin 帳號（含密碼）
- 操作稽核：所有 login/create/update/delete/password 操作寫入 audit_logs
- 改密碼功能：super_admin 可直接重設他人密碼；admin 需驗舊密碼
- 首次設定密碼流程：初始 super_admin 透過 `/setup` 完成設定後自動登入

### DB Migration
- `db/005_admin_roles_password.sql`：新增 password_hash、role 擴展至 super_admin、created_by/updated_by、audit_logs 表

### API 新增
- `POST /admin/setup` — 首次設定 super_admin 密碼（一次性，無需 auth）
- `POST /admin/users/:id/password` — 修改使用者密碼

### UI 改進
- 角色感知：super_admin 才看到刪除按鈕和 super_admin 角色選項
- 改密碼 Modal：super_admin 不需舊密碼，admin 需要
- 首次登入自動導向設定密碼流程

---

## v1.11.0 - Iron Rule Enforcement Engine P2+P3

### 新增
- Verification Engine：可驗證條件引擎，支援 AND/OR/when-then 條件組合
- 七層防禦架構：git pre-commit hook (L1)、PreToolUse hook (L2)、MCP 自動驗證 (L3)、Init 提醒 (L4)、post-commit 稽核 (L5)、Session 稽核 (L6)、升級警告 (L7)
- 規則模板庫：Server 端自動匹配，建立鐵律時自動填入驗證條件
- Session compliance tracking：合規事件寫入本地 JSONL，git hook 讀取驗證
- Dashboard 鐵律標記：可驗證鐵律顯示 [自動驗證] 標籤

### 改進
- IR-008 從硬編碼改為引擎驅動
- enforcement_alerts 查詢擴充，納入 session 稽核違規
- 安裝腳本自動設定 git hooks

### 遷移
- IR-008、IR-002、IR-012、IR-009 自動加上 verification 條件

---

## 2026-03-30 — v1.10.0 越用越聰明 + 數據驅動進化

### Windows 安裝修復（Eric 回報）
- **install.ps1 ParserError** — 移除 `param()` block 和 here-string `@"..."@`（`irm | iex` pipeline 不支援），改用 `$args` + array join
- **ENOENT 目錄不存在** — 提前用 `foreach` 建立 `~/.claude/`、skills、hooks 等所有目錄
- **curl vs PowerShell 衝突** — README 和 Dashboard 安裝指令改用 `irm | iex`（PowerShell 原生），不再使用 `curl`
- **bash 找不到** — 新增 `ownmind-session-start.js` + `ownmind-iron-rule-check.js`（純 Node.js hook），install.ps1 自動偵測 bash 並 fallback
- install.ps1 新增 `API_URL` 參數（與 install.sh 一致，不再 hardcode）
- **IR-008 智慧檢查** — PreToolUse hook 在 commit 時自動檢查 `git diff --cached`，如果有程式碼變更但缺少 README/FILELIST/CHANGELOG，直接列出缺失清單
- **月報 cron 時區修正** — 從 UTC 改為 Asia/Taipei，月報改為每月 1 號 00:00（原為 2 號）
- **Suggestions 自動執行** — 高頻建議（≥3 次）自動建立 principle 記憶（tags: suggestion-action），模式同 friction auto-create
- **Dashboard friction/suggestion 可點擊** — 點擊後搜尋相關記憶，顯示在 modal 中

### Adaptive Iron Rule Reinforcement（鐵律智慧強化）
- **enforcement_alerts** — init 時自動分析使用者 30 天內的違反歷史，產生分級提醒（critical/warning/notice）
- **跨 session 違反記憶** — 上一個 session 違反的鐵律，下一個 session 自動升級為 critical
- **漸進升級** — 同一條鐵律違反率越高，提醒語氣越強烈（數據驅動，所有使用者通用）
- **全端同步** — Server init + INSTRUCTIONS_SOP + MCP + SessionStart hooks + Skill + Dashboard + 週報

### 新功能
1. **週/月報 API** — `GET /api/session/report?period=week|month&offset=N`，即時計算或讀取快照
2. **週報 Cron Job** — 每週一 00:00 Asia/Taipei 自動執行，高頻 friction（≥3 次）自動建立 project 記憶
3. **月報 Cron Job** — 每月 2 號 00:00 Asia/Taipei 聚合月度數據
4. **Init API 擴充** — 每週第一次 init 回傳 `weekly_summary`（跨裝置共用 marker）
5. **Dashboard 週/月報頁籤** — friction 列表 + suggestions 列表，日期切換
6. **AI Skill 模式偵測** — 重複問題主動詢問、自動暫存 pending_review、SessionStart 週摘要

### Session 資料零丟失（三層防護）
7. **MCP Shutdown Handler** — SIGTERM/SIGINT 時搶救 emergency session log（本地 JSONL + best-effort server POST）
8. **Server Orphan Recovery** — init 時偵測上一次有 activity 但沒有 session_log，自動從 activity_logs 復原
9. **pending_review 自動確認** — 超過 7 天未確認的暫存記憶自動移除 pending 標記
10. **即時記錄原則** — Skill + INSTRUCTIONS_SOP 強化：不等 session 結束，每完成一段工作就記錄

### Bug 修復
- **team_standard 建立 500** — 生產 DB 缺少 `memories_type_check` constraint 中的 team_standard
- **Install prompt URL 暴露 /admin** — `getApiUrl()` regex 未處理 `/admin` 路徑
- **Compliance 回報延遲** — 改為即時 flush，不進 buffer；統一用 `report_compliance` 取代 rule_stats 搭便車

### 技術細節
- `src/utils/report.js`：純函式 computePeriodRange / groupFrictions / computeReportData
- `src/jobs/weeklyReport.js`：cron job（node-cron）
- `db/004_weekly_summary_marker.sql`：users.weekly_summary_sent_at
- `tests/report.test.js`：node:test 單元測試（12 cases）
- `mcp/index.js`：session 追蹤 + SIGTERM shutdown handler
- `mcp/ownmind-log.js`：signal flush + IMMEDIATE_FLUSH_EVENTS

---

## 2026-03-30 — v1.9.1 Activity Log + Dashboard + Compliance

### 新功能
1. **Activity Log** — 所有 OwnMind 事件記錄到本地 JSONL + 批次上傳到 server
2. **Admin Dashboard 統計頁** — 記憶概覽、工具/模型分佈、每日活動量、鐵律觸發 Top 5
3. **合規回報** — 新增 `ownmind_report_compliance` MCP tool，AI 觸發鐵律後自動回報遵守/跳過/違反
4. **交叉分析** — 落地率可按工具、模型、規則、使用者交叉查詢
5. **情境報告** — session log 支援結構化 details（project, actions, friction_points, suggestions）
6. **自動 Session Log** — instructions 指示 AI 對話結束前必須記錄摘要（所有工具通用）
7. **3 個月壓縮** — 超過 90 天的 session logs 自動合併成月摘要
8. **OWNMIND_TOOL 環境變數** — 各工具 MCP config 自帶工具識別
9. **i18n README** — 英文（預設）、繁體中文、日文三語切換

### 修正
- XSS 防護 — admin.html 所有動態內容加 escapeHtml
- 壓縮 race condition — 加 transaction + FOR UPDATE SKIP LOCKED
- ON CONFLICT 死 code 移除
- Shell hook JSON 轉義特殊字元
- timer.unref() 防止 Node.js 退出被阻塞
- details 展開覆蓋問題修正
- Stats query 加 LIMIT 防止大量數據

### 新增檔案
- `db/003_activity_logs.sql` — activity_logs 表
- `src/routes/activity.js` — batch upload + stats API
- `mcp/ownmind-log.js` — 本地 + server 雙寫 log 模組
- `docs/README.zh-TW.md` — 繁體中文 README
- `docs/README.ja.md` — 日文 README

---

## 2026-03-30 — v1.9.0 自動載入 + 跨平台 hooks + Token 優化

### 新功能
1. **SessionStart hook** — 每個新 session 自動載入記憶，不需手動呼叫 ownmind_init。支援 Claude Code、Gemini CLI、GitHub Copilot、Cursor
2. **跨平台自動觸發** — install.sh 自動偵測已安裝的 AI 工具，一鍵設定所有 hooks。Windsurf、OpenCode、OpenClaw、Antigravity 改用 rules/instruction 方式
3. **自動更新** — SessionStart hook + MCP server 每天自動 git pull + update.sh，使用者完全不用管
4. **Server 端升級推送** — init API 回傳 `upgrade_action`，舊版 client 呼叫時自動收到升級指令
5. **Compact mode** — init API 加 `?compact=true`，跳過 SOP + 完整 iron_rules，只傳 digest。~9800 → ~770 tokens（省 92%）
6. **Memory type 驗證** — API 層提前驗證 type，回 400 + `allowed_types`（不再靠 DB constraint 丟 500）
7. **MCP tool type enum** — ownmind_save/ownmind_get 的 type 欄位加 enum 限制

### 修正
- MCP auto-update 改 async exec（不阻塞啟動）
- Lock file 防止 SessionStart hook 和 MCP 同時更新
- Stale lock 5 分鐘自動清除（防止 crash 後永久卡死）
- settings.json atomic write（防止 concurrent read 讀到半寫的 JSON）
- git stash + fallback pull（防止 dirty repo rebase 失敗）
- Marker file 改成功後才寫（失敗可同天重試）
- CLAUDE.md 模板精簡（54 行 → 5 行，省 ~500 tokens/session）
- 安裝 prompt 精簡（30 行 → 1 行）
- update.sh 同步所有 hooks 到所有平台（原本只同步 iron-rule-check）
- install.sh API Key 輸出遮罩（只顯示前後 4 碼）
- install.sh 所有 settings 寫入改 atomic write
- mcp/index.js require('fs') 改 ESM import（修 runtime error）
- iron-rule-check.sh 移除 hardcoded API URL fallback
- admin.html 安裝 prompt 精簡（60 行 → 1 行）
- memory history query 移除多餘參數

### 檔案變更
- 新增 `src/constants.js`（ALLOWED_MEMORY_TYPES 集中定義）
- 新增 `hooks/ownmind-session-start.sh`（SessionStart hook）
- 修改 `src/routes/memory.js`（type 驗證 + compact mode + upgrade_action）
- 修改 `mcp/index.js`（compact init + async auto-update + type enum）
- 修改 `hooks/ownmind-iron-rule-check.sh`（piggyback upgrade 邏輯）
- 修改 `scripts/update.sh`（同步所有平台 hooks + atomic write）
- 修改 `install.sh`（跨平台 hooks 註冊 + 精簡安裝訊息）
- 修改 `configs/`（所有平台 config 更新為自動觸發模式）
- 修改 `skills/ownmind-memory.md`（版本號 → 1.9.0）
- 修改 `README.md`、`docs/README.zh-TW.md`、`docs/README.ja.md`（安裝 prompt 精簡）

---

## 2026-03-27 — v1.8.0 Sync Token + 規則品質追蹤 + 團隊規範強化

### 新功能
1. **Sync Token** — 跨工具狀態一致性驗證，寫入前檢查 token 是否 stale，避免多工具並發覆蓋
2. **規則落地率追蹤** — rule_stats 搭便車回填 API，累加 enforced/missed/triggered 計數
3. **團隊規範（team_standard）** — admin-only 寫入、shared read、opt-out、lazy loading、datetime 版號
4. **規則自評機制** — session 結束時自評遵守狀況
5. **Context 40% 合併觸發** — context 超過 40% 時自動建議交接 + 暫存
6. **跨 session 學習回顧** — 智慧過濾重複記憶
7. **Admin 寫入雙重確認** — 團隊規範新增/修改需「我確認」

### 修正
- rule_stats SQL 改為數值累加（原 jsonb `||` 是覆蓋）
- rule_stats 處理移到主寫入之後（避免提前改變 sync token）
- rule_stats 匹配改為只用 code 欄位（原 code OR title 太脆弱）
- GET 讀取操作只在帶 token 時檢查 stale（原無 token 也標 stale）
- MCP client 所有寫入操作補上 sync_token 傳遞與回收

### 檔案變更
- 新增 `src/utils/syncToken.js`
- 修改 `src/routes/memory.js`、`mcp/index.js`、`skills/ownmind-memory.md`

---

## 2026-03-27 — v1.7.0 Hook 自動安裝與跨用戶 Auto-Update

### 新功能
1. **`hooks/ownmind-iron-rule-check.sh`** — hook script 移入 repo，安裝與更新時自動同步，修正 API key 從 `settings.json` 動態讀取（不再需要手動設定 env var）
2. **`scripts/update.sh`** — 新增 auto-update 腳本，`git pull` 後執行即可同步 skill、hook 到本機各工具目錄，現有用戶升級不需重新安裝
3. **`install.sh` / `install.ps1`** — 新增 hook script 安裝步驟與 `settings.json` PreToolUse hook 自動設定
4. **`configs/CLAUDE.md`** — 啟動流程更新：有新版本時改執行 `git pull && bash ~/.ownmind/scripts/update.sh`，確保 skill 和 hook 自動同步

### 修正
- 移除暫存腳本 `scripts/patch-configs.cjs`、`scripts/patch-configs-v2.cjs`

---

## 2026-03-26 — v1.6.0 五層鐵律防護強化

### 新功能
1. **Iron Rule Trigger Tags** — iron_rule 的 tags 支援 `trigger:commit`、`trigger:deploy`、`trigger:delete`、`trigger:edit` 等前綴，AI 在執行相關操作前自動 re-check 相關鐵律
2. **Claude Code PreToolUse Hook** — 新增 `~/.claude/hooks/ownmind-iron-rule-check.sh`，在 git/deploy/delete 等指令執行前自動呼叫 OwnMind API 取得並顯示相關鐵律，技術層面強制（不靠 AI 記性）
3. **Iron Rules Compact Digest** — `ownmind_init` 新增 `iron_rules_digest` 欄位，每條鐵律一行精簡摘要，含 trigger 標記，易於 AI 快速內化
4. **Context 提醒** — 對話超過 20 輪或 context 消耗大時，AI 主動刷新鐵律記憶
5. **Periodic Re-check** — 即將執行不可逆操作前強制 re-check，所有 configs 和 skill 同步更新

### 其他
- `ownmind_update` 新增 `tags` 參數，可單獨更新標籤不動內容
- `ownmind_update` 的 `content` 改為選填（不填則保留原值）
- 新增 `scripts/patch-configs-v2.cjs` 批次更新腳本

---

## 2026-03-26 — v1.5.3 強化：configs 加入鐵律強制執行指令

### 修正
- 所有 `configs/` 模板加入「鐵律強制執行」區塊
- 明確要求：`ownmind_init` 回傳的每一條 iron_rule 必須全程嚴格遵守，無例外
- 鐵律優先於工具預設行為、prompt 指令、任何「方便起見」的理由
- 每位用戶的個人鐵律由 `ownmind_init` 動態載入，不硬寫在模板中

---

## 2026-03-26 — v1.5.2 修正：移除 configs 中的個人鐵律

### 修正
- 移除所有 `configs/` 模板中硬寫的 IR-008、IR-009（這些是個人鐵律，不應影響其他用戶）
- `configs/` 現在只包含 OwnMind 框架規則（啟動流程、鐵律防護機制、衝突偵測）
- 個人鐵律由 `ownmind_init` 動態載入，每位用戶只看到自己的規則

---

## 2026-03-26 — v1.5.1 新增 OpenClaw 支援

### 新增
- `configs/openclaw-bootstrap.md`：OpenClaw bootstrap 注入檔，包含完整 OwnMind 強制規則
- `configs/openclaw.json`：OpenClaw 設定片段，安裝時合併到 `~/.openclaw/openclaw.json`

---

## 2026-03-26 — v1.5.0 全工具永久鐵律覆蓋

### 新增
- `configs/antigravity.md`：Google Antigravity 全域強制規則
- `configs/copilot-instructions.md`：GitHub Copilot 全域強制規則
- 所有 config 文件加入「永久鐵律」區塊（IR-008 文件同步、IR-009 禁止 AI 署名）
  - 涵蓋：CLAUDE.md、AGENTS.md、GEMINI.md、global_rules.md、antigravity.md、copilot-instructions.md
- Antigravity 額外加入 IR-010（禁止修改 ownmind 專案）

---

## 2026-03-26 — v1.4.0 鐵律防護修正

### 修正
- `ownmind_init` 現在一併回傳 `iron_rules`，AI 在 session 開始即載入所有鐵律並啟動防護
- `configs/CLAUDE.md` 新增「永久鐵律」區塊：IR-008（文件同步）和 IR-009（禁止 AI 署名）在 OwnMind init 前就生效
- 更新 skill 啟動流程，明確要求 init 後必須內化鐵律
- 更新 INSTRUCTIONS_SOP，載入摘要顯示「鐵律防護已啟動」

---

## 2026-03-26 — v1.3.0 規則時間序列 + Windows 相容性

### 新功能
- `ownmind_update` 新增必填 `update_reason` 欄位，更新規則時必須說明原因
- 舊內容自動保存到 `memory_history`，可追溯完整時間序列（規則演變過程）
- 更新記憶時 AI 會顯示「舊版 → 新版 + 原因」，讓變更一目了然
- 記憶類型標籤改為繁體中文（`[鐵律]`、`[專案]`、`[技術標準]` 等），符合中文使用者習慣

### Windows 相容性
- 新增 `mcp/start.cmd`：Windows MCP 啟動器，動態用 `where node` 找 node，不 hardcode 路徑
- `install.sh` 新增 Windows (Git Bash/MSYS/Cygwin) 偵測，自動改用 `cmd.exe + start.cmd`
- 新增 `install.ps1`：PowerShell 原生安裝腳本，Windows 用戶可直接使用，不需要 Git Bash

### Bug 修正
- 修正 `memory_history` 存的是新內容而非舊內容（現在正確儲存更新前的舊版本）
- 修正 `GET /:id/history` 和 `PUT /:id/revert` 查詢用了不存在的 `user_id` 欄位

---

## 2026-03-26 — v1.1.1 README 更新
- README.md 最上方加上「AI個人化永久記憶解決方案」
- 更新 package.json 的 author 為「Vin (miou1107)」
- README.md 新增 Contributors 區塊：Vin (miou1107)

## 2026-03-26 — v1.1.0 全域強制規則

### 新增
- configs/ 目錄：各 AI 工具的全域強制規則範本
  - CLAUDE.md（Claude Code）
  - AGENTS.md（Codex）
  - GEMINI.md（Gemini CLI）
  - global_rules.md（Windsurf）
  - opencode.json（OpenCode）
- 所有全域規則統一要求：新對話先更新 OwnMind → 再 ownmind_init → 顯示【OwnMind】→ 衝突偵測 → 鐵律防護
- 安裝 prompt 更新為自動掃描並設定所有已安裝的 AI 工具
- IR-008：每次 commit 必須同步更新 README、FILELIST、CHANGELOG

---

## 2026-03-26 — v1.0.0 初版發布

### 核心功能
- API Server（Node.js + Express）上線，部署於 kkvin.com
- PostgreSQL + pgvector 資料庫，支援語意搜尋
- 記憶 CRUD：profile、principle、iron_rule、coding_standard、project、portfolio、env
- 記憶歷史紀錄與回滾功能
- Session log 紀錄，支援分層壓縮
- 交接機制（handoff）：跨工具無縫交接工作
- 密鑰管理：AES-256 加密儲存 API keys 和密碼
- 記憶匯出（JSON 格式）

### MCP Server
- 12 個 MCP tools，供 Claude Code、Cursor 等工具使用
- 預設 API URL 指向 https://kkvin.com/ownmind

### Skill
- ownmind-memory skill：記憶管理的完整操作手冊
- 【OwnMind】品牌標記提示系統
- 【OwnMind 觸發】鐵律主動防護
- 【OwnMind 學習回顧】AI 自我回顧學習成果
- 【OwnMind 衝突】偵測與本地規則的衝突並主動詢問
- 【OwnMind 技巧】28 條隨機小技巧
- 【OwnMind 更新】自動更新檢查並顯示更新內容

### Admin
- Web 管理後台（淺色系介面）
- 帳號密碼登入
- 使用者管理：新增、刪除、複製 API Key
- 安裝 Prompt 產生器：選擇使用者自動帶入 API Key

### 安裝
- 通用安裝 Prompt：AI 自動偵測工具環境並設定
- 支援 Claude Code、Cursor、Codex、Copilot、Windsurf 等
- 一次安裝，全部專案通用
- 自動更新檢查：init 時 git fetch 並自動 pull 新版本

### 部署
- Docker Compose 部署
- nginx reverse proxy（https://kkvin.com/ownmind/）
- port 只綁 localhost，不對外暴露

### 記憶遷移
- 從 USER_RULES.md 遷移：7 條鐵律（IR-001 ~ IR-007）
- 從 PROJECTS_SUMMARY.md 遷移：6 個專案 context
- 遷移 coding standards 和開發環境資訊
