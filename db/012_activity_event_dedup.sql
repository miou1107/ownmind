-- v1.17.98: activity_logs 加 client_event_id 給 client 端 dedup 用
--
-- 為什麼：v1.17.96 reply-lint Stop hook + v1.17.97 SessionStart flush helper
-- 兩個都會 POST /api/activity/batch 寫合規違反事件、有兩個 race 場景會造成
-- 同事件被寫進 DB 兩次（review I1）：
--
--   (a) hook POST 1500ms timeout 後 server 端 INSERT 仍可能完成、hook 看到
--       false 又 spool → SessionStart flush 撿走再送 → DB 兩筆
--   (b) 兩個 SessionStart 並發、雖然 v1.17.97 rename pattern 收窄、若 PENDING
--       被新寫入的時間窗剛好 + 第二個 flush 又 rename 成功 → 仍可能小機率重複
--
-- 解法：events 帶 client_event_id (uuid v4)、server 對 (user_id, client_event_id)
-- 加 partial unique index、INSERT 用 ON CONFLICT DO NOTHING。
-- 舊 client（沒帶 client_event_id）NULL 進來不受影響（partial index WHERE NOT NULL）。
--
-- IF NOT EXISTS：保險、重跑 migration 也安全
ALTER TABLE activity_logs
  ADD COLUMN IF NOT EXISTS client_event_id UUID;

-- partial unique index：只 enforce 在 client 有帶 id 的事件
-- 沒帶 id（舊 client / server 端 auto_observed_trigger / mcp/ownmind-log batch）
-- → 不影響、可重複寫
--
-- ⚠️ 安全性：第一次 deploy 時、所有舊 row 的 client_event_id 都是 NULL（剛新增）、
-- partial index 自然不會撞 unique violation、CREATE INDEX 一定能成功。
-- 未來若有人手動 backfill client_event_id 把舊 row 補上 → 必須先 dedupe
-- 同 (user_id, client_event_id) 的 row、否則這個 CREATE INDEX 會失敗。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_activity_logs_user_client_event
  ON activity_logs (user_id, client_event_id)
  WHERE client_event_id IS NOT NULL;
