import { useEffect, useState } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { useSession } from '../../session/SessionContext';
import { roleAtLeast } from '../../session/roles.js';
import { apiGet } from '../../api';
import { fmtDate } from '../../utils/fmtDate';
import TeamUsagePage from './TeamUsagePage.jsx';
import { memberRows } from './members-vm.js';

// v1.32.5 — 團隊 › 成員: one table of people.
//
// An admin gets the table that used to be 團隊用量 — ranking, coverage ("OwnMind 看得到嗎"
// as measured / unmeasured / exempt), and the drawer with one person's numbers — under
// this heading instead of its own. A member gets the simpler table the team half of
// /api/me/report has carried for everyone since v1.17: who is on the team, their role,
// when they last worked with the AI, how many sessions this fortnight. No column here
// shows a number the member's own report did not already show them.
export default function MembersPage() {
  const t = useT();
  const { role } = useSession();
  if (roleAtLeast(role, 'admin')) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-500">{t('members.intro.admin')}</p>
        <TeamUsagePage embedded />
      </div>
    );
  }
  return <MemberList />;
}

function MemberList() {
  const t = useT();
  const { locale } = useLocale();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let current = true;
    (async () => {
      const r = await apiGet('/api/me/report?range=14d');
      if (!current) return;
      setLoading(false);
      if (!r.ok) { setLoadError(r.error || 'load_failed'); return; }
      setData(r.data || null);
    })();
    return () => { current = false; };
  }, []);

  const rows = memberRows(data?.team?.users, t);

  return (
    <div className="max-w-5xl space-y-4">
      <p className="text-sm text-slate-500">{t('members.intro.member')}</p>
      {loading ? (
        <p className="text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-slate-500">{t('common.empty')}</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">{t('members.col.member')}</th>
                <th className="text-left px-3 py-2">{t('members.col.last_activity')}</th>
                <th className="text-right px-3 py-2">{t('members.col.sessions_14d')}</th>
                <th className="text-left px-3 py-2">{t('members.col.visible')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <span className="font-medium text-slate-900">{r.name}</span>
                    <span className="ml-2 text-xs text-slate-500">{t(`role.${r.role}`)}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {r.lastActivity ? fmtDate(r.lastActivity, locale) : <span className="text-slate-400">{t('members.never')}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{r.sessions}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className={`inline-block px-2 py-0.5 rounded-full font-semibold ${
                      r.visible === 'yes' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                    }`}>
                      {r.visibleLabel}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-400">{t('members.hint.member')}</p>
    </div>
  );
}
