import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Inbox, BarChart3, UsersRound, Brain, UserCircle, Sliders, Sparkles, X,
} from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { visibleSections, firstVisiblePath } from './nav-sections';

// 導覽結構已抽到 nav-sections.js（純資料、無 JSX），這樣「誰看得到哪一項」才有辦法被
// 真的跑起來的測試拿去跟路由守門員比對。JSX 檔案 node --test 進不去。
// 這裡只留入口到圖示的對照。
//
// v1.32.0 — 左邊從五組二十項收成七個入口；每個入口裡的分頁在 Layout 畫、不在這裡。
// 一個入口是「亮」的，看的是現在的網址是不是在它底下，不是連結本身是不是被點到：
// 入口連到它第一個分頁，人在第二個分頁時入口還是得亮。
const ICONS = {
  '/home': LayoutDashboard,
  '/inbox': Inbox,
  '/usage': BarChart3,
  '/team': UsersRound,
  '/memory': Brain,
  '/settings': UserCircle,
  '/admin': Sliders,
};

function entryClass(active) {
  const base =
    'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-semibold transition-colors '
    + 'focus-visible:outline-2 focus-visible:outline-sage-500';
  return active
    ? `${base} bg-white text-sage-600 shadow-sm border border-sage-100`
    : `${base} text-slate-600 hover:bg-slate-200/50 hover:text-slate-900`;
}

/** Whether `pathname` is this entry's own path or one of its tabs. */
export function isEntryActive(entry, pathname) {
  return pathname === entry.path || pathname.startsWith(`${entry.path}/`);
}

export default function Sidebar({ role = 'user', version, onNavigate, onClose }) {
  const t = useT();
  const { pathname } = useLocation();

  // 入口按角色過濾；一個入口只要還有一個分頁看得到就會出現
  const entries = visibleSections(role);

  return (
    <aside className="w-64 h-full bg-slate-50 border-r border-slate-200 flex flex-col">
      <div className="p-5 border-b border-slate-200 flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-sage-500 text-white flex items-center justify-center">
          <Sparkles size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-900 truncate">
            {t('header.title')}
          </p>
          {version && (
            <p className="text-[10px] font-mono text-slate-400">{version}</p>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('nav.menu_close')}
            className="min-[960px]:hidden p-1 rounded text-slate-500 hover:text-slate-900"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-1">
          {entries.map((entry) => {
            const Icon = ICONS[entry.path];
            return (
              <li key={entry.id}>
                <Link
                  to={firstVisiblePath(entry, role) ?? entry.path}
                  onClick={onNavigate}
                  aria-current={isEntryActive(entry, pathname) ? 'page' : undefined}
                  className={entryClass(isEntryActive(entry, pathname))}
                >
                  <Icon size={16} />
                  <span className="flex-1 truncate">{t(entry.labelKey)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
