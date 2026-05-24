import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  ChevronDown, BarChart3, FolderClock, GitBranch, Bug,
  UserCircle, Shield, Key, Users, AlertOctagon,
  Sliders, Megaphone, FileSearch, Sparkles,
} from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';

// 導航結構 — 4 區段、按角色決定能看到哪些
// roles 為「至少一個符合就顯示」邏輯
const NAV_SECTIONS = [
  {
    id: 'portal',
    labelKey: 'nav.section.portal_analytics',
    roles: ['user', 'admin', 'super_admin'],
    items: [
      { path: '/portal/usage', labelKey: 'nav.usage', icon: BarChart3 },
      { path: '/portal/project-history', labelKey: 'nav.project_history', icon: FolderClock },
      { path: '/portal/handoffs', labelKey: 'nav.handoffs', icon: GitBranch },
      { path: '/portal/reports', labelKey: 'nav.reports', icon: Bug },
    ],
  },
  {
    id: 'preference',
    labelKey: 'nav.section.preference',
    roles: ['user', 'admin', 'super_admin'],
    items: [
      { path: '/preference/profile', labelKey: 'nav.profile', icon: UserCircle },
      { path: '/preference/security', labelKey: 'nav.security', icon: Shield },
      { path: '/preference/vault', labelKey: 'nav.vault', icon: Key },
    ],
  },
  {
    id: 'admin',
    labelKey: 'nav.section.admin',
    roles: ['admin', 'super_admin'],
    items: [
      { path: '/admin/team', labelKey: 'nav.team', icon: Users },
      { path: '/admin/bugs', labelKey: 'nav.bugs', icon: AlertOctagon },
    ],
  },
  {
    id: 'super',
    labelKey: 'nav.section.super',
    roles: ['super_admin'],
    items: [
      { path: '/super/config', labelKey: 'nav.config', icon: Sliders },
      { path: '/super/broadcast', labelKey: 'nav.broadcast', icon: Megaphone },
      { path: '/super/audit', labelKey: 'nav.audit', icon: FileSearch },
    ],
  },
];

function navLinkClass({ isActive }) {
  const base =
    'flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors';
  return isActive
    ? `${base} bg-white text-sage-600 shadow-sm border border-sage-100`
    : `${base} text-slate-600 hover:bg-slate-200/50 hover:text-slate-900`;
}

export default function Sidebar({ role = 'user', version }) {
  const t = useT();
  // 預設全展開、user 可折疊
  const [openSections, setOpenSections] = useState(() =>
    Object.fromEntries(NAV_SECTIONS.map((s) => [s.id, true])),
  );

  const toggle = (id) =>
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));

  const visibleSections = NAV_SECTIONS.filter((s) => s.roles.includes(role));

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
        {visibleSections.map((section) => (
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
                  const Icon = item.icon;
                  return (
                    <li key={item.path}>
                      <NavLink to={item.path} className={navLinkClass}>
                        <Icon size={14} />
                        <span>{t(item.labelKey)}</span>
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
