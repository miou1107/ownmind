// i18n 路線 C：寫繁中、編譯時自動翻譯
// - zh.json：唯一真實來源（手寫）
// - en.json / ja.json：translate.mjs 編譯時產出（commit 進 git）
// - glossary.json：固定術語對照（LLM 翻譯時參考）
// - {locale}.override.json：人工強制覆寫（LLM 翻不好的詞）

import zh from './zh.json';
import en from './en.json';
import ja from './ja.json';

const dictionaries = { zh, en, ja };

export function t(key, locale = 'zh', params = {}) {
  const dict = dictionaries[locale] || dictionaries.zh;
  let str = dict[key] ?? dictionaries.zh[key] ?? key;
  Object.entries(params).forEach(([k, v]) => {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  });
  return str;
}

export const SUPPORTED_LOCALES = ['zh', 'en', 'ja'];
