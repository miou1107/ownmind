-- v1.26.97 — record how the submit confirmation was obtained.
--
-- The tool description told the AI to show the report to the user and wait for them to type
-- a submit phrase, and claimed the backend rejected auto-filled submissions. It does not,
-- and it cannot: `confirm_string` is a string field, and the server sees only that a string
-- equal to the expected phrase arrived. It has no way to tell whether the user typed those
-- characters or the AI did. Demonstrated on 2026-08-07 (bug report #18, which was itself
-- filed that way, as was #17).
--
-- No server-side check can close this while the AI holds the same API key as the person:
-- console login returns that same key, so every endpoint either of them can call, both can.
-- Separating the credentials is a larger change, tracked in the backlog.
--
-- What is possible now is to stop pretending and record the distinction. This column holds
-- what the CLIENT declared, not something the server verified — the name says `declared` so
-- no later reader mistakes it for proof.
ALTER TABLE bug_reports
  ADD COLUMN IF NOT EXISTS confirmation_declared VARCHAR(16);

COMMENT ON COLUMN bug_reports.confirmation_declared IS
  'Client-declared, never server-verified: user_typed | ai_filled | unknown. The server cannot distinguish these; see db/022 for why.';

-- Existing rows predate the field. 'unknown' is the honest value: some were user-typed and
-- some were not, and there is no record of which.
UPDATE bug_reports SET confirmation_declared = 'unknown' WHERE confirmation_declared IS NULL;
