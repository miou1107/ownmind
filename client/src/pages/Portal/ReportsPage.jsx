import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { Modal } from '../../components/common';
import { fmtDate } from '../../utils/fmtDate';

// 回報紀錄頁 — list 你建立的 bug reports、點 row 開 Modal 看完整 detail
// list 不帶 detail 欄位（severity / component / status 等基本資訊）、詳細在 GET /:id

// 嚴重程度 / 狀態 的 badge 配色（不翻譯 server 端 enum、避免破窗）
const SEVERITY_COLOR = {
  critical: 'bg-rose-100 text-rose-700 border-rose-200',
  high:     'bg-orange-100 text-orange-700 border-orange-200',
  medium:   'bg-amber-100 text-amber-700 border-amber-200',
  low:      'bg-slate-100 text-slate-700 border-slate-200',
};
const STATUS_COLOR = {
  pending:  'bg-amber-100 text-amber-700 border-amber-200',
  resolved: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  declined: 'bg-slate-100 text-slate-700 border-slate-200',
};

function Badge({ value, palette }) {
  if (!value) return null;
  const cls = palette[value] || 'bg-slate-100 text-slate-700 border-slate-200';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs border ${cls}`}>
      {value}
    </span>
  );
}

export default function ReportsPage() {
  const t = useT();
  const { locale } = useLocale();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // detail 載入
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    let aborted = false;
    (async () => {
      const r = await apiGet('/api/bug-reports?scope=mine&size=100');
      if (aborted) return;
      setLoading(false);
      if (!r.ok) {
        setLoadError(r.error || 'load_failed');
        return;
      }
      setItems(r.data?.items || []);
    })();
    return () => { aborted = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDetail(report) {
    setSelected(report);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    const r = await apiGet(`/api/bug-reports/${report.id}`);
    setDetailLoading(false);
    if (!r.ok) {
      // 403（user_id 不符）有專用 i18n 文案、其他錯走 generic load error
      const msg = r.status === 403 ? t('reports.error_forbidden') : (r.error || t('common.error_load'));
      setDetailError(msg);
      return;
    }
    setDetail(r.data);
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('reports.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('reports.subtitle')}</p>

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
        <ul className="mt-6 space-y-2">
          {items.map((report) => (
            <li key={report.id}>
              <button
                type="button"
                onClick={() => openDetail(report)}
                className="block w-full text-left bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:border-sage-400 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-medium text-slate-900 break-all">
                      {report.title || `#${report.id}`}
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge value={report.severity} palette={SEVERITY_COLOR} />
                      <Badge value={report.status} palette={STATUS_COLOR} />
                      {report.component ? (
                        <span className="text-xs text-slate-500">{report.component}</span>
                      ) : null}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-slate-500">
                    {fmtDate(report.created_at, locale)}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        isOpen={!!selected}
        onClose={() => { setSelected(null); setDetail(null); }}
        title={selected?.title || t('reports.detail_title')}
        size="lg"
      >
        {detailLoading ? (
          <p className="text-slate-500">{t('common.loading')}</p>
        ) : detailError ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {detailError}
          </div>
        ) : detail ? (
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs font-medium text-slate-500">{t('reports.severity_label')}</dt>
              <dd className="mt-1"><Badge value={detail.severity} palette={SEVERITY_COLOR} /></dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">{t('reports.component_label')}</dt>
              <dd className="mt-1 text-slate-700">{detail.component || '-'}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">{t('reports.status_label')}</dt>
              <dd className="mt-1"><Badge value={detail.status} palette={STATUS_COLOR} /></dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">{t('reports.created_at_label')}</dt>
              <dd className="mt-1 text-slate-700">{fmtDate(detail.created_at, locale)}</dd>
            </div>
            {detail.resolved_at ? (
              <div>
                <dt className="text-xs font-medium text-slate-500">{t('reports.resolved_at_label')}</dt>
                <dd className="mt-1 text-slate-700">{fmtDate(detail.resolved_at, locale)}</dd>
              </div>
            ) : null}
            {detail.status_reason ? (
              <div>
                <dt className="text-xs font-medium text-slate-500">{t('reports.status_reason_label')}</dt>
                <dd className="mt-1 text-slate-700 whitespace-pre-wrap">{detail.status_reason}</dd>
              </div>
            ) : null}
            {detail.description ? (
              <div>
                <dt className="text-xs font-medium text-slate-500">{t('reports.description_label')}</dt>
                <dd className="mt-1 text-slate-700 whitespace-pre-wrap break-words">
                  {detail.description}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </Modal>
    </div>
  );
}
