import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet, apiPost, apiPut } from '../../api';
import { notifyInboxChanged } from '../../hooks/useInboxCount';
import { postMemoryWrite } from '../../lib/memory-write.js';
import { fmtDate } from '../../utils/fmtDate';
import {
  LESSONS_PATH, RETRACT_REASON, lessonRow, applyLessonAction, lessonErrorKey,
} from './lessons-vm.js';

// 學到的 — the lessons each closed session left behind (v1.31.0).
//
// v1.33.0: the AI decides. A lesson becomes a memory on its second occurrence or at the
// monthly pass; the person no longer presses 留下. This page lists the last 60 days with
// the state the AI left each lesson in, and one undo per row: 收回 archives the memory a
// kept lesson made (and marks the lesson dismissed with that reason), 還是留 promotes a
// lesson the AI passed over. Same page shape as HandoffsPage: one list, one action per row,
// row-level errors, a toast on success.

const STATE_CLASS = {
  promoted: 'bg-emerald-50 text-emerald-700',
  dismissed: 'bg-slate-100 text-slate-600',
  new: 'bg-amber-50 text-amber-700',
};

export default function LessonsPage() {
  const t = useT();
  const { locale } = useLocale();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // busyId locks the row whose request is in flight, so a double click cannot act twice.
  const [busyId, setBusyId] = useState(null);
  const [rowError, setRowError] = useState({});
  const [toast, setToast] = useState('');

  useEffect(() => {
    let aborted = false;
    (async () => {
      const r = await apiGet(LESSONS_PATH);
      if (aborted) return;
      setLoading(false);
      if (!r.ok) {
        setLoadError(r.error || 'load_failed');
        return;
      }
      setItems(Array.isArray(r.data) ? r.data : []);
    })();
    return () => { aborted = true; };
  }, []);

  async function act(row) {
    if (busyId) return;
    const { id, action, memoryId } = row;
    setBusyId(id);
    setRowError((prev) => ({ ...prev, [id]: '' }));
    let r;
    if (action === 'retract') {
      // Archive the memory first: that is the undo. Then record on the lesson why it is no
      // longer kept, so a reload shows the same state the row shows now. A refusal of the
      // second call does not undo the first, so the row still reads as taken back.
      // The write needs a sync_token: postMemoryWrite fetches one and retries once on 409.
      r = memoryId
        ? await postMemoryWrite(apiPost, apiGet, `/api/memory/${memoryId}/archive`, { reason: RETRACT_REASON })
        : { ok: false, status: 404 };
      if (r.ok) await apiPut(`/api/session/lessons/${id}/set`, { status: 'dismissed', reason: RETRACT_REASON });
    } else {
      r = await apiPut(`/api/session/lessons/${id}/set`, { status: 'promoted' });
    }
    setBusyId(null);
    if (!r.ok) {
      // The server's reason is a status, not a sentence for the person: map it here so
      // the page never shows a raw English error string.
      setRowError((prev) => ({ ...prev, [id]: t(lessonErrorKey(r)) }));
      return;
    }
    setItems((prev) => applyLessonAction(prev, id, action, r.data));
    notifyInboxChanged();
    setToast(action === 'retract' ? t('lessons.retracted') : t('lessons.kept'));
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('lessons.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('lessons.subtitle')}</p>

      {toast ? (
        <div role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {toast}
        </div>
      ) : null}

      {loading ? (
        <p className="mt-6 text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div role="alert" className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : items.length === 0 ? (
        <p className="mt-6 text-slate-500">{t('lessons.empty')}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((l) => {
            const row = lessonRow(l);
            return (
              <li key={l.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-medium text-slate-900 break-words">{l.stuck}</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      {l.project ? `${l.project} · ` : ''}
                      {fmtDate(l.created_at, locale)}
                    </p>
                    <p className="mt-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATE_CLASS[row.status]}`}>
                        {t(row.stateKey, { reason: row.reason })}
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {row.action === 'retract' ? (
                      <button
                        type="button"
                        onClick={() => act(row)}
                        disabled={busyId === l.id}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 transition-colors"
                      >
                        {busyId === l.id ? t('lessons.working') : t(row.actionKey)}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => act(row)}
                        disabled={busyId === l.id}
                        className="rounded-lg bg-sage-600 px-4 py-1.5 text-sm text-white font-medium hover:bg-sage-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                      >
                        {busyId === l.id ? t('lessons.working') : t(row.actionKey)}
                      </button>
                    )}
                  </div>
                </div>
                <dl className="mt-3 grid gap-2 text-sm text-slate-700 bg-slate-50 rounded p-3">
                  {l.fix ? (
                    <div>
                      <dt className="text-xs text-slate-500">{t('lessons.fix_label')}</dt>
                      <dd className="whitespace-pre-wrap break-words">{l.fix}</dd>
                    </div>
                  ) : null}
                  {l.next_time ? (
                    <div>
                      <dt className="text-xs text-slate-500">{t('lessons.next_time_label')}</dt>
                      <dd className="whitespace-pre-wrap break-words">{l.next_time}</dd>
                    </div>
                  ) : null}
                  {!l.fix && !l.next_time ? (
                    <p className="text-xs text-slate-400">{t('lessons.only_stuck')}</p>
                  ) : null}
                </dl>
                {rowError[l.id] ? (
                  <div role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                    {rowError[l.id]}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
