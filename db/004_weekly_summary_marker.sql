-- OwnMind Database Migration
-- Migration: 004_weekly_summary_marker
-- Description: Add weekly_summary_sent_at to users for per-user init marker

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS weekly_summary_sent_at TIMESTAMPTZ DEFAULT NULL;
