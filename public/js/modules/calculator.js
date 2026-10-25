// =========================================================================
// ON-SCREEN MINI CALCULATOR MODULE (Alt+C) - HISAB PRO
// =========================================================================

window.AppCalculatorModule = {
  calcExpr: '',
  calcCurrent: '0',
  calcPrev: null,
  calcOperator: null,
  calcResetOnNextDigit: false,
  calcDragInitialized: false,

  toggleCalculator(forceState) {
    const el = document.getElementById('floating-calc-widget');
    if (!el) return;
    const shouldShow = (typeof forceState === 'boolean') ? forceState : (el.style.display === 'none' || !el.style.display);
    if (shouldShow) {
      el.style.display = 'block';
      this.initCalcDrag();
      this.calcUpdateDisplay();
    } else {
      el.style.display = 'none';
    }
  },

  calcUpdateDisplay() {
    const dispEl = document.getElementById('calc-main-display');
    const histEl = document.getElementById('calc-history-expr');
    if (dispEl) dispEl.textContent = this.calcCurrent;
    if (histEl) histEl.textContent = this.calcExpr;
  },

  calcInputDigit(digit) {
    if (this.calcResetOnNextDigit) {
      this.calcCurrent = (digit === '.') ? '0.' : digit;
      this.calcResetOnNextDigit = false;
    } else {
      if (digit === '.') {
        if (!this.calcCurrent.includes('.')) {
          this.calcCurrent += '.';
        }
      } else {
        if (this.calcCurrent === '0') {
          this.calcCurrent = digit;
        } else {
          this.calcCurrent += digit;
        }
      }
    }
    this.calcUpdateDisplay();
  },

  calcInputOp(op) {
    const curNum = parseFloat(this.calcCurrent);
    if (isNaN(curNum)) return;

    if (this.calcOperator && !this.calcResetOnNextDigit) {
      this.calcCompute();
    } else {
      this.calcPrev = curNum;
    }

    this.calcOperator = op;
    const symbolMap = { '+': '+', '-': '−', '*': '×', '/': '÷' };
    this.calcExpr = `${this.calcPrev} ${symbolMap[op] || op}`;
    this.calcResetOnNextDigit = true;
    this.calcUpdateDisplay();
  },

  calcCompute() {
    if (this.calcPrev === null || !this.calcOperator) return;
    const curNum = parseFloat(this.calcCurrent);
    if (isNaN(curNum)) return;
    let result = 0;
    switch (this.calcOperator) {
      case '+': result = this.calcPrev + curNum; break;
      case '-': result = this.calcPrev - curNum; break;
      case '*': result = this.calcPrev * curNum; break;
      case '/': 
        result = (curNum !== 0) ? (this.calcPrev / curNum) : 0; 
        break;
      default: return;
    }
    // Round cleanly to avoid floating point oddities
    result = Math.round(result * 100000000) / 100000000;
    this.calcCurrent = String(result);
    this.calcPrev = result;
  },

  calcEquals() {
    if (!this.calcOperator || this.calcPrev === null) return;
    const symbolMap = { '+': '+', '-': '−', '*': '×', '/': '÷' };
    const prevExpr = `${this.calcPrev} ${symbolMap[this.calcOperator] || this.calcOperator} ${this.calcCurrent} =`;
    this.calcCompute();
    this.calcExpr = prevExpr;
    this.calcOperator = null;
    this.calcPrev = null;
    this.calcResetOnNextDigit = true;
    this.calcUpdateDisplay();
  },

  calcClear() {
    this.calcCurrent = '0';
    this.calcPrev = null;
    this.calcOperator = null;
    this.calcExpr = '';
    this.calcResetOnNextDigit = false;
    this.calcUpdateDisplay();
  },

  calcBackspace() {
    if (this.calcResetOnNextDigit) {
      this.calcCurrent = '0';
      this.calcResetOnNextDigit = false;
    } else {
      if (this.calcCurrent.length > 1) {
        this.calcCurrent = this.calcCurrent.slice(0, -1);
      } else {
        this.calcCurrent = '0';
      }
    }
    this.calcUpdateDisplay();
  },

  calcToggleSign() {
    if (this.calcCurrent !== '0') {
      if (this.calcCurrent.startsWith('-')) {
        this.calcCurrent = this.calcCurrent.substring(1);
      } else {
        this.calcCurrent = '-' + this.calcCurrent;
      }
      this.calcUpdateDisplay();
    }
  },

  calcPercent() {
    const val = parseFloat(this.calcCurrent);
    if (!isNaN(val)) {
      this.calcCurrent = String(val / 100);
      this.calcUpdateDisplay();
    }
  },

  calcCopy() {
    const val = this.calcCurrent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val);
    }
    const btn = document.getElementById('btn-calc-copy-top');
    const lbl = document.getElementById('lbl-calc-copy-text');
    if (btn && lbl) {
      btn.classList.add('copied');
      lbl.textContent = 'Copied! ✓';
      setTimeout(() => {
        btn.classList.remove('copied');
        lbl.textContent = 'Copy';
      }, 1500);
    }
  },

  initCalcDrag() {
    if (this.calcDragInitialized) return;
    this.calcDragInitialized = true;
    const card = document.getElementById('floating-calc-widget');
    const handle = document.getElementById('calc-drag-handle');
    if (!card || !handle) return;

    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = card.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      card.style.right = 'auto';
      card.style.left = `${initialLeft}px`;
      card.style.top = `${initialTop}px`;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newLeft = Math.max(10, Math.min(window.innerWidth - card.offsetWidth - 10, initialLeft + dx));
      const newTop = Math.max(10, Math.min(window.innerHeight - card.offsetHeight - 10, initialTop + dy));
      card.style.left = `${newLeft}px`;
      card.style.top = `${newTop}px`;
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }
};

if (typeof window !== 'undefined' && window.App) {
  Object.assign(window.App, window.AppCalculatorModule);
}
