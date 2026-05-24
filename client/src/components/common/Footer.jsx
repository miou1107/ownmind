import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import Modal from './Modal';

// 頁尾 — 版本號 + changelog 觸發按鈕
// changelog 內容為時間軸式陳列、用毛玻璃彈窗呈現
export default function Footer({ version, changelog = [] }) {
  const t = useT();
  const [showChangelog, setShowChangelog] = useState(false);

  return (
    <>
      <footer className="border-t border-slate-200 bg-white/50 px-6 py-3 flex items-center justify-between text-[11px] text-slate-500">
        <span>
          OwnMind <span className="font-mono">{version}</span>
        </span>
        <button
          onClick={() => setShowChangelog(true)}
          className="flex items-center gap-1.5 px-3 py-1 rounded-full hover:bg-slate-100 transition-colors text-slate-600 hover:text-sage-600 font-semibold"
        >
          <Sparkles size={12} />
          {t('footer.changelog')}
        </button>
        <span>{t('footer.copyright')}</span>
      </footer>

      <Modal
        isOpen={showChangelog}
        onClose={() => setShowChangelog(false)}
        title={t('changelog.title')}
        size="lg"
        glassmorphism
      >
        {changelog.length === 0 ? (
          <p className="text-xs text-slate-500 text-center py-8">
            {t('changelog.empty')}
          </p>
        ) : (
          <div className="relative pl-6 border-l-2 border-slate-100 space-y-6">
            {changelog.map((entry) => (
              <div key={entry.version} className="relative">
                <div className="absolute -left-[31px] top-1 w-4 h-4 bg-sage-500 rounded-full border-4 border-white shadow-sm" />
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-sm font-bold text-slate-900">
                    {entry.version}
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">
                    {entry.date}
                  </span>
                </div>
                {entry.title && (
                  <p className="text-xs font-semibold text-slate-700 mb-1">
                    {entry.title}
                  </p>
                )}
                {entry.description && (
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {entry.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}
