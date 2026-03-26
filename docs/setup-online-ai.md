# 線上 AI 使用指南

線上 AI（claude.ai、ChatGPT、Gemini）無法直接呼叫 API，但可以透過以下方式使用 OwnMind。

## 方法一：手動載入

在對話開頭貼入你的記憶內容。你可以透過 API 匯出：

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" http://kkvin.com:3100/api/export
```

## 方法二：ChatGPT GPTs（推薦）

建立一個自訂 GPT，設定 Actions 連接 OwnMind API。

### OpenAPI Schema

在 GPTs 的 Actions 設定中，匯入以下 schema：
（參考 docs/openapi.yaml）

## 方法三：開場白 Prompt

在對話開頭貼入以下 prompt：

```
我使用 OwnMind 個人記憶系統。以下是我的偏好和規則：

[貼入你的 profile 和 iron rules]

請在這次對話中遵守以上偏好。如果你學到新的重要資訊，
請在對話結束前整理成 OwnMind 格式，讓我手動匯入。
```
