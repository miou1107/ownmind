import { detectSecretLike } from '../../shared/secret-detect.js';

/**
 * memory-secret-guard — 記憶 API 寫入前的密鑰偵測守門員
 *
 * v1.19.1 引入。對應 openspec/changes/v1.19.1-secret-tool-routing/proposal.md §2
 *
 * 包一層 detectSecretLike、加上 memory type 感知：
 *   - narrative 類型（iron_rule / principle / coding_standard / team_standard /
 *     session_log）跳過 keyword 偵測、避免討論密碼主題的記憶被誤擋；
 *     但 regex 跟 length heuristic 仍跑、抓真貼進去的密鑰
 *   - 其他類型（profile / project / portfolio / env / reference）跑完整偵測
 *
 * Bypass: metadata.allow_secret_like=true → 跳過偵測 + 回傳 lint_warning_entry
 *   caller 負責把 entry 寫進 memory.metadata.lint_warnings（audit log）
 *
 * Pure function — 不碰 DB、好測試。
 *
 * @param {Object} input
 * @param {string} input.type - memory type
 * @param {string} input.title - memory title
 * @param {string} input.content - memory content
 * @param {Object} [input.metadata] - memory metadata（可能含 description / allow_secret_like）
 * @returns {{ ok: true, lint_warning_entry?: Object }
 *         | { ok: false, status: number, body: Object }}
 */
export function validateMemoryContent({ type, title, content, metadata }) {
  // content 為 null / undefined / 空 → 沒內容可擋、放行
  if (typeof content !== 'string' || content.length === 0) {
    return { ok: true };
  }

  const md = metadata && typeof metadata === 'object' ? metadata : {};
  const allowBypass = md.allow_secret_like === true;

  // narrative 類型：跳 keyword 偵測（這些類型經常討論密碼主題、或引用程式碼路徑檔名）
  // 名單需跟 ALLOWED_MEMORY_TYPES 對齊、未來新增 type 時記得評估歸類
  // code review I-2 修：standard_detail（v1.x 加的、團隊標準明細）也是 narrative、漏列
  // v1.19.11 擴大：project / portfolio 也是 narrative — 專案紀錄會大量引用檔名跟路徑
  //   （例如 'random-password.js'、'reset-admin-password.js' 含 password 子字串、會誤判）
  //   regex 跟 length heuristic 仍跑、不影響真實金鑰偵測
  // 仍排除：profile（個人偏好、不該存敏感）、env（環境設定、真的會有 token）、reference
  const narrativeTypes = new Set([
    'iron_rule',
    'principle',
    'coding_standard',
    'team_standard',
    'session_log',
    'standard_detail',
    'project',     // v1.19.11
    'portfolio',   // v1.19.11
  ]);
  const skipKeyword = narrativeTypes.has(type);

  const description = typeof md.description === 'string' ? md.description : '';

  const detection = detectSecretLike(content, {
    title,
    description,
    allow_bypass: allowBypass,
    skip_keyword: skipKeyword,
  });

  // 命中且沒 bypass → 擋
  if (detection.detected) {
    return {
      ok: false,
      status: 400,
      body: {
        error: '偵測到此內容看起來是敏感資料（密碼／token／API key）',
        hint:
          '敏感資料請改用 ownmind_set_secret（MCP 工具）或 POST /api/secret（HTTP API）。' +
          '記憶系統只應該存非敏感的 profile／project／portfolio／session_log 等內容。',
        redirect_tool: 'ownmind_set_secret',
        detected_by: detection.rule,
      },
    };
  }

  // 沒命中、但 caller 帶 allow_bypass=true → 寫 audit warning entry
  // 即使 detector 沒命中、bypass flag 本身也記下來（避免 caller 偷塞 bypass=true 卻
  // 沒真的有敏感資料、製造誤導 audit）
  if (allowBypass) {
    return {
      ok: true,
      lint_warning_entry: {
        type: 'bypass_secret_detect',
        ts: new Date().toISOString(),
      },
    };
  }

  return { ok: true };
}
