# i18n 維護流程（路線 C：編譯時自動翻譯）

## 唯一真實來源
- **`zh.json`**：所有可見文字寫這裡（繁體中文白話）

## 自動產出
- **`en.json`** / **`ja.json`**：`npm run translate` 自動產出、commit 進 git

## 一致性控制
- **`glossary.json`**：固定術語對照（鐵律 → Iron Rule 等）、LLM 翻譯時必用
- **`en.override.json`** / **`ja.override.json`**：人工強制覆寫（LLM 翻不好的詞寫這裡）
- **`.translate-cache.json`**：每個 key 的繁中 hash、未變動就跳過

## 維護流程

### 新增一句文案
1. 在元件用 `t('new.key')`
2. 在 `zh.json` 加 `"new.key": "繁中文案"`
3. 跑 `npm run translate`、機器自動翻 EN / JA
4. 5 秒掃 build log review 翻譯
5. 翻不好的詞加進 `en.override.json` / `ja.override.json`
6. git add `zh.json en.json ja.json *.override.json`、commit

### 改文案
- 直接改 `zh.json`、跑 `npm run translate`、會自動偵測 hash 變動重翻

### 詞翻不好
- 開 `en.override.json`、加 `"key": "Better Translation"`、永遠覆蓋 LLM

## 額度成本
- 第一次全翻 200~400 句：約 0.02 美金
- 每次發版增量翻譯：約 0.001 美金
- 一年發版 50 次：約 1.6 台幣
