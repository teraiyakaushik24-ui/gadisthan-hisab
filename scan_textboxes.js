const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const appJs = fs.readFileSync('public/js/app.js', 'utf8');
const gujJs = fs.readFileSync('public/js/gujaratiTyping.js', 'utf8');

const gujInitIds = [
  'expense-input-title',
  'expense-input-remark',
  'remarks-input',
  'admin-input-new-voucher',
  'admin-input-new-bank',
  'quick-upad-title-input',
  'quick-upad-remarks',
  'quick-pagar-title-input',
  'quick-pagar-remarks',
  'emp-form-name',
  'admin-emp-name'
];

// Check all <input> and <textarea> in index.html
const inputRegex = /<(input|textarea)([^>]*)>/gi;
let match;
const allInputs = [];

while ((match = inputRegex.exec(html)) !== null) {
  const tag = match[1].toLowerCase();
  const attrs = match[2];

  const typeMatch = attrs.match(/type=["']([^"']+)["']/i);
  const type = typeMatch ? typeMatch[1].toLowerCase() : (tag === 'textarea' ? 'textarea' : 'text');

  if (['hidden', 'radio', 'checkbox', 'date', 'month', 'time', 'number', 'submit', 'button', 'file'].includes(type)) {
    continue;
  }

  const idMatch = attrs.match(/id=["']([^"']+)["']/i);
  const id = idMatch ? idMatch[1] : '(no id)';

  const classMatch = attrs.match(/class=["']([^"']+)["']/i);
  const cls = classMatch ? classMatch[1] : '';

  const phMatch = attrs.match(/placeholder=["']([^"']+)["']/i);
  const ph = phMatch ? phMatch[1] : '';

  const hasAutoGuj = cls.includes('auto-gujarati') || 
                     attrs.includes('data-transliterate="gu"') || 
                     (id && gujInitIds.includes(id));

  allInputs.push({
    source: 'index.html',
    id,
    type,
    cls,
    ph,
    hasAutoGuj
  });
}

// Also check app.js for dynamically generated input elements
// E.g. in innerHTML or document.createElement
const dynamicInputRegex = /<input([^>]+)>/gi;
while ((match = dynamicInputRegex.exec(appJs)) !== null) {
  const attrs = match[1];
  const typeMatch = attrs.match(/type=["']([^"']+)["']/i);
  const type = typeMatch ? typeMatch[1].toLowerCase() : 'text';

  if (['hidden', 'radio', 'checkbox', 'date', 'month', 'time', 'number', 'submit', 'button', 'file'].includes(type)) {
    continue;
  }

  const idMatch = attrs.match(/id=["']([^"']+)["']/i);
  const id = idMatch ? idMatch[1] : '(dynamic/template)';

  const classMatch = attrs.match(/class=["']([^"']+)["']/i);
  const cls = classMatch ? classMatch[1] : '';

  const phMatch = attrs.match(/placeholder=["']([^"']+)["']/i);
  const ph = phMatch ? phMatch[1] : '';

  const hasAutoGuj = cls.includes('auto-gujarati') || 
                     attrs.includes('data-transliterate="gu"') || 
                     (id && gujInitIds.includes(id));

  allInputs.push({
    source: 'app.js (dynamic)',
    id,
    type,
    cls,
    ph,
    hasAutoGuj
  });
}

console.log('=== TOTAL INPUTS FOUND: ' + allInputs.length + ' ===\n');

console.log('--- [1] AUTO GUJARATI ENABLED (ચાલુ): ---');
allInputs.filter(x => x.hasAutoGuj).forEach((x, i) => {
  console.log(`${i+1}. [${x.id}] (${x.source}) - Placeholder: "${x.ph}"`);
});

console.log('\n--- [2] AUTO GUJARATI NOT ENABLED (બંધ / English/Normal): ---');
allInputs.filter(x => !x.hasAutoGuj).forEach((x, i) => {
  console.log(`${i+1}. [${x.id}] (${x.source}) - Placeholder: "${x.ph}"`);
});
