import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Express 內部路由是 /admin、nginx reverse proxy 在 prod 加 /ownmind/ 前綴
// 前端用相對路徑（base: './'）讓 build 出來的 HTML 不綁死前綴、
// 部署到 /admin 或 /ownmind/admin 都自動跟著 document.baseURI 走
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // v1.26.46：後台跟 server 共用 shared/ 底下的模組（目前是舊後台功能清單
      // legacy-console-manifest.js）。複製一份到 client/ 會變成兩份要同步的東西、
      // 而那正是這份清單要取代的失效模式。
      // 容器內 WORKDIR=/client，所以這個 alias 指到 /shared，對應 Dockerfile
      // client-builder stage 的 `COPY shared/ /shared/`。
      '@shared': resolve(__dirname, '../shared'),
    },
  },
  build: {
    outDir: '../src/public/dashboard',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
    fs: {
      // vite dev server 預設只放行 client/ 這個 root；shared/ 在它外面
      allow: ['..'],
    },
  },
});
