# Tasks

- [ ] 1. Commit `hooks/ownmind-usage-scanner.js` as mode `100755`
- [ ] 2. Add `bin/` and `reports/` to `.gitignore`
- [ ] 3. `scripts/interactive-upgrade.sh` — decide dirtiness from tracked changes only;
      log untracked paths without acting on them
- [ ] 4. `scripts/interactive-upgrade.ps1` — the same change (IR-022)
- [ ] 5. Test: every path the installers `chmod +x` inside the checkout is committed
      `100755`, with the list read out of the installers
- [ ] 6. Test: untracked-only trees take the `--ff-only` branch in both upgraders;
      a modified tracked file still takes the reset branch
- [ ] 7. Mutation-test every new assertion
- [ ] 8. Version bump + CHANGELOG + FILELIST + three READMEs (IR-026, IR-032)
- [ ] 9. `superpowers:verification-before-completion`
- [ ] 10. `superpowers:requesting-code-review`, then adversarial review via `agy` (IR-072)
