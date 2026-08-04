// v1.26.58 — 團隊用量排行榜 (Stage 6).
//
// Nine columns where the legacy table had thirteen. Three of the four token
// columns are folded into one 用量 cell — the fresh figure on the first line,
// the cache-inclusive total on the second — and the cost column is gone, not
// blanked (Requirement 8).
//
// Requirement 7 is the reason the empty cells are not dashes: a member with no
// usage data gets a marked row and a named reason, so nobody reads them as a
// quiet colleague.

import { useT, useLocale } from '../../i18n/LocaleContext';
import { fmtDate, bcp47Of } from '../../utils/fmtDate';
import { bandTextClass } from './charts.jsx';

/** Absent value, with the reason on hover rather than a bare dash. */
function Absent({ reason, t }) {
  return (
    <span className="text-xs italic text-slate-400" title={reason}>{t('team_usage.no_data')}</span>
  );
}

export default function TeamUsageTable({ rows, onSelect }) {
  const t = useT();
  const { locale } = useLocale();
  const fmtInt = (v) => v.toLocaleString(bcp47Of(locale));
  const fmtHours = (sec) => `${(sec / 3600).toFixed(1)}h`;

  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">{t('team_usage.empty')}</p>;
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">{t('team_usage.col.member')}</th>
            <th className="text-left px-3 py-2 whitespace-nowrap">{t('team_usage.col.last_active')}</th>
            {/* Two different session counts sit in this table and the legacy
                tooltips existed because people conflated them. Kept. */}
            <th className="text-right px-3 py-2 whitespace-nowrap" title={t('team_usage.col.sessions_hint')}>
              {t('team_usage.col.sessions')}
            </th>
            <th className="text-left px-3 py-2">{t('team_usage.col.project')}</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">{t('team_usage.col.compliance')}</th>
            <th className="text-right px-3 py-2 whitespace-nowrap" title={t('team_usage.col.usage_hint')}>
              {t('team_usage.col.usage')}
            </th>
            <th className="text-right px-3 py-2 whitespace-nowrap">{t('team_usage.col.messages')}</th>
            <th className="text-right px-3 py-2 whitespace-nowrap">{t('team_usage.col.active')}</th>
            <th className="text-right px-3 py-2 whitespace-nowrap" title={t('team_usage.col.usage_sessions_hint')}>
              {t('team_usage.col.usage_sessions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => onSelect(r)}
              className={`border-t border-slate-100 cursor-pointer hover:bg-sage-50 ${
                r.measured ? '' : 'bg-slate-50/70'
              }`}
              title={t('team_usage.row_hint')}
            >
              <td className="px-3 py-2">
                <span className="text-sage-700 underline underline-offset-2">{r.label}</span>
                {/* The mark Requirement 7 asks for: this row is not comparable
                    with the ones above it, and saying so beats a styling cue. */}
                {!r.measured && (
                  <span className="ml-2 inline-block px-1.5 py-0.5 rounded bg-slate-200 text-[11px] text-slate-600">
                    {t('team_usage.badge.unmeasured')}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                {r.lastActiveIso
                  ? fmtDate(r.lastActiveIso, locale)
                  : <Absent reason={t('team_usage.reason.no_activity')} t={t} />}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {r.sessionCount === null
                  ? <Absent reason={t('team_usage.reason.no_activity')} t={t} />
                  : fmtInt(r.sessionCount)}
              </td>
              <td className="px-3 py-2 text-slate-700">
                {r.topProject
                  ? <span className="truncate">{r.topProject}</span>
                  : <Absent reason={t('team_usage.reason.no_project')} t={t} />}
              </td>
              <td className={`px-3 py-2 text-right tabular-nums font-semibold ${bandTextClass(r.complianceBand)}`}>
                {r.complianceRate === null
                  ? <Absent reason={t('team_usage.reason.no_compliance')} t={t} />
                  : (
                    <span title={t('team_usage.compliance_counts', {
                      complied: r.complianceCounts.complied,
                      triggered: r.complianceCounts.triggered,
                    })}
                    >
                      {r.complianceRate}%
                    </span>
                  )}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {r.measured ? (
                  <>
                    <div className="tabular-nums text-slate-800">{fmtInt(r.freshTokens)}</div>
                    <div className="text-[11px] tabular-nums text-slate-400" title={t('team_usage.cache_hint')}>
                      {t('team_usage.with_cache', { total: fmtInt(r.totalTokens) })}
                    </div>
                  </>
                ) : <Absent reason={t('team_usage.reason.no_usage')} t={t} />}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {r.messageCount === null
                  ? <Absent reason={t('team_usage.reason.no_usage')} t={t} />
                  : fmtInt(r.messageCount)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {r.activeSeconds === null
                  ? <Absent reason={t('team_usage.reason.no_usage')} t={t} />
                  : fmtHours(r.activeSeconds)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {r.usageSessionCount === null
                  ? <Absent reason={t('team_usage.reason.no_usage')} t={t} />
                  : fmtInt(r.usageSessionCount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
