import { detectSecretLike } from '../../shared/secret-detect.js';

/**
 * memory-secret-guard — secret-detection gatekeeper before memory API writes
 *
 * Introduced in v1.19.1. See openspec/changes/v1.19.1-secret-tool-routing/proposal.md §2
 *
 * Wraps detectSecretLike with memory-type awareness:
 *   - narrative types (iron_rule / principle / coding_standard / team_standard /
 *     session_log) skip keyword detection, to avoid false-blocking memories that
 *     discuss password topics; but the regex and length heuristic still run to
 *     catch a real secret pasted in
 *   - other types (profile / project / portfolio / env / reference) run full detection
 *
 * Bypass: metadata.allow_secret_like=true → skip detection + return lint_warning_entry;
 *   the caller is responsible for writing the entry into memory.metadata.lint_warnings (audit log)
 *
 * Pure function — no DB access, easy to test.
 *
 * @param {Object} input
 * @param {string} input.type - memory type
 * @param {string} input.title - memory title
 * @param {string} input.content - memory content
 * @param {Object} [input.metadata] - memory metadata (may include description / allow_secret_like)
 * @returns {{ ok: true, lint_warning_entry?: Object }
 *         | { ok: false, status: number, body: Object }}
 */
export function validateMemoryContent({ type, title, content, metadata }) {
  // content is null / undefined / empty → nothing to block, allow it
  if (typeof content !== 'string' || content.length === 0) {
    return { ok: true };
  }

  const md = metadata && typeof metadata === 'object' ? metadata : {};
  const allowBypass = md.allow_secret_like === true;

  // narrative types: skip keyword detection (these types often discuss password
  //   topics or reference code paths/filenames)
  // The list must stay aligned with ALLOWED_MEMORY_TYPES; when adding a new type,
  //   remember to evaluate its classification.
  // code review I-2 fix: standard_detail (added in v1.x, team-standard detail) is also
  //   narrative and was missing from the list.
  // v1.19.11 expansion: project / portfolio are also narrative — project records
  //   reference many filenames and paths (e.g. 'random-password.js',
  //   'reset-admin-password.js' contain the 'password' substring and false-positive).
  //   The regex and length heuristic still run, so real key detection is unaffected.
  // Still excluded: profile (personal preferences, shouldn't store secrets),
  //   env (environment config, genuinely has tokens), reference
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

  // matched and no bypass → block
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
        // v1.19.13: return the matched snippet to the caller so the AI can see what
        //   triggered it and fix it correctly on the first try
        matched_text: detection.matched_text,
      },
    };
  }

  // no match, but the caller passed allow_bypass=true → write an audit warning entry
  // Even when the detector finds nothing, the bypass flag itself is recorded (to stop
  // a caller from sneaking in bypass=true without real sensitive data, which would
  // create a misleading audit)
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
