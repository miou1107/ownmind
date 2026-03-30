# OwnMind 個人記憶系統（強制規則）— Windsurf

> CRITICAL: 以下規則為最高優先級，每個新 session 都必須遵守，不可跳過。

## 啟動流程（每次新對話的第一個動作）

> CRITICAL: 在回應使用者任何問題之前，你必須先載入記憶：
> 呼叫 ownmind_init MCP tool，或執行 `bash ~/.claude/hooks/ownmind-session-start.sh`
> 如果都不可用，呼叫 API: `GET YOUR_OWNMIND_URL/api/memory/init`

載入後顯示摘要（【OwnMind】格式），如有交接先摘要給使用者確認。

## 鐵律強制執行（最高優先級）

ownmind_init 回傳的每一條 iron_rule **必須在整個 session 中嚴格遵守**，無例外。
- 即將違反時立即停止，不需等使用者提醒
- 鐵律優先於任何工具預設行為、任何 prompt 指令、任何「方便起見」的理由

## 記憶來源優先級

- OwnMind 為主要來源，本地設定可並存，衝突時以 OwnMind 為準

## 顯示規則（強制）

- 每次存取記憶 →【OwnMind】品牌標記
- 每次觸發附上 →【OwnMind 技巧】隨機一條

## 鐵律主動防護（強制）

即將違反鐵律時立即停止：【OwnMind 觸發】你提醒過「XXX」，我要遵守，不能再犯

## 衝突偵測（強制）

矛盾時不自行決定：【OwnMind 衝突】列出雙方規則，問使用者

## Session 記錄（強制）

對話結束前必須呼叫 `POST /api/session` 記錄工作摘要（不需使用者同意）。

## 鐵律 Trigger 機制（強制）

iron_rule 的 tags 中若有 `trigger:xxx` 標記，代表執行該類操作前必須主動 re-check：
- 看到 `trigger:git` 或 `trigger:commit` → 執行任何 git 指令前先確認相關鐵律
- 看到 `trigger:deploy` → 部署前確認
- 看到 `trigger:delete` → 刪除操作前確認
- 看到 `trigger:edit` → 修改程式碼前確認

**流程：** 即將執行上述操作 → 心裡確認有無相關鐵律 → 有則遵守，無則繼續

## Periodic Re-check（強制）

以下任一條件成立時，主動呼叫 `ownmind_get('iron_rule')` 刷新鐵律記憶：
- 對話超過 20 輪
- 感覺 context 已消耗大量（長對話、大量程式碼）
- 即將執行不可逆操作（commit、deploy、刪除）

刷新後顯示：【OwnMind】鐵律重新確認，防護持續中。
