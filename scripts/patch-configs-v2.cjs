const fs = require('fs');

const files = [
  'C:/Users/Vin/.ownmind/configs/CLAUDE.md',
  'C:/Users/Vin/.ownmind/configs/AGENTS.md',
  'C:/Users/Vin/.ownmind/configs/GEMINI.md',
  'C:/Users/Vin/.ownmind/configs/global_rules.md',
  'C:/Users/Vin/.ownmind/configs/antigravity.md',
  'C:/Users/Vin/.ownmind/configs/copilot-instructions.md',
  'C:/Users/Vin/.ownmind/configs/openclaw-bootstrap.md',
  'C:/Users/Vin/.ownmind/skills/ownmind-memory.md',
];

const addition = `
## 鐵律 Trigger 機制（強制）

iron_rule 的 tags 中若有 \`trigger:xxx\` 標記，代表執行該類操作前必須主動 re-check：
- 看到 \`trigger:git\` 或 \`trigger:commit\` → 執行任何 git 指令前先確認相關鐵律
- 看到 \`trigger:deploy\` → 部署前確認
- 看到 \`trigger:delete\` → 刪除操作前確認
- 看到 \`trigger:edit\` → 修改程式碼前確認

**流程：** 即將執行上述操作 → 心裡確認有無相關鐵律 → 有則遵守，無則繼續

## Periodic Re-check（強制）

以下任一條件成立時，主動呼叫 \`ownmind_get('iron_rule')\` 刷新鐵律記憶：
- 對話超過 20 輪
- 感覺 context 已消耗大量（長對話、大量程式碼）
- 即將執行不可逆操作（commit、deploy、刪除）

刷新後顯示：【OwnMind】鐵律重新確認，防護持續中。
`;

files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  if (!content.includes('Trigger 機制')) {
    content = content.trimEnd() + '\n' + addition;
    fs.writeFileSync(f, content, 'utf8');
    console.log('updated:', f.split('/').pop());
  } else {
    console.log('skip (already patched):', f.split('/').pop());
  }
});
