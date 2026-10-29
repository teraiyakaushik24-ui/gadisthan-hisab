const xlsx = require('xlsx');

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
    logAdminActivity,
    getAuthUser
  } = deps;

// 6. Get all records summary
app.get('/api/records', (req, res) => {
  const authUser = (typeof getAuthUser === 'function') ? getAuthUser(req) : null;
  const userRole = (authUser && authUser.role) || req.headers['x-user-role'];
  const settings = getSettings();
  const rolePerms = (settings && settings.rolePermissions) || {};
  const userPerms = (userRole && rolePerms[userRole]) || {};
  const histPerm = userPerms.historyLedger || (userPerms.dailyHisab === 'hidden' ? 'hidden' : 'full');
  if (userRole && userRole !== 'admin' && histPerm === 'hidden') {
    return res.status(403).json({ success: false, error: 'ઍક્સેસ નકારવામાં આવ્યો! આ આઈડી માટે પાછલા હિસાબનો ઇતિહાસ જોવાની પરવાનગી નથી.' });
  }

  const records = getRecords();
  const summaryList = Object.keys(records).map(date => {
    const r = records[date];
    return {
      date,
      notes: r.notes || [],
      cashTotal: r.cashTotal || 0,
      bankTotal: r.bankTotal || 0,
      voucherTotal: r.voucherTotal || 0,
      grandTotal: r.grandTotal || 0,
      noteCountTotal: r.noteCountTotal || 0,
      banksCount: (r.banks || []).length,
      vouchersCount: (r.vouchers || []).length,
      updatedAt: r.updatedAt || date
    };
  }).sort((a, b) => b.date.localeCompare(a.date));

  res.json(summaryList);
});

// 6.5. Get Analytics Aggregations for visual charts
app.get('/api/analytics', (req, res) => {
  const { date, range, from, to } = req.query;
  const records = getRecords();
  const settings = getSettings();
  const baseDate = date || getTodayDateStr();

  let startDate = baseDate;
  let endDate = baseDate;

  if (from && to) {
    startDate = from;
    endDate = to;
  } else if (range === '7days') {
    const endD = new Date(baseDate);
    const startD = new Date(baseDate);
    startD.setDate(startD.getDate() - 6);
    startDate = startD.toISOString().split('T')[0];
    endDate = endD.toISOString().split('T')[0];
  } else if (range === 'month') {
    const [y, m] = baseDate.split('-');
    startDate = `${y}-${m}-01`;
    const lastDay = new Date(Number(y), Number(m), 0).getDate();
    endDate = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
  } else {
    // default 'today'
    startDate = baseDate;
    endDate = baseDate;
  }

  // Filter matching records
  const matchingDates = Object.keys(records)
    .filter(d => d >= startDate && d <= endDate)
    .sort();

  let totalCash = 0;
  let totalBank = 0;
  let totalVouchers = 0;
  const noteMap = {};
  const bankMap = {};
  const voucherMap = {};
  const dailyTrend = [];

  const defaultNotes = settings.notes || [500, 200, 100, 50, 20, 10];
  defaultNotes.forEach(n => { noteMap[n] = { note: n, count: 0, amount: 0 }; });

  matchingDates.forEach(d => {
    const r = records[d];
    const cTotal = Number(r.cashTotal) || 0;
    const bTotal = Number(r.bankTotal) || 0;
    const vTotal = Number(r.voucherTotal) || 0;
    const gTotal = Number(r.grandTotal) || (cTotal + bTotal + vTotal);

    totalCash += cTotal;
    totalBank += bTotal;
    totalVouchers += vTotal;

    // notes
    (r.notes || []).forEach(n => {
      const val = Number(n.note);
      if (!noteMap[val]) noteMap[val] = { note: val, count: 0, amount: 0 };
      noteMap[val].count += (Number(n.count) || 0);
      noteMap[val].amount += (Number(n.amount) || 0);
    });

    // banks
    (r.banks || []).forEach(b => {
      const bName = (b.name || '').trim();
      if (bName) {
        if (!bankMap[bName]) bankMap[bName] = { name: bName, amount: 0 };
        bankMap[bName].amount += (Number(b.amount) || 0);
      }
    });

    // vouchers
    (r.vouchers || []).forEach(v => {
      const vName = (v.name || '').trim();
      if (vName) {
        if (!voucherMap[vName]) voucherMap[vName] = { name: vName, amount: 0 };
        voucherMap[vName].amount += (Number(v.amount) || 0);
      }
    });

    dailyTrend.push({
      date: d,
      cashTotal: cTotal,
      bankTotal: bTotal,
      voucherTotal: vTotal,
      grandTotal: gTotal
    });
  });

  const grandTotal = totalCash + totalBank + totalVouchers;

  res.json({
    success: true,
    range: range || 'today',
    startDate,
    endDate,
    recordCount: matchingDates.length,
    totalCash,
    totalBank,
    totalVouchers,
    grandTotal,
    noteTotals: Object.values(noteMap).sort((a, b) => b.note - a.note),
    bankTotals: Object.values(bankMap).sort((a, b) => b.amount - a.amount),
    voucherTotals: Object.values(voucherMap).sort((a, b) => b.amount - a.amount),
    dailyTrend
  });
});

