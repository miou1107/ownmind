/**
 * First-run redirect middleware — v1.19.8
 *
 * 對應 openspec/changes/v1.19.8-setup-wizard/spec.md 場景 1、2、3。
 *
 * 行為：
 *   - users 表為空（first_run=true） → /admin/* 自動 redirect 到 /setup
 *   - users 表有 admin（first_run=false） → /setup 自動 redirect 到 /admin/login
 *   - 兩種狀態的另一邊路徑保持正常（不額外攔截）
 *
 * 設計：
 *   - 純 redirect、不擋 API（/api/setup/* 自己 router 處理）
 *   - 失敗時 fail-open：DB 查詢出錯、視為非 first_run、不誤導使用者到 wizard
 *   - 不快取結果：每次請求都查 DB；若效能成問題、未來可加 in-memory 1 秒 cache
 *     （v1.19.8 範圍內預期 first_run 期非常短、不會被頻繁打）
 *   - Factory pattern（v1.19.8 code-review I-2）：依賴可注入、方便整合測試
 */
import { detectFirstRun as defaultDetectFirstRun } from '../routes/setup.js';

/**
 * 建立 first-run redirect middleware
 *
 * @param {object} [deps]
 * @param {() => Promise<{firstRun: boolean}>} [deps.detectFirstRun] - 偵測函式（測試時注入）
 * @returns {(req, res, next) => Promise<void>}
 */
export function createFirstRunRedirect(deps = {}) {
  const detectFirstRun = deps.detectFirstRun || defaultDetectFirstRun;

  return async function firstRunRedirectImpl(req, res, next) {
    const path = req.path;

    // 只攔特定路徑、其他直接 next
    const isAdminPath = path === '/admin' || path === '/admin/' || path.startsWith('/admin/');
    const isSetupPath = path === '/setup' || path === '/setup/';

    if (!isAdminPath && !isSetupPath) {
      return next();
    }

    // 註：/api/* 路徑不會走到這（前面條件已排除）、不需要額外 guard
    // （v1.19.8 code-review M-1 拿掉 dead code）

    let firstRun;
    try {
      ({ firstRun } = await detectFirstRun());
    } catch {
      // fail-open：DB 失敗時不轉向、讓使用者看到原本的頁
      return next();
    }

    if (firstRun && isAdminPath) {
      // users 表為空、使用者開 admin → 引導去 wizard
      return res.redirect(302, '/setup');
    }

    if (!firstRun && isSetupPath) {
      // 已設定完成、wizard 永久關閉、引導回登入頁
      return res.redirect(302, '/admin/login');
    }

    // 其他情況（first_run + setup 路徑、或非 first_run + admin 路徑）正常通過
    return next();
  };
}

// Default export：給 production app.js 直接 mount 用（使用真實的 detectFirstRun）
export const firstRunRedirect = createFirstRunRedirect();
