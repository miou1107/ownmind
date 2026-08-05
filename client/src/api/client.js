// 統一 fetch 封裝 — 所有頁面對後端的呼叫都走這層
//
// 設計目標：
//   1. 自動帶 Bearer header（從 localStorage 拿 api_key）
//   2. 統一回傳格式 { ok, data, error, status } — caller 不用自己 try/catch
//   3. 401 自動清掉 api_key，但不直接 redirect（交給 RequireAuth 處理）
//   4. 白名單路徑（login）不帶 Bearer
//
// 用法：
//   const { ok, data, error } = await apiGet('/api/me/profile');
//   if (!ok) toast.error(error);
//
// 為什麼不用 axios：依賴最少化、fetch 已夠用、Bundle 小

import { getApiKey, clearApiKey } from './auth.js';
import { AUTH_EXPIRED } from './events.js';

// 不需 Bearer header 的端點（公開）
const NO_AUTH_PATHS = ['/api/me/login'];

// API base 動態偵測：跟 main.jsx 的 basename 同源邏輯、抽 dashboard 之前的部分
// 線上 https://example.com/ownmind/dashboard/* → API base = '/ownmind'（nginx /ownmind/ 前綴）
// 本機 docker http://localhost:3100/dashboard/* → API base = ''（同 host root）
// vite dev http://localhost:5173/* → API base = ''（vite proxy /api 到 :3000）
//
// 為什麼動態：fetch('/api/me/login') 會被瀏覽器解析成 https://<host>/api/me/login、
// 不會自動帶 nginx 反向代理的 /ownmind/ 前綴、線上會打到不存在 endpoint 致登入失敗。
const API_BASE = (() => {
  const path = new URL(document.baseURI).pathname;
  const m = path.match(/^(.*)\/dashboard(\/.*)?$/);
  return m ? m[1] : '';
})();

// 同一個前綴也是「舊後台在哪」的答案（/ownmind/admin/），所以 export 出去給
// 曾經給 legacy-handoff.js 用（v1.26.60 隨舊後台一起刪掉），現在是 appBase() 的單一來源。
export function appBase() {
  return API_BASE;
}

function resolveUrl(path) {
  // 只對 /api/... 加前綴；外部 URL（https://...）或非 /api 開頭不動
  if (path.startsWith('/api/')) return API_BASE + path;
  return path;
}

// 401 burst debounce：同時 5 個 in-flight requests 都 401 時、只 dispatch 一次 event
// 避免 React DevTools / Sentry 冒 noise + 多次 navigate 重跑
// 1 秒 window 內第二次以後的 401 不再 dispatch（仍會清 token 跟回 unauthorized）
let authExpiredDispatched = false;

function needsAuth(path) {
  return !NO_AUTH_PATHS.includes(path);
}

async function request(method, path, body, opts = {}) {
  const headers = {
    Accept: 'application/json',
    ...(opts.headers || {}),
  };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
  }
  if (needsAuth(path)) {
    const key = getApiKey();
    if (key) headers.Authorization = `Bearer ${key}`;
  }

  let resp;
  try {
    resp = await fetch(resolveUrl(path), {
      method,
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch (err) {
    // 網路掛掉、CORS 擋、URL 錯 — 都到這
    return { ok: false, error: err.message || 'network_error', status: 0 };
  }

  // 401 — token 失效，清掉 localStorage 並廣播 event
  // App.jsx 監聽 AUTH_EXPIRED 跑 navigate('/login')、保留 SPA 體驗
  // 不在 client.js 直接 window.location 硬跳：保留純函數性、方便單元測試
  if (resp.status === 401) {
    clearApiKey();
    if (typeof window !== 'undefined' && !authExpiredDispatched) {
      authExpiredDispatched = true;
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED));
      // 1 秒後 reset flag、允許後續真實過期再次觸發
      setTimeout(() => { authExpiredDispatched = false; }, 1000);
    }
    return { ok: false, error: 'unauthorized', status: 401 };
  }

  // 嘗試 parse JSON；後端錯誤回應通常是 { error: '...' }
  let payload = null;
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      payload = await resp.json();
    } catch {
      payload = null;
    }
  }

  if (!resp.ok) {
    const error = (payload && payload.error) || resp.statusText || `http_${resp.status}`;
    return { ok: false, error, status: resp.status, data: payload };
  }

  return { ok: true, data: payload, status: resp.status };
}

export function apiGet(path, opts) {
  return request('GET', path, null, opts);
}

export function apiPost(path, body, opts) {
  return request('POST', path, body, opts);
}

export function apiPut(path, body, opts) {
  return request('PUT', path, body, opts);
}

export function apiPatch(path, body, opts) {
  return request('PATCH', path, body, opts);
}

export function apiDelete(path, opts) {
  return request('DELETE', path, null, opts);
}
