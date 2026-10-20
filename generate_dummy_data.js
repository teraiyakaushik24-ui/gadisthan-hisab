const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// 1. EMPLOYEES DATA
const employees = [
  {
    id: "emp_101",
    name: "હરેશભાઈ પટેલ",
    designation: "મુખ્ય પૂજારી",
    phone: "9879100001",
    salary: 18000,
    initialBalance: 0,
    joiningDate: "2025-01-01",
    status: "active",
    upads: [
      {
        id: "upd_101_1",
        date: "2026-08-12",
        time: "10:30 AM",
        amount: 3000,
        title: "હરેશભાઈ પટેલ - ઘર ખર્ચ ઉપાડ",
        forMonth: "2026-08",
        remarks: "તહેવાર નિમિત્તે ઉપાડ"
      },
      {
        id: "upd_101_2",
        date: "2026-09-14",
        time: "11:15 AM",
        amount: 2500,
        title: "હરેશભાઈ પટેલ - દવા માટે ઉપાડ",
        forMonth: "2026-09",
        remarks: "મેડિકલ ખર્ચ"
      }
    ],
    pagars: [
      {
        id: "pgr_101_aug",
        date: "2026-09-01",
        time: "09:30 AM",
        amount: 15000,
        title: "હરેશભાઈ પટેલ - August 2026 માસનો પગાર",
        forMonth: "2026-08",
        remarks: "માસિક પગાર: ₹18000 | ઉપાડ બાદ: ₹3000 | ચોખ્ખો પગાર: ₹15000",
        totalMonthDays: 31,
        absentDays: 0,
        earnedSalary: 18000,
        openingBalance: 0,
        upadDeduction: 3000
      },
      {
        id: "pgr_101_sep",
        date: "2026-10-01",
        time: "10:00 AM",
        amount: 15500,
        title: "હરેશભાઈ પટેલ - September 2026 માસનો પગાર",
        forMonth: "2026-09",
        remarks: "માસિક પગાર: ₹18000 | ઉપાડ બાદ: ₹2500 | ચોખ્ખો પગાર: ₹15500",
        totalMonthDays: 30,
        absentDays: 0,
        earnedSalary: 18000,
        openingBalance: 0,
        upadDeduction: 2500
      }
    ]
  },
  {
    id: "emp_102",
    name: "મુકેશભાઈ પરમાર",
    designation: "મુખ્ય રસોઈયા",
    phone: "9879100002",
    salary: 13000,
    initialBalance: 0,
    joiningDate: "2025-03-01",
    status: "active",
    upads: [
      {
        id: "upd_102_1",
        date: "2026-08-18",
        time: "02:00 PM",
        amount: 2000,
        title: "મુકેશભાઈ પરમાર - ઉપાડ",
        forMonth: "2026-08",
        remarks: "સામાજિક પ્રસંગ"
      }
    ],
    pagars: [
      {
        id: "pgr_102_aug",
        date: "2026-09-01",
        time: "09:35 AM",
        amount: 11000,
        title: "મુકેશભાઈ પરમાર - August 2026 માસનો પગાર",
        forMonth: "2026-08",
        remarks: "માસિક પગાર: ₹13000 | ઉપાડ બાદ: ₹2000 | ચોખ્ખો પગાર: ₹11000",
        totalMonthDays: 31,
        absentDays: 0,
        earnedSalary: 13000,
        openingBalance: 0,
        upadDeduction: 2000
      },
      {
        id: "pgr_102_sep",
        date: "2026-10-01",
        time: "10:05 AM",
        amount: 13000,
        title: "મુકેશભાઈ પરમાર - September 2026 માસનો પગાર",
        forMonth: "2026-09",
        remarks: "માસિક પગાર: ₹13000 | ચોખ્ખો પગાર: ₹13000",
        totalMonthDays: 30,
        absentDays: 0,
        earnedSalary: 13000,
        openingBalance: 0,
        upadDeduction: 0
      }
    ]
  },
  {
    id: "emp_103",
    name: "દિનેશભાઈ રાઠોડ",
    designation: "સહાયક / સફાઈ સેવક",
    phone: "9879100003",
    salary: 9500,
    initialBalance: 0,
    joiningDate: "2025-05-10",
    status: "active",
    upads: [
      {
        id: "upd_103_1",
        date: "2026-09-10",
        time: "04:30 PM",
        amount: 1500,
        title: "દિનેશભાઈ રાઠોડ - કરિયાણા ઉપાડ",
        forMonth: "2026-09",
        remarks: "ઘર ખર્ચ"
      }
    ],
    pagars: [
      {
        id: "pgr_103_aug",
        date: "2026-09-01",
        time: "09:40 AM",
        amount: 9500,
        title: "દિનેશભાઈ રાઠોડ - August 2026 માસનો પગાર",
        forMonth: "2026-08",
        remarks: "માસિક પગાર: ₹9500 | પૂરો પગાર ચૂકવ્યો",
        totalMonthDays: 31,
        absentDays: 0,
        earnedSalary: 9500,
        openingBalance: 0,
        upadDeduction: 0
      },
      {
        id: "pgr_103_sep",
        date: "2026-10-01",
        time: "10:10 AM",
        amount: 8000,
        title: "દિનેશભાઈ રાઠોડ - September 2026 માસનો પગાર",
        forMonth: "2026-09",
        remarks: "માસિક પગાર: ₹9500 | ઉપાડ બાદ: ₹1500 | ચોખ્ખો પગાર: ₹8000",
        totalMonthDays: 30,
        absentDays: 0,
        earnedSalary: 9500,
        openingBalance: 0,
        upadDeduction: 1500
      }
    ]
  },
  {
    id: "emp_104",
    name: "રાજુભાઈ સોલંકી",
    designation: "ગૌશાળા સંભાળક",
    phone: "9879100004",
    salary: 10500,
    initialBalance: 0,
    joiningDate: "2025-02-15",
    status: "active",
    upads: [],
    pagars: [
      {
        id: "pgr_104_aug",
        date: "2026-09-01",
        time: "09:45 AM",
        amount: 10500,
        title: "રાજુભાઈ સોલંકી - August 2026 માસનો પગાર",
        forMonth: "2026-08",
        remarks: "માસિક પગાર: ₹10500 | પૂરો પગાર ચૂકવ્યો",
        totalMonthDays: 31,
        absentDays: 0,
        earnedSalary: 10500,
        openingBalance: 0,
        upadDeduction: 0
      },
      {
        id: "pgr_104_sep",
        date: "2026-10-01",
        time: "10:15 AM",
        amount: 10500,
        title: "રાજુભાઈ સોલંકી - September 2026 માસનો પગાર",
        forMonth: "2026-09",
        remarks: "માસિક પગાર: ₹10500 | પૂરો પગાર ચૂકવ્યો",
        totalMonthDays: 30,
        absentDays: 0,
        earnedSalary: 10500,
        openingBalance: 0,
        upadDeduction: 0
      }
    ]
  }
];

