const fs = require('fs');
const path = require('path');

// Gujarati Category translations
const CATEGORY_NAMES_GU = {
  'MANDIRKHARCH': 'મંદિર ખર્ચ',
  'RASODAKHARCH': 'રસોડા ખર્ચ',
  'PAGAR': 'પગાર ખર્ચ',
  'UPAD': 'ઉપાડ (Advance)',
  'GAUSHALA': 'ગૌશાળા ખર્ચ',
  'ગૌશાળા ખર્ચ': 'ગૌશાળા ખર્ચ',
  'HINDOLAKHARCH': 'હિંડોળા ખર્ચ',
  'BIJLI BILL': 'વીજળી બિલ',
  'FESTIVAL': 'ઉત્સવ ખર્ચ'
};

const CATEGORY_NAMES_EN = {
  'MANDIRKHARCH': 'Temple Expense',
  'RASODAKHARCH': 'Kitchen Expense',
  'PAGAR': 'Salary / Staff',
  'UPAD': 'Advance / Upad',
  'GAUSHALA': 'Gaushala Expense',
  'ગૌશાળા ખર્ચ': 'Gaushala Expense',
  'HINDOLAKHARCH': 'Hindola Expense',
  'BIJLI BILL': 'Electricity Bill',
  'FESTIVAL': 'Festival Expense'
};

/**
 * Format Indian Currency
 */
function formatCurrency(amount) {
  const num = Math.round(Number(amount) || 0);
  return '₹ ' + num.toLocaleString('en-IN');
}

/**
 * Builds a comprehensive data snapshot of the software to feed into Gemini
 */
function buildSoftwareContext(dataSources) {
  const { records = {}, uchak = [], bankDeposits = [], bhaktDeposits = [], settings = {} } = dataSources;

  const dates = Object.keys(records).sort();
  const totalDays = dates.length;
  const firstDate = dates[0] || 'N/A';
  const lastDate = dates[dates.length - 1] || 'N/A';
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

  // Aggregate monthly stats and collect expense items
  const monthlyStats = {};
  const allExpenseItems = [];

  for (const [dateStr, day] of Object.entries(records)) {
    const monthKey = dateStr.slice(0, 7); // e.g. "2026-10"
    if (!monthlyStats[monthKey]) {
      monthlyStats[monthKey] = {
        month: monthKey,
        daysCount: 0,
        cashTotal: 0,
        bankTotal: 0,
        voucherTotal: 0,
        grandTotal: 0,
        categories: {}
      };
    }
    const ms = monthlyStats[monthKey];
    ms.daysCount += 1;
    ms.cashTotal += Number(day.cashTotal) || 0;
    ms.bankTotal += Number(day.bankTotal) || 0;
    ms.voucherTotal += Number(day.voucherTotal) || 0;
    ms.grandTotal += Number(day.grandTotal) || 0;

    if (day.vouchers && Array.isArray(day.vouchers)) {
      day.vouchers.forEach(v => {
        const cat = v.name || 'OTHER';
        ms.categories[cat] = (ms.categories[cat] || 0) + (Number(v.amount) || 0);
      });
    }

    if (day.expenseItems && Array.isArray(day.expenseItems)) {
      day.expenseItems.forEach(item => {
        allExpenseItems.push({
          date: dateStr,
          time: item.time || '',
          title: item.title || '',
          amount: Number(item.amount) || 0,
          category: item.category || item.categoryType || 'OTHER',
          categoryGu: CATEGORY_NAMES_GU[item.category] || item.category,
          forMonth: item.forMonth || monthKey
        });
      });
    }
  }

  // Uchak Summary
  const pendingUchak = uchak.filter(u => u.status === 'pending' || u.status === 'partial' || Number(u.remainingAmount) > 0);
  const settledUchak = uchak.filter(u => u.status === 'settled' || Number(u.remainingAmount) === 0);
  const totalPendingUchak = pendingUchak.reduce((s, u) => s + (Number(u.remainingAmount) || 0), 0);
  const totalGivenUchak = uchak.reduce((s, u) => s + (Number(u.givenAmount) || 0), 0);

  // Today or latest record
  const latestRecord = records[todayStr] || records[lastDate] || null;

  return {
    organization: settings.orgName || 'Shree Swaminarayan Mandir Gadi Sansthan Jetpur',
    todayDate: todayStr,
    databaseDateRange: { from: firstDate, to: lastDate, totalRecordedDays: totalDays },
    monthlySummary: Object.values(monthlyStats),
    latestDayHisab: latestRecord ? {
      date: latestRecord.date,
      cashTotal: latestRecord.cashTotal,
      notesBreakdown: latestRecord.notes,
      bankTransfers: latestRecord.banks,
      bankTotal: latestRecord.bankTotal,
      vouchersSummary: latestRecord.vouchers,
      voucherTotal: latestRecord.voucherTotal,
      grandTotal: latestRecord.grandTotal
    } : null,
    uchakAdvanceRegister: {
      totalActivePendingAmount: totalPendingUchak,
      totalGivenAmount: totalGivenUchak,
      pendingCount: pendingUchak.length,
      settledCount: settledUchak.length,
      activePendingRecords: pendingUchak.map(u => ({
        person: u.personName,
        givenAmount: u.givenAmount,
        remainingAmount: u.remainingAmount,
        givenDate: u.givenDate,
        purpose: u.purpose,
        status: u.status
      })),
      allRecords: uchak.map(u => ({
        person: u.personName,
        givenAmount: u.givenAmount,
        remainingAmount: u.remainingAmount,
        givenDate: u.givenDate,
        purpose: u.purpose,
        status: u.status
      }))
    },
    recentExpenseVouchers: allExpenseItems.slice(-150)
  };
}