// 7. Get record by date (or blank template based on current settings)
app.get('/api/records/:date', (req, res) => {
  const { date } = req.params;
  const records = getRecords();
  const settings = getSettings();

  const noteList = settings.notes || [500, 200, 100, 50, 20, 10];
  const bankList = settings.defaultBanks || ['IOB TRF', 'BOB TRF ', 'SBI TRF'];
  const voucherList = settings.defaultVouchers || ['MANDIRKHARCH', 'RASODAKHARCH', 'PAGAR'];

  if (records[date]) {
    const rec = records[date];
    // Map with configured master items
    const noteMap = {};
    (rec.notes || []).forEach(n => { noteMap[n.note] = n; });
    const notes = noteList.map(val => ({
      note: val,
      count: noteMap[val] ? noteMap[val].count : 0,
      amount: noteMap[val] ? noteMap[val].amount : 0
    }));

    const bankMap = {};
    const extraBanks = [];
    (rec.banks || []).forEach(b => {
      const bName = (b.name || '').trim();
      bankMap[bName.toUpperCase()] = b.amount;
      if (!bankList.some(master => master.trim().toUpperCase() === bName.toUpperCase())) {
        extraBanks.push({ name: bName, amount: Number(b.amount) || 0 });
      }
    });
    const banks = [
      ...bankList.map(name => ({
        name,
        amount: bankMap[name.trim().toUpperCase()] !== undefined ? bankMap[name.trim().toUpperCase()] : 0
      })),
      ...extraBanks
    ];

    const extraVouchers = [];
    (rec.vouchers || []).forEach(v => {
      const vName = (v.name || '').trim();
      if (!vName) return;
      if (!voucherList.some(master => isSameKhata(master, vName))) {
        const existing = extraVouchers.find(e => isSameKhata(e.name, vName));
        if (existing) {
          existing.amount = (Number(existing.amount) || 0) + (Number(v.amount) || 0);
        } else {
          extraVouchers.push({ name: vName, amount: Number(v.amount) || 0 });
        }
      }
    });
    const vouchers = [
      ...voucherList.map(masterName => {
        const matching = (rec.vouchers || []).filter(v => v && isSameKhata(v.name, masterName));
        const totalAmt = matching.reduce((sum, v) => sum + (Number(v.amount) || 0), 0);
        return {
          name: masterName,
          amount: totalAmt
        };
      }),
      ...extraVouchers
    ];

    const cashTotal = notes.reduce((s, n) => s + n.amount, 0);
    const bankTotal = banks.reduce((s, b) => s + b.amount, 0);
    const voucherTotal = vouchers.reduce((s, v) => s + v.amount, 0);

    return res.json({
      ...rec,
      expenseItems: rec.expenseItems || [],
      notes,
      cashTotal,
      noteCountTotal: notes.reduce((s, n) => s + n.count, 0),
      banks,
      bankTotal,
      vouchers,
      voucherTotal,
      grandTotal: cashTotal + bankTotal + voucherTotal
    });
  }

  // Generate blank template for this date
  const blankTemplate = {
    date,
    expenseItems: [],
    notes: noteList.map(note => ({ note, count: 0, amount: 0 })),
    cashTotal: 0,
    banks: bankList.map(name => ({ name, amount: 0 })),
    bankTotal: 0,
    vouchers: voucherList.map(name => ({ name, amount: 0 })),
    voucherTotal: 0,
    grandTotal: 0,
    noteCountTotal: 0,
    remarks: '',
    updatedAt: new Date().toISOString(),
    isNew: true
  };

  res.json(blankTemplate);
});

