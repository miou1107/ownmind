-- OwnMind Database Schema
-- Migration: 001_init
-- Description: Initial schema with pgvector support

-- ============================================================
-- Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Tables
-- ============================================================

-- 1. users
CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    email       VARCHAR(255) UNIQUE NOT NULL,
    name        VARCHAR(255),
    api_key     VARCHAR(64) UNIQUE NOT NULL,
    role        VARCHAR(20) DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    settings    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 2. memories
CREATE TABLE memories (
    id              SERIAL PRIMARY KEY,
    user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(50) NOT NULL CHECK (type IN (
                        'profile', 'principle', 'iron_rule', 'coding_standard',
                        'project', 'portfolio', 'env', 'session_log'
                    )),
    title           VARCHAR(500) NOT NULL,
    content         TEXT NOT NULL,
    code            VARCHAR(20),
    status          VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    disabled_reason TEXT,
    disabled_at     TIMESTAMPTZ,
    tags            TEXT[] DEFAULT '{}',
    metadata        JSONB DEFAULT '{}',
    embedding       vector(1536),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 3. memory_history
CREATE TABLE memory_history (
    id          SERIAL PRIMARY KEY,
    memory_id   INT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    metadata    JSONB DEFAULT '{}',
    changed_by  VARCHAR(255),
    change_type VARCHAR(20) NOT NULL CHECK (change_type IN (
                    'create', 'update', 'disable', 'enable', 'revert'
                )),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 4. session_logs
CREATE TABLE session_logs (
    id            SERIAL PRIMARY KEY,
    user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id    VARCHAR(100),
    tool          VARCHAR(100),
    model         VARCHAR(100),
    machine       VARCHAR(255),
    summary       TEXT,
    details       JSONB DEFAULT '{}',
    compressed    BOOLEAN DEFAULT false,
    compressed_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 5. handoffs
CREATE TABLE handoffs (
    id           SERIAL PRIMARY KEY,
    user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project      VARCHAR(255),
    from_tool    VARCHAR(100),
    from_model   VARCHAR(100),
    from_machine VARCHAR(255),
    content      TEXT NOT NULL,
    status       VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    accepted_by  VARCHAR(100),
    accepted_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 6. secrets
CREATE TABLE secrets (
    id              SERIAL PRIMARY KEY,
    user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key             VARCHAR(255) NOT NULL,
    encrypted_value TEXT NOT NULL,
    description     VARCHAR(500),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, key)
);

-- ============================================================
-- Indexes
-- ============================================================

-- memories
CREATE INDEX idx_memories_user_id   ON memories (user_id);
CREATE INDEX idx_memories_type      ON memories (type);
CREATE INDEX idx_memories_status    ON memories (status);
CREATE INDEX idx_memories_tags      ON memories USING GIN (tags);
CREATE INDEX idx_memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops);

-- memory_history
CREATE INDEX idx_memory_history_memory_id ON memory_history (memory_id);

-- session_logs
CREATE INDEX idx_session_logs_user_id    ON session_logs (user_id);
CREATE INDEX idx_session_logs_created_at ON session_logs (created_at);
CREATE INDEX idx_session_logs_compressed ON session_logs (compressed);

-- handoffs
CREATE INDEX idx_handoffs_user_id ON handoffs (user_id);
CREATE INDEX idx_handoffs_status  ON handoffs (status);

-- secrets
CREATE INDEX idx_secrets_user_id ON secrets (user_id);
