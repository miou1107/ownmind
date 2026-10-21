-- v1.33.0 — the AI keeps the memory; the console only shows and undoes.
--
-- 2026-10-21: 155 iron rules and 374 project memories had piled up with duplicates and
-- finished items still active, because every clean-up waited for a person to press a button
-- in the console. Maintaining the store is now the AI's job (CLAUDE.md, inference 5). This
-- migration gives it what that needs:
--
--   * pg_trgm, so the server can say "this looks like #N" without any model;
--   * a third memory state, `archived`: the thing it describes has ended, and what it says
--     was true at the time. `disabled` keeps meaning "wrong or superseded";
--   * history change types for merge / archive / decide / restore, so the console can show
--     what the AI did and `revert` can undo it;
--   * where a lesson's verdict came from (`promoted_by`) and why (`reason`);
--   * the evidence a task card was closed with, and whether its monthly report was shown;
--   * the questions the AI could not answer by itself, so it can ask at most twice.
--
-- Spec: openspec/changes/v1.33.0-ai-keeps-the-memory/spec.md

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── memories: archived is a state, with when and why ──────────────────────────────────
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_reason TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_status_check') THEN
    ALTER TABLE memories DROP CONSTRAINT memories_status_check;
  END IF;
  ALTER TABLE memories
    ADD CONSTRAINT memories_status_check
    CHECK (status IN ('active', 'disabled', 'archived'));
END $$;

-- The save-time duplicate check and the monthly candidate pairs both ask
-- "which active rows read like this text"; the GIN index is what makes that a lookup.
CREATE INDEX IF NOT EXISTS memories_trgm_idx
  ON memories USING gin (lower(title || ' ' || content) gin_trgm_ops);

-- ── memory_history: the four actions the AI takes on its own ──────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_history_change_type_check') THEN
    ALTER TABLE memory_history DROP CONSTRAINT memory_history_change_type_check;
  END IF;
  ALTER TABLE memory_history
    ADD CONSTRAINT memory_history_change_type_check
    CHECK (change_type IN (
      'create', 'update', 'disable', 'enable', 'revert',
      'merge', 'archive', 'decide', 'restore'
    ));
END $$;

-- ── session_lessons: who decided, and why ─────────────────────────────────────────────
ALTER TABLE session_lessons
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS promoted_by VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_lessons_promoted_by_check') THEN
    ALTER TABLE session_lessons
      ADD CONSTRAINT session_lessons_promoted_by_check
      CHECK (promoted_by IS NULL OR promoted_by IN ('ai_repeat', 'ai_monthly', 'console'));
  END IF;
END $$;

-- ── tasks: done carries its evidence; the consolidation card remembers its report ─────
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS evidence TEXT,
  ADD COLUMN IF NOT EXISTS report_shown_at TIMESTAMPTZ;

-- ── tasks: one consolidation card per user per month ──────────────────────────────────
-- The daily job writes one card per user titled with CARD_TITLE_PREFIX + 'YYYY-MM'. It
-- checks first, but the start-up run and the cron (or two servers) can both pass the check;
-- this index makes the second insert a no-op (ON CONFLICT DO NOTHING in
-- src/jobs/memory-consolidation.js). The prefix is the CARD_TITLE_PREFIX constant of
-- src/routes/memory-consolidation.js, written here as \u escapes (Postgres E'' syntax).
CREATE UNIQUE INDEX IF NOT EXISTS tasks_consolidation_card_uidx
  ON tasks (user_id, title)
  WHERE project = 'ownmind' AND title LIKE E'\u6574\u7406\u8a18\u61b6 %';

-- ── questions the AI parks for the person ─────────────────────────────────────────────
-- One row per memory the AI could not settle on its own. `asked_count` goes up each time a
-- session shows it; at two unanswered showings the daily job archives the memory and marks
-- the question answered, so a question never blocks newer ones.
CREATE TABLE IF NOT EXISTS consolidation_questions (
    id            SERIAL PRIMARY KEY,
    user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    memory_id     INT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    project       VARCHAR(255),
    question      TEXT NOT NULL,
    asked_count   INT NOT NULL DEFAULT 0,
    last_asked_at TIMESTAMPTZ,
    answered_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- The session-start context asks "this person's open questions, oldest first" on every
-- conversation; the job asks "open questions asked twice and old".
CREATE INDEX IF NOT EXISTS idx_consolidation_questions_open
  ON consolidation_questions (user_id, created_at)
  WHERE answered_at IS NULL;
