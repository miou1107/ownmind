/**
 * What a session learned, in the one shape both ends agree on (v1.31.0).
 *
 * `ownmind_log_session` takes a `lessons` list at the close of a conversation. The MCP
 * client builds the request body from it and the server stores it, and the two have
 * drifted apart before on this very tool (Eric's bug #9: the client sent what the schema
 * said and the server demanded two more fields). One normaliser, imported by both, is how
 * that stays impossible here.
 *
 * A lesson is three short answers: where the work got stuck (`stuck`, required), what
 * unstuck it (`fix`), and what to do differently next time (`next_time`). A bare string is
 * accepted as `stuck` alone, because an AI that has one sentence to say should not have to
 * wrap it in an object to say it.
 */

export const LESSON_FIELDS = Object.freeze(['stuck', 'fix', 'next_time']);

/** Upper bounds, so a runaway caller cannot fill the table from one call. */
export const MAX_LESSONS_PER_SESSION = 20;
export const MAX_LESSON_FIELD_LENGTH = 2000;

function cleanText(v) {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  return trimmed.length > MAX_LESSON_FIELD_LENGTH
    ? trimmed.slice(0, MAX_LESSON_FIELD_LENGTH)
    : trimmed;
}

/**
 * @param {unknown} input  whatever the caller passed as `lessons`
 * @returns {{ lessons: Array<{stuck: string, fix?: string, next_time?: string}>, dropped: number }}
 *   `lessons` is what survives: entries with a non-blank `stuck`, trimmed and capped.
 *   `dropped` counts entries that carried nothing usable, so a caller can be told rather
 *   than left believing twenty lessons were saved when three were.
 */
export function normalizeLessons(input) {
  if (!Array.isArray(input)) return { lessons: [], dropped: 0 };
  const lessons = [];
  let dropped = 0;
  for (const raw of input) {
    const entry = typeof raw === 'string' ? { stuck: raw } : raw;
    if (!entry || typeof entry !== 'object') { dropped += 1; continue; }
    const stuck = cleanText(entry.stuck);
    if (!stuck) { dropped += 1; continue; }
    if (lessons.length >= MAX_LESSONS_PER_SESSION) { dropped += 1; continue; }
    const lesson = { stuck };
    const fix = cleanText(entry.fix);
    const nextTime = cleanText(entry.next_time);
    if (fix) lesson.fix = fix;
    if (nextTime) lesson.next_time = nextTime;
    lessons.push(lesson);
  }
  return { lessons, dropped };
}

/**
 * The memory a promoted lesson becomes: one project memory whose body keeps the three
 * answers apart, so a later reader can tell the symptom from the cure.
 *
 * @param {{stuck: string, fix?: string, next_time?: string, project?: string|null}} lesson
 * @returns {{ title: string, content: string, tags: string[] }}
 */
export function lessonToMemory(lesson) {
  const titleBody = lesson.stuck.length > 120 ? `${lesson.stuck.slice(0, 117)}...` : lesson.stuck;
  const title = lesson.project ? `[${lesson.project}] ${titleBody}` : titleBody;
  const lines = [`Stuck: ${lesson.stuck}`];
  if (lesson.fix) lines.push(`Fix: ${lesson.fix}`);
  if (lesson.next_time) lines.push(`Next time: ${lesson.next_time}`);
  const tags = ['lesson'];
  if (lesson.project) tags.push(`project:${lesson.project}`);
  return { title, content: lines.join('\n'), tags };
}