// 2. BHAKTS DATA
const bhakts = [
  {
    id: "bhakt_1",
    donorId: "101",
    name: "રમેશભાઈ પટેલ",
    phone: "9876543210",
    dailyAmount: 20,
    payType: "daily",
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  },
  {
    id: "bhakt_2",
    donorId: "102",
    name: "હરેશભાઈ શાહ",
    phone: "9825012345",
    dailyAmount: 50,
    payType: "daily",
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  },
  {
    id: "bhakt_3",
    donorId: "103",
    name: "કિરીટભાઈ મહેતા",
    phone: "9426098765",
    dailyAmount: 25,
    payType: "daily",
    status: "active",
    createdAt: "2026-07-15T00:00:00.000Z"
  },
  {
    id: "bhakt_4",
    donorId: "104",
    name: "ભાવેશભાઈ જોષી",
    phone: "9909988776",
    dailyAmount: 100,
    payType: "month_wise",
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z"
  },
  {
    id: "bhakt_5",
    donorId: "105",
    name: "અશોકભાઈ સોની",
    phone: "9712345678",
    dailyAmount: 500,
    payType: "month_wise",
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z"
  }
];

// 3. BHAKT DEPOSITS
const bhaktDeposits = [
  {
    id: "bdep_aug_1",
    bhaktId: "bhakt_1",
    donorId: "101",
    bhaktName: "રમેશભાઈ પટેલ",
    date: "2026-08-31",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    days: 31,
    dailyAmount: 20,
    totalAmount: 620,
    paymentMode: "cash",
    receiptNo: 1001,
    remarks: "August 2026 દાન જમા"
  },
  {
    id: "bdep_aug_2",
    bhaktId: "bhakt_2",
    donorId: "102",
    bhaktName: "હરેશભાઈ શાહ",
    date: "2026-08-31",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    days: 31,
    dailyAmount: 50,
    totalAmount: 1550,
    paymentMode: "cash",
    receiptNo: 1002,
    remarks: "August 2026 દાન જમા"
  },
  {
    id: "bdep_sep_1",
    bhaktId: "bhakt_1",
    donorId: "101",
    bhaktName: "રમેશભાઈ પટેલ",
    date: "2026-09-30",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    days: 30,
    dailyAmount: 20,
    totalAmount: 600,
    paymentMode: "cash",
    receiptNo: 1003,
    remarks: "September 2026 દાન જમા"
  },
  {
    id: "bdep_sep_2",
    bhaktId: "bhakt_2",
    donorId: "102",
    bhaktName: "હરેશભાઈ શાહ",
    date: "2026-09-30",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    days: 30,
    dailyAmount: 50,
    totalAmount: 1500,
    paymentMode: "cash",
    receiptNo: 1004,
    remarks: "September 2026 દાન જમા"
  },
  {
    id: "bdep_sep_3",
    bhaktId: "bhakt_4",
    donorId: "104",
    bhaktName: "ભાવેશભાઈ જોષી",
    date: "2026-09-15",
    periodStart: "2026-08-01",
    periodEnd: "2026-09-30",
    days: 2,
    dailyAmount: 100,
    totalAmount: 200,
    paymentMode: "cash",
    receiptNo: 1005,
    remarks: "બે માસનું ભક્ત દાન"
  }
];

