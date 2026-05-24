import { useState, useRef, useEffect } from 'react';
import { ChevronDown, User, LogOut, Settings } from 'lucide-react';
import { SUPPORTED_LOCALES } from '../../i18n';
import { useLocale, useT } from '../../i18n/LocaleContext';
import RoleBadge from './RoleBadge';

const LOCALE_LABELS = { zh: '繁中', en: 'EN', ja: '日本語' };
const ROLES = ['user', 'admin', 'super_admin'];

// 上方列 — 標題 / 副標題 / 語系切換 / 角色模擬器 / 頭像選單
// 角色模擬器只給 super_admin 看（其他角色傳 onRoleChange={null} 即隱藏）
export default function TopBar({
  pageTitle,
  pageSubtitle,
  currentRole,
  onRoleChange,
  profile,
  onLogout,
  onOpenProfile,
}) {
  const { locale, setLocale } = useLocale();
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-slate-900 truncate">
          {pageTitle || t('header.title')}
        </h1>
        {pageSubtitle && (
          <p className="text-xs text-slate-500 truncate">{pageSubtitle}</p>
        )}
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-1 bg-slate-100 border border-slate-200 rounded-full p-0.5">
          {SUPPORTED_LOCALES.map((loc) => (
            <button
              key={loc}
              onClick={() => setLocale(loc)}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                locale === loc
                  ? 'bg-white text-sage-600 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {LOCALE_LABELS[loc]}
            </button>
          ))}
        </div>

        {onRoleChange && (
          <div className="flex items-center gap-1 bg-slate-100 border border-slate-200 rounded-full p-0.5">
            <span className="px-2 text-[11px] text-slate-500 font-medium">
              {t('header.role_simulator')}
            </span>
            {ROLES.map((r) => (
              <button
                key={r}
                onClick={() => onRoleChange(r)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                  currentRole === r
                    ? 'bg-white text-sage-600 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t(`header.role.${r}`)}
              </button>
            ))}
          </div>
        )}

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full hover:bg-slate-100 transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-sage-500 text-white flex items-center justify-center font-bold text-xs">
              {profile?.name?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="hidden sm:flex items-center gap-1.5">
              <span className="text-xs font-semibold text-slate-900">
                {profile?.name || t('header.guest')}
              </span>
              <RoleBadge role={currentRole} />
            </div>
            <ChevronDown size={14} className="text-slate-500" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-2 w-48 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden z-40">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onOpenProfile?.();
                }}
                className="w-full flex items-center gap-2 px-4 py-2 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <User size={14} /> {t('menu.profile')}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onOpenProfile?.('preferences');
                }}
                className="w-full flex items-center gap-2 px-4 py-2 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <Settings size={14} /> {t('menu.preferences')}
              </button>
              <div className="h-px bg-slate-100" />
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onLogout?.();
                }}
                className="w-full flex items-center gap-2 px-4 py-2 text-xs text-red-600 hover:bg-red-50 transition-colors"
              >
                <LogOut size={14} /> {t('menu.logout')}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
