module.exports = function registerEmployeeRoutes(app, deps) {
  const {
    getEmployees,
    saveEmployees,
    getRecords,
    saveRecords,
    getSettings,
    createBlankRecord,
    isValidAdminSession,
    getTodayDateStr,
    getTodayTimeStr,
    logAdminActivity,
    getGujaratiMonthLabel,
    getAuthUser
  } = deps;

  function checkStaffSalaryPermission(req, res) {
    const authUser = (typeof getAuthUser === 'function') ? getAuthUser(req) : null;
    const userRole = (authUser && authUser.role) || req.headers['x-user-role'];
    const settings = getSettings();
    const rolePerms = (settings && settings.rolePermissions) || {};
    if (userRole && rolePerms[userRole]) {
      const perm = rolePerms[userRole].staffSalary;
      if (perm === 'readonly' || perm === 'hidden') {
        res.status(403).json({
          success: false,
          error: 'ઍક્સેસ નકારવામાં આવ્યો! આ આઈડી માટે સ્ટાફ પગાર ફક્ત વાંચવા માટે (Read-Only Mode) છે.'
        });
        return false;
      }
    }
    return true;
  }

function getDefaultSalaryMonth(dateStr = null) {
  const dStr = dateStr || getTodayDateStr();
  return dStr.slice(0, 7);
}

// Robust Staff Salary & Upad Balance Engine (With opening balance carry-forward, absent deduction, unclamped balance)
function calculateEmployeeBalances(emp, targetMonth = null) {
  const currentMonth = targetMonth || getDefaultSalaryMonth();
  const configuredSalary = Number(emp.salary) || 0;
  const isInactive = (emp.status === 'inactive');
  const upads = emp.upads || [];
  const pagars = emp.pagars || [];

  // Sort chronologically ascending for timeline calculation
  const sortedUpads = [...upads].sort((a, b) => ((a.date || '') + (a.time || '')).localeCompare((b.date || '') + (b.time || '')));
  const sortedPagars = [...pagars].sort((a, b) => ((a.date || '') + (a.time || '')).localeCompare((b.date || '') + (b.time || '')));

  // Collect all distinct months
  const allMonthsSet = new Set();
  sortedUpads.forEach(u => {
    const m = u.forMonth || (u.date ? u.date.slice(0, 7) : '');
    if (m) allMonthsSet.add(m);
  });
  sortedPagars.forEach(p => {
    const m = p.forMonth || (p.date ? p.date.slice(0, 7) : '');
    if (m) allMonthsSet.add(m);
  });
  if (currentMonth) allMonthsSet.add(currentMonth);

  // Determine starting month for automatic continuous tracking
  // To avoid phantom debts for years prior to software adoption, start from either salaryStartMonth,
  // or joiningDate if >= '2026-07', or earliest transaction month
  let startMonth = emp.salaryStartMonth || null;
  if (!startMonth) {
    if (emp.joiningDate && emp.joiningDate >= '2026-07') {
      startMonth = emp.joiningDate.slice(0, 7);
    } else {
      const transMonths = Array.from(allMonthsSet).sort();
      startMonth = transMonths[0] || currentMonth;
    }
  }

  // Ensure continuous monthly sequence from startMonth to currentMonth
  if (startMonth && startMonth <= currentMonth) {
    let cur = startMonth;
    while (cur <= currentMonth) {
      allMonthsSet.add(cur);
      const parts = cur.split('-').map(Number);
      const nextM = parts[1] === 12 ? 1 : parts[1] + 1;
      const nextY = parts[1] === 12 ? parts[0] + 1 : parts[0];
      cur = `${nextY}-${String(nextM).padStart(2, '0')}`;
    }
  }

  const sortedMonths = Array.from(allMonthsSet).sort();

  let runningOpeningBalance = Number(emp.initialBalance) || 0;
  let targetOpeningBalance = 0;
  let targetEarnedSalary = (isInactive ? 0 : configuredSalary);
  let targetMonthUpad = 0;
  let targetMonthPagarPaid = 0;
  let targetAbsentDays = 0;
  let targetAbsentDeduction = 0;
  let targetTotalDays = 30;

  const monthlyHistory = [];

  for (const m of sortedMonths) {
    const mUpads = sortedUpads.filter(u => (u.forMonth || (u.date ? u.date.slice(0, 7) : '')) === m);
    const mPagars = sortedPagars.filter(p => (p.forMonth || (p.date ? p.date.slice(0, 7) : '')) === m);

    const mUpadTotal = mUpads.reduce((s, u) => s + (Number(u.amount) || 0), 0);
    const mPagarTotal = mPagars.reduce((s, p) => s + (Number(p.amount) || 0), 0);

    let mAbsentDays = 0;
    let mAbsentDeduction = 0;
    let mTotalDays = 30;
    mPagars.forEach(p => {
      if (p.absentDays) mAbsentDays += Number(p.absentDays) || 0;
      if (p.absentDeduction) mAbsentDeduction += Number(p.absentDeduction) || 0;
      if (p.totalMonthDays) mTotalDays = Number(p.totalMonthDays) || 30;
    });

    const mSalary = (isInactive && m >= currentMonth) ? 0 : configuredSalary;
    const mEarnedSalary = Math.max(0, mSalary - mAbsentDeduction);
    const mOpening = runningOpeningBalance;
    // Closing = Opening + Earned Salary - Upads - Pagars Paid
    const mClosing = mOpening + mEarnedSalary - mUpadTotal - mPagarTotal;

    monthlyHistory.push({
      month: m,
      monthLabel: getGujaratiMonthLabel(m),
      openingBalance: mOpening,
      salary: mSalary,
      totalMonthDays: mTotalDays,
      absentDays: mAbsentDays,
      absentDeduction: mAbsentDeduction,
      earnedSalary: mEarnedSalary,
      upadTotal: mUpadTotal,
      pagarTotal: mPagarTotal,
      closingBalance: mClosing,
      upadsCount: mUpads.length,
      pagarsCount: mPagars.length
    });

    if (m === currentMonth) {
      targetOpeningBalance = mOpening;
      targetEarnedSalary = mEarnedSalary;
      targetMonthUpad = mUpadTotal;
      targetMonthPagarPaid = mPagarTotal;
      targetAbsentDays = mAbsentDays;
      targetAbsentDeduction = mAbsentDeduction;
      targetTotalDays = mTotalDays;
    }

    runningOpeningBalance = mClosing;
  }

  // True net balance for currentMonth
  // Net balance = opening balance from past months + earned salary of this month - upad of this month - pagar paid of this month
  const netBalance = targetOpeningBalance + targetEarnedSalary - targetMonthUpad - targetMonthPagarPaid;

  const totalUpadAllTime = upads.reduce((s, u) => s + (Number(u.amount) || 0), 0);
  const totalPagarPaidAllTime = pagars.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  // Sort descending by date for ledger display
  const sortedUpadsDesc = [...upads].sort((a, b) => ((b.date || '') + (b.time || '')).localeCompare((a.date || '') + (a.time || '')));
  const sortedPagarsDesc = [...pagars].sort((a, b) => ((b.date || '') + (b.time || '')).localeCompare((a.date || '') + (a.time || '')));

  return {
    ...emp,
    paymentType: emp.paymentType || 'monthly',
    paymentMode: emp.paymentMode === 'bank' ? 'bank' : 'cash',
    salary: configuredSalary,
    currentMonth,
    currentMonthLabel: getGujaratiMonthLabel(currentMonth),
    openingBalance: targetOpeningBalance, // અગાઉના મહિનાઓની બાકી (+ એટલે ચૂકવવાપાત્ર, - એટલે એડવાન્સ/ઉપાડ જમા)
    absentDays: targetAbsentDays,
    absentDeduction: targetAbsentDeduction,
    totalMonthDays: targetTotalDays,
    earnedSalary: targetEarnedSalary,
    currentMonthUpad: targetMonthUpad,
    currentMonthPagarPaid: targetMonthPagarPaid,
    totalUpadAllTime,
    totalPagarPaidAllTime,
    netBalance, // Can be positive (Payable), negative (Advance/Overdrawn), or zero (Settled)
    upads: sortedUpadsDesc,
    pagars: sortedPagarsDesc,
    upadsCount: upads.length,
    monthUpadsCount: upads.filter(u => (u.forMonth || (u.date ? u.date.slice(0, 7) : '')) === currentMonth).length,
    pagarsCount: pagars.length,
    monthPagarsCount: pagars.filter(p => (p.forMonth || (p.date ? p.date.slice(0, 7) : '')) === currentMonth).length,
    monthlyHistory
  };
}

// 9d. Get all employees with calculated salary, upad, pagar and net balance
app.get('/api/employees', (req, res) => {
  const employees = getEmployees();
  const currentMonth = req.query.month || getDefaultSalaryMonth(); // 'YYYY-MM'

  const enriched = employees.map(emp => calculateEmployeeBalances(emp, currentMonth));

  const activeEmployees = enriched.filter(e => e.status !== 'inactive');
  const inactiveEmployees = enriched.filter(e => e.status === 'inactive');
  const cashEmployees = activeEmployees.filter(e => (e.paymentMode || 'cash') !== 'bank');
  const bankEmployees = activeEmployees.filter(e => e.paymentMode === 'bank');

  const totalPayroll = activeEmployees.reduce((s, e) => s + (e.salary || 0), 0);
  const totalCashPayroll = cashEmployees.reduce((s, e) => s + (e.salary || 0), 0);
  const totalBankPayroll = bankEmployees.reduce((s, e) => s + (e.salary || 0), 0);

  const totalOpeningBalance = cashEmployees.reduce((s, e) => s + (e.openingBalance || 0), 0);
  const totalCashMonthUpad = cashEmployees.reduce((s, e) => s + (e.currentMonthUpad || 0), 0);
  const totalBankMonthUpad = bankEmployees.reduce((s, e) => s + (e.currentMonthUpad || 0), 0);
  const totalMonthUpad = totalCashMonthUpad;
  const totalAllMonthUpad = activeEmployees.reduce((s, e) => s + (e.currentMonthUpad || 0), 0);
  const totalMonthPagarPaid = cashEmployees.reduce((s, e) => s + (e.currentMonthPagarPaid || 0), 0);
  const totalNetPayable = cashEmployees.reduce((s, e) => s + (e.netBalance > 0 ? e.netBalance : 0), 0);
  const totalNetAdvance = cashEmployees.reduce((s, e) => s + (e.netBalance < 0 ? Math.abs(e.netBalance) : 0), 0);

  res.json({
    success: true,
    currentMonth,
    currentMonthLabel: getGujaratiMonthLabel(currentMonth),
    summary: {
      totalEmployees: activeEmployees.length,
      totalActiveEmployees: activeEmployees.length,
      totalInactiveEmployees: inactiveEmployees.length,
      totalCashEmployees: cashEmployees.length,
      totalBankEmployees: bankEmployees.length,
      totalPayroll,
      totalCashPayroll,
      totalBankPayroll,
      totalOpeningBalance,
      totalMonthUpad,
      totalCashMonthUpad,
      totalBankMonthUpad,
      totalAllMonthUpad,
      totalMonthPagarPaid,
      totalNetPayable,
      totalNetAdvance
    },
    employees: enriched
  });
});

// 9e. Add New Employee
app.post('/api/employees', (req, res) => {
  if (!checkStaffSalaryPermission(req, res)) return;
  const { name, role, phone, salary, joiningDate, paymentType, paymentMode } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'કર્મચારીનું નામ જરૂરી છે (Employee name is required)' });
  }

  const cleanPaymentType = paymentType === '15days' ? '15days' : 'monthly';
  const cleanPaymentMode = paymentMode === 'bank' ? 'bank' : 'cash';
  const employees = getEmployees();
  const newEmp = {
    id: 'emp_' + Date.now(),
    name: name.trim(),
    role: (role || 'સ્ટાફ').trim(),
    phone: (phone || '').trim(),
    salary: Number(salary) || 0,
    paymentType: cleanPaymentType,
    paymentMode: cleanPaymentMode,
    joiningDate: joiningDate || getTodayDateStr(),
    status: 'active',
    upads: [],
    pagars: []
  };

  employees.push(newEmp);
  saveEmployees(employees);
  logAdminActivity(
    'STAFF_ADD',
    'STAFF',
    `નવો કર્મચારી ઉમેર્યો: ${newEmp.name}`,
    `Added Staff Member: ${newEmp.name}`,
    `હોદ્દો: ${newEmp.role}, પદ્ધતિ: ${cleanPaymentMode === 'bank' ? '🏦 બેંક' : '💵 રોકડ'}, પ્રકાર: ${cleanPaymentType === '15days' ? '૧૫ દિવસીય ચૂકવણી' : 'માસિક ચૂકવણી'}, પગાર: ₹${newEmp.salary}`,
    `Role: ${newEmp.role}, Mode: ${cleanPaymentMode === 'bank' ? 'Bank' : 'Cash'}, Type: ${cleanPaymentType === '15days' ? '15-Day' : 'Monthly'}, Salary: ₹${newEmp.salary}`,
    'success',
    req
  );
  res.json({ success: true, employee: newEmp });
});

