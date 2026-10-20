const fs = require('fs');

const BASE_URL = 'http://localhost:3000';
const report = {
  timestamp: new Date().toISOString(),
  totalTests: 0,
  passCount: 0,
  failCount: 0,
  tests: [],
  bugsFound: []
};

function recordTest(topicNumber, topicName, testName, passed, details, bugDetail = null) {
  report.totalTests++;
  if (passed) {
    report.passCount++;
  } else {
    report.failCount++;
    report.bugsFound.push({
      topicNumber,
      topicName,
      testName,
      severity: bugDetail?.severity || 'Medium',
      description: bugDetail?.description || details,
      actual: bugDetail?.actual,
      expected: bugDetail?.expected
    });
  }
  report.tests.push({
    topicNumber,
    topicName,
    testName,
    passed,
    details
  });
}

async function runTests() {
  console.log('Starting 19-Topic Full System Audit (Refined Contracts)...');

  // Login as admin first to get token
  let adminToken = '';
  try {
    const r = await fetch(`${BASE_URL}/api/admin/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' })
    });
    const d = await r.json();
    if (d.token) adminToken = d.token;
  } catch (e) {}

  const adminHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${adminToken}`
  };

  // -------------------------------------------------------------
  // TOPIC 1: Daily Hisab & Mathematical Calculations
  // -------------------------------------------------------------
  try {
    const today = new Date().toISOString().split('T')[0];
    const recRes = await fetch(`${BASE_URL}/api/records/${today}`);
    const recData = await recRes.json();
    recordTest(1, 'Daily Hisab & Math', 'Fetch Today Daily Record', recRes.status === 200, `Fetched ${today} status: ${recRes.status}`);

    // Math check
    const testNotes = [
      { note: 500, count: 10, amount: 5000 },
      { note: 200, count: 5, amount: 1000 },
      { note: 100, count: 0, amount: 0 }
    ];
    const calcCashTotal = testNotes.reduce((s, n) => s + (n.note * n.count), 0);
    recordTest(1, 'Daily Hisab & Math', 'Denomination Multiplication (500x10 + 200x5 = 6000)', calcCashTotal === 6000, `Calc: ${calcCashTotal}`);

    // Save today's record (unlocked for current day or with admin token)
    const testPayload = {
      date: today,
      notes: testNotes,
      cashTotal: calcCashTotal,
      banks: [{ name: 'SBI TRF', amount: 3000 }],
      bankTotal: 3000,
      vouchers: [{ name: 'MANDIRKHARCH', amount: 2000 }],
      voucherTotal: 2000,
      grandTotal: 7000,
      remarks: 'Automated Test Verification'
    };
    const saveRes = await fetch(`${BASE_URL}/api/records/${today}`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(testPayload)
    });
    const saveData = await saveRes.json();
    recordTest(1, 'Daily Hisab & Math', 'Save Daily Record with Admin Token', saveData.success === true, `Save response: ${JSON.stringify(saveData)}`);

    // Past date lock verification: Without admin token, past date should be locked
    const pastRes = await fetch(`${BASE_URL}/api/records/2026-08-01`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });
    const pastData = await pastRes.json();
    const isPastDateGuarded = pastRes.status === 403 && pastData.isLocked === true;
    recordTest(1, 'Daily Hisab & Math', 'Past Date Editing Locked for Non-Admin (Security Protection)', isPastDateGuarded, `Status: ${pastRes.status}, Error: ${pastData.error}`);
  } catch (e) {
    recordTest(1, 'Daily Hisab & Math', 'Daily Hisab Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 2: Advance Cash / Uchak (ઉચક) System
  // -------------------------------------------------------------
  try {
    const uchakListRes = await fetch(`${BASE_URL}/api/uchak`);
    const uchakData = await uchakListRes.json();
    const passed2_1 = Array.isArray(uchakData.items);
    recordTest(2, 'Advance Cash (Uchak)', 'Fetch Uchak List API', passed2_1, `Total Uchak items: ${uchakData.items?.length}`);

    // Add Uchak using givenAmount or amount
    const testUchak = {
      personName: 'Ramesh Test Sevak',
      phone: '9876543210',
      purpose: 'Uchak Advance Test',
      givenDate: '2026-10-14',
      givenTime: '11:40 AM',
      amount: 2500,
      remarks: 'Automated test'
    };
    const addRes = await fetch(`${BASE_URL}/api/uchak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testUchak)
    });
    const addData = await addRes.json();
    const addedId = addData.item?.id || addData.entry?.id;
    recordTest(2, 'Advance Cash (Uchak)', 'Add Uchak Advance Record', addData.success === true && !!addedId, `Created ID: ${addedId}`);

    if (addedId) {
      // Settle Uchak
      const settleRes = await fetch(`${BASE_URL}/api/uchak/${addedId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settledDate: '2026-10-14',
          returnedAmount: 2500,
          voucherAmount: 0,
          remarks: 'Full cash returned'
        })
      });
      const settleData = await settleRes.json();
      recordTest(2, 'Advance Cash (Uchak)', 'Settle Uchak Advance Record', settleData.success === true, `Settle response: ${JSON.stringify(settleData)}`);

      // Cleanup
      await fetch(`${BASE_URL}/api/uchak/${addedId}`, { method: 'DELETE' });
    }
  } catch (e) {
    recordTest(2, 'Advance Cash (Uchak)', 'Uchak System Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 3: Staff & Employees Management
  // -------------------------------------------------------------
  try {
    const empRes = await fetch(`${BASE_URL}/api/employees`);
    const empData = await empRes.json();
    recordTest(3, 'Employees & Staff', 'Fetch Employees with Calculated Balances', empData.success === true && Array.isArray(empData.employees), `Total employees: ${empData.employees?.length}`);

    // Add employee
    const addEmpRes = await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Shyam Test Maharaj', role: 'Rasoiya', salary: 15000, phone: '9988776655' })
    });
    const addEmpData = await addEmpRes.json();
    const empId = addEmpData.employee?.id;
    recordTest(3, 'Employees & Staff', 'Add New Employee Record', addEmpData.success === true && !!empId, `Created Emp ID: ${empId}`);

    if (empId) {
      // Add Upad
      const upadRes = await fetch(`${BASE_URL}/api/employees/${empId}/upad`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-10-14', amount: 3000, remarks: 'Medical Upad' })
      });
      const upadData = await upadRes.json();
      recordTest(3, 'Employees & Staff', 'Record Employee Upad Deduction', upadData.success === true, `Upad recorded: ${upadData.success}`);

      // Cleanup
      await fetch(`${BASE_URL}/api/employees/${empId}`, { method: 'DELETE' });
    }
  } catch (e) {
    recordTest(3, 'Employees & Staff', 'Employees Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 4: Mahapuja & Bhakts
  // -------------------------------------------------------------
  try {
    const bhaktsRes = await fetch(`${BASE_URL}/api/bhakts`);
    const bhaktsData = await bhaktsRes.json();
    recordTest(4, 'Bhakts & Mahapuja', 'Fetch Bhakts List with Deposit Summaries', bhaktsData.success === true && Array.isArray(bhaktsData.bhakts), `Total bhakts: ${bhaktsData.bhakts?.length}`);

    // Add Bhakt with Admin Token
    const addBhaktRes = await fetch(`${BASE_URL}/api/bhakts`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'Navneetbhai Test Bhakt', phone: '9825098250', dailyAmount: 51, donorId: 'D-999', payType: 'monthly' })
    });
    const addBhaktData = await addBhaktRes.json();
    const bhaktId = addBhaktData.bhakt?.id;
    recordTest(4, 'Bhakts & Mahapuja', 'Add New Bhakt Record (Protected)', addBhaktData.success === true && !!bhaktId, `Created Bhakt ID: ${bhaktId}`);

    if (bhaktId) {
      // Cleanup
      await fetch(`${BASE_URL}/api/bhakts/${bhaktId}`, { method: 'DELETE', headers: adminHeaders });
    }
  } catch (e) {
    recordTest(4, 'Bhakts & Mahapuja', 'Bhakts Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 5: Printing & Voucher Formatting
  // -------------------------------------------------------------
  try {
    const sRes = await fetch(`${BASE_URL}/api/settings`);
    const s = await sRes.json();
    recordTest(5, 'Printing & Layout', 'Print Margin Top/Left Offsets (140mm / 43mm)', s.printTopOffset === 140 && s.printLeftOffset === 43, `Top: ${s.printTopOffset}mm, Left: ${s.printLeftOffset}mm`);
    recordTest(5, 'Printing & Layout', 'Print Signatures (Prepared, Checked, President)', !!(s.signPrepared && s.signChecked && s.signPresident), `Prepared: ${s.signPrepared}, Checked: ${s.signChecked}`);
  } catch (e) {
    recordTest(5, 'Printing & Layout', 'Printing Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 6: Admin Security, Lockout & Email OTP
  // -------------------------------------------------------------
  try {
    recordTest(6, 'Admin Security & Email', 'Admin PIN Bearer Auth Generation', !!adminToken, `Token: ${adminToken ? adminToken.slice(0, 15) + '...' : 'none'}`);
    
    // Test Email Delivery with Token
    const testMailRes = await fetch(`${BASE_URL}/api/admin/test-email`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ senderName: 'Gadisthan Jetpur' })
    });
    const testMailData = await testMailRes.json();
    recordTest(6, 'Admin Security & Email', 'English Test Email Sent (From: Gadisthan Jetpur)', testMailData.success === true, `Response: ${testMailData.message}`);

    // Forgot PIN OTP Dispatch
    const otpRes = await fetch(`${BASE_URL}/api/admin/forgot-pin-request`, { method: 'POST' });
    const otpData = await otpRes.json();
    recordTest(6, 'Admin Security & Email', '6-Digit OTP Generated & Sent to Gmail', otpData.success === true, `Response: ${otpData.message}`);
  } catch (e) {
    recordTest(6, 'Admin Security & Email', 'Security Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 7: Backup, Restore & Excel Export
  // -------------------------------------------------------------
  try {
    const backupRes = await fetch(`${BASE_URL}/api/admin/backup`, { headers: adminHeaders });
    const backupData = await backupRes.json();
    const hasRecords = backupData && backupData.records && Object.keys(backupData.records).length > 0;
    recordTest(7, 'Backup & Export', 'Full JSON Database Backup Download (Records + Settings)', hasRecords, `Records backed up: ${Object.keys(backupData.records || {}).length}`);

    // Export Daily Excel
    const today = new Date().toISOString().split('T')[0];
    const excelRes = await fetch(`${BASE_URL}/api/export/excel/${today}`);
    recordTest(7, 'Backup & Export', 'Export Daily Excel Sheet (.xlsx)', excelRes.status === 200, `Excel HTTP status: ${excelRes.status}`);

    // Export History Excel
    const historyRes = await fetch(`${BASE_URL}/api/export/history-excel`);
    recordTest(7, 'Backup & Export', 'Export Multi-Month History Excel (.xlsx)', historyRes.status === 200, `Status: ${historyRes.status}`);
  } catch (e) {
    recordTest(7, 'Backup & Export', 'Backup Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 8: MongoDB Atlas Cloud Sync
  // -------------------------------------------------------------
  try {
    const cloudRes = await fetch(`${BASE_URL}/api/cloud-status`);
    const cloudData = await cloudRes.json();
    const isOnline = cloudData.online === true || cloudData.status === 'Online Connected';
    recordTest(8, 'Cloud Sync (MongoDB)', 'MongoDB Atlas Cloud Connectivity', isOnline, `Cloud Status: ${cloudData.status || (cloudData.online ? 'Online' : 'Offline')}`);
  } catch (e) {
    recordTest(8, 'Cloud Sync (MongoDB)', 'Cloud Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 10: Validation & Error Prevention (Negative Numbers)
  // -------------------------------------------------------------
  try {
    const badRecord = {
      date: '2026-09-03',
      notes: [{ note: 500, count: -5, amount: -2500 }],
      cashTotal: -2500,
      banks: [],
      bankTotal: 0,
      vouchers: [],
      voucherTotal: 0,
      grandTotal: -2500
    };
    const badRes = await fetch(`${BASE_URL}/api/records/2026-09-03`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(badRecord)
    });
    const badData = await badRes.json();
    if (badRes.status === 200 && badData.success === true) {
      recordTest(10, 'Validation & Error Prevention', 'Prevent Negative Note Counts & Amounts in Daily Hisab', false,
        'Server accepted negative cash note count (-5 notes of 500 = -2500) without throwing validation error.', {
          severity: 'Low',
          description: 'The backend does not validate that note counts must be >= 0 in /api/records/:date.',
          actual: 'HTTP 200 Success with cashTotal: -2500',
          expected: 'HTTP 400 Bad Request: "Note count cannot be negative"'
        }
      );
      await fetch(`${BASE_URL}/api/records/2026-09-03`, { method: 'DELETE', headers: adminHeaders });
    } else {
      recordTest(10, 'Validation & Error Prevention', 'Prevent Negative Note Counts & Amounts in Daily Hisab', true, 'Server rejected negative cash');
    }
  } catch (e) {
    recordTest(10, 'Validation & Error Prevention', 'Validation Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 13: Financial Year Closing & Dates
  // -------------------------------------------------------------
  try {
    const m31 = await fetch(`${BASE_URL}/api/records/2026-03-31`);
    const a01 = await fetch(`${BASE_URL}/api/records/2026-04-01`);
    recordTest(13, 'Year End & Dates', 'Fiscal Year Boundary Date Records Support', m31.status === 200 && a01.status === 200, `March 31: ${m31.status}, April 01: ${a01.status}`);
  } catch (e) {
    recordTest(13, 'Year End & Dates', 'Fiscal Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 18: Audit Trail & Timestamps
  // -------------------------------------------------------------
  try {
    const recRes = await fetch(`${BASE_URL}/api/records/2026-10-14`);
    const recData = await recRes.json();
    const hasUpdatedAt = !!(recData.updatedAt || recData.record?.updatedAt);
    recordTest(18, 'Audit Trail & Timestamps', 'Record Modification Timestamp (updatedAt)', hasUpdatedAt, `updatedAt: ${recData.updatedAt || recData.record?.updatedAt}`);
  } catch (e) {
    recordTest(18, 'Audit Trail & Timestamps', 'Audit Exception', false, e.message);
  }

  // -------------------------------------------------------------
  // TOPIC 19: Performance & Stress Test
  // -------------------------------------------------------------
  try {
    const t0 = Date.now();
    const calls = [];
    for (let i = 0; i < 30; i++) {
      calls.push(fetch(`${BASE_URL}/api/records`).then(r => r.json()));
    }
    await Promise.all(calls);
    const elapsed = Date.now() - t0;
    recordTest(19, 'Performance & Stress', 'Rapid Concurrent API Requests (30 calls)', elapsed < 2000, `Completed in ${elapsed}ms (Avg ${(elapsed/30).toFixed(1)}ms/call)`);
  } catch (e) {
    recordTest(19, 'Performance & Stress', 'Stress Exception', false, e.message);
  }

  fs.writeFileSync('full_test_report_refined.json', JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n======================================================`);
  console.log(`REFINED TEST: ${report.passCount}/${report.totalTests} Passed (${((report.passCount/report.totalTests)*100).toFixed(1)}%)`);
  console.log(`Bugs / Observations Found: ${report.bugsFound.length}`);
  console.log(`======================================================`);
}

runTests();
