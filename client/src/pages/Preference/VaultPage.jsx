import { useState, useEffect, useRef } from 'react';
import { Eye, EyeOff, Pencil, Trash2, Plus } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet, apiPost, apiPut, apiDelete } from '../../api';
import { Modal } from '../../components/common';

// 密鑰管理頁 — list 所有 secret key、點「顯示」才 GET /:key 解密 value
// 新增 / 編輯 / 刪除（紅色按鈕 + 確認 dialog）
//
// 安全設計：
//   - List 不帶 value、避免 React state / DevTools 殘留明文
//   - 顯示 value 後 60 秒自動隱藏（防離席被偷看）
//   - 編輯 modal 不預載原 value（避免不小心覆蓋舊 value、得 user 主動 clear+ 重打）

const HIDE_AFTER_MS = 60 * 1000;

export default function VaultPage() {
  const t = useT();

  // list state
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // 顯示 value 用：key -> { value }
  const [revealed, setRevealed] = useState({});
  // timer ids 用 ref 存、避免 cleanup useEffect 拿到 stale closure 抓不到後加的 timer
  // 這跟 C1 reviewer 抓的 bug 對應、unmount 時必須清所有後加 timer 避免 setState on unmounted
  const timersRef = useRef(new Map());
  // 顯示 / 刪除 / 儲存 busy lock per row
  const [rowBusy, setRowBusy] = useState({});
  const [rowError, setRowError] = useState({});

  // modal state（create / edit 共用）
  const [modal, setModal] = useState(null);
  // { mode: 'create' | 'edit', key, description, value, oldKey?: 'edit 模式存原 key' }
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState('');

  // delete confirm modal
  const [pendingDelete, setPendingDelete] = useState(null);

  const [toast, setToast] = useState('');

  useEffect(() => {
    let aborted = false;
    (async () => {
      const r = await apiGet('/api/secret');
      if (aborted) return;
      setLoading(false);
      if (!r.ok) {
        setLoadError(r.error || 'load_failed');
        return;
      }
      setItems(Array.isArray(r.data) ? r.data : []);
    })();
    return () => { aborted = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // unmount 時清掉所有 reveal timer（從 ref 拿、不會被 closure 鎖死）
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((tid) => clearTimeout(tid));
      timers.clear();
    };
  }, []);

  function clearRevealTimer(key) {
    const tid = timersRef.current.get(key);
    if (tid) {
      clearTimeout(tid);
      timersRef.current.delete(key);
    }
  }

  async function handleReveal(key) {
    if (revealed[key]) {
      // 已顯示 → 隱藏
      clearRevealTimer(key);
      setRevealed((prev) => {
        const n = { ...prev };
        delete n[key];
        return n;
      });
      return;
    }
    setRowBusy((p) => ({ ...p, [key]: 'show' }));
    setRowError((p) => ({ ...p, [key]: '' }));
    const r = await apiGet(`/api/secret/${encodeURIComponent(key)}`);
    setRowBusy((p) => ({ ...p, [key]: '' }));
    if (!r.ok) {
      setRowError((p) => ({ ...p, [key]: r.error || t('vault.error_show') }));
      return;
    }
    const tid = setTimeout(() => {
      timersRef.current.delete(key);
      setRevealed((prev) => {
        const n = { ...prev };
        delete n[key];
        return n;
      });
    }, HIDE_AFTER_MS);
    timersRef.current.set(key, tid);
    setRevealed((prev) => ({ ...prev, [key]: { value: r.data.value } }));
  }

  function openCreate() {
    setModalError('');
    setModal({ mode: 'create', key: '', description: '', value: '' });
  }

  function openEdit(secret) {
    setModalError('');
    // value 不預填、user 要明確 retype 才會更新；description 可改
    // oldDescription 用來比對「有沒有真的改」、避免空白 submit 把原描述覆蓋成空字串
    setModal({
      mode: 'edit',
      oldKey: secret.key,
      oldDescription: secret.description || '',
      key: secret.key,
      description: secret.description || '',
      value: '',
    });
  }

  async function handleSave() {
    if (modalBusy) return;
    setModalError('');
    if (!modal.key.trim()) {
      setModalError(t('vault.error_key_required'));
      return;
    }
    if (modal.mode === 'create' && !modal.value) {
      setModalError(t('vault.error_value_required'));
      return;
    }
    setModalBusy(true);
    // create toast 文案：後端 POST 是 upsert（既有 key 會 update 不報錯），
    // 比對 items 判斷實際是新增還是更新，否則 user 看到誤導 toast
    const keyExisted = items.some((s) => s.key === modal.key.trim());
    let r;
    if (modal.mode === 'create') {
      r = await apiPost('/api/secret', {
        key: modal.key.trim(),
        value: modal.value,
        description: modal.description || null,
      });
    } else {
      // edit 模式：只送真的改過的欄位、避免空白 submit 把原描述洗掉
      const body = {};
      if (modal.value) body.value = modal.value;
      if (modal.description !== modal.oldDescription) body.description = modal.description;
      if (Object.keys(body).length === 0) {
        // 都沒改 → 直接關 modal、不打 API（noop submit）
        setModalBusy(false);
        setModal(null);
        return;
      }
      r = await apiPut(`/api/secret/${encodeURIComponent(modal.oldKey)}`, body);
    }
    setModalBusy(false);
    if (!r.ok) {
      setModalError(r.error || t('vault.error_save'));
      return;
    }
    // 成功：refresh list、關 modal、顯示對的 toast（upsert 場景判斷實際動作）
    const successToast = modal.mode === 'edit' || keyExisted
      ? t('vault.success_update')
      : t('vault.success_create');
    setToast(successToast);
    setModal(null);
    await refresh();
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    const key = pendingDelete.key;
    setRowBusy((p) => ({ ...p, [key]: 'delete' }));
    setRowError((p) => ({ ...p, [key]: '' }));
    const r = await apiDelete(`/api/secret/${encodeURIComponent(key)}`);
    setRowBusy((p) => ({ ...p, [key]: '' }));
    setPendingDelete(null);
    if (!r.ok) {
      setRowError((p) => ({ ...p, [key]: r.error || t('vault.error_delete') }));
      return;
    }
    setToast(t('vault.success_delete'));
    // 刪 row 順便清 revealed timer（若有）+ row-level state（避免 stale entry 累積）
    clearRevealTimer(key);
    setRevealed((prev) => {
      const n = { ...prev };
      delete n[key];
      return n;
    });
    setRowError((prev) => {
      const n = { ...prev };
      delete n[key];
      return n;
    });
    setRowBusy((prev) => {
      const n = { ...prev };
      delete n[key];
      return n;
    });
    setItems((prev) => prev.filter((s) => s.key !== key));
  }

  async function refresh() {
    const r = await apiGet('/api/secret');
    if (r.ok) setItems(Array.isArray(r.data) ? r.data : []);
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-sage-700">{t('vault.title')}</h1>
          <p className="text-slate-500 mt-1 text-sm">{t('vault.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="shrink-0 rounded-lg bg-sage-600 px-4 py-2 text-sm text-white font-medium hover:bg-sage-700 transition-colors flex items-center gap-1.5"
        >
          <Plus size={16} />
          {t('vault.add')}
        </button>
      </div>

      {toast ? (
        <div
          role="status"
          className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          {toast}
        </div>
      ) : null}

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
        <p className="mt-6 text-slate-500">{t('vault.empty')}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((s) => (
            <li
              key={s.key}
              className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-mono text-sm font-medium text-slate-900 break-all">
                    {s.key}
                  </h2>
                  {s.description ? (
                    <p className="mt-1 text-xs text-slate-500 break-words">
                      {s.description}
                    </p>
                  ) : null}
                  {revealed[s.key] ? (
                    <pre className="mt-2 text-sm text-slate-700 whitespace-pre-wrap break-all bg-slate-50 rounded p-2">
                      {revealed[s.key].value}
                    </pre>
                  ) : null}
                  {rowError[s.key] ? (
                    <div
                      role="alert"
                      className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
                    >
                      {rowError[s.key]}
                    </div>
                  ) : null}
                </div>
                {/* 按鈕區：顯示 / 編輯 / 刪除；刪除按鈕紅色並跟編輯保持距離 */}
                <div className="shrink-0 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleReveal(s.key)}
                    disabled={rowBusy[s.key] === 'show'}
                    aria-label={revealed[s.key] ? t('vault.hide') : t('vault.show')}
                    title={revealed[s.key] ? t('vault.hide') : t('vault.show')}
                    className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                  >
                    {revealed[s.key] ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(s)}
                    aria-label={t('vault.edit')}
                    title={t('vault.edit')}
                    className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <Pencil size={16} />
                  </button>
                  {/* 刪除按鈕紅色、跟編輯隔開 ml-4 */}
                  <button
                    type="button"
                    onClick={() => setPendingDelete(s)}
                    disabled={rowBusy[s.key] === 'delete'}
                    aria-label={t('vault.delete')}
                    title={t('vault.delete')}
                    className="ml-4 rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-rose-600 hover:bg-rose-100 disabled:opacity-50 transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* create / edit modal */}
      <Modal
        isOpen={!!modal}
        onClose={() => !modalBusy && setModal(null)}
        title={
          modal?.mode === 'edit'
            ? t('vault.modal_edit_title')
            : t('vault.modal_create_title')
        }
        size="md"
      >
        {modal ? (
          <div className="space-y-4">
            <label className="block">
              <span className="block text-sm font-medium text-slate-700">
                {t('vault.key_label')}
              </span>
              <input
                type="text"
                value={modal.key}
                onChange={(e) => setModal({ ...modal, key: e.target.value })}
                placeholder={t('vault.placeholder_key')}
                disabled={modalBusy || modal.mode === 'edit'}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
              />
            </label>
            <label className="block">
              <span className="block text-sm font-medium text-slate-700">
                {t('vault.value_label')}
              </span>
              <input
                type="password"
                value={modal.value}
                onChange={(e) => setModal({ ...modal, value: e.target.value })}
                placeholder={t('vault.placeholder_value')}
                autoComplete="new-password"
                disabled={modalBusy}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
              />
            </label>
            <label className="block">
              <span className="block text-sm font-medium text-slate-700">
                {t('vault.description_label')}
              </span>
              <input
                type="text"
                value={modal.description}
                onChange={(e) => setModal({ ...modal, description: e.target.value })}
                placeholder={t('vault.placeholder_description')}
                disabled={modalBusy}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
              />
            </label>
            {modalError ? (
              <div
                role="alert"
                className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
              >
                {modalError}
              </div>
            ) : null}
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setModal(null)}
                disabled={modalBusy}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
              >
                {t('vault.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={modalBusy}
                className="rounded-lg bg-sage-600 px-4 py-2 text-sm text-white font-medium hover:bg-sage-700 disabled:bg-slate-300 transition-colors"
              >
                {modalBusy ? t('vault.saving') : t('vault.save')}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* delete confirm modal */}
      <Modal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title={t('vault.delete_confirm_title')}
        size="sm"
      >
        <p className="text-sm text-slate-700">{t('vault.delete_confirm_body')}</p>
        {pendingDelete ? (
          <p className="mt-2 font-mono text-sm text-slate-900 bg-slate-50 rounded p-2 break-all">
            {pendingDelete.key}
          </p>
        ) : null}
        <div className="flex justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={() => setPendingDelete(null)}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
          >
            {t('vault.cancel')}
          </button>
          {/* 紅色刪除確認按鈕、跟取消保持距離 */}
          <button
            type="button"
            onClick={handleConfirmDelete}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm text-white font-medium hover:bg-rose-700 transition-colors"
          >
            {t('vault.confirm_delete')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
