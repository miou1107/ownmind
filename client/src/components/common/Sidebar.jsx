import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  ChevronDown, BarChart3, FolderClock, GitBranch, Bug,
  FileText, TriangleAlert, CalendarDays, UsersRound, LineChart,
  UserCircle, Shield, Key, Users, AlertOctagon,
  Sliders, Megaphone, History, Sparkles,
} from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { NAV_SECTIONS, visibleSections } from './nav-sections';
import { isSignpost } from '@shared/legacy-console-manifest.js';

// 導覽結構已抽到 nav-sections.js（純資料、無 JSX），這樣「誰看得到哪一項」才有辦法被
// 真的跑起來的測試拿去跟路由守門員比對。JSX 檔案 node --test 進不去。
// 這裡只留 path 到圖示的對照。
const ICONS = {
  '/portal/usage': BarChart3,
  '/portal/project-history': FolderClock,
  '/portal/handoffs': GitBranch,
  '/portal/reports': Bug,
  '/portal/narrative': FileText,
  '/portal/pitfalls': TriangleAlert,
  '/portal/periodic-reports': CalendarDays,
  '/team/usage': UsersRound,
  '/team/stats': LineChart,
  '/preference/profile': UserCircle,
  '/preference/security': Shield,
  '/preference/vault': Key,
  '/admin/team': Users,
  '/admin/bugs': AlertOctagon,
  '/system/config': Sliders,
  '/system/broadcast': Megaphone,
  '/system/work-log': History,
};

function navLinkClass({ isActive }) {
  const base =
    'flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors';
  return isActive
    ? `${base} bg-white text-sage-600 shadow-sm border border-sage-100`
    : `${base} text-slate-600 hover:bg-slate-200/50 hover:text-slate-900`;
}

export default function Sidebar({ role = 'user', version }) {
  const t = useT();
  // 預設全展開、user 可折疊。用 NAV_SECTIONS 而不是 visibleSections('super_admin')：
  // 要的是「所有區塊」，拿最高角色當代名詞多繞一層而且可能算錯
  const [openSections, setOpenSections] = useState(() =>
    Object.fromEntries(NAV_SECTIONS.map((s) => [s.id, true])),
  );

  const toggle = (id) =>
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));

  // 區塊與項目都按角色過濾；一個區塊只要還有一項看得到就會出現
  const sections = visibleSections(role);

  return (
    <aside className="w-64 bg-slate-50 border-r border-slate-200 flex flex-col">
      <div className="p-5 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-sage-500 text-white flex items-center justify-center">
            <Sparkles size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-900 truncate">
              {t('header.title')}
            </p>
            {version && (
              <p className="text-[10px] font-mono text-slate-400">{version}</p>
            )}
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
        {sections.map((section) => (
          <div key={section.id}>
            <button
              onClick={() => toggle(section.id)}
              className="w-full flex items-center justify-between px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-600 transition-colors"
            >
              <span>{t(section.labelKey)}</span>
              <ChevronDown
                size={12}
                className={`transition-transform ${
                  openSections[section.id] ? '' : '-rotate-90'
                }`}
              />
            </button>
            {openSections[section.id] && (
              <ul className="mt-1.5 space-y-1">
                {section.items.map((item) => {
                  const Icon = ICONS[item.path];
                  // 還在舊後台的功能標一個小點、不要讓人以為已經搬完
                  const pending = isSignpost(item.path);
                  return (
                    <li key={item.path}>
                      <NavLink to={item.path} className={navLinkClass}>
                        <Icon size={14} />
                        <span className="flex-1 truncate">{t(item.labelKey)}</span>
                        {pending && (
                          <span
                            title={t('nav.still_in_legacy')}
                            aria-label={t('nav.still_in_legacy')}
                            className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
                          />
                        )}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </nav>
    </aside>
  );
}
