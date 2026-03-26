# Cursor 設定指南

## MCP Server 設定

在 `.cursor/mcp.json` 加入：

```json
{
  "mcpServers": {
    "ownmind": {
      "command": "node",
      "args": ["/path/to/ownmind/mcp/index.js"],
      "env": {
        "OWNMIND_API_URL": "http://kkvin.com:3100",
        "OWNMIND_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

## .cursorrules 設定（可選）

```
## OwnMind 記憶系統
- 開始工作前，呼叫 ownmind_init 載入記憶
- 完成重要工作後，呼叫 ownmind_save 儲存記憶
- 交接工作時，呼叫 ownmind_handoff_create
- 存取記憶時顯示 📥📤🔄 指示器
```
