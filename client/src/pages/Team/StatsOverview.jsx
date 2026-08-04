// v1.26.56 — 用戶活躍度總表, the cross-user view of GET /activity/stats/all.
//
// Eight columns, same as the legacy table. The two Requirement 7 points:
// an empty tool/model map is marked absent rather than left blank, and a null
// compliance rate reads "no data" instead of joining the colour bands.

import { useMemo } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { overviewRowVm } from './stats-overview-vm.js';
import { statsLabel } from './stats-labels.js';
import { bandTextClass } from './charts.jsx';

function Pills({ pills, measured, unmeasuredText, t }) {
  if (!measured) return <span className="text-xs text-slate-400 italic">{unmeasuredText}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {pills.map((p) => (
        <span
          key={p.key}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 text-[11px] text-slate-700"
          title={p.key}
        >
          {/* Through the dictionary, not raw. session_logs.model is nullable, so
              GROUP BY model yields a null that becomes the literal string "null"
              once it is an object key — which the browser check caught rendering
              as `null 1` in the 使用模型 column. */}
          {statsLabel(p.key, t)}
          <span className="text-slate-400 tabular-nums">{p.count}</span>
        </span>
      ))}
    </div>
  );
}

// zh → zh-Hant, en → en, ja → ja. Three sibling pages hardcode 'zh-TW' here;
// ProfilePage already derives it, and a new page should not copy the wrong one.
const BCP47 = { zh: 'zh-Hant', en: 'en', ja: 'ja' };

export default function StatsOverview({ users, nowMs }) {
  const t = useT();
  const { locale } = useLocale();
  const rows = useMemo(
    () => (users || []).map((u) => overviewRowVm(u, nowMs)),
    [users, nowMs],
  );

  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">{t('stats.overview.empty')}</p>;
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-600">
          <tr>
            <th className="text-left px-3 py-2 w-8">{t('stats.col.status')}</th>
            <th className="text-left px-3 py-2">{t('stats.col.user')}</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">{t('stats.col.memories')}</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">{t('stats.col.sessions')}</th>
            <th className="text-left px-3 py-2">{t('stats.col.tools')}</th>
            <th className="text-left px-3 py-2">{t('stats.col.models')}</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">{t('stats.col.compliance')}</th>
            <th className="text-left px-3 py-2 whitespace-nowrap">{t('stats.col.last_active')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-slate-100 align-top">
              <td className="px-3 py-2">
                <span
                  title={r.isActive ? t('stats.dot.active') : t('stats.dot.inactive')}
                  className={`inline-block w-2 h-2 rounded-full ${r.isActive ? 'bg-emerald-500' : 'bg-slate-300'}`}
                />
              </td>
              <td className="px-3 py-2 text-slate-800">{r.label}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">{r.memoryCount}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">{r.sessionCount}</td>
              <td className="px-3 py-2">
                <Pills pills={r.tools} measured={r.toolsMeasured} unmeasuredText={t('stats.no_sessions')} t={t} />
              </td>
              <td className="px-3 py-2">
                <Pills pills={r.models} measured={r.modelsMeasured} unmeasuredText={t('stats.no_sessions')} t={t} />
              </td>
              <td className={`px-3 py-2 text-right tabular-nums font-semibold ${bandTextClass(r.complianceBand)}`}>
                {r.complianceRate === null
                  ? <span className="font-normal italic text-xs" title={t('stats.no_compliance_events')}>{t('stats.no_data')}</span>
                  : `${r.complianceRate}%`}
              </td>
              <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                {r.neverActive
                  ? <span className="italic">{t('stats.never_active')}</span>
                  : new Date(r.lastActiveIso).toLocaleDateString(BCP47[locale] ?? 'zh-Hant')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
