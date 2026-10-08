import { useT } from '../../i18n/LocaleContext';
import useMeReport from './useMeReport.js';
import UsageRangeBar, { ReportState } from './UsageRangeBar.jsx';
import UsageTeam from '../Portal/UsageTeam.jsx';

// v1.32.4 — 用量與規矩 › 全隊 (admin). The team half of /api/me/report: per-member
// totals, the daily trend, and when in the day and the week the team talks to the AI.
// The per-member ranking with coverage stays at 團隊 › 用量排行 until Phase 5 folds it
// into 成員.
export default function UsageTeamPage() {
  const t = useT();
  const { data, loading, loadError, rangeBar } = useMeReport();
  return (
    <div className="max-w-6xl space-y-6">
      <p className="text-sm text-slate-500">{t('usage.team.intro')}</p>
      <UsageRangeBar bar={rangeBar} />
      <ReportState loading={loading} loadError={loadError} data={data}>
        <UsageTeam team={data?.team} />
      </ReportState>
    </div>
  );
}
