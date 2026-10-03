/**
 * Which pitfalls rows a caller may see.
 *
 * GET /api/me/pitfalls was built to show every member the whole team's rows, on the reasoning
 * that the patterns only show up across users. But the rows carry other people's private data:
 * the titles and codes of their iron rules, their names, and the project and summary of their
 * sessions. Iron rules are readable by their owner only (src/utils/memory-visibility.js);
 * this page, and the team narrative's compliance section (hideOthersRuleTitles below), were
 * where a member could read anyone's.
 *
 * Admins keep the cross-user view — auditing the team is what the page is for. A member sees
 * their own rows.
 */
import { isAtLeast } from './roles.js';

/**
 * @param {Array<{ user_id: number|string }>} rows
 * @param {{ id: number, role: string }} user
 * @returns {Array} the rows this caller may see
 */
export function scopePitfallRows(rows, user) {
  if (!Array.isArray(rows)) return [];
  if (user && isAtLeast(user.role, 'admin')) return rows;
  const self = Number(user && user.id);
  return rows.filter((r) => Number(r.user_id) === self);
}

/**
 * The team narrative (GET /api/me/narrative and /insights) is a team report on purpose —
 * usage, projects and compliance counts per person — and stays one. What it should not hand a
 * member is the title of someone else's iron rule, which is private everywhere else. A member
 * keeps every row and count, and their own titles; other people's titles become null. Admins
 * see everything. Applied before the sections reach the page or the LLM that writes the prose.
 *
 * @param {{ compliance?: Array<{ user_id: number|string, title?: string|null }> }} sections
 * @param {{ id: number, role: string }} user
 */
export function hideOthersRuleTitles(sections, user) {
  if (!sections || !Array.isArray(sections.compliance)) return sections;
  if (user && isAtLeast(user.role, 'admin')) return sections;
  const self = Number(user && user.id);
  return {
    ...sections,
    compliance: sections.compliance.map((r) => (Number(r.user_id) === self ? r : { ...r, title: null })),
  };
}
