import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeConfirmationDeclared,
  DECLARED_VALUES,
  DECLARED_UNKNOWN,
} from '../src/utils/confirmation-declared.js';

/**
 * v1.26.97 — the submit gate was never a gate, and now says so.
 *
 * `ownmind_report_bug` told the AI to wait for the user to type a submit phrase and claimed
 * "the backend rejects auto-filled submissions with HTTP 400". It does not. `confirm_string`
 * is a string field; the server sees that a string with the expected value arrived and
 * cannot tell who produced those characters.
 *
 * Nor can any server-side check close it: `POST /me/login` returns the same `api_key` the
 * AI already holds, so every endpoint the person can call, the AI can call too. A one-time
 * server-issued phrase does not help either — the AI is the caller that fetches it.
 *
 * What is left is to record the claim and label it as a claim. These tests pin that the
 * false assurance is gone and that an absent declaration never reads as the stronger value.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

describe('v1.26.97 — an undeclared confirmation is never read as the stronger one', () => {
  it('the two declarable values pass through', () => {
    for (const v of DECLARED_VALUES) assert.equal(normalizeConfirmationDeclared(v), v);
  });

  it('absent, empty, wrong-typed and unrecognised all become unknown', () => {
    // An older client sends nothing at all, which is exactly this case. Reading that as
    // "a user typed it" would invent the very assurance this release removes.
    for (const v of [undefined, null, '', 'USER_TYPED', 'user typed', 'yes', 0, 1, true,
                     {}, [], 'unknown', 'constructor', '__proto__']) {
      assert.equal(normalizeConfirmationDeclared(v), DECLARED_UNKNOWN, String(v));
    }
  });

  it('unknown is not one of the declarable values', () => {
    // Otherwise a client could declare it directly and the field would stop distinguishing
    // "said nothing" from "said unknown".
    assert.equal(DECLARED_VALUES.includes(DECLARED_UNKNOWN), false);
  });
});

describe('v1.26.97 — the route records it, using the shared function', () => {
  const route = fs.readFileSync(path.join(repoRoot, 'src', 'routes', 'bug-reports.js'), 'utf8');

  it('imports the shared normaliser rather than repeating the list', () => {
    // Same arrangement as src/utils/activity-insert.js: one implementation, so the route
    // and the tests above cannot drift into disagreeing about what counts.
    assert.match(route, /import \{ normalizeConfirmationDeclared \} from '\.\.\/utils\/confirmation-declared\.js'/);
    assert.match(route, /normalizeConfirmationDeclared\(confirmation_declared\)/);
  });

  it('writes the column on insert', () => {
    assert.match(route, /confirmation_declared\)\s*\n\s*VALUES/,
      'the INSERT must carry the column');
    assert.match(route, /^\s*declared,$/m, 'and pass the normalised value');
  });

  it('returns it when listing reports', () => {
    // Recording it and never showing it would leave the person reading these no better off.
    const listSelect = route.slice(route.indexOf('SELECT id, user_id, title, severity'));
    assert.match(listSelect.slice(0, 300), /confirmation_declared/);
  });
});

describe('v1.26.97 — the tool no longer claims the server enforces it', () => {
  const mcp = fs.readFileSync(path.join(repoRoot, 'mcp', 'index.js'), 'utf8');
  const start = mcp.indexOf('name: "ownmind_report_bug"');
  const block = mcp.slice(start, mcp.indexOf('name: "ownmind_session_off"'));

  it('the false assurance is gone', () => {
    // This is the sentence bug #18 was about. Leaving it would keep telling every future AI
    // that something is checked which is not.
    assert.doesNotMatch(block, /backend rejects auto-filled/);
    assert.doesNotMatch(block, /MUST NOT fill confirm_string itself/);
  });

  it('and it says plainly that the server cannot tell', () => {
    assert.match(block, /cannot tell whether you or the user/);
  });

  it('but does not read as permission to skip the user', () => {
    // Keeping the phrase out of the AI's reach was always the part doing the work. Being
    // honest that the check is not enforced must not turn into telling the AI it can get
    // away with filling it in — the wording puts the obligation on the AI instead.
    assert.doesNotMatch(block, /not blocked|will accept a report either way/);
    assert.match(block, /this one is on you/);
    assert.doesNotMatch(block, /送出/,
      'the phrase itself must still stay out of an AI-facing description');
  });

  it('confirmation_declared is required and enumerated', () => {
    assert.match(block, /confirmation_declared: \{/);
    assert.match(block, /enum: \["user_typed", "ai_filled"\]/);
    assert.match(block, /required: \[[^\]]*"confirmation_declared"/);
  });

  it('the handler forwards it', () => {
    const handler = mcp.slice(mcp.indexOf('case "ownmind_report_bug"'));
    assert.match(handler.slice(0, 4000), /confirmation_declared: args\.confirmation_declared/);
  });
});

describe('v1.26.97 — migration 022', () => {
  const sql = fs.readFileSync(path.join(repoRoot, 'db', '022_bug_report_confirmation_source.sql'), 'utf8');

  it('is re-runnable', () => {
    // Migrations run on every boot; the runner skips applied ones, but a migration that
    // cannot survive a second run is a trap for a restored database.
    assert.match(sql, /ADD COLUMN IF NOT EXISTS confirmation_declared/);
  });

  it('backfills existing rows as unknown, not as user_typed', () => {
    // Reports filed before the column existed have no record of who confirmed them. Some
    // were user-typed and some were not; claiming either would be inventing data.
    assert.match(sql, /UPDATE bug_reports SET confirmation_declared = 'unknown'/);
  });

  it('the column comment says it is not verified', () => {
    assert.match(sql, /COMMENT ON COLUMN bug_reports\.confirmation_declared/);
    assert.match(sql, /never server-verified/);
  });
});
