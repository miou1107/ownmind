#!/usr/bin/env node
// Compile-time auto-translation script (route C).
//
// Environment variables (used together):
//   TRANSLATE_API_BASE  — OpenAI-compatible API base URL (required, e.g. https://your-host/llm-switch/v1)
//   TRANSLATE_API_KEY   — matching API key
//   TRANSLATE_MODEL     — translation model (default gpt-4o-mini)
//
// If TRANSLATE_API_KEY is unset, falls back to manual mode: lists the new strings and prompts
// you to paste them into Claude Code for translation.
//
// 4 mechanisms keep translation consistent:
// 1. git cache — a string is translated once, written into en.json / ja.json, and never
//    re-translated as long as the source Chinese does not change
// 2. LLM temperature=0 — reduces randomness
// 3. glossary.json — forces the LLM to use fixed term mappings (also doubles as a way to pin
//    protocol literals — tokens like reply keywords that must survive untranslated — by
//    mapping them to themselves)
// 4. override dictionaries — human overrides for terms the LLM translates poorly, always
//    applied last so they can never be clobbered by a later LLM pass
//
// --dir <path>
//   Points the whole pipeline (zh/en/ja dictionaries, the translate cache, glossary, and
//   overrides) at a different directory instead of the default client/src/i18n. Resolved
//   relative to the current working directory; an absolute path is used as-is. Omitting
//   --dir keeps the original client/src/i18n behavior byte-for-byte.
//
//   Only zh.json (the hand-written source of truth) is required to exist under --dir.
//   en.json, ja.json, glossary.json, en.override.json and ja.override.json are all optional
//   and default to an empty object, so a brand-new dictionary directory can be bootstrapped by
//   the very first run rather than needing every scaffold file created by hand first.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Unchanged from before --dir existed: the client dictionary directory, resolved relative to
// this script's own location so it works regardless of the caller's cwd.
export const DEFAULT_I18N_DIR = join(__dirname, '..', 'i18n');

const API_BASE = process.env.TRANSLATE_API_BASE || '';
const API_KEY = process.env.TRANSLATE_API_KEY;
const MODEL = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';

/** Pulls the value following `--dir` out of argv. Returns null when absent or dangling. */
export function parseDirArg(argv) {
  const i = argv.indexOf('--dir');
  if (i === -1 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

/**
 * Resolves the dictionary directory for this run: `--dir` (resolved against `cwd`) when given,
 * otherwise the original client/src/i18n directory, unchanged.
 */
export function resolveI18nDir(argv, { cwd = process.cwd(), defaultDir = DEFAULT_I18N_DIR } = {}) {
  const dirArg = parseDirArg(argv);
  return dirArg ? resolve(cwd, dirArg) : defaultDir;
}

const I18N_DIR = resolveI18nDir(process.argv.slice(2));

function loadRequiredJson(file) {
  return JSON.parse(readFileSync(join(I18N_DIR, file), 'utf8'));
}

/** Same as loadRequiredJson, but returns `fallback` instead of throwing when the file is absent. */
function loadOptionalJson(file, fallback) {
  const path = join(I18N_DIR, file);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
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
  // Strip a possible markdown code fence.
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(cleaned);
}

async function translateBatch(items, targetLang, glossary) {
  if (items.length === 0) return {};
  const prompt = buildPrompt(items, targetLang, glossary);
  const result = await callLLM(prompt);
  // result is { chinese: translation } — remap to { key: translation }
  const mapped = {};
  for (const item of items) {
    const translated = result[item.zh];
    if (translated) mapped[item.key] = translated;
    else console.warn(`  Missing translation: ${item.key} (${item.zh})`);
  }
  return mapped;
}

export function applyOverride(target, override) {
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith('_')) continue;
    target[key] = value;
  }
}

async function main() {
  const zh = loadRequiredJson('zh.json');
  const en = loadOptionalJson('en.json', {});
  const ja = loadOptionalJson('ja.json', {});
  const glossary = loadOptionalJson('glossary.json', {});
  const enOverride = loadOptionalJson('en.override.json', {});
  const jaOverride = loadOptionalJson('ja.override.json', {});

  const cachePath = join(I18N_DIR, '.translate-cache.json');
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : { en: {}, ja: {} };

  const missingEn = findMissingKeys(zh, en, cache.en);
  const missingJa = findMissingKeys(zh, ja, cache.ja);

  if (missingEn.length === 0 && missingJa.length === 0) {
    console.log('Translations are already up to date — no LLM call needed');
    return;
  }

  console.log(`Pending translation: ${missingEn.length} English, ${missingJa.length} Japanese`);

  if (!API_KEY) {
    console.log('');
    console.log('TRANSLATE_API_KEY not set — falling back to manual mode');
    console.log('   Translate the following keys by hand and write them into en.json / ja.json:');
    console.log('');
    for (const item of missingEn) console.log(`  en  ${item.key}: ${item.zh}`);
    for (const item of missingJa) console.log(`  ja  ${item.key}: ${item.zh}`);
    console.log('');
    console.log('   Or set these environment variables to enable automatic translation:');
    console.log('   export TRANSLATE_API_KEY=<llm-switch or OpenAI key>');
    console.log('   export TRANSLATE_API_BASE=<api base, e.g. https://your-host/llm-switch/v1>');
    console.log('   export TRANSLATE_MODEL=<model name, default gpt-4o-mini>');
    // Overrides still apply even though the LLM did not run.
    applyOverride(en, enOverride);
    applyOverride(ja, jaOverride);
    saveJson('en.json', en);
    saveJson('ja.json', ja);
    return;
  }

  console.log(`Translating with ${MODEL} (API base: ${API_BASE})`);

  if (missingEn.length > 0) {
    console.log(`   Translating ${missingEn.length} English string(s)...`);
    const enResult = await translateBatch(missingEn, 'en', glossary);
    Object.assign(en, enResult);
    for (const item of missingEn) cache.en[item.key] = item.currentHash;
  }

  if (missingJa.length > 0) {
    console.log(`   Translating ${missingJa.length} Japanese string(s)...`);
    const jaResult = await translateBatch(missingJa, 'ja', glossary);
    Object.assign(ja, jaResult);
    for (const item of missingJa) cache.ja[item.key] = item.currentHash;
  }

  // Overrides are applied last so they always win over the LLM result.
  applyOverride(en, enOverride);
  applyOverride(ja, jaOverride);

  saveJson('en.json', en);
  saveJson('ja.json', ja);
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');

  console.log('Done — en.json / ja.json written, cache updated');
}

// Only run the CLI when this file is the process entry point, not when it is imported (e.g.
// from tests, to reuse parseDirArg / resolveI18nDir / applyOverride as pure functions).
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error('Translation script error:', err.message);
    process.exit(1);
  });
}
