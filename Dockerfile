# v1.20：multi-stage build — 前端 client (Vite + React) 編譯產物嵌入 image
# Stage 1: 前端編譯
FROM node:20-alpine AS client-builder
WORKDIR /client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
# v1.26.46: client 端 import '@shared/...'（vite.config.js 的 alias 指到 ../shared）。
# WORKDIR 是 /client，所以要放在 /shared，否則 build 會找不到 module 直接失敗。
COPY shared/ /shared/
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

# v1.20：藍綠並存策略 — 新版 client build 產物放 dashboard/
# v1.26.48：/me 已退役，靜態 UI 搬到 repo 根目錄的 legacy/me-v1.19/（不打包進映像）。舊 admin/ 還在服務，
# 等單一後台整併程式後續階段把 shared/legacy-console-manifest.js 的最後一個 signpost 翻成 live 就會自動 301 到新後台
# 注意 vite outDir 設 '../src/public/dashboard'（相對 client/）、stage 1 cwd=/client、build 後寫到 /src/public/dashboard、不是預設的 /client/dist
COPY --from=client-builder /src/public/dashboard/ ./src/public/dashboard/

EXPOSE 3000

CMD ["node", "src/index.js"]
