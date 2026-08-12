# Tasks

## 1. Find out what is actually broken, before changing anything

- [x] Sweep every `trigger:` tag on the live account against `TRIGGER_TAG_ALIASES` — 36 words
      are recognised, and a long tail of tags is not
- [x] Ask the better question: not "which tags are dead" but **"which memories match no
      operation at all"** — 9, across team standards, iron rules and preferences
- [x] Check `trigger:push` before proposing it: all three memories carrying it already match
      `commit` another way, so adding the word changes nothing. Dropped.
- [x] Read the standard behind `trigger:send` in full rather than guessing from its title
- [x] Confirm the gap is in the classifier, not the vocabulary: `gh issue create`,
      `gh issue comment`, `gh pr create` all classified as nothing

## 2. Add the trigger

- [x] `detectCommandTrigger`: `gh issue|pr create|comment|edit|review|close|reopen`,
      `git send-email`
- [x] `gh release create|edit|upload` → `deploy`, above the send branch — it publishes a build
- [x] `TRIGGER_LABELS.send = 'Outward send'`
- [x] `TRIGGER_TAG_ALIASES.send`, with `publish` / `發布` / `發佈` in both buckets
- [x] `發佈` added to `deploy` as well — the traditional-character form was missing

## 3. Tests

- [x] The four send commands, in the parity table both classifiers run against
- [x] The two that must **not** fire: `gh issue list`, `gh pr view`
- [x] `gh release create` → deploy
- [x] `gh pr create && git push` → deploy, so nothing already classified changes
- [x] `publish` / `發布` / `發佈` match both buckets; the deploy-only words match only one
- [x] A send tag fires on neither commit nor edit

## 4. Verify against the real thing, not a stub

- [x] Run the shipping `.sh` hook with a `gh issue create` payload against the live server:

```
[OwnMind v1.26.154] This operation is a "Outward send" procedure.
Memories found: Team standards 1/32, …
  Team standards: [團隊] 對外送出前先獨立審查
```

- [x] Full suite

## 5. Release

- [x] CHANGELOG / FILELIST / three READMEs / package.json
- [x] Commit, push, tag `v1.26.155`

## Not doing, and why it is written down

The other seven invisible memories. What their tags name is a kind of work, not an operation
— replying, wrapping up, debugging, onboarding, migrating — and there is no tool call to hook.
They already work through the session-start channel, which loads every team standard's title.
Their tags are redundant, not broken.

**Anyone reading this later: do not "finish the job" by tagging them `trigger:command`.** That
matches every operation, which puts all seven in front of every commit and every file edit —
the noise v1.26.151 was built to remove.
