/**
 * v1.26.133 — the pending-banner spool, parsed in one place.
 *
 * `logs/banner-pending.jsonl` is where every banner lands that could not be written to the
 * terminal directly: the tty-echo PostToolUse hook and the reply-lint Stop hook both try
 * `\\.\CONOUT$` (or `/dev/tty`) first and fall back to this file. On a machine where that
 * device cannot be opened — Claude Code's desktop app on Windows, measured 2026-08-10 — the
 * fallback is not an edge case, it is the only path: 19 banners piled up in 25 minutes.
 *
 * Two programs drain it, and until now they did it in two different ways:
 *
 *   - the shell SessionStart hook, via the `flush-pending-banners.js` CLI
 *   - the Node SessionStart hook, which spawned that same CLI *detached with stdio ignored*
 *     and truncated the file immediately afterwards
 *
 * The second one destroyed the spool. The CLI writes each block to its own stderr, and the
 * spawn discarded stderr, so the blocks went nowhere while the file was emptied anyway.
 * What the user saw was the header line and nothing under it — every queued message lost.
 *
 * So the parsing rule lives here, both callers share it, and the Node hook prints the blocks
 * itself rather than delegating to a child whose output it cannot see. Clearing the spool is
 * the caller's job, and only after the blocks are out: the cleanup goes after the evidence,
 * never before it.
 */

/**
 * Split a spool file's contents into the blocks worth printing.
 *
 * A broken line must not cost the readable ones: this file is appended to by several
 * processes, so a half-written record is a normal thing to find at the tail. Unreadable
 * lines are counted rather than dropped silently, because "nothing printable in a non-empty
 * file" is the one case where the caller must not simply delete it.
 *
 * The unreadable lines come back verbatim, not just counted: when some of the spool could be
 * shown and some could not, the caller has to be able to write the remainder back instead of
 * emptying the file over it. A malformed line is the only record of how it got that way.
 *
 * @param {string} raw contents of banner-pending.jsonl
 * @returns {{ blocks: string[], unreadable: string[] }}
 */
export function parsePendingBanners(raw) {
  const blocks = [];
  const unreadable = [];
  if (typeof raw !== 'string' || raw.trim() === '') return { blocks, unreadable };

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      unreadable.push(line);
      continue;
    }
    if (rec && typeof rec.block === 'string' && rec.block !== '') {
      blocks.push(rec.block);
    } else {
      // Parsed, but carries no block: a record shape nobody prints. Kept the same way, so a
      // spool full of these is recognised as "cannot be shown" rather than looking like an
      // empty queue and being deleted as one.
      unreadable.push(line);
    }
  }
  return { blocks, unreadable };
}

/**
 * The header that introduces the queued messages.
 *
 * Exported so the caller can print it only when there is something under it. The lonely
 * header — printed before the flush, with the flush then writing nothing — is what the
 * v1.26.133 defect looked like from the outside.
 */
export const PENDING_BANNER_HEADER = '\n📥 OwnMind messages queued from your last session:\n';

/**
 * Render the blocks as the text to write to stderr, header included.
 *
 * Returns an empty string when there is nothing to show, which is the caller's signal to
 * leave the spool alone.
 *
 * @param {string[]} blocks
 * @returns {string}
 */
export function renderPendingBanners(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  return PENDING_BANNER_HEADER + blocks.map((b) => `\n${b}\n`).join('');
}
