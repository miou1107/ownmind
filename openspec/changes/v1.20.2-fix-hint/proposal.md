# v1.20.2 — 鉤子失敗訊息加上具體 ownmind_report_compliance 呼叫範例

## 一句話總結

當 `recent_event_exists` 檢查失敗時、鉤子失敗訊息要直接告訴 AI 該怎麼呼叫 `ownmind_report_compliance`（含正確的 `rule_title` 跟「不要帶 `rule_code`」這個關鍵提示）、避免 AI 反覆踩同個坑。

## 背景

2026-05-26 Vin 在 ima 專案 commit 時、IR-025 鉤子兩條檢查（verification + code-review）一直擋。AI 跑了 superpowers 技巧、派了 reviewer 子代理人、也呼叫了兩次 `ownmind_report_compliance`、但鉤子還是擋。

實際合規記錄抓出來才發現問題：

| 時間 | 寫入 event 欄位 | 原因 |
|------|---------------|------|
| 05:12:43 | `IR-025` | AI 第 1 次呼叫帶 `rule_code='IR-025'`、`mcp/index.js:1082` 寫死 `event: args.rule_code || args.rule_title` → 寫成 event=IR-025、但鉤子要找的是 event=verification |
| 05:13:05 | `verification` | AI 第 2 次只帶 `rule_title='verification'`、沒帶 `rule_code` → `args.rule_code || args.rule_title` 落到 title → 寫入 event=verification ✓ |
| — | — | AI 漏了 `event=code-review` 那次呼叫 → 鉤子持續擋 |

真正的 bug 來源是 `mcp/index.js:1082`：MCP 處理 `ownmind_report_compliance` 時硬寫 `event: args.rule_code || args.rule_title`、把 `rule_code` 優先寫進 event。`shared/compliance.js:43` 雖然也有條 fallback `event = entry.event || entry.rule_code || ''`、但 MCP 路徑 event 已先在 1082 行算好、compliance.js 那條 fallback 在這條路徑根本不會生效。

post-commit 鉤子寫得清清楚楚：`failures: ["還沒做 code review，請先完成「code-review」對應步驟"]`。鉤子邏輯沒壞、是 AI 不知道要怎麼正確呼叫。

## 為什麼 AI 容易踩這個坑

1. **MCP handler 隱式偏好 rule_code、AI 無從察覺**：`mcp/index.js:1082` 寫 `event: args.rule_code || args.rule_title`、把 rule_code 優先寫進 event。但 `ownmind_report_compliance` 的 `inputSchema` 只說「回報鐵律遵守狀況」、欄位 `rule_title` + `rule_code`。schema 沒任何提示說 rule_code 會吃掉 rule_title、也沒提示要寫語意事件名（verification / code-review）。
2. **鉤子錯誤訊息只說症狀不講解法**：原本訊息「請先完成『verification』對應步驟」、AI 不知道怎麼「完成」這個步驟。
3. **技巧（skill）跑了不會自動寫合規**：superpowers 技巧跑了、子代理人派了、這些動作沒接到 OwnMind 合規記錄機制。

## 範圍內

- 改 `shared/verification.js` 的 `FIX_HINTS.recent_event_exists`、訊息含完整呼叫範例 + rule_code 不能填的提示
- 加 reproduction test 到 `tests/verification.test.js`
- 更新 CHANGELOG / FILELIST / package.json / SERVER_VERSION 版號（IR-008 / IR-031）
- README 三語系如有提到鉤子訊息格式就同步改（IR-032）

## 範圍外

- ❌ 治本：刪掉 `mcp/index.js:1082` 的 `args.rule_code || args.rule_title`、或 schema 加 `event` 欄位讓 caller 直接指定（中成本、留 backlog）
- ❌ 自動偵測 skill / subagent 啟動寫合規記錄（高成本、留 backlog）
- ❌ bug_report 流程在 hook 失敗 path 拿不到 fingerprint 的修法（獨立 bug、留 backlog）
- ❌ 改 admin-pages / super-pages / legacy-retire 三個 stub 提案的編號（互不影響、留給 Vin 開動時自己處理）
- ❌ README 三語系版號標示同步到 v1.20.2（既存 stale、v1.20.0→v1.20.1 也沒同步、留獨立 commit 處理）

## 版號決策

本提案版號 v1.20.2、跟 stub `v1.20.2-admin-pages` 共用 v1.20.2 開頭。理由：

- 這次是 patch-level bug fix、不是 admin-pages 那種 feature work
- admin-pages 還是 stub（status: stub、待 v1.20.1 release 後展開）、未實際對應 release
- 我這個 hotfix 先吃 v1.20.2 號、admin-pages 開動時自己決定要不要往後推

