// 認證 token 管理 — 統一 localStorage 存取，避免散落
// api_key 由 POST /api/me/login 拿到、所有後續 API 請求都帶 Bearer header
//
// 同時管理 must_change_password 旗標（user 預設密碼還沒改、必須先改才能用其他功能）
//
// 用法：
//   import { getApiKey, setApiKey, clearApiKey } from './auth';
//   setApiKey('abc123');
//   const key = getApiKey();  // 'abc123' or null
//   clearApiKey();           // 登出時用、會一併清 must_change_password

const STORAGE_KEY = 'ownmind.api_key';
const STORAGE_KEY_MUST_CHANGE = 'ownmind.must_change_password';

export function getApiKey() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function setApiKey(key) {
  if (!key || typeof key !== 'string') return;
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // 隱私模式 / quota 滿 — 忽略，下次重新登入即可
  }
}

export function clearApiKey() {
  // 一併清 must_change_password 旗標、避免下次別 user 登入時讀到上次殘留
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY_MUST_CHANGE);
  } catch {
    // 同上
  }
}

// must_change_password 旗標：true 時 RequireFreshPassword 守門員會強制導 /preference/security
// login 時 setMustChangePassword(r.data.must_change_password)
// 改密碼成功（3.7 SecurityPage 完工後）會 clearMustChangePassword()
export function getMustChangePassword() {
  try {
    return localStorage.getItem(STORAGE_KEY_MUST_CHANGE) === '1';
  } catch {
    return false;
  }
}

export function setMustChangePassword(must) {
  try {
    if (must) {
      localStorage.setItem(STORAGE_KEY_MUST_CHANGE, '1');
    } else {
      localStorage.removeItem(STORAGE_KEY_MUST_CHANGE);
    }
  } catch {
    // 同上
  }
}

export function clearMustChangePassword() {
  try {
    localStorage.removeItem(STORAGE_KEY_MUST_CHANGE);
  } catch {
    // 同上
  }
}
