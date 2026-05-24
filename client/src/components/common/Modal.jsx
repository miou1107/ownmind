import { useEffect } from 'react';
import { X } from 'lucide-react';

// 通用彈窗 — 含背景遮罩、ESC 關閉、點背景關閉
// size: sm = max-w-md, md = max-w-lg, lg = max-w-2xl
// glassmorphism: 開啟時用半透明白底 + backdrop-blur（changelog 用）
export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  glassmorphism = false,
}) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sizeClass = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' }[size];
  const panelClass = glassmorphism
    ? 'bg-white/95 backdrop-blur-sm border-white/50'
    : 'bg-white border-slate-200';

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        className={`w-full ${sizeClass} ${panelClass} border rounded-3xl shadow-xl overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 id="modal-title" className="text-base font-bold text-slate-900">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-900 transition-colors"
            aria-label="關閉"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 max-h-[70vh] overflow-y-auto">{children}</div>

        {footer && (
          <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
