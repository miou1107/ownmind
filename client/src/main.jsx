import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { LocaleProvider, useT } from './i18n/LocaleContext.jsx';
import { SessionProvider } from './session/SessionContext.jsx';

// basename 動態偵測：從 document.baseURI 抽 pathname、自動適應任何部署路徑
//
// 為什麼動態：SPA 由 Express serve 在 /dashboard、線上再過 nginx reverse proxy
// 加 /ownmind/ 前綴。寫死任一前綴會讓另一端炸（v1.20.1 release deploy 實測踩到
// 「Router basename="/ownmind/dashboard" is not able to match URL "/dashboard/"」、
// 整個 Router 不渲染）。
//
// 三種部署實際對照：
//   - 本機 docker：http://localhost:3100/dashboard/ → basename = '/dashboard'
//   - 線上反向代理：https://example.com/ownmind/dashboard/ → basename = '/ownmind/dashboard'
//   - vite dev (port 5173)：http://localhost:5173/ → basename = ''（空字串等同無 basename）
//
// 原理：HTML 沒有 <base> tag 時、document.baseURI 等於 document.URL（瀏覽器當前
// 頁面 URL）、所以抽 pathname 就拿到當前部署路徑。env override（VITE_BASE_PATH）
// 保留給「子路徑跟靜態檔位置不同」等特殊場景的逃生通道、不寫死預設值避免回到原 bug。
const basename = import.meta.env.VITE_BASE_PATH
  ?? new URL(document.baseURI).pathname.replace(/\/$/, '');

function TitleSync() {
  const t = useT();
  // 文件 title 跟隨當前 locale、locale 變動時自動更新
  useEffect(() => {
    document.title = t('header.title');
  }, [t]);
  return null;
}

function Root() {
  return (
    <LocaleProvider>
      <TitleSync />
      <SessionProvider>
        <BrowserRouter basename={basename}>
          <App />
        </BrowserRouter>
      </SessionProvider>
    </LocaleProvider>
  );
}

// HMR 重跑 main.jsx 時、不可重複呼叫 createRoot — 用 window 快取現有 root
// 修掉「You are calling createRoot() on a container that has already been passed」警告
const container = document.getElementById('root');
const root = window.__ownmind_root__ ?? createRoot(container);
window.__ownmind_root__ = root;
root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