/**
 * Direct Gemini API caller with automatic fallback models
 */
async function callGeminiDirect(prompt, apiKey) {
  if (!apiKey || apiKey.trim().length < 10) return null;

  const modelsToTry = [
    { name: 'gemini-3.5-flash-lite', timeout: 4500 },
    { name: 'gemini-flash-lite-latest', timeout: 4000 }
  ];

  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent?key=${apiKey.trim()}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048
          }
        }),
        signal: AbortSignal.timeout(model.timeout)
      });

      if (response.ok) {
        const json = await response.json();
        const text = (json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text);
        if (text && text.trim()) {
          return text.trim();
        }
      }
    } catch (err) {
      // Continue to next model on timeout or rate limit
    }
  }

  return null;
}

/**
 * Parses Gemini response text into structured report JSON
 */
function parseGeminiJson(rawText, defaultQuery, lang = 'gu') {
  if (!rawText) return null;

  let cleaned = rawText.trim();
  // Strip ```json ... ``` wrapper if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && (parsed.narrative || parsed.reportTitle)) {
      return {
        success: true,
        query: defaultQuery,
        reportTitle: parsed.reportTitle || (lang === 'en' ? 'Accounting Report' : 'હિસાબ રિપોર્ટ'),
        period: parsed.period || (lang === 'en' ? 'Verified Hisab' : 'સચોટ હિસાબ'),
        narrative: parsed.narrative || '',
        kpis: Array.isArray(parsed.kpis) ? parsed.kpis : [],
        table: parsed.table && Array.isArray(parsed.table.rows) ? parsed.table : null,
        isGemini: true
      };
    }
  } catch (e) {
    // If Gemini output was plain markdown text instead of JSON
    return {
      success: true,
      query: defaultQuery,
      reportTitle: lang === 'en' ? 'AI Accounting Answer' : 'AI હિસાબ ઉત્તર',
      period: lang === 'en' ? 'Live Query' : 'લાઈવ પ્રશ્નોત્તરી',
      narrative: rawText,
      kpis: [],
      table: null,
      isGemini: true
    };
  }

  return null;
}

/**
 * Main Entry Point: Process user question with Software Data context + Gemini
 */
async function processReportQuery(userQuery, dataSources, lang = 'gu') {
  const isEn = lang === 'en';
  const q = (userQuery || '').trim();
  const apiKey = process.env.GEMINI_API_KEY || (dataSources.settings && dataSources.settings.geminiApiKey);

  // 1. Build software context snapshot
  const context = buildSoftwareContext(dataSources);

  // 2. If Gemini API Key is available, directly call Gemini with the software info
  if (apiKey && apiKey.trim().length > 10) {
    const prompt = `You are the official Chief AI Accountant and Hisab Expert for 'Shree Swaminarayan Mandir Gadi Sansthan Jetpur' (શ્રી સ્વામિનારાયણ મંદિર ગાદીસ્થાન જેતપુર).
Here is the complete verified software data snapshot from the temple's records:
${JSON.stringify(context, null, 2)}

User Question: "${q}"

INSTRUCTIONS:
1. Thoroughly inspect the software data to answer the user's specific question with 100% mathematical accuracy.
2. Language: Respond in ${isEn ? 'English' : 'clean, polite, respectful Gujarati (or Hindi if asked)'}.
3. Formatting: Use Markdown with **bold** for all amounts (₹), dates, khata names, and persons.
4. Structure: If the user asks for a category, expense, uchak, bank transfer, or list, provide a full, clear table of entries.
5. Return STRICTLY a valid JSON object matching this schema without any markdown backtick wrapper:
{
  "reportTitle": "A concise title (e.g. રસોડા ખર્ચ રિપોર્ટ or ઉચક બાકી લિસ્ટ)",
  "period": "Relevant month/dates (e.g. ઑક્ટોબર 2026 or લાઈવ સ્થિતિ)",
  "narrative": "Your detailed explanation and answer in Markdown format",
  "kpis": [
    { "label": "કુલ રકમ", "value": "₹ 14,250", "color": "#b91c1c" },
    { "label": "કુલ એન્ટ્રીઓ", "value": "18 વાઉચર", "color": "#0284c7" }
  ],
  "table": {
    "headers": ["ક્રમ", "તારીખ", "વિગત", "ખાતું", "રકમ (₹)"],
    "rows": [
      ["1", "2026-10-15", "શાકભાજી", "રસોડા ખર્ચ", "₹ 650"]
    ],
    "totalAmount": "₹ 14,250"
  }
}
If no table is needed (for a simple factual question), set "table": null.`;

    const rawAiText = await callGeminiDirect(prompt, apiKey);
    if (rawAiText) {
      const parsedReport = parseGeminiJson(rawAiText, q, lang);
      if (parsedReport) {
        return parsedReport;
      }
    }
  }

  // 3. Fallback Deterministic Engine (in case Gemini is offline or unconfigured)
  return fallbackDeterministicEngine(q, dataSources, lang);
}

