# v1.20.3 — 任務清單

1. **寫 shared/session-off-state.js helper**
   - 純函式：read / write / clear / increment tick / isOffForSession / isOffForPreCommit
   - 24 小時過期邏輯
   - 檔案損毀 / 目錄不存在防呆
   - 配合 `tests/session-off-state.test.js`：8+ 個守備 case

2. **新增兩個 MCP 工具到 mcp/index.js**
   - `ownmind_session_off`：取 session_id 寫狀態檔
   - `ownmind_session_on`：刪狀態檔
   - 兩個工具呼叫都回中文 ack + 解釋下一步

3. **改 hooks/ownmind-reply-lint.js**
   - main 開頭讀狀態檔、若本 session 關閉中：
     - tick_count 增加
     - 每 10 輪用 writeToTty 寫提醒、fallback stderr
     - exit 0 跳過 lint
   - 新 session 偵測：session_id 不符就清狀態檔

4. **改 hooks/ownmind-git-pre-commit.js**
   - 開頭讀狀態檔（pre-commit 無 session_id、只看 off_at 是否 24 小時內）
   - 若是 → 印提示 + exit 0
   - 24 小時過期 → 清狀態檔、正常跑

5. **slash 指令檔**
   - `~/.claude/commands/ownmind-off.md`：引導 AI 呼叫 `ownmind_session_off`
   - `~/.claude/commands/ownmind-on.md`：引導 AI 呼叫 `ownmind_session_on`

6. **版號 + 文件**
   - package.json + client/package.json: 1.20.2 → 1.20.3
   - CHANGELOG.md 加 v1.20.3 條目
   - FILELIST.md 加新檔
   - 三份 README 版本標示 v1.20.2 → v1.20.3

7. **品管 + commit + push + 同步本機**
   - npm test 全綠
   - cp 同步 ~/.ownmind/
   - verification + code-review 合規記錄
   - commit + push
