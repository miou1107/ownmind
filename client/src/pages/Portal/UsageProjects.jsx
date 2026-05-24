import { useState } from 'react';
import { useT } from '../../i18n/LocaleContext';
import { Modal } from '../../components/common';

// 專案區塊 — 全團隊所有專案 list、按 turns 倒序
// 點 row 展開「主要負責人」明細（contributors：name / sessions / turns / handoffs）

export default function UsageProjects({ projects }) {
  const t = useT();
  const [selected, setSelected] = useState(null);

  if (!projects || projects.length === 0) {
    return <p className="text-slate-500">{t('common.empty')}</p>;
  }

  return (
    <div>
      <h2 className="text-sm font-bold text-slate-900 mb-2">
        {t('usage.projects.title')}
      </h2>
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">{t('usage.col.project')}</th>
              <th className="text-right px-3 py-2">{t('usage.col.sessions')}</th>
              <th className="text-right px-3 py-2">{t('usage.col.turns')}</th>
              <th className="text-right px-3 py-2">{t('usage.col.handoffs')}</th>
              <th className="text-right px-3 py-2">{t('usage.col.contributors')}</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p, i) => (
              <tr
                key={`${p.project}-${i}`}
                className="border-t border-slate-100 hover:bg-sage-50 cursor-pointer"
                onClick={() => setSelected(p)}
              >
                <td className="px-3 py-2 text-slate-700 break-all">{p.project || '-'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.sessions ?? 0}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.turns ?? 0}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.handoffs ?? 0}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.contributors?.length ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.project || t('usage.projects.detail_title')}
        size="md"
      >
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <p className="text-xs text-slate-500">{t('usage.col.sessions')}</p>
              <p className="text-lg font-bold tabular-nums">{selected?.sessions ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">{t('usage.col.turns')}</p>
              <p className="text-lg font-bold tabular-nums">{selected?.turns ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">{t('usage.col.handoffs')}</p>
              <p className="text-lg font-bold tabular-nums">{selected?.handoffs ?? 0}</p>
            </div>
          </div>

          <h3 className="text-sm font-bold text-slate-900 mt-4">
            {t('usage.projects.contributors_title')}
          </h3>
          {!selected?.contributors || selected.contributors.length === 0 ? (
            <p className="text-xs text-slate-500">{t('common.empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-600">
                <tr>
                  <th className="text-left px-2 py-1">{t('usage.col.user')}</th>
                  <th className="text-right px-2 py-1">{t('usage.col.sessions')}</th>
                  <th className="text-right px-2 py-1">{t('usage.col.turns')}</th>
                  <th className="text-right px-2 py-1">{t('usage.col.handoffs')}</th>
                </tr>
              </thead>
              <tbody>
                {selected.contributors.map((c, i) => (
                  <tr key={`${c.name}-${i}`} className="border-t border-slate-100">
                    <td className="px-2 py-1 text-slate-700">{c.name || '-'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{c.sessions ?? 0}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{c.turns ?? 0}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{c.handoffs ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Modal>
    </div>
  );
}