// 8. Save record by date (Past dates are strictly locked and cannot be edited)
app.post('/api/records/:date', (req, res) => {
  const { date } = req.params;
  const today = getTodayDateStr();

  const isPast = (date < today);
  if (isPast) {
    return res.status(403).json({
      success: false,
      error: 'પાછલી તારીખનો હિસાબ લૉક થયેલ છે! તેમાં ફેરફાર કરી શકાતો નથી.'
    });
  }

  // Role Permissions Enforcement Check
  const authUser = (typeof getAuthUser === 'function') ? getAuthUser(req) : null;
  const userRole = (authUser && authUser.role) || req.headers['x-user-role'];
  const settings = getSettings();
  const rolePerms = (settings && settings.rolePermissions) || {};
  if (userRole && rolePerms[userRole]) {
    const perm = rolePerms[userRole].dailyHisab;
    if (perm === 'readonly' || perm === 'hidden') {
      return res.status(403).json({
        success: false,
        error: 'ઍક્સેસ નકારવામાં આવ્યો! આ આઈડી માટે દૈનિક હિસાબ ફક્ત વાંચવા માટે (Read-Only Mode) છે.'
      });
    }
  }

  const data = req.body;
  const records = getRecords();
  const prevRecord = records[date] ? JSON.parse(JSON.stringify(records[date])) : null;

  // Validate negative values: negative counts or amounts are strictly prohibited in accounting
  const hasNegativeNote = (data.notes || []).some(n => Number(n.count) < 0 || Number(n.amount) < 0);
  const hasNegativeBank = (data.banks || []).some(b => Number(b.amount) < 0);
  const hasNegativeVoucher = (data.vouchers || []).some(v => Number(v.amount) < 0);
  if (hasNegativeNote || hasNegativeBank || hasNegativeVoucher) {
    return res.status(400).json({ error: 'ઋણ (Negative) રકમ અથવા નોટોની સંખ્યા માન્ય નથી!' });
  }

  const notes = (data.notes || []).map(n => ({
    note: Number(n.note) || 0,
    count: Math.max(0, parseInt(n.count, 10) || 0),
    amount: (Number(n.note) || 0) * Math.max(0, parseInt(n.count, 10) || 0)
  }));
  const cashTotal = notes.reduce((s, n) => s + n.amount, 0);
  const noteCountTotal = notes.reduce((s, n) => s + n.count, 0);

  const banks = (data.banks || []).map(b => ({
    name: String(b.name || '').trim(),
    amount: Number(b.amount) || 0
  }));
  const bankTotal = banks.reduce((s, b) => s + b.amount, 0);

  // Deduplicate and aggregate incoming vouchers by isSameKhata
  const rawVouchers = (data.vouchers || []).map(v => ({
    name: String(v.name || '').trim(),
    amount: Number(v.amount) || 0
  })).filter(v => v.name);

  const deduplicatedVouchers = [];
  rawVouchers.forEach(v => {
    const existing = deduplicatedVouchers.find(d => isSameKhata(d.name, v.name));
    if (existing) {
      existing.amount = (Number(existing.amount) || 0) + (Number(v.amount) || 0);
    } else {
      deduplicatedVouchers.push({ name: v.name, amount: Number(v.amount) || 0 });
    }
  });

  const vouchers = deduplicatedVouchers;
  const voucherTotal = vouchers.reduce((s, v) => s + v.amount, 0);

  const grandTotal = cashTotal + bankTotal + voucherTotal;

  const record = {
    date,
    notes,
    cashTotal,
    noteCountTotal,
    banks,
    bankTotal,
    vouchers,
    voucherTotal,
    grandTotal,
    expenseItems: Array.isArray(data.expenseItems) ? data.expenseItems : [],
    remarks: data.remarks || '',
    updatedAt: new Date().toISOString()
  };

  records[date] = record;
  saveRecords(records);

  // Auto-reconcile Employee ledger (Pagar & Upad) for this date
  let empModified = false;
  try {
    const employees = getEmployees();
    const currentItems = record.expenseItems || [];
    const pagarVoucher = (record.vouchers || []).find(v => (v.name || '').trim().toUpperCase() === 'PAGAR');
    const pagarVoucherAmt = pagarVoucher ? Number(pagarVoucher.amount) || 0 : 0;
    const upadVoucher = (record.vouchers || []).find(v => (v.name || '').trim().toUpperCase() === 'UPAD');
    const upadVoucherAmt = upadVoucher ? Number(upadVoucher.amount) || 0 : 0;

    employees.forEach(emp => {
      // 1. Reconcile pagars on this date
      if (Array.isArray(emp.pagars)) {
        const initialPagarCount = emp.pagars.length;
        emp.pagars = emp.pagars.filter(p => {
          if (p.date !== date) return true; // keep transactions of other dates
          // If PAGAR voucher is 0 and no PAGAR expenseItems exist, clean up
          if (pagarVoucherAmt === 0 && !currentItems.some(it => (it.category || '').toUpperCase().includes('PAGAR'))) {
            return false;
          }
          // If there are expense items, check if this pagar is still present in expenseItems
          const stillInExpenses = currentItems.some(it => 
            (it.employeeId === emp.id || it.employeeName === emp.name) &&
            (it.employeeEntryId === p.id || it.id === p.expenseItemId || it.id === ('exp_' + p.id) || (Number(it.amount) === Number(p.amount) && (it.category || '').toUpperCase().includes('PAGAR')))
          );
          return stillInExpenses;
        });
        if (emp.pagars.length !== initialPagarCount) empModified = true;
      }

      // 2. Reconcile upads on this date
      if (Array.isArray(emp.upads)) {
        const initialUpadCount = emp.upads.length;
        emp.upads = emp.upads.filter(u => {
          if (u.date !== date) return true; // keep transactions of other dates
          // If UPAD voucher is 0 and no UPAD expenseItems exist, clean up
          if (upadVoucherAmt === 0 && !currentItems.some(it => (it.category || '').toUpperCase().includes('UPAD'))) {
            return false;
          }
          // If there are expense items, check if this upad is still present in expenseItems
          const stillInExpenses = currentItems.some(it => 
            (it.employeeId === emp.id || it.employeeName === emp.name) &&
            (it.employeeEntryId === u.id || it.id === u.expenseItemId || it.id === ('exp_' + u.id) || (Number(it.amount) === Number(u.amount) && (it.category || '').toUpperCase().includes('UPAD')))
          );
          return stillInExpenses;
        });
        if (emp.upads.length !== initialUpadCount) empModified = true;
      }
    });

    if (empModified) {
      saveEmployees(employees);
    }
  } catch (err) {
    console.error('Error auto-reconciling employees on record save:', err);
  }

  if (isPast || isValidAdminSession(req)) {
    const hisabChanges = [];
    if (prevRecord) {
      if ((prevRecord.cashTotal || 0) !== cashTotal) {
        hisabChanges.push({ field: 'રોકડ રકમ (Cash Total)', before: '₹' + (prevRecord.cashTotal || 0).toLocaleString('en-IN'), after: '₹' + cashTotal.toLocaleString('en-IN') });
      }
      if ((prevRecord.bankTotal || 0) !== bankTotal) {
        hisabChanges.push({ field: 'બેંક જમા (Bank Total)', before: '₹' + (prevRecord.bankTotal || 0).toLocaleString('en-IN'), after: '₹' + bankTotal.toLocaleString('en-IN') });
      }
      if ((prevRecord.voucherTotal || 0) !== voucherTotal) {
        hisabChanges.push({ field: 'વાઉચર ખર્ચ (Voucher Total)', before: '₹' + (prevRecord.voucherTotal || 0).toLocaleString('en-IN'), after: '₹' + voucherTotal.toLocaleString('en-IN') });
      }
      if ((prevRecord.grandTotal || 0) !== grandTotal) {
        hisabChanges.push({ field: 'કુલ હિસાબ (Grand Total)', before: '₹' + (prevRecord.grandTotal || 0).toLocaleString('en-IN'), after: '₹' + grandTotal.toLocaleString('en-IN') });
      }
    }
    if (hisabChanges.length === 0) {
      hisabChanges.push({ field: 'કુલ હિસાબ (Grand Total)', before: prevRecord ? ('₹' + (prevRecord.grandTotal || 0).toLocaleString('en-IN')) : 'નવો હિસાબ', after: '₹' + grandTotal.toLocaleString('en-IN') });
    }

    logAdminActivity(
      'HISAB_UPDATE',
      'HISAB',
      `તારીખ ${date} નો હિસાબ સાચવ્યો`,
      `Updated Hisab for ${date}`,
      `કુલ રકમ: ₹${grandTotal.toLocaleString('en-IN')} (રોકડ: ₹${cashTotal}, બેંક: ₹${bankTotal}, વાઉચર: ₹${voucherTotal})`,
      `Total: ₹${grandTotal.toLocaleString('en-IN')} (Cash: ₹${cashTotal}, Bank: ₹${bankTotal}, Voucher: ₹${voucherTotal})`,
      'info',
      req,
      {
        type: 'HISAB_UPDATE',
        date,
        changes: hisabChanges
      }
    );
  }

  res.json({ success: true, record, employeesUpdated: empModified });
});

