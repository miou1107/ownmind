#!/usr/bin/env node
// 編譯時自動翻譯腳本（路線 C）
//
// 環境變數（任一組可用）：
//   TRANSLATE_API_BASE  — OpenAI 相容 API base URL（必填，例如 https://your-host/llm-switch/v1）
//   TRANSLATE_API_KEY   — 對應 API key
//   TRANSLATE_MODEL     — 翻譯模型（預設 gpt-4o-mini）
//
// 若 TRANSLATE_API_KEY 未設、自動退到 manual mode：列出新句、提示貼進 Claude Code 翻
//
// 4 機制控制翻譯一致性：
// 1. git 快取 — 翻完寫進 en.json / ja.json、之後不再翻
// 2. LLM temperature=0 — 降低隨機性
// 3. 術語表 glossary.json — prompt 強制 LLM 用固定對照
// 4. override 字典 — 人工覆寫 LLM 翻不好的詞

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N_DIR = join(__dirname, '..', 'i18n');

const API_BASE = process.env.TRANSLATE_API_BASE || '';
const API_KEY = process.env.TRANSLATE_API_KEY;
const MODEL = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';

function loadJson(file) {
  return JSON.parse(readFileSync(join(I18N_DIR, file), 'utf8'));
}

function saveJson(file, data) {
  writeFileSync(join(I18N_DIR, file), JSON.stringify(data, null, 2) + '\n');
}

function hash(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 8);
}

function findMissingKeys(zh, target, hashCache) {
  const missing = [];
  for (const [key, value] of Object.entries(zh)) {
    if (key.startsWith('_')) continue;
    const currentHash = hash(value);
    const cachedHash = hashCache[key];
    if (!target[key] || cachedHash !== currentHash) {
      missing.push({ key, zh: value, currentHash });
    }
  }
  return missing;
}

function buildPrompt(items, targetLang, glossary) {
  const langName = targetLang === 'en' ? 'English' : 'Japanese';
  const glossaryEntries = Object.entries(glossary[`zh-to-${targetLang}`] || {})
    .filter(([k]) => !k.startsWith('_'))
    .map(([zh, target]) => `  "${zh}" → "${target}"`)
    .join('\n');

  return `Translate the following Traditional Chinese UI strings to ${langName}.

STRICT RULES:
1. Use this glossary for term consistency (MUST use these exact translations):
${glossaryEntries}

2. Keep placeholders intact: {name}, {count}, etc. must remain unchanged
3. Translation must fit UI context (buttons, labels, menus — keep short and natural)
4. Output ONLY a JSON object mapping the original Chinese to translation
5. No explanations, no markdown, just raw JSON

Input strings:
${items.map((i) => `  ${JSON.stringify(i.zh)}`).join('\n')}

Output JSON:`;
}

async function callLLM(prompt) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a precise UI string translator. Output only raw JSON.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const text = data.choices[0].message.content.trim();
  // 去掉可能的 markdown code fence
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(cleaned);
}

async function translateBatch(items, targetLang, glossary) {
  if (items.length === 0) return {};
  const prompt = buildPrompt(items, targetLang, glossary);
  const result = await callLLM(prompt);
  // result 是 { 中文: 翻譯 }、轉成 { key: 翻譯 }
  const mapped = {};
  for (const item of items) {
    const translated = result[item.zh];
    if (translated) mapped[item.key] = translated;
    else console.warn(`  ⚠️  缺翻譯：${item.key} (${item.zh})`);
  }
  return mapped;
}

function applyOverride(target, override) {
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith('_')) continue;
    target[key] = value;
  }
}

async function main() {
  const zh = loadJson('zh.json');
  const en = loadJson('en.json');
  const ja = loadJson('ja.json');
  const glossary = loadJson('glossary.json');
  const enOverride = loadJson('en.override.json');
  const jaOverride = loadJson('ja.override.json');

  const cachePath = join(I18N_DIR, '.translate-cache.json');
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : { en: {}, ja: {} };

  const missingEn = findMissingKeys(zh, en, cache.en);
  const missingJa = findMissingKeys(zh, ja, cache.ja);

  if (missingEn.length === 0 && missingJa.length === 0) {
    console.log('✅ 翻譯已最新、無需呼叫 LLM');
    return;
  }

  console.log(`📝 待翻譯：英文 ${missingEn.length} 句、日文 ${missingJa.length} 句`);

  if (!API_KEY) {
    console.log('');
    console.log('⚠️  TRANSLATE_API_KEY 未設、走 manual mode');
    console.log('   請手動翻譯下列 key、寫進 en.json / ja.json：');
    console.log('');
    for (const item of missingEn) console.log(`  英  ${item.key}: ${item.zh}`);
    for (const item of missingJa) console.log(`  日  ${item.key}: ${item.zh}`);
    console.log('');
    console.log('   或設定環境變數啟用自動翻譯：');
    console.log('   export TRANSLATE_API_KEY=<llm-switch 或 OpenAI key>');
    console.log('   export TRANSLATE_API_BASE=<api base、例如 https://your-host/llm-switch/v1>');
    console.log('   export TRANSLATE_MODEL=<model 名、預設 gpt-4o-mini>');
    // 仍套用 override（即使 LLM 沒跑、override 字典還是要 apply）
    applyOverride(en, enOverride);
    applyOverride(ja, jaOverride);
    saveJson('en.json', en);
    saveJson('ja.json', ja);
    return;
  }

  console.log(`🤖 用 ${MODEL} 翻譯（API base: ${API_BASE}）`);

  if (missingEn.length > 0) {
    console.log(`   翻英文 ${missingEn.length} 句...`);
    const enResult = await translateBatch(missingEn, 'en', glossary);
    Object.assign(en, enResult);
    for (const item of missingEn) cache.en[item.key] = item.currentHash;
  }

  if (missingJa.length > 0) {
    console.log(`   翻日文 ${missingJa.length} 句...`);
    const jaResult = await translateBatch(missingJa, 'ja', glossary);
    Object.assign(ja, jaResult);
    for (const item of missingJa) cache.ja[item.key] = item.currentHash;
  }

  // 套用 override（覆蓋 LLM 結果）
  applyOverride(en, enOverride);
  applyOverride(ja, jaOverride);

  saveJson('en.json', en);
  saveJson('ja.json', ja);
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');

  console.log('✅ 翻譯完成、已寫進 en.json / ja.json、cache 更新');
}

main().catch((err) => {
  console.error('❌ 翻譯腳本錯誤：', err.message);
  process.exit(1);
});
