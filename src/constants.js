/**
 * OwnMind 共用常數
 * DB CHECK constraint (memories_type_check) 必須與此同步
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
];
