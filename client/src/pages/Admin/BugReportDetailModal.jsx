import { useState, useEffect } from 'react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet, apiPatch } from '../../api';
import { validateBugStatusUpdate } from './bug-status-update-validate.js';

// v1.26.51 — Detail + status editor modal. Ports src/public/index.html:818-852.
//
// The modal owns three things:
//   1. Fetches the full report via GET /api/bug-reports/:id
//   2. Renders the fields + conversation_snippets exactly as the legacy modal
//      does — string, truncated-with-details, and truncated_messages summary
//      shapes
//   3. Runs validateBugStatusUpdate client-side before PATCHing

function severityClass(color) {
  switch (color) {
    case 'critical': return 'text-rose-700 font-bold';
    case 'high':     return 'text-rose-600';
    case 'medium':   return 'text-amber-600';
    default:         return 'text-slate-500';
  }
}

function InfoRow({ label, children }) {
  return (
    <tr>
      <td className="w-32 text-xs text-slate-500 py-1 pr-2">{label}</td>
      <td className="text-xs text-slate-700 py-1">{children}</td>
    </tr>
  );
}

function renderSnippets(snippets) {
  if (!Array.isArray(snippets) || snippets.length === 0) return null;
  return snippets.map((s, i) => {
    if (typeof s === 'string') {
      return (
        <div key={i} className="border-l-2 border-slate-200 pl-2 py-1 my-1 text-xs text-slate-700 whitespace-pre-wrap">
          {s}
        </div>
      );
    }
    if (s && s.truncated === true) {
      return (
        <details key={i} className="border-l-2 border-amber-400 pl-2 py-1 my-1">
          <summary className="cursor-pointer text-amber-800 text-xs">
            (truncated — original {s.original_size} bytes)
          </summary>
          <div className="mt-1 text-xs text-slate-500">head: {s.head || ''}</div>
          <div className="text-xs text-slate-500">tail: {s.tail || ''}</div>
        </details>
      );
    }
    if (s && typeof s.truncated_messages === 'number') {
      return (
        <div key={i} className="text-xs italic text-slate-400 py-1">
          {s.summary || `(${s.truncated_messages} messages omitted)`}
        </div>
      );
    }
    return null;
  });
}

