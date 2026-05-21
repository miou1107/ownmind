# v1.20 — Critical 鐵律卡控 規格（GIVEN / WHEN / THEN）

> BDD 三段式描述（前提 / 動作 / 預期結果），對應 OpenSpec CONVENTIONS.md。
> 卡控落點、偵測邏輯、bypass 機制詳見 proposal §2、§3、§6。

---

## 一、Git pre-commit hook 卡控場景

### 場景 1：IR-002 偵測 .env 檔案進 staged → 擋

**GIVEN（前提）**

- v1.20 pre-commit hook 已安裝（`~/.ownmind/hooks/git-pre-commit` symlink 到 git hook dir）
- 工作區有 `.env.production` 檔案
- `OWNMIND_BYPASS` 環境變數**未設**

**WHEN（動作）**

```bash
git add .env.production
git commit -m "feat: add env"
```

**THEN（預期結果）**

- pre-commit hook 跑、exit code **1**
- stderr 顯示：
  ```
  ❌ IR-002 違反: 偵測到 .env 檔案進入 commit
    檔案: .env.production
    請改用 ownmind_set_secret 儲存敏感資料，或設定 OWNMIND_BYPASS=IR-002 強制 commit
  ```
- commit **沒建立**（`git log -1` 顯示前一個 commit）
- 寫 audit event：`compliance` 表新增 `action='block', rule_code='IR-002'` 紀錄

---

### 場景 2：IR-002 偵測密碼樣式進 staged → 擋

**GIVEN**

- v1.20 pre-commit hook 已安裝
- staged diff 含明文 OpenAI API key（`sk-proj-1234...`）

**WHEN**

```bash
git commit -m "feat: add api integration"
```

**THEN**

- exit 1
- stderr 訊息含 `detected_by: regex:openai_api_key`（與 v1.19.1 共用 detector）
- commit 未建立

---

### 場景 3：IR-008 src/ 改了但三個文件沒改 → 擋

**GIVEN**

- staged diff：`src/routes/memory.js` 修改、無 README.md / FILELIST.md / CHANGELOG.md 改動

**WHEN**

```bash
git commit -m "fix: memory route"
```

**THEN**

- exit 1
- stderr：
  ```
  ❌ IR-008 違反: src/ 有改動但這三個文件沒同步
    src/routes/memory.js (+12 -3)
    缺少: README.md / FILELIST.md / CHANGELOG.md
  ```
- commit 未建立

---

### 場景 4：IR-008 純測試 / 純文件改動 → 不擋

**GIVEN**

- staged diff 只動 `tests/**` 或 `docs/**`、不動 `src/**`

**WHEN**

```bash
git commit -m "test: add coverage"
```

**THEN**

- exit 0、commit 成功
- README/FILELIST/CHANGELOG 不需要同步

---

### 場景 5：IR-009 git user.name ≠ Vin → 擋

**GIVEN**

- `git config user.name` 為 `Anthropic Claude`（誤）

**WHEN**

```bash
git commit -m "feat: ..."
```

**THEN**

- exit 1
- stderr：
  ```
  ❌ IR-009 違反: contributors 必須是 Vin
    當前 git user.name: Anthropic Claude
    執行修正: git config --global user.name "Vin"
  ```

---

### 場景 6：IR-024 commit message 含 Co-Authored-By → 擋

**GIVEN**

- pre-commit hook 已安裝
- commit message：`feat: add X\n\nCo-Authored-By: Claude <noreply@anthropic.com>`

**WHEN**

```bash
git commit -F /tmp/msg
```

**THEN**

- exit 1
- stderr：
  ```
  ❌ IR-024 違反: commit message 不可含 Co-Authored-By
    找到行: Co-Authored-By: Claude <noreply@anthropic.com>
  ```

---

### 場景 7：IR-031 三處版號不同步 → 擋（pre-tag）

**GIVEN**

- `package.json.version` = `1.20.0`
- `src/SERVER_VERSION` = `1.19.0`（沒同步）
- user 要打 tag `v1.20.0`

**WHEN**

