/**
 * v1.17.69 — combine broadcast / prefix / body / tip into a single text part.
 *
 * Why: v1.17.0 ~ v1.17.68 returned 4 separate `{ type: "text", text: ... }` parts.
 * Most MCP clients (Codex / Cursor / Antigravity) render them in order and the user sees
 * everything, but Claude Code's UI folds the tool result into a card that **visually swallows
 * the gap between parts** — the last part (the tip) ends up hidden. Vin's report "the tip used
 * to show up, now Claude Code doesn't show it but other tools do" was exactly this bug.
 *
 * Fix: combine every section into a single text part, so rendering is consistent across clients.
 *
 * Visual rules (preserve the pre-v1.17.68 layout each client used to see):
 *   - If there's a broadcast, it goes first, followed by a blank line.
 *   - The tag is followed by ":\n" and then the body (tag as a header line; multi-line JSON
 *     bodies don't get squeezed onto one line).
 *   - One blank line between body and tip.
 *   - Empty tip → omit the section entirely (no trailing whitespace).
 *
 * @param {object} parts
 * @param {string} [parts.broadcastText] - rendered broadcast text; may be omitted
 * @param {string} parts.tag - the "[OwnMind vX.Y.Z] type" prefix, without the trailing ":"
 * @param {string} parts.body - main content (usually a JSON.stringify result)
 * @param {string} [parts.tip] - tip text; empty string omits the tip section
 * @param {string} [parts.tipTag] - tag prefix for the tip (e.g. "[OwnMind v1.17.69] Tip")
 * @returns {{ content: Array<{ type: 'text', text: string }> }}
 */
export function composeToolResponse({ broadcastText, tag, body, tip, tipTag } = {}) {
  const sections = [];
  if (broadcastText) sections.push(broadcastText);
  sections.push(`${tag ?? ''}:\n${body ?? ''}`);
  if (tip && tipTag) {
    sections.push(`${tipTag}: ${tip}`);
  } else if (tip) {
    sections.push(`Tip: ${tip}`);
  }
  return {
    content: [{ type: 'text', text: sections.join('\n\n') }],
  };
}
