import { useT } from '../../i18n/LocaleContext';

const ROLE_STYLES = {
  user: 'bg-slate-100 text-slate-600 border-slate-200',
  admin: 'bg-indigo-50 text-indigo-600 border-indigo-100',
  super_admin: 'bg-amber-50 text-amber-700 border-amber-100',
};

const ROLE_LABEL_KEYS = {
  user: 'header.role.user',
  admin: 'header.role.admin',
  super_admin: 'header.role.super_admin',
};

export default function RoleBadge({ role, size = 'sm' }) {
  const t = useT();
  const style = ROLE_STYLES[role] || ROLE_STYLES.user;
  const labelKey = ROLE_LABEL_KEYS[role] || ROLE_LABEL_KEYS.user;
  const sizeClass = size === 'md'
    ? 'text-xs px-2.5 py-1'
    : 'text-[10px] px-2 py-0.5';

  return (
    <span
      className={`inline-flex items-center font-bold rounded-full border ${sizeClass} ${style}`}
    >
      {t(labelKey)}
    </span>
  );
}
