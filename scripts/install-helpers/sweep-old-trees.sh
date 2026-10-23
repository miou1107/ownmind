#!/usr/bin/env bash
# Sweep old copies of ~/.ownmind: upgrade backups (.ownmind.bak.<ts>) and directories set aside by
# bootstrap as broken (.ownmind.broken.<ts>) beside it, a .ownmind.prev beside it, and the previous
# release's code an archive update keeps inside it (.ownmind/.prev). Sourced by
# interactive-upgrade.sh at the end of a successful upgrade.
#
# Each of them may hold runtime/current, a symlink to the private Node. `rm -rf` does not follow
# a symlink, but the link is removed on its own first all the same, so no recursive delete ever
# meets it whatever the platform's rule is (Git Bash on Windows sees the directory junction there
# as a link too). Only real directories are matched (`-type d`): a link named like one of these is
# left alone rather than followed.
#
# Bash 3.2 compatible.

# ownmind_sweep_old_trees PARENT_DIR RETENTION_DAYS
ownmind_sweep_old_trees() {
  local parent="$1" days="$2" dir
  [ -d "$parent" ] || return 0
  case "$days" in ''|*[!0-9]*) days=7 ;; esac
  {
    find "$parent" -maxdepth 1 -type d \
      \( -name '.ownmind.bak.*' -o -name '.ownmind.broken.*' -o -name '.ownmind.prev' \) \
      -mtime +"$days" 2>/dev/null
    [ -d "$parent/.ownmind" ] && find "$parent/.ownmind" -maxdepth 1 -type d -name '.prev' -mtime +"$days" 2>/dev/null
  } | while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      if [ -L "$dir/runtime/current" ]; then rm -f "$dir/runtime/current" 2>/dev/null || continue; fi
      rm -rf "$dir" 2>/dev/null || true
    done
  return 0
}
