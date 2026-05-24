# v1.20：multi-stage build — 前端 client (Vite + React) 編譯產物嵌入 image
# Stage 1: 前端編譯
FROM node:20-alpine AS client-builder
WORKDIR /client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
# build 內含 npm run translate（i18n 增量翻譯）、若無 LLM 金鑰會跳到 manual fallback
RUN npm run build:no-translate

# Stage 2: server 主 image
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY src/ ./src/
COPY db/ ./db/
# v1.17.6: bootstrap scripts are served by src/app.js at boot via readFileSync.
# Must copy them into the image or the container crashes on startup.
COPY scripts/bootstrap.sh ./scripts/bootstrap.sh
COPY scripts/bootstrap.ps1 ./scripts/bootstrap.ps1
# shared/ 被 server 端多個模組 import（events.js 需要 id-helper，若未來也可能需要
# helpers.js 等）。scanners/ 內有 base.js / id-helper.js / claude-code.js / codex.js
# / opencode.js / vscode-telemetry.js / cursor.js / antigravity.js；id-helper 是
# server 端必須，其餘為 client scanner 共用同一份檔案的部署便利考量
COPY shared/ ./shared/

# v1.20：藍綠並存策略 — 新版 client build 產物放 dashboard/、舊 admin/ + me/ 維持不動
# 等新版觀察期通過、Vin 拍板退役才會把舊版搬到 legacy-admin-v1.html 並 301 轉址
COPY --from=client-builder /client/dist/ ./src/public/dashboard/

EXPOSE 3000

CMD ["node", "src/index.js"]
