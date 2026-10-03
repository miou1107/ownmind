/**
 * The git half of the release check (v1.31.5), with git injected so every rule is testable.
 *
 * What a release needs to know from the repository: which branch, what its base is, how far
 * behind that base it is (the one blocking check — a rule written after it happened), the last
 * tag, and the commits since. Nothing here tags or pushes.
 */

/** Flags after `git tag` that list, verify or delete rather than create. */
const TAG_NOT_A_RELEASE = /^(-l|--list|-d|--delete|-n\d*|-v|--verify|--contains|--no-contains|--points-at|--merged|--no-merged|--sort(=.*)?|--format(=.*)?|--column(=.*)?|--no-column)$/;
/** Flags `git tag` takes while creating; `-m` and `-F` consume the next token. */
const TAG_CREATE_FLAG = /^(-a|-s|-f|--force|-e|--annotate|--sign|--no-sign|-u|--local-user(=.*)?|--cleanup(=.*)?|--create-reflog|-m|--message(=.*)?|-F|--file(=.*)?)$/;

/** Quoted text blanked and the command split on `&&`, `||`, `;`, `|` and newlines. */
function segmentsOf(command) {
  const blanked = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  return blanked.split(/&&|\|\||;|\||\n/).map((x) => x.trim()).filter(Boolean);
}

/** `git tag v1.2.3`, `git tag -a v1 -m x`, `git push --tags`, `git push origin v1.2.3` — a release.
 *  `git tag`, `git tag -l`, `git tag -d x`, `git tag --sort=…`, a `git tag` inside a quoted
 *  string (a commit message that mentions it) — not. */
export function isReleaseCommand(command) {
  if (typeof command !== 'string') return false;
  for (const seg of segmentsOf(command)) {
    const tag = seg.match(/\bgit\s+tag\b(.*)$/);
    if (tag) {
      const tokens = tag[1].trim().split(/\s+/).filter(Boolean);
      let names = 0;
      let skipNext = false;
      let listing = false;
      for (const tok of tokens) {
        if (skipNext) { skipNext = false; continue; }
        if (TAG_NOT_A_RELEASE.test(tok)) { listing = true; break; }
        if (TAG_CREATE_FLAG.test(tok)) { if (tok === '-m' || tok === '-F' || tok === '--message' || tok === '--file' || tok === '-u' || tok === '--local-user') skipNext = true; continue; }
        if (tok.startsWith('-')) continue;
        names += 1;
      }
      if (!listing && names > 0) return true;
      continue;
    }
    const push = seg.match(/\bgit\s+push\b(.*)$/);
    if (push && /(^|\s)(--tags|--follow-tags)(\s|$)|\brefs\/tags\/|(^|\s)v?\d+\.\d+(\.\d+)?(\s|$)/.test(push[1])) return true;
  }
  return false;
}

/**
 * @param {(args: string[]) => string} git  runs git with args, returns stdout, throws on failure
 * @param {string} [override]               --base from the command line
 * @returns {{ base: string|null, source: string }}
 */
export function detectBase(git, override) {
  if (override) return { base: override, source: 'option' };
  try {
    const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
    // The symbolic ref survives the deletion of the branch it names; verify before trusting it,
    // or a stale origin/HEAD would make the one blocking check silently unmeasurable.
    if (head) {
      git(['rev-parse', '--verify', '--quiet', head]);
      return { base: head, source: 'origin/HEAD' };
    }
  } catch { /* unset, or pointing at a branch that is gone */ }
  for (const name of ['origin/main', 'origin/master']) {
    try {
      git(['rev-parse', '--verify', '--quiet', name]);
      return { base: name, source: 'fallback' };
    } catch { /* not there */ }
  }
  return { base: null, source: 'none' };
}

export function currentBranch(git) {
  try { return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null; } catch { return null; }
}

/** Commits on `base` that HEAD lacks. null when it cannot be measured. */
export function behindCount(git, base) {
  if (!base) return null;
  try {
    const out = git(['rev-list', '--count', `HEAD..${base}`]).trim();
    const n = Number.parseInt(out, 10);
    return Number.isInteger(n) ? n : null;
  } catch { return null; }
}

export function lastTag(git) {
  try { return git(['describe', '--tags', '--abbrev=0']).trim() || null; } catch { return null; }
}