// 9. Delete record (Protected - permanent financial audit trail)
app.delete('/api/records/:date', (req, res) => {
  return res.status(403).json({
    error: 'રેકોર્ડ ડિલીટ કરી શકાતો નથી.'
  });
});

function getCanonicalExpenseCategory(name) {
  if (!name) return 'પરચૂરણ ખર્ચ';
  const trimmed = String(name).trim();
  const upper = trimmed.toUpperCase();
  if (['MANDIRKHARCH', 'MANDIR KHARCH', 'MANDIR_KHARCH', 'MANDIR', 'TEMPLE', 'મંદિર ખર્ચ', 'મંદિર'].includes(upper) || trimmed === 'મંદિર ખર્ચ') return 'મંદિર ખર્ચ';
  if (['RASODAKHARCH', 'RASODA KHARCH', 'RASODA_KHARCH', 'RASODA', 'KITCHEN', 'રસોડા ખર્ચ', 'રસોડું'].includes(upper) || trimmed === 'રસોડા ખર્ચ') return 'રસોડા ખર્ચ';
  if (['PAGAR', 'PAGARKHARCH', 'PAGAR KHARCH', 'SALARY', 'પગાર', 'પગાર ખર્ચ'].includes(upper) || trimmed === 'પગાર') return 'પગાર';
  if (['UPAD', 'ADVANCE', 'ઉપાડ'].includes(upper) || trimmed === 'ઉપાડ') return 'ઉપાડ';
  if (['GAUSHALA', 'GAUSALA', 'GOSHALA', 'ગૌશાળા', 'ગૌશાળા ખર્ચ'].includes(upper) || trimmed.includes('ગૌશાળા')) return 'ગૌશાળા ખર્ચ';
  if (['HINDOLA KHARCH', 'HINDOLAKHARCH', 'HILDOLAKHARCH', 'HINDOLA', 'હિંડોળા ખર્ચ', 'હિંડોળા'].includes(upper) || trimmed.includes('હિંડોળા')) return 'હિંડોળા ખર્ચ';
  if (['BIJLI BILL', 'BIJLIBILL', 'LIGHT BILL', 'LIGHTBILL', 'ELECTRICITY', 'વીજળી બિલ', 'લાઈટ બિલ'].includes(upper) || trimmed.includes('વીજળી') || trimmed.includes('લાઈટ')) return 'વીજળી બિલ';
  if (['PETROL', 'PETROL KHARCH', 'પેટ્રોલ ખર્ચ', 'પેટ્રોલ'].includes(upper)) return 'પેટ્રોલ ખર્ચ';
  if (['DUDH', 'DUDH KHARCH', 'દૂધ', 'દૂધ ખર્ચ'].includes(upper)) return 'દૂધ ખર્ચ';
  if (['CHAI', 'CHAI NASTA', 'ચા', 'ચા-નાસ્તો'].includes(upper)) return 'ચા-નાસ્તો';
  if (typeof getGujaratiKhataName === 'function') {
    const gName = getGujaratiKhataName(trimmed);
    if (gName) return gName;
  }
  return trimmed;
}

