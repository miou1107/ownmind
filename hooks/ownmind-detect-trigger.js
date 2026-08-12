#!/usr/bin/env node
/**
 * OwnMind Detect Trigger — the single place a bash command is classified.
 *
 * Reads a command and prints its trigger name, or nothing when it matches none. Exit
 * status is 0 either way: "no trigger" is a real answer, not a failure.
 *
 * Usage: printf '%s' "$COMMAND" | node ownmind-detect-trigger.js
 *        node ownmind-detect-trigger.js "git tag v1.2.3"     (for reading by hand)
 * Output: commit | deploy | delete | install | <empty>
 *
 * issue #92 — this file exists so hooks/ownmind-iron-rule-check.sh and
 * hooks/ownmind-iron-rule-check.js reach the same verdict by construction instead of by two
 * people remembering to edit both. The shell copy used to carry its own grep chain. By the
 * time anyone compared them, 7 of 17 sample commands were classified differently, and
 * `git tag` — a release tag, the exact moment the version rules are written for — reached no
 * trigger at all on macOS and Linux, which is where install.sh registers the shell copy.
 * v1.26.149 made the two agree; this removes the second copy so they cannot disagree again.
 *
 * The command arrives on stdin rather than argv on purpose: a `git commit -m` command
 * carries a message that is routinely multi-line and occasionally long, and stdin has
 * neither the length cap nor the quoting rules argv does. It is also what every other node
 * call in the shell hook already does.
 */

import { readFileSync } from 'fs';
import { detectCommandTrigger } from '../shared/helpers.js';

function readCommand() {
  // An argv command wins when one is given, so this stays runnable by hand. Falling back to
  // stdin unconditionally would block on a terminal with nothing piped in.
  if (process.argv.length > 2) return process.argv.slice(2).join(' ');
  try {
    // fd 0, not '/dev/stdin': Windows node resolves that POSIX path against the drive root
    // and throws ENOENT. Same failure v1.26.90 fixed in the shell hook's own payload read.
    return readFileSync(0, 'utf8');
  } catch {
    // No stdin attached (a terminal with no pipe). Not an error worth a stack trace — the
    // answer for "no command" is the same as for a command that matches nothing.
    return '';
  }
}

const trigger = detectCommandTrigger(readCommand());
// console.log always ends the line. The shell reads this through $(...), which strips the
// trailing newline, so an empty trigger arrives as an empty string rather than as "\n".
console.log(trigger || '');
