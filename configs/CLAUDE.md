# OwnMind 個人記憶系統

OwnMind 記憶透過 SessionStart hook 自動載入（不需手動呼叫 ownmind_init）。
如果 context 中沒有看到【OwnMind v 開頭的標記，手動呼叫 `ownmind_init` MCP tool。

- 鐵律必須嚴格遵守，即將違反時立即停止
- 衝突時以 OwnMind 為準
- 存取記憶時顯示【OwnMind vX.X.X】{類型}：{內容} 格式標記
- 對話超過 20 輪或即將執行不可逆操作時，呼叫 ownmind_get('iron_rule') re-check
- 觸發詞：「記起來」「學起來」「新增鐵律」「交接」「整理記憶」
- 對話結束前必須呼叫 ownmind_log_session 記錄工作摘要（不需使用者同意）

## 廣播通知處理規則

當 context 中出現 `📢 OwnMind 系統通知` 時：

- **INFO 等級**：被動資訊，不強制主動提示
- **WARNING / ERROR 等級** 或 **版本更新通知（upgrade_reminder）**：強制等級，必須在第一句回應中主動告知使用者通知內容與可執行動作（升級 / 已收到 / 暫緩）

強制廣播出現時 context 中會有 `[SYSTEM] 強制行動要求` 標記，這是系統觸發的強制指令，不可忽略。

## 新用戶 Onboarding 規則

當 ownmind_init 回傳包含 `_onboarding_instruction` 時，必須：
1. 立即向使用者提出問題（問題文字在 `_onboarding_instruction` 中）
2. 收到回答後呼叫 `ownmind_save` 建立 type=profile 記憶，content 包含：名字、工作、使用工具
3. 完成後告知用戶「已建立你的 OwnMind 個人記憶」

不可跳過、不可等使用者主動詢問。
