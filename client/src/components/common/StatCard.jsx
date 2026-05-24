// 統計卡 — 用於 KPI 區塊（合規率、互動場次、估算額度等）
// value 與 unit 分開、unit 用較小字級附在數值右側
// trend 為選填、顯示為小角標
export default function StatCard({
  title,
  value,
  unit,
  trend,
  icon,
  bgColor = 'bg-sage-50',
  iconColor = 'text-sage-600',
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <p className="text-xs font-semibold text-slate-500 truncate">{title}</p>
          <div className="flex items-baseline gap-1">
            <p className="text-2xl font-bold text-slate-900">{value}</p>
            {unit && <span className="text-xs text-slate-500">{unit}</span>}
          </div>
          {trend && (
            <p
              className={`text-[11px] font-medium ${
                trend.direction === 'up' ? 'text-emerald-600' : 'text-red-500'
              }`}
            >
              {trend.direction === 'up' ? '↑' : '↓'} {trend.percent}%
            </p>
          )}
        </div>
        {icon && (
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${bgColor} ${iconColor}`}
          >
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
