import { useState, useEffect } from 'react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import UsageMine from './UsageMine';
import UsageTeam from './UsageTeam';
import UsageProjects from './UsageProjects';

// 用量分析頁 — Portal 招牌頁
// 三分頁標籤（個人 / 團隊 / 專案）+ 頂部時段切換條（7d / 14d / 30d / all）
// 接口：GET /api/me/report?range={range}、回 { me, team, projects }
//
// 設計說明：
//   - FilterBar 是「日期 + 專案 + 關鍵字」介面、跟用量頁切時段的需求不符
//     → 在頁面內做小元件「時段切換條」、不重用 FilterBar 避免硬塞
//   - range 變化會重新打 API；tab 切換不重新打（資料一次拿完）

const RANGES = ['7d', '14d', '30d', 'all'];
const TABS = ['mine', 'team', 'projects'];

export default function UsagePage() {
  const t = useT();

  const [tab, setTab] = useState('mine');
  const [range, setRange] = useState('14d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      const r = await apiGet(`/api/me/report?range=${encodeURIComponent(range)}`);
      if (aborted) return;
      setLoading(false);
      if (!r.ok) {
        setLoadError(r.error || 'load_failed');
        setData(null);
        return;
      }
      setData(r.data || null);
    })();
    return () => { aborted = true; };
  }, [range]);

  return (
    <div className="max-w-6xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('usage.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('usage.subtitle')}</p>

      {/* 時段切換條 */}
      <div className="mt-4 inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            className={
              'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ' +
              (range === r
                ? 'bg-sage-600 text-white'
                : 'text-slate-600 hover:bg-slate-100')
            }
          >
            {t(`usage.range.${r}`)}
          </button>
        ))}
      </div>

      {/* 分頁標籤條 */}
      <div className="mt-4 border-b border-slate-200 flex gap-1">
        {TABS.map((tb) => (
          <button
            key={tb}
            type="button"
            onClick={() => setTab(tb)}
            className={
              'px-4 py-2 text-sm font-semibold border-b-2 transition-colors -mb-px ' +
              (tab === tb
                ? 'border-sage-600 text-sage-700'
                : 'border-transparent text-slate-500 hover:text-slate-700')
            }
          >
            {t(`usage.tab.${tb}`)}
          </button>
        ))}
      </div>

      {/* 內容區 */}
      <div className="mt-6">
        {loading ? (
          <p className="text-slate-500">{t('common.loading')}</p>
        ) : loadError ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {loadError === 'load_failed' ? t('common.error_load') : loadError}
          </div>
        ) : !data ? (
          <p className="text-slate-500">{t('common.empty')}</p>
        ) : tab === 'mine' ? (
          <UsageMine me={data.me} />
        ) : tab === 'team' ? (
          <UsageTeam team={data.team} />
        ) : (
          <UsageProjects projects={data.projects} />
        )}
      </div>
    </div>
  );
}
