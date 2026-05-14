-- v1.19.0: memories 表加 tier 欄位給鐵律分級用
--
-- 為什麼：
--   v1.18.9 時鐵律已累積 41 條（IR-002 ~ IR-042），告警疲勞已經發生
--   （單次 session 啟動跳 13 條回話品質 lint 警告）。重要規則被次要規則稀釋、
--   IR-027「提醒無效、邏輯才有效」失效。
--
--   v1.19 把鐵律分成三級：
--     - critical（核心硬規則）— v1.20 起會被直接卡控
--     - default  （預設規則）  — 跳警告 + 寫違反紀錄
--     - advisory（純參考提示）— v1.20 起只寫紀錄、不跳警告
--
--   本版只做「掛標籤」、不動執行邏輯。v1.20 才會根據 tier 改卡控行為。
--
-- 對應規格：openspec/changes/v1.19-iron-rule-tier/spec.md 場景 1
--
-- 安全性：
--   - 純 ADD COLUMN IF NOT EXISTS + DEFAULT 'default'、不改既有資料
--   - 既有 41 條鐵律的 tier 全部會是 'default'、發版後管理員透過 admin UI
--     手動把 10 條核心規則升級為 critical（拍板名單：
--     IR-002 / 005 / 008 / 009 / 012 / 024 / 027 / 031 / 038 / 041）
--   - CHECK constraint 確保只能寫三個合法值
--   - 部分索引（PARTIAL INDEX）只覆蓋 type='iron_rule' 的列、避免污染其他 type
--   - migration 可重跑（IF NOT EXISTS）
--
-- 不做：
--   - 不對非鐵律的 memory 強制 tier（type='project' 等不需要分級）
--     → 應用層在 routes/memory.js 擋下「非鐵律設 tier」的請求
--   - 不自動分類既有鐵律（避免機器分錯）
--   - 不加 trigger 同步 tier 變動到 history（已有 memory_history 表覆蓋）

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'default';

-- CHECK constraint 分開加、避免 ADD COLUMN 已存在時跳過 constraint
-- （PostgreSQL ADD COLUMN IF NOT EXISTS 不會重跑 constraint 設定）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_tier_check'
  ) THEN
    ALTER TABLE memories
      ADD CONSTRAINT memories_tier_check
      CHECK (tier IN ('critical', 'default', 'advisory'));
  END IF;
END $$;

-- 部分索引：只覆蓋鐵律、給 admin 列表分組與 v1.20 卡控查詢加速
CREATE INDEX IF NOT EXISTS idx_memories_iron_rule_tier
  ON memories(tier)
  WHERE type = 'iron_rule';

-- ============================================================
-- Sanity check SQL（手動跑、確認 migration 成功）
-- ============================================================
--
-- 1. 確認欄位存在 + 預設值正確：
--    SELECT column_name, data_type, column_default
--      FROM information_schema.columns
--     WHERE table_name = 'memories' AND column_name = 'tier';
--    → 預期：tier | character varying | 'default'::character varying
--
-- 2. 確認既有鐵律全部是 default：
--    SELECT tier, COUNT(*) FROM memories
--     WHERE type = 'iron_rule' AND status = 'active'
--     GROUP BY tier;
--    → 預期：default | 41（或當前總數）
--
-- 3. 確認 CHECK constraint：
--    INSERT INTO memories (user_id, type, title, content, tier)
--      VALUES (1, 'iron_rule', 'test', 'test', 'invalid_value');
--    → 預期：ERROR check constraint memories_tier_check
--    （測完記得 rollback）
--
-- 4. 確認索引存在：
--    SELECT indexname FROM pg_indexes
--     WHERE tablename = 'memories' AND indexname = 'idx_memories_iron_rule_tier';
--    → 預期：idx_memories_iron_rule_tier
