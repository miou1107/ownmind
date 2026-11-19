# The pending-items pane: open only for new items, a switch for opening by itself, a one-sentence reminder

Follows v1.33.6 (hide a card, OwnMind items in the conversation).

## Why

On 2026-11-18 a colleague asked whether the daily issue check could be off by default: the pane
opened at the start of every conversation as long as anything was listed, and nothing turned
that off. The product owner settled the design in the conversation:

- the pane opens by itself only when a new item has come in;
- a switch stops it opening by itself, as a button at the top of the pane and by telling Claude
  in plain words (and back on the same way);
- the reminder in the conversation stays whatever the switch says, because it is one sentence,
  and it is cut to one sentence that names who gave which item.

The same version carries a fix found on the way: a response read in pieces could split a
multi-byte character, so a title sometimes showed one or two garbled characters.

## What changes

### When the pane opens

- The pane keeps, in `$.store` (`seen`, capped at 500), the items it has drawn or opened for,
  each as `key:kind:mark`, where `mark` is the item's `signal` (a failing PR's commit, a
  comment's mark). At `session.start` it opens only when the list holds an item not in `seen`.
- An item drawn while the pane is open is noted as seen; an open the engine did not place
  (`isPlaced: false`) notes nothing, so the pane still opens once a surface draws it.
- The list is looked at once more ten seconds after the start, since the check that writes the
  state file may finish after the pane's first read.

### The switch

- `$.store` key `autoOpen` (absent means on), per machine. The pane's header row has a button
  that says what pressing it does: 「關閉自動跳出」 while on, 「開啟自動跳出」 while off, with a
  toast after each press. A press that could not be stored says so and changes nothing.
- A tool for the model, `pane`, with `action` `off`, `on` or `show`. Its description lists the
  phrases a person might use and tells the model to ask first when the wording could mean
  closing the item itself. `show` opens the pane once and reports when it could not be drawn.
- `/pending-items` opens the pane whatever the switch says.

### The reminder

- `decide` also returns `added` (items that appeared since the host's previous answer) and
  `total`; the state file keeps `known`, each host's ids at its last answer, so a host that sat
  out one check does not make old items look new. A state file from an older version is read as
  if its items were known.
- `render` writes one sentence: how many are new and up to two of them by name, most urgent
  first (review, failing tests, new reply, assigned), then how many more. The day's first
  conversation states the total first. A title is cut at 24 characters. An item the user opened
  themself is named by its title alone; a failing PR as “the one with failing tests”.
- `contextNote` gives the model the same sentence plus up to ten of the new items with their
  links, so the user can ask Claude to open one.
- Locale keys: `pendingItems.new`, `.allWithNew`, `.all`, `.rest`, `.pair`, `.name.by`,
  `.name.plain`, `.name.failing`, `.name.reply`, `.name.replied`; `header.*`, `item`, `more`
  and `kind.*` are removed. `expired.*` is unchanged.

### Split characters

- Every place that reads an HTTP response in pieces calls `res.setEncoding('utf8')` first:
  `hooks/lib/pending-items.js`, `fetch-project-tasks.js`, `release-check.js`,
  `hook-context-fetch.js`, `hooks/ownmind-touch-report.js`.

## Not in this change

- No server change; no setting in the console.
- The reminder itself is still turned off with `OWNMIND_PENDING_ITEMS=off`.
