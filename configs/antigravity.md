# OwnMind 個人記憶系統（強制規則）— Google Antigravity

> CRITICAL: 以下規則為最高優先級，每個新 session 都必須遵守，不可跳過。

## 啟動流程（每次新對話必須執行）

1. **檢查更新**：執行 `cd ~/.ownmind && git fetch && git log HEAD..origin/main --oneline`
   - 如果有更新 → 執行 `git pull && cd mcp && npm install`
   - 顯示【OwnMind 更新】說明更新了什麼
2. **載入記憶**：呼叫 OwnMind API 載入個人記憶
   - API URL：https://kkvin.com/ownmind
   - Header：`Authorization: Bearer <OWNMIND_API_KEY>`
   - Endpoint：`GET /api/memory/init`
3. **顯示載入摘要**（【OwnMind】格式）
4. **檢查交接**：如果有 pending handoff，先摘要給使用者確認

**未完成啟動流程前，不要開始任何工作。**

## 記憶來源優先級

- OwnMind 為主要來源，本地設定可並存，衝突時以 OwnMind 為準

## 顯示規則（強制）

- 每次存取記憶 →【OwnMind】品牌標記
- 每次觸發附上 →【OwnMind 技巧】隨機一條

## 鐵律主動防護（強制）

init 完成後將所有 iron_rules 內化為工作準則。即將違反時立即停止：
【OwnMind 觸發】你提醒過「XXX」，我要遵守，不能再犯

## 衝突偵測（強制）

矛盾時不自行決定：【OwnMind 衝突】列出雙方規則，問使用者

