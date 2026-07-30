import { useState } from 'react';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { useSession } from '../../session/SessionContext';
import { legacyConsoleUrl, primeLegacyConsole } from '../../api/legacy-handoff';
import { legacyFeatureFor } from '@shared/legacy-console-manifest.js';
import { navLabelKey } from './nav-sections';

// 指路牌 — 取代原本四個空殼頁的「此頁面正在重構中、即將於後續階段完工」。
//
// 那句話不是實話：功能沒有在重構中不能用，它現在就在舊後台好好地跑著。空殼頁讓人
// 以為東西壞了或不見了，指路牌直接說「在哪裡」並且把人帶過去，順手把憑證交出去、
// 不用再登入一次。
//
// 標題跟導覽列共用同一個 i18n key（navLabelKey），舊後台頁籤名稱來自功能清單
// （legacy-console-manifest），所以同一個功能不會在兩個地方叫兩個名字。
export default function Signpost({ path }) {
  const t = useT();
  const { id, role, name } = useSession();
  // 憑證交不出去（隱私模式、儲存空間滿）就要改口說「會要求你再登入一次」，
  // 不能繼續承諾不用登入。預設 null 代表還沒點、顯示原本那句。
  const [handedOff, setHandedOff] = useState(null);

  const feature = legacyFeatureFor(path);
  const labelKey = navLabelKey(path);
  const tab = feature?.legacyTab || '';
  const href = legacyConsoleUrl(tab);

  // 左鍵點下去時才寫憑證：新開視窗 / 複製連結不會觸發，最壞情況是舊後台自己要求登入
  const handOff = () => {
    setHandedOff(primeLegacyConsole({ role, id, name }));
  };

  return (
    <div className="max-w-2xl">
      <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-amber-500 shrink-0">
            <TriangleAlert size={20} />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-sage-700">
              {labelKey ? t(labelKey) : path}
            </h1>
            <p className="text-sm text-slate-600 mt-2 leading-relaxed">
              {t('signpost.body')}
            </p>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed">
              {t('signpost.where', { tab: t(`legacy.tab.${tab}`) })}
            </p>
          </div>
        </div>

        <a
          href={href}
          onClick={handOff}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-sage-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sage-700"
        >
          {t('signpost.cta', { tab: t(`legacy.tab.${tab}`) })}
          <ExternalLink size={14} />
        </a>

        <p className="text-xs text-slate-400 mt-3">
          {handedOff === false ? t('signpost.relogin_needed') : t('signpost.no_relogin')}
        </p>
      </div>
    </div>
  );
}
