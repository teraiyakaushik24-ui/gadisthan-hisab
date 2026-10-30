/**
 * GujaratiTyping.js - Automatic English-to-Gujarati Phonetic Transliteration Engine
 * Converts English phonetic typing (e.g. "dudh", "chai", "petrol", "kharch") into Gujarati in real-time.
 * Works both Offline (built-in fast rule engine + dictionary) and Online (Google Input Tools API caching).
 */

const GujaratiTyping = {
  enabled: (function() {
    try {
      const saved = localStorage.getItem('hisab_gujarati_typing_enabled');
      if (saved !== null) return saved === 'true';
    } catch(e) {}
    return false; // Default English as requested
  })(),
  cache: new Map(),
  lastConversion: null, // Stores { el, rawWord, convertedWord, startPos, endPos } for Backspace undo

  // 1. Comprehensive Gujarati Business, Temple, Grocery & Daily Expense Dictionary
  dictionary: {
    // Everyday expenses & groceries
    'dudh': 'દૂધ', 'doodh': 'દૂધ', 'milk': 'દૂધ',
    'chai': 'ચા', 'cha': 'ચા', 'tea': 'ચા', 'chay': 'ચા',
    'shak': 'શાક', 'shakbhaji': 'શાકભાજી', 'sabji': 'શાકભાજી', 'bhaji': 'ભાજી',
    'petrol': 'પેટ્રોલ', 'diesel': 'ડીઝલ', 'dizel': 'ડીઝલ', 'oil': 'ઓઈલ',
    'kharch': 'ખર્ચ', 'kharach': 'ખર્ચ', 'vyay': 'ખર્ચ',
    'pagar': 'પગાર', 'salary': 'પગાર',
    'upad': 'ઉપાડ', 'advance': 'ઉપાડ',
    'baki': 'બાકી', 'jama': 'જમા', 'udhar': 'ઉધાર',
    'rokad': 'રોકડ', 'cash': 'રોકડ', 'cheque': 'ચેક', 'check': 'ચેક', 'bank': 'બેંક',
    'bhadu': 'ભાડું', 'bhada': 'ભાડું', 'rent': 'ભાડું',
    'rickshaw': 'રીક્ષા', 'auto': 'રીક્ષા', 'riksha': 'રીક્ષા', 'tempo': 'ટેમ્પો',
    'gadi': 'ગાડી', 'transport': 'ટ્રાન્સપોર્ટ',
    'lightbill': 'લાઈટ બિલ', 'light': 'લાઈટ', 'bill': 'બિલ', 'bijli': 'વીજળી',
    'kirana': 'કરિયાણું', 'kariyana': 'કરિયાણું', 'kariyanu': 'કરિયાણું',
    'tel': 'તેલ', 'ghee': 'ઘી', 'ghi': 'ઘી',
    'chawal': 'ચોખા', 'chokha': 'ચોખા', 'rice': 'ચોખા',
    'dal': 'દાળ', 'daal': 'દાળ', 'tuver': 'તુવેર', 'mag': 'મગ',
    'khand': 'ખાંડ', 'sugar': 'ખાંડ', 'gol': 'ગોળ', 'jaggery': 'ગોળ',
    'masala': 'મસાલા', 'mirch': 'મરચું', 'marchu': 'મરચું', 'haldi': 'હળદર', 'haldar': 'હળદર',
    'mithu': 'મીઠું', 'namak': 'મીઠું',
    'pani': 'પાણી', 'water': 'પાણી', 'jar': 'જગ',
    'nasto': 'નાસ્તો', 'nashto': 'નાસ્તો', 'biscuit': 'બિસ્કીટ',
    'sabun': 'સાબુ', 'soap': 'સાબુ', 'safai': 'સફાઈ', 'clean': 'સફાઈ', 'sarf': 'સર્ફ',
    'repairing': 'રીપેરીંગ', 'marammat': 'સમારકામ', 'servicing': 'સર્વિસિંગ',

    // Mandir, Temple, Gaushala, Trust specific
    'mandir': 'મંદિર', 'mandirkharch': 'મંદિરખર્ચ',
    'rasoda': 'રસોડા', 'rasodu': 'રસોડું', 'rasodakharch': 'રસોડાખર્ચ',
    'gaushala': 'ગૌશાળા', 'goshala': 'ગૌશાળા', 'ghas': 'ઘાસ', 'pendi': 'ખોળ', 'khal': 'ખોળ',
    'puja': 'પૂજા', 'pooja': 'પૂજા', 'samagri': 'સામગ્રી',
    'darshan': 'દર્શન', 'prasad': 'પ્રસાદ', 'prasadi': 'પ્રસાદી', 'mithai': 'મીઠાઈ',
    'phool': 'ફૂલ', 'ful': 'ફૂલ', 'har': 'હાર', 'mala': 'માળા',
    'agarbatti': 'અગરબત્તી', 'dhoop': 'ધૂપ', 'diva': 'દીવા', 'diwa': 'દીવા',
    'kanku': 'કંકુ', 'kumkum': 'કુમકુમ', 'chandan': 'ચંદન', 'kapur': 'કપૂર',
    'vastra': 'વસ્ત્ર', 'dhwaj': 'ધ્વજ', 'dhwaja': 'ધ્વજા', 'seva': 'સેવા',
    'dharmi': 'ધાર્મિક', 'dharmik': 'ધાર્મિક', 'utsav': 'ઉત્સવ', 'hindola': 'હિંડોળા',

    // Common Gujarati connectors & verbs
    'ane': 'અને', 'ne': 'ને', 'pan': 'પણ', 'mate': 'માટે',
    'nu': 'નું', 'na': 'ના', 'ni': 'ની', 'no': 'નો',
    'thi': 'થી', 'ma': 'માં', 'chhe': 'છે',
    'chukvya': 'ચૂકવ્યા', 'chukvyo': 'ચૂકવ્યો', 'aapya': 'આપ્યા', 'aapyu': 'આપ્યું',
    'lidha': 'લીધા', 'karyo': 'કર્યો', 'karela': 'કરેલા', 'kharedi': 'ખરીદી',

    // Medical, utilities, misc
    'dawa': 'દવા', 'dava': 'દવા', 'medicine': 'દવા', 'doctor': 'ડોક્ટર', 'hospital': 'હોસ્પિટલ',
    'mobile': 'મોબાઇલ', 'recharge': 'રીચાર્જ', 'phone': 'ફોન',
    'stationery': 'સ્ટેશનરી', 'chopda': 'ચોપડા', 'chopo': 'ચોપડો', 'pen': 'પેન', 'kagad': 'કાગળ', 'book': 'બુક',
    'xerox': 'ઝેરોક્ષ', 'print': 'પ્રિન્ટ',
    'litre': 'લીટર', 'liter': 'લીટર', 'ltr': 'લીટર', 'kg': 'કિલો', 'kilo': 'કિલો', 'gram': 'ગ્રામ', 'gm': 'ગ્રામ',
    'dabba': 'ડબ્બો', 'dabbo': 'ડબ્બો', 'packet': 'પેકેટ', 'katto': 'કટ્ટો', 'bori': 'બોરી', 'thali': 'થેલી',

    // Common staff & person names
    'ramesh': 'રમેશ', 'rameshbhai': 'રમેશભાઈ',
    'haresh': 'હરેશ', 'hareshbhai': 'હરેશભાઈ',
    'bharat': 'ભરત', 'bharatbhai': 'ભરતભાઈ',
    'suresh': 'સુરેશ', 'sureshbhai': 'સુરેશભાઈ',
    'mahesh': 'મહેશ', 'maheshbhai': 'મહેશભાઈ',
    'naresh': 'નરેશ', 'nareshbhai': 'નરેશભાઈ',
    'patel': 'પટેલ', 'parmar': 'પરમાર', 'solanki': 'સોલંકી', 'shah': 'શાહ', 'mehta': 'મહેતા',
    'bhai': 'ભાઈ', 'ben': 'બેન', 'kaka': 'કાકા', 'sheth': 'શેઠ', 'seth': 'શેઠ',

    // Words & months
    'aaje': 'આજે', 'kale': 'કાલે', 'mahino': 'મહિનો', 'mas': 'માસ',
    'january': 'જાન્યુઆરી', 'february': 'ફેબ્રુઆરી', 'march': 'માર્ચ', 'april': 'એપ્રિલ',
    'may': 'મે', 'june': 'જૂન', 'july': 'જુલાઈ', 'august': 'ઓગસ્ટ',
    'september': 'સપ્ટેમ્બર', 'october': 'ઓક્ટોબર', 'november': 'નવેમ્બર', 'december': 'ડિસેમ્બર'
  },

  // 2. Offline Phonetic Rule-based transliterator
  phoneticTransliterate(rawWord) {
    if (!rawWord) return '';
    const word = rawWord.toLowerCase();

    // Check direct dictionary first
    if (this.dictionary[word]) return this.dictionary[word];

    // Consonants mapping
    const consonants = [
      { en: 'ksha', gu: 'ક્ષ' }, { en: 'ksho', gu: 'ક્ષો' }, { en: 'kshi', gu: 'ક્ષિ' }, { en: 'ksh', gu: 'ક્ષ્' }, { en: 'x', gu: 'ક્ષ' },
      { en: 'gya', gu: 'જ્ઞ' }, { en: 'gna', gu: 'જ્ઞ' }, { en: 'gn', gu: 'જ્ઞ્' },
      { en: 'shri', gu: 'શ્રી' }, { en: 'shr', gu: 'શ્ર્' },
      { en: 'chhh', gu: 'છ' }, { en: 'chh', gu: 'છ' }, { en: 'ch', gu: 'ચ' },
      { en: 'kh', gu: 'ખ' }, { en: 'gh', gu: 'ઘ' }, { en: 'jh', gu: 'ઝ' }, { en: 'th', gu: 'થ' },
      { en: 'dh', gu: 'ધ' }, { en: 'ph', gu: 'ફ' }, { en: 'bh', gu: 'ભ' }, { en: 'sh', gu: 'શ' },
      { en: 'k', gu: 'ક' }, { en: 'g', gu: 'ગ' }, { en: 'j', gu: 'જ' }, { en: 'z', gu: 'ઝ' },
      { en: 't', gu: 'ત' }, { en: 'd', gu: 'દ' }, { en: 'n', gu: 'ન' },
      { en: 'p', gu: 'પ' }, { en: 'f', gu: 'ફ' }, { en: 'b', gu: 'બ' }, { en: 'm', gu: 'મ' },
      { en: 'y', gu: 'ય' }, { en: 'r', gu: 'ર' }, { en: 'l', gu: 'લ' }, { en: 'v', gu: 'વ' }, { en: 'w', gu: 'વ' },
      { en: 's', gu: 'સ' }, { en: 'h', gu: 'હ' }
    ];

    // Vowel Matras (when preceded by a consonant)
    const matras = [
      { en: 'aee', gu: 'ાઈ' }, { en: 'aai', gu: 'ાઈ' },
      { en: 'aa', gu: 'ા' }, { en: 'ee', gu: 'ી' }, { en: 'oo', gu: 'ૂ' },
      { en: 'ai', gu: 'ૈ' }, { en: 'au', gu: 'ૌ' }, { en: 'ou', gu: 'ૌ' },
      { en: 'a', gu: '' }, // inherent vowel
      { en: 'i', gu: 'િ' }, { en: 'u', gu: 'ુ' }, { en: 'e', gu: 'ે' }, { en: 'o', gu: 'ો' }
    ];

    // Independent Vowels (at word start or after another vowel)
    const indVowels = [
      { en: 'aee', gu: 'આઈ' }, { en: 'aai', gu: 'આઈ' },
      { en: 'aa', gu: 'આ' }, { en: 'ee', gu: 'ઈ' }, { en: 'oo', gu: 'ઊ' },
      { en: 'ai', gu: 'ઐ' }, { en: 'au', gu: 'ઔ' }, { en: 'ou', gu: 'ઔ' },
      { en: 'a', gu: 'અ' }, { en: 'i', gu: 'ઇ' }, { en: 'u', gu: 'ઉ' },
      { en: 'e', gu: 'એ' }, { en: 'o', gu: 'ઓ' }
    ];

    let result = '';
    let i = 0;
    const len = word.length;
    let prevWasConsonant = false;

    while (i < len) {
      // Check special anusvara (e.g. 'am', 'an' before consonant or at end)
      if ((word[i] === 'n' || word[i] === 'm') && prevWasConsonant && (i + 1 === len || !'aeiou'.includes(word[i + 1]))) {
        if (i + 1 < len && !'aeiou'.includes(word[i + 1])) {
          result += 'ં';
          prevWasConsonant = false;
          i++;
          continue;
        }
      }

      // 1. Try matching consonants
      let matchedC = null;
      for (const c of consonants) {
        if (word.startsWith(c.en, i)) {
          matchedC = c;
          break;
        }
      }

      if (matchedC) {
        if (prevWasConsonant) {
          result += '્';
        }
        result += matchedC.gu;
        i += matchedC.en.length;
        prevWasConsonant = true;
        continue;
      }

      // 2. Try matching vowels
      let matchedV = null;
      if (prevWasConsonant) {
        for (const m of matras) {
          if (word.startsWith(m.en, i)) {
            matchedV = m;
            break;
          }
        }
        if (matchedV) {
          result += matchedV.gu;
          i += matchedV.en.length;
          prevWasConsonant = false;
          continue;
        }
      } else {
        for (const v of indVowels) {
          if (word.startsWith(v.en, i)) {
            matchedV = v;
            break;
          }
        }
        if (matchedV) {
          result += matchedV.gu;
          i += matchedV.en.length;
          prevWasConsonant = false;
          continue;
        }
      }

      // Fallback: character not recognized or number / punctuation
      result += word[i];
      prevWasConsonant = false;
      i++;
    }

    return result || rawWord;
  },

  // 3. Fast Synchronous Transliteration (0ms, zero cursor race conditions)
  transliterateWordSync(rawWord) {
    if (!rawWord || rawWord.trim() === '') return rawWord;
    const cleanWord = rawWord.trim();
    const lower = cleanWord.toLowerCase();

    // Already Gujarati or punctuation or numbers
    if (/[\u0A80-\u0AFF]/.test(cleanWord) || /^[\d\s.,;:'"!?()\-+/*%=#@]+$/.test(cleanWord)) {
      return cleanWord;
    }

    // 1. Check direct dictionary
    if (this.dictionary[lower]) {
      return this.dictionary[lower];
    }

    // 2. Check local memory cache
    if (this.cache.has(lower)) {
      return this.cache.get(lower);
    }

    // 3. Offline rule-based engine
    const guj = this.phoneticTransliterate(lower);
    this.cache.set(lower, guj);

    // Warm up Google cache in background asynchronously for next time
    this.fetchGoogleSuggestion(lower);

    return guj;
  },

  // Background Google API Suggestion Fetcher
  async fetchGoogleSuggestion(lower) {
    try {
      const url = `https://inputtools.google.com/request?text=${encodeURIComponent(lower)}&itc=gu-t-i0-und&num=1`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data && data[0] === 'SUCCESS' && data[1]?.[0]?.[1]?.[0]) {
          const apiWord = data[1][0][1][0];
          this.cache.set(lower, apiWord);
        }
      }
    } catch(e) {}
  },

  // 4. Full phrase / sentence transliteration (for paste or blur)
  transliterateSentence(text) {
    if (!text || typeof text !== 'string') return text;
    const tokens = text.split(/([^\w\u0A80-\u0AFF]+)/);
    const converted = tokens.map(token => {
      if (/^[a-zA-Z]+$/.test(token)) {
        return this.transliterateWordSync(token);
      }
      return token;
    });
    return converted.join('');
  },

  transliterateWord(rawWord) {
    if (!rawWord || typeof rawWord !== 'string') return rawWord;
    return this.transliterateSentence(rawWord);
  },

  // 5. Attach transliteration listeners to an input or textarea element
  attach(el) {
    if (!el || el._gujAttached) return;
    el._gujAttached = true;

    // Synchronous word conversion on delimiter
    const handleWordConversion = () => {
      if (!this.enabled) return;
      const text = el.value;
      const cursorPos = el.selectionStart;
      if (cursorPos === null || cursorPos === undefined) return;

      const textBeforeCursor = text.slice(0, cursorPos);
      const match = textBeforeCursor.match(/([a-zA-Z]+)$/);
      if (!match) return;

      const rawWord = match[1];
      const wordStart = cursorPos - rawWord.length;
      const wordEnd = cursorPos;

      const gujWord = this.transliterateWordSync(rawWord);
      if (gujWord && gujWord !== rawWord) {
        const newText = text.slice(0, wordStart) + gujWord + text.slice(wordEnd);
        const newCursorPos = wordStart + gujWord.length;

        this.lastConversion = {
          el,
          rawWord,
          convertedWord: gujWord,
          startPos: wordStart,
          endPos: newCursorPos
        };

        el.value = newText;
        el.setSelectionRange(newCursorPos, newCursorPos);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };

    // Keydown handler
    el.addEventListener('keydown', (e) => {
      // Toggle shortcut: Ctrl + G
      if (e.ctrlKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        this.toggle();
        return;
      }

      if (!this.enabled) return;

      if (e.key === ' ' || e.key === 'Enter' || e.key === ',' || e.key === ';') {
        handleWordConversion();
      } else if (e.key === 'Backspace') {
        // Revert last conversion if cursor is right after it
        if (this.lastConversion && this.lastConversion.el === el) {
          const cur = el.selectionStart;
          if (cur === this.lastConversion.endPos) {
            const raw = this.lastConversion.rawWord;
            const conv = this.lastConversion.convertedWord;
            const s = this.lastConversion.startPos;

            if (el.value.slice(s, cur) === conv) {
              e.preventDefault();
              const newText = el.value.slice(0, s) + raw + el.value.slice(cur);
              el.value = newText;
              el.setSelectionRange(s + raw.length, s + raw.length);
              this.lastConversion = null;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
        }
      }
    });

    // Blur handler: If user typed in English and left field, convert full text
    el.addEventListener('blur', () => {
      if (!this.enabled) return;
      const original = el.value;
      if (/[a-zA-Z]/.test(original)) {
        const converted = this.transliterateSentence(original);
        if (converted !== original) {
          el.value = converted;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
  },

  // Toggle ON/OFF
  toggle() {
    this.enabled = !this.enabled;
    try {
      localStorage.setItem('hisab_gujarati_typing_enabled', String(this.enabled));
    } catch(e) {}
    this.updateBadges();
    if (typeof App !== 'undefined' && App.showToast) {
      App.showToast(
        this.enabled ? '🇮🇳 ગુજરાતી ટાઇપિંગ સક્રિય (Auto Gujarati ON)' : '🔤 અંગ્રેજી ટાઇપિંગ સક્રિય (English ON)',
        this.enabled ? 'success' : 'info'
      );
    }
  },

  updateBadges() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    document.querySelectorAll('.guj-typing-badge').forEach(badge => {
      if (this.enabled) {
        badge.innerHTML = '<span>🇮🇳</span> <span>' + (isEn ? 'Gujarati ON' : 'ગુજરાતી ચાલુ') + '</span>';
        badge.classList.remove('off');
        badge.title = isEn ? 'Gujarati Typing (Ctrl+G)' : 'ગુજરાતી ટાઇપિંગ (Ctrl+G)';
      } else {
        badge.innerHTML = '<span>🔤</span> <span>English ON</span>';
        badge.classList.add('off');
        badge.title = isEn ? 'English Typing (Ctrl+G)' : 'અંગ્રેજી ટાઇપિંગ (Ctrl+G)';
      }
    });
  },

  // Attach to all relevant inputs across the application
  init() {
    const selectorIds = [
      'expense-input-title',
      'expense-input-remark',
      'remarks-input',
      'modal-remarks-textarea',
      'admin-input-new-voucher',
      'quick-upad-title-input',
      'quick-upad-remarks',
      'quick-pagar-title-input',
      'quick-pagar-remarks',
      'emp-form-name',
      'emp-form-role',
      'admin-emp-name',
      'admin-emp-role',
      'fast-uchak-name',
      'bank-deposit-remarks',
      'exp-filter-search',
      'emp-search-input',
      'uchak-search-input'
    ];

    selectorIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) this.attach(el);
    });

    document.querySelectorAll('.auto-gujarati, [data-transliterate="gu"]').forEach(el => {
      this.attach(el);
    });

    this.updateBadges();
  }
};

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => GujaratiTyping.init());
  } else {
    GujaratiTyping.init();
  }
}

if (typeof window !== 'undefined') {
  window.GujaratiTyping = GujaratiTyping;
}