// 9f. Update Employee
app.put('/api/employees/:id', (req, res) => {
  if (!checkStaffSalaryPermission(req, res)) return;
  const { id } = req.params;
  const { name, role, phone, salary, paymentType, paymentMode, joiningDate, status, pagars, upads, monthlyHistory } = req.body;
  const employees = getEmployees();
  const emp = employees.find(e => e.id === id);

  if (!emp) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી (Employee not found)' });
  }

  const oldEmp = {
    name: emp.name,
    role: emp.role,
    phone: emp.phone,
    salary: emp.salary,
    paymentType: emp.paymentType || 'monthly',
    paymentMode: emp.paymentMode || 'cash',
    status: emp.status
  };

  const staffChanges = [];
  if (name !== undefined && name.trim() !== oldEmp.name) {
    staffChanges.push({ field: 'નામ (Name)', before: oldEmp.name, after: name.trim() });
    emp.name = name.trim();
  }
  if (role !== undefined && role.trim() !== oldEmp.role) {
    staffChanges.push({ field: 'હોદ્દો (Role)', before: oldEmp.role, after: role.trim() });
    emp.role = role.trim();
  }
  if (phone !== undefined && phone.trim() !== oldEmp.phone) {
    staffChanges.push({ field: 'ફોન (Phone)', before: oldEmp.phone || 'ખાલી', after: phone.trim() || 'ખાલી' });
    emp.phone = phone.trim();
  }
  if (salary !== undefined && Number(salary) !== oldEmp.salary) {
    staffChanges.push({ field: 'પગાર (Salary)', before: '₹' + oldEmp.salary, after: '₹' + Number(salary) });
    emp.salary = Number(salary) || 0;
  }
  if (paymentType !== undefined) {
    const cleanPaymentType = paymentType === '15days' ? '15days' : 'monthly';
    if (cleanPaymentType !== oldEmp.paymentType) {
      staffChanges.push({
        field: 'ચૂકવણી પ્રકાર (Payment Type)',
        before: oldEmp.paymentType === '15days' ? '૧૫ દિવસીય (15-Day)' : 'માસિક (Monthly)',
        after: cleanPaymentType === '15days' ? '૧૫ દિવસીય (15-Day)' : 'માસિક (Monthly)'
      });
    }
    emp.paymentType = cleanPaymentType;
  }
  if (paymentMode !== undefined) {
    const cleanPaymentMode = paymentMode === 'bank' ? 'bank' : 'cash';
    if (cleanPaymentMode !== oldEmp.paymentMode) {
      staffChanges.push({
        field: 'ચૂકવણી પદ્ધતિ (Payment Mode)',
        before: oldEmp.paymentMode === 'bank' ? '🏦 બેંક ટ્રાન્સફર' : '💵 રોકડ ચુકવણી',
        after: cleanPaymentMode === 'bank' ? '🏦 બેંક ટ્રાન્સફર' : '💵 રોકડ ચુકવણી'
      });
    }
    emp.paymentMode = cleanPaymentMode;
  }
  if (joiningDate !== undefined && joiningDate !== emp.joiningDate) {
    staffChanges.push({ field: 'જોડાવાની તારીખ', before: emp.joiningDate || '-', after: joiningDate });
    emp.joiningDate = joiningDate;
  }
  if (status !== undefined && status !== oldEmp.status) {
    staffChanges.push({ field: 'સ્થિતિ (Status)', before: oldEmp.status === 'active' ? 'Active (ચાલુ)' : 'Inactive (બંધ)', after: status === 'active' ? 'Active (ચાલુ)' : 'Inactive (બંધ)' });
    emp.status = status;
  }
  if (Array.isArray(pagars)) emp.pagars = pagars;
  if (Array.isArray(upads)) emp.upads = upads;
  if (Array.isArray(monthlyHistory)) emp.monthlyHistory = monthlyHistory;

  if (staffChanges.length === 0) {
    staffChanges.push({ field: 'કર્મચારી પ્રોફાઇલ', before: 'જૂની વિગત', after: 'અપડેટ કરી' });
  }

  saveEmployees(employees);
  logAdminActivity(
    'STAFF_UPDATE',
    'STAFF',
    `કર્મચારી વિગત અપડેટ: ${emp.name}`,
    `Updated Staff: ${emp.name}`,
    `હોદ્દો: ${emp.role}, પ્રકાર: ${emp.paymentType === '15days' ? '૧૫ દિવસીય' : 'માસિક'}, સ્થિતિ: ${emp.status}, પગાર: ₹${emp.salary}`,
    `Role: ${emp.role}, Type: ${emp.paymentType === '15days' ? '15-Day' : 'Monthly'}, Status: ${emp.status}, Salary: ₹${emp.salary}`,
    'info',
    req,
    {
      type: 'STAFF_UPDATE',
      staffName: emp.name,
      changes: staffChanges
    }
  );
  res.json({ success: true, employee: emp });
});

