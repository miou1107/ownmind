import { useT } from '../../i18n/LocaleContext';
import useMeReport from './useMeReport.js';
import UsageRangeBar, { ReportState } from './UsageRangeBar.jsx';
import UsageProjects from '../Portal/UsageProjects.jsx';

// v1.32.4 — 用量與規矩 › 專案. The project table from /api/me/report: sessions, turns,
// handoffs and who worked on each; a row opens the detail.
export default function UsageProjectsPage() {
  const t = useT();
  const { data, loading, loadError, rangeBar } = useMeReport();
  return (
    <div className="max-w-6xl space-y-6">
      <p className="text-sm text-slate-500">{t('usage.projects.intro')}</p>
      <UsageRangeBar bar={rangeBar} />
      <ReportState loading={loading} loadError={loadError} data={data}>
        <UsageProjects projects={data?.projects} />
      </ReportState>
    </div>
  );
}
