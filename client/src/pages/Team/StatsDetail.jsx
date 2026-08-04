// v1.26.56 — the single-user view: GET /activity/stats plus /activity/stats/rules.
//
// Block order follows the legacy page so someone who used it recognises this
// one. What changed is Requirement 7: unmeasured rates are their own band
// rather than a red zero, 從未被觸發的規則 stays its own statement, and the
// context section states why it is empty instead of vanishing.

import { useMemo } from 'react';
import { useT } from '../../i18n/LocaleContext';
import { memoryCards, healthLines, handoffLines, contextVm } from './stats-detail-vm.js';
import { rateRows, ruleStatsRows, neverTriggeredTitles } from './stats-compliance-vm.js';
import { statsLabel } from './stats-labels.js';
import { BarChart, DailyChart, Card, ChartPair, NoData, bandTextClass, bandBarClass } from './charts.jsx';

function StatTile({ label, value, tone }) {
  const toneClass = tone === 'warn' ? 'text-amber-600'
    : tone === 'ok' ? 'text-emerald-600'
      : 'text-slate-900';
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-3 py-2.5 shadow-sm">
      <div className={`text-xl font-bold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-[11px] text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

/** One labelled bar with its rate — shared by 各規則落地率 and 各工具落地率. */
function RateBars({ rows, t, labelled }) {
  if (rows.length === 0) return <NoData>{t('stats.no_compliance_events')}</NoData>;
  return (
    <div className="space-y-2 max-w-2xl">
      {rows.map((r) => (
        <div key={r.key}>
          <div className="flex justify-between items-baseline text-xs gap-2">
            <span className="truncate text-slate-700" title={r.key}>
              {/* Rule titles are free text and stay raw; `unknown` is the
                  substitute rateRows makes for a null key, so it is translated
                  in both modes. */}
              {labelled || r.key === 'unknown' ? statsLabel(r.key, t) : r.key}
            </span>
            <span className={`font-semibold shrink-0 ${bandTextClass(r.band)}`}>
              {r.rate === null
                ? <span className="font-normal italic" title={t('stats.no_compliance_events')}>{t('stats.no_data')}</span>
                : <>{r.rate}% <span className="text-slate-400 font-normal">({r.total})</span></>}
            </span>
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1">
            {/* An unmeasured row draws no bar at all. Drawing it at 0% in the
                failure colour is the legacy defect this stage fixes. */}
            {r.rate !== null && (
              <div className={`h-full rounded-full ${bandBarClass(r.band)}`} style={{ width: `${r.rate}%` }} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function StatsDetail({ detail, ruleStats }) {
  const t = useT();

  const cards = useMemo(() => memoryCards(detail), [detail]);
  const health = useMemo(() => healthLines(detail), [detail]);
  const handoffs = useMemo(() => handoffLines(detail), [detail]);
  const ctx = useMemo(() => contextVm(detail.context), [detail]);

  const byRule = useMemo(() => rateRows(detail.compliance?.by_rule), [detail]);
  const byTool = useMemo(() => rateRows(detail.compliance?.by_tool), [detail]);
  const rules = useMemo(() => ruleStatsRows(ruleStats?.rules), [ruleStats]);
  const neverTriggered = useMemo(() => neverTriggeredTitles(ruleStats?.summary), [ruleStats]);

  const comp = detail.compliance || {};
  const compBandClass = bandTextClass(
    comp.rate === null || comp.rate === undefined ? 'unmeasured'
      : comp.rate >= 90 ? 'high' : comp.rate >= 70 ? 'mid' : 'low',
  );

  const triggerData = useMemo(() => {
    const out = {};
    // The heading says Top 5 but GET /stats has no LIMIT on triggerCounts, so
    // the slice is what makes the heading true rather than a rough estimate.
    // Already ordered by count DESC server-side.
    for (const r of (detail.iron_rules?.top_triggered || []).slice(0, 5)) {
      out[r.trigger || 'unknown'] = r.count;
    }
    return out;
  }, [detail]);

  return (
    <div className="space-y-4">
      {/* 1 — 記憶數量卡片 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {cards.map((c) => (
          <StatTile key={c.key} label={t(`stats.card.${c.key}`)} value={c.value} tone={c.tone} />
        ))}
      </div>

      {/* 2 — 記憶類型分布 */}
      <Card title={t('stats.block.memory_types')}>
        <BarChart data={detail.memory?.by_type} t={t} emptyText={t('stats.no_memories')} />
      </Card>

      {/* 3, 4 — 工具 / 模型分布 */}
      <ChartPair>
        <Card title={t('stats.block.tools')}>
          <BarChart data={detail.sessions?.by_tool} t={t} emptyText={t('stats.no_sessions')} />
        </Card>
        <Card title={t('stats.block.models')}>
          <BarChart data={detail.sessions?.by_model} t={t} emptyText={t('stats.no_sessions')} />
        </Card>
      </ChartPair>

      {/* 5 — 每日活動量 */}
      <Card title={t('stats.block.daily')}>
        <DailyChart daily={detail.activity?.daily} emptyText={t('stats.no_activity')} />
      </Card>

      {/* 6 — 鐵律合規率 */}
      <Card title={t('stats.block.compliance')}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="bg-slate-50 rounded-lg px-3 py-2.5">
            <div className={`text-xl font-bold tabular-nums ${compBandClass}`}>
              {comp.rate === null || comp.rate === undefined
                ? <span className="text-base font-normal italic" title={t('stats.no_compliance_events')}>{t('stats.no_data')}</span>
                : `${comp.rate}%`}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">{t('stats.card.overall_rate')}</div>
          </div>
          <StatTile label={t('stats.card.comply')} value={comp.by_action?.comply || 0} tone="ok" />
          <StatTile label={t('stats.card.skip')} value={comp.by_action?.skip || 0} tone="warn" />
          <StatTile label={t('stats.card.violate')} value={comp.by_action?.violate || 0} tone="default" />
        </div>
      </Card>

      {/* 7, 8 — 各規則 / 各工具落地率 */}
      <ChartPair>
        <Card title={t('stats.block.rate_by_rule')}>
          <RateBars rows={byRule} t={t} labelled={false} />
        </Card>
        <Card title={t('stats.block.rate_by_tool')}>
          <RateBars rows={byTool} t={t} labelled />
        </Card>
      </ChartPair>

      {/* 9, 10 — 每條鐵律落地率表 + 從未被觸發的規則 */}
      <Card title={t('stats.block.rule_table')}>
        {rules.length === 0 ? (
          <NoData>{t('stats.no_rules')}</NoData>
        ) : (
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2 whitespace-nowrap">{t('stats.col.rule_code')}</th>
                  <th className="text-left px-3 py-2">{t('stats.col.rule_title')}</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">{t('stats.col.enforced')}</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">{t('stats.col.skipped')}</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">{t('stats.col.violated')}</th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">{t('stats.col.rate')}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r, i) => (
                  <tr key={r.id ?? `${r.codeLabel}-${i}`} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 text-xs text-violet-700 whitespace-nowrap">{r.codeLabel || '—'}</td>
                    <td className="px-3 py-1.5 text-xs text-slate-800">
                      {r.title}
                      {r.verifyTriggers && (
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 text-[10px]">
                          {t('stats.auto_verify')}: {r.verifyTriggers.join(', ')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-emerald-600 font-medium">{r.enforced}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-amber-600 font-medium">{r.skipped}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-rose-600 font-medium">{r.violated}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${bandTextClass(r.band)}`}>
                      {r.rate === null
                        ? <span className="font-normal italic text-xs" title={t('stats.no_compliance_events')}>{t('stats.no_data')}</span>
                        : `${r.rate}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {neverTriggered.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500 leading-relaxed">
            {/* Its own statement, never folded into a rate. With 88 active rules
                and a handful triggered per week, averaging these in would invent
                a low score out of an absence of evidence. */}
            <span className="font-medium text-slate-600">
              {t('stats.never_triggered', { count: neverTriggered.length })}
            </span>
            {' '}
            {neverTriggered.join(t('stats.list_separator'))}
          </div>
        )}
      </Card>

      {/* 11, 12 — 鐵律觸發 Top 5 + 系統健康 */}
      <ChartPair>
        <Card title={t('stats.block.top_triggers')}>
          <BarChart data={triggerData} t={t} emptyText={t('stats.no_triggers')} />
          <p className="mt-3 text-xs text-slate-500">
            {t('stats.trigger_summary', {
              rules: detail.iron_rules?.total_active ?? 0,
              triggers: detail.iron_rules?.total_triggers ?? 0,
            })}
          </p>
        </Card>
        <Card title={t('stats.block.health')}>
          <dl className="space-y-1.5 text-sm">
            {health.map((l) => (
              <div key={l.key} className="flex justify-between gap-4">
                <dt className="text-slate-600">{t(`stats.health.${l.key}`)}</dt>
                <dd className={`font-semibold tabular-nums ${l.band ? bandTextClass(l.band) : 'text-slate-800'}`}>
                  {l.value === null
                    ? <span className="font-normal italic text-xs" title={t('stats.no_init_events')}>{t('stats.no_data')}</span>
                    : <>{l.value}{l.isPercent ? '%' : ''}</>}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </ChartPair>

      {/* 13-16 — the context section.
          The legacy page answered a null context with classList.add('hidden'),
          which is an unexplained absence. Requirement 6 asks for all four blocks
          to render and each to say why it is empty — so the four cards are
          always present and only their contents change. A reader who came
          looking for 使用者痛點 finds the words either way. */}
      {ctx.available && (
        <p className="text-xs text-slate-500">
          {/* Requirement 7's "aggregates state their denominator". */}
          {t('stats.context.basis', { sessions: ctx.sessionsWithContext })}
          {ctx.avgTurns !== null && ` ${t('stats.context.avg_turns', { turns: ctx.avgTurns })}`}
        </p>
      )}
      <ChartPair>
        <Card title={t('stats.block.actions')}>
          {ctx.available
            ? <BarChart rows={ctx.actions} t={t} emptyText={t('stats.no_actions')} />
            : <NoData>{t(ctx.reasonKey)}</NoData>}
        </Card>
        <Card title={t('stats.block.projects')}>
          {ctx.available
            ? <BarChart rows={ctx.projects} t={t} emptyText={t('stats.no_projects')} />
            : <NoData>{t(ctx.reasonKey)}</NoData>}
        </Card>
      </ChartPair>
      <ChartPair>
        <Card title={t('stats.block.friction')}>
          {!ctx.available ? <NoData>{t(ctx.reasonKey)}</NoData>
            : ctx.friction.length === 0 ? <NoData>{t('stats.no_friction')}</NoData> : (
              <ul className="space-y-2 text-sm">
                {ctx.friction.map((f, i) => (
                  <li key={i}>
                    <span className="text-violet-700 font-medium text-xs">[{f.tool}]</span>{' '}
                    <span className="text-slate-700">{f.text}</span>
                  </li>
                ))}
              </ul>
            )}
        </Card>
        <Card title={t('stats.block.suggestions')}>
          {!ctx.available ? <NoData>{t(ctx.reasonKey)}</NoData>
            : ctx.suggestions.length === 0 ? <NoData>{t('stats.no_suggestions')}</NoData> : (
              <ul className="space-y-2 text-sm">
                {ctx.suggestions.map((s, i) => (
                  <li key={i}>
                    <span className="text-violet-700 font-medium text-xs">[{s.tool}]</span>{' '}
                    <span className="text-slate-700">{s.text}</span>
                  </li>
                ))}
              </ul>
            )}
        </Card>
      </ChartPair>

      {/* 17 — 交接統計 */}
      <Card title={t('stats.block.handoffs')} className="max-w-md">
        <dl className="space-y-1.5 text-sm">
          {handoffs.map((l) => (
            <div key={l.key} className="flex justify-between gap-4">
              <dt className="text-slate-600">{t(`stats.handoff.${l.key}`)}</dt>
              <dd className={`font-semibold tabular-nums ${
                l.tone === 'ok' ? 'text-emerald-600' : l.tone === 'warn' ? 'text-amber-600' : 'text-slate-800'
              }`}>
                {l.value}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
