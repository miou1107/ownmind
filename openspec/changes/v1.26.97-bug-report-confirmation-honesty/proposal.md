# v1.26.97 — Proposal: the submit gate was never a gate

## Background

Reported as bug #18. `ownmind_report_bug`'s description said:

> The AI MUST NOT fill confirm_string itself — the backend rejects auto-filled submissions
> with HTTP 400.

It does not. `confirm_string` is a string field; the server sees that a string equal to the
expected phrase arrived and has no way to tell who produced those characters. The reporter
demonstrated it by filing bug #17 with no user input at all, then filed #18 the same way.

## The proposed fix does not close it either

The report suggested a server-issued one-time phrase: the caller asks for a random phrase,
the user reads it back, `confirm_string` must equal it.

**The AI is the caller that fetches the phrase.** It can read the phrase and fill it in, and
the server sees exactly what it sees today: a string with the right value. The only thing
gained is that the phrase is not guessable from memory — but nobody had to guess, because
the tool description contained it.

"Approve it in the admin console" fails for a different reason, established by reading the
auth: `POST /me/login` returns **the same `api_key`** the AI already holds. Every endpoint
the person can call, the AI can call.

So no server-side check of any shape can separate them while they share one credential.

## What this changes

Stop claiming otherwise, and record the distinction as what it is.

- `bug_reports.confirmation_declared` — `user_typed` | `ai_filled` | `unknown`. Named
  `declared` so no later reader mistakes it for something verified.
- Absent, unrecognised or malformed → `unknown`, never `user_typed`. An older client sends
  nothing at all, and that must not read as the stronger value.
- Existing rows backfill to `unknown`: some were user-typed and some were not, and there is
  no record of which. Claiming either would be inventing data.
- The tool description drops the false assurance and says plainly that the server checks the
  value and cannot see who typed it, so the AI should declare it honestly instead.
- Returned when listing reports, so the person triaging can see it.

This does not make the gate real. It makes the record true, which is what tells the person
reading these reports whether anyone else has looked at one.

## Not done

Separating the credentials — an MCP key that can file a report but not confirm one, and a
confirmation credential only a browser login mints. That is a change to the permission
model rather than to this feature. Backlog 36.
