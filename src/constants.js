/**
 * OwnMind shared constants
 * The DB CHECK constraint (memories_type_check) must stay in sync with this.
 */
export const SESSION_RETENTION_DAYS = 90;

export const ALLOWED_MEMORY_TYPES = [
  'profile',
  'principle',
  'iron_rule',
  'coding_standard',
  'team_standard',
  'project',
  'portfolio',
  'env',
  'session_log',
  'standard_detail',
];
