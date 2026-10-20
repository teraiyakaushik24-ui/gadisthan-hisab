const fs = require('fs');
const path = 'c:/Users/terai/.gemini/antigravity-ide/scratch/hisab-software/public/index.html';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (/main-view|view-admin|admin-panel|id="admin|id="view-admin|class="admin/i.test(line)) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
