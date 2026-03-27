-- OwnMind Database Migration
-- Migration: 002_add_team_standard
-- Description: Add team_standard type to memories table

-- Update the CHECK constraint to include team_standard
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_type_check CHECK (type IN (
    'profile', 'principle', 'iron_rule', 'coding_standard',
    'team_standard', 'project', 'portfolio', 'env', 'session_log'
));
