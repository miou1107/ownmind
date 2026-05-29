# v1.20.3 — Session 暫時關閉開關（/ownmind-off / /ownmind-on）

## 一句話總結

加兩個 slash 指令、讓 user 在本 session 內暫時關閉 OwnMind 的兩個鉤子（回話品質 lint + commit 前檢查）、不被擋。關閉狀態下每 10 輪 AI 回應提醒 user「現在 OwnMind 關閉中」、避免忘記重開。新 session 自動失效（白話：開新對話就自動重新打開）。

## 背景

user（Vin）開發過程中、有時 OwnMind 鉤子會過嚴或誤擋（例如 IR-036 / IR-037 連續 lint、或 v1.20.2 之前的 IR-025 過嚴擋 commit）。user 希望有臨時開關、可以「先放著、之後再開」。

但也擔心：關掉後忘記重開、不知不覺長期沒鉤子保護。所以要有「定時提醒」機制。

## 範圍內

- 新狀態檔 `~/.ownmind/state/session-off.json` 含當前 `session_id` + `off_at` 時間戳 + `tick_count` 計數
- 新 helper 模組 `shared/session-off-state.js`（純函式、零外部依賴）
- 兩個新 MCP 工具：`ownmind_session_off` / `ownmind_session_on`
- 改 `hooks/ownmind-reply-lint.js`：開頭讀狀態檔、本 session 已關閉就 tick + 跳過、每 10 輪用 `writeToTty` 寫終端機提醒
- 改 `hooks/ownmind-git-pre-commit.js`：開頭讀狀態檔、本 session 已關閉就跳過 + 印提示 + 放行 commit
- 兩個 Claude Code slash 指令檔（`~/.claude/commands/ownmind-off.md` + `ownmind-on.md`）
- 跨 session 失效邏輯：狀態檔內的 `session_id` 跟當前 session 不符 → 視為失效、自動忽略

## 範圍外

- ❌ 關閉 MCP 工具層（C）：保留、user /ownmind-on 還要靠 MCP 重開
- ❌ 關閉 SessionStart 載入（D）：保留、AI 仍知道有 OwnMind
- ❌ 持久關閉（跨 session）：刻意不做、新 session 一定重開、避免長期無保護
- ❌ 細粒度關閉（只關 IR-036 不關 IR-037）：保留為未來 backlog

## 版號決策

v1.20.3、繼承 v1.20.2 系列、跟 v1.20.2 的 stub `v1.20.2-admin-pages` / `v1.20.3-super-pages` 共用版號前綴但資料夾名不衝突（前者叫 `v1.20.3-session-toggle`、後者叫 `v1.20.3-super-pages`）。stub `v1.20.3-super-pages` 還沒動工、未來 Vin 開動時自己決定要不要往後推。

## 風險

- **TTY echo 失敗 fallback**：`writeToTty` 在某些環境（CI / 沒 TTY）會失敗、改用 stderr。但 stderr 寫的訊息給 AI 看、不是 user。設計上要兩條路都試。
- **狀態檔競爭條件**：多個 hook 同時讀寫狀態檔可能衝突。實際發生機率低（rare）、暫不處理。
- **session_id 拿不到**：pre-commit hook 不在 Claude Code session 內、拿不到 session_id。對策：pre-commit hook 只看狀態檔存在 + `off_at` 是不是「最近」（例如 24 小時內）、不嚴格比對 session_id。
