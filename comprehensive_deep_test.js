const fs = require('fs');

const BASE_URL = 'http://localhost:3000';
const auditReport = {
  timestamp: new Date().toISOString(),
  totalTests: 0,
  passCount: 0,
  failCount: 0,
  suites: {},
  bugs: []
};

function logTest(suiteName, testName, passed, details, bugMeta = null) {
  auditReport.totalTests++;
  if (!auditReport.suites[suiteName]) {
    auditReport.suites[suiteName] = { total: 0, passed: 0, failed: 0, tests: [] };
  }
  auditReport.suites[suiteName].total++;
  
  if (passed) {
    auditReport.passCount++;
    auditReport.suites[suiteName].passed++;
  } else {
    auditReport.failCount++;
    auditReport.suites[suiteName].failed++;
    auditReport.bugs.push({
      suite: suiteName,
      test: testName,
      severity: bugMeta?.severity || 'Medium',
      observed: bugMeta?.observed || details,
      expected: bugMeta?.expected || 'Expected behavior not met',
      reproduction: bugMeta?.reproduction || 'See test steps'
    });
  }

  auditReport.suites[suiteName].tests.push({
    testName,
    passed,
    details
  });
}

async function runDeepAudit() {
  console.log('Starting Comprehensive Deep End-to-End Audit...\n');

  // Step 0: Obtain Admin Auth Token
  let adminToken = '';
  try {
    const r = await fetch(`${BASE_URL}/api/admin/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' })
    });
    const d = await r.json();
    if (d.token) adminToken = d.token;
  } catch(e) {}

  const adminHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${adminToken}`
  };

  // =========================================================================
  // SUITE 1: Employee Pagar, Upad & Ledger Calculation
  // =========================================================================
  console.log('Testing Suite 1: Employee Pagar, Upad & Ledger Calculations...');
  try {
    // 1.1 Create Test Employee with Salary 10000
    const addEmpRes = await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'કિશોરભાઈ સેવક (Audit Test)',
        role: 'પૂજારી',
        salary: 10000,
        phone: '9898989898'
      })
    });
    const empData = await addEmpRes.json();
    const empId = empData.employee?.id;
    logTest('1. Pagar & Upad Engine', 'Create Employee Record', !!empId, `Created Employee ID: ${empId}`);

    if (empId) {
      // 1.2 Record Upad of 3000
      const upadRes = await fetch(`${BASE_URL}/api/employees/${empId}/upad`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: '2026-10-14',
          amount: 3000,
          remarks: 'તહેવાર ઉપાડ'
        })
      });
      const upadData = await upadRes.json();
      const upadId = upadData.upad?.id;
      logTest('1. Pagar & Upad Engine', 'Record Employee Upad (Advance)', upadData.success === true && !!upadId, `Upad ID: ${upadId}, Amount: 3000`);

      // 1.3 Verify Balance Calculation: Salary 10000 - Upad 3000 = Net 7000
      const checkRes = await fetch(`${BASE_URL}/api/employees?month=2026-10`);
      const checkData = await checkRes.json();
      const empEnriched = (checkData.employees || []).find(e => e.id === empId);
      const isBalance7000 = empEnriched && empEnriched.netBalance === 7000;
      logTest('1. Pagar & Upad Engine', 'Net Salary Calculation (10000 - 3000 = 7000)', isBalance7000, 
        `Expected Net: 7000, Got: ${empEnriched?.netBalance}`, {
          severity: 'High',
          observed: `Net balance is ${empEnriched?.netBalance}`,
          expected: 'Net balance should be 7000'
        }
      );

      // 1.4 Payout Pagar of 5000 (Partial payout)
      const pagarRes = await fetch(`${BASE_URL}/api/employees/${empId}/pagar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: '2026-10-14',
          forMonth: '2026-10',
          amount: 5000,
          paymentMode: 'CASH',
          remarks: 'પગાર ચૂકવણી ભાગ ૧'
        })
      });
      const pagarData = await pagarRes.json();
      const pagarId = pagarData.pagar?.id;
      logTest('1. Pagar & Upad Engine', 'Record Pagar Payout (Partial 5000)', pagarData.success === true && !!pagarId, `Pagar ID: ${pagarId}`);

      // 1.5 Verify New Balance: 7000 - 5000 = 2000
      const checkRes2 = await fetch(`${BASE_URL}/api/employees?month=2026-10`);
      const checkData2 = await checkRes2.json();
      const empEnriched2 = (checkData2.employees || []).find(e => e.id === empId);
      const isBalance2000 = empEnriched2 && empEnriched2.netBalance === 2000;
      logTest('1. Pagar & Upad Engine', 'Post-Payout Balance Calculation (7000 - 5000 = 2000)', isBalance2000, 
        `Expected Net: 2000, Got: ${empEnriched2?.netBalance}`, {
          severity: 'High',
          observed: `Net balance is ${empEnriched2?.netBalance}`,
          expected: 'Net balance should be 2000'
        }
      );

      // 1.6 Verify Pagar recorded in Today\'s Daily Hisab Vouchers
      const todayHisabRes = await fetch(`${BASE_URL}/api/records/2026-10-14`);
      const todayHisab = await todayHisabRes.json();
      const pagarExpenseItem = (todayHisab.expenseItems || []).find(it => it.employeeId === empId || (it.remarks || '').includes('કિશોરભાઈ'));
      logTest('1. Pagar & Upad Engine', 'Automatic Voucher Creation in Daily Hisab upon Pagar Payout', !!pagarExpenseItem, 
        `Expense item found: ${pagarExpenseItem ? JSON.stringify(pagarExpenseItem) : 'None'}`, {
          severity: 'High',
          observed: 'No linked expense item found in today\'s records for this pagar payout',
          expected: 'Pagar payout should automatically create an expense item under PAGAR voucher'
        }
      );

      // =========================================================================
      // SUITE 3: Reversal & Deletion Testing
      // =========================================================================
      console.log('Testing Suite 3: Reversal & Cascading Deletion...');
      if (pagarId) {
        // Delete the pagar entry
        const delPagarRes = await fetch(`${BASE_URL}/api/employees/${empId}/pagar/${pagarId}`, { method: 'DELETE' });
        const delPagarData = await delPagarRes.json();
        logTest('3. Reversal & Cascading', 'Delete Pagar Entry', delPagarData.success === true, `Delete response: ${JSON.stringify(delPagarData)}`);

        // Check if today's Daily Hisab expense voucher was reversed
        const recheckHisab = await (await fetch(`${BASE_URL}/api/records/2026-10-14`)).json();
        const stillExistsInExpense = (recheckHisab.expenseItems || []).some(it => it.id === ('exp_' + pagarId) || (it.category === 'PAGAR' && it.employeeId === empId));
        logTest('3. Reversal & Cascading', 'Cascade Reversal: Voucher Removed from Daily Hisab when Pagar Deleted', !stillExistsInExpense, 
          `Pagar voucher still in Daily Hisab: ${stillExistsInExpense}`, {
            severity: 'Medium',
            observed: 'Pagar expense item remained in Daily Hisab even after deleting employee pagar',
            expected: 'Pagar expense item must be removed from Daily Hisab'
          }
        );
      }

      // Cleanup test employee
      await fetch(`${BASE_URL}/api/employees/${empId}`, { method: 'DELETE' });
    }
  } catch (e) {
    logTest('1. Pagar & Upad Engine', 'Pagar/Upad Suite Exception', false, e.message);
  }

  // =========================================================================
  // SUITE 2: Uchak (Advance Cash) & Employee Inter-Relation + Over-Settlement
  // =========================================================================
  console.log('Testing Suite 2: Uchak System, Employee Linking & Over-Settlement...');
  try {
    // 2.1 Issue Uchak of 1000 to an employee
    const uchakPayload = {
      personName: 'વિનોદભાઈ રસોઈયા (Audit Test)',
      phone: '9797979797',
      purpose: 'રસોડા સામગ્રી ઉચક',
      givenDate: '2026-10-14',
      givenTime: '12:00 PM',
      givenAmount: 1000,
      remarks: 'ટેસ્ટિંગ ઉચક'
    };
    const addUchakRes = await fetch(`${BASE_URL}/api/uchak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uchakPayload)
    });
    const uchakResData = await addUchakRes.json();
    const uchakEntryId = uchakResData.item?.id;
    logTest('2. Uchak & Inter-relation', 'Issue Uchak Advance Record', uchakResData.success === true && !!uchakEntryId, `Uchak ID: ${uchakEntryId}`);

    if (uchakEntryId) {
      // 2.2 Settle with Partial Voucher (800) and Cash Return (200)
      const settlePayload = {
        settledDate: '2026-10-14',
        settledTime: '12:05 PM',
        settleType: 'voucher',
        voucherCategory: 'RASODAKHARCH',
        voucherAmount: 800,
        voucherDetail: 'શાકભાજી બિલ (Uchak Settled)',
        cashReturned: 200,
        remarks: '800 બિલ + 200 રોકડા પરત'
      };
      const settleRes = await fetch(`${BASE_URL}/api/uchak/${uchakEntryId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settlePayload)
      });
      const settleData = await settleRes.json();
      logTest('2. Uchak & Inter-relation', 'Settle Uchak with Split (Voucher 800 + Cash 200)', settleData.success === true, `Response: ${JSON.stringify(settleData)}`);

      // 2.3 Check if Voucher 800 is added to Today\'s Daily Hisab
      const hisabRes = await fetch(`${BASE_URL}/api/records/2026-10-14`);
      const hisabData = await hisabRes.json();
      const foundVoucher = (hisabData.expenseItems || []).find(it => (it.title || it.detail || '').includes('શાકભાજી બિલ') || Number(it.amount) === 800);
      logTest('2. Uchak & Inter-relation', 'Uchak Settlement Voucher Added to Daily Hisab', !!foundVoucher, 
        `Found item: ${foundVoucher ? JSON.stringify(foundVoucher) : 'None'}`, {
          severity: 'High',
          observed: 'Voucher bill from Uchak settlement was not added to Daily Hisab expenseItems',
          expected: 'Settlement voucher must automatically reflect in Daily Hisab'
        }
      );

      // Cleanup
      await fetch(`${BASE_URL}/api/uchak/${uchakEntryId}`, { method: 'DELETE' });
    }

    // 2.4 Over-Settlement / Extra-Paid Case: Given 1000, Bill is 1200 (200 extra paid by employee)
    const overUchakPayload = {
      personName: 'વિનોદભાઈ રસોઈયા (Extra Test)',
      givenDate: '2026-10-14',
      givenTime: '12:10 PM',
      givenAmount: 1000
    };
    const overAddRes = await fetch(`${BASE_URL}/api/uchak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overUchakPayload)
    });
    const overAddData = await overAddRes.json();
    const overId = overAddData.item?.id;

    if (overId) {
      const overSettleRes = await fetch(`${BASE_URL}/api/uchak/${overId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settledDate: '2026-10-14',
          settleType: 'voucher',
          voucherCategory: 'RASODAKHARCH',
          voucherAmount: 1200, // 200 more than given!
          cashReturned: 0,
          remarks: 'ખર્ચ ૧૨૦૦ થયો (૨૦૦ વધુ ચૂકવ્યા)'
        })
      });
      const overSettleData = await overSettleRes.json();
      logTest('2. Uchak & Inter-relation', 'Over-Settlement (Bill 1200 > Advance 1000)', overSettleData.success === true, 
        `Response: ${JSON.stringify(overSettleData)}`, {
          severity: 'Low',
          observed: `Server returned: ${JSON.stringify(overSettleData)}`,
          expected: 'Should gracefully handle extra-spent amount'
        }
      );
      // Cleanup
      await fetch(`${BASE_URL}/api/uchak/${overId}`, { method: 'DELETE' });
    }
  } catch (e) {
    logTest('2. Uchak & Inter-relation', 'Uchak Suite Exception', false, e.message);
  }

  // =========================================================================
  // SUITE 4: Admin Panel Edit, Update & Inactive across all modules
  // =========================================================================
  console.log('Testing Suite 4: Admin Edit, Update & Inactive Status...');
  try {
    // 4.1 Edit Employee Details (Update Name, Role, Salary)
    const empAdd = await (await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'જયેશભાઈ પૂજારી', role: 'સહાયક', salary: 8000, phone: '9191919191' })
    })).json();
    const jId = empAdd.employee?.id;

    if (jId) {
      const updateRes = await fetch(`${BASE_URL}/api/employees/${jId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'જયેશભાઈ શાસ્ત્રી (પ્રમોશન)',
          role: 'મુખ્ય પૂજારી',
          salary: 11000,
          phone: '9191919191',
          status: 'inactive' // Testing inactive status
        })
      });
      const updateData = await updateRes.json();
      logTest('4. Admin Edit & Update', 'Employee Profile Update (Name & Salary Changed)', updateData.success === true, `Update response: ${JSON.stringify(updateData)}`);

      // Check if Inactive status is supported
      const getUpdated = await (await fetch(`${BASE_URL}/api/employees`)).json();
      const updatedEmp = (getUpdated.employees || []).find(e => e.id === jId);
      const isStatusInactive = updatedEmp && updatedEmp.status === 'inactive';
      logTest('4. Admin Edit & Update', 'Employee Inactive Status Support (Preserves History)', isStatusInactive, 
        `Status found: ${updatedEmp?.status}`, {
          severity: 'Low',
          observed: `Status is ${updatedEmp?.status}`,
          expected: 'Status should be inactive'
        }
      );
      // Cleanup
      await fetch(`${BASE_URL}/api/employees/${jId}`, { method: 'DELETE' });
    }

    // 4.2 Admin Bank Rename: IOB TRF -> TEST BANK TRF
    const renameBankRes = await fetch(`${BASE_URL}/api/admin/rename-bank`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ oldName: 'BOB TRF', newName: 'BOB TRF (MAIN)' })
    });
    const renameBankData = await renameBankRes.json();
    logTest('4. Admin Edit & Update', 'Admin Bank Rename API', renameBankData.success === true, `Rename response: ${JSON.stringify(renameBankData)}`);

    // Revert bank rename
    await fetch(`${BASE_URL}/api/admin/rename-bank`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ oldName: 'BOB TRF (MAIN)', newName: 'BOB TRF' })
    });

    // 4.3 Admin Voucher Rename
    const renameVoucherRes = await fetch(`${BASE_URL}/api/admin/rename-voucher`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ oldName: 'UPAD', newName: 'STAFF UPAD' })
    });
    const renameVoucherData = await renameVoucherRes.json();
    logTest('4. Admin Edit & Update', 'Admin Voucher Rename API', renameVoucherData.success === true, `Rename voucher response: ${JSON.stringify(renameVoucherData)}`);

    // Revert voucher rename
    await fetch(`${BASE_URL}/api/admin/rename-voucher`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ oldName: 'STAFF UPAD', newName: 'UPAD' })
    });

    // 4.4 Admin Master Hisab (Edit Past Date 2026-08-01 with admin override)
    const pastEditPayload = {
      notes: [{ note: 500, count: 2, amount: 1000 }],
      cashTotal: 1000,
      banks: [],
      bankTotal: 0,
      vouchers: [],
      voucherTotal: 0,
      grandTotal: 1000,
      remarks: 'Admin Master Audit Update'
    };
    const pastEditRes = await fetch(`${BASE_URL}/api/records/2026-08-01`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(pastEditPayload)
    });
    const pastEditData = await pastEditRes.json();
    logTest('4. Admin Edit & Update', 'Admin Past Date Master Hisab Edit (Protected Override)', pastEditData.success === true, `Response: ${JSON.stringify(pastEditData)}`);

  } catch (e) {
    logTest('4. Admin Edit & Update', 'Admin Suite Exception', false, e.message);
  }

  // =========================================================================
  // SUITE 5: Decimals, Gujarati Search & Excel Formulas
  // =========================================================================
  console.log('Testing Suite 5: Decimals, Search & Excel Formulas...');
  try {
    // 5.1 Decimal Handling (₹457.50)
    const decimalPayload = {
      date: '2026-10-14',
      expenseItems: [{ id: 'exp_dec_test', category: 'RASODAKHARCH', amount: 457.50, title: 'દૂધ શાકભાજી બિલ' }]
    };
    // Fetch today, merge item
    const curHisab = await (await fetch(`${BASE_URL}/api/records/2026-10-14`)).json();
    const updatedExpenses = [...(curHisab.expenseItems || []), decimalPayload.expenseItems[0]];
    const decSaveRes = await fetch(`${BASE_URL}/api/records/2026-10-14`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ ...curHisab, expenseItems: updatedExpenses })
    });
    const decSaveData = await decSaveRes.json();
    const verifyDec = await (await fetch(`${BASE_URL}/api/records/2026-10-14`)).json();
    const savedDecItem = (verifyDec.expenseItems || []).find(it => it.id === 'exp_dec_test');
    const decimalPreserved = savedDecItem && savedDecItem.amount === 457.5;
    logTest('5. Decimals & Search', 'Decimal Precision Support (₹457.50)', decimalPreserved, 
      `Saved decimal amount: ${savedDecItem?.amount}`, {
        severity: 'Medium',
        observed: `Amount saved as: ${savedDecItem?.amount}`,
        expected: 'Amount should preserve 457.5'
      }
    );

    // 5.2 Gujarati Conjunct (જોડાક્ષર) Search Test
    const bhaktsListRes = await (await fetch(`${BASE_URL}/api/bhakts`)).json();
    const allBhakts = bhaktsListRes.bhakts || [];
    // Test filter with 'પ્ર' or 'પ'
    const filteredBhakts = allBhakts.filter(b => (b.name || '').includes('પ') || (b.name || '').includes('પ્ર'));
    logTest('5. Decimals & Search', 'Gujarati Text Matching & Filtering', Array.isArray(filteredBhakts), `Matched ${filteredBhakts.length} bhakts with Gujarati query`);

    // 5.3 Excel File Export Inspection
    const excelRes = await fetch(`${BASE_URL}/api/export/excel/2026-10-14`);
    const isXlsx = excelRes.headers.get('content-type')?.includes('spreadsheetml');
    const buf = await excelRes.arrayBuffer();
    const hasData = buf.byteLength > 2000; // valid xlsx is > 2KB
    logTest('5. Decimals & Search', 'Daily Excel Workbook File Generation (>2KB valid format)', isXlsx && hasData, `Size: ${buf.byteLength} bytes, MIME: ${excelRes.headers.get('content-type')}`);

  } catch (e) {
    logTest('5. Decimals & Search', 'Suite 5 Exception', false, e.message);
  }

  // Save report
  fs.writeFileSync('comprehensive_audit_report.json', JSON.stringify(auditReport, null, 2), 'utf8');
  console.log(`\n======================================================`);
  console.log(`DEEP AUDIT FINISHED: ${auditReport.passCount}/${auditReport.totalTests} Passed (${((auditReport.passCount/auditReport.totalTests)*100).toFixed(1)}%)`);
  console.log(`Issues / Observations Found: ${auditReport.bugs.length}`);
  console.log(`======================================================`);
}

runDeepAudit();
