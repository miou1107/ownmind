import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { fmtDate } from '../../utils/fmtDate';

// 整體分析 — 從舊的 /me/ 「整體分析」頁搬過來
//
// 兩段式，跟舊頁一樣：
//   機械段 GET /api/me/narrative        — 十個區塊的原始統計，一定拿得到
//   洞察段 GET /api/me/narrative/insights — LLM 產生的白話說明，管理者沒設 LLM 金鑰時
//                                          回 503 no_api_key
//
// 兩支平行發、機械段先畫。洞察段失敗只換掉說明文字、不會讓整頁空白：報告的價值在
// 數字，AI 說明是加分項。舊頁就是這樣設計的，照抄。
//
// range 換值時，上一輪的回應要被丟掉。這裡用每個 effect 各自持有的區域布林值，不是
// SessionContext 那種單調遞增的請求編號 — 那邊的問題是旗標跟事件監聽共用同一個
// cleanup、所以什麼都沒守住；這裡的旗標是這一次 effect 專屬的，React 換 range 時一定
// 會先跑上一輪的 cleanup 才跑新的 effect，所以舊回應回來時看到的必然是 false。

const RANGES = ['7d', '14d', '30d', 'all'];
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// 時段圖補滿 0..23、星期圖補滿 0..6，否則沒資料的時段會整個消失、看起來像連續的
function padHours(rows) {
  const byHour = new Map((rows || []).map((r) => [Number(r.hour), Number(r.c) || 0]));
  return Array.from({ length: 24 }, (_, h) => ({ hour: h, c: byHour.get(h) || 0 }));
}

function padWeekdays(rows, t) {
  const byDow = new Map((rows || []).map((r) => [Number(r.dow), Number(r.c) || 0]));
  return Array.from({ length: 7 }, (_, d) => ({
    label: t(`usage.weekday.${WEEKDAY_KEYS[d]}`),
    c: byDow.get(d) || 0,
  }));
}

function Card({ children, className = '' }) {
  return (
    <div className={`bg-white border border-slate-200 rounded-xl shadow-sm ${className}`}>
      {children}
    </div>
  );
}

function Section({ n, title, explanation, children }) {
  return (
    <section>
      <h2 className="text-sm font-bold text-slate-900 mb-2">
        <span className="text-slate-400 mr-1.5 tabular-nums">{n}.</span>
        {title}
      </h2>
      {children}
      {explanation !== undefined && (
        <p className="mt-2 text-xs leading-relaxed text-slate-600 bg-sage-50 border-l-2 border-sage-300 px-3 py-2 rounded-r">
          {explanation}
        </p>
      )}
    </section>
  );
}

function Empty() {
  const t = useT();
  return <p className="text-xs text-slate-500">{t('common.empty')}</p>;
}