// 4. UCHAK (ADVANCES)
const uchak = [
  {
    id: "uchak_201",
    personName: "મુકેશભાઈ રસોઈયા",
    givenDate: "2026-08-14",
    givenTime: "08:30 AM",
    givenAmount: 5000,
    purpose: "જન્માષ્ટમી રસોડા સામાન ખરીદી",
    status: "settled",
    remainingAmount: 0,
    installments: [
      {
        id: "inst_201_1",
        settledDate: "2026-08-16",
        settledTime: "06:00 PM",
        settleType: "voucher",
        voucherAmount: 4650,
        voucherCategory: "RASODAKHARCH",
        voucherTitle: "જન્માષ્ટમી શાકભાજી તથા અનાજ બિલ",
        cashReturned: 350,
        notes: "બાકી વધેલા ₹350 રોકડા ગલ્લામાં જમા"
      }
    ]
  },
  {
    id: "uchak_202",
    personName: "હરેશભાઈ પટેલ",
    givenDate: "2026-09-20",
    givenTime: "10:15 AM",
    givenAmount: 3500,
    purpose: "મંદિર લાઈટ-ડેકોરેશન સામાન",
    status: "settled",
    remainingAmount: 0,
    installments: [
      {
        id: "inst_202_1",
        settledDate: "2026-09-22",
        settledTime: "05:30 PM",
        settleType: "voucher",
        voucherAmount: 3500,
        voucherCategory: "MANDIRKHARCH",
        voucherTitle: "ડેકોરેશન તથા વાયરિંગ સામાન બિલ",
        cashReturned: 0,
        notes: "વાઉચર બિલથી સંપૂર્ણ પતાવટ"
      }
    ]
  },
  {
    id: "uchak_203",
    personName: "દિનેશભાઈ રાઠોડ",
    givenDate: "2026-10-12",
    givenTime: "09:00 AM",
    givenAmount: 2000,
    purpose: "દિવાળી કલરકામ બ્રશ અને કેમિકલ",
    status: "pending",
    remainingAmount: 2000,
    installments: []
  }
];

