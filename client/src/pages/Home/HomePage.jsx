import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, AlertTriangle, Circle, CircleCheck, CircleX } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { useSession } from '../../session/SessionContext';
import { apiGet } from '../../api';
import { headlineVm, rulesVm, teamRulesVm, teamVm, decisionsVm, footerVm } from './overview-vm.js';

// 總覽: one sentence about the period, 我的 AI 守規矩, 團隊的 AI 守規矩 with the per-person
// table (admin), 要你決定的事, and a footer line for memory and computers. One API
// (/api/me/overview) feeds the page; every sentence is composed in overview-vm.js.

const RANGES = [7, 14, 30];

const BADGE = {
  better: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  worse: 'bg-amber-50 text-amber-800 ring-amber-200',
  same: 'bg-slate-50 text-slate-600 ring-slate-200',
};

const VERDICT = {
  success: 'text-emerald-700',
  warning: 'text-amber-700',
  danger: 'text-rose-700',
  muted: 'text-slate-500',
};

const FOOTER = {
  good: { Icon: CircleCheck, cls: 'text-emerald-600' },
  warn: { Icon: AlertTriangle, cls: 'text-amber-600' },
  bad: { Icon: CircleX, cls: 'text-rose-600' },
  none: { Icon: Circle, cls: 'text-slate-400' },
};

