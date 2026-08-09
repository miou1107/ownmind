# Claude Code 設定指南

## MCP Server 設定

**寫在 `~/.claude.json`，不是 `~/.claude/settings.json`。**

這兩個是不同的檔案，很容易搞混：

| 檔案 | Claude Code 從這裡讀什麼 |
|---|---|
| `~/.claude.json` | **MCP server** —— `ownmind_*` 工具要能出現，設定必須在這裡 |
| `~/.claude/settings.json` | hooks、權限等。Claude Code **不會**從這裡讀 MCP server |

這份文件到 v1.26.111 為止都寫成 `~/.claude/settings.json`，而安裝腳本也只寫那一個檔案。
結果是：記憶照常載入（SessionStart hook 設定在 settings.json，Claude Code 確實會讀那裡的
hooks），但 `ownmind_*` 工具在任何 session 裡都不存在 —— 看起來一切正常的那一半，正是它
藏了九個版本的原因。v1.26.112 起安裝與升級腳本都會寫入 `~/.claude.json`，一般使用者不需要
手動做這一步；下面保留給要手動設定或排查的人。

在 `~/.claude.json` 的 `mcpServers` 區塊加入：

```json
{
  "mcpServers": {
    "ownmind": {
      "command": "node",
      "args": ["/path/to/ownmind/mcp/index.js"],
      "env": {
        "OWNMIND_API_URL": "YOUR_OWNMIND_URL",
        "OWNMIND_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

## CLAUDE.md 設定（可選）

在專案的 CLAUDE.md 或全域 ~/.claude/CLAUDE.md 加入：

```
## OwnMind 記憶系統
- 開始工作前，呼叫 ownmind_init 載入記憶
- 完成重要工作後，呼叫 ownmind_save 儲存記憶
- 交接工作時，呼叫 ownmind_handoff_create
- 存取記憶時顯示 📥📤🔄 指示器
```

## 使用方式

設定完成後，在 Claude Code 裡說：
- 「載入我的 OwnMind」→ 觸發 ownmind_init
- 「記起來」→ 觸發 ownmind_save
- 「交接給 Codex」→ 觸發 ownmind_handoff_create

## 可用的 MCP Tools

| Tool | 說明 |
|------|------|
| ownmind_init | 載入初始記憶 |
| ownmind_get | 取得特定類型記憶 |
| ownmind_search | 搜尋記憶 |
| ownmind_save | 儲存新記憶 |
| ownmind_update | 更新記憶 |
| ownmind_disable | 停用記憶 |
| ownmind_handoff_create | 建立交接 |
| ownmind_handoff_accept | 接受交接 |
| ownmind_log_session | 記錄 session |
| ownmind_get_secret | 取得密鑰 |
| ownmind_list_secrets | 列出密鑰 |
| ownmind_set_secret | 儲存密鑰 |
