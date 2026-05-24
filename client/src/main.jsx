import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { LocaleProvider, useT } from './i18n/LocaleContext.jsx';

// basename 配對：dev 走 '/'、prod build 走 import.meta.env.VITE_BASE_PATH（預設 '/ownmind/dashboard'）
// 環境變數允許未來部署到其他位置時不改程式碼、用 build env override 即可
const basename = import.meta.env.PROD
  ? import.meta.env.VITE_BASE_PATH || '/ownmind/dashboard'
  : '';

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
      <BrowserRouter basename={basename}>
        <App />
      </BrowserRouter>
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
