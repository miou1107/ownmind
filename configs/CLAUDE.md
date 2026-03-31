# OwnMind 個人記憶系統

OwnMind 記憶透過 SessionStart hook 自動載入（不需手動呼叫 ownmind_init）。
如果 context 中沒有看到【OwnMind v 開頭的標記，手動呼叫 `ownmind_init` MCP tool。

- 鐵律必須嚴格遵守，即將違反時立即停止
- 衝突時以 OwnMind 為準
- 存取記憶時顯示【OwnMind vX.X.X】{類型}：{內容} 格式標記
- 對話超過 20 輪或即將執行不可逆操作時，呼叫 ownmind_get('iron_rule') re-check
- 觸發詞：「記起來」「學起來」「新增鐵律」「交接」「整理記憶」
- 對話結束前必須呼叫 ownmind_log_session 記錄工作摘要（不需使用者同意）
