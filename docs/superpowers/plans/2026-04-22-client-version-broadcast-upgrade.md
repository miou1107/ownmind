# Client 版本 Dashboard、廣播、互動升級 — 實作計畫

> 日期：2026-04-22
> Spec：`docs/superpowers/specs/2026-04-22-client-version-broadcast-upgrade-design.md`
> 版本：v1.16.x → v1.17.0
> 預估：28–35 小時（分 7 phase）

## 執行守則（依 Vin 鐵律）

- **IR-004**：每 phase 前確認走 OpenSpec 流程，spec 有更動先修 spec 再改 code
- **IR-012**：每 phase 結束走品管三步驟 — verification → code review (codex) → receiving review
- **IR-008**：每個 commit 同步 README / FILELIST / CHANGELOG
- **IR-021**：每個 phase 開工前 `git pull origin main`
- **IR-022**：所有功能同時檢查 server + client 兩端
- **IR-024**：commit 不加 Co-Authored-By
- **IR-025**：完成實作 ≠ 完成工作；品管三步驟是工作的一部分
- **IR-026**：改完程式碼立即檢查 README/FILELIST/CHANGELOG，不等 commit
- **IR-031**：merge 到 main 時 package.json / SERVER_VERSION / git tag 三處版號同步
- **IR-032**：OwnMind README 三語系（zh-TW / EN / JA）必須同步更新

---

## 依賴關係

```
P1 (DB migration + 裝機狀況 Dashboard)
  └──→ P2 (Broadcast backend + admin CRUD) ← Gate：P2 的 API 是 P3/P4 的基礎
         ├──→ P3 (Claude Code SessionStart hook — Layer 1)
         └──→ P4 (MCP response injection — Layer 2)
                └──→ P5 (Universal upgrade script)
                       └──→ P6 (Verification script)
                              └──→ P7 (AI tool skills/prompts 接線) ← Gate：最後 ship
```

P3 / P4 可以平行做（都靠 P2 的 broadcast API）。P5 / P6 / P7 必須序列，因為 P7 的 skill 需要 P5+P6 完成才有得跑。

---

## P1：DB Migration + 裝機狀況 Dashboard

**目標**：Admin 能看到所有 user 的 client 版本分布

**預估**：3–4 小時

### Tasks

1. `db/008_broadcast.sql`：
   - `broadcast_messages`（全欄位見 spec S1）
   - `user_broadcast_state`
   - `user_tool_last_seen`
   - `memories` 加 `is_test` 欄位 + partial index
   - （不 seed sample upgrade_reminder — P2 的 `nightly-upgrade-reminder.js` job 會自動產生符合 CHECK 約束的正式廣播，避免 demo 資料污染 prod）

2. `src/routes/admin/clients.js`（新檔）：
   - `GET /api/admin/clients` — JOIN `users` + `collector_heartbeat`（latest per user+tool）
   - 每筆回傳該 user 所有 tool 的 version + status
   - 計算 `needs_upgrade`（client_version < SERVER_VERSION）

3. `src/public/index.html`：
   - 「設定」tab 下新增「裝機狀況」sub-panel 或獨立 tab
   - 顯示：User / Email / 各 tool 的 version + last_heartbeat + 狀態燈
   - 未升級 user 標黃、未裝標灰、active 標綠
   - 團隊覆蓋率 summary（已裝 / 總人數）

### Tests

- `tests/clients.test.js`：
  - admin 可讀、member 不可讀（403）
  - 多 tool 同 user 正確 group
  - heartbeat > 48h 算 offline，> 24h 算 stale
  - needs_upgrade 判定正確

### Verification（IR-012 Step 1）

- [ ] `bash db/008_broadcast.sql` 成功
- [ ] Jest 跑 `npm test -- clients` 全綠
- [ ] Dashboard 手動點開「裝機狀況」看到自己的紀錄
- [ ] README / FILELIST / CHANGELOG 同步加上 v1.17 條目

### Code Review（IR-012 Step 2）

- 交 codex-rescue 做 adversarial review
- 重點檢查：SQL injection、N+1 查詢、權限邊界

### Receiving Review（IR-012 Step 3）

- 依 codex 回饋修正
- 所有 review 疑問逐條 address

### Commit

- `feat(dashboard): 裝機狀況頁 + broadcast_messages schema (v1.17.0 P1)`

---

## P2：Broadcast Backend + Admin CRUD

