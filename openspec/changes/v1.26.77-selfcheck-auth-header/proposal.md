# v1.26.77 — the self-check could never have reached the server

## What happened

Vin's machine was upgraded to v1.26.76 on 2026-08-06. The upgrade's own self-check ran and
said:

```
Could not ask the server: the server answered 401
The scan itself ran; this check just could not confirm the other end.
```

The scan uploaded nine events successfully. Only the check that reads back failed.

## Why

`fetchSelfCheck` sent `X-API-Key: <key>`. `src/middleware/auth.js` reads
`req.headers.authorization` and requires it to start with `Bearer `. It reads nothing else.

So `GET /api/usage/self-check` answered 401 to every call, always. The feature has been
shipped and broken since v1.26.72.

## Why it was not noticed

It was checked against production once, when v1.26.72 was written. Production was on
v1.26.67 then, which does not have the endpoint, so the answer was 404 and the check
reported, correctly and uselessly, "this server does not have the self-check endpoint yet".
A 404 is returned by the router before auth runs. The first server that could have
returned 401 was the one deployed an hour ago.

## Why no test caught it

The two sides were faked independently:

- `tests/selfcheck-report.test.js` stubs `fetch`, so no header is ever read.
- `tests/selfcheck-endpoint.test.js` stubs `auth`, so no header is ever checked.

Each side passed its own tests while disagreeing with the other. This is the second defect
of exactly this shape in two hours; the first was the heartbeat SQL in v1.26.76, where
every test handed the route a fake `query` and nothing ever parsed the statement.

**Where a test fakes both sides of a contract, it cannot see the contract break.**

## The fix

Send `Authorization: Bearer <key>`.

Verified against production before shipping: the old header answers 401, the new one
answers 200 with five tool rows.

Two tests: one asserting the header sent, one reading `src/middleware/auth.js` itself so
the client and the middleware cannot drift apart again without something going red.
