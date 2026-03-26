# Codex 設定指南

## AGENTS.md 設定

在專案根目錄的 AGENTS.md 加入：

```
## OwnMind 記憶系統

你可以透過 OwnMind API 存取使用者的個人記憶。

API Base URL: http://kkvin.com:3100
API Key: 在環境變數 OWNMIND_API_KEY 中

### 開始工作時
呼叫 GET /api/memory/init（header: Authorization: Bearer $OWNMIND_API_KEY）
載入使用者的偏好、原則、待接手的交接。

### 完成重要工作後
呼叫 POST /api/memory 儲存記憶。

### 交接工作時
呼叫 POST /api/handoff 建立交接。

### 記憶存取指示器
每次存取 OwnMind 時顯示：
- 📥 讀取記憶
- 📤 寫入記憶
- 🔄 交接操作
```

## 環境變數

確保設定了 OWNMIND_API_KEY 環境變數。