**目標**：Admin 可在 dashboard 發 / 列 / 撤銷廣播

**預估**：4–5 小時

### Tasks

1. `src/routes/broadcast.js`（新檔）：
   - `POST /api/admin/broadcast`（super_admin）
   - `GET /api/admin/broadcast`（admin+）
   - `PATCH /api/admin/broadcast/:id`（super_admin）
   - `DELETE /api/admin/broadcast/:id`（super_admin，soft delete = set ends_at=NOW()）
   - `GET /api/broadcast/active?tool=X`（all）— **不含 snooze / dismissed**
   - `POST /api/broadcast/dismiss`（all）— 寫 user_broadcast_state

2. `src/lib/broadcast-filter.js`（新檔）：
   - `filterVisibleBroadcasts(userId, tool, clientVersion)` — 集中實作 S5 的決策邏輯
   - P4 和 `/api/broadcast/active` 共用同一個 function（避免雙實作漂移）

3. `src/jobs/nightly-upgrade-reminder.js`（新檔）：
   - 每天 03:30 Asia/Taipei 跑
   - 檢查 + insert `type='upgrade_reminder'` 廣播（見 spec F3）
   - 冪等：已有同版本 reminder 不重複插

4. `src/public/index.html`：
   - Admin 「設定」tab 下新增「廣播管理」sub-panel
   - 新增廣播 form：type / severity / title / body / CTA / target_users / allow_snooze / starts_at / ends_at
   - 列表顯示所有廣播（含已撤銷），可撤銷 / 編輯

### Tests

- `tests/broadcast.test.js`：
  - CRUD 權限（admin vs super_admin vs member）
  - `/active` 正確過濾 snooze / dismissed / version / target_users
  - Dismiss 不 allow_snooze 的廣播應 400
  - Nightly job 冪等性（跑 3 次只插一筆）

### Verification

- [ ] Jest 全綠
- [ ] 手動在 dashboard 發一則「測試廣播」，用 curl 打 `/api/broadcast/active?tool=claude-code` 能取回
- [ ] Dismiss 後再 GET 不見
- [ ] snooze_until 到期後再出現
- [ ] CHANGELOG 更新

### Code Review（codex）

- 重點：broadcast-filter.js 邏輯正確性（Scenario A-J 全部涵蓋）
- SQL N+1（批次查 user_broadcast_state）

### Commit

- `feat(broadcast): 通用廣播系統 backend + admin CRUD (v1.17.0 P2)`

---

## P3：Claude Code SessionStart Hook（Layer 1）

**目標**：Claude Code user 每次啟動看到廣播

**預估**：2–3 小時

### Tasks

1. `hooks/ownmind-session-start.sh`（已存在，擴充）：
   - call `/api/broadcast/active?tool=claude-code`
   - 把廣播 render 成 additional context 的 markdown
   - fail-silent（API 掛掉不該擋住 SessionStart）

2. `scripts/update.sh`：同步新版 hook 到 `~/.claude/hooks/`

3. 處理 Token 儲存：hook 需要讀 `~/.ownmind/credentials.json`（已存在機制）

### Tests

- `tests/session-start-hook.test.js`：
  - Mock API response，確認輸出格式正確
  - API 500 時不爆
  - 多則廣播依 severity 排序

### Verification

- [ ] 在本機起一個 Claude Code session，手動從 dashboard 發測試廣播 → 下次開 session 應看到
- [ ] Dismiss 後 24h 再開不出現
- [ ] CHANGELOG 更新

### Code Review（codex）

- 重點：hook 的 error handling、output 格式是否符合 SessionStart hook 規範

### Commit

- `feat(broadcast): Claude Code SessionStart 顯示廣播 (v1.17.0 P3)`

---

## P4：MCP Response Injection（Layer 2）

**目標**：所有 AI 工具 call ownmind_* 時看到廣播（text prepend 到 main response）

**預估**：4–5 小時

### Tasks

1. `src/mcp/middleware/inject-broadcast.js`（新檔）：
   - 包裝所有 `ownmind_*` tool handler 的 response
   - 判斷 `isFirstOfDay` / `isLongGap` → `forceInject` flag
   - 呼叫 `broadcast-filter.js`（P2 建好的）
   - Cooldown 過濾（D6a）
   - **把廣播 prepend 到 `content[0].text`**（D4 text 策略）
   - 更新 `user_broadcast_state.last_injected_at`