```bash
git tag v1.20.0
```

**THEN**

- pre-tag hook 跑、exit 1
- stderr：
  ```
  ❌ IR-031 違反: 三處版號不同步
    package.json:   1.20.0
    SERVER_VERSION: 1.19.0
    tag:            v1.20.0
    請先把 SERVER_VERSION 更新到 1.20.0
  ```
- tag 未建立

---

### 場景 8：IR-012 session log 沒 verification 紀錄 → 擋

**GIVEN**

- 工作區有 src/ 改動已 staged
- 本 session 沒呼叫過 `superpowers:verification-before-completion`、`ownmind_search` 查不到 verification compliance event

**WHEN**

```bash
git commit -m "feat: new feature"
```

**THEN**

- exit 1
- stderr：
  ```
  ❌ IR-012 違反: 沒找到本 session 的品管驗證紀錄
    執行 superpowers:verification-before-completion 後再 commit
  ```

---

### 場景 9：IR-012 已跑 verification → 通過

**GIVEN**

- 本 session 已呼叫 verification、寫了 compliance event `rule_code='IR-012', action='comply'`

**WHEN**

```bash
git commit -m "feat: new feature"
```

**THEN**

- IR-012 檢查通過、進入其他鐵律檢查

---

### 場景 10：所有檢查通過 → commit 成功

**GIVEN**

- 工作區改動：src/ + README + FILELIST + CHANGELOG 都已同步
- git user.name = Vin
- commit message 沒 Co-Authored-By
- 沒密碼進 commit
- 本 session 有 verification 紀錄

**WHEN**

```bash
git commit -m "feat: legit feature"
```

**THEN**

- exit 0、commit 建立
- 寫 compliance event：所有 critical 鐵律 `action='comply'`
- 顯示 `✓ 鐵律檢查通過（6 條 critical、耗時 67ms）`

---

## 二、PreToolUse hook 卡控場景

### 場景 11：IR-005 blind edit、沒讀過檔案直接 Edit → 擋

**GIVEN**

- v1.20 PreToolUse hook 已安裝（Claude Code `~/.claude/settings.json` 加 hook）
- AI 沒對 `src/routes/auth.js` 呼叫過 Read

**WHEN**

- AI 呼叫 `Edit { file_path: "src/routes/auth.js", old_string: "...", new_string: "..." }`

**THEN**

- hook exit 2、Claude Code 中斷 tool 呼叫
- 回給 AI 的訊息：
  ```
  ❌ IR-005 違反: 不可 blind edit
    這個 session 沒有 Read 過 src/routes/auth.js
    請先呼叫 Read 工具讀取後再 Edit
  ```
- AI 收到、應該下一輪呼叫 Read

---

### 場景 12：IR-005 已讀過、Edit 通過

**GIVEN**

- AI 在本 session 已 Read `src/routes/auth.js`
- hook 紀錄 read state：`~/.ownmind/state/session-<id>/read-files.json`

**WHEN**

- AI 呼叫 `Edit { file_path: "src/routes/auth.js", ... }`

**THEN**

- exit 0、tool 呼叫繼續

---

### 場景 13：IR-002 工具層攔截 rm 密碼檔

**GIVEN**

- v1.20 PreToolUse hook 已安裝

**WHEN**

- AI 呼叫 `Bash { command: "rm .env.production" }`

**THEN**

- hook 偵測 `rm .env*` pattern、exit 2
- 訊息：
  ```
  ❌ IR-002 違反: 不可刪除 .env 檔案（可能含密碼、刪了不可復原）
    若真要刪、設 OWNMIND_BYPASS=IR-002 後重試
  ```

---

## 三、Reply-lint hook 卡控場景

### 場景 14：IR-037 中英混雜 > 15% → 擋下回應

**GIVEN**

- v1.20 reply-lint hook 已升級為 exit 2 模式
- AI 草稿回應中英混雜比例 21.9%

**WHEN**

- Claude Code 準備送出回應前跑 reply-lint hook

**THEN**

