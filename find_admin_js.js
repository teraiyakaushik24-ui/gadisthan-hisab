const fs = require('fs');
const content = fs.readFileSync('c:/Users/terai/.gemini/antigravity-ide/scratch/hisab-software/public/js/app.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('btn-admin-panel') || line.includes('openAdmin') || line.includes('AdminPin') || line.includes('modal-admin')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
