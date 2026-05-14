# v1.17.66 — Tasks

執行清單。順序強制：helpers → reproduction tests → 修 bug → 觀測擴充 → admin view → 驗證 → 三同步 → review → commit。

---

## 0. 前置（等 Eric 工作排程器歷程截圖）

- [ ] **驗證 Bug #7 假設**：Eric 截圖「OwnMind Usage Scanner」task 歷程
  - 預期看到：每 30 分鐘準時 + 偶有 catch-up 連續紀錄
  - 若不是：暫停 #7 修法，回頭 grep 其他可能來源

---

## 1. Helpers（先建底層，後面所有 bug 都用 helper）

### 1.1 `scripts/windows/lib/find-git-bash.ps1`

- [ ] 建檔，實作 `Find-GitBash` function（spec.md §1.1）
- [ ] 偵測順序：cache → 常見路徑 → where bash 過濾 WSL relay
- [ ] 用 `bash --version` 確認真的是 Git Bash（避免 WSL distro 也回）
- [ ] 寫 cache 到 `~/.ownmind/.git-bash-path`

### 1.2 `scripts/install-helpers/safe-spawn.cjs`

- [ ] 建檔，export `safeSpawn(file, args, options)`
- [ ] 預設 `shell:false` + `windowsHide:true` + `timeout:5000`
- [ ] 失敗回 `{ok:false, error, stderr_tail}`，不 throw
- [ ] options 傳 `shell:true` 時 log warning（不擋）

### 1.3 `scripts/install-helpers/path-to-win32.cjs`

- [ ] 建檔，export `toWin32Path(p)` 和 `toMsysPath(p)`
- [ ] `/c/X` ↔ `C:\X` 雙向
- [ ] 非 Windows 平台 no-op

### 1.4 `scripts/windows/run-hidden.vbs`

- [ ] 建檔（spec.md §1.4 內容）
- [ ] install.ps1 把這檔複製到 `~/.ownmind/scripts/windows/`

---

## 2. Reproduction tests（IR-003：先紅，後面才能轉綠）

加進既有測試檔，不新建。

### 2.1 `tests/ps1-windows-compat.test.js` 新增 case

- [ ] **#1 reproduction**：mock PATH 含 `C:\Windows\System32\bash.exe` 在前、Git Bash 在後 → expect `Find-GitBash` 不回 System32 那個
- [ ] **#1 fallback**：mock PATH 只有 System32 → expect 回 `$null`
- [ ] **#6 reproduction**：跑 `Out-File` 寫中文 → expect 預設 UTF-16 BOM（紅）→ 修完 expect UTF-8 無 BOM（綠）

### 2.2 `tests/self-check.test.js` 新增 case

- [ ] **#2 reproduction**：mock spawn 攔截 → expect args 不被 cmd shell 包；對 PowerShell pipeline 命令確認 `|` 不會被當 cmd pipe
- [ ] **#4 reproduction (a)**：mock 升級失敗（throw）→ expect self-check.cjs 仍被呼叫
- [ ] **#4 reproduction (b)**：mock fetch 401 → expect 報告寫進 spool 而非丟掉
- [ ] **#4 reproduction (c)**：給定 spool 內容 + mock fetch 200 → expect spool 被清空且報告全傳完
- [ ] **#7 acceptance**：register-scanner-task.ps1 dry-run 輸出含 `wscript.exe` 和 `run-hidden.vbs`，**不**含 bare `node.exe -Execute`

### 2.3 確認所有 reproduction tests 都先紅

- [ ] 跑 `npm test` 看七條新測試全紅，老測試全綠

---

## 3. 修 bug（每個 bug 一個 commit，按順序）

### 3.1 Bug #1 — interactive-upgrade.ps1 三處 bare `bash`

- [ ] line 120, 125, 130 改用 `Find-GitBash` helper
- [ ] 加 fallback：找不到 Git Bash → 跳過 verify 但不擋升級
- [ ] 跑 #1 reproduction 轉綠

### 3.2 Bug #2 — self-check.cjs 拿掉 `shell:true`