- hook exit 2、回應**不送出**
- 回給 AI 的訊息：
  ```
  ❌ IR-037 違反: 中英混雜比例 21.9% > 15%
    找到 12 個非白名單英文詞（前 5：author, Authored, Sheet, ...）
    請改成白話中文後重新回應
  ```
- AI 收到、應該重寫回應

---

### 場景 15：IR-036 行話沒附白話 → 擋

**GIVEN**

- AI 草稿回應含「sitemap」「verify」等行話、後面 50 字內沒「（白話）」「：解釋」「即...」

**WHEN**

- reply-lint hook 跑

**THEN**

- exit 2、訊息：
  ```
  ❌ IR-036 違反: 行話沒附白話說明
    sitemap, verify, drafts, ...
  ```

---

### 場景 16：Reply-lint 連續擋 3 次 → 降為 warning（避免死循環）

**GIVEN**

- AI 在同一 turn 連續被 reply-lint 擋 3 次

**WHEN**

- 第 4 次草稿仍違反

**THEN**

- hook 改 exit 1（warning）、回應送出但顯示警告
- 寫 compliance event `action='repeated_violation_softblock'`
- 提示 user：「reply-lint 連續擋 3 次、降為警告避免死循環、請手動 review」

---

### 場景 17：IR-041 偵測身分證 / email → 擋

**GIVEN**

- AI 回應含 `vincent@gmail.com` 或身分證 pattern

**WHEN**

- reply-lint hook 跑

**THEN**

- exit 2、訊息列出命中 pattern
- 例外：當 user 自己 prompt 含同樣資料時、視為 user 主動分享、不擋（檢查 user message 是否含同樣字串）

---

## 四、Bypass 機制場景

### 場景 18：OWNMIND_BYPASS 環境變數 → 跳過特定鐵律 + 寫 audit

**GIVEN**

- staged diff 含 README.md 沒同步（會違反 IR-008）

**WHEN**

```bash
OWNMIND_BYPASS=IR-008 git commit -m "hotfix: emergency"
```

**THEN**

- IR-008 檢查跳過、其他鐵律照跑
- commit 成功
- 寫 audit：
  ```json
  {
    "ts": "2026-05-22T...",
    "event": "bypass",
    "rule_code": "IR-008",
    "commit_sha": "abc1234",
    "commit_message": "hotfix: emergency",
    "user": "vin",
    "tool": "git-pre-commit"
  }
  ```
- admin UI Bypass 紀錄分頁顯示這筆

---

### 場景 19：OWNMIND_BYPASS=all → 跳過所有 critical（緊急逃生）

**GIVEN**

- 緊急情況、所有 critical 鐵律暫時關閉

**WHEN**

```bash
OWNMIND_BYPASS=all git commit -m "emergency"
```

**THEN**

- 所有 critical 檢查跳過、commit 成功
- audit log 標記為 `bypass_all`
- admin UI 紅字警示「⚠️ ALL CRITICAL BYPASSED」

---

### 場景 20：Bypass 不影響其他 session / 機器

**GIVEN**

- A session 跑 `OWNMIND_BYPASS=IR-008 git commit ...`

**WHEN**

- B session（同台機器、另一個 terminal）跑 `git commit`、staged 違反 IR-008

**THEN**

- B session 仍被擋（環境變數是 process scope、不外洩）
- A session 的 bypass 不污染全域

---

## 五、跨工具與升級場景

### 場景 21：Cursor 用戶走 git pre-commit 保底

**GIVEN**

- user 在 Cursor 工作（沒 PreToolUse hook）
- 改了 src/ 沒同步 README

**WHEN**

- user 在 Cursor 整合 terminal 跑 `git commit`

**THEN**

- git pre-commit 仍跑、IR-008 擋下
- IR-005（PreToolUse 層）在 Cursor 沒擋到 = 接受的設計妥協
- 文件清楚說明「Cursor 用戶只有 git 層卡控」

---

### 場景 22：v1.19 既有用戶升級到 v1.20

**GIVEN**

- 既有用戶 v1.19.0、pre-commit hook 未安裝
- 跑 `ownmind` SessionStart

