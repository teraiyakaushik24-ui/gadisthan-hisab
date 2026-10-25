const fs = require('fs');

const original = fs.readFileSync('server.js', 'utf8');
fs.writeFileSync('server.js.bak_rec', original, 'utf8');

const lines = original.split('\r\n').length > 1 ? original.split('\r\n') : original.split('\n');

// 1. Add import
const empImportIdx = lines.findIndex(l => l.includes("const registerEmployeeRoutes = require('./routes/employees');"));
lines.splice(empImportIdx + 1, 0, "const registerRecordsRoutes = require('./routes/records');");

// 2. Remove the records section: from idxStart to idxEnd
const idxStart = lines.findIndex(l => l.includes("// 6. Get all records summary"));
const idxEnd = lines.findIndex(l => l.includes("// UCHAK / ADVANCE & VOUCHER SETTLEMENT MANAGEMENT"));

console.log('Removing records section from line', idxStart + 1, 'to', idxEnd);
lines.splice(idxStart, idxEnd - idxStart);

// 3. Register registerRecordsRoutes right after registerEmployeeRoutes call
const empCallEnd = lines.findIndex(l => l.includes("registerEmployeeRoutes(app, {"));
let empCallEndIdx = -1;
for (let i = empCallEnd; i < lines.length; i++) {
  if (lines[i].trim() === '});') {
    empCallEndIdx = i;
    break;
  }
}

const recCallSnippet = `
// Register modular Daily Records & Expense routes
registerRecordsRoutes(app, {
  getRecords,
  saveRecords,
  getSettings,
  saveSettings,
  getEmployees,
  saveEmployees,
  getUchakRecords,
  saveUchakRecords,
  getBankDeposits,
  getBhaktDeposits,
  getTodayDateStr,
  getTodayTimeStr,
  isValidAdminSession,
  isSameKhata,
  getGujaratiKhataName,
  getGujaratiMonthLabel,
  createBlankRecord,
  logAdminActivity
});
`;

lines.splice(empCallEndIdx + 1, 0, recCallSnippet);

fs.writeFileSync('server.js', lines.join('\n'), 'utf8');
console.log('server.js refactored for records successfully! New line count:', lines.length);