// 5. BANK DEPOSITS
const bankDeposits = [
  {
    id: "dep_20260815",
    depositDate: "2026-08-15",
    fromDate: "2026-08-01",
    toDate: "2026-08-14",
    daysCount: 14,
    bankName: "IOB TRF",
    amount: 145000,
    slipNo: "SLIP-0801",
    remarks: "ઓગસ્ટ પ્રથમ પખવાડિયાની રોકડ બેંક જમા"
  },
  {
    id: "dep_20260831",
    depositDate: "2026-08-31",
    fromDate: "2026-08-15",
    toDate: "2026-08-30",
    daysCount: 16,
    bankName: "SBI TRF",
    amount: 172000,
    slipNo: "SLIP-0802",
    remarks: "ઓગસ્ટ બીજા પખવાડિયાની રોકડ બેંક જમા"
  },
  {
    id: "dep_20260915",
    depositDate: "2026-09-15",
    fromDate: "2026-09-01",
    toDate: "2026-09-14",
    daysCount: 14,
    bankName: "BOB TRF",
    amount: 138000,
    slipNo: "SLIP-0901",
    remarks: "સપ્ટેમ્બર પ્રથમ પખવાડિયાની રોકડ બેંક જમા"
  },
  {
    id: "dep_20260930",
    depositDate: "2026-09-30",
    fromDate: "2026-09-15",
    toDate: "2026-09-29",
    daysCount: 15,
    bankName: "IOB TRF",
    amount: 165000,
    slipNo: "SLIP-0902",
    remarks: "સપ્ટેમ્બર બીજા પખવાડિયાની રોકડ બેંક જમા"
  }
];

// 6. GENERATE 76 DAYS OF DAILY HISAB RECORDS (2026-08-01 to 2026-10-15)
const records = {};