// 9g. Delete Employee
app.delete('/api/employees/:id', (req, res) => {
  if (!checkStaffSalaryPermission(req, res)) return;
  const { id } = req.params;
  let employees = getEmployees();
  const initialLen = employees.length;
  const targetEmp = employees.find(e => e.id === id);
  employees = employees.filter(e => e.id !== id);

  if (employees.length === initialLen) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી' });
  }

  saveEmployees(employees);
  logAdminActivity(
    'STAFF_DELETE',
    'STAFF',
    `કર્મચારી કાઢી નાખ્યો: ${targetEmp ? targetEmp.name : id}`,
    `Deleted Staff Member: ${targetEmp ? targetEmp.name : id}`,
    `કર્મચારી રેકોર્ડ સફળતાપૂર્વક હટાવી દેવામાં આવ્યો`,
    `Staff record successfully removed from system`,
    'warning',
    req
  );
  res.json({ success: true, message: 'કર્મચારી કાઢી નાખવામાં આવ્યો છે.' });
});

// 9h. Add Upad (Advance) to Employee and sync with Daily Expense & UPAD voucher
app.post('/api/employees/:id/upad', (req, res) => {
  if (!checkStaffSalaryPermission(req, res)) return;
  const { id } = req.params;
  const { amount, title, remarks, date, time, forMonth, addToHisab } = req.body;

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'સાચી રકમ લખો (Valid amount required)' });
  }

  const employees = getEmployees();
  const emp = employees.find(e => e.id === id);
  if (!emp) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી' });
  }

  const upadDate = date || getTodayDateStr();
  const today = getTodayDateStr();
  if (upadDate < today && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${upadDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં ઉપાડ આપવા માટે એડમિન પિન જરૂરી છે.`,
      isLocked: true,
      sessionRequired: true
    });
  }
  const upadTime = time || getTodayTimeStr();
  const upadForMonth = forMonth || upadDate.slice(0, 7);
  const monthLabel = getGujaratiMonthLabel(upadForMonth);
  const upadTitle = (title || 'ઉપાડ').trim();
  const upadRemarks = (remarks || '').trim();

  const upadId = 'upd_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

  const newUpad = {
    id: upadId,
    date: upadDate,
    time: upadTime,
    forMonth: upadForMonth,
    amount: amt,
    title: upadTitle,
    remarks: upadRemarks,
    expenseItemId: req.body.expenseItemId || ('exp_' + upadId)
  };

  if (!Array.isArray(emp.upads)) emp.upads = [];
  emp.upads.unshift(newUpad);
  saveEmployees(employees);

  // If addToHisab is true, record in records.json under UPAD
  if (addToHisab !== false) {
    const records = getRecords();
    let rec = records[upadDate];
    if (!rec) {
      rec = createBlankRecord(upadDate, getSettings());
      records[upadDate] = rec;
    }

    if (!Array.isArray(rec.expenseItems)) rec.expenseItems = [];
    const itemTitle = `${emp.name} - ${monthLabel} માસનો ઉપાડ${upadTitle && upadTitle !== 'ઉપાડ' && upadTitle !== `${emp.name} ઉપાડ` ? ` (${upadTitle})` : ''}`;
    rec.expenseItems.unshift({
      id: 'exp_' + upadId,
      time: upadTime,
      title: itemTitle,
      amount: amt,
      category: 'UPAD',
      categoryType: 'voucher',
      employeeId: emp.id,
      employeeName: emp.name,
      employeeEntryId: upadId,
      forMonth: upadForMonth,
      remarks: upadRemarks
    });

    // Auto-increase UPAD voucher
    let upadVoucher = (rec.vouchers || []).find(v => v.name.trim() === 'UPAD');
    if (upadVoucher) {
      upadVoucher.amount = (Number(upadVoucher.amount) || 0) + amt;
    } else {
      rec.vouchers.push({ name: 'UPAD', amount: amt });
    }

    rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
    rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
    rec.updatedAt = new Date().toISOString();
    saveRecords(records);
  }

  res.json({ success: true, upad: newUpad, employee: emp });
});

// 9i. Delete Upad from Employee
app.delete('/api/employees/:id/upad/:upadId', (req, res) => {
  const { id, upadId } = req.params;
  const employees = getEmployees();
  const emp = employees.find(e => e.id === id);
  if (!emp) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી' });
  }

  const idx = (emp.upads || []).findIndex(u => u.id === upadId);
  if (idx === -1) {
    return res.status(404).json({ error: 'ઉપાડ એન્ટ્રી મળી નથી' });
  }

  const targetUpad = emp.upads[idx];
  const isPast = targetUpad.date < getTodayDateStr();
  if (isPast && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${targetUpad.date} નો હિસાબ લૉક છે! પાછલી તારીખની એન્ટ્રી કાઢવા માટે એડમિન પિન જરૂરી છે.`,
      sessionRequired: true,
      isLocked: true
    });
  }

  const removed = emp.upads.splice(idx, 1)[0];
  saveEmployees(employees);

  // Two-way sync: Also clean up from daily records if present!
  try {
    const records = getRecords();
    const rec = records[removed.date];
    if (rec && Array.isArray(rec.expenseItems)) {
      const eIdx = rec.expenseItems.findIndex(e => 
        (e.employeeId === id) &&
        (e.id === ('exp_' + upadId) || e.id === removed.expenseItemId || (Number(e.amount) === Number(removed.amount) && (e.category || '').toUpperCase().includes('UPAD')))
      );
      if (eIdx !== -1) {
        rec.expenseItems.splice(eIdx, 1);
        const catSums = {};
        rec.expenseItems.forEach(it => {
          const k = (it.category || '').trim().toUpperCase();
          catSums[k] = (catSums[k] || 0) + (Number(it.amount) || 0);
        });
        (rec.vouchers || []).forEach(v => {
          const vKey = (v.name || '').trim().toUpperCase();
          if (vKey === 'UPAD' || catSums[vKey] !== undefined) {
            v.amount = catSums[vKey] || 0;
          }
        });
        rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
        rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
        rec.updatedAt = new Date().toISOString();
        saveRecords(records);
      }
    }
  } catch (err) {
    console.error('Error syncing employee upad deletion to daily records:', err);
  }

  res.json({ success: true, removed, employee: emp });
});

