import { useT, useLocale } from '../../i18n/LocaleContext';
import { StatCard } from '../../components/common';
import { fmtDate } from '../../utils/fmtDate';

// 個人區塊 — 你自己的用量數據
// KPI 卡：互動場次 / 事件數 / 最後活動時間 / 鐵律合規率
// 表格：專案 / 鐵律遵守 / 版本 / 近期 activity
//
// 合規率算法：comply / (comply + skip + violate)
// 不算 observed、因為那是系統自動觀測、user 沒主動選擇遵守
function calcRulePassRate(rows) {
  let pass = 0;
  let total = 0;
  for (const r of rows || []) {
    pass += r.comply || 0;
    total += (r.comply || 0) + (r.skip || 0) + (r.violate || 0);
  }
  if (total === 0) return null;
  return Math.round((pass / total) * 100);
}

export default function UsageMine({ me }) {
  const t = useT();
  const { locale } = useLocale();

  if (!me) {
    return <p className="text-slate-500">{t('common.empty')}</p>;
  }

  const rate = calcRulePassRate(me.compliance);
  const projects = me.projects || [];
  const versions = me.versions || [];
  const compliance = me.compliance || [];
  const activity = me.activity || [];

  return (
    <div className="space-y-6">
      {/* KPI 卡列 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title={t('usage.mine.sessions')}
          value={me.sessions ?? 0}
          unit={t('usage.unit.sessions')}
        />
        <StatCard
          title={t('usage.mine.events')}
          value={me.events ?? 0}
          unit={t('usage.unit.events')}
        />
        <StatCard
          title={t('usage.mine.last_activity')}
          value={me.last_activity ? fmtDate(me.last_activity, locale) : '-'}
        />
        <StatCard
          title={t('usage.mine.compliance_rate')}
          value={rate === null ? '-' : rate}
          unit={rate === null ? '' : '%'}
        />
      </div>

      {/* 專案 */}
      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-2">
          {t('usage.mine.projects_title')}
        </h2>
        {projects.length === 0 ? (
          <p className="text-xs text-slate-500">{t('common.empty')}</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">{t('usage.col.project')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.sessions')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.turns')}</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.project_key} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700 break-all">{p.project || '-'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.sessions ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.turns ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 鐵律遵守 */}
      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-2">
          {t('usage.mine.compliance_title')}
        </h2>
        {compliance.length === 0 ? (
          <p className="text-xs text-slate-500">{t('common.empty')}</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">{t('usage.col.rule')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.comply')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.skip')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.violate')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.observed')}</th>
                </tr>
              </thead>
              <tbody>
                {compliance.map((r) => (
                  <tr key={r.rule_code} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700">
                      <span className="text-xs text-slate-400 mr-1">{r.rule_code}</span>
                      <span className="break-all">{r.title || '-'}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{r.comply}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.skip}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-700">{r.violate}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.observed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 版本 */}
      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-2">
          {t('usage.mine.versions_title')}
        </h2>
        {versions.length === 0 ? (
          <p className="text-xs text-slate-500">{t('common.empty')}</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">{t('usage.col.tool')}</th>
                  <th className="text-left px-3 py-2">{t('usage.col.version')}</th>
                  <th className="text-left px-3 py-2">{t('usage.col.last_seen')}</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v, i) => (
                  <tr key={`${v.tool}-${i}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700">{v.tool}</td>
                    <td className="px-3 py-2 text-slate-700">{v.version || '-'}</td>
                    <td className="px-3 py-2 text-slate-500 text-xs">
                      {v.last_reported_at ? fmtDate(v.last_reported_at, locale) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 近期 activity */}
      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-2">
          {t('usage.mine.activity_title')}
        </h2>
        {activity.length === 0 ? (
          <p className="text-xs text-slate-500">{t('common.empty')}</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">{t('usage.col.time')}</th>
                  <th className="text-left px-3 py-2">{t('usage.col.event')}</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((a, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-500 text-xs whitespace-nowrap">
                      {a.ts ? fmtDate(a.ts, locale) : '-'}
                    </td>
                    <td className="px-3 py-2 text-slate-700 break-all">{a.event || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
