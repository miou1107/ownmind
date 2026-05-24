import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Express 內部路由是 /admin、nginx reverse proxy 在 prod 加 /ownmind/ 前綴
// 前端用相對路徑（base: './'）讓 build 出來的 HTML 不綁死前綴、
// 部署到 /admin 或 /ownmind/admin 都自動跟著 document.baseURI 走
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
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
  },
});