2. `src/mcp/server.js`：在 tool router 注入 middleware

3. `src/db/user-tool-last-seen.js`（新檔）：
   - `getUserToolLastSeen` / `upsertUserToolLastSeen`
   - upsert 要冪等，避免 race condition

4. **不需改 MCP client 端** — D4 用 text prepend 後，舊版 client 自動相容，零改動

### Tests

- `tests/inject-broadcast.test.js`：
  - 首次對話（Scenario D）prepend 到 text
  - 隔 4h（Scenario E）prepend
  - 隔 3h59m 但已在 cooldown 內 → 不 inject
  - 同一則廣播 10 分鐘內 call 5 次 MCP，只第一次 inject（Scenario K cooldown）
  - 版本落後但 snooze 中不注入（Scenario F）
  - 無廣播時 content[0].text 完全不變
  - text prepend 格式正確（分隔符 `\n\n---\n\n` 在中間）
  - 舊版 client 無需改動也能顯示（Scenario J，純 string 相容）

### Verification

- [ ] 起 MCP server，透過 ownmind_get 模擬 user 首次 call → 回應含 `_broadcast`
- [ ] user_tool_last_seen 有更新
- [ ] 立即再 call 一次 → 不含 `_broadcast`（同日且非隔久）
- [ ] CHANGELOG 更新

### Code Review（codex）

- 重點：race condition（同一 user 同時多個 MCP call）
- `_broadcast` 不要讓 response 體積爆炸（加 max_broadcasts=3）

### Commit

- `feat(mcp): response 注入廣播（首次/隔久/版本落後）(v1.17.0 P4)`

---

## P5：Universal Upgrade Script

**目標**：user 跑一條指令即完成升級（備份 → pull → install → 重排程）

**預估**：4–5 小時

### Tasks

1. `scripts/interactive-upgrade.sh`（新檔，Mac/Linux）：
   - 結構化 stdout（INFO/OK/ERROR/ASK prefix，spec S3）
   - 備份：`cp -r ~/.ownmind ~/.ownmind.bak.<timestamp>`
   - git pull（`--ff-only`，conflict 就 fail 不硬 merge）
   - install.sh --update（extend 現有 install.sh，新增 `--update` mode）
   - launchctl / systemctl 重註冊（依 OS）
   - 呼叫 verify-upgrade.sh --local / --server / --cleanup

2. `scripts/interactive-upgrade.ps1`（新檔，Windows）：
   - 結構完全對應 bash 版
   - 用 Task Scheduler cmdlet 重註冊

3. `install.sh` / `install.ps1`：新增 `--update` 參數（跳過已經做過的步驟，但強制更新檔案 + 重註冊排程）

4. `scripts/backup-rotate.sh`：只保留最近 3 個 bak 資料夾，避免磁碟爆

### Tests

- `tests/upgrade-script.test.js`（Node 呼叫 bash script，mock git + install.sh）：
  - 正常流程每步驟輸出格式正確
  - git pull 失敗時 stdout 有 `ERROR:git_pull`
  - 已是最新版時 git pull 不報錯（「Already up to date」）
  - 備份資料夾有建立

### Verification

- [ ] 在 macOS VM 跑完整升級：裝 v1.16 → 跑 script → 確認變 v1.17，launchd 有重註冊
- [ ] Linux VM 重複一次
- [ ] Windows VM 跑 PowerShell 版
- [ ] 刻意模擬網路斷線 → git pull 失敗 → stdout 格式對
- [ ] CHANGELOG 更新

### Code Review（codex）

- 重點：備份失敗時的 rollback 策略、敏感檔案（credentials.json）不要進 bak
- 跨平台邊界：PowerShell 版的錯誤語意是否和 bash 版一致

### Commit

- `feat(upgrade): 通用互動升級 script (v1.17.0 P5)`

---

## P6：Post-upgrade Verification Script

**目標**：升級後自動驗測本地 + server + 清理

**預估**：4–5 小時

### Tasks

1. `scripts/verify-upgrade.sh`（新檔，見 spec S3）：
   - `--local`：檢查 MCP binary / skill / hook / VERSION
   - `--server`：寫 → 讀 → 鐵律 trigger → 全成功
   - `--cleanup`：刪所有 `name LIKE '__upgrade_test__%'` 的 memory

2. `scripts/verify-upgrade.ps1`：同結構 PowerShell

