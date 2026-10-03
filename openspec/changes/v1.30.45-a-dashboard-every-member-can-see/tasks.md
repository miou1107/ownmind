# Tasks

## 1. Bring the mod into the repository

- [x] Copy `~/.claude/mods/ownmind-monitor` to `mods/ownmind-monitor` (generated type stubs
      excluded and git-ignored)
- [x] Home folder: `USERPROFILE` when `HOME` is missing or in Git Bash form; env names stay
      string literals so `claude plugin validate` lists them
- [x] Paths joined with the home folder's own separator; no usable home → empty charts
- [x] Warning toast closes after 5 seconds (`timeoutMs: 5000`, synced from Vin's copy)
- [x] Plugin test for Windows (HOME unset, HOME=/c/Users/amy)
- [x] `claude plugin validate` passes with no warnings; `claude plugin test` passes

## 2. Settings helper

- [x] `scripts/install-helpers/ensure-monitor-mod.cjs`
- [x] Called from `install.sh`, `scripts/update.sh`, `install.ps1`, `scripts/update.ps1`
- [x] `tests/ensure-monitor-mod.test.js`: fresh file, existing env, other plugin dir, two runs,
      legacy migration (tilde, expanded), duplicate spelling, BOM, unparsable file, missing
      mod folder (and removing our entry when it disappears), non-object env / non-string
      dirs refused, opt-out (also on Windows), Windows separator / Git Bash path /
      case-insensitive migration, every installer runs the helper inside an `if` / with a
      `$LASTEXITCODE` check
- [x] Break the check once (installers not wired yet: 4 failures), then wire and confirm green
- [x] Break the helper (separator, legacy match: 5 failures), the mod's home fix (2 failures)
      and the update.sh call (commented out: 1 failure); restore each from a backup

## 3. Release

- [x] Version 1.30.45 in package.json / package-lock.json (SERVER_VERSION reads package.json)
- [x] CHANGELOG, FILELIST, README in three languages, docs/setup-claude-code.md
