import { useEffect, useRef } from 'react';
import { Terminal, Edit3, Key, Trash2 } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { visibleMenuItems } from './menu-visibility.js';

// Per-row dropdown. The four items and their order come from
// visibleMenuItems(actor, row); this component only renders them and handles
// click-outside dismissal. Fixed-position gymnastics stay here so the
// containing table row can be plain HTML.

const META = {
  'install-prompt': { icon: Terminal, labelKey: 'team.menu.install' },
  edit:             { icon: Edit3,    labelKey: 'team.menu.edit' },
  password:         { icon: Key,      labelKey: 'team.menu.password' },
  delete:           { icon: Trash2,   labelKey: 'team.menu.delete', danger: true },
};

export default function RowMenu({ actor, row, onSelect, onDismiss }) {
  const t = useT();
  const ref = useRef(null);
  const items = visibleMenuItems(actor, row);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onDismiss();
    };
    const key = (e) => { if (e.key === 'Escape') onDismiss(); };
    // Defer for one tick so the click that opened us doesn't dismiss us.
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', handler);
    }, 0);
    window.addEventListener('keydown', key);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('keydown', key);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      role="menu"
      className="absolute right-0 top-full mt-1 min-w-[180px] bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden z-10"
    >
      {items.map((id, idx) => {
        const { icon: Icon, labelKey, danger } = META[id];
        const isFirstDanger = danger && idx > 0 && !META[items[idx - 1]]?.danger;
        return (
          <button
            key={id}
            role="menuitem"
            onClick={() => { onSelect(id); onDismiss(); }}
            className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-slate-50 ${
              danger ? 'text-red-600' : 'text-slate-700'
            } ${isFirstDanger ? 'border-t border-slate-200' : ''}`}
          >
            <Icon size={14} />
            {t(labelKey)}
          </button>
        );
      })}
    </div>
  );
}
