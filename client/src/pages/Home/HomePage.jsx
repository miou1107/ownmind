import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { useSession } from '../../session/SessionContext';
import { apiGet } from '../../api';
import { DailyChart } from '../Team/charts.jsx';
import { lightsVm, pendingVm, tilesVm, dailyVm } from './overview-vm.js';

// v1.32.2, Phase 2 — 總覽：三個狀態燈、等你處理、四張數字卡、每天幾場對話。
//
// 一支 API（/api/me/overview）餵整頁；它只是把後台別處已經在算的數字合在一起，沒有新的
// 量測。每個燈、每張卡旁邊都有一句話說要不要做什麼；伺服器沒有的數字顯示「沒有資料」，
// 不顯示 0。文案跟 2026-10-04 的原型一致，主詞是你、AI 或 OwnMind。

const RANGES = [7, 14, 30];

const DOT = {
  good: 'bg-emerald-500 ring-emerald-100',
  warn: 'bg-amber-500 ring-amber-100',
  bad: 'bg-rose-500 ring-rose-100',
  none: 'bg-slate-300 ring-slate-100',
};

const TONE = {
  up: 'text-emerald-600',
  down: 'text-rose-600',
  flat: 'text-slate-500',
  none: 'text-slate-400',
};

function fmtTime(iso, t) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return t('home.no_data');
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `${t('home.time.today')} ${hm}`;
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `${t('home.time.yesterday')} ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export default function HomePage() {
  const t = useT();
  const { role, name } = useSession();
  const [range, setRange] = useState(7);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    (async () => {
      const r = await apiGet(`/api/me/overview?range=${range}`);
      if (aborted) return;
      setLoading(false);
      if (!r.ok) { setLoadError(r.error || 'load_failed'); setData(null); return; }
      setLoadError('');
      setData(r.data);
    })();
    return () => { aborted = true; };
  }, [range]);

  const lights = lightsVm(data, t, { role });
  const pending = pendingVm(data, t);
  const tiles = tilesVm(data, t, { role });
  const daily = dailyVm(data);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">
            {name ? t('home.greeting').replace('{name}', name) : t('nav.home')}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">{t('home.subtitle')}</p>
        </div>
        <div className="inline-flex rounded-lg border border-slate-200 bg-white overflow-hidden" role="group" aria-label={t('home.range')}>
          {RANGES.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setRange(d)}
              aria-pressed={range === d}
              className={`px-3 py-1.5 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-sage-500 ${
                range === d ? 'bg-sage-500 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {t('home.range.days').replace('{n}', d)}
            </button>
          ))}
        </div>
      </div>

      {loadError && (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      )}

      {/* 三個燈 */}
      <section aria-label={t('home.lights')} className="grid gap-3 md:grid-cols-3">
        {lights.map((l) => (
          <div key={l.id} className="bg-white border border-slate-200 rounded-2xl p-4 flex gap-3 items-start shadow-sm">
            <span aria-hidden="true" className={`mt-1.5 w-3 h-3 rounded-full ring-4 shrink-0 ${DOT[l.state]}`} />
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-900">{l.title}</p>
              <p className="text-xs text-slate-600 mt-0.5">{loading && !data ? t('common.loading') : l.text}</p>
              {l.action && !loading && (
                <Link to={l.action.to} className="inline-block mt-2 text-xs font-semibold text-sage-700 hover:underline">
                  {l.action.label}
                </Link>
              )}
            </div>
          </div>
        ))}
      </section>

      {/* 等你處理 */}
      <section className="bg-white border border-slate-200 rounded-2xl shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <h2 className="text-sm font-bold text-slate-900">{t('home.pending')}</h2>
          <Link to="/inbox" className="text-xs font-semibold text-sage-700 hover:underline">{t('home.pending.open_all')}</Link>
        </div>
        {loading && !data ? (
          <p className="px-4 py-6 text-sm text-slate-500">{t('common.loading')}</p>
        ) : pending.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500 text-center">{t('home.pending.empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {pending.map((row) => (
              <li key={row.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[200px]">
                  <p className="text-sm font-medium text-slate-900">{row.text}</p>
                  {row.detail && <p className="text-xs text-slate-500 mt-0.5 break-words">{row.detail}</p>}
                </div>
                <Link
                  to={row.to}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-sage-500 text-white text-xs font-semibold hover:bg-sage-600 focus-visible:outline-2 focus-visible:outline-sage-500"
                >
                  {row.action} <ArrowRight size={12} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 四張卡 */}
      <section aria-label={t('home.tiles')} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.id} className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm min-w-0">
            <p className="text-xs font-semibold text-slate-500">{tile.label}</p>
            <p className={`font-bold text-slate-900 mt-1 truncate ${tile.small || tile.tone === 'none' ? 'text-lg' : 'text-3xl tabular-nums'}`}>
              {loading && !data ? '…' : tile.isTime ? fmtTime(tile.value, t) : tile.value}
              {tile.unit && <span className="ml-1 text-xs font-medium text-slate-500">{tile.unit}</span>}
            </p>
            <p className={`text-xs mt-1 ${TONE[tile.tone] ?? TONE.flat}`}>{loading && !data ? '' : tile.note}</p>
          </div>
        ))}
      </section>

      {/* 每天幾場 */}
      <section className="bg-white border border-slate-200 rounded-2xl shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <h2 className="text-sm font-bold text-slate-900">{t('home.daily').replace('{n}', range)}</h2>
          <Link to="/usage/mine" className="text-xs font-semibold text-sage-700 hover:underline">{t('home.daily.more')}</Link>
        </div>
        <div className="p-4">
          <DailyChart daily={daily} emptyText={t('home.no_data')} />
        </div>
      </section>
    </div>
  );
}
