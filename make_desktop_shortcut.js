const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const desktopDir = 'C:\\Users\\terai\\OneDrive\\Desktop';
const batPath = 'C:\\Users\\terai\\.gemini\\antigravity-ide\\scratch\\hisab-software\\Launch_HISAB.bat';
const lnkPath = path.join(desktopDir, 'HISAB PRO.lnk');

const vbsContent = [
  'Set ws = CreateObject("WScript.Shell")',
  `Set sc = ws.CreateShortcut("${lnkPath.replace(/\\/g, '\\\\')}")`,
  `sc.TargetPath = "${batPath.replace(/\\/g, '\\\\')}"`,
  `sc.WorkingDirectory = "${path.dirname(batPath).replace(/\\/g, '\\\\')}"`,
  'sc.Save'
].join('\r\n');

fs.writeFileSync('create_shortcut.vbs', vbsContent);
execSync('cscript //nologo create_shortcut.vbs');
fs.unlinkSync('create_shortcut.vbs');
console.log('SUCCESS: HISAB PRO shortcut created on Desktop at ' + lnkPath);
