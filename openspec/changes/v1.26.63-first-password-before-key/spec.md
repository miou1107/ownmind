# v1.26.63 — Spec

## Requirement 1 — Login issues no key to an account still on a temporary password

`POST /api/me/login`, given correct credentials for an account with
`must_change_password = TRUE`, answers `200` with `{ mustSetPassword: true }` and no
`api_key`, no `id`, and no `role`. The account is authenticated but not yet trusted with a
credential.

Every other login outcome is unchanged: wrong credentials still answer `401` with the
generic `LOGIN_REJECTED` body, an account with no `password_hash` still answers through
`noPasswordLoginResponse`, and an account with the flag `FALSE` still receives the full
identity and its `api_key`.

### Scenario: the temporary password is correct

- **GIVEN** a user with `must_change_password = TRUE` and a known password
- **WHEN** they POST the right email and password to `/api/me/login`
- **THEN** the status is 200
- **AND** the body is `{ mustSetPassword: true }`
- **AND** the body has no `api_key` key at all, not `api_key: null`

### Scenario: the temporary password is wrong

- **GIVEN** the same user
- **WHEN** they POST the wrong password
- **THEN** the answer is 401 with the same body a wrong password gets for any other
  account, so the response never reveals that this account is on a temporary password

### Scenario: an ordinary account is unaffected

- **GIVEN** a user with `must_change_password = FALSE`
- **WHEN** they log in correctly
- **THEN** the response carries `api_key`, `id`, `name`, `email` and `role` exactly as
  before this release
- **AND** it carries `must_change_password: false`

## Requirement 2 — One endpoint sets the first password and issues the key

`POST /api/me/first-password` takes `{ email, current_password, new_password }`. It is
unauthenticated, because the caller has no key yet, and it is mounted behind the same
`authLimiter` as `/api/me/login`, because it verifies a password.

On success it writes the new hash, sets `must_change_password = FALSE`, writes an audit
row, and returns the same body a successful login returns.

It refuses every other case:

| Case | Answer |
|---|---|
| Email or password wrong | 401, `LOGIN_REJECTED` |
| Account has `must_change_password = FALSE` | 401, `LOGIN_REJECTED` |
| Account has no `password_hash` | 401, `LOGIN_REJECTED` |
| `new_password` shorter than 8 | 400 |
| `new_password` equal to `current_password` | 400 |
| Any field missing | 400 |

The `FALSE` case answers with the credential error rather than a helpful "you already set
your password", because a helpful answer turns the endpoint into an oracle for which
accounts are still on a temporary password.

Every one of those decisions lives in `src/utils/first-password.js` as pure functions
returning `{ status, body }`, following `src/utils/setup-recovery.js`, which already does
this for the no-password login case. The route fetches the row, runs `bcrypt.compare`, and
asks the policy what to answer. `src/routes/me.js` is a 1119-line module-level router with
no dependency injection, and refactoring it into a factory to test one endpoint would put
far more at risk than it proves; moving the decisions out is both testable and smaller.

### Scenario: the first password is set

- **GIVEN** a user with `must_change_password = TRUE` whose temporary password is `temp1234`
- **WHEN** they POST `{ email, current_password: 'temp1234', new_password: 'my-own-pass' }`
- **THEN** the status is 200 and the body carries `api_key`, `id`, `name`, `email`, `role`
- **AND** the stored `password_hash` verifies against `my-own-pass` and not against
  `temp1234`
- **AND** `must_change_password` is now `FALSE`
- **AND** an audit row was written

### Scenario: the temporary password is wrong

- **WHEN** `current_password` does not match
- **THEN** the answer is 401 and `must_change_password` is still `TRUE`
- **AND** no `api_key` appears anywhere in the response

### Scenario: the endpoint cannot be used as an ordinary password change

- **GIVEN** a user with `must_change_password = FALSE`
- **WHEN** they POST their correct current password and a new one
- **THEN** the answer is 401 and the password is unchanged

### Scenario: the new password has to be a real change

- **GIVEN** a user with `must_change_password = TRUE`
- **WHEN** `new_password` equals `current_password`, or is shorter than 8 characters
- **THEN** the answer is 400 and the flag is still `TRUE`

## Requirement 3 — The console recognises the new outcome

`decideLoginOutcome` gains a fourth kind, `first_password`, tested against a literal
`true` and placed before the `api_key` check, following the ordering the module already
documents.

### Scenario: the server says a password must be set

- **GIVEN** `{ ok: true, data: { mustSetPassword: true } }`
- **WHEN** `decideLoginOutcome` runs
- **THEN** the result is `{ kind: 'first_password' }`

### Scenario: a truthy-but-not-true value is not trusted

- **GIVEN** `{ ok: true, data: { mustSetPassword: 'yes' } }`
- **WHEN** `decideLoginOutcome` runs
- **THEN** the result is `{ kind: 'error' }`, because a value this client does not
  understand must not be guessed into a password-setting form

### Scenario: the existing outcomes keep their order

- **GIVEN** `{ ok: true, data: { requiresSetup: true } }`
- **THEN** the result is still `{ kind: 'setup' }`
- **AND** `{ ok: true, data: { api_key: 'k' } }` is still `{ kind: 'authenticated' }`
- **AND** `{ ok: false, error: 'x' }` is still `{ kind: 'error', error: 'x' }`

## Requirement 4 — The login page gains a third mode

`LoginPage` already switches between `login` and `setup` on a `mode` state. A third value,
`first-password`, renders a form asking for the new password twice, keeping the email and
the temporary password already typed so the user does not retype them.

On success it stores the key, primes the session, and navigates to wherever the user was
heading, exactly as an ordinary login does. There is no redirect to `/preference/security`
on this path, because the password has just been set.

### Scenario: a first login completes in one sitting

- **GIVEN** a user typing a temporary password on the login form
- **WHEN** the server answers `mustSetPassword`
- **THEN** the page swaps to the new-password form without clearing the email
- **AND** on success the console lands on the destination page, signed in

### Scenario: the two new passwords must match

- **WHEN** the two fields differ
- **THEN** the form refuses locally, without a request, reusing the existing
  `security.error_mismatch` wording

### Scenario: backing out

- **WHEN** the user chooses to sign in as somebody else
- **THEN** the page returns to the login form with the password field cleared

## Requirement 5 — All three locales carry the new wording

`zh.json` is the source; `en.json` and `ja.json` carry the same key set. The new keys cover
the third mode's title, its explanation, and its submit and back buttons. The password
field labels and the mismatch and length errors reuse the existing `security.*` keys
rather than duplicating them.

### Scenario: no key is left dangling

- **WHEN** every `t('…')` call in `LoginPage.jsx` is checked against the dictionaries
- **THEN** each key exists in all three files

## Requirement 6 — What is still open is written down, not implied

The admin reset path (`src/routes/admin-password-reset.js`) sets `must_change_password`
back to `TRUE` without touching `api_key`, so that person's existing session and MCP keep
working. This release does not change that.

### Scenario: an admin resets a password

- **GIVEN** a signed-in user whose admin resets their password
- **WHEN** they keep using the console with the key they already hold
- **THEN** requests still succeed, and `RequireFreshPassword` is the only thing steering
  them to `/preference/security`

This is stated so the release is not read as closing it. Closing it requires rotating the
`api_key`, which breaks that person's installed MCP configuration; that is a separate
decision, deferred by Vin on 2026-08-05.
