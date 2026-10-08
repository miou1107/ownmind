import { useEffect, useState } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { Modal } from '../../components/common';
import { fmtDate } from '../../utils/fmtDate';
import { ruleGroups } from './memory-rules-vm.js';

// v1.32.5 — 記憶 › 規矩: the rules the AI follows for this person.
//
// Two lists, read the way the AI reads them at the start of every conversation: the
// person's own iron rules (/api/memory/type/iron_rule — the words they wrote after a real
// incident, with the tier OwnMind enforces them at) and the team standards they can see
// (/api/memory/type/team_standard — the company's, shared). Click a row to read it in
// full. Nothing here can be edited: a rule changes through the AI or the memory tools,
// and this page says so.
export default function MemoryRulesPage() {
  const t = useT();
  const { locale } = useLocale();
  const [iron, setIron] = useState(null);
  const [standards, setStandards] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let current = true;
    (async () => {
      const [a, b] = await Promise.all([
        apiGet('/api/memory/type/iron_rule'),
        apiGet('/api/memory/type/team_standard'),
      ]);
      if (!current) return;
      setLoading(false);
      if (!a.ok && !b.ok) { setLoadError(a.error || b.error || 'load_failed'); return; }
      setIron(a.ok ? (a.data?.data || []) : null);
      setStandards(b.ok ? (b.data?.data || []) : null);
    })();
    return () => { current = false; };
  }, []);

  const groups = ruleGroups({ iron, standards }, t);

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-slate-500">{t('memory.rules.intro')}</p>
      {loading ? (
        <p className="text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : groups.map((g) => (
        <section key={g.id} className="bg-white border border-slate-200 rounded-2xl shadow-sm">
          <div className="px-4 py-3 border-b border-slate-100">
            <h2 className="text-sm font-bold text-slate-900">{g.title}</h2>
            <p className="text-xs text-slate-500 mt-0.5">{g.subtitle}</p>
          </div>
          {g.rows === null ? (
            <p className="px-4 py-4 text-sm text-slate-500">{t('home.no_data')}</p>
          ) : g.rows.length === 0 ? (
            <p className="px-4 py-4 text-sm text-slate-500">{g.empty}</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {g.rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(r)}
                    className="w-full text-left px-4 py-3 hover:bg-slate-50 flex flex-wrap items-center gap-2 focus-visible:outline-2 focus-visible:outline-sage-500"
                  >
                    {r.code && <code className="text-xs text-slate-400">{r.code}</code>}
                    <span className="flex-1 min-w-[200px] text-sm text-slate-900">{r.title}</span>
                    {r.tier && (
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-semibold ${
                        r.tier === 'critical' ? 'bg-rose-50 text-rose-700' : r.tier === 'advisory' ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-700'
                      }`}>
                        {t(`memory.rules.tier.${r.tier}`)}
                      </span>
                    )}
                    <span className="text-xs text-slate-400">{fmtDate(r.updatedAt, locale)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <p className="text-xs text-slate-400">{t('memory.rules.hint')}</p>

      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.title || ''}
        size="lg"
      >
        {selected && (
          <div className="space-y-3">
            {selected.triggers.length > 0 && (
              <p className="text-xs text-slate-500">
                {t('memory.rules.triggers')}：{selected.triggers.join('、')}
              </p>
            )}
            <pre className="whitespace-pre-wrap break-words text-sm text-slate-800 font-sans">{selected.content}</pre>
          </div>
        )}
      </Modal>
    </div>
  );
}
