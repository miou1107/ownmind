# v1.20.3 — 規格：session 暫時關閉開關

## Scenario 1：寫狀態檔 → lint hook 在同 session 跳過

**GIVEN** session_id = "S1"
**AND** `ownmind_session_off` 被呼叫（帶 session_id="S1"）
**WHEN** Stop hook 跑、payload.session_id = "S1"
**THEN** hook 跳過 lint 檢查
**AND** hook exit code = 0
**AND** 狀態檔 `tick_count` 從 0 增加到 1

## Scenario 2：新 session 自動失效

**GIVEN** 狀態檔含 session_id="S1"
**WHEN** Stop hook 跑、payload.session_id = "S2"（不同 session）
**THEN** hook 視為已失效、正常跑 lint
**AND** 狀態檔被清除（白話：刪掉）

## Scenario 3：每 10 輪提醒

**GIVEN** 狀態檔的 tick_count = 9
**WHEN** Stop hook 跑、同 session
**THEN** tick_count 增加到 10
**AND** 嘗試用 `writeToTty` 寫提醒「⚠️ OwnMind 目前關閉中、請記得 /ownmind-on 重開（已關閉 10 輪）」

## Scenario 4：未達 10 輪不提醒

**GIVEN** 狀態檔的 tick_count = 5
**WHEN** Stop hook 跑、同 session
**THEN** tick_count 增加到 6
**AND** 不寫提醒

## Scenario 5：pre-commit hook 跳過

**GIVEN** 狀態檔存在、off_at 是 1 小時前
**WHEN** pre-commit hook 跑
**THEN** 跳過所有鐵律檢查
**AND** 印「⚠️ OwnMind 目前關閉中、commit 放行」
**AND** exit code = 0（放行 commit）

## Scenario 6：狀態檔過期（24 小時前）

**GIVEN** 狀態檔的 off_at 是 25 小時前
**WHEN** pre-commit hook 跑
**THEN** 視為失效、正常跑檢查
**AND** 狀態檔被清除

## Scenario 7：ownmind_session_on 清除狀態

**GIVEN** 狀態檔存在
**WHEN** `ownmind_session_on` 被呼叫
**THEN** 狀態檔被刪除
**AND** 回 ack 含「OwnMind 已重新開啟」

## Scenario 8：ownmind_session_off 已經是關閉狀態

**GIVEN** 狀態檔已存在、session_id="S1"
**WHEN** `ownmind_session_off` 又被呼叫（同 session_id="S1"）
**THEN** 狀態檔不變（tick_count 保留）
**AND** 回 ack 含「OwnMind 已經是關閉狀態」

## 非功能性需求

- **零外部依賴**：`session-off-state.js` 純函式、不引入新套件
- **檔案損毀防呆**：狀態檔 parse 失敗 → 視為失效、不 crash
- **目錄不存在自動建立**：`~/.ownmind/state/` 不存在時自動建（mkdir -p）
- **失敗安全**：所有 IO 失敗一律「fail open」（白話：寫不進去就當沒關閉、正常跑 lint）
