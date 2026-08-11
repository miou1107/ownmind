# Tasks

- [x] 1. Commit `hooks/ownmind-usage-scanner.js` as mode `100755`
- [x] 2. Add `bin/` and `reports/` to `.gitignore`
- [x] 3. `scripts/interactive-upgrade.sh` — decide dirtiness from tracked changes only;
      log untracked paths without acting on them
- [x] 4. `scripts/interactive-upgrade.ps1` — the same change (IR-022)
- [x] 5. Test: every path the installers `chmod +x` inside the checkout is committed
      `100755`, with the list read out of the installers
- [x] 6. Test: untracked-only trees take the `--ff-only` branch in both upgraders;
      a modified tracked file still takes the reset branch
- [x] 7. Mutation-test every new assertion
- [x] 8. Version bump + CHANGELOG + FILELIST + three READMEs (IR-026, IR-032)
- [x] 9. `superpowers:verification-before-completion`
- [x] 10. `superpowers:requesting-code-review`, then adversarial review via `agy` (IR-072)
- [x] 11. Found in review: `hooks/ownmind-session-start.sh` stashed before pulling and never
      restored (30 stash entries measured on one machine). Now pulls with `--autostash`,
      guarded by a grown test over every script in the repository
