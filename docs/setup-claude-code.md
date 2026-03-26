# Claude Code 設定指南

## MCP Server 設定

在 `~/.claude/settings.json` 的 `mcpServers` 區塊加入：

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
