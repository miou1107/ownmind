/**
 * What the edit hook tells the server about where an edit is happening (v1.31.2).
 *
 * The collision warning needs one fact per edit: this person is in *this directory of this
 * project* right now. It must not need more. A file name (`payroll-export.js`) is already
 * information, and an absolute path says where somebody keeps their files — the line
 * v1.26.98 drew for the project name holds for the directory too. So the server receives
 * the project name and a directory relative to the project, nothing else, and this module
 * is the only place that derives them.
 */

import path from 'path';
import os from 'os';

/** Longest directory the server accepts; deeper paths are cut from the left, keeping the tail. */
export const MAX_DIR_LENGTH = 200;

/** Others seen inside this window are reported. */
export const OVERLAP_WINDOW_MINUTES = 120;

/** The hook reports a directory at most once per this window per session. */
export const REPORT_WINDOW_MS = 10 * 60 * 1000;

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * @param {string} filePath      the file being edited, as the tool call named it
 * @param {string} projectDir    the project directory (CLAUDE_PROJECT_DIR or the cwd)
 * @returns {{ project: string, dir: string } | null}
 *   null when the file is not under the project, the project has no usable name, or either
 *   input is missing. Never a file name, never an absolute path.
 */
export function touchOf(filePath, projectDir) {
  if (typeof filePath !== 'string' || !filePath || typeof projectDir !== 'string' || !projectDir) return null;
  const root = path.resolve(projectDir);
  const project = path.basename(root);
  if (!project || project === '.' || project === '/' || /^[a-zA-Z]:$/.test(project)) return null;
  // The home directory, or anything above it, is not a project: its name is the person's
  // and its subfolders are where they keep their files. resolveProjectName draws the same
  // line for the project name; it has to hold for the directory too.
  const home = path.resolve(os.homedir());
  if (root === home || home.startsWith(root + path.sep)) return null;

  const dirAbs = path.resolve(path.dirname(filePath));
  let rel = toPosix(path.relative(root, dirAbs));
  if (rel.startsWith('..') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  if (rel === '') rel = '.';
  if (rel.length > MAX_DIR_LENGTH) rel = rel.slice(rel.length - MAX_DIR_LENGTH);
  return { project, dir: rel };
}

/**
 * The server's side of the same rule: refuse anything that is not a project-relative
 * directory. `..`, an absolute path, a drive letter and a backslash are all signs the client
 * sent what this module would never produce.
 */
export function isValidTouch(body) {
  if (!body || typeof body !== 'object') return false;
  const { project, dir } = body;
  if (typeof project !== 'string' || !project.trim() || project.length > 255) return false;
  if (/[\\/]/.test(project)) return false;
  if (typeof dir !== 'string' || !dir || dir.length > MAX_DIR_LENGTH) return false;
  if (dir.includes('\\') || dir.startsWith('/') || /^[a-zA-Z]:/.test(dir)) return false;
  if (dir.split('/').some((seg) => seg === '..')) return false;
  return true;
}

/**
 * Put the overlap line into the envelope the edit reminder already printed, or into one of
 * its own. A deny envelope (no additionalContext) passes through untouched: a blocked edit
 * does not need to know who else is in the folder.
 *
 * @param {string} out      what editReminder returned ('' when it had nothing to say)
 * @param {string} overlap  what touchReport returned ('' when nobody is there)
 * @returns {string}        what the hook prints, or '' for nothing
 */
export function mergeOverlapIntoEnvelope(out, overlap) {
  if (!overlap) return out || '';
  if (!out) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: overlap } });
  }
  try {
    const parsed = JSON.parse(out);
    const prior = parsed?.hookSpecificOutput?.additionalContext;
    if (typeof prior !== 'string') return out;
    parsed.hookSpecificOutput.additionalContext = `${prior}\n${overlap}`;
    return JSON.stringify(parsed);
  } catch {
    return out;
  }
}

/**
 * The line the hook adds to the AI's context when somebody else is in the same directory.
 * Model-facing, so English; it asks the AI to tell the person once, in their language.
 *
 * @param {{ name: string, minutes_ago: number }[]} others
 * @param {{ project: string, dir: string }} touch
 * @param {string} version
 */
export function renderOverlapLine(others, touch, version) {
  if (!Array.isArray(others) || others.length === 0) return '';
  const who = others
    .map((o) => `${o.name} (${Math.max(0, Math.round(o.minutes_ago))} min ago)`)
    .join(', ');
  const where = touch.dir === '.' ? `the root of ${touch.project}` : `${touch.dir}/ in ${touch.project}`;
  return `[OwnMind v${version}] Also editing ${where} right now: ${who}. `
    + 'Tell the user once, in their language, so they can coordinate before the merge; then carry on.';
}
