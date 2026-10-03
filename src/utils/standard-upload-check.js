import { validateMemoryContent } from './memory-secret-guard.js';

/**
 * Secret scan for a team standard uploaded in one go (POST /api/memory/batch-sync-standard).
 *
 * Every other memory write runs validateMemoryContent before it touches the table. This route
 * did not: a standard's fragments went straight in, and a team standard is the one kind of
 * memory every member of the team reads. The client tool that feeds it read any file it was
 * pointed at, so a prompt-injected AI on an admin's machine could publish a key file to the
 * whole team, and nothing on the server looked. Security review 2026-10-03, item 10.
 *
 * Same rules as a single fragment written by hand (type `standard_detail`: narrative, so the
 * keyword pass is skipped — a standard about password policy is not a password — while the
 * key formats and the length heuristic still run). No bypass: the batch carries no metadata,
 * and a bulk upload is the last place to wave a match through.
 *
 * Pure: no DB. Checked before anything is written, so a refused upload changes nothing.
 *
 * @param {{ parent_title: unknown, chunks: unknown[] }} body
 * @returns {{ ok: true } | { ok: false, status: number, body: object }}
 */
export function checkStandardUpload({ parent_title, chunks }) {
  const parent = validateMemoryContent({ type: 'team_standard', title: '', content: String(parent_title ?? '') });
  if (!parent.ok) return refuse(parent, { where: 'parent_title' });

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || typeof chunk !== 'object' || typeof chunk.content !== 'string' || typeof chunk.title !== 'string') {
      return { ok: false, status: 400, body: { error: `chunk ${i} must have a string title and content` } };
    }
    if (chunk.level !== undefined && !(Number.isInteger(chunk.level) && chunk.level >= 0 && chunk.level <= 6)) {
      return { ok: false, status: 400, body: { error: `chunk ${i}: level must be an integer from 0 to 6` } };
    }
    if (chunk.hash !== undefined && !(typeof chunk.hash === 'string' && /^[0-9a-f]{64}$/.test(chunk.hash))) {
      return { ok: false, status: 400, body: { error: `chunk ${i}: hash must be a sha256 hex digest` } };
    }
    // The title is scanned as content too: headings are published exactly like the body.
    for (const text of [chunk.title, chunk.content]) {
      const result = validateMemoryContent({ type: 'standard_detail', title: '', content: text });
      if (!result.ok) return refuse(result, { where: 'chunk', chunk_index: i });
      const extra = uploadOnlyCheck(text);
      if (extra) return refuse({ status: 400, body: { detected_by: extra } }, { where: 'chunk', chunk_index: i });
    }
  }
  return { ok: true };
}

/**
 * Two shapes the shared detector leaves alone on purpose — it guards every memory write, and
 * there a project note saying `DB_PASSWORD=…` is more often a reference than a value — but a
 * document published to the whole team should not carry: a password in a connection URL, and
 * an env-file line whose value looks real. Review of this fix measured both passing.
 *
 * Placeholders stay allowed, because a deployment standard is full of them:
 * `API_KEY=your-key-here`, `postgres://user:<password>@host`, `TOKEN=${TOKEN}`.
 */
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,100}:([^\s@/]{1,200})@/gi;
const ENV_ASSIGNMENT = /(?<![A-Za-z])[A-Z0-9_]{0,40}(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)\s*[:=]\s*["']?([^\s"'`,;]{8,200})/g;
const PLACEHOLDER = /^(?:\*+|x+|\.+|<[^>]*>|\[[^\]]*\]|\{[^}]*\}|\$\{?\w+\}?|%\w+%|password|passwd|pass|pwd|secret|changeme|example|test|testing|dev|demo|dummy|fake|sample|local|guest)$|your|xxx|example|placeholder|changeme|redacted|<|\$\{/i;

function uploadOnlyCheck(text) {
  for (const m of text.matchAll(URL_PASSWORD)) {
    if (!PLACEHOLDER.test(m[1])) return 'upload:url_password';
  }
  for (const m of text.matchAll(ENV_ASSIGNMENT)) {
    const value = m[1];
    if (/[A-Za-z]/.test(value) && /[0-9]/.test(value) && !PLACEHOLDER.test(value)) return 'upload:env_assignment';
  }
  return null;
}

/**
 * Which section and which rule — never the section's title or the matched text. A key pasted
 * as a heading made the title the secret itself, and this answer goes back into a conversation.
 * Section numbers are 1-based, as a person counts them.
 */
function refuse(result, location) {
  const { matched_text: _omitted, ...body } = result.body || {};
  return {
    ok: false,
    status: result.status,
    body: {
      ...body,
      ...location,
      ...(location.chunk_index !== undefined && { section: location.chunk_index + 1 }),
      error: '這份規範裡有看起來像金鑰或密碼的內容，整份都沒有上傳。團隊規範全團隊都看得到，請先拿掉再上傳。',
    },
  };
}