// 9b. Get Expenses Report (Date to Date Filter & Analytics)
app.get('/api/expenses/report', (req, res) => {
  const { from, to, category } = req.query;
  const records = getRecords();
  const allDates = Object.keys(records).sort();

  let fromDate = from || (allDates.length > 0 ? allDates[0] : getTodayDateStr());
  let toDate = to || getTodayDateStr();

  // Edge case: if fromDate > toDate, swap them
  if (fromDate > toDate) {
    const temp = fromDate;
    fromDate = toDate;
    toDate = temp;
  }

  const filteredDates = allDates.filter(d => d >= fromDate && d <= toDate);
  const selectedCanonCat = (!category || category === 'all') ? null : getCanonicalExpenseCategory(category);

  let allExpenses = [];
  const categoryTotals = {};

  filteredDates.forEach(date => {
    const rec = records[date];
    const diaryItems = rec.expenseItems || [];
    const diaryCategories = new Set(diaryItems.map(item => getCanonicalExpenseCategory(item.category)));

    // 1. Process all granular diary items
    diaryItems.forEach(item => {
      const amt = Number(item.amount) || 0;
      if (amt > 0) {
        const canonCat = getCanonicalExpenseCategory(item.category);
        if (!selectedCanonCat || canonCat === selectedCanonCat) {
          allExpenses.push({
            id: item.id || `exp_${date}_${Math.random()}`,
            date,
            time: item.time || '',
            title: item.title,
            category: canonCat,
            categoryType: item.categoryType || 'voucher',
            amount: amt,
            remarks: item.remarks || ''
          });
          categoryTotals[canonCat] = (categoryTotals[canonCat] || 0) + amt;
        }
      }
    });

    // 2. Process vouchers for categories not itemized in diary on this date
    (rec.vouchers || []).forEach(v => {
      const amt = Number(v.amount) || 0;
      if (amt > 0) {
        const canonCat = getCanonicalExpenseCategory(v.name);
        if (!diaryCategories.has(canonCat)) {
          if (!selectedCanonCat || canonCat === selectedCanonCat) {
            allExpenses.push({
              id: `vouch_${date}_${v.name}`,
              date,
              time: '',
              title: `${canonCat} (વાઉચર હિસાબ)`,
              category: canonCat,
              categoryType: 'voucher',
              amount: amt,
              remarks: 'દૈનિક વાઉચર એન્ટ્રી'
            });
            categoryTotals[canonCat] = (categoryTotals[canonCat] || 0) + amt;
          }
        }
      }
    });
  });

  // Sort descending by date, then time
  allExpenses.sort((a, b) => b.date.localeCompare(a.date));

  const grandTotal = allExpenses.reduce((s, x) => s + x.amount, 0);
  const daysCount = Math.max(1, filteredDates.length);
  const dailyAverage = Math.round(grandTotal / daysCount);

  // Find highest spending category
  let highestCategory = { name: '-', amount: 0 };
  Object.keys(categoryTotals).forEach(cat => {
    if (categoryTotals[cat] > highestCategory.amount) {
      highestCategory = { name: cat, amount: categoryTotals[cat] };
    }
  });

  res.json({
    fromDate,
    toDate,
    daysCount,
    totalEntries: allExpenses.length,
    grandTotal,
    dailyAverage,
    highestCategory,
    categoryTotals,
    expenses: allExpenses
  });
});

