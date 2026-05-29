# v1.20.3 — Task list

1. **Write shared/session-off-state.js helper**
   - Pure functions: read / write / clear / increment tick / isOffForSession / isOffForPreCommit
   - 24-hour expiry logic
   - Safeguards for corrupted file / missing directory
   - Paired with `tests/session-off-state.test.js`: 8+ guard cases

2. **Add two MCP tools to mcp/index.js**
   - `ownmind_session_off`: get session_id and write the state file
   - `ownmind_session_on`: delete the state file
   - Both tool calls return a Chinese ack + explain the next step

3. **Change hooks/ownmind-reply-lint.js**
   - At the start of main, read the state file; if this session is off:
     - increment tick_count
     - every 10 turns use writeToTty to write a reminder, fallback stderr
     - exit 0 to skip lint
   - New-session detection: if session_id does not match, clear the state file

4. **Change hooks/ownmind-git-pre-commit.js**
   - Read the state file at the start (pre-commit has no session_id, only checks whether off_at is within 24 hours)
   - If so → print a hint + exit 0
   - 24-hour expiry → clear the state file, run normally

5. **Slash command files**
   - `~/.claude/commands/ownmind-off.md`: guide the AI to call `ownmind_session_off`
   - `~/.claude/commands/ownmind-on.md`: guide the AI to call `ownmind_session_on`

6. **Version + docs**
   - package.json + client/package.json: 1.20.2 → 1.20.3
   - CHANGELOG.md add v1.20.3 entry
   - FILELIST.md add new files
   - Three README version markers v1.20.2 → v1.20.3

7. **Quality control + commit + push + sync local**
   - npm test all green
   - cp sync ~/.ownmind/
   - verification + code-review compliance records
   - commit + push
