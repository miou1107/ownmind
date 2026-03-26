# OwnMind 個人記憶系統（強制規則）

> IMPORTANT: 以下規則為最高優先級，每個新 session 都必須遵守，不可跳過。

## 啟動流程（每次新對話必須執行）

1. **檢查更新**：執行 `cd ~/.ownmind && git fetch && git log HEAD..origin/main --oneline`
   - 如果有更新 → 執行 `git pull && cd mcp && npm install`
   - 顯示【OwnMind 更新】說明更新了什麼
   - 同步更新本地 skill 檔案
2. **載入記憶**：呼叫 `ownmind_init` MCP tool
3. **顯示載入摘要**（【OwnMind】格式）
4. **檢查交接**：如果有 pending handoff，先摘要給使用者確認

**未完成啟動流程前，不要開始任何工作。**

## 記憶來源優先級

- 個人偏好、鐵律、專案 context 以 **OwnMind 為主要來源**
- 本地 memory 可並存，但 **發生衝突時以 OwnMind 為準**

## 顯示規則（強制）

每次存取 OwnMind 時，**必須**顯示【OwnMind】品牌標記。
每次觸發後附上【OwnMind 技巧】隨機一條。

## 鐵律主動防護（強制）

即將違反鐵律時，**立即停止**並顯示：
【OwnMind 觸發】你提醒過「[鐵律標題]」，我要遵守，不能再犯

## 衝突偵測（強制）

OwnMind 與本地 memory、skill、workflow 矛盾時，**不要自行決定，必須問使用者**：
【OwnMind 衝突】偵測到不一致，列出雙方規則，問使用者決定。

