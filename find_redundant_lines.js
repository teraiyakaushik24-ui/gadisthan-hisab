const fs = require('fs');
const code = fs.readFileSync('public/js/app.js', 'utf8');

const targets = [
  'ડાઉનલોડ થઈ રહી છે',
  'લૉક પાછો લાગી ગયો',
  'ફેરફારો રદ કર્યા',
  'સામાન્ય યુઝર મોડ: માત્ર જમા',
  'એડિટ મોડ સક્રિય થયો',
  'આજે કોઈ ખર્ચ નોંધાયેલ નથી',
  'પસંદ કરેલા કર્મચારીઓનો પગાર',
  'ખોલી શકાયું નહીં'
];

const lines = code.split('\n');
targets.forEach(t => {
  lines.forEach((l, idx) => {
    if (l.includes(t)) {
      console.log('LINE ' + (idx + 1) + ': ' + l.trim());
    }
  });
});