function BarCard({ data, xKey, height = 200 }) {
  if (!data || data.length === 0) return <Empty />;
  return (
    <Card className="p-4">
      <ResponsiveContainer height={height}>
        <BarChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="c" fill="#6a8b6a" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

function Table({ head, children }) {
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-600">
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </Card>
  );
}

export default function NarrativePage() {
  const t = useT();
  const { locale } = useLocale();

  const [range, setRange] = useState('14d');
  const [mech, setMech] = useState(null);
  const [insights, setInsights] = useState(null);
  // 洞察段拿不到時要說「為什麼」，不是留一個沒解釋的破折號
  const [insightNote, setInsightNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError('');
    setInsights(null);
    setInsightNote(t('narrative.insights_loading'));

    const qs = `?range=${encodeURIComponent(range)}`;
    const mechP = apiGet(`/api/me/narrative${qs}`);
    const insP = apiGet(`/api/me/narrative/insights${qs}`);

    (async () => {
      const m = await mechP;
      if (!current) return;
      setLoading(false);
      if (!m.ok) {
        setLoadError(m.error || 'load_failed');
        setMech(null);
      } else {
        setMech(m.data || null);
      }

      const i = await insP;
      if (!current) return;
      if (i.ok) {
        setInsights(i.data || null);
        setInsightNote('');
        return;
      }
      // 503 no_api_key 是「管理者還沒設定 LLM」，跟「暫時壞掉」要分開講
      setInsights(null);
      setInsightNote(
        i.status === 503 ? t('narrative.insights_no_llm') : t('narrative.insights_failed'),
      );
    })();

    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // 有洞察就用洞察的說明，沒有就用一句解釋為什麼沒有
  const say = (key) => insights?.section_explanations?.[key] || insightNote || undefined;

  const sections = mech?.sections;
  const ranking = sections?.ranking || [];
  const unmeasured = ranking.filter((r) => !r.measured);

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('narrative.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('narrative.subtitle')}</p>

      <div className="mt-4 inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            className={
              'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors '
              + (range === r ? 'bg-sage-600 text-white' : 'text-slate-600 hover:bg-slate-100')
            }
          >
            {t(`usage.range.${r}`)}
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
      ) : (
        <div className="mt-6 space-y-6">
          {/* 一句話結論 */}
          <Card className="p-4 border-sage-200 bg-sage-50">
            <p className="text-xs font-bold text-sage-700">{t('narrative.summary_label')}</p>
            <p className="mt-1 text-sm text-slate-700 leading-relaxed">
              {insights?.summary_one_line || insightNote || t('narrative.summary_empty')}
            </p>
          </Card>

          {/* AI 那段如果是讀摘要寫出來的，這裡先講。
              下面的統計表格是完整資料，AI 的說明不是 — 兩邊會對不起來，不講的話讀者只會覺得
              AI 寫錯了。長區間會走到這條：整段期間的紀錄超過模型單次能收的量。 */}
          {insights?.condensed?.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 leading-relaxed">
              <p className="font-bold">{t('narrative.condensed_label')}</p>
              <ul className="mt-1 list-disc pl-4 space-y-0.5">
                {insights.condensed.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </div>
          )}

          {/* 從來沒回報過的成員先講清楚，免得下面的排名被當成完整名單。
              他們在表格裡有出現、只是被標起來，所以文案不能寫「不含他們」 */}
          {unmeasured.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 leading-relaxed">
              {t('narrative.coverage_note', {
                total: ranking.length,
                missing: unmeasured.length,
                names: unmeasured.map((r) => r.name || `#${r.id}`).join('、'),
              })}
            </div>
          )}

          <Section n={1} title={t('narrative.s.ranking')} explanation={say('ranking')}>
            {ranking.length === 0 ? <Empty /> : (
              <Table
                head={(
                  <>
                    <th className="text-left px-3 py-2">{t('usage.col.user')}</th>
                    <th className="text-right px-3 py-2">{t('usage.col.sessions')}</th>
                    <th className="text-right px-3 py-2">{t('usage.col.events')}</th>
                    <th className="text-left px-3 py-2">{t('usage.mine.last_activity')}</th>
                  </>
                )}
              >
                {ranking.map((r) => (
                  <tr
                    key={r.id}
                    className={
                      'border-t border-slate-100 '
                      + (r.measured ? '' : 'bg-slate-50 text-slate-400')
                    }
                  >
                    <td className="px-3 py-2 break-all">{r.name || `#${r.id}`}</td>
                    {r.measured ? (
                      <>
                        <td className="px-3 py-2 text-right tabular-nums">{r.sessions ?? 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.events ?? 0}</td>
                        <td className="px-3 py-2 text-xs text-slate-500">
                          {r.last_activity ? fmtDate(r.last_activity, locale) : '-'}
                        </td>
                      </>
                    ) : (
                      <td className="px-3 py-2 text-xs italic" colSpan={3}>
                        {t('narrative.no_data_for_member')}
                      </td>
                    )}
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <Section n={2} title={t('narrative.s.versions')} explanation={say('versions')}>
            {(sections.versions || []).length === 0 ? <Empty /> : (
              <Table
                head={(
                  <>
                    <th className="text-left px-3 py-2">{t('usage.col.user')}</th>
                    <th className="text-left px-3 py-2">{t('usage.col.tool')}</th>
                    <th className="text-left px-3 py-2">{t('usage.col.version')}</th>
                    <th className="text-left px-3 py-2">{t('usage.col.last_seen')}</th>
                  </>
                )}
              >
                {sections.versions.map((v, i) => {
                  const owner = ranking.find((r) => r.id === v.user_id);
                  return (
                    <tr key={`${v.user_id}-${v.tool}-${i}`} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-700 break-all">
                        {owner?.name || `#${v.user_id}`}
                      </td>
                      <td className="px-3 py-2 text-slate-700">{v.tool}</td>
                      <td className="px-3 py-2 text-slate-700">{v.version || '-'}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {v.last_reported_at ? fmtDate(v.last_reported_at, locale) : '-'}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Section>

          <Section n={3} title={t('narrative.s.daily')} explanation={say('daily')}>
            <BarCard data={sections.daily} xKey="d" height={220} />
          </Section>

          <Section n={4} title={t('narrative.s.hourly')} explanation={say('hourly')}>
            <BarCard data={padHours(sections.hourly)} xKey="hour" />
          </Section>

          {/* 星期分布 7 列、更新健康度通常 2~4 列 — 依 Requirement 7 併排，不各佔滿版 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Section n={5} title={t('narrative.s.weekday')} explanation={say('weekday')}>
              <BarCard data={padWeekdays(sections.weekday, t)} xKey="label" />
            </Section>

            <Section n={6} title={t('narrative.s.update_health')} explanation={say('update_health')}>
              {(sections.update_health || []).length === 0 ? <Empty /> : (
                <Table
                  head={(
                    <>
                      <th className="text-left px-3 py-2">{t('usage.col.event')}</th>
                      <th className="text-right px-3 py-2">{t('usage.col.count')}</th>
                    </>
                  )}
                >
                  {sections.update_health.map((u) => (
                    <tr key={u.event} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-700 break-all">{u.event}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(u.c) || 0}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
          </div>

          <Section n={7} title={t('narrative.s.event_types')} explanation={say('event_types')}>
            {(sections.event_types || []).length === 0 ? <Empty /> : (
              <Table
                head={(
                  <>
                    <th className="text-left px-3 py-2">{t('usage.col.event')}</th>
                    <th className="text-right px-3 py-2">{t('usage.col.count')}</th>
                  </>
                )}
              >
                {sections.event_types.map((e) => (
                  <tr key={e.event} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700 break-all">{e.event}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(e.c) || 0}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <Section n={8} title={t('narrative.s.compliance')} explanation={say('compliance')}>
            {(sections.compliance || []).length === 0 ? <Empty /> : (
              <Table
                head={(
                  <>
                    <th className="text-left px-3 py-2">{t('usage.col.user')}</th>
                    <th className="text-left px-3 py-2">{t('usage.col.rule')}</th>
                    <th className="text-right px-3 py-2">{t('usage.col.comply')}</th>
                    <th className="text-right px-3 py-2">{t('usage.col.skip')}</th>
                    <th className="text-right px-3 py-2">{t('usage.col.violate')}</th>
                    <th className="text-right px-3 py-2">{t('usage.col.observed')}</th>
                  </>
                )}
              >
                {sections.compliance.map((c, i) => (
                  <tr key={`${c.user_id}-${c.rule_code}-${i}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700 break-all">{c.user_name || '-'}</td>
                    <td className="px-3 py-2 text-slate-700">
                      <span className="text-xs text-slate-400 mr-1">{c.rule_code}</span>
                      <span className="break-all">{c.title || '-'}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{Number(c.comply) || 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{Number(c.skip) || 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-700">{Number(c.violate) || 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{Number(c.observed) || 0}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <Section n={9} title={t('narrative.s.project_ranking')} explanation={say('project_ranking')}>
            {(sections.project_ranking || []).length === 0 ? <Empty /> : (
              <Table
                head={(
                  <>
                    <th className="text-left px-3 py-2">{t('usage.col.project')}</th>
                    <th className="text-left px-3 py-2">{t('usage.col.user')}</th>
                    <th className="text-right px-3 py-2">{t('usage.col.sessions')}</th>
                    <th className="text-right px-3 py-2">{t('usage.col.turns')}</th>
                  </>
                )}
              >
                {sections.project_ranking.map((p, i) => (
                  <tr key={`${p.project_key}-${p.user_id}-${i}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700 break-all">{p.project || '-'}</td>
                    <td className="px-3 py-2 text-slate-700 break-all">{p.name || '-'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.sessions ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.turns ?? 0}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <Section n={10} title={t('narrative.s.project_friction')}>
            <ProjectFriction friction={insights?.project_friction} note={insightNote} />
          </Section>

          {(insights?.insights_for_admin?.length > 0 || insights?.next_actions?.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {insights.insights_for_admin?.length > 0 && (
                <Section n={11} title={t('narrative.s.insights')}>
                  <Card className="p-4">
                    <ul className="list-disc pl-5 space-y-1.5 text-sm text-slate-700 leading-relaxed">
                      {insights.insights_for_admin.map((x, i) => <li key={i}>{x}</li>)}
                    </ul>
                  </Card>
                </Section>
              )}
              {insights.next_actions?.length > 0 && (
                <Section n={12} title={t('narrative.s.next_actions')}>
                  <Card className="p-4">
                    <ul className="list-disc pl-5 space-y-1.5 text-sm text-slate-700 leading-relaxed">
                      {insights.next_actions.map((x, i) => <li key={i}>{x}</li>)}
                    </ul>
                  </Card>
                </Section>
              )}
            </div>
          )}

          <p className="text-xs text-slate-400">
            {mech.generated_at ? t('narrative.generated_at', { at: fmtDate(mech.generated_at, locale) }) : ''}
          </p>
        </div>
      )}
    </div>
  );
}

// 各專案踩的坑 — 唯一完全靠 LLM 的區塊，沒有洞察就只有一句說明
function ProjectFriction({ friction, note }) {
  const t = useT();
  const entries = Object.entries(friction || {});
  if (entries.length === 0) {
    return <p className="text-xs text-slate-500">{note || t('common.empty')}</p>;
  }
  return (
    <div className="space-y-3">
      {entries.map(([project, items]) => (
        <Card key={project} className="p-4">
          <p className="text-sm font-bold text-slate-900 break-all">{project}</p>
          <ul className="mt-2 space-y-2">
            {(Array.isArray(items) ? items : []).map((item, i) => (
              <li key={i} className="text-sm text-slate-700 leading-relaxed">
                {/* 舊頁也吃單行字串的舊格式、保持向下相容 */}
                {typeof item === 'string' ? item : (
                  <>
                    <span className="font-semibold">{item.what}</span>
                    {item.impact && (
                      <span className="block text-xs text-slate-500 mt-0.5">
                        {t('narrative.friction_impact', { text: item.impact })}
                      </span>
                    )}
                    {item.mitigation && (
                      <span className="block text-xs text-slate-500">
                        {t('narrative.friction_fix', { text: item.mitigation })}
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
