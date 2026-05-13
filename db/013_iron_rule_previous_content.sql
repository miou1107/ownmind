-- v1.18.0: 加 previous_content 備援欄位給鐵律升級助手用
--
-- 為什麼：
--   v1.18.0 把鐵律從 free-text 升級成 SKILL.md 格式、會用「升級助手」Web UI
--   讓 Vin 手動 + AI 輔助批次轉舊鐵律。AI 提案可能歪、Vin 按確認後寫壞 DB
--   是小機率但嚴重的場景 — 鐵律 content 被改、原始語意丟失。
--
--   加 previous_content 欄位、PUT /memory/:id 改鐵律時自動備份原 content。
--   萬一升級助手寫壞、可從 previous_content 復原。
--
-- 觸發點：src/routes/memory.js PUT /memory/:id 的 UPDATE 加
--   `previous_content = CASE WHEN $7::boolean THEN content ELSE previous_content END`
--   只在 type='iron_rule' 且 content 真的改變時備份、避免無謂寫入。
--
-- 安全性：純 ADD COLUMN IF NOT EXISTS、不影響既有資料、無 reject 風險。
--   既有 35 條鐵律 previous_content 預設 NULL、第一次更新後才填。
--
-- 不做：
--   - 不加 history depth（多版本歷史已由 memory_history table 提供）
--   - 不加 trigger 自動寫（用 application-level UPDATE 控制更彈性）

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS previous_content TEXT;
