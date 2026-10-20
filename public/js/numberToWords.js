// Indian Currency to Words Converter (English, Hindi, Gujarati)

const NumberToWords = {
  toEnglish(num) {
    if (isNaN(num) || num === 0) return 'Zero Rupees Only';
    num = Math.floor(Math.abs(num));

    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
      'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    function convertTwoDigits(n) {
      if (n < 20) return ones[n];
      const ten = Math.floor(n / 10);
      const rem = n % 10;
      return tens[ten] + (rem > 0 ? ' ' + ones[rem] : '');
    }

    function convertThreeDigits(n) {
      const hundred = Math.floor(n / 100);
      const rem = n % 100;
      let res = '';
      if (hundred > 0) {
        res += ones[hundred] + ' Hundred';
        if (rem > 0) res += ' and ';
      }
      if (rem > 0) {
        res += convertTwoDigits(rem);
      }
      return res;
    }

    const crore = Math.floor(num / 10000000);
    let rem = num % 10000000;
    const lakh = Math.floor(rem / 100000);
    rem = rem % 100000;
    const thousand = Math.floor(rem / 1000);
    rem = rem % 1000;

    const parts = [];
    if (crore > 0) parts.push(convertThreeDigits(crore) + ' Crore');
    if (lakh > 0) parts.push(convertTwoDigits(lakh) + ' Lakh');
    if (thousand > 0) parts.push(convertTwoDigits(thousand) + ' Thousand');
    if (rem > 0) parts.push(convertThreeDigits(rem));

    return parts.join(' ') + ' Rupees Only';
  },

  toHindi(num) {
    if (isNaN(num) || num === 0) return 'शून्य रुपये मात्र';
    num = Math.floor(Math.abs(num));

    const hindiNumbers = [
      '', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छः', 'सात', 'आठ', 'नौ', 'दस',
      'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस', 'बीस',
      'इक्कीस', 'बाईस', 'तेईस', 'चौबीस', 'पच्चीस', 'छब्बीस', 'सत्ताईस', 'अट्ठाईस', 'उनतीस', 'तीस',
      'इकतीस', 'बत्तीस', 'तैंतीस', 'चौंतीस', 'पैंतीस', 'छत्तीस', 'सैंतीस', 'अड़तीस', 'उनतालीस', 'चालीस',
      'इकतालीस', 'बयालीस', 'तैंतालीस', 'चौवालीस', 'पैंतालीस', 'छियालीस', 'सैंतालीस', 'अड़तालीस', 'उनचास', 'पचास',
      'इक्यावन', 'बावन', 'तिरेपन', 'चौवन', 'पचपन', 'छप्पन', 'सत्तावन', 'अट्ठावन', 'उनसठ', 'साठ',
      'इकसठ', 'बासठ', 'तिरेसठ', 'चौंसठ', 'पैंसठ', 'छियासठ', 'सड़सठ', 'अड़सठ', 'उनहत्तर', 'सत्तर',
      'इकहत्तर', 'बहत्तर', 'तिहत्तर', 'चौहत्तर', 'पचहत्तर', 'छिहत्तर', 'सतहत्तर', 'अठहत्तर', 'उनासी', 'अस्सी',
      'इक्यासी', 'बयासी', 'तिरासी', 'चौरासी', 'पचासी', 'छियासी', 'सत्तासी', 'अट्ठासी', 'नवासी', 'नब्बे',
      'इक्यानवे', 'बानवे', 'तिरानवे', 'चौरानवे', 'पंचानवे', 'छियानवे', 'सत्तानवे', 'अट्ठानवे', 'निन्यानवे'
    ];

    function convertTwoDigits(n) {
      return hindiNumbers[n] || '';
    }

    function convertThreeDigits(n) {
      const hundred = Math.floor(n / 100);
      const rem = n % 100;
      let res = '';
      if (hundred > 0) {
        res += hindiNumbers[hundred] + ' सौ';
      }
      if (rem > 0) {
        res += (res ? ' ' : '') + convertTwoDigits(rem);
      }
      return res;
    }

    const crore = Math.floor(num / 10000000);
    let rem = num % 10000000;
    const lakh = Math.floor(rem / 100000);
    rem = rem % 100000;
    const thousand = Math.floor(rem / 1000);
    rem = rem % 1000;

    const parts = [];
    if (crore > 0) parts.push(convertThreeDigits(crore) + ' करोड़');
    if (lakh > 0) parts.push(convertTwoDigits(lakh) + ' लाख');
    if (thousand > 0) parts.push(convertTwoDigits(thousand) + ' हज़ार');
    if (rem > 0) parts.push(convertThreeDigits(rem));

    return parts.join(' ') + ' रुपये मात्र';
  },

  toGujarati(num) {
    if (isNaN(num) || num === 0) return 'શૂન્ય રૂપિયા પૂરા';
    num = Math.floor(Math.abs(num));

    const gujaratiNumbers = [
      '', 'એક', 'બે', 'ત્રણ', 'ચાર', 'પાંચ', 'છ', 'સાત', 'આઠ', 'નવ', 'દસ',
      'અગિયાર', 'બાર', 'તેર', 'ચૌદ', 'પંદર', 'સોળ', 'સત્તર', 'અઢાર', 'ઓગણીસ', 'વીસ',
      'એકવીસ', 'બાવીસ', 'ત્રેવીસ', 'ચોવીસ', 'પચ્ચીસ', 'છવ્વીસ', 'સત્તાવીસ', 'અઠ્ઠાવીસ', 'ઓગણત્રીસ', 'ત્રીસ',
      'એકત્રીસ', 'બત્રીસ', 'તેત્રીસ', 'ચોત્રીસ', 'પાંત્રીસ', 'છત્રીસ', 'સાડત્રીસ', 'આડત્રીસ', 'ઓગણચાલીસ', 'ચાલીસ',
      'એકતાલીસ', 'બેતાલીસ', 'તેતાલીસ', 'ચુમ્માલીસ', 'પિસ્તાલીસ', 'છેતાલીસ', 'સુડતાલીસ', 'અડતાલીસ', 'ઓગણપચાસ', 'પચાસ',
      'એકાવન', 'બાવન', 'ત્રેપન', 'ચોપન', 'પંચાવન', 'છપ્પન', 'સત્તાવન', 'અઠ્ઠાવન', 'ઓગણસાઠ', 'સાઠ',
      'એકસઠ', 'બાસઠ', 'ત્રેસઠ', 'ચોસઠ', 'પાંસઠ', 'છાસઠ', 'સડસઠ', 'અડસઠ', 'અગણોસિત્તેર', 'સિત્તેર',
      'એકોતેર', 'બોતેર', 'તેરોતેર', 'ચુમોતેર', 'પંચોતેર', 'છોતેર', 'સીંતોતેર', 'ઈઠોતેર', 'ઓગણએંસી', 'એંસી',
      'એક્યાસી', 'બ્યાસી', 'ત્યાસી', 'ચોર્યાસી', 'પંચાસી', 'છ્યાસી', 'સત્યાસી', 'અઠ્યાસી', 'નેવ્યાસી', 'નેવું',
      'એકાણું', 'બાણું', 'ત્રાણું', 'ચોરાણું', 'પંચાણું', 'છન્નું', 'સત્તાણું', 'અઠ્ઠાણું', 'નવાણું'
    ];

    function convertTwoDigits(n) {
      return gujaratiNumbers[n] || '';
    }

    function convertThreeDigits(n) {
      const hundred = Math.floor(n / 100);
      const rem = n % 100;
      let res = '';
      if (hundred > 0) {
        res += gujaratiNumbers[hundred] + ' સો';
      }
      if (rem > 0) {
        res += (res ? ' ' : '') + convertTwoDigits(rem);
      }
      return res;
    }

    const crore = Math.floor(num / 10000000);
    let rem = num % 10000000;
    const lakh = Math.floor(rem / 100000);
    rem = rem % 100000;
    const thousand = Math.floor(rem / 1000);
    rem = rem % 1000;

    const parts = [];
    if (crore > 0) parts.push(convertThreeDigits(crore) + ' કરોડ');
    if (lakh > 0) parts.push(convertTwoDigits(lakh) + ' લાખ');
    if (thousand > 0) parts.push(convertTwoDigits(thousand) + ' હજાર');
    if (rem > 0) parts.push(convertThreeDigits(rem));

    return parts.join(' ') + ' રૂપિયા પૂરા';
  },

  format(num, lang = 'gu') {
    if (lang === 'en') return this.toEnglish(num);
    return this.toGujarati(num);
  },

  formatCurrency(num) {
    if (isNaN(num)) return '₹0';
    return '₹ ' + Number(num).toLocaleString('en-IN');
  }
};

if (typeof window !== 'undefined') window.NumberToWords = NumberToWords;
if (typeof module !== 'undefined' && module.exports) module.exports = NumberToWords;
