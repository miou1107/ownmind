// v1.26.56 — the two chart primitives the stats page reuses.
//
// Requirement 7's last scenario drives the sizing: the main column is capped so
// a two-digit count is never placed 1500px from its own label, and a chart with
// three or four rows sits beside a sibling rather than spanning the page.
// `ChartPair` is that layout, named so the rule is applied rather than
// remembered.

import { barChartRows, dailyChartRows } from './stats-chart-data.js';
import { statsLabel } from './stats-labels.js';

/** Two cards side by side on wide screens, stacked on narrow ones. */
export function ChartPair({ children }) {
  return <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{children}</div>;
}

export function Card({ title, children, className = '' }) {
  return (
    <div className={`bg-white border border-slate-200 rounded-xl p-4 shadow-sm ${className}`}>
      {title && <h3 className="text-sm font-semibold text-slate-800 mb-3">{title}</h3>}
      {children}
    </div>
  );
}

export function NoData({ children }) {
  return <p className="text-sm text-slate-500 italic">{children}</p>;
}

/**
 * Horizontal bar chart.
 *
 * Takes either a `{ key: count }` map (`data`) or rows already through
 * `barChartRows` (`rows`) — the context blocks arrive pre-shaped, and round-
 * tripping them back into an object only to recompute the same percentages was
 * work for nothing. `t` is passed in so labels go through the dictionary.
 */
export function BarChart({ data, rows: preRows, t, emptyText }) {
  const rows = preRows ?? barChartRows(data);
  if (rows.length === 0) return <NoData>{emptyText}</NoData>;
  return (
    <div className="space-y-1.5 max-w-2xl">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2">
          <div className="w-32 shrink-0 truncate text-xs text-slate-600" title={r.key}>
            {statsLabel(r.key, t)}
          </div>
          <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-sage-500 rounded-full" style={{ width: `${r.pct}%` }} />
          </div>
          <div className="w-10 shrink-0 text-right text-xs tabular-nums text-slate-700">{r.count}</div>
        </div>
      ))}
    </div>
  );
}

/** Vertical column chart over `[{ date, count }]`, chronological order kept. */
export function DailyChart({ daily, emptyText }) {
  const rows = dailyChartRows(daily);
  if (rows.length === 0) return <NoData>{emptyText}</NoData>;
  return (
    <div className="flex items-end gap-0.5 h-32 overflow-x-auto">
      {rows.map((r) => (
        <div
          key={r.date}
          title={`${r.date}: ${r.count}`}
          className="flex-1 min-w-[3px] bg-sage-400 hover:bg-sage-600 rounded-t"
          // A zero-count day still gets a visible sliver, so a gap in the series
          // reads as "we have this day and it was quiet" rather than as absence.
          style={{ height: `${Math.max(r.pct, 1)}%` }}
        />
      ))}
    </div>
  );
}

/** The colour band shared by every rate on the page. `unmeasured` has no colour. */
export function bandTextClass(band) {
  switch (band) {
    case 'high': return 'text-emerald-600';
    case 'mid':  return 'text-amber-600';
    case 'low':  return 'text-rose-600';
    default:     return 'text-slate-400';
  }
}

export function bandBarClass(band) {
  switch (band) {
    case 'high': return 'bg-emerald-500';
    case 'mid':  return 'bg-amber-500';
    case 'low':  return 'bg-rose-500';
    default:     return 'bg-slate-300';
  }
}