/**
 * Deterministic Safety Fallback Engine
 */
function fallbackDeterministicEngine(query, dataSources, lang) {
  const isEn = lang === 'en';
  const q = query.toLowerCase();
  const { records = {}, uchak = [] } = dataSources;

  // Uchak Pending Fallback
  if (q.includes('ઉચક') || q.includes('uchak') || q.includes('બાકી')) {
    const pending = uchak.filter(u => u.remainingAmount > 0 || u.status === 'pending');
    const totalDue = pending.reduce((s, u) => s + (Number(u.remainingAmount) || 0), 0);
    const rows = pending.map((u, i) => [
      i + 1,
      u.givenDate || '-',
      u.personName || '-',
      u.purpose || 'પરચૂરણ કામ',
      formatCurrency(u.givenAmount),
      formatCurrency(u.remainingAmount),
      u.status || 'બાકી'
    ]);

    return {
      success: true,
      query: query,
      reportTitle: isEn ? 'Advance Cash (Uchak) Due List' : 'ઉચક હિસાબ (એડવાન્સ) ચાલુ બાકી લિસ્ટ',
      period: isEn ? 'Live Active Status' : 'લાઈવ ચાલુ સ્થિતિ',
      narrative: isEn
        ? `Currently, there are **${pending.length} person(s)** with active pending advance cash, totaling **${formatCurrency(totalDue)}**.`
        : `ગાદીસ્થાન જેતપુર ઉચક રજિસ્ટર મુજબ કુલ **${pending.length} વ્યક્તિ** પાસે સક્રિય બાકી રકમ છે, જેનો કુલ સરવાળો **${formatCurrency(totalDue)}** થાય છે.`,
      kpis: [
        { label: isEn ? 'Total Due' : 'કુલ બાકી રકમ', value: formatCurrency(totalDue), color: '#b91c1c' },
        { label: isEn ? 'Persons' : 'બાકી વ્યક્તિ', value: `${pending.length}`, color: '#d97706' }
      ],
      table: {
        headers: isEn ? ['#', 'Date', 'Person', 'Purpose', 'Given', 'Due', 'Status'] : ['ક્રમ', 'તારીખ', 'વ્યક્તિનું નામ', 'હેતુ', 'આપેલ રકમ', 'બાકી રકમ', 'સ્થિતિ'],
        rows: rows,
        totalAmount: formatCurrency(totalDue)
      }
    };
  }

  // Kitchen Expense Fallback
  let totalKitchen = 0;
  const kitchenRows = [];
  for (const [d, day] of Object.entries(records)) {
    if (day.expenseItems) {
      day.expenseItems.forEach(item => {
        if ((item.category || '').includes('RASODA') || (item.title || '').includes('શાકભાજી') || (item.title || '').includes('દૂધ')) {
          totalKitchen += Number(item.amount) || 0;
          kitchenRows.push([
            kitchenRows.length + 1,
            d,
            item.title || 'રસોડા સામગ્રી',
            'રસોડા ખર્ચ',
            formatCurrency(item.amount)
          ]);
        }
      });
    }
  }

  return {
    success: true,
    query: query,
    reportTitle: isEn ? 'Kitchen Expense Report' : 'રસોડા ખર્ચ રિપોર્ટ',
    period: 'ચાલુ વર્ષ / મહિનો',
    narrative: `મંદિરના હિસાબ મુજબ રસોડા પેટે કુલ **${formatCurrency(totalKitchen)}** નો ખર્ચ નોંધાયેલ છે (કુલ ${kitchenRows.length} એન્ટ્રીઓ).`,
    kpis: [
      { label: 'કુલ રસોડા ખર્ચ', value: formatCurrency(totalKitchen), color: '#b91c1c' },
      { label: 'કુલ એન્ટ્રીઓ', value: `${kitchenRows.length} વાઉચર`, color: '#0284c7' }
    ],
    table: {
      headers: ['ક્રમ', 'તારીખ', 'વિગત', 'ખાતું', 'રકમ (₹)'],
      rows: kitchenRows.slice(-30),
      totalAmount: formatCurrency(totalKitchen)
    }
  };
}

module.exports = {
  processReportQuery,
  formatCurrency,
  buildSoftwareContext
};
