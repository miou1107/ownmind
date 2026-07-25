import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.26.34 — programmatic guard: no personal iron-rule codes in product code.
 *
 * The project rule "personal iron-rule codes must not appear in product code"
 * had drifted (~80 stray `IR-NNN` references in comments, display strings, and
 * a few functional spots), each of which is wrong for any user whose rule #N is
 * something different. This test enforces the rule with logic instead of
 * reminders (the "logic over reminders" principle applied to the codebase
 * itself), so the drift cannot silently return.
 *
 * A concrete numbered code (`IR-` + 2-3 digits) is banned. Generic teaching
 * examples must use the non-numeric placeholder `IR-XXX`, which does not match.
 *
 * Allowlist: the single documented backward-compat literal in me.js that must
 * match historical production compliance rows (a destructive data migration is
 * out of scope). Test fixtures legitimately carry codes and are not scanned.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SCAN_DIRS = ['src', 'mcp', 'hooks', 'shared', 'client/src'];
// Case-insensitive, 2-4 digits: catches lowercase (`ir-037`) and any future
// 3+ digit codes. `\b` + the required hyphen avoid matching things like
// `air-030` or the `ir027_candidate` key (no hyphen). Generic examples must use
// the digit-free placeholder `IR-XXX`, which never matches.
const PERSONAL_CODE = /\bIR-\d{2,4}\b/i;
const SKIP_PATH = /node_modules|\.min\.|\/dist\/|\/assets\/|\/bundle/;
const SCAN_EXT = /\.(js|jsx|ts|tsx|cjs|mjs|cmd|sh|html)$/;
// Bare (extensionless) hook scripts are scanned too.
const SCAN_BARENAME = /ownmind-git-[a-z-]+$/;

// Explicit, justified exceptions: { file (repo-relative), reason, substr }.
const ALLOWLIST = [
  {
    file: 'src/routes/me.js',
    substr: 'IR-006',
    reason: 'documented legacy backward-compat literal matching historical prod rows',
  },
];

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP_PATH.test(full)) continue;
    if (entry.isDirectory()) walk(full, acc);
    else if (SCAN_EXT.test(entry.name) || SCAN_BARENAME.test(entry.name)) acc.push(full);
  }
  return acc;
}

function isAllowed(relFile, line) {
  return ALLOWLIST.some((a) => relFile === a.file && line.includes(a.substr));
}

describe('v1.26.34 — no personal iron-rule codes in product code', () => {
  it('every scanned product file is free of concrete IR-NNN codes (use IR-XXX for examples)', () => {
    const files = SCAN_DIRS
      .map((d) => path.join(repoRoot, d))
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => walk(d, []));

    const violations = [];
    for (const file of files) {
      const rel = path.relative(repoRoot, file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (PERSONAL_CODE.test(line) && !isAllowed(rel, line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }

    assert.equal(
      violations.length,
      0,
      `Found personal iron-rule codes in product code (use IR-XXX for generic examples, ` +
        `describe the rule's purpose in comments, or add a justified ALLOWLIST entry):\n` +
        violations.join('\n')
    );
  });
});
