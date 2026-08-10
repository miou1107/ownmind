/**
 * CHANGELOG.md, read as data for the dashboard footer.
 *
 * Why the markdown file is the source
 * -----------------------------------
 * The footer's changelog modal shipped in v1.20.0 with its timeline markup and
 * all three locale strings, and with `changelog: []` hardcoded in App.jsx. The
 * comment there said the real source "is a separate thing" — this is that thing.
 * The alternative was a second, hand-maintained list of releases, which is the
 * same shape of mistake as the hardcoded 'v1.20.1' that useServerVersion exists
 * to undo: two places to update, one of which nobody notices going stale.
 *
 * Read on the server rather than baked into the client bundle for the same
 * reason the version is: a cached bundle keeps reporting its own build long
 * after the server has moved on.
 *
 * Heading shapes
 * --------------
 * Three exist in the file and all three are still reachable by a reader
 * scrolling back:
 *
 *   ## v1.26.125 — title        (current, em dash)
 *   ## v1.15.4 - title          (up to v1.16.0, ASCII hyphen)
 *   ## 2026-03-26 — v1.4.0 title (the first releases, date first)
 *
 * Only the earliest shape carries a date, so `date` is empty for most entries
 * and the timeline omits it rather than showing a placeholder.
 */

import { readFileSync } from 'node:fs';

const HEADING = /^##\s+(.*)$/;
// The optional bracketed group absorbs the `（同版）` marker on the six headings that
// share a version with the one above them. It is a note to a reader of the markdown,
// and leaving it in produced titles reading `（同版）— 回滾失敗時…`, with the separator
// stranded mid-title. The repetition it announces is visible in the timeline anyway:
// the same version number appears on consecutive rows.
const VERSION_FIRST = /^v?(\d+\.\d+\.\d+)\s*(?:（[^）]*）|\([^)]*\))?\s*(?:[—–-]\s*)?(.*)$/;
const DATE_FIRST = /^(\d{4}-\d{2}-\d{2})\s*(?:[—–-]\s*)?(.*)$/;

/**
 * Reduce inline markdown to the prose inside it. The modal renders into a
 * <p>, so `code`, **bold** and [text](url) would otherwise reach the reader as
 * literal punctuation.
 */
function plain(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a heading into version, title and (rarely) date.
 * Returns null when no version is present, so a stray "## 尚未發布" does not
 * become a timeline dot with nothing in it.
 */
function parseHeading(heading) {
  const text = plain(heading);

  const dated = DATE_FIRST.exec(text);
  if (dated) {
    const inner = VERSION_FIRST.exec(dated[2]);
    if (!inner) return null;
    return { version: inner[1], title: inner[2].trim(), date: dated[1] };
  }

  const versioned = VERSION_FIRST.exec(text);
  if (!versioned) return null;
  return { version: versioned[1], title: versioned[2].trim(), date: '' };
}

/**
 * The first prose paragraph of an entry, as the one-line summary.
 *
 * Everything that is structure rather than a sentence is skipped while looking
 * for that paragraph, and ends it once found: fenced blocks (several entries open
 * with a log excerpt, which is the least useful line in the entry), sub-headings,
 * tables, list bullets and blockquotes.
 *
 * Skipping rather than stopping matters for the sub-heading case. Eight of the
 * thirty most recent entries open straight into `### 修法`, and stopping there
 * summarised a quarter of the modal as nothing at all. The paragraph under an
 * entry's own sub-heading still belongs to that entry — it is not borrowed from
 * another release.
 */
const STRUCTURE = /^#|^\||^[-*+]\s|^\d+\.\s|^>/;

function firstParagraph(lines) {
  const collected = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      if (inFence) { inFence = false; continue; }
      // A fence opening before any prose: skip the block, keep looking.
      if (collected.length) break;
      inFence = true;
      continue;
    }
    if (inFence) continue;

    if (!trimmed || STRUCTURE.test(trimmed)) {
      if (collected.length) break;
      continue;
    }

    collected.push(trimmed);
  }

  return plain(collected.join(' '));
}

/**
 * Which lines are headings — computed in one pass, because a `##` inside a fenced
 * block is not one.
 *
 * Entries quote each other: this very release's notes contain a fence listing the
 * three heading shapes, and reading those as releases invented a v1.15.4 entry
 * titled "標題（v1.16.0 以前，ASCII 連字號）" and sat it above the real history.
 * Six of the file's headings are quotations of that kind.
 */
function headingMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (!inFence) mask[i] = HEADING.test(lines[i]);
  }

  return mask;
}

/**
 * @param {string} markdown  contents of CHANGELOG.md
 * @param {{limit?: number}} [options]  how many entries to keep, newest first
 * @returns {Array<{version: string, title: string, date: string, description: string}>}
 */
export function parseChangelog(markdown, { limit = 30 } = {}) {
  const lines = String(markdown).split(/\r?\n/);
  const isHeading = headingMask(lines);
  const entries = [];

  // The file is written newest first, so the first `limit` headings are the
  // newest `limit` releases and the rest of the file need not be parsed.
  for (let i = 0; i < lines.length && entries.length < limit; i += 1) {
    if (!isHeading[i]) continue;

    const parsed = parseHeading(HEADING.exec(lines[i])[1]);
    if (!parsed) continue;

    const body = [];
    for (let j = i + 1; j < lines.length && !isHeading[j]; j += 1) body.push(lines[j]);

    entries.push({ ...parsed, description: firstParagraph(body) });
  }

  return entries;
}

const CHANGELOG_PATH = new URL('../../CHANGELOG.md', import.meta.url);

/**
 * Entries for the running server, or [] if CHANGELOG.md is not in the image.
 *
 * Never throws: a footer button that shows its empty state is a cosmetic loss,
 * whereas a route that throws on a missing file is an outage. `readFile` is a
 * seam so that branch is reachable from a test.
 */
export function loadChangelogEntries({ readFile = readFileSync, limit } = {}) {
  try {
    return parseChangelog(readFile(CHANGELOG_PATH, 'utf8'), { limit });
  } catch {
    return [];
  }
}
