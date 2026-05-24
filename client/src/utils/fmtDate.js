// 共用日期格式工具 — 把 ISO timestamp 轉成跟 LocaleContext 同步的 user 看得懂的格式
// 用法：const t = useT(); const { locale } = useLocale(); fmtDate(iso, locale);
//
// 設計：
//   - invalid date 回 '-'（不丟 'Invalid Date' 字串給 user）
//   - 用 BCP-47 locale 字串、不依賴瀏覽器 default locale

export function fmtDate(iso, locale) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  const bcp47 = locale === 'zh' ? 'zh-TW' : locale === 'ja' ? 'ja-JP' : 'en-US';
  return d.toLocaleString(bcp47);
}
