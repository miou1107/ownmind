-- What a session learned, kept apart from what it did.
--
-- Every closed session already leaves a summary (session_logs). What it does not leave is
-- the part worth keeping: where the work got stuck, what unstuck it, and what to do
-- differently next time. The team standard "update every layer when you learn something"
-- asks for exactly that, and measured against the memory table it almost never happens —
-- the AI logs the session and the conversation ends. v1.31.0 makes the close itself the
-- place that asks, and this table is where the answers land before anyone has decided
-- whether they deserve to become a memory.
--
-- A lesson is not a memory yet. It sits here as `new` until the person promotes it (a
-- memory row is created and `memory_id` points at it) or dismisses it. Promoting is a human
-- decision on purpose: writing every session's lessons straight into memory would turn the
-- memory table into a log, and a log is what the AI already ignores.
CREATE TABLE IF NOT EXISTS session_lessons (
    id              SERIAL PRIMARY KEY,
    user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_log_id  INT REFERENCES session_logs(id) ON DELETE SET NULL,
    project         VARCHAR(255),
    stuck           TEXT NOT NULL,
    fix             TEXT,
    next_time       TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'promoted', 'dismissed')),
    memory_id       INT REFERENCES memories(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ
);

-- The session-start context asks "how many are waiting" on every conversation, and the
-- page lists one person's `new` rows; both are answered from this index.
CREATE INDEX IF NOT EXISTS idx_session_lessons_user_status
  ON session_lessons (user_id, status, created_at DESC);
