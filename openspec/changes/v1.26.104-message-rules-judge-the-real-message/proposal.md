# v1.26.104 — Proposal: the commit-message check was reading the previous commit

## Background

Found while committing v1.26.103. A commit was rejected by the commit-msg hook for a
`Co-Authored-By` trailer. The trailer was removed and the same commit was submitted again —
and was rejected a second time, now by the **pre-commit** hook, quoting IR-009 and IR-024
for a trailer the message no longer contained. `grep -ci co-authored-by .git/COMMIT_EDITMSG`
confirmed the file still held the first attempt's text. The commit only went through after
manually copying the corrected message over `.git/COMMIT_EDITMSG`.

## Root cause

Git runs hooks in this order:

    pre-commit → prepare-commit-msg → editor → commit-msg

`.git/COMMIT_EDITMSG` is not written with the current message until after pre-commit has
run. `hooks/ownmind-git-pre-commit.js` read that file, so it was always judging whatever
the previous commit — or the previous aborted attempt — had left behind.

Measured directly with two commits in a row, with a hook printing what each stage sees:

    PRE-COMMIT sees COMMIT_EDITMSG: [FIRST MESSAGE]
    COMMIT-MSG  $1 contains:        [SECOND MESSAGE]

On the very first commit in a repository the file does not exist at all, so message rules
never fired there.

## Both directions are wrong, and the quiet one is worse

1. **False block.** Fix a message violation and get blocked again on the old text, with
   nothing on screen to explain why. This is how it was found.
2. **False pass.** A clean first attempt leaves a clean file behind, so a violation
   introduced on the second attempt is waved through. Nobody would notice this one, which
   is why it survived.

## Why it was never caught

`getCommitMessage()` fell back to `process.env.GIT_COMMIT_MSG` only when the file read
threw. `GIT_COMMIT_MSG` appears in exactly two places in the repository: that fallback, and
`tests/pre-commit-secret.test.js`. The test sandbox is a fresh repo with no
`COMMIT_EDITMSG`, so the read always threw and the tests always exercised the env-var path —
the one production never takes. Both ends of the interface were supplied by the test.

## What this changes

Message rules move to the hook that is handed the message.

- New `hooks/ownmind-git-commit-msg.js` evaluates every rule whose condition type starts
  with `commit_message`, against `process.argv[2]` — the path git supplies. Selection is by
  condition type, never by rule code, so it works whatever numbering a user has.
- `hooks/ownmind-git-commit-msg` calls it, and skips it when the script is absent rather
  than treating that as a block: a half-installed client must not stop somebody committing.
- Pre-commit **excludes** message rules rather than merely leaving them unevaluated. The
  condition handlers return `true` when no message is present, so leaving them in would
  have counted them in `all N rules passed ✓` — an assurance about a check that never ran.
- `GIT_COMMIT_MSG` is gone. It existed only to let tests avoid the broken path.

## What this deliberately keeps

**The hardcoded trailer grep stays in the shell hook.** Removing it was the first attempt
and it introduced a hole: the rule engine's `commit_message_not_contains` is a
case-sensitive substring test, so a rule reading `Co-Authored-By` does not match
`Co-authored-by:` — git's own spelling. The grep is anchored and case-insensitive and
catches what the rule cannot. The pre-existing tests in
`tests/git-hook-co-authored-by.test.js` are what caught this, unchanged.

It remains true that one user's rule is written into product code. That is worth removing,
but only together with making the message conditions case-insensitive, which changes
matching semantics for every user and is its own decision. Backlog.

## Scope

Message conditions only. Staged filenames, secret content and compliance events stay in
pre-commit, which is the earlier and cheaper place to refuse a commit.

## Impact

Two active rules in production use `commit_message_not_contains`, both belonging to one
user, both blocking, and both about the same trailer that the grep already catches. So
nobody has been silently unprotected in practice — but the general mechanism has never
worked, and anyone writing a `commit_message_contains` rule today would get a check that
reads the wrong message.
