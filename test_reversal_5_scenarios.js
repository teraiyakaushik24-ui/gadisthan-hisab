const fs = require('fs');

const BASE_URL = 'http://localhost:3000';
const results = [];

function recordScenario(id, title, passed, details, proof) {
  results.push({ id, title, passed, details, proof });
  console.log(`[Scenario ${id}] ${title}: ${passed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`   Details: ${details}`);
  console.log(`   Proof: ${JSON.stringify(proof)}\n`);
}

async function run5ReversalScenarios() {
  console.log('================================================================');
  console.log('   PAGAR / UPAD REVERSAL: 5 RIGOROUS REAL-WORLD SCENARIOS TEST   ');
  console.log('================================================================\n');

  const testDate = '2026-10-14';

  // Helper to get fresh hisab
  const getHisab = async () => (await fetch(`${BASE_URL}/api/records/${testDate}`)).json();
  const getEmp = async (id) => {
    const list = (await (await fetch(`${BASE_URL}/api/employees`)).json()).employees || [];
    return list.find(e => e.id === id);
  };

  // --------------------------------------------------------------------------
  // SCENARIO 1: Single Employee Single Pagar Payout & Complete Reversal to Zero
  // --------------------------------------------------------------------------
  try {
    // 1. Create Employee 1
    const emp1 = (await (await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'કર્મચારી ૧ (ટેસ્ટ ૧)', role: 'સેવક', salary: 12000, phone: '9000000001' })
    })).json()).employee;

    // Get baseline PAGAR voucher
    const hisabBefore = await getHisab();
    const pagarBefore = (hisabBefore.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;

    // Payout 8000
    const pagarRes = await (await fetch(`${BASE_URL}/api/employees/${emp1.id}/pagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: testDate, forMonth: '2026-10', amount: 8000, remarks: 'ટેસ્ટ પગાર ૧' })
    })).json();
    const pagarId = pagarRes.pagar?.id;

    // Verify PAGAR increased
    const hisabAfterPay = await getHisab();
    const pagarAfterPay = (hisabAfterPay.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;

    // Delete payout
    await fetch(`${BASE_URL}/api/employees/${emp1.id}/pagar/${pagarId}`, { method: 'DELETE' });

    // Verify PAGAR reversed back to baseline
    const hisabAfterDel = await getHisab();
    const pagarAfterDel = (hisabAfterDel.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;
    const itemStillThere = (hisabAfterDel.expenseItems || []).some(it => it.id === ('exp_' + pagarId));

    const s1Passed = (pagarAfterPay === pagarBefore + 8000) && (pagarAfterDel === pagarBefore) && !itemStillThere;
    recordScenario(1, 'Single Pagar Payout & Complete Reversal', s1Passed, 
      `Baseline: ₹${pagarBefore} -> Added: ₹${pagarAfterPay} -> After Reversal: ₹${pagarAfterDel}`, {
        pagarBefore,
        pagarAfterPay,
        pagarAfterDel,
        expenseItemRemoved: !itemStillThere
      }
    );

    // Cleanup
    await fetch(`${BASE_URL}/api/employees/${emp1.id}`, { method: 'DELETE' });
  } catch (e) {
    recordScenario(1, 'Single Pagar Exception', false, e.message, {});
  }

  // --------------------------------------------------------------------------
  // SCENARIO 2: Single Employee Single Upad (Advance) & Complete Reversal to Zero
  // --------------------------------------------------------------------------
  try {
    const emp2 = (await (await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'કર્મચારી ૨ (ટેસ્ટ ૨)', role: 'રસોઈયા', salary: 15000, phone: '9000000002' })
    })).json()).employee;

    const hisabBefore = await getHisab();
    const upadBefore = (hisabBefore.vouchers || []).find(v => v.name.trim() === 'UPAD')?.amount || 0;

    // Record Upad 2500
    const upadRes = await (await fetch(`${BASE_URL}/api/employees/${emp2.id}/upad`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: testDate, amount: 2500, remarks: 'ટેસ્ટ ઉપાડ ૨' })
    })).json();
    const upadId = upadRes.upad?.id;

    const hisabAfterUpad = await getHisab();
    const upadAfterUpad = (hisabAfterUpad.vouchers || []).find(v => v.name.trim() === 'UPAD')?.amount || 0;

    // Delete Upad
    await fetch(`${BASE_URL}/api/employees/${emp2.id}/upad/${upadId}`, { method: 'DELETE' });

    const hisabAfterDel = await getHisab();
    const upadAfterDel = (hisabAfterDel.vouchers || []).find(v => v.name.trim() === 'UPAD')?.amount || 0;
    const upadItemStillThere = (hisabAfterDel.expenseItems || []).some(it => it.id === ('exp_' + upadId));

    const s2Passed = (upadAfterUpad === upadBefore + 2500) && (upadAfterDel === upadBefore) && !upadItemStillThere;
    recordScenario(2, 'Single Upad (Advance) & Complete Reversal', s2Passed,
      `Baseline: ₹${upadBefore} -> Added: ₹${upadAfterUpad} -> After Reversal: ₹${upadAfterDel}`, {
        upadBefore,
        upadAfterUpad,
        upadAfterDel,
        expenseItemRemoved: !upadItemStillThere
      }
    );

    await fetch(`${BASE_URL}/api/employees/${emp2.id}`, { method: 'DELETE' });
  } catch (e) {
    recordScenario(2, 'Single Upad Exception', false, e.message, {});
  }

  // --------------------------------------------------------------------------
  // SCENARIO 3: Multiple Employees (A: 5000 + B: 7000 = 12000). Delete ONLY A.
  // Verify B (7000) remains untouched and voucher is exactly 7000.
  // --------------------------------------------------------------------------
  try {
    const empA = (await (await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'કર્મચારી A (ટેસ્ટ ૩)', salary: 10000, phone: '9000000003' })
    })).json()).employee;

    const empB = (await (await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'કર્મચારી B (ટેસ્ટ ૩)', salary: 14000, phone: '9000000004' })
    })).json()).employee;

    const hisabBefore = await getHisab();
    const pagarBase = (hisabBefore.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;

    // Pay A 5000
    const payA = await (await fetch(`${BASE_URL}/api/employees/${empA.id}/pagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: testDate, forMonth: '2026-10', amount: 5000, remarks: 'પગાર A' })
    })).json();

    // Pay B 7000
    const payB = await (await fetch(`${BASE_URL}/api/employees/${empB.id}/pagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: testDate, forMonth: '2026-10', amount: 7000, remarks: 'પગાર B' })
    })).json();

    // Verify voucher is Base + 12000
    const hisabBoth = await getHisab();
    const pagarBoth = (hisabBoth.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;

    // Delete ONLY A (5000)
    await fetch(`${BASE_URL}/api/employees/${empA.id}/pagar/${payA.pagar?.id}`, { method: 'DELETE' });

    // Verify voucher is now Base + 7000 (ONLY B remaining)
    const hisabAfterDelA = await getHisab();
    const pagarAfterDelA = (hisabAfterDelA.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;

    // Verify B's ledger is untouched
    const freshB = await getEmp(empB.id);
    const bStillHasPagar = (freshB.pagars || []).some(p => p.id === payB.pagar?.id);

    const s3Passed = (pagarBoth === pagarBase + 12000) && (pagarAfterDelA === pagarBase + 7000) && bStillHasPagar;
    recordScenario(3, 'Multi-Employee Pagar: Delete One, Preserve Other', s3Passed,
      `Combined (5000+7000): ₹${pagarBoth} -> After Deleting A (5000): ₹${pagarAfterDelA} (B 7000 preserved)`, {
        expectedRemaining: pagarBase + 7000,
        actualRemaining: pagarAfterDelA,
        bLedgerUntouched: bStillHasPagar
      }
    );

    // Cleanup B's pagar and both emps
    await fetch(`${BASE_URL}/api/employees/${empB.id}/pagar/${payB.pagar?.id}`, { method: 'DELETE' });
    await fetch(`${BASE_URL}/api/employees/${empA.id}`, { method: 'DELETE' });
    await fetch(`${BASE_URL}/api/employees/${empB.id}`, { method: 'DELETE' });
  } catch (e) {
    recordScenario(3, 'Multi-Employee Exception', false, e.message, {});
  }

  // --------------------------------------------------------------------------
  // SCENARIO 4: Same Employee has BOTH Upad (2000) and Pagar (6000) on Same Day.
  // Delete ONLY Upad. Verify Pagar voucher remains 6000 and Upad voucher becomes 0.
  // --------------------------------------------------------------------------
  try {
    const empC = (await (await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'કર્મચારી C (ટેસ્ટ ૪)', salary: 16000, phone: '9000000005' })
    })).json()).employee;

    const hisabBefore = await getHisab();
    const upadBase = (hisabBefore.vouchers || []).find(v => v.name.trim() === 'UPAD')?.amount || 0;
    const pagarBase = (hisabBefore.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;

    // Issue Upad 2000
    const upadC = await (await fetch(`${BASE_URL}/api/employees/${empC.id}/upad`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: testDate, amount: 2000, remarks: 'ઉપાડ C' })
    })).json();

    // Issue Pagar 6000
    const pagarC = await (await fetch(`${BASE_URL}/api/employees/${empC.id}/pagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: testDate, forMonth: '2026-10', amount: 6000, remarks: 'પગાર C' })
    })).json();

    // Delete ONLY Upad (2000)
    await fetch(`${BASE_URL}/api/employees/${empC.id}/upad/${upadC.upad?.id}`, { method: 'DELETE' });

    const hisabAfterDelUpad = await getHisab();
    const upadAfterDel = (hisabAfterDelUpad.vouchers || []).find(v => v.name.trim() === 'UPAD')?.amount || 0;
    const pagarAfterDel = (hisabAfterDelUpad.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;

    const s4Passed = (upadAfterDel === upadBase) && (pagarAfterDel === pagarBase + 6000);
    recordScenario(4, 'Cross-Category Isolation: Same Employee Upad vs Pagar', s4Passed,
      `Upad successfully reverted to ₹${upadAfterDel}, while Pagar safely remained intact at ₹${pagarAfterDel}`, {
        expectedUpad: upadBase,
        actualUpad: upadAfterDel,
        expectedPagar: pagarBase + 6000,
        actualPagar: pagarAfterDel
      }
    );

    // Cleanup
    await fetch(`${BASE_URL}/api/employees/${empC.id}/pagar/${pagarC.pagar?.id}`, { method: 'DELETE' });
    await fetch(`${BASE_URL}/api/employees/${empC.id}`, { method: 'DELETE' });
  } catch (e) {
    recordScenario(4, 'Cross-Category Exception', false, e.message, {});
  }

  // --------------------------------------------------------------------------
  // SCENARIO 5: Bulk Pagar Payout (3 Employees: 3000 + 4000 + 5000 = 12000).
  // Delete the middle employee (4000). Verify voucher is exactly 8000.
  // --------------------------------------------------------------------------
  try {
    const e1 = (await (await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'બલ્ક ૧', salary: 10000, phone: '9000000011' })
    })).json()).employee;

    const e2 = (await (await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'બલ્ક ૨', salary: 10000, phone: '9000000012' })
    })).json()).employee;

    const e3 = (await (await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'બલ્ક ૩', salary: 10000, phone: '9000000013' })
    })).json()).employee;

    const hisabBefore = await getHisab();
    const basePagar = (hisabBefore.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;

    // Bulk Payout
    const bulkRes = await (await fetch(`${BASE_URL}/api/employees/bulk-pagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: testDate,
        time: '12:00 PM',
        forMonth: '2026-10',
        addToHisab: true,
        items: [
          { employeeId: e1.id, amount: 3000, remarks: 'બલ્ક ૧' },
          { employeeId: e2.id, amount: 4000, remarks: 'બલ્ક ૨' },
          { employeeId: e3.id, amount: 5000, remarks: 'બલ્ક ૩' }
        ]
      })
    })).json();

    const hisabBulk = await getHisab();
    const pagarBulk = (hisabBulk.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;

    // Find e2's pagar ID
    const freshE2 = await getEmp(e2.id);
    const e2PagarId = freshE2.pagars[0]?.id;

    // Delete e2's payout (4000)
    await fetch(`${BASE_URL}/api/employees/${e2.id}/pagar/${e2PagarId}`, { method: 'DELETE' });

    const hisabAfterDelE2 = await getHisab();
    const pagarAfterDelE2 = (hisabAfterDelE2.vouchers || []).find(v => v.name.trim() === 'PAGAR')?.amount || 0;

    // Verify e1 (3000) and e3 (5000) sum = 8000
    const s5Passed = (pagarBulk === basePagar + 12000) && (pagarAfterDelE2 === basePagar + 8000);
    recordScenario(5, 'Bulk Pagar Partial Reversal', s5Passed,
      `Bulk Total (3000+4000+5000): ₹${pagarBulk} -> After Deleting #2 (4000): ₹${pagarAfterDelE2} (Exact 8000 remaining)`, {
        bulkTotal: pagarBulk,
        expectedAfterDeleteE2: basePagar + 8000,
        actualAfterDeleteE2: pagarAfterDelE2
      }
    );

    // Cleanup remaining
    const freshE1 = await getEmp(e1.id);
    const freshE3 = await getEmp(e3.id);
    if (freshE1.pagars[0]) await fetch(`${BASE_URL}/api/employees/${e1.id}/pagar/${freshE1.pagars[0].id}`, { method: 'DELETE' });
    if (freshE3.pagars[0]) await fetch(`${BASE_URL}/api/employees/${e3.id}/pagar/${freshE3.pagars[0].id}`, { method: 'DELETE' });
    await fetch(`${BASE_URL}/api/employees/${e1.id}`, { method: 'DELETE' });
    await fetch(`${BASE_URL}/api/employees/${e2.id}`, { method: 'DELETE' });
    await fetch(`${BASE_URL}/api/employees/${e3.id}`, { method: 'DELETE' });
  } catch (e) {
    recordScenario(5, 'Bulk Exception', false, e.message, {});
  }

  fs.writeFileSync('reversal_5_scenarios_report.json', JSON.stringify(results, null, 2), 'utf8');
}

run5ReversalScenarios();