export default function BugReportDetailModal({ reportId, onClose, onSaved }) {
  const t = useT();

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('new');
  const [statusReason, setStatusReason] = useState('by_design');
  const [statusReasonNote, setStatusReasonNote] = useState('');
  const [errorKey, setErrorKey] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (reportId === null || reportId === undefined) {
      setReport(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError('');
      const res = await apiGet(`/api/bug-reports/${reportId}`);
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setLoadError(res.error || 'load_failed');
        return;
      }
      const r = res.data;
      setReport(r);
      setStatus(r.status || 'new');
      setStatusReason(r.status_reason || 'by_design');
      setStatusReasonNote(r.status_reason_note || '');
      setErrorKey('');
    })();
    return () => { cancelled = true; };
  }, [reportId]);

  if (reportId === null || reportId === undefined) return null;

  const submit = async () => {
    setErrorKey('');
    const form = {
      status,
      status_reason: status === 'wontfix' ? statusReason : undefined,
      status_reason_note: status === 'wontfix' ? statusReasonNote : undefined,
    };
    const check = validateBugStatusUpdate(form);
    if (!check.ok) {
      setErrorKey(check.errorKey);
      return;
    }
    const payload = { status };
    if (status === 'wontfix') {
      payload.status_reason = statusReason;
      payload.status_reason_note = statusReasonNote.trim() || null;
    }
    setSubmitting(true);
    const res = await apiPatch(`/api/bug-reports/${reportId}/status`, payload);
    setSubmitting(false);
    if (!res.ok) {
      setErrorKey(res.error || 'submit_failed');
      return;
    }
    onSaved();
  };

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">
            {t('bug_reports.detail.title')} <span className="text-slate-400 font-normal">#{reportId}</span>
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">×</button>
        </div>

        <div className="p-5 space-y-4">
          {loading && <p className="text-sm text-slate-500">{t('common.loading')}</p>}

          {loadError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {loadError}
            </div>
          )}

          {report && (
            <>
              <table className="w-full">
                <tbody>
                  <InfoRow label={t('bug_reports.detail.title_field')}>
                    <span className="font-medium text-slate-900">{report.title}</span>
                  </InfoRow>
                  <InfoRow label={t('bug_reports.detail.fingerprint')}>
                    <code className="text-xs">{report.bug_fingerprint}</code>
                  </InfoRow>
                  <InfoRow label={t('bug_reports.detail.severity')}>
                    <span className={severityClass(report.severity || 'medium')}>{report.severity}</span>
                  </InfoRow>
                  <InfoRow label={t('bug_reports.detail.component')}>{report.component || '—'}</InfoRow>
                  <InfoRow label={t('bug_reports.detail.client_tool')}>{report.client_tool || '—'}</InfoRow>
                  <InfoRow label={t('bug_reports.detail.device_fingerprint')}>
                    <code className="text-xs">{report.device_fingerprint || '—'}</code>
                  </InfoRow>
                  <InfoRow label={t('bug_reports.detail.created_at')}>
                    {String(report.created_at || '').replace('T', ' ').slice(0, 19)}
                  </InfoRow>
                </tbody>
              </table>

              <div>
                <h4 className="text-sm font-medium text-slate-800 mb-1">{t('bug_reports.detail.description')}</h4>
                <div className="bg-slate-50 rounded-md p-3 text-xs text-slate-700 whitespace-pre-wrap">
                  {report.description || ''}
                </div>
              </div>

              {report.reproduce_input && (
                <div>
                  <h4 className="text-sm font-medium text-slate-800 mb-1">{t('bug_reports.detail.reproduce_input')}</h4>
                  <pre className="bg-slate-50 rounded-md p-3 text-xs text-slate-700 overflow-x-auto">
                    {report.reproduce_input}
                  </pre>
                </div>
              )}

              {report.context_blob?.conversation_snippets?.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-slate-800 mb-1">{t('bug_reports.detail.snippets')}</h4>
                  <div>{renderSnippets(report.context_blob.conversation_snippets)}</div>
                </div>
              )}

              <hr className="border-slate-200" />

              <h4 className="text-sm font-medium text-slate-800">{t('bug_reports.detail.status_editor')}</h4>

              <div className="space-y-2">
                <label className="text-xs text-slate-500 block">{t('bug_reports.detail.status')}</label>
                <select
                  value={status}
                  onChange={(e) => { setStatus(e.target.value); setErrorKey(''); }}
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm w-full"
                >
                  <option value="new">new</option>
                  <option value="triaged">triaged</option>
                  <option value="in_progress">in_progress</option>
                  <option value="fixed">fixed</option>
                  <option value="wontfix">wontfix</option>
                </select>
              </div>

              {status === 'wontfix' && (
                <>
                  <div className="space-y-2">
                    <label className="text-xs text-slate-500 block">{t('bug_reports.detail.status_reason')}</label>
                    <select
                      value={statusReason}
                      onChange={(e) => { setStatusReason(e.target.value); setErrorKey(''); }}
                      className="border border-slate-300 rounded-md px-2 py-1.5 text-sm w-full"
                    >
                      <option value="by_design">by_design</option>
                      <option value="duplicate">duplicate</option>
                      <option value="low_priority">low_priority</option>
                      <option value="cannot_reproduce">cannot_reproduce</option>
                      <option value="wontfix_other">wontfix_other</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-slate-500 block">
                      {t('bug_reports.detail.status_reason_note')}
                      {statusReason === 'wontfix_other' && ' *'}
                    </label>
                    <textarea
                      value={statusReasonNote}
                      onChange={(e) => { setStatusReasonNote(e.target.value); setErrorKey(''); }}
                      rows={3}
                      className="border border-slate-300 rounded-md px-2 py-1.5 text-sm w-full"
                    />
                  </div>
                </>
              )}

              {errorKey && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-700">
                  {t(`bug_reports.error.${errorKey}`) || errorKey}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={submitting || !report}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            {t('bug_reports.detail.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