// 9j. Add Pagar (Salary Payment) to Employee and sync with Daily Expense & PAGAR voucher
app.post('/api/employees/:id/pagar', (req, res) => {
  if (!checkStaffSalaryPermission(req, res)) return;
  const { id } = req.params;
  const { 
    amount, 
    title, 
    remarks, 
    date, 
    time, 
    forMonth, 
    addToHisab,
    totalMonthDays,
    absentDays,
    absentDeduction,
    earnedSalary,
    openingBalance,
    upadDeduction
  } = req.body;

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'સાચી રકમ લખો (Valid amount required)' });
  }

  const employees = getEmployees();
  const emp = employees.find(e => e.id === id);
  if (!emp) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી' });
  }

  const is15Days = emp.paymentType === '15days';
  const pagarDate = date || getTodayDateStr();
  const today = getTodayDateStr();
  if (pagarDate < today && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${pagarDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં પગાર ચૂકવવા માટે એડમિન પિન જરૂરી છે.`,
      isLocked: true,
      sessionRequired: true
    });
  }
  const pagarTime = time || getTodayTimeStr();
  const pagarForMonth = forMonth || pagarDate.slice(0, 7);
  const monthLabel = getGujaratiMonthLabel(pagarForMonth);
  const defaultTitle = is15Days ? '૧૫ દિવસનો પગાર' : `${monthLabel} માસનો પગાર`;
  const pagarTitle = (title || defaultTitle).trim();
  
  // Construct detailed auto-remarks for complete accounting transparency
  const autoRemarksParts = [];
  autoRemarksParts.push(is15Days ? `૧૫ દિવસીય પગાર: ₹${emp.salary || 0}` : `માસિક પગાર: ₹${emp.salary || 0}`);
  if (absentDays > 0) {
    autoRemarksParts.push(`ગેરહાજર: ${absentDays} દિવસ (-₹${absentDeduction || 0})`);
  }
  if (openingBalance) {
    autoRemarksParts.push(`જૂની બાકી: ${openingBalance > 0 ? '+' : ''}₹${openingBalance}`);
  }
  if (upadDeduction > 0) {
    autoRemarksParts.push(`ઉપાડ કપાત: -₹${upadDeduction}`);
  }
  autoRemarksParts.push(`ચૂકવેલ ચોખ્ખો પગાર: ₹${amt}`);
  if (remarks && remarks.trim()) {
    autoRemarksParts.push(`(${remarks.trim()})`);
  }
  const pagarRemarks = autoRemarksParts.join(' | ');

  const pagarId = 'pgr_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

  const newPagar = {
    id: pagarId,
    date: pagarDate,
    time: pagarTime,
    forMonth: pagarForMonth,
    fromDate: req.body.fromDate || null,
    toDate: req.body.toDate || null,
    amount: amt,
    title: pagarTitle,
    remarks: pagarRemarks,
    totalMonthDays: Number(totalMonthDays) || (is15Days ? 15 : 30),
    absentDays: Number(absentDays) || 0,
    absentDeduction: Number(absentDeduction) || 0,
    earnedSalary: Number(earnedSalary) || (emp.salary - (Number(absentDeduction) || 0)),
    openingBalance: Number(openingBalance) || 0,
    upadDeduction: Number(upadDeduction) || 0,
    expenseItemId: req.body.expenseItemId || ('exp_' + pagarId)
  };

  if (!Array.isArray(emp.pagars)) emp.pagars = [];
  emp.pagars.unshift(newPagar);
  saveEmployees(employees);

  // If addToHisab is true, record in records.json under PAGAR voucher ONLY for CASH employees (Bank employees are never added to daily voucher!)
  const isBankEmp = (emp.paymentMode === 'bank');
  if (addToHisab !== false && !isBankEmp) {
    const records = getRecords();
    let rec = records[pagarDate];
    if (!rec) {
      rec = createBlankRecord(pagarDate, getSettings());
      records[pagarDate] = rec;
    }

    if (!Array.isArray(rec.expenseItems)) rec.expenseItems = [];
    const itemTitle = (pagarTitle && pagarTitle.trim())
      ? `${pagarTitle}${absentDays > 0 ? ` (${absentDays} દિ. કપાત)` : ''}`
      : (is15Days
        ? `${emp.name} - ૧૫ દિવસનો પગાર${absentDays > 0 ? ` (${absentDays} દિ. કપાત)` : ''}`
        : `${emp.name} - ${monthLabel} માસનો પગાર${absentDays > 0 ? ` (${absentDays} દિ. કપાત)` : ''}`);
    rec.expenseItems.unshift({
      id: 'exp_' + pagarId,
      time: pagarTime,
      title: itemTitle,
      amount: amt,
      category: 'PAGAR',
      categoryType: 'voucher',
      employeeId: emp.id,
      employeeName: emp.name,
      employeeEntryId: pagarId,
      forMonth: pagarForMonth,
      remarks: pagarRemarks
    });

    // Auto-increase PAGAR voucher
    let pagarVoucher = (rec.vouchers || []).find(v => v.name.trim() === 'PAGAR');
    if (pagarVoucher) {
      pagarVoucher.amount = (Number(pagarVoucher.amount) || 0) + amt;
    } else {
      rec.vouchers.push({ name: 'PAGAR', amount: amt });
    }

    rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
    rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
    rec.updatedAt = new Date().toISOString();
    saveRecords(records);
  }

  res.json({ success: true, pagar: newPagar, employee: emp, isBank: isBankEmp });
});

// 9j-2. Bulk Pagar Payout (Selected or All employees pagar charged to kharch)
app.post('/api/employees/bulk-pagar', (req, res) => {
  if (!checkStaffSalaryPermission(req, res)) return;
  const { items, date, time, forMonth, addToHisab } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'કોઈ કર્મચારી પસંદ કરેલ નથી' });
  }

  const employees = getEmployees();
  const pagarDate = date || getTodayDateStr();
  const today = getTodayDateStr();
  if (pagarDate < today && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${pagarDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં જથ્થાબંધ પગાર ચૂકવવા માટે એડમિન પિન જરૂરી છે.`,
      isLocked: true,
      sessionRequired: true
    });
  }
  const pagarTime = time || getTodayTimeStr();
  const bulkMonth = forMonth || pagarDate.slice(0, 7);
  const monthLabel = getGujaratiMonthLabel(bulkMonth);
  let totalBulkAmount = 0;
  const processedItems = [];

  items.forEach(item => {
    const emp = employees.find(e => e.id === (item.id || item.employeeId));
    const amt = Number(item.amount);
    if (emp && !isNaN(amt) && amt > 0) {
      const is15 = emp.paymentType === '15days';
      const isBank = (emp.paymentMode === 'bank');
      const pagarId = 'pgr_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      const defaultTitle = is15 ? `${emp.name} - ૧૫ દિવસનો પગાર` : `${emp.name} - ${monthLabel} માસનો પગાર`;
      const pagarTitle = (item.title || defaultTitle).trim();
      const pagarRemarks = (item.remarks || '').trim();

      const newPagar = {
        id: pagarId,
        date: pagarDate,
        time: pagarTime,
        forMonth: bulkMonth,
        amount: amt,
        title: pagarTitle,
        remarks: pagarRemarks,
        expenseItemId: 'exp_' + pagarId
      };

      if (!Array.isArray(emp.pagars)) emp.pagars = [];
      emp.pagars.unshift(newPagar);

      if (!isBank) {
        totalBulkAmount += amt;
      }

      processedItems.push({
        pagarId,
        empId: emp.id,
        empName: emp.name,
        amount: amt,
        isBank,
        title: pagarTitle,
        remarks: pagarRemarks
      });
    }
  });

  if (processedItems.length === 0) {
    return res.status(400).json({ error: 'કોઈ માન્ય પગાર રકમ મળી નથી' });
  }

  saveEmployees(employees);

  // If addToHisab is true, record ONLY CASH employees under PAGAR voucher (Bank employees are never added to voucher)
  if (addToHisab !== false && totalBulkAmount > 0) {
    const records = getRecords();
    let rec = records[pagarDate];
    if (!rec) {
      rec = createBlankRecord(pagarDate, getSettings());
      records[pagarDate] = rec;
    }

    if (!Array.isArray(rec.expenseItems)) rec.expenseItems = [];
    processedItems.filter(p => !p.isBank).forEach(p => {
      rec.expenseItems.unshift({
        id: 'exp_' + p.pagarId,
        time: pagarTime,
        title: p.title,
        amount: p.amount,
        category: 'PAGAR',
        categoryType: 'voucher',
        employeeId: p.empId,
        employeeName: p.empName,
        forMonth: bulkMonth,
        remarks: p.remarks
      });
    });

    // Auto-increase PAGAR voucher
    let pagarVoucher = (rec.vouchers || []).find(v => v.name.trim() === 'PAGAR');
    if (pagarVoucher) {
      pagarVoucher.amount = (Number(pagarVoucher.amount) || 0) + totalBulkAmount;
    } else {
      rec.vouchers.push({ name: 'PAGAR', amount: totalBulkAmount });
    }

    rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
    rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
    rec.updatedAt = new Date().toISOString();
    saveRecords(records);
  }

  res.json({
    success: true,
    count: processedItems.length,
    totalPaid: totalBulkAmount,
    forMonth: bulkMonth,
    monthLabel,
    items: processedItems
  });
});

