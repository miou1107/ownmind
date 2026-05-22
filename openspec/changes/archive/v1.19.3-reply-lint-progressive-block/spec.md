# v1.19.3 — Reply-lint Progressive Block 規格（GIVEN / WHEN / THEN）

> BDD 三段式。涵蓋漸進式 block、3 種 MODE、session counter、白名單擴充行為。

---

## 場景 1：MODE=warn（預設） — 違規只警告、永不 block

**GIVEN**
- `OWNMIND_REPLY_LINT_MODE` 未設或設為 `warn`
- transcript 最後一輪 assistant text 含 「我用 refactor 跟 hook 重寫整個 codebase 的 middleware」（明顯違規）

**WHEN**
hook 被觸發

**THEN**
- stdout **完全空白**（不寫 block JSON、不寫任何文字）
- /dev/tty 寫 banner（含 IR-037/036 違規清單）
- compliance event spool / POST
- exit 0

---

## 場景 2：MODE=block + session 第 1 次違規 — 警告、不 block

**GIVEN**
- `OWNMIND_REPLY_LINT_MODE=block`
- session counter 顯示本 session 違規 0 次
- assistant text 違規

**WHEN**
hook 被觸發

**THEN**
- session counter +1 → 變 1
- /dev/tty 寫 banner（含「目前 session 違規 1 次、累積 4 次會 block」）
- stdout **不寫** block JSON
- exit 0

---

## 場景 3：MODE=block + session 第 4 次違規 — 觸發 block

**GIVEN**
- `OWNMIND_REPLY_LINT_MODE=block`
- session counter 顯示本 session 違規 3 次
- assistant text 違規

**WHEN**
hook 被觸發

**THEN**
- session counter +1 → 變 4
- /dev/tty 寫 banner（含「⚠️ 已觸發 block、Claude 將收到重寫指令」）
- stdout 輸出 `{"decision":"block","reason":"請重寫你剛才的回應..."}` JSON
- reason 內容為指令型、含具體問題詞、含改寫格式說明
- exit 0

---

## 場景 4：MODE=block + Claude 重寫後又違規 — 計數繼續累積、Claude Code 內建 8 次上限保護

**GIVEN**
- 已達第 4 次違規、hook block 過
- Claude 收到 reason、重寫、新回應依然違規
- 此時 `stop_hook_active` 由 Claude Code 設為 true

**WHEN**
hook 被觸發

**THEN**
- 偵測到 `stop_hook_active: true` → **立刻 exit 0、不跑 lint、不寫 banner、不寫 stdout**
- session counter **不增加**（這次不算 user 違規、是 hook 自己 retry 造成）
- 後續真正的 user 新對話 stop_hook_active=false、計數恢復累積

---

## 場景 5：MODE=disable — 完全跳過

**GIVEN**
- `OWNMIND_REPLY_LINT_MODE=disable`（或 `OWNMIND_REPLY_LINT_DISABLE=1`）

**WHEN**
hook 被觸發

**THEN**
- 不讀 transcript、不跑 lint、不寫任何東西
- exit 0

---

## 場景 6：MODE 未知值（fail-open） — 當 warn 處理

**GIVEN**
- `OWNMIND_REPLY_LINT_MODE=foo`（誤拼）

**WHEN**
hook 被觸發

**THEN**
- 視為 `warn`、行為同場景 1
- /dev/tty banner 加一行「⚠️ MODE 值 'foo' 不認識、fallback 到 warn」（讓 user 注意到）

---

## 場景 7：Session counter 檔不存在 — 視為計數 0

**GIVEN**
- `~/.ownmind/logs/reply-lint-session-counter.json` 不存在
- MODE=block、違規

**WHEN**
hook 被觸發

**THEN**
- counter 視為 0、加 1 後寫入新建檔
- 行為同場景 2（第 1 次違規、警告不 block）

---

## 場景 8：Session counter 檔毀損 — 計數歸零、不擋流程

**GIVEN**
- counter 檔內容不是合法 JSON
- MODE=block、違規

**WHEN**
hook 被觸發

**THEN**
- 視為計數 0、覆寫檔（從乾淨狀態重來）
- 行為同場景 2

---

## 場景 9：白名單擴充 — Top 30 違規詞應該全部被白名單吸收

**GIVEN**
- assistant text 含「Google」、「main」、「branch」、「worktree」、「review」、「hook」（Top 30 詞）

**WHEN**
跑 `checkMixedLanguage`

**THEN**
- 回 `{ok: true, ratio: 0, mixedWords: []}` — 都在新擴白名單

---

## 場景 10：Proper noun 偵測 — 大寫開頭孤立詞不算違規

**GIVEN**
- assistant text 含「Eric 跟 Phoebe 都同意」（人名）

**WHEN**
跑 `checkMixedLanguage`

**THEN**
- `Eric`、`Phoebe` 符合 `^[A-Z][a-z]+$` pattern → 視為 proper noun、不算違規
- 回 `{ok: true, ratio: 0, mixedWords: []}`

---

## 場景 11：Threshold 分情境 — 含 code block 寬鬆到 25%

**GIVEN**
- assistant text 含 ` ```code``` ` 區塊
- 中英混雜比例 22%（一般情境會違規、含 code 應放行）

**WHEN**
跑 `checkMixedLanguage`

**THEN**
- 偵測到 ` ``` ` → threshold=0.25
- 22% < 25% → `{ok: true, ratio: 0.22}`

---

## 場景 12：Code review 豁免 — 含「code review」字眼直接放行

**GIVEN**
- assistant text 開頭含「## Code Review」或「code-review 結果」

**WHEN**
跑 `checkMixedLanguage`

**THEN**
- 偵測到 code review 字眼 → 直接回 `{ok: true, ratio: 0, mixedWords: []}`

---

## 場景 13：IR-036 視窗從 50 字擴到 80 字

**GIVEN**
- assistant text 含「我們的 dispatcher 設計、     也就是把訊息分派出去的元件」
（dispatcher 後第一個有意義字距離 > 50 但 < 80）

**WHEN**
跑 `checkJargonExplanation`

**THEN**
- 80 字內找到「也就是」→ 不算違規
- 同樣 text 在舊 50 字視窗下會違規、新 80 字下放行

---

## 場景 14：Session counter 自掃 — 30 天前的 session 自動清

**GIVEN**
- counter 檔含 100 個 session 紀錄、其中 60 個 `started_at` > 30 天前
- MODE=block、新 session 違規

**WHEN**
hook 被觸發

**THEN**
- 寫入時自掃、60 個過期紀錄被刪除
- 最終檔只剩 41 個 session（40 個未過期 + 1 個新觸發的）

---

## 場景 15：Reason 寫法為指令型、含改寫格式建議

**GIVEN**
- MODE=block、第 4 次違規、違規詞含「refactor」、「codebase」

**WHEN**
hook 輸出 block JSON

**THEN**
- `reason` 字串以「請重寫」開頭（指令動詞）
- 含「refactor」、「codebase」實際詞列出
- 含「用括號附中文解釋」「：」「（）」等具體格式範例
- 含「如果你判斷上述詞已經有相關上下文、或屬於變數名 / 函式名等程式碼引用、可以保留不改」這類例外指引
- 不含「你違反了」、「你做錯了」這類報告式語氣