// 9b-2. Get Unique Expense Names / Person Names for Autocomplete Suggestions
app.get('/api/expenses/names', (req, res) => {
  try {
    const records = getRecords();
    const namesSet = new Set();
    Object.values(records).forEach(rec => {
      (rec.expenseItems || []).forEach(item => {
        if (item.remarks && typeof item.remarks === 'string') {
          const trimmed = item.remarks.trim();
          if (trimmed && trimmed !== '-' && !trimmed.startsWith('વાઉચર હિસાબ') && !trimmed.includes('નક્કી પગાર') && !trimmed.includes('હપ્તો પતાવટ') && trimmed.length < 40) {
            namesSet.add(trimmed);
          }
        }
      });
    });
    const list = Array.from(namesSet).sort((a, b) => a.localeCompare(b, 'gu'));
    res.json({ success: true, names: list });
  } catch (e) {
    res.json({ success: true, names: [] });
  }
});

// 9c. Comprehensive Analytics & Chart Data Endpoint
app.get('/api/analytics', (req, res) => {
  const { from, to, date } = req.query;
  const records = getRecords();
  const allDates = Object.keys(records).sort();

  let targetDates = [];
  if (date) {
    targetDates = [date];
  } else if (from && to) {
    targetDates = allDates.filter(d => d >= from && d <= to);
  } else {
    // Default to all available dates (e.g. September 2026)
    targetDates = allDates;
  }

  let totalCash = 0;
  let totalBank = 0;
  let totalVouchers = 0;
  let totalGrand = 0;
  let totalNotesCount = 0;

  const noteTotals = {
    500: { count: 0, amount: 0 },
    200: { count: 0, amount: 0 },
    100: { count: 0, amount: 0 },
    50: { count: 0, amount: 0 },
    20: { count: 0, amount: 0 },
    10: { count: 0, amount: 0 }
  };
  const bankTotals = {};
  const categoryTotals = {};
  const dailyTrend = [];

  targetDates.forEach(d => {
    const r = records[d] || { cashTotal: 0, bankTotal: 0, voucherTotal: 0, grandTotal: 0 };
    totalCash += Number(r.cashTotal) || 0;
    totalBank += Number(r.bankTotal) || 0;
    totalVouchers += Number(r.voucherTotal) || 0;
    totalGrand += Number(r.grandTotal) || 0;
    totalNotesCount += Number(r.noteCountTotal) || 0;

    (r.notes || []).forEach(n => {
      if (noteTotals[n.note]) {
        noteTotals[n.note].count += Number(n.count) || 0;
        noteTotals[n.note].amount += Number(n.amount) || 0;
      }
    });

    (r.banks || []).forEach(b => {
      bankTotals[b.name] = (bankTotals[b.name] || 0) + (Number(b.amount) || 0);
    });

    (r.vouchers || []).forEach(v => {
      categoryTotals[v.name] = (categoryTotals[v.name] || 0) + (Number(v.amount) || 0);
    });

    dailyTrend.push({
      date: d,
      cashTotal: Number(r.cashTotal) || 0,
      bankTotal: Number(r.bankTotal) || 0,
      voucherTotal: Number(r.voucherTotal) || 0,
      grandTotal: Number(r.grandTotal) || 0
    });
  });

  res.json({
    success: true,
    daysCount: targetDates.length,
    fromDate: targetDates[0] || '',
    toDate: targetDates[targetDates.length - 1] || '',
    totalCash,
    totalBank,
    totalVouchers,
    totalGrand,
    totalNotesCount,
    noteTotals,
    bankTotals,
    categoryTotals,
    dailyTrend
  });
});

