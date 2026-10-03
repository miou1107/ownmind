import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { fmtDate } from '../../utils/fmtDate';

// Overlaps (v1.31.2): pairs of members who edited the same directory of the same project
// within the last day. Read from GET /api/activity/touch/overlaps (admin+). The block says
// nothing when the window is empty — an empty table would read as "nobody works".

export default function OverlapsBlock() {
  const t = useT();
  const { locale } = useLocale();
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let aborted = false;
    (async () => {
      const r = await apiGet('/api/activity/touch/overlaps');
      if (aborted) return;
      if (!r.ok) { setFailed(true); return; }
      setRows(Array.isArray(r.data?.overlaps) ? r.data.overlaps : []);
    })();
    return () => { aborted = true; };
  }, []);

  if (failed) {
    return (
      <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        {t('overlaps.load_failed')}
      </div>
    );
  }
  if (!rows || rows.length === 0) return null;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
      <h2 className="font-medium text-slate-900">{t('overlaps.title')}</h2>
      <p className="text-xs text-slate-500 mt-1">{t('overlaps.subtitle')}</p>
      <ul className="mt-3 space-y-2 text-sm">
        {rows.map((o) => (
          <li key={`${o.project}/${o.dir}/${o.first_name}/${o.second_name}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-slate-800">{o.first_name}</span>
            <span className="text-slate-400">+</span>
            <span className="font-medium text-slate-800">{o.second_name}</span>
            <span className="text-slate-600">
              {o.dir === '.' ? o.project : `${o.project} / ${o.dir}`}
            </span>
            <span className="text-xs text-slate-400">{fmtDate(o.last_seen, locale)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