- [ ] [scripts/install-helpers/self-check.cjs:195-197](../../../scripts/install-helpers/self-check.cjs) 改用 `safeSpawn`
- [ ] 移除 `{ shell: true }`
- [ ] 跑 #2 reproduction 轉綠

### 3.3 Bug #4 — self-check 觀測管道保證執行 + 失敗 spool

- [ ] interactive-upgrade.ps1：把 self-check 從 line 172 改成 try/finally 結構
- [ ] interactive-upgrade.sh：同步加 `trap` 保證執行
- [ ] self-check.cjs：實作 `appendSpool` + `retrySpool` 兩個 function
- [ ] uploadReport：401/403/network 失敗時寫 spool
- [ ] uploadReport：每次跑 self-check 開頭先試補傳 spool
- [ ] 跑 #4 reproduction 三條全綠

### 3.4 Bug #6 — Out-File 加 `-Encoding utf8`

- [ ] grep 全 repo 所有 `Out-File`、`Set-Content`、`Add-Content` 沒指定 -Encoding 的
- [ ] 全部加 `-Encoding utf8`
- [ ] 跑 #6 reproduction 轉綠

### 3.5 Bug #7-a — Scanner VBS launcher

- [ ] [scripts/windows/register-scanner-task.ps1](../../../scripts/windows/register-scanner-task.ps1) Action 改 `wscript.exe run-hidden.vbs ...`
- [ ] install.ps1 確保 `run-hidden.vbs` 被複製到 `~/.ownmind/scripts/windows/`

### 3.6 Bug #7-b — Scanner task settings

- [ ] [scripts/windows/register-scanner-task.ps1:89-98](../../../scripts/windows/register-scanner-task.ps1) trigger interval 30 → 120 分鐘
- [ ] settings 加 `-DontStartIfOnBatteries -StopIfGoingOnBatteries`
- [ ] 跑 #7 acceptance 轉綠

---

## 4. 環境資訊收集擴充（IR-038 落實）

### 4.1 self-check.cjs `buildReport` 擴充

- [ ] 新增 `collectEnv()` function，收集 spec.md §3.1 所有欄位
- [ ] Windows 才跑 `bash_resolution`（呼叫 where.exe）
- [ ] Windows 才跑 `scheduler_detail`（用 safeSpawn 跑 PowerShell）
- [ ] 全部用 `sanitizePath` redact $HOME

### 4.2 Upgrade trace 收集（trigger=post_upgrade）

- [ ] interactive-upgrade.ps1 寫 step trace 到 `~/.ownmind/logs/.last-upgrade-trace.json`
- [ ] interactive-upgrade.sh 同步
- [ ] self-check.cjs 讀 `.last-upgrade-trace.json` 加進 `full_log.upgrade_trace`

### 4.3 File lock 偵測（Windows）

- [ ] 新增 `scripts/install-helpers/check-file-locks.cjs`，用 `Get-Process` + `handle.exe` 偵測
- [ ] 只在 trigger=manual_after_failure 或偵測到 rollback 失敗時跑
- [ ] handle.exe 沒裝就 skip（不擋）

### 4.4 Server 端確認

- [ ] [src/routes/debug.js:30-33](../../../src/routes/debug.js) 確認 `env`、`upgrade_trace`、`file_locks` 都被 64KB validator 接受
- [ ] 新欄位在 `install_check_logs.full_log` JSONB 內，不需要 migration（已是 JSONB）

---

## 5. Admin dashboard view（spec.md §4）

### 5.1 後端

- [ ] [src/routes/admin.js](../../../src/routes/admin.js) 新增 `GET /api/admin/install-check`
- [ ] 支援篩選：`?user_id=...&trigger=...&has_fail=true&days=7`
- [ ] super_admin role check
- [ ] 預設取最近 7 天，limit 100

### 5.2 前端

- [ ] 加 `/ownmind/admin/install-check.html`（或既有 admin SPA route）
- [ ] 列表 + 詳細 modal
- [ ] 失敗高亮（紅色標籤）
- [ ] 點某筆 → 顯示完整 `full_log` JSON 結構化展開

### 5.3 Acceptance test

- [ ] `tests/admin-install-check.test.js`（新檔）：mock 兩筆紀錄（一 pass 一 fail）→ 確認列表 + 詳細 view 正確