**WHEN**

- SessionStart 偵測到 v1.20 已部署、本機 hook 還沒接上

**THEN**

- 顯示一次性引導訊息：
  ```
  【OwnMind v1.20】Critical 卡控已上線、請跑：
    ownmind migrate-hooks
  把 pre-commit / PreToolUse / reply-lint hook 接上。
  ```
- user 跑 migrate-hooks 後、`.git/hooks/pre-commit` symlink 到 `~/.ownmind/hooks/`
- 再次 SessionStart 不再顯示引導

---

### 場景 23：Hook 效能 SLA 驗收

**GIVEN**

- 本機有 50 個 staged 檔案、commit message 100 行

**WHEN**

- 跑 `time git commit`

**THEN**

- pre-commit hook 總執行時間 **< 100ms（p95）**
- 各鐵律檢查並行跑、不序列累加
- benchmark 測試在 CI 確保不退化

---

## 六、Audit log 與 admin UI

### 場景 24：所有違反、bypass、comply 都進 compliance 表

**GIVEN**

- v1.20 跑了一週

**WHEN**

- admin 開 admin UI 的「Bypass 紀錄」分頁

**THEN**

- 顯示時間序列：每筆 bypass 的時間、規則、commit sha、原因（user 可選填）
- 支援篩選：依鐵律編號、依日期區間
- 計數摘要：「本週 IR-008 bypass 3 次、IR-024 bypass 0 次」
- 連結到對應 commit（GitHub URL）

---

### 場景 25：Bypass 紀錄不可刪除（audit 完整性）

**GIVEN**

- admin UI Bypass 紀錄分頁

**WHEN**

- admin 嘗試刪除某筆紀錄

**THEN**

- 沒有「刪除」按鈕
- API `DELETE /api/compliance/:id` 永遠回 403
- 紀錄只能標記 `reviewed=true`、不能消失

---

## 七、邊界情境

### 場景 26：Hook 自己跑掛（內部錯誤）

**GIVEN**

- pre-commit hook 內部錯誤（例如 detector 函式拋 exception）

**WHEN**

- user 跑 `git commit`

**THEN**

- hook exit code **0**（fail-open、不卡住 user）
- stderr 顯示 warning：
  ```
  ⚠️ OwnMind hook 跑錯、暫時跳過卡控
    error: <message>
    請通報 ownmind issue
  ```
- 寫 error log 到 `~/.ownmind/logs/hook-errors.log`
- compliance event 標記 `action='hook_internal_error'`
- **設計理由**：hook 壞掉不該擋住正常工作流；fail-open 同時通報維護者

---

### 場景 27：離線環境（OwnMind server 連不上）

**GIVEN**

- 本機網路斷、OwnMind server 連不上

**WHEN**

- pre-commit hook 跑

**THEN**

- regex / pattern 偵測（IR-002、IR-024、IR-009）正常跑（純本機）
- 需要 server 的偵測（IR-012 查 session log）→ 退回 fail-open + warning
- audit log 暫存到 `~/.ownmind/queue/`、上線後自動 flush（既有 offline queue 機制）

---

### 場景 28：誤判 fallback 路徑

**GIVEN**

- pre-commit 因為某個 regex 過嚴擋到正常 commit

**WHEN**

- user 反覆嘗試、3 次都失敗

**THEN**

- 第 3 次 hook 額外提示：
  ```
  💡 如果這是誤判、用：
    OWNMIND_BYPASS=<rule_code> git commit ...
    並到 Admin UI 回報誤判改善 detector
  ```

---

## 非場景（明確不做）

- ❌ **Advisory tier 邏輯**：v1.21+ 處理
- ❌ **動態升降級**：v1.22+ 處理
- ❌ **靜默改寫 user code / commit message**：不做、要讓 user/AI 自己修
- ❌ **Cursor PreToolUse 卡控**：Cursor 沒對應 hook 點、本版不做
- ❌ **AI 自動建議 bypass**：bypass 必須是 user 明確意圖、不交給 AI 決定
