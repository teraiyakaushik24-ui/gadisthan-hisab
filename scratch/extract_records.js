const fs = require('fs');

const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\r\n').length > 1 ? content.split('\r\n') : content.split('\n');

const idxStart = lines.findIndex(l => l.includes("// 6. Get all records summary"));
const idxEnd = lines.findIndex(l => l.includes("// UCHAK / ADVANCE & VOUCHER SETTLEMENT MANAGEMENT"));

console.log('idxStart (1-based):', idxStart + 1);
console.log('idxEnd (1-based):', idxEnd + 1);

const recordsRoutesCode = lines.slice(idxStart, idxEnd - 1).join('\n');

const moduleContent = `const xlsx = require('xlsx');

module.exports = function registerRecordsRoutes(app, deps) {
  const {
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
  } = deps;

${recordsRoutesCode}
};
`;

fs.writeFileSync('routes/records.js', moduleContent, 'utf8');
console.log('routes/records.js created successfully! Size:', fs.statSync('routes/records.js').size);
