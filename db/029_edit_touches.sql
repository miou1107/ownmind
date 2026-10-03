-- Who is editing which directory of which project right now (v1.31.1).
--
-- GitLab knows who claimed an issue; nothing knows that two people are in the same module
-- in two AI conversations until the merge. The edit hook already runs on every member's
-- machine before every file edit, so it reports the project and the directory — never the
-- file, never an absolute path — and the server answers with who else was there recently.
--
-- This is a two-hour window, not a record. Rows are upserted per (user, project, dir,
-- session) and deleted after a day by the cleanup job; nothing reads them after that, and
-- nothing is meant to.
CREATE TABLE IF NOT EXISTS edit_touches (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project     VARCHAR(255) NOT NULL,
    dir         VARCHAR(255) NOT NULL,
    session_id  VARCHAR(100) NOT NULL,
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, project, dir, session_id)
);

-- Every answer asks "who else touched this (project, dir) lately".
CREATE INDEX IF NOT EXISTS idx_edit_touches_place_time
  ON edit_touches (project, dir, last_seen DESC);

-- The daily cleanup asks "what is older than a day", which the index above cannot answer
-- (it is led by project and dir).
CREATE INDEX IF NOT EXISTS idx_edit_touches_last_seen
  ON edit_touches (last_seen);
