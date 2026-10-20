const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const i18nContent = fs.readFileSync('public/js/i18n.js', 'utf8');

// Target modal IDs
const modalIds = [
  'modal-employees',
  'modal-employee-form',
  'modal-employee-ledger',
  'modal-employee-quick-upad',
  'modal-employee-quick-pagar',
  'modal-bulk-pagar-confirm',
  'modal-uchak',
  'modal-uchak-settle',
  'quick-uchak-drawer',
  'floating-uchak-toggle',
  'modal-bank-deposit',
  'modal-bank-deposit-history',
  'modal-bank-accumulated-detail',
  'btn-header-bank-accumulated'
];

modalIds.forEach(id => {
  const startIdx = html.indexOf('id="' + id + '"');
  if (startIdx === -1) {
    console.log('ID not found: ' + id);
    return;
  }
  let endIdx = html.indexOf('id="modal-', startIdx + 30);
  if (endIdx === -1) endIdx = html.indexOf('</aside>', startIdx);
  if (endIdx === -1) endIdx = startIdx + 4000;

  const snippet = html.substring(startIdx, endIdx);

  // Match tags containing Gujarati text: >([^<]*[\u0A80-\u0AFF]+[^<]*)<
  const tagMatches = [...snippet.matchAll(/<([a-zA-Z0-9]+)([^>]*)>([^<]*[\u0A80-\u0AFF]+[^<]*)<\/\1>/g)];
  const withoutI18n = tagMatches.filter(m => {
    const attrs = m[2];
    const text = m[3].trim();
    if (!text) return false;
    return !attrs.includes('data-i18n') && !attrs.includes('data-i18n-title');
  });

  if (withoutI18n.length > 0) {
    console.log('=== ' + id + ' (' + withoutI18n.length + ' tags without data-i18n): ===');
    withoutI18n.slice(0, 10).forEach(m => console.log('   <' + m[1] + m[2] + '>' + m[3].trim() + '</' + m[1] + '>'));
  } else {
    console.log('OK: ' + id + ' has full data-i18n coverage.');
  }
});
