-- v1.19.2: schema_migrations 追蹤表
--
-- 為什麼：
--   v1.19.0 把 014_iron_rule_tier.sql commit 進 repo、但發版時沒人記得手動
--   `psql -f` 套上 prod、結果 memories 表少了 tier 欄位、所有 ownmind_save
--   回 500。追了半小時才發現是 schema mismatch。
--
--   docker-compose 的 docker-entrypoint-initdb.d/ 只在 volume 首次初始化時
--   跑、後續 14 個 migration 全部要手動跑、靠人工記憶 = 必踩坑。
--
--   v1.19.2 引入 schema_migrations 表 + run-migrations.sh runner、deploy 時
--   自動偵測未套用 migration、自動跑、不再依賴人工記得。
--
-- 對應規格：openspec/changes/v1.19.2-auto-migration/spec.md 場景 1 ~ 9
-- 對應鐵律：IR-027 邏輯才有效、IR-048 deploy 必須跑 db/ 下未套用 migration
--
-- 安全性：
--   - 純 CREATE TABLE IF NOT EXISTS、不動既有資料
--   - 首次跑會自己 INSERT 自己這筆（self-record）
--   - 後續重跑 IF NOT EXISTS 確保 idempotent、ON CONFLICT DO NOTHING 確保不重覆寫
--
-- 不做：
--   - 不寫 down migration（OwnMind 從來沒做過、暫不規劃）
--   - 不加 trigger / function、保持表單純


CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  applied_by VARCHAR(100) DEFAULT 'auto'
);

-- Self-record：015 跑完自己也要寫一筆、否則下次 runner 會誤判 015 沒套用
INSERT INTO schema_migrations (filename, applied_by)
VALUES ('015_schema_migrations_table.sql', 'auto')
ON CONFLICT (filename) DO NOTHING;


-- ============================================================
-- Sanity check SQL（手動跑、確認 migration 成功）
-- ============================================================
--
-- 1. 確認表存在：
--    \d schema_migrations
--    → 預期：3 個欄位 filename / applied_at / applied_by
--
-- 2. 確認自己這筆有寫入：
--    SELECT * FROM schema_migrations WHERE filename = '015_schema_migrations_table.sql';
--    → 預期：1 筆、applied_by='auto'
--
-- 3. 重跑這條 SQL → 確認 idempotent：
--    psql -f db/015_schema_migrations_table.sql
--    → 預期：CREATE TABLE notice（已存在跳過）、INSERT 0 1（conflict do nothing）
--    SELECT COUNT(*) FROM schema_migrations WHERE filename='015_schema_migrations_table.sql';
--    → 預期：仍為 1
