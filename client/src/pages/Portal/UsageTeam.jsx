import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { fmtDate } from '../../utils/fmtDate';

// 團隊區塊 — 成員列表 + 三條趨勢圖（日 / 時 / 週）+ 事件類型 + 版本分布 + 合規率
//
// 趨勢圖選擇：
//   - 日趨勢用 LineChart（看走勢、是否有 spike）
//   - 時段分布用 BarChart（24 小時、看哪個時段活躍）
//   - 星期分布用 BarChart（週一到週日、看哪天活躍）
// 三張圖都顯示 sessions（場次）；tooltip 帶 tokens / turns 細節

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export default function UsageTeam({ team }) {
  const t = useT();
  const { locale } = useLocale();

  if (!team) {
    return <p className="text-slate-500">{t('common.empty')}</p>;
  }

  const users = team.users || [];
  const daily = team.daily_trend || [];
  const hourly = team.hourly_trend || [];
  const weekday = team.weekday_trend || [];
  const eventTypes = team.event_types || [];
  const versions = team.versions || [];

  // 星期資料把 dow 數字轉成 label（用 i18n key 對應）
  const weekdayData = weekday.map((w) => ({
    ...w,
    label: t(`usage.weekday.${WEEKDAY_KEYS[w.dow] || 'sun'}`),
  }));

  return (
    <div className="space-y-6">
      {/* 成員列表 */}
      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-2">
          {t('usage.team.users_title')}
        </h2>
        {users.length === 0 ? (
          <p className="text-xs text-slate-500">{t('common.empty')}</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">{t('usage.col.user')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.sessions')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.events')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.tokens')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.turns')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id || u.name} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700 break-all">{u.name || '-'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{u.sessions ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{u.events ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{u.tokens ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{u.turns ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 日趨勢 */}
      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-2">
          {t('usage.team.daily_title')}
        </h2>
        {daily.length === 0 ? (
          <p className="text-xs text-slate-500">{t('common.empty')}</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <ResponsiveContainer height={240}>
              <LineChart data={daily} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="d" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="sessions" stroke="#6a8b6a" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* 時段分布 */}
      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-2">
          {t('usage.team.hourly_title')}
        </h2>
        {hourly.length === 0 ? (
          <p className="text-xs text-slate-500">{t('common.empty')}</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <ResponsiveContainer height={200}>
              <BarChart data={hourly} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="sessions" fill="#6a8b6a" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* 星期分布 */}
      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-2">
          {t('usage.team.weekday_title')}
        </h2>
        {weekdayData.length === 0 ? (
          <p className="text-xs text-slate-500">{t('common.empty')}</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <ResponsiveContainer height={200}>
              <BarChart data={weekdayData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="sessions" fill="#6a8b6a" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* 事件類型 */}
      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-2">
          {t('usage.team.events_title')}
        </h2>
        {eventTypes.length === 0 ? (
          <p className="text-xs text-slate-500">{t('common.empty')}</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">{t('usage.col.event')}</th>
                  <th className="text-right px-3 py-2">{t('usage.col.count')}</th>
                </tr>
              </thead>
              <tbody>
                {eventTypes.map((e) => (
                  <tr key={e.event} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700 break-all">{e.event}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{e.count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 版本分布 */}
      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-2">
          {t('usage.team.versions_title')}
        </h2>
        {versions.length === 0 ? (
          <p className="text-xs text-slate-500">{t('common.empty')}</p>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">{t('usage.col.user')}</th>
                  <th className="text-left px-3 py-2">{t('usage.col.tool')}</th>
                  <th className="text-left px-3 py-2">{t('usage.col.version')}</th>
                  <th className="text-left px-3 py-2">{t('usage.col.last_seen')}</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v, i) => (
                  <tr key={`${v.user_id}-${v.tool}-${i}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700 break-all">{v.name || '-'}</td>
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
    </div>
  );
}