/** `[{ hash, subject }]` since `tag` (or all of them when there is no tag). */
export function commitsSince(git, tag) {
  try {
    const range = tag ? `${tag}..HEAD` : 'HEAD';
    const out = git(['log', '--format=%h%x09%s', range]).trim();
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [hash, ...rest] = line.split('\t');
      return { hash, subject: rest.join('\t') };
    });
  } catch { return []; }
}

export function tagDate(git, tag) {
  if (!tag) return null;
  try { return git(['log', '-1', '--format=%cI', tag]).trim() || null; } catch { return null; }
}

/**
 * Everything the git half knows, in one object.
 * @param {(args: string[]) => string} git
 * @param {{ base?: string }} [opts]
 */
export function isInsideRepository(git) {
  try { return git(['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; }
}

export function gitFacts(git, opts = {}) {
  if (!isInsideRepository(git)) {
    return { inRepo: false, branch: null, base: null, baseSource: 'none', behind: null, lastTag: null, since: null, commits: [] };
  }
  const { base, source } = detectBase(git, opts.base);
  const tag = lastTag(git);
  return {
    inRepo: true,
    branch: currentBranch(git),
    base,
    baseSource: source,
    behind: behindCount(git, base),
    lastTag: tag,
    since: tagDate(git, tag),
    commits: commitsSince(git, tag),
  };
}

/**
 * The report, as lines. `Blocking:` first and alone; everything else is for the person to
 * read, and says so.
 *
 * @param {object} facts    from gitFacts
 * @param {object|null} server  the answer of GET /api/release/check, or null when unreachable
 * @returns {{ blocking: string[], lines: string[] }}
 */
export function buildReleaseReport(facts, server) {
  const blocking = [];
  if (facts.inRepo === false) {
    return { blocking, lines: ['Blocking:', '  OwnMind found nothing that blocks this release', '', 'For you to read (a reminder, not a check):', '  this folder is not inside a git repository, so OwnMind has nothing to check here'] };
  }
  if (facts.base && Number.isInteger(facts.behind) && facts.behind > 0) {
    blocking.push(`Branch ${facts.branch || '?'} is ${facts.behind} commit(s) behind ${facts.base}. Run: git merge ${facts.base}`);
  }

  const lines = [];
  lines.push('Blocking:');
  if (blocking.length === 0) lines.push('  OwnMind found nothing that blocks this release');
  for (const b of blocking) lines.push(`  ✗ ${b}`);
  lines.push('');
  lines.push('For you to read (a reminder, not a check):');
  lines.push(`  branch ${facts.branch || '?'}, base ${facts.base || 'unknown'}${facts.baseSource === 'fallback' ? ' (guessed; pass --base to set it)' : ''}`);
  if (!facts.base) lines.push('  ? OwnMind could not tell which branch this one is based on; you can pass --base <branch>');
  if (facts.base && facts.behind === null) lines.push('  ? OwnMind could not measure how far behind the base this branch is; check it yourself');
  lines.push(`  last tag ${facts.lastTag || 'none (counting from the first commit)'}, ${facts.commits.length} commit(s) since (OwnMind compares against what is fetched; run git fetch first if in doubt)`);

  if (!server) {
    lines.push('  ? OwnMind could not reach its server, so you have to check cards, lessons and standards yourself');
    return { blocking, lines };
  }

  const cards = server.cards || { pending: [], ready: [] };
  if (cards.unavailable) lines.push('  ? cards: your OwnMind server does not keep task cards yet, so you have to check them yourself');
  else if (cards.pending.length === 0 && cards.ready.length === 0) lines.push('  cards: none for this project');
  else {
    lines.push(`  cards: ${cards.ready.length} reviewed, ${cards.pending.length} not yet`);
    for (const c of cards.pending) lines.push(`    - #${c.id} ${c.status}${c.holder ? ` (${c.holder})` : ''} — ${c.title}`);
  }

  if (server.lessons && Number.isInteger(server.lessons.new)) {
    lines.push(server.lessons.new > 0
      ? `  lessons: ${server.lessons.new} from this project since the last tag still waiting on /portal/lessons`
      : '  lessons: none waiting');
  }

  const standards = Array.isArray(server.standards) ? server.standards : [];
  if (standards.length > 0) {
    lines.push(`  team standards for a release (${standards.length}), in full:`);
    for (const s of standards) {
      lines.push(`    ## ${s.title}`);
      for (const l of String(s.content || '').split('\n')) lines.push(`    ${l}`);
    }
  } else {
    lines.push('  team standards tagged for release: none');
  }
  return { blocking, lines };
}
