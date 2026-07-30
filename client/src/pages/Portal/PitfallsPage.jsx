import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { fmtDate } from '../../utils/fmtDate';

// 踩坑紀錄 — 從舊的 /me/ 「踩坑紀錄」頁搬過來
//
// GET /api/me/pitfalls?window=7d|30d|90d|all，回三個區塊：
//   unobserved      鐵律被觸發但伺服器沒留稽核紀錄（系統層問題）
//   unverified      系統看到了、但 AI 沒主動回報遵守（AI 行為問題）
//   orphan_session  五輪以上的 session 整段沒有任何遵守紀錄
//
// 刻意對所有人開放，跟舊頁一樣：這些是系統或 AI 行為的問題，不是個人隱私，而且
// 只有橫跨所有人看才看得出模式。
//
// 每一列四個欄位：時間 / 發生什麼 / 影響 / 怎麼處理。fix_hint 常常是「這是歷史殘留、
// 不需要處理」，所以一定要顯示，不然每個人都會想去手動補資料。

const WINDOWS = ['7d', '30d', '90d', 'all'];
const KINDS = ['unobserved', 'unverified', 'orphan_session'];

const KIND_TONE = {
  unobserved: 'border-rose-200 bg-rose-50 text-rose-800',
  unverified: 'border-amber-200 bg-amber-50 text-amber-800',
  orphan_session: 'border-slate-200 bg-slate-50 text-slate-700',
};

export default function PitfallsPage() {
  const t = useT();
  const { locale } = useLocale();

  const [window_, setWindow] = useState('30d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError('');
    (async () => {
      const r = await apiGet(`/api/me/pitfalls?window=${encodeURIComponent(window_)}`);
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
  }, [window_]);

  const sections = data?.sections;
  const total = sections
    ? KINDS.reduce((sum, k) => sum + (sections[k]?.count || 0), 0)
    : 0;

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('pitfalls.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('pitfalls.subtitle')}</p>

      <div className="mt-4 inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWindow(w)}
            className={
              'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors '
              + (window_ === w ? 'bg-sage-600 text-white' : 'text-slate-600 hover:bg-slate-100')
            }
          >
            {t(`pitfalls.window.${w}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="mt-6 text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : !sections ? (
        <p className="mt-6 text-slate-500">{t('common.empty')}</p>
      ) : total === 0 ? (
        <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {t('pitfalls.all_clear')}
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {KINDS.map((kind) => (
            <PitfallSection
              key={kind}
              kind={kind}
              section={sections[kind]}
              locale={locale}
            />
          ))}
        </div>
      )}

      {data?.generated_at && (
        <p className="mt-6 text-xs text-slate-400">
          {t('narrative.generated_at', { at: fmtDate(data.generated_at, locale) })}
        </p>
      )}
    </div>
  );
}

function PitfallSection({ kind, section, locale }) {
  const t = useT();
  const rows = section?.rows || [];

  return (
    <section>
      <h2 className="text-sm font-bold text-slate-900 mb-1 flex items-center gap-2">
        {t(`pitfalls.kind.${kind}`)}
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 tabular-nums">
          {section?.count ?? 0}
        </span>
      </h2>
      <p className="text-xs text-slate-500 mb-2">{t(`pitfalls.kind_hint.${kind}`)}</p>

      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">{t('pitfalls.none_in_window')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li
              key={`${r.type}-${r.raw?.id ?? i}`}
              className={`rounded-xl border px-4 py-3 ${KIND_TONE[kind]}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-xs tabular-nums opacity-70">
                  {r.when ? fmtDate(r.when, locale) : '-'}
                </span>
                {r.user_name && (
                  <span className="text-xs font-semibold opacity-80">{r.user_name}</span>
                )}
              </div>
              <p className="mt-1 text-sm font-semibold break-all">{r.what}</p>
              {r.impact && (
                <p className="mt-1 text-xs leading-relaxed opacity-90">
                  {t('pitfalls.impact', { text: r.impact })}
                </p>
              )}
              {r.fix_hint && (
                <p className="mt-1 text-xs leading-relaxed opacity-75">
                  {t('pitfalls.fix_hint', { text: r.fix_hint })}
                </p>
              )}
              {r.raw?.summary && (
                <p className="mt-1 text-xs italic opacity-60 break-all">{r.raw.summary}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