3. `src/routes/memories.js`：
   - 接收 `type='_test'` 或 `name` 開頭 `__upgrade_test__` 的寫入
   - 寫入 `is_test=TRUE`
   - 新增 `DELETE /api/memories?name_prefix=__upgrade_test__`（只許刪 is_test=TRUE 的）

4. `src/db/memories.js`：
   - 讀取 `getMemories` / `syncMemories` 加 `WHERE is_test = FALSE`
   - 所有寫入、sync、cron job 都跳過 is_test

5. `src/routes/memories.js`：新增 `POST /api/memories/trigger-check`：
   - body: `{ tool, trigger }`
   - 執行鐵律 evaluation engine 的 dry run
   - return 是否 trigger 到鐵律

### Tests

- `tests/verify-upgrade.test.js`：
  - --local 每個檢查缺一項都會 FAIL
  - --server 寫 → 讀能匹配 TEST_NAME
  - --cleanup 只刪 is_test=TRUE 的（刻意寫一筆 is_test=FALSE 的同名，不該被刪）
  - trigger-check 回傳正確的鐵律清單

### Verification

- [ ] 本機跑 verify --local（已裝 v1.17）→ OK
- [ ] 故意刪掉一個檔案 → FAIL 訊息清楚
- [ ] 跑 --server → 寫 → 讀 → 清理成功
- [ ] DB 查 memories 沒有殘留 `__upgrade_test__`
- [ ] is_test 的 memory 不出現在 `/api/memories`（user 看不到）
- [ ] CHANGELOG 更新

### Code Review（codex）

- 重點：cleanup 的安全邊界（絕對不能刪非 is_test 的）
- name_prefix SQL injection 防護
- trigger-check 不能真的執行鐵律副作用（必須是 pure dry run）

### Commit

- `feat(upgrade): 升級後驗測 + 測試資料清理 (v1.17.0 P6)`

---

## P7：AI 工具 Skills / Prompts 接線

**目標**：所有 AI 工具都能辨識「我要升級」/「暫緩升級」意圖

**預估**：4–6 小時

### Tasks

1. `skills/ownmind-upgrade.md`（新檔）— skill 本體：
   - 觸發詞：「我要升級」「幫我升級 OwnMind」「升級 OwnMind」
   - 執行：依 OS 呼叫 `interactive-upgrade.sh` 或 `.ps1`
   - 逐行讀 stdout，把 INFO/OK 摘要給 user，ERROR 時依 spec D9 引導
   - 完成後呼叫 `POST /api/broadcast/dismiss`（dismiss 當前 upgrade reminder）

2. `skills/ownmind-upgrade-snooze.md`（新檔）— snooze skill：
   - 觸發詞：「暫緩升級」「先不要」「稍後再升級」「skip」「snooze」
   - 呼叫 `POST /api/broadcast/dismiss { snooze_hours: 24 }`
   - 回報「已延後 24 小時提醒」

3. `install.sh` / `update.sh`：同步新 skill 到各工具目錄。**每個工具先偵測目錄存在才複製，不存在就 skip**（Vin 需求 Q4）：
   - Claude Code：`~/.claude/skills/`（偵測 `~/.claude`）
   - OpenClaw：`~/.openclaw/skills/`（偵測 `~/.openclaw`）
   - Codex：`~/.codex/AGENTS.md`（偵測 `~/.codex`，append 一段升級規則）
   - Cursor：`~/.cursor/rules/ownmind.md`（偵測 `~/.cursor`）
   - Antigravity：`~/.antigravity/rules/ownmind.md`（偵測 `~/.antigravity`）
   - OpenCode：`~/.opencode/AGENTS.md`（偵測 `~/.opencode`）
   - Windsurf：`~/.windsurf/rules/ownmind.md`（偵測 `~/.windsurf`）
   - Gemini CLI：`~/.gemini/GEMINI.md`（偵測 `~/.gemini`，append）
   - install.sh 結束時 log：「安裝 skill 到 X 個工具，Y 個工具未安裝（已跳過）」

4. **各工具的 skill 內容**放 `skills/tool-specific/`（會自動產生各工具格式）：
   - `claude-code-upgrade.md`（原生 skill）
   - `codex-upgrade-rules.md`（system prompt snippet）
   - `cursor-upgrade-rule.md`
   - ... 每個工具一份，但核心邏輯（call script）一致

### Tests