/** The rate, the period before, the badge, one sentence and the rules missed most. */
function RateBlock({ vm, topLabel }) {
  return (
    <div className={`p-4 grid gap-4 ${vm.hasData ? 'md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]' : ''}`}>
      <div>
        <p className={`font-bold text-slate-900 tabular-nums ${vm.hasData ? 'text-4xl' : 'text-lg'}`}>{vm.value}</p>
        {vm.compare && <p className="text-xs text-slate-500 mt-1">{vm.compare}</p>}
        {vm.badge && (
          <span className={`inline-block mt-2 px-2 py-0.5 rounded-full text-xs font-semibold ring-1 ${BADGE[vm.badge.kind]}`}>
            {vm.badge.text}
          </span>
        )}
        <p className="text-sm text-slate-700 mt-2">{vm.sentence}</p>
      </div>
      {vm.hasData && (
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-500 mb-2">{topLabel}</p>
          {vm.top.length === 0 ? (
            <p className="text-sm text-slate-600">{vm.empty}</p>
          ) : (
            <ol className="divide-y divide-slate-100 border border-slate-100 rounded-xl">
              {vm.top.map((r, i) => (
                <li key={r.code ?? i} className="flex items-start justify-between gap-3 px-3 py-2">
                  <span className="text-sm text-slate-800 min-w-0 break-words">
                    <span className="text-slate-400 tabular-nums mr-2">{i + 1}</span>{r.title}
                  </span>
                  <span className="text-xs font-semibold text-amber-700 whitespace-nowrap">{r.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {vm.footnote && <p className="md:col-span-2 text-xs text-slate-400">{vm.footnote}</p>}
    </div>
  );
}

function Card({ title, link, children }) {
  return (
    <section className="bg-white border border-slate-200 rounded-2xl shadow-sm">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
        {link && <Link to={link.to} className="text-xs font-semibold text-sage-700 hover:underline shrink-0">{link.label}</Link>}
      </div>
      {children}
    </section>
  );
}

export default function HomePage() {
  const t = useT();
  const { name } = useSession();
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

  const waiting = loading && !data;
  const headline = headlineVm(data, t);
  const rules = rulesVm(data, t);
  const teamRules = teamRulesVm(data, t);
  const team = teamVm(data, t);
  const decisions = decisionsVm(data, t);
  const footer = footerVm(data, t);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-500">
            {name ? t('home.greeting').replace('{name}', name) : t('nav.home')}
          </p>
          <h1 className="text-xl font-bold text-slate-900 mt-0.5">
            {waiting ? t('common.loading') : headline.title}
          </h1>
          {!waiting && headline.detail && <p className="text-sm text-slate-600 mt-1">{headline.detail}</p>}
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

      {/* 我的 AI 守規矩 */}
      <Card title={t('home.rules.title')} link={{ to: '/usage/rules', label: t('home.rules.more') }}>
        {waiting ? (
          <p className="px-4 py-6 text-sm text-slate-500">{t('common.loading')}</p>
        ) : (
          <RateBlock vm={rules} topLabel={t('home.rules.top')} />
        )}
      </Card>

      {/* 團隊的 AI 守規矩（管理員）: everyone pooled, then one row per person */}
      {team && (
        <Card title={t('home.team.title')} link={{ to: '/team/members', label: t('home.team.more') }}>
          {teamRules && <RateBlock vm={teamRules} topLabel={t('home.team.top')} />}
          <div className="border-t border-slate-100">
            <p className="px-4 pt-3 pb-1 text-xs font-semibold text-slate-500">{t('home.team.people')}</p>
            {team.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500 text-center">{t('home.team.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500">
                      <th scope="col" className="px-3 sm:px-4 py-2 font-semibold whitespace-nowrap">{t('home.team.col.who')}</th>
                      <th scope="col" className="px-3 sm:px-4 py-2 font-semibold whitespace-nowrap text-right">{t('home.team.col.rules')}</th>
                      <th scope="col" className="px-3 sm:px-4 py-2 font-semibold whitespace-nowrap text-right">{t('home.team.col.sessions')}</th>
                      <th scope="col" className="hidden sm:table-cell px-4 py-2 font-semibold whitespace-nowrap">{t('home.team.col.verdict')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {team.map((row) => (
                      <tr key={row.id}>
                        <td className="px-3 sm:px-4 py-2 font-medium text-slate-900">
                          <span className="whitespace-nowrap">{row.name}</span>
                          {/* On a phone the verdict sits under the name instead of in its own column. */}
                          <span className={`sm:hidden block text-xs mt-0.5 ${VERDICT[row.tone]}`}>{row.verdict}</span>
                        </td>
                        <td className="px-3 sm:px-4 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">{row.rate}</td>
                        <td className="px-3 sm:px-4 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">{row.sessions}</td>
                        <td className={`hidden sm:table-cell px-4 py-2 font-medium whitespace-nowrap ${VERDICT[row.tone]}`}>{row.verdict}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* 要你決定的事 */}
      <Card
        title={waiting ? t('home.decide.title.plain') : t('home.decide.title').replace('{n}', decisions.count)}
        link={{ to: '/inbox', label: t('home.decide.open_all') }}
      >
        {waiting ? (
          <p className="px-4 py-6 text-sm text-slate-500">{t('common.loading')}</p>
        ) : decisions.items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500 text-center">{decisions.empty}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {decisions.items.map((row) => (
              <li key={row.id} className="px-4 py-3 flex items-center gap-3">
                <p className="flex-1 min-w-0 text-sm text-slate-900 break-words">{row.text}</p>
                <Link
                  to={row.to}
                  className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-sage-500 text-white text-xs font-semibold hover:bg-sage-600 focus-visible:outline-2 focus-visible:outline-sage-500"
                >
                  {t('home.decide.go')} <ArrowRight size={12} />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {!waiting && (
          <div className="px-4 py-2 border-t border-slate-100 text-xs text-slate-400 flex flex-wrap gap-x-3 gap-y-1">
            {decisions.more && <Link to="/inbox" className="font-semibold text-sage-700 hover:underline">{decisions.more}</Link>}
            <span>{decisions.note}</span>
          </div>
        )}
      </Card>

      {/* 底下一行：記憶、電腦 */}
      <footer aria-label={t('home.footer')} className="flex flex-wrap gap-x-5 gap-y-2 px-1 text-xs">
        {footer.map((f) => {
          const { Icon, cls } = FOOTER[f.state];
          return (
            <span key={f.id} className={`inline-flex items-start gap-1.5 ${f.state === 'good' ? 'text-slate-500' : 'text-slate-700'}`}>
              <Icon size={14} className={`mt-px shrink-0 ${cls}`} aria-hidden="true" />
              <span>
                {waiting ? t('common.loading') : f.text}
                {!waiting && f.action && (
                  <Link to={f.action.to} className="ml-2 font-semibold text-sage-700 hover:underline">{f.action.label}</Link>
                )}
              </span>
            </span>
          );
        })}
      </footer>
    </div>
  );
}
