#!/bin/bash
# scripts/health-report-daily.sh
#
# 目的：OwnMind 產品健康度日報（路線 C 階段 A 雛形）
#       不算比例、只看絕對數字、避免冷啟動下被分母為 0 / 樣本不足誤導
#
# 用法：
#   bash scripts/health-report-daily.sh              # 印到 stdout
#   bash scripts/health-report-daily.sh > report.md  # 存檔
#
# 為什麼這樣設計（基於 Gemini r1+r2+r3 三輪 review + prod 真實資料）：
#   - 比例指標在 user < 10、樣本 < 100 時毫無意義
#   - 改看絕對觸發次數 / 觸發鐵律覆蓋數 / 違反明細
#   - 等資料累積 2~3 個月後再算比例

set -euo pipefail

DATE=$(date +%F)
HOST="${OWNMIND_PROD_HOST:-root@kkvin.com}"

cat <<HEADER
# OwnMind 健康度日報 — $DATE

_資料來源：${HOST} prod、過去 7 天_

HEADER

ssh "$HOST" bash <<'REMOTE_EOF'
cd /VinService/ownmind
docker compose exec -T db psql -U ownmind -d ownmind <<'PSQL_EOF'
\pset format aligned
\pset border 2
\pset null '—'

\echo '## 1. 核心指標（絕對數字）'
\echo
SELECT
  metric AS "指標",
  value AS "值"
FROM (
  SELECT 1 AS sort_order, '違反次數 (violate)' AS metric,
    COUNT(*)::text AS value
  FROM activity_logs
  WHERE event='iron_rule_compliance' AND details->>'action'='violate'
    AND ts > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 2, '遵守次數 (comply)',
    COUNT(*)::text
  FROM activity_logs
  WHERE event='iron_rule_compliance' AND details->>'action'='comply'
    AND ts > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 3, '跳過次數 (skip)',
    COUNT(*)::text
  FROM activity_logs
  WHERE event='iron_rule_compliance' AND details->>'action'='skip'
    AND ts > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 4, '觸發鐵律覆蓋數 (distinct rules)',
    COUNT(DISTINCT details->>'rule_code')::text
  FROM activity_logs
  WHERE event='iron_rule_compliance' AND ts > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 5, '啟用中鐵律總數',
    COUNT(*)::text
  FROM memories WHERE type='iron_rule' AND status='active'
  UNION ALL
  SELECT 6, '活躍 user 數 (週)',
    COUNT(DISTINCT user_id)::text
  FROM activity_logs WHERE ts > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 7, '活躍 user 數 (日)',
    COUNT(DISTINCT user_id)::text
  FROM activity_logs WHERE ts > NOW() - INTERVAL '1 day'
) t
ORDER BY sort_order;

\echo
\echo '## 2. 過去 7 天違反明細'
\echo
SELECT
  COALESCE(details->>'rule_code', '(無 code)') AS "鐵律",
  LEFT(COALESCE(details->>'rule_title', '—'), 40) AS "標題",
  COUNT(*) AS "違反次數",
  MAX(ts)::date AS "最近違反"
FROM activity_logs
WHERE event='iron_rule_compliance'
  AND details->>'action'='violate'
  AND ts > NOW() - INTERVAL '7 days'
GROUP BY details->>'rule_code', details->>'rule_title'
ORDER BY COUNT(*) DESC, MAX(ts) DESC;

\echo
\echo '## 3. 過去 7 天觸發但 0 違反的鐵律（靜默生效）'
\echo
SELECT
  COALESCE(details->>'rule_code', '(無 code)') AS "鐵律",
  LEFT(COALESCE(details->>'rule_title', '—'), 40) AS "標題",
  COUNT(*) AS "遵守次數"
FROM activity_logs
WHERE event='iron_rule_compliance'
  AND details->>'action'='comply'
  AND ts > NOW() - INTERVAL '7 days'
  AND details->>'rule_code' NOT IN (
    SELECT DISTINCT details->>'rule_code'
    FROM activity_logs
    WHERE event='iron_rule_compliance'
      AND details->>'action'='violate'
      AND ts > NOW() - INTERVAL '7 days'
      AND details->>'rule_code' IS NOT NULL
  )
GROUP BY details->>'rule_code', details->>'rule_title'
ORDER BY COUNT(*) DESC
LIMIT 15;

\echo
\echo '## 4. 從沒觸發過的鐵律（過去 30 天死規則、要評估）'
\echo
SELECT
  COALESCE(m.code, '(無 code)') AS "鐵律 code",
  LEFT(m.title, 40) AS "標題",
  m.created_at::date AS "建立日"
FROM memories m
WHERE m.type='iron_rule' AND m.status='active'
  AND NOT EXISTS (
    SELECT 1 FROM activity_logs al
    WHERE al.event='iron_rule_compliance'
      AND al.details->>'rule_code' = m.code
      AND al.ts > NOW() - INTERVAL '30 days'
  )
ORDER BY m.created_at;

\echo
\echo '## 5. 過去 7 天各 tool 觸發分布'
\echo
SELECT
  COALESCE(tool, '(無 tool)') AS "工具",
  COUNT(*) AS "事件數",
  COUNT(DISTINCT user_id) AS "user 數"
FROM activity_logs
WHERE ts > NOW() - INTERVAL '7 days'
GROUP BY tool
ORDER BY COUNT(*) DESC;

\echo
\echo '## 6. 異常事件（usage_audit_log、過去 7 天、排除 unknown_model）'
\echo
SELECT
  event_type AS "事件類型",
  COUNT(*) AS "件數",
  COUNT(DISTINCT user_id) AS "影響 user 數",
  MIN(ts)::date AS "最早",
  MAX(ts)::date AS "最近"
FROM usage_audit_log
WHERE ts > NOW() - INTERVAL '7 days'
  AND event_type <> 'unknown_model'
GROUP BY event_type
ORDER BY COUNT(*) DESC;
PSQL_EOF
REMOTE_EOF

cat <<FOOTER

---

## 解讀提示

- **比例指標目前不計算**：user 數 < 10、樣本 < 100 / 鐵律的階段、比例會被冷啟動誤導
- **死規則（section 4）值得關注**：30 天 0 觸發 → 該 disable 還是該調整觸發條件
- **異常事件（section 6）**：4 種正式安全告警尚未實作、目前 usage_audit_log 主要是 token pricing 稽核

下一步：兩週後再跑一次、看樣本是否累積到可以算比例。
FOOTER