// Helper for dates
function getDatesInRange(startDate, endDate) {
  const dates = [];
  let curr = new Date(startDate);
  const end = new Date(endDate);
  while (curr <= end) {
    const y = curr.getFullYear();
    const m = String(curr.getMonth() + 1).padStart(2, '0');
    const d = String(curr.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

const allDates = getDatesInRange('2026-08-01', '2026-10-15');

// Deterministic pseudo-random based on date string
function pseudoRand(seedStr, offset = 0) {
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash << 5) - hash + seedStr.charCodeAt(i) + offset;
    hash |= 0;
  }
  return Math.abs(hash);
}

allDates.forEach((date, dayIdx) => {
  const [year, month, day] = date.split('-').map(Number);
  const daySeed = pseudoRand(date, 7);

  // 1. Cash notes
  // Realistic temple daily collection: ₹8,000 to ₹25,000
  const c500 = 10 + (daySeed % 25); // 10-34 notes (₹5000-₹17000)
  const c200 = 8 + ((daySeed >> 2) % 20); // 8-27 notes (₹1600-₹5400)
  const c100 = 15 + ((daySeed >> 4) % 35); // 15-49 notes (₹1500-₹4900)
  const c50 = 10 + ((daySeed >> 1) % 25); // 10-34 notes (₹500-₹1700)
  const c20 = 10 + ((daySeed >> 3) % 30); // 10-39 notes (₹200-₹780)
  const c10 = 15 + ((daySeed >> 5) % 40); // 15-54 notes (₹150-₹540)

  const notes = [
    { note: 500, count: c500, amount: c500 * 500 },
    { note: 200, count: c200, amount: c200 * 200 },
    { note: 100, count: c100, amount: c100 * 100 },
    { note: 50, count: c50, amount: c50 * 50 },
    { note: 20, count: c20, amount: c20 * 20 },
    { note: 10, count: c10, amount: c10 * 10 }
  ];
  const cashTotal = notes.reduce((s, n) => s + n.amount, 0);
  const noteCountTotal = notes.reduce((s, n) => s + n.count, 0);

  // 2. Bank transfer amounts (IOB, BOB, SBI TRF)
  const b1 = (day % 3 === 0) ? (500 + (daySeed % 5) * 500) : 0;
  const b2 = (day % 4 === 0) ? (1000 + (daySeed % 4) * 500) : 0;
  const b3 = (day % 5 === 0) ? (500 + (daySeed % 6) * 500) : 0;
  const banks = [
    { name: "IOB TRF", amount: b1 },
    { name: "BOB TRF", amount: b2 },
    { name: "SBI TRF", amount: b3 }
  ];
  const bankTotal = banks.reduce((s, b) => s + b.amount, 0);

  // 3. Vouchers & Detailed Expense Items
  const expenseItems = [];
  let expCounter = 1;

  function addExp(cat, title, amt, time = "10:30 AM", remarks = "") {
    if (amt <= 0) return;
    expenseItems.push({
      id: `exp_${date.replace(/-/g, '')}_${expCounter++}`,
      time: time,
      title: title,
      amount: amt,
      category: cat,
      categoryType: "voucher",
      forMonth: date.slice(0, 7),
      remarks: remarks
    });
  }

  // Daily Temple Expenses (Mandirkharch)
  const pujaAmt = 250 + (daySeed % 5) * 50;
  addExp("MANDIRKHARCH", "દૈનિક પૂજાપો, દીવા-વાટ અને ફૂલહાર", pujaAmt, "08:00 AM");

  if (day % 7 === 1) {
    addExp("MANDIRKHARCH", "અગરબત્તી, ધૂપ અને કપૂર જથ્થો", 850, "09:00 AM");
  }
  if (day === 5) {
    addExp("MANDIRKHARCH", "લાઈટ બિલ ચૂકવણું (GEB)", 3420, "11:30 AM", "ઓનલાઈન પાવતી");
  }

  // Daily Kitchen Expenses (Rasodakharch)
  const vegAmt = 450 + (daySeed % 7) * 50;
  addExp("RASODAKHARCH", "દૈનિક શાકભાજી અને લીંબુ-મરચાં", vegAmt, "08:30 AM");

  const milkAmt = 300 + (daySeed % 4) * 60;
  addExp("RASODAKHARCH", "ડેરી દૂધ અને દહીં", milkAmt, "07:30 AM");

  if (day % 10 === 0) {
    addExp("RASODAKHARCH", "રસોડા કરિયાણું (લોટ, તેલ અને મસાલા)", 4200, "11:00 AM");
  }
  if (day === 15) {
    addExp("RASODAKHARCH", "કમર્શિયલ ગેસ સિલિન્ડર રિફિલ (૨ બોટલ)", 3600, "02:00 PM");
  }

  // Gaushala Expenses (ગૌશાળા ખર્ચ)
  if (day % 4 === 0) {
    addExp("ગૌશાળા ખર્ચ", "લીલો ઘાસચારો અને નીણ", 1200 + (daySeed % 4) * 150, "09:45 AM");
  }
  if (day === 20) {
    addExp("ગૌશાળા ખર્ચ", "ગાયો માટે દાણ અને ખોળની ગુણી", 3800, "03:00 PM");
  }

  // Monthly Salaries (PAGAR) on 1st of Sept and 1st of Oct
  if (date === '2026-09-01') {
    addExp("PAGAR", "હરેશભાઈ પટેલ - August 2026 માસનો પગાર", 15000, "09:30 AM", "ઉપાડ બાદ ચોખ્ખો પગાર");
    addExp("PAGAR", "મુકેશભાઈ પરમાર - August 2026 માસનો પગાર", 11000, "09:35 AM", "ઉપાડ બાદ ચોખ્ખો પગાર");
    addExp("PAGAR", "દિનેશભાઈ રાઠોડ - August 2026 માસનો પગાર", 9500, "09:40 AM", "પૂરો પગાર");
    addExp("PAGAR", "રાજુભાઈ સોલંકી - August 2026 માસનો પગાર", 10500, "09:45 AM", "પૂરો પગાર");
  }
  if (date === '2026-10-01') {
    addExp("PAGAR", "હરેશભાઈ પટેલ - September 2026 માસનો પગાર", 15500, "10:00 AM", "ઉપાડ બાદ ચોખ્ખો પગાર");
    addExp("PAGAR", "મુકેશભાઈ પરમાર - September 2026 માસનો પગાર", 13000, "10:05 AM", "પૂરો પગાર");
    addExp("PAGAR", "દિનેશભાઈ રાઠોડ - September 2026 માસનો પગાર", 8000, "10:10 AM", "ઉપાડ બાદ ચોખ્ખો પગાર");
    addExp("PAGAR", "રાજુભાઈ સોલંકી - September 2026 માસનો પગાર", 10500, "10:15 AM", "પૂરો પગાર");
  }

  // Upad entries
  if (date === '2026-08-12') {
    addExp("UPAD", "હરેશભાઈ પટેલ - ઉપાડ", 3000, "10:30 AM", "તહેવાર ઉપાડ");
  }
  if (date === '2026-08-18') {
    addExp("UPAD", "મુકેશભાઈ પરમાર - ઉપાડ", 2000, "02:00 PM", "સામાજિક પ્રસંગ");
  }
  if (date === '2026-09-10') {
    addExp("UPAD", "દિનેશભાઈ રાઠોડ - ઉપાડ", 1500, "04:30 PM", "કરિયાણા ઉપાડ");
  }
  if (date === '2026-09-14') {
    addExp("UPAD", "હરેશભાઈ પટેલ - ઉપાડ", 2500, "11:15 AM", "મેડિકલ ઉપાડ");
  }

  // Calculate voucher sums
  const vSums = {
    "MANDIRKHARCH": 0,
    "RASODAKHARCH": 0,
    "PAGAR": 0,
    "UPAD": 0,
    "ગૌશાળા ખર્ચ": 0
  };

  expenseItems.forEach(it => {
    if (vSums[it.category] !== undefined) {
      vSums[it.category] += it.amount;
    } else {
      vSums[it.category] = it.amount;
    }
  });

  const vouchers = Object.entries(vSums).map(([name, amount]) => ({ name, amount }));
  const voucherTotal = vouchers.reduce((s, v) => s + v.amount, 0);
  const grandTotal = cashTotal + bankTotal + voucherTotal;

  records[date] = {
    date: date,
    notes: notes,
    cashTotal: cashTotal,
    noteCountTotal: noteCountTotal,
    banks: banks,
    bankTotal: bankTotal,
    vouchers: vouchers,
    voucherTotal: voucherTotal,
    grandTotal: grandTotal,
    expenseItems: expenseItems,
    remarks: (day === 1 || day === 15) ? "ઠાકોરજીના વિશેષ ઉત્સવનો હિસાબ" : "",
    updatedAt: new Date(date + "T18:00:00.000Z").toISOString()
  };
});

// Write all generated dummy files
fs.writeFileSync(path.join(DATA_DIR, 'employees.json'), JSON.stringify(employees, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'bhakts.json'), JSON.stringify(bhakts, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'bhakt_deposits.json'), JSON.stringify(bhaktDeposits, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'uchak.json'), JSON.stringify(uchak, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'bank_deposits.json'), JSON.stringify(bankDeposits, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'records.json'), JSON.stringify(records, null, 2), 'utf8');

console.log(`✅ Successfully generated clean local dummy dataset!`);
console.log(`Total Days: ${Object.keys(records).length} (From ${allDates[0]} to ${allDates[allDates.length - 1]})`);
console.log(`Employees: ${employees.length}`);
console.log(`Bhakts: ${bhakts.length}`);
console.log(`Uchak records: ${uchak.length}`);
console.log(`Bank Deposits: ${bankDeposits.length}`);

// Sync to MongoDB Cloud
async function syncToCloud() {
  require('dotenv').config();
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('No MONGODB_URI found, skipping cloud sync.');
    return;
  }
  const dns = require('dns');
  try { dns.setServers(['8.8.8.8', '8.8.4.4']); } catch (e) {}

  const { MongoClient } = require('mongodb');
  let client = null;
  try {
    console.log('🔄 Connecting to MongoDB Cloud to sync dummy data...');
    client = new MongoClient(uri, { connectTimeoutMS: 10000, serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const db = client.db('hisab_db');
    console.log('Connected! Clearing old collections and uploading new 3-month dataset...');

    // 1. Records
    await db.collection('records').deleteMany({});
    const recordDocs = Object.entries(records).map(([date, rec]) => ({ _id: date, ...rec }));
    if (recordDocs.length > 0) {
      await db.collection('records').insertMany(recordDocs);
      console.log(`☁️ Synced ${recordDocs.length} daily records to MongoDB Cloud.`);
    }

    // 2. Employees
    await db.collection('employees').deleteMany({});
    const empDocs = employees.map(e => ({ _id: e.id, ...e }));
    if (empDocs.length > 0) {
      await db.collection('employees').insertMany(empDocs);
      console.log(`☁️ Synced ${empDocs.length} employees to MongoDB Cloud.`);
    }

    // 3. Bhakts
    await db.collection('bhakts').deleteMany({});
    const bhaktDocs = bhakts.map(b => ({ _id: b.id, ...b }));
    if (bhaktDocs.length > 0) {
      await db.collection('bhakts').insertMany(bhaktDocs);
      console.log(`☁️ Synced ${bhaktDocs.length} bhakts to MongoDB Cloud.`);
    }

    // 4. Bhakt Deposits
    await db.collection('bhakt_deposits').deleteMany({});
    const bdepDocs = bhaktDeposits.map(d => ({ _id: d.id, ...d }));
    if (bdepDocs.length > 0) {
      await db.collection('bhakt_deposits').insertMany(bdepDocs);
      console.log(`☁️ Synced ${bdepDocs.length} bhakt deposits to MongoDB Cloud.`);
    }

    // 5. Uchak
    await db.collection('uchak').deleteMany({});
    const uchakDocs = uchak.map(u => ({ _id: u.id, ...u }));
    if (uchakDocs.length > 0) {
      await db.collection('uchak').insertMany(uchakDocs);
      console.log(`☁️ Synced ${uchakDocs.length} uchak records to MongoDB Cloud.`);
    }

    // 6. Bank Deposits
    await db.collection('bank_deposits').deleteMany({});
    const depDocs = bankDeposits.map(d => ({ _id: d.id, ...d }));
    if (depDocs.length > 0) {
      await db.collection('bank_deposits').insertMany(depDocs);
      console.log(`☁️ Synced ${depDocs.length} bank deposits to MongoDB Cloud.`);
    }

    console.log('🎉 MongoDB Cloud is fully synchronized with the 3-month dummy dataset!');
  } catch (err) {
    console.warn('⚠️ Cloud sync notice (saved locally):', err.message);
  } finally {
    if (client) await client.close();
  }
}

syncToCloud();