// 9d. Export Filtered Expenses to Excel (.xlsx)
app.get('/api/export/expenses-excel', (req, res) => {
  const { from, to, category } = req.query;
  const records = getRecords();
  const allDates = Object.keys(records).sort();

  const fromDate = from || (allDates.length > 0 ? allDates[0] : getTodayDateStr());
  const toDate = to || getTodayDateStr();

  const filteredDates = allDates.filter(d => d >= fromDate && d <= toDate);
  const selectedCanonCat = (!category || category === 'all') ? null : getCanonicalExpenseCategory(category);
  const settings = getSettings();

  const rows = [];
  rows.push([settings.orgName || 'સંસ્થાન', '', '', '', '']);
  rows.push([`તારીખવાર ખર્ચ હિસાબ રિપોર્ટ: ${fromDate} થી ${toDate}`, '', '', '', '']);
  rows.push(['']);
  rows.push(['ક્રમ', 'તારીખ', 'રકમ (₹)', 'ખર્ચ વિગત', 'ખાતો / મદ', 'સમય', 'નોંધ']);

  let grandTotal = 0;
  let idx = 1;

  filteredDates.forEach(date => {
    const rec = records[date];
    const diaryItems = rec.expenseItems || [];

    const diaryCategories = new Set(diaryItems.map(item => getCanonicalExpenseCategory(item.category)));

    diaryItems.forEach(item => {
      const amt = Number(item.amount) || 0;
      if (amt > 0) {
        const canonCat = getCanonicalExpenseCategory(item.category);
        if (!selectedCanonCat || canonCat === selectedCanonCat) {
          grandTotal += amt;
          rows.push([idx++, date, amt, item.title, canonCat, item.time || '', item.remarks || '']);
        }
      }
    });

    (rec.vouchers || []).forEach(v => {
      const amt = Number(v.amount) || 0;
      if (amt > 0) {
        const canonCat = getCanonicalExpenseCategory(v.name);
        if (!diaryCategories.has(canonCat)) {
          if (!selectedCanonCat || canonCat === selectedCanonCat) {
            grandTotal += amt;
            rows.push([idx++, date, amt, `${canonCat} (વાઉચર હિસાબ)`, canonCat, '', 'દૈનિક વાઉચર એન્ટ્રી']);
          }
        }
      }
    });
  });

  rows.push(['']);
  rows.push(['', '', grandTotal, 'કુલ ખર્ચનો મહાસરવાળો (GRAND TOTAL)', '', '', '']);

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(rows);

  ws['!cols'] = [
    { wch: 6 },
    { wch: 14 },
    { wch: 16 },
    { wch: 34 },
    { wch: 22 },
    { wch: 12 },
    { wch: 25 }
  ];

  xlsx.utils.book_append_sheet(wb, ws, 'Expense_Report');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', `attachment; filename=Expense_Report_${fromDate}_to_${toDate}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// 9e. Export Accounting History to Excel (.xlsx)
app.get('/api/export/history-excel', (req, res) => {
  const { month, fy, mode, startDate, endDate } = req.query;
  const records = getRecords();
  const allDates = Object.keys(records).sort();
  const settings = getSettings();

  let targetDates = allDates;
  let reportLabel = 'તમામ ઇતિહાસ હિસાબ';

  if (startDate || endDate) {
    targetDates = allDates.filter(d => {
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    });
    reportLabel = `${startDate || 'શરૂઆત'} થી ${endDate || 'અંતિમ'} નો હિસાબ`;
  } else if (month) {
    targetDates = allDates.filter(d => d.startsWith(month));
    reportLabel = `${getGujaratiMonthLabel(month)} માસનો હિસાબ`;
  } else if (fy && fy !== 'all') {
    const [fyStart, fyEnd] = fy.split('-').map(Number);
    const minD = `${fyStart}-04-01`;
    const maxD = `${fyEnd}-03-31`;
    targetDates = allDates.filter(d => d >= minD && d <= maxD);
    reportLabel = `નાણાકીય વર્ષ ${fy} હિસાબ`;
  }

  const isCashMode = mode === 'cash';
  const rows = [];
  rows.push([settings.orgName || 'સંસ્થાન હિસાબ', '', '', '', '', '', '']);
  rows.push([`દૈનિક રોકડ, બેંક અને વાઉચર હિસાબ પત્રક - ${reportLabel}`, '', '', '', '', '', '']);
  rows.push(['']);

  let totCash = 0;
  let totBank = 0;
  let totVoucher = 0;
  let totGrand = 0;
  let totNotes = 0;
  let tot500 = 0, tot200 = 0, tot100 = 0, tot50 = 0, tot20 = 0, tot10 = 0;

  const allDeposits = getBankDeposits();
  let totDeposited = 0;

  if (isCashMode) {
    rows.push(['ક્રમ', 'તારીખ', '₹ 500', '₹ 200', '₹ 100', '₹ 50', '₹ 20', '₹ 10/સિક્કા', 'કુલ નોટો', 'કુલ રોકડ (₹)', 'બેંકમાં જમા રોકડ વિગત']);
    targetDates.forEach((date, i) => {
      const rec = records[date];
      const notes = rec.notes || [];
      const getC = (v) => {
        const found = notes.find(n => Number(n.note) === v);
        return found ? found.count : 0;
      };
      const c500 = getC(500), c200 = getC(200), c100 = getC(100), c50 = getC(50), c20 = getC(20), c10 = getC(10);
      const nCount = rec.noteCountTotal || (c500 + c200 + c100 + c50 + c20 + c10);
      const cAmt = Number(rec.cashTotal) || 0;

      tot500 += c500; tot200 += c200; tot100 += c100; tot50 += c50; tot20 += c20; tot10 += c10;
      totNotes += nCount;
      totCash += cAmt;

      const depList = allDeposits.filter(d => d.depositDate === date);
      let depText = '-';
      if (depList.length > 0) {
        depText = depList.map(d => `${d.bankName || 'બેંક'}: ₹${Number(d.amount).toLocaleString('en-IN')} (${d.fromDate} થી ${d.toDate} - ${d.daysCount || '-'} દિવસ)`).join(' | ');
        depList.forEach(d => { totDeposited += Number(d.amount) || 0; });
      }

      rows.push([i + 1, date, c500, c200, c100, c50, c20, c10, nCount, cAmt, depText]);
    });

    rows.push(['']);
    rows.push(['', 'કુલ સરવાળો', tot500, tot200, tot100, tot50, tot20, tot10, totNotes, totCash, `કુલ બેંક જમા: ₹${totDeposited.toLocaleString('en-IN')}`]);
  } else {
    rows.push(['ક્રમ', 'તારીખ', 'રોકડ રકમ (₹)', 'બેંક ટ્રાન્સફર (₹)', 'વાઉચર ખર્ચ (₹)', 'બેંકમાં જમા રોકડ વિગત (કઈ બેંક & ગાળો)', 'કુલ સરવાળો (₹)']);
    targetDates.forEach((date, i) => {
      const rec = records[date];
      const cAmt = Number(rec.cashTotal) || 0;
      const bAmt = Number(rec.bankTotal) || 0;
      const vAmt = Number(rec.voucherTotal) || 0;
      const gAmt = Number(rec.grandTotal) || (cAmt + bAmt + vAmt);

      totCash += cAmt;
      totBank += bAmt;
      totVoucher += vAmt;
      totGrand += gAmt;

      const depList = allDeposits.filter(d => d.depositDate === date);
      let depText = '-';
      if (depList.length > 0) {
        depText = depList.map(d => `${d.bankName || 'બેંક'}: ₹${Number(d.amount).toLocaleString('en-IN')} (${d.fromDate} થી ${d.toDate} - ${d.daysCount || '-'} દિવસ)`).join(' | ');
        depList.forEach(d => { totDeposited += Number(d.amount) || 0; });
      }

      rows.push([i + 1, date, cAmt, bAmt, vAmt, depText, gAmt]);
    });

    rows.push(['']);
    rows.push(['', 'કુલ સરવાળો', totCash, totBank, totVoucher, `કુલ બેંક જમા: ₹${totDeposited.toLocaleString('en-IN')}`, totGrand]);
  }

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(rows);

  ws['!cols'] = isCashMode
    ? [{ wch: 6 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 42 }]
    : [{ wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 45 }, { wch: 20 }];

  xlsx.utils.book_append_sheet(wb, ws, 'Hisab_History');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const safeLabel = (month || fy || 'All').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename=Hisab_History_${safeLabel}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

};
