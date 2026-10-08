import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { useSession } from '../../session/SessionContext';
import { visibleSections, firstVisiblePath } from '../../components/common/nav-sections';

// v1.32.0, Phase 1 — 總覽的第一版：進到每一區的門，每一區一句話說它回答什麼。
//
// 第 2 段會把這一頁換成三個狀態燈、等你處理的清單、四張數字卡（/api/me/overview）。
// 現在還沒有那支 API，所以這裡不放任何數字——沒有來源的數字就是編的。
export default function HomePage() {
  const t = useT();
  const { role } = useSession();
  const entries = visibleSections(role).filter((e) => e.id !== 'home');

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">{t('home.intro')}</p>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <li key={entry.id}>
            <Link
              to={firstVisiblePath(entry, role) ?? entry.path}
              className="block h-full bg-white border border-slate-200 rounded-2xl p-5 shadow-sm hover:border-sage-300 hover:shadow transition focus-visible:outline-2 focus-visible:outline-sage-500"
            >
              <h2 className="text-base font-bold text-slate-900">{t(entry.labelKey)}</h2>
              <p className="mt-1 text-sm text-slate-600">{t(`home.card.${entry.id}`)}</p>
              <p className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-sage-700">
                {t('home.open')} <ArrowRight size={12} />
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
