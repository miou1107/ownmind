import { useT } from '../../i18n/LocaleContext';
import useMeReport from './useMeReport.js';
import UsageRangeBar, { ReportState } from './UsageRangeBar.jsx';
import UsageMine from '../Portal/UsageMine.jsx';

// v1.32.4 — 用量與規矩 › 我的對話. The personal half of /api/me/report, under the shared
// range bar. The content block (UsageMine) is the one the old usage page showed, plus the
// daily chart and the 連的主機 column it gained in this release.
export default function UsageMinePage() {
  const t = useT();
  const { data, loading, loadError, rangeBar } = useMeReport();
  return (
    <div className="max-w-6xl space-y-6">
      <p className="text-sm text-slate-500">{t('usage.mine.intro')}</p>
      <UsageRangeBar bar={rangeBar} />
      <ReportState loading={loading} loadError={loadError} data={data}>
        <UsageMine me={data?.me} />
      </ReportState>
    </div>
  );
}
