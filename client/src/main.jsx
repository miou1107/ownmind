import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { t } from './i18n';

// basename 配對：dev 走 '/'、prod build 走 import.meta.env.VITE_BASE_PATH（預設 '/ownmind/dashboard'）
// 環境變數允許未來部署到其他位置時不改程式碼、用 build env override 即可
const basename = import.meta.env.PROD
  ? import.meta.env.VITE_BASE_PATH || '/ownmind/dashboard'
  : '';

function Root() {
  // 文件 title 走 i18n（v1.20.1 i18n locale context 完工後改用當前 locale）
  useEffect(() => {
    document.title = t('header.title');
  }, []);
  return (
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
