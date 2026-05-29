#!/bin/bash
# scripts/health-report-daily.sh
#
# Purpose: OwnMind product health daily report (Track C phase A prototype).
#          Does NOT compute ratios — only absolute numbers — to avoid being misled by
#          cold-start divide-by-zero / insufficient-sample issues.
#
# Usage:
#   bash scripts/health-report-daily.sh              # print to stdout
#   bash scripts/health-report-daily.sh > report.md  # save to file
#
# Why this design (based on three rounds of Gemini r1+r2+r3 review + real prod data):
#   - Ratio metrics are meaningless when users < 10 and samples < 100.
#   - Look at absolute trigger counts / triggered-rule coverage / violation breakdown instead.
#   - Once data accumulates over 2-3 months, switch to ratios.

set -euo pipefail

DATE=$(date +%F)
HOST="${OWNMIND_PROD_HOST:-root@YOUR_PROD_HOST}"

cat <<HEADER
# OwnMind health report — $DATE

_Data source: ${HOST} prod, last 7 days._

HEADER

ssh "$HOST" bash <<'REMOTE_EOF'
cd /VinService/ownmind
docker compose exec -T db psql -U ownmind -d ownmind <<'PSQL_EOF'
\pset format aligned
\pset border 2
\pset null '—'

\echo '## 1. Core metrics (absolute counts)'
\echo
SELECT
  metric AS "Metric",
  value AS "Value"
FROM (
  SELECT 1 AS sort_order, 'Violations (violate)' AS metric,
    COUNT(*)::text AS value
  FROM activity_logs
  WHERE event='iron_rule_compliance' AND details->>'action'='violate'
    AND ts > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 2, 'Compliance (comply)',
    COUNT(*)::text
  FROM activity_logs
  WHERE event='iron_rule_compliance' AND details->>'action'='comply'
    AND ts > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 3, 'Skips (skip)',
    COUNT(*)::text
  FROM activity_logs
  WHERE event='iron_rule_compliance' AND details->>'action'='skip'
    AND ts > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 4, 'Distinct triggered rules',
    COUNT(DISTINCT details->>'rule_code')::text
  FROM activity_logs
  WHERE event='iron_rule_compliance' AND ts > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 5, 'Active iron rules total',
    COUNT(*)::text
  FROM memories WHERE type='iron_rule' AND status='active'
  UNION ALL
  SELECT 6, 'Active users (week)',
    COUNT(DISTINCT user_id)::text
  FROM activity_logs WHERE ts > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 7, 'Active users (day)',
    COUNT(DISTINCT user_id)::text
  FROM activity_logs WHERE ts > NOW() - INTERVAL '1 day'
) t
ORDER BY sort_order;

\echo
\echo '## 2. Violations breakdown (last 7 days)'
\echo
SELECT
  COALESCE(details->>'rule_code', '(no code)') AS "Rule",
  LEFT(COALESCE(details->>'rule_title', '—'), 40) AS "Title",
  COUNT(*) AS "Violations",
  MAX(ts)::date AS "Latest violation"
FROM activity_logs
WHERE event='iron_rule_compliance'
  AND details->>'action'='violate'
  AND ts > NOW() - INTERVAL '7 days'
GROUP BY details->>'rule_code', details->>'rule_title'
ORDER BY COUNT(*) DESC, MAX(ts) DESC;

\echo
\echo '## 3. Triggered but 0 violations in 7 days (silent enforcement)'
\echo
SELECT
  COALESCE(details->>'rule_code', '(no code)') AS "Rule",
  LEFT(COALESCE(details->>'rule_title', '—'), 40) AS "Title",
  COUNT(*) AS "Compliance"
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
\echo '## 4. Never triggered in 30 days (dead rules — review)'
\echo
SELECT
  COALESCE(m.code, '(no code)') AS "Rule code",
  LEFT(m.title, 40) AS "Title",
  m.created_at::date AS "Created"
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
\echo '## 5. Tool trigger distribution (last 7 days)'
\echo
SELECT
  COALESCE(tool, '(no tool)') AS "Tool",
  COUNT(*) AS "Events",
  COUNT(DISTINCT user_id) AS "Users"
FROM activity_logs
WHERE ts > NOW() - INTERVAL '7 days'
GROUP BY tool
ORDER BY COUNT(*) DESC;

\echo
\echo '## 6. Abnormal events (usage_audit_log, last 7 days, excluding unknown_model)'
\echo
SELECT
  event_type AS "Event type",
  COUNT(*) AS "Count",
  COUNT(DISTINCT user_id) AS "Affected users",
  MIN(ts)::date AS "Earliest",
  MAX(ts)::date AS "Latest"
FROM usage_audit_log
WHERE ts > NOW() - INTERVAL '7 days'
  AND event_type <> 'unknown_model'
GROUP BY event_type
ORDER BY COUNT(*) DESC;
PSQL_EOF
REMOTE_EOF

cat <<FOOTER

---

## Reading notes

- **Ratio metrics not computed**: while users < 10 and samples < 100 per rule, ratios get
  distorted by cold-start.
- **Dead rules (section 4) deserve attention**: 0 triggers in 30 days → either disable, or
  adjust the trigger conditions.
- **Abnormal events (section 6)**: 4 formal security alerts not yet implemented;
  usage_audit_log is currently mostly token-pricing audit data.

Next: re-run in two weeks and see whether the sample has accumulated enough for ratios.
FOOTER
