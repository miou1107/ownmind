FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY src/ ./src/
COPY db/ ./db/
# shared/ 被 server 端多個模組 import（events.js 需要 id-helper，若未來也可能需要
# helpers.js 等）。scanners/ 內有 base.js / id-helper.js / claude-code.js / codex.js
# / opencode.js / vscode-telemetry.js / cursor.js / antigravity.js；id-helper 是
# server 端必須，其餘為 client scanner 共用同一份檔案的部署便利考量
COPY shared/ ./shared/

EXPOSE 3000

CMD ["node", "src/index.js"]
