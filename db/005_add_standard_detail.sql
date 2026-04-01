-- OwnMind Database Migration
-- Migration: 005_add_standard_detail
-- Description: Add standard_detail type to memories table

-- Update the CHECK constraint to include standard_detail
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_type_check CHECK (type IN (
    'profile', 'principle', 'iron_rule', 'coding_standard',
    'team_standard', 'project', 'portfolio', 'env', 'session_log', 'standard_detail'
));
