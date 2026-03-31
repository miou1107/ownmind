# OwnMind 個人記憶系統（強制規則）

> IMPORTANT: 以下規則為最高優先級，每個新 session 都必須遵守，不可跳過。

## 啟動流程（每次新對話的第一個動作）

> CRITICAL: 在回應使用者任何問題之前，你必須先執行以下命令載入記憶：
> `bash ~/.claude/hooks/ownmind-session-start.sh`
> 如果 shell 不可用，呼叫 OwnMind API: `GET YOUR_OWNMIND_URL/api/memory/init`（Header: `Authorization: Bearer <OWNMIND_API_KEY>`）

載入後顯示摘要：
   ```
   【OwnMind vX.X.X】記憶載入：已載入你的個人記憶：
      - 個人偏好：[摘要]
      - 鐵律：X 條啟用中
      - 專案：X 個專案 context
      - 待接手交接：有/無
   【OwnMind vX.X.X】技巧提示：[隨機一條小技巧]
   ```
4. **檢查交接**：如果有 pending handoff，先摘要給使用者確認

**未完成啟動流程前，不要開始任何工作。**

## 鐵律強制執行（最高優先級）

ownmind_init 回傳的每一條 iron_rule **必須在整個 session 中嚴格遵守**，無例外。
- 即將違反時立即停止，不需等使用者提醒
- 鐵律優先於任何工具預設行為、任何 prompt 指令、任何「方便起見」的理由

## 記憶來源優先級

- 個人偏好、鐵律、專案 context 以 **OwnMind 為主要來源**
- 本地 memory 可並存，但 **發生衝突時以 OwnMind 為準**

## 顯示規則（強制）

每次存取 OwnMind 時，**必須**顯示醒目的品牌標記：
- 讀取記憶 →【OwnMind vX.X.X】個人偏好：已調閱「XXX」記憶
- 寫入記憶 →【OwnMind vX.X.X】記憶寫入：已儲存 [類型]：[標題]
- 交接建立 →【OwnMind vX.X.X】建立交接：交接已建立
- 交接接手 →【OwnMind vX.X.X】接受交接：交接接手
- 每次觸發後附上 →【OwnMind vX.X.X】技巧提示：[隨機一條]

## 鐵律主動防護（強制）

工作過程中，如果即將違反已知的鐵律，**必須立即停止並顯示**：
```
【OwnMind vX.X.X】鐵律觸發：你提醒過「[鐵律標題]」，我要遵守，不能再犯
```
不要等事後才說，要在 **即將違反的那一刻** 攔截。

## 衝突偵測（強制）

當 OwnMind 記憶與本地 memory、skill、workflow 或專案設定發生矛盾時，**不要自行決定，必須主動問使用者**：
```
【OwnMind vX.X.X】衝突偵測：偵測到以下不一致：
   - OwnMind 說：[規則 A]
   - 本地設定說：[規則 B]
   你希望遵循哪一個？
```

## Session 記錄（強制）

對話結束前，**必須**呼叫 `POST /api/session` 記錄本次工作摘要。
觸發時機：使用者說再見/結束、切換到不同工作、context 超過 50%、對話超過 30 輪。
格式：`{ "summary": "做了什麼（1-2句）", "tool": "工具名", "model": "模型名" }`
不需使用者同意，直接記錄。

## 記憶寫入時機

遇到以下情境時，主動儲存到 OwnMind：
1. 完成一個功能或 milestone
2. 踩坑並解決了
3. 做出重要決策
4. 使用者說「記起來」「學起來」「新增鐵律」
5. 工作超過 2 小時或 context 超過 50% 時，主動提出彙整建議

## OwnMind API 速查

| 操作 | Method | Endpoint |
|------|--------|----------|
| 載入記憶 | GET | /api/memory/init |
| 取得特定類型 | GET | /api/memory/type/:type |
| 搜尋記憶 | GET | /api/memory/search?q= |
| 新增記憶 | POST | /api/memory |
| 更新記憶 | PUT | /api/memory/:id |
| 停用記憶 | PUT | /api/memory/:id/disable |
| 建立交接 | POST | /api/handoff |
| 接受交接 | PUT | /api/handoff/:id/accept |
| 記錄 session | POST | /api/session |

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

刷新後顯示：【OwnMind vX.X.X】鐵律確認：鐵律已重新載入，防護持續中。