- `tests/upgrade-skill.test.js`（unit test skill 辨識邏輯）：
  - 「我要升級 OwnMind」match 正 regex
  - 「升級我的 macOS」不該 match
  - snooze 觸發詞全部測過

- **手動 E2E**（記錄到 CHANGELOG 的 Verify 區）：
  - Claude Code：說「我要升級」→ 完整跑完
  - Codex：同上
  - Cursor：同上
  - Windows Claude Code（PowerShell）：同上

### Verification

- [ ] 所有工具 skill 檔案都由 update.sh 正確 deliver
- [ ] 手動在 Claude Code + Codex + Cursor 各跑一次完整升級流程 OK
- [ ] Snooze 在各工具都能觸發、時效正確
- [ ] README 三語系更新說明新流程（IR-032）
- [ ] FILELIST / CHANGELOG 更新

### Code Review（codex）

- 重點：skill 辨識是否過度寬鬆（會誤觸發）
- 各工具檔案分發的路徑 hardcode 是否正確
- PowerShell 路徑在 Windows 不同版本的相容性

### Commit

- `feat(upgrade): AI 工具 skill 接線 — 所有工具可互動升級 (v1.17.0 P7)`

### Receiving Review → PR

1. 全部 7 phase 結束後，做一次綜合 E2E
2. 手動試：
   - 新裝（fresh install）
   - 從 v1.16.0 升到 v1.17.0
   - 從 v1.15.x 升到 v1.17.0（跨多版）
3. 發 PR
4. PR 通過 + merge → 打 tag `v1.17.0`（IR-031）
5. 部署（docker compose build，IR-023；--no-cache，IR-018）
6. 部署後瀏覽器實測（IR-020）

---

## Risks / Open Questions

| # | 風險 | 緩解 |
|---|------|------|
| R1 | 各 AI 工具 skill 辨識「我要升級」精準度不一 | P7 test 寫充足的 positive / negative case，用 LLM 判斷而非純 regex |
| R2 | MCP response 注入在高頻 tool（ownmind_search）會不會拖慢 | user_tool_last_seen 加 index + cache 最近 5 分鐘的結果 |
| R3 | Windows PowerShell 權限政策（ExecutionPolicy）擋住 script | 腳本開頭加 `Set-ExecutionPolicy -Scope Process Bypass`；update.sh 檢查 |
| R4 | 升級中 user 又 call MCP 會怎樣 | Server 不阻擋；P7 skill 顯示「升級中請稍候」提示 |
| R5 | 廣播 body 有 markdown 在 SessionStart hook 中斷 hook 輸出 | P3 對 body escape newline、限制字元 |
| R6 | is_test flag 加到既有 memories 表可能影響性能 | 用 partial index `WHERE is_test = TRUE`，正常查詢走另一個 index |
| R7 | Nightly job 在 server 重啟後排程丟失 | 用現有 cron 機制（P6 token 用量 nightly-recompute 一樣的 pattern） |

---

## 驗證覆蓋（對應 Spec Scenarios）

| Scenario | 驗證位置 |
|----------|---------|
| A 裝機狀況 | P1 verification |
| B Admin 發廣播 | P2 verification |
| C 自動升級提醒 | P2 nightly-upgrade-reminder.test + 手動 |
| D 每天第一次 | P4 inject-broadcast.test |
| E 隔 4h | P4 inject-broadcast.test |
| F Snooze | P4 + P7 |
| G 我要升級（E2E） | P7 手動 |
| H 升級失敗引導 | P5 + P7 |
| I 測試資料不污染 | P6 verify-upgrade.test |
| J 舊 client 相容 | P4 inject-broadcast.test + 手動 |

---

## 出貨標準（gate before v1.17.0 release）

- [ ] 7 個 phase 全部 commit + review passed
- [ ] 所有 unit test 綠（預期 ~200 個新測試 + 既有 361 個）
- [ ] 手動 E2E：macOS / Linux / Windows × Claude Code / Codex / Cursor 3×3 = 9 組都試過
- [ ] README 三語系更新（IR-032）
- [ ] CHANGELOG 完整
- [ ] package.json + SERVER_VERSION + git tag 三處 v1.17.0 對齊（IR-031）
- [ ] DB migration 008 在 staging 先跑過
- [ ] `docker compose build --no-cache`（IR-018, IR-023）
- [ ] 部署後瀏覽器實測覆蓋率 panel + 裝機狀況 + 廣播管理 + 發一則測試廣播 → user 能看到（IR-020）
