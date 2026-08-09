# v1.26.104 — Spec

## Requirement: commit-message rules are evaluated against the message being committed

Rules whose condition type begins with `commit_message` MUST be evaluated in the commit-msg
hook, against the message file git supplies as the first argument.

They MUST NOT be evaluated in pre-commit. Git writes `.git/COMMIT_EDITMSG` after pre-commit
has run, so at that point it holds the previous commit's message, or nothing at all on a
repository's first commit.

### Scenario: a violation is corrected and the commit retried

- **GIVEN** a commit attempt rejected for a forbidden trailer
- **WHEN** the trailer is removed and the commit is retried, unchanged otherwise
- **THEN** the commit succeeds

### Scenario: a violation is introduced after a clean attempt

- **GIVEN** a commit that succeeded with a clean message
- **WHEN** the next commit's message contains a forbidden trailer
- **THEN** that commit is rejected

### Scenario: stale text cannot block an unrelated commit

- **GIVEN** `.git/COMMIT_EDITMSG` contains a message that violates a rule
- **WHEN** pre-commit runs for a commit whose staged files break no rule
- **THEN** pre-commit does not block

## Requirement: pre-commit does not claim to have checked what it cannot see

Message rules MUST be excluded from the set pre-commit evaluates, not merely left to
evaluate to "pass".

The condition handlers return true when no message is present, so an unfiltered rule would
be counted in `all N rules passed ✓`. A check reported as passed is stronger than one not
mentioned, and here nothing was examined at all.

### Scenario: the only cached rule is a message rule

- **WHEN** pre-commit runs
- **THEN** its output does not report that rule as passed

## Requirement: rule selection is by condition type, never by rule code

The set of message rules MUST be derived from `conditions.type`.

Every user numbers their own rules. A check keyed to one person's numbering enforces
nothing for anybody else, silently.

### Scenario: a user whose message rule is numbered differently

- **GIVEN** a rule with condition type `commit_message_contains` and any code
- **WHEN** a commit message lacks the required text
- **THEN** the commit is rejected, naming that rule's own code

## Requirement: the anchored trailer guard is retained alongside the rule engine

The shell hook MUST keep its case-insensitive, line-anchored `Co-Authored-By:` check.

`commit_message_not_contains` is a case-sensitive substring test, so a rule written as
`Co-Authored-By` does not match `Co-authored-by:` — which is git's own spelling. Replacing
the guard with the rule engine alone would open exactly that gap.

### Scenario: git's lowercase trailer spelling

- **WHEN** a commit message contains `Co-authored-by: Someone <x@y.z>`
- **THEN** the commit is rejected

## Requirement: an incomplete client fails open

The shell hook MUST skip rule evaluation when the Node script is not present, rather than
treating its absence as a failure.

### Scenario: the script has not been installed yet

- **GIVEN** `~/.ownmind/hooks/ownmind-git-commit-msg.js` does not exist
- **WHEN** a commit is made whose message would violate a cached rule
- **THEN** the commit proceeds

### Scenario: no message path is supplied

- **WHEN** the script is invoked with no argument
- **THEN** it exits 0

## Requirement: the installed hook wrappers are refreshed on every update

`scripts/update.sh` and `scripts/update.ps1` MUST copy each already-installed wrapper in
`~/.ownmind/git-hooks/` from the checkout, not merely repair its line endings. Neither may
create a wrapper that was not already installed.

`~/.ownmind` is the checkout, so a `git pull` replaces the hook *logic* instantly, while
the wrappers are copies made by an installer that the auto-update path never runs. Any
release that moves work from one wrapper to another therefore lands one half and not the
other. For this release specifically, that means pre-commit stops checking messages while
the old commit-msg wrapper never starts — leaving message rules unenforced, silently, and
masked by the one rule the old wrapper's hardcoded grep still catches.

### Scenario: a client auto-updates without running an installer

- **GIVEN** `~/.ownmind/git-hooks/commit-msg` was written by an older installer
- **WHEN** the daily update runs
- **THEN** it is replaced with the current wrapper from the checkout

### Scenario: a machine that never installed the git hooks

- **GIVEN** `~/.ownmind/git-hooks/` has no `commit-msg`
- **WHEN** the update runs
- **THEN** none is created

## Requirement: only the message is judged, not what git attached to it

Everything from git's scissors line onward MUST be excluded before rules are evaluated.

`git commit --verbose` places the staged diff there, uncommented. Measured: a diff adding a
line containing a forbidden trailer arrives as `+Co-Authored-By: …`, which a substring rule
matches — blocking the commit over text the message does not contain, which is the same
failure this release exists to remove.

Comment lines MUST be stripped using `core.commentChar` rather than an assumed `#`.

If stripping comments would leave nothing, the un-stripped text MUST be used. `git commit
-m '#123 fix'` cleans up with `whitespace`, so that line lands in the real commit; treating
it as a comment would switch off every message rule for anyone who writes issue numbers
that way.

### Scenario: committing with --verbose

- **GIVEN** a staged diff that adds a line containing a forbidden string
- **WHEN** the message itself is clean and the commit is made with `--verbose`
- **THEN** the commit is not blocked

### Scenario: a message that is only an issue number

- **GIVEN** `#123 fix the thing` as the entire message
- **THEN** rules are evaluated against that text, not against an empty string

## Requirement: an incomplete installation cannot block a commit

The hook MUST load this project's modules in a way that a failure can be caught, so a
partially mirrored client fails open instead of exiting non-zero with a stack trace.

A static `import` cannot be caught: the module never begins executing, node exits 1, and
the wrapper cannot distinguish that from a rule violation.

### Scenario: the script is present but `shared/` is not

- **WHEN** a commit is made
- **THEN** it proceeds, and no module-resolution error is printed

## Known limits

**Matching stays case-sensitive.** `commit_message_contains` and
`commit_message_not_contains` compare with `String.prototype.includes`. Making them
case-insensitive would change matching for every existing rule, so it is deliberately not
bundled here — and it is the precondition for retiring the hardcoded trailer guard, which
is one user's rule living in product code.

**A comment-character line is dropped when other content exists.** `#123 fix\nbody text`
loses its first line, because the hook cannot tell whether git will apply `strip` cleanup
(editor path, where those lines are git's own template) or `whitespace` (`-m`, where they
are the user's). The fallback only covers the case where stripping would leave nothing at
all. Determining this properly needs the cleanup mode, which git does not pass to the hook.

**A stale rule cache is preferred to none.** commit-msg reads the cache without refreshing
it. On `git commit` pre-commit refreshed it moments earlier; on `git merge`, `git revert`
and `git cherry-pick` — which run commit-msg without pre-commit — it may be up to a day
old. That errs towards enforcing a withdrawn rule rather than towards missing a new one.
