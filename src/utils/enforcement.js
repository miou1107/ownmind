const SEVERITY_ORDER = { critical: 0, warning: 1, notice: 2 };

const MESSAGES = {
  critical: (title, code, vc, tc, rate) =>
    `🚨 嚴重警告：你反覆違反「${title}」（${vc}/${tc} 次，${rate}%）。這條鐵律你已經證明自己容易犯錯。在本次 session 中，每次涉及相關操作時，你必須停下來逐字確認是否違反。不確認就執行 = 再次違反。`,
  warning: (title, code, vc) =>
    `⚠️ 警告：你曾違反「${title}」（${vc} 次）。觸發此鐵律時，必須明確說出「我確認沒有違反 ${code}」再繼續。`,
  notice: (title) =>
    `📌 注意：「${title}」曾被違反。觸發時務必確認遵守。`,
};

export function computeEnforcementAlerts(complianceData, lastSessionViolations = []) {
  const byRule = {};
  for (const row of complianceData) {
    const key = row.rule_title;
    if (!byRule[key]) {
      byRule[key] = { rule_title: key, rule_code: row.rule_code || 'IR-?', violate: 0, comply: 0, skip: 0 };
    }
    const count = parseInt(row.count, 10) || 0;
    if (row.action === 'violate') byRule[key].violate += count;
    else if (row.action === 'comply') byRule[key].comply += count;
    else if (row.action === 'skip') byRule[key].skip += count;
  }

  const alerts = [];
  for (const r of Object.values(byRule)) {
    if (r.violate === 0) continue;
    const total = r.violate + r.comply + r.skip;
    const rate = Math.round((r.violate / total) * 100);
    const consecutiveViolation = lastSessionViolations.includes(r.rule_code);

    let severity;
    if (rate >= 50 || consecutiveViolation) severity = 'critical';
    else if (rate >= 25) severity = 'warning';
    else severity = 'notice';

    alerts.push({
      rule_code: r.rule_code,
      rule_title: r.rule_title,
      violation_count: r.violate,
      total_count: total,
      violation_rate: rate,
      severity,
      reinforcement_message: MESSAGES[severity](r.rule_title, r.rule_code, r.violate, total, rate),
    });
  }

  alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return alerts;
}
