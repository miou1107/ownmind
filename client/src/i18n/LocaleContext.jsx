import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { t as translate, SUPPORTED_LOCALES } from './index.js';

// 語系全域狀態 — Provider 放在 main.jsx 最外層、所有元件透過 useLocale / useT 存取
// 解掉 v1.20.0 reviewer 留下的 TODO「locale 改 context 化、不用 props 傳到底」

const STORAGE_KEY = 'ownmind.locale';
const DEFAULT_LOCALE = 'zh';

function detectInitialLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED_LOCALES.includes(saved)) return saved;
  } catch {
    // localStorage 可能在 SSR / 隱私模式失敗、忽略
  }
  return DEFAULT_LOCALE;
}

const LocaleContext = createContext({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
});

export function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(detectInitialLocale);

  const setLocale = useCallback((next) => {
    if (!SUPPORTED_LOCALES.includes(next)) return;
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 寫不進去就算了
    }
    // 同步 html lang 屬性、讓螢幕閱讀器知道
    document.documentElement.lang = next === 'zh' ? 'zh-Hant' : next;
  }, []);

  // 初次 mount 也要同步 html lang
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-Hant' : locale;
  }, [locale]);

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}

// 包裝 t() 自動帶入當前 locale、用法：const t = useT(); t('nav.usage')
export function useT() {
  const { locale } = useLocale();
  return useCallback(
    (key, params) => translate(key, locale, params),
    [locale],
  );
}
