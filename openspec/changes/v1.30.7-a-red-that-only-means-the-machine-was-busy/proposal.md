# A red that only means the machine was busy

## Why

During the v1.30.6 verification run, two test files failed. Both passed when run on their own.
Their reported durations were about nine hours, which is how the runner describes a test that
was still going when its timeout arrived.

`tests/iron-rule-trigger-parity.test.js` takes **55 seconds by itself** on Windows. It has 30
cases, each of which spawns `bash`, which starts the real hook, which starts `node` more than
once. Under a loaded parallel suite run that is slow enough to cross the 300-second test
timeout, and the file goes red saying the shell classifier disagrees with `shared/helpers.js` —
which it does not.

That is a false red, and worse, one that lands on a different file depending on which four
happened to run together. v1.26.158 was spent removing exactly that shape from this suite. It
came back through a different door: not an unlucky port this time, but an unlucky minute.

## What changes

**Every command is classified once, up front, four at a time.** Each test then reads its
answer and asserts. One test per command is kept, so a genuine disagreement still fails with
the command in its name — which is the whole reason the file is written as thirty tests rather
than one loop.

55 seconds becomes 16, measured over three consecutive runs (17s, 16s, 15s).

**Each spawn gets its own `session_id`.** The hook keys its once-an-hour window on the session;
without one, every spawn shared the key `default`. Sequentially that was a hidden coupling —
only the first run of the file saw a full listing — and concurrently it would have been thirty
processes writing one state file. Giving each its own is both the fix for that and a more
honest fixture: real sessions do not share a window.

**Bounded at four rather than run all at once**, because thirty concurrent bash-and-node trees
is a different way to overload the same machine.

## What this does not do

The other file that timed out, `tests/reset-admin-password-script.test.js`, is not touched. It
takes under a second alone; it was collateral from the same busy minute. If it times out again
with this one fixed, that is new information rather than the same information twice.

## Impact

- `tests/iron-rule-trigger-parity.test.js` only. No product code.
