# GitHub Copilot 設定指南

## .github/copilot-instructions.md

在專案的 `.github/copilot-instructions.md` 加入精簡版偏好摘要：

```
## 開發偏好
- 語言：繁體中文
- 所有 code 必須包含 logging
- 修 bug 前先寫 reproduction test
- 不要 blind edit，驗證後再提交

## 注意事項
- SSH 不要頻繁登入登出
- 不要 commit .env 或密碼
- 優先用 migration 而非 raw SQL
```

注意：Copilot 目前不支援 MCP，所以無法直接連接 OwnMind API。
以上是手動摘要的偏好設定。