---

## 6. 驗證（superpowers:verification-before-completion）

- [ ] 7 條 reproduction test 全綠
- [ ] 既有 60+ tests 全綠（不允許 regression）
- [ ] 跑 `npm run lint` 無 warning
- [ ] **手動測**：在 Windows VM（或 Eric 機器）跑 `bootstrap.ps1` 升級到本版
  - 預期：升級 OK、不跳視窗、self-check 上傳成功、upgrade_trace 有寫入
- [ ] **手動測**：拔電源（電池模式）→ 等 2 小時 → scanner 不跑
- [ ] **手動測**：故意把 API key 改錯 → self-check 上傳 401 → 看 spool 有寫
  - 改回正確 key → 重跑 self-check → spool 被清空、server 收到舊紀錄

---

## 7. Code review（superpowers:requesting-code-review）

- [ ] 把 diff 給 codex/code-reviewer agent 跑一次
- [ ] 重點問：
  - VBS launcher 在企業防毒環境會不會被誤殺？
  - safeSpawn 的 default override 邏輯是不是太寬鬆？
  - spool 機制有沒有 race condition（兩個 self-check 同時跑）？
  - admin install-check view 有沒有 PII 洩漏風險？
- [ ] 收 review 後走 superpowers:receiving-code-review，**不盲改**

---

## 8. 三同步（IR-008）+ 三處版號（IR-031）+ 三語 README（IR-032）

### 8.1 三處版號同步到 1.17.66

- [ ] `package.json` `"version": "1.17.66"`
- [ ] `mcp/index.js` SERVER_VERSION 常數（如有）
- [ ] git tag `v1.17.66`（commit 時打）

### 8.2 README 三語

- [ ] `README.md`（繁中）— 加「v1.17.66 Windows 平台硬化」段
- [ ] `README.en.md`（如存在）
- [ ] `README.ja.md`（如存在）

### 8.3 CHANGELOG.md

- [ ] 新增 v1.17.66 條目，依現有格式
- [ ] 列七個 bug 修法 + 環境資訊收集 + admin view + 三個 helper

### 8.4 FILELIST.md

- [ ] 新增條目：
  - `scripts/windows/lib/find-git-bash.ps1`
  - `scripts/windows/run-hidden.vbs`
  - `scripts/install-helpers/safe-spawn.cjs`
  - `scripts/install-helpers/path-to-win32.cjs`
  - `scripts/install-helpers/check-file-locks.cjs`
  - `openspec/changes/v1.17.66-windows-hardening/*.md`

---

## 9. Commit + PR

- [ ] 走 IR-009：contributors 顯示 Vin
- [ ] 走 IR-024：commit message 不加 `Co-Authored-By`
- [ ] commit message 格式對齊既有：`feat(windows): v1.17.66 Windows 平台硬化 + IR-038 觀測管道擴充`
- [ ] PR 描述含：七個 bug 列表 + 修法摘要 + 給 Eric/Adam 的「請重跑 bootstrap」備註

---

## 10. 收尾

- [ ] `ownmind_save` IR-038 候選鐵律寫入雲端記憶
- [ ] 知會 Eric / Adam 升級
- [ ] 記下：v1.17.66 部署後 24~48h 開始撈 install_check_logs，看是否有新 bug 浮出 → 規劃 v1.17.67（修 #3 + #5）

---

## 順序強制依賴圖

```
[0] Eric 截圖驗證 #7
       ↓
[1] Helpers (1.1 ~ 1.4) ← 必須先建
       ↓
[2] Reproduction tests (先紅)
       ↓
[3] 修 bug (#1, #2, #4, #6, #7-a, #7-b)（每條 commit 後跑對應 test 轉綠）
       ↓
[4] 環境資訊收集擴充
       ↓
[5] Admin view
       ↓
[6] verification-before-completion（全跑一次）
       ↓
[7] requesting-code-review
       ↓
[8] 三同步 + 三處版號 + 三語 README
       ↓
[9] Commit + PR
       ↓
[10] 收尾
```

**不可跳階段。** 每個階段沒過不能進下一個（IR-007 Persistent Bug Protocol + 軟體開發品管三步驟）。
