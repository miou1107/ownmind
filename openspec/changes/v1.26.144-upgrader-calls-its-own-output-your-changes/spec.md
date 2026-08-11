# Spec — the upgrader distinguishes the user's changes from its own output

## ADDED Requirements

### Requirement: files the installers make executable are committed executable

Every path inside the checkout that `install.sh` or `scripts/update.sh` passes to
`chmod +x` SHALL be recorded in the repository with mode `100755`.

#### Scenario: the scanner hook

- **GIVEN** `scripts/update.sh` runs `chmod +x "$OWNMIND_DIR/hooks/ownmind-usage-scanner.js"`
- **WHEN** the repository's index is read
- **THEN** `hooks/ownmind-usage-scanner.js` is recorded as `100755`
- **AND** `git status --porcelain --untracked-files=no` is empty on an installation the
  user has not edited

#### Scenario: a file made executable in future

- **GIVEN** a new `chmod +x "$OWNMIND_DIR/<path>"` is added to either installer
- **WHEN** the test suite runs
- **THEN** it fails naming `<path>` unless `<path>` is committed `100755`
- **AND** the list of paths comes from reading the installers, not from a list written by
  hand

### Requirement: untracked files do not trigger the destructive branch

The upgraders SHALL decide whether the working tree is dirty from tracked changes only.

#### Scenario: OwnMind's own runtime output

- **GIVEN** the checkout contains untracked `bin/` and `reports/` written by OwnMind
- **AND** no tracked file has been modified
- **WHEN** `interactive-upgrade.sh` or `interactive-upgrade.ps1` runs
- **THEN** it takes the `git pull --ff-only` branch
- **AND** it does not run `git reset --hard`
- **AND** it files no `upgrade_dirty_tree` report

#### Scenario: an edit the user actually made

- **GIVEN** a tracked file has been modified
- **WHEN** either upgrader runs
- **THEN** it saves a backup, files `upgrade_dirty_tree`, and force-aligns as before

#### Scenario: untracked files remain visible

- **GIVEN** the checkout contains untracked paths
- **WHEN** either upgrader runs
- **THEN** the untracked paths are written to the upgrade log
- **AND** nothing is overwritten on their account

## MODIFIED Requirements

### Requirement: the checkout ignores what OwnMind writes into it

`.gitignore` SHALL cover the directories the installers and scheduled jobs create inside
the checkout.

#### Scenario: installer and report output

- **GIVEN** `install.sh` creates `bin/` and the daily health job writes `reports/`
- **WHEN** `git status --porcelain` runs in the checkout
- **THEN** neither path appears

### Requirement: nothing stashes the working tree without restoring it

No script in the repository SHALL run `git stash` without restoring the stashed state.

#### Scenario: the session-start hook pulls a new version

- **GIVEN** the user has uncommitted changes in the checkout
- **WHEN** `hooks/ownmind-session-start.sh` finds new commits upstream and pulls
- **THEN** it pulls with `--autostash`, which restores the changes when the pull finishes
- **AND** the fallback pull omits `--autostash` and declines a dirty tree with `--ff-only`
  rather than touching it

#### Scenario: a script added later

- **GIVEN** a shell or PowerShell script that runs `git stash` with no matching
  `stash pop` or `stash apply` in the same file, and without `--autostash`
- **WHEN** the test suite runs
- **THEN** it fails naming that script
- **AND** the list of scripts checked comes from walking the repository, not from a list
  written by hand
