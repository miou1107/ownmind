-- 一次性補齊 user_id=1 的缺編號鐵律
-- 按 created_at 順序，從 IR-014 開始
-- 執行前先用下方 SELECT 預覽確認

-- 預覽（先跑這段確認結果正確）：
-- WITH numbered AS (
--   SELECT id, title, ROW_NUMBER() OVER (ORDER BY created_at) + 13 AS new_num
--   FROM memories
--   WHERE user_id = 1 AND type = 'iron_rule' AND (code IS NULL OR code = '')
-- )
-- SELECT id, title, 'IR-' || LPAD(new_num::text, 3, '0') AS new_code
-- FROM numbered
-- ORDER BY new_num;

-- 正式執行：
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) + 13 AS new_num
  FROM memories
  WHERE user_id = 1 AND type = 'iron_rule' AND (code IS NULL OR code = '')
)
UPDATE memories m
SET code = 'IR-' || LPAD(n.new_num::text, 3, '0'),
    updated_at = NOW()
FROM numbered n
WHERE m.id = n.id;
