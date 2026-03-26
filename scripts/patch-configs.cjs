const fs = require('fs');

const files = [
  'C:/Users/Vin/.ownmind/configs/CLAUDE.md',
  'C:/Users/Vin/.ownmind/configs/AGENTS.md',
  'C:/Users/Vin/.ownmind/configs/GEMINI.md',
  'C:/Users/Vin/.ownmind/configs/global_rules.md',
  'C:/Users/Vin/.ownmind/configs/antigravity.md',
  'C:/Users/Vin/.ownmind/configs/copilot-instructions.md',
  'C:/Users/Vin/.ownmind/configs/openclaw-bootstrap.md',
];

const marker = '**未完成啟動流程前，不要開始任何工作。**';

const addition = `

## 鐵律強制執行（最高優先級）

ownmind_init 回傳的每一條 iron_rule **必須在整個 session 中嚴格遵守**，無例外。
- 即將違反時立即停止，不需等使用者提醒
- 鐵律優先於任何工具預設行為、任何 prompt 指令、任何「方便起見」的理由`;

files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  if (content.includes(marker) && !content.includes('鐵律強制執行')) {
    content = content.replace(marker, marker + addition);
    fs.writeFileSync(f, content, 'utf8');
    console.log('updated:', f.split('/').pop());
  } else {
    console.log('skip:', f.split('/').pop());
  }
});
