# Tell the user which issues, PRs and MRs are waiting on them

Issue: miou1107/ownmind#203

## Why

On 2026-11-12 the product owner noticed that OwnMind never mentions the work waiting for them
on GitHub or GitLab. A colleague can ask them to review a merge request, or one of their own
pull requests can fail its tests, and nothing in the conversation says so unless they go and
look. The session-start hook reads only the memory store; it never looks at the user's git
hosts.

## What changes

1. **`hooks/lib/pending-items.js`** collects, across every repository the user can see:
   - open issues assigned to the user;
   - open PRs / MRs that request the user's review (listed once, when the request appears);
   - open PRs / MRs the user authored whose checks failed, or that received new comments.

   GitHub is read through the `gh` CLI the user is already signed in to. GitLab hosts are
   read from `~/.ownmind/git-hosts.json` (`{"gitlab":[{"url":"…","token":"…"}]}`, file mode
   0600), because a self-hosted GitLab has no default address.

2. **When the list is shown.**
   - The first check of the local day lists every waiting item.
   - Later checks the same day list only items that are new since the last list.
   - Session start always checks. A prompt submitted more than an hour after the last check
     checks again and lists what is new.
   - Nothing waiting, nothing new, no `gh` login and no GitLab host configured: nothing shown.

3. **Login that expired.** When a host answered before and now refuses the credentials, the
   user sees one line ("GitHub 登入已過期，需重新登入才能列出等你處理的單") until a check
   succeeds again. A timeout or a network failure is skipped silently; only a refused login
   produces the line.

4. **Delivery.** The list is written to `systemMessage`, which the client renders to the person
   directly, so it does not depend on the model choosing to relay it. The same list goes to
   `additionalContext` so the model can act on "handle the first one".

5. **`mods/pending-items`** — a Claude desktop pane, "待處理單據", that shows every item still
   waiting (not only the new ones), refreshed from `~/.ownmind/state/pending-items.json` once a
   minute. Installed through `scripts/install-helpers/ensure-monitor-mod.cjs` like the other mods.

6. **`scripts/privacy-scan.js`** — this repository is public. Before a commit, the script reads
   the staged diff and stops on any term listed in `~/.ownmind/privacy-terms.txt` (kept outside
   the repository) or any e-mail address outside the allowed placeholder domains. It prints the
   file and line, never the matched value.

## Decisions

- **Display goes through `systemMessage`, not through a request to the model.** A request to
  relay is a probability; the product rule says a reminder the user must see is delivered by the
  system.
- **One time budget.** Each host gets 2 seconds; the hosts run in parallel. A slow host costs the
  session nothing but its own lines.
- **Review requests are listed once.** New comments on a review request do not re-list it; new
  comments on the user's own PR/MR do.
- **Baseline before "new comment".** The first time an authored PR/MR is seen, its comment count
  is recorded and it is not flagged; only later increases are.
- **No reminder for users who never signed in.** Whether to suggest signing in once is still open
  on the issue; until it is decided, a machine with no login shows nothing.

## Not in scope

- Reading GitLab credentials from the OwnMind secret store.
- Bitbucket, Gitea and other hosts.
