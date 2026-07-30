import { useState, useEffect, useMemo } from 'react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import UsageMine from './UsageMine';
import UsageTeam from './UsageTeam';
import UsageProjects from './UsageProjects';
import AuditFindings from './AuditFindings';

// 用量分析頁 — Portal 招牌頁
// 三分頁標籤（個人 / 團隊 / 專案）+ 頂部時段切換條（7d / 14d / 30d / all / 自訂區間）
// 接口：GET /api/me/report?range={range} 或 ?start=&end=、回 { me, team, projects }
//
// 設計說明：
//   - FilterBar 是「日期 + 專案 + 關鍵字」介面、跟用量頁切時段的需求不符
//     → 在頁面內做小元件「時段切換條」、不重用 FilterBar 避免硬塞
//   - range 變化會重新打 API；tab 切換不重新打（資料一次拿完）
//   - v1.26.46 補上自訂區間。伺服器早就支援 ?start=&end=（src/routes/me.js），只有舊的
//     /me/ 頁有介面，新後台漏掉了。effect 依賴「算好的查詢字串」，所以自訂日期填一半
//     不會打出半套請求
//   - v1.26.46 補上資料品質警示（audit_findings）。它警告的是「下面的數字可能不完整」，
//     所以放在分頁標籤上面、不是塞進個人那一頁

const RANGES = ['7d', '14d', '30d', 'all'];
const TABS = ['mine', 'team', 'projects'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function UsagePage() {
  const t = useT();

  const [tab, setTab] = useState('mine');
  const [range, setRange] = useState('14d');
  const [custom, setCustom] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const customComplete = ISO_DATE.test(start) && ISO_DATE.test(end);
  const customReversed = customComplete && start > end;
  const customUsable = customComplete && !customReversed;

  // 查詢字串就是「要不要重新打」的唯一依據
  const queryString = useMemo(
    () => (custom && customUsable
      ? `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
      : `range=${encodeURIComponent(range)}`),
    [custom, customUsable, start, end, range],
  );

  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError('');
    (async () => {
      const r = await apiGet(`/api/me/report?${queryString}`);
      if (!current) return;
      setLoading(false);
      if (!r.ok) {
        setLoadError(r.error || 'load_failed');
        setData(null);
        return;
      }
      setData(r.data || null);
    })();
    return () => { current = false; };
  }, [queryString]);

  return (
    <div className="max-w-6xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('usage.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('usage.subtitle')}</p>

      {/* 時段切換條 */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => { setCustom(false); setRange(r); }}
              className={
                'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors '
                + (!custom && range === r
                  ? 'bg-sage-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100')
              }
            >
              {t(`usage.range.${r}`)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCustom(true)}
            className={
              'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors '
              + (custom ? 'bg-sage-600 text-white' : 'text-slate-600 hover:bg-slate-100')
            }
          >
            {t('usage.range.custom')}
          </button>
        </div>

        {custom && (
          <div className="inline-flex items-center gap-2 text-xs text-slate-600">
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              aria-label={t('usage.range.start')}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 shadow-sm"
            />
            <span className="text-slate-400">～</span>
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              aria-label={t('usage.range.end')}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 shadow-sm"
            />
          </div>
        )}
      </div>

      {custom && !customComplete && (
        <p className="mt-2 text-xs text-slate-500">{t('usage.range.pick_both')}</p>
      )}
      {customReversed && (
        <p role="alert" className="mt-2 text-xs text-rose-600">{t('usage.range.reversed')}</p>
      )}

      {/* 資料品質警示 — 警告下面的數字可能不完整，所以放在標籤條上面 */}
      <AuditFindings findings={data?.me?.audit_findings} />

      {/* 分頁標籤條 */}
      <div className="mt-4 border-b border-slate-200 flex gap-1">
        {TABS.map((tb) => (
          <button
            key={tb}
            type="button"
            onClick={() => setTab(tb)}
            className={
              'px-4 py-2 text-sm font-semibold border-b-2 transition-colors -mb-px '
              + (tab === tb
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