## 風險

- **未改 MCP schema、AI 還是可能誤帶 rule_code 觸發備援**：靠 hint 提示治標、不治本。後續可以開 backlog 改 schema 加 `event` 欄位、根治。
- **本機已安裝鉤子訊息不會自動更新**：要等 user 升級 OwnMind 才會拿到。Vin 本機可以手動同步 `~/.ownmind/shared/verification.js`。

## Follow-up patch #3（同版本內、不另開版號）

Eric（另一個 AI session）報 bug：規則 IR-036 寫「上下文已說明過、可保留不改」、但 lint 程式沒實作詞彙記憶。同 session 解釋過的詞、後續 reply 仍被擋、user 重寫成本爆炸。

順手把整個 bug report 流程串起來修：

1. **lint 加詞彙記憶**：`checkJargonExplanation` + `lintReply` 加第二參數 `historicalCorpus`、lint hook 從 transcript 抽全部前輪 assistant text 餵進去。
2. **兩個 hook 失敗都帶 bug report 路徑**：lint hook + pre-commit hook 失敗 stderr 加 `bug_fingerprint:` + `suggest_report: true`、AI 拿到指紋就能送 bug report。
3. **註冊 3 個新指紋**：`lint_context_memory_missing` / `lint_hook_no_suggest_report_path` / `mem_iron_rule_blocking_commit_no_fingerprint`。

修法清單見 CHANGELOG v1.20.2 follow-up #3 段落。測試 `npm test` 1923/1923 全綠。

## Follow-up patch #2（同版本內、不另開版號）

Vin 在工作期間遇到「每次寫 OwnMind 都要先 init 拿 token、不然 409」的 UX 痛點。AI 在本次工作中也連續踩 3 次。

**根本原因**：`sync_token` 設計防 stale write（白話：防止用過時資料覆蓋）、但對「user 同時開多個 AI session」太嚴格。本次 session 期間 active_handoff 從 id=68 跳到 id=70、表示另一 session 建了 handoff、bump 了 token、這個 session 的 token 失效。

**修法**：MCP 端 callApi 函式自動攔 409 sync_token 錯誤 → 打輕量端點 GET /api/memory/sync-token 拿新 token → retry 1 次。對 AI 透明。

**改動**：
- `mcp/lib/sync-token-retry.js`（新）：兩個純函式 helper、獨立可測
- `mcp/index.js`：callApi 加 `_retried` 防無限循環、加 `refreshSyncToken()` 輕量端點呼叫
- `tests/auto-retry-sync-token.test.js`（新）：17 個 case 涵蓋 GET 不 retry / 500 不 retry / 非 sync_token 訊息不 retry 等防呆

**限制**：
- 只 retry 1 次
- 只對寫入操作（非 GET / HEAD）
- 必須訊息含 sync_token 字眼

## Follow-up patch #1（同版本內、不另開版號）

主 fix 上線後實測（2026-05-26 commit `de3a74f` 後）發現副作用 bug：

**症狀**：MCP 工具 `ownmind_report_compliance` 回傳 `status: blocked`、但 pre-commit 鉤子卻放行同次提交。鉤子訊息正是這次主 fix 的新版 hint（白話：fix 本身上線運作、但也順帶把問題曝光得更清楚）。

**根本原因**：`mcp/index.js:1090-1129` 的 autoComply（白話：合規呼叫後自動再跑一次鉤子檢查的機制）用記憶體變數 `complianceEvents`。`ownmind_init` 會把它歸零、session 重啟就清空。pre-commit 鉤子改讀 `~/.ownmind/logs/compliance.jsonl` 檔案、不受 session 重啟影響。兩者資料來源不一致 → 行為不一致。

**證據**：session log 顯示 session_id 從 `1779774294945` 換成 `1779778052749`、合規記錄 jsonl 仍有兩筆 fresh comply、但 autoComply 因記憶體變數已歸零、誤判 block。

**修法**（同 v1.20.2 版本內、不另開版號）：
- `mcp/index.js`：autoComply 內把記憶體變數跟檔案合併（`[...complianceEvents, ...readComplianceEvents()]`）。檔案視為唯一可靠來源、記憶體只當當前 session 的 cache（白話：暫存）。
- `tests/auto-comply-reads-file.test.js`：新增 3 個 case 守備設計合約。
- 不抽 helper（白話：可獨立測試的小函式）：weighing 簡單性 vs 嚴格 reproduction test 紅綠循環、選擇前者；測試走「設計合約 + 反證」型而非嚴格紅綠。註明在 commit message。
