-- Task cards an AI session can pick up (v1.31.2).
--
-- Not a board for people to drag cards around — GitLab does that. A dispatch queue: a
-- person writes a small card, a session (started by a person or by a schedule) claims it,
-- does it, reports back, and the person reviews. The card is the unit the lessons of
-- v1.31.0 attach to and the release check of v1.31.3 reads.
--
-- `reviewed` is set only from the console; no MCP tool can set it (the AI never reviews
-- its own work). `claimed` expires after a day (shared/task-body.js CLAIM_TTL_HOURS) so a
-- session that died does not hold a card forever.
CREATE TABLE IF NOT EXISTS tasks (
    id              SERIAL PRIMARY KEY,
    user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project         VARCHAR(255) NOT NULL,
    title           VARCHAR(500) NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    status          VARCHAR(20) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'claimed', 'done', 'reviewed', 'dropped')),
    is_private      BOOLEAN NOT NULL DEFAULT FALSE,
    auto            BOOLEAN NOT NULL DEFAULT FALSE,
    links           JSONB NOT NULL DEFAULT '{}',
    claimed_by      INT REFERENCES users(id) ON DELETE SET NULL,
    claimed_tool    VARCHAR(100),
    claimed_session VARCHAR(100),
    claimed_at      TIMESTAMPTZ,
    result          TEXT,
    done_at         TIMESTAMPTZ,
    reviewed_by     INT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every list asks "open and claimed cards of this project"; the expiry asks "claims older
-- than a day"; the session-start context asks "what has this person claimed".
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks (project, status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed ON tasks (claimed_by, claimed_at) WHERE status = 'claimed';
