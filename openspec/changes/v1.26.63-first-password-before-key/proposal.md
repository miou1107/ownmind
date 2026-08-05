# v1.26.63 — A temporary password stops converting into a permanent key

`openspec/BACKLOG.md` item 1 said `must_change_password` is enforced only in the browser.
That is true, and the shape of the problem is worse than the entry described.

## What actually happens

`seedDefaultPasswords` generates a random password for every account with no
`password_hash`, writes it to the server log once, and sets `must_change_password = TRUE`.
The admin reads it out of the log and relays it to the person, usually over chat.

That person logs in. `POST /api/me/login` checks the password and returns the account's
**permanent `api_key`** (`src/routes/me.js:70`), the same credential the MCP client holds,
which never expires and which every authenticated route accepts.

From that moment the only thing still asking them to change the password is
`RequireFreshPassword`, which reads `ownmind.must_change_password` out of localStorage.
Delete that key in devtools and the requirement is gone.

So a password that was written to a log file and relayed over a chat channel converts, on
first use, into permanent unrestricted API access. The requirement to replace it was never
enforced anywhere a user could not reach.

## Why the obvious fix is the wrong one

The backlog entry implies gating requests on the flag. Doing that would take the team
offline.

`must_change_password = TRUE` is not a rare state. The seed job sets it for everyone who
had no password, which is everyone who has never opened the web console. `src/routes/me.js`
carries a reverse-audit query built exactly for those people, whose message reads
「可能根本沒登入過」. All of them use OwnMind daily through the MCP, with the same
`api_key`. A middleware gate on that flag would stop their hooks and their MCP the moment
it deployed, for a reason that has nothing to do with how they use the product.

The flag says "this person has not chosen their own password". It does not say "this
request is suspicious".

## The fix

Move the gate to the one place the temporary password is actually used: login.

- When the password is correct and `must_change_password` is `TRUE`, the login response
  carries **no `api_key`**. It says only that a password must be set.
- A new endpoint, `POST /api/me/first-password`, takes the email, the temporary password
  and the new one. It verifies the temporary password itself, writes the new hash, clears
  the flag, and only then returns the `api_key`.
- The console's login page gains a third mode, alongside the login and recovery-setup
  modes it already has.

Three consequences worth stating plainly:

**Nobody's MCP is touched.** Only the console calls `/api/me/login`; a grep across
`mcp/`, `hooks/`, `scripts/` and `shared/` finds no other caller. Installed clients hold a
key issued at install time and never ask for another.

**Deleting the localStorage flag stops being worth anything**, because the browser no
longer holds a key to use. The bypass is not blocked so much as emptied.

**No new token type, no schema change, no migration.** The new endpoint verifies a
password the same way login does.

## What this does not close

An admin resetting someone's password (`src/routes/admin-password-reset.js:88`) sets the
flag back to `TRUE` but leaves that person's `api_key` untouched. Their open browser
session and their MCP keep working. After this release the path that *issues* a temporary
password is closed; the path where an admin *resets* one is not.

Closing it means rotating the `api_key` on a password change, which invalidates that
person's installed MCP configuration and requires them to re-run the installer, possibly
without knowing why it broke. Vin's call on 2026-08-05 was to keep this release to the
source and decide rotation separately.

## Review round

Adversarial review through the `agy` CLI, against a copy outside the repo. **Zero
findings**, which on a credential path is a result to be suspicious of rather than pleased
by, so three things were checked independently afterwards. All three are things the
reviewer had no way to know:

- **`audit_logs.action` accepts the new value.** `db/005_admin_roles_password.sql:21`
  declares it `VARCHAR(50)` with no CHECK constraint, and nothing maps action strings to
  display text, so `'first_password'` stores and renders fine.
- **`writeAuditLog`'s signature matches the call.** `(actorId, action, targetType,
  targetId, details)`.
- **Nothing else reads the login response shape.** The full suite passes, and the e2e
  harness seeds its accounts with `must_change_password = FALSE`.

The reviewer's own confirmations worth recording, because they are the claims the spec
makes: every credential refusal is one indistinguishable 401; the shape checks run first
so a 400 cannot be read as "your guess was right"; mounting the *same* `authLimiter`
instance on both paths means an address gets ten attempts across the two combined, not ten
each; and the client returns out of the submit handler before `setApiKey`, so no
credential is stored on the new path.

**Found while writing it up.** The login audit row said `login` whether or not a key was
issued, so from this release a row could record something that did not happen. It now
carries `issued_key`.

**The review had to be asked twice.** Phrased as "attack this and construct attack
sequences", `agy` declined outright. Rephrased as a pre-merge defensive review of the
project's own code, it ran. Worth remembering: the framing changes whether the tool works
at all, and the second framing is also the more accurate description of what this is.

## Non-goals

- No `api_key` rotation, per above.
- No middleware gate on `must_change_password`; see why not, above.
- `RequireFreshPassword` and the localStorage flag stay. They are no longer load-bearing
  for the login path, but they still nudge someone whose flag was set by an admin reset
  while they were signed in.
- No change to `POST /api/me/change-password`, which serves the ordinary case of a
  signed-in user changing a password they already chose.
- No expiry on temporary passwords.
