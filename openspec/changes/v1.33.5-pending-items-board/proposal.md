# The pending-items pane as a board grouped by project

Follows miou1107/ownmind#203 (v1.33.4).

## Why

On 2026-11-12, after v1.33.4 shipped, the product owner looked at the side pane and asked for
cards instead of a flat list, a refresh button, and a way to look at one project at a time
(all projects by default). Reviewing the prototype he added: days since the last update on
each card, the "pending" label only where it differs from a plain assignment (every card is
already pending), project groups that fold from their header, and the GitHub or GitLab logo
after each project's name.

## What changes

1. **Items carry `project`.** On GitHub it is the repository's name. On GitLab it is the
   repository's name unless the issue or MR carries a label that the host entry in
   `~/.ownmind/git-hosts.json` names under `projectLabels` (`{"daas": "DaaS"}`), for one
   repository that holds several products. Comment items also carry `project` and `at`.
2. **`hooks/pending-items-check.js`** runs the same check the session-start hook runs and
   rewrites the state file. The pane's refresh button runs it.
3. **The pane** (`mods/pending-items`) groups cards by source and project, biggest group first;
   inside a group, review / failing / comment items first, then the newest change. Each group
   header folds the group (remembered across sessions in `$.store`), shows a coloured dot, the
   project's name, the GitHub or GitLab logo (the name on the terminal, which has no Svg) and
   the count. A select beside the refresh button picks one project. Each card shows the title as
   a link, a label only for review / failing / comment, the short ref (`#12`, `PR #7`, `!112`),
   "today / yesterday / N days ago" (in the warning colour past 14 days), and the initials of
   whoever is waiting on the user in a coloured circle (`JD` for Jane Doe; a CJK name's first
   character; letters only on the terminal). Items carry that person as `person`: an issue's
   opener when it is not the user, a PR's author, or the last commenter who is not the user.

4. **OwnMind's own items.** With OwnMind credentials on the machine, the check also asks the
   server for the user's open task cards and bug reports (an admin's unhandled ones, the user's
   own resolved in the last week). They are pane-only: grouped under the OwnMind logo (task cards by their
   project, reports in one 「問題回報」 group), linked to the console's inbox pages, and never
   listed as new in the conversation, which already reports them at session start.

## Not changed

When the reminder appears in the conversation, what it lists, the state file's other fields.
