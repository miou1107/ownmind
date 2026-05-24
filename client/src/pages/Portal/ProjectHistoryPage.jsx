import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { Modal } from '../../components/common';
import { fmtDate } from '../../utils/fmtDate';

// 專案歷程頁 — list 你的所有 type=project memories、按 updated_at 倒序
// 點 row 開 Modal 看完整 content

export default function ProjectHistoryPage() {
  const t = useT();
  const { locale } = useLocale();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let aborted = false;
    (async () => {
      const r = await apiGet('/api/memory/type/project');
      if (aborted) return;
      setLoading(false);
      if (!r.ok) {
        setLoadError(r.error || 'load_failed');
        return;
      }
      setItems(r.data?.data || []);
    })();
    return () => { aborted = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('project_history.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('project_history.subtitle')}</p>

      {loading ? (
        <p className="mt-6 text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : items.length === 0 ? (
        <p className="mt-6 text-slate-500">{t('common.empty')}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setSelected(m)}
                className="block w-full text-left bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:border-sage-400 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-medium text-slate-900 break-all">
                    {m.title || `#${m.id}`}
                  </h2>
                  <span className="shrink-0 text-xs text-slate-500">
                    {fmtDate(m.updated_at, locale)}
                  </span>
                </div>
                {m.content ? (
                  // line-clamp-2 已限制視覺寬度、不用 slice 切（slice 對 UTF-16
                  // surrogate pair 不安全、emoji 等可能被切成 lone surrogate 變「�」）
                  <p className="mt-2 text-sm text-slate-600 line-clamp-2 break-all">
                    {m.content}
                  </p>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.title || t('project_history.detail_title')}
        size="lg"
      >
        <pre className="text-sm text-slate-700 whitespace-pre-wrap break-words">
          {selected?.content || ''}
        </pre>
      </Modal>
    </div>
  );
}
