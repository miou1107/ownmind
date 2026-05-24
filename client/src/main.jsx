import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';

// basename 配對：dev mode 走 '/'、prod build 走 '/ownmind/dashboard'（nginx 加 /ownmind 前綴 + Express /dashboard 路由）
// 寫死 prod path 對 OwnMind 來說 OK — kkvin.com 不會搬位置、且簡單可靠
// （之前用 document.baseURI 動態偵測會在 Vite SPA fallback 後產生 URL 堆疊 bug）
const basename = import.meta.env.PROD ? '/ownmind/dashboard' : '';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