// 9k. Delete Pagar payment from Employee
app.delete('/api/employees/:id/pagar/:pagarId', (req, res) => {
  const { id, pagarId } = req.params;
  const employees = getEmployees();
  const emp = employees.find(e => e.id === id);
  if (!emp) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી' });
  }

  const idx = (emp.pagars || []).findIndex(p => p.id === pagarId);
  if (idx === -1) {
    return res.status(404).json({ error: 'પગાર ચૂકવણી એન્ટ્રી મળી નથી' });
  }

  const targetPagar = emp.pagars[idx];
  const isPast = targetPagar.date < getTodayDateStr();
  if (isPast && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${targetPagar.date} નો હિસાબ લૉક છે! પાછલી તારીખની એન્ટ્રી કાઢવા માટે એડમિન પિન જરૂરી છે.`,
      sessionRequired: true,
      isLocked: true
    });
  }

  const removed = emp.pagars.splice(idx, 1)[0];
  saveEmployees(employees);

  // Two-way sync: Also clean up from daily records if present!
  try {
    const records = getRecords();
    const rec = records[removed.date];
    if (rec && Array.isArray(rec.expenseItems)) {
      const eIdx = rec.expenseItems.findIndex(e => 
        (e.employeeId === id) &&
        (e.id === ('exp_' + pagarId) || e.id === removed.expenseItemId || (Number(e.amount) === Number(removed.amount) && (e.category || '').toUpperCase().includes('PAGAR')))
      );
      if (eIdx !== -1) {
        rec.expenseItems.splice(eIdx, 1);
        const catSums = {};
        rec.expenseItems.forEach(it => {
          const k = (it.category || '').trim().toUpperCase();
          catSums[k] = (catSums[k] || 0) + (Number(it.amount) || 0);
        });
        (rec.vouchers || []).forEach(v => {
          const vKey = (v.name || '').trim().toUpperCase();
          if (vKey === 'PAGAR' || catSums[vKey] !== undefined) {
            v.amount = catSums[vKey] || 0;
          }
        });
        rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
        rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
        rec.updatedAt = new Date().toISOString();
        saveRecords(records);
      }
    }
  } catch (err) {
    console.error('Error syncing employee pagar deletion to daily records:', err);
  }

  res.json({ success: true, removed, employee: emp });
});

};
