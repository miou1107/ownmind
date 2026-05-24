import { useT } from '../../i18n/LocaleContext';

// 篩選列 — 日期 / 專案 / 關鍵字、可重置
// values 為受控屬性、onChange 接收 { date, project, keyword }
// projects 為可選清單、預設只有「所有專案」
export default function FilterBar({
  values = {},
  projects = [],
  onChange,
  onClear,
}) {
  const t = useT();
  const { date = '', project = '', keyword = '' } = values;
  const hasAnyFilter = !!(date || project || keyword);

  const update = (patch) => onChange?.({ ...values, ...patch });

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-slate-900">
            {t('filter.title')}
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {t('filter.subtitle')}
          </p>
        </div>
        {hasAnyFilter && (
          <button
            onClick={onClear}
            className="text-[11px] font-semibold text-red-500 hover:text-red-700 transition-colors shrink-0"
          >
            {t('filter.clear')}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <input
          type="date"
          value={date}
          onChange={(e) => update({ date: e.target.value })}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-sage-500"
        />
        <select
          value={project}
          onChange={(e) => update({ project: e.target.value })}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-700 font-semibold focus:outline-none focus:border-sage-500"
        >
          <option value="">{t('filter.all_projects')}</option>
          {projects.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder={t('filter.keyword_placeholder')}
          value={keyword}
          onChange={(e) => update({ keyword: e.target.value })}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs w-44 focus:outline-none focus:border-sage-500"
        />
      </div>
    </div>
  );
}
