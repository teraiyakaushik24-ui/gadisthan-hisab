// Main Application Logic for HISAB PRO

const App = {
  currentDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()),
  record: null,
  settings: null,
  isDirty: false,
  autoSaveTimer: null,
  printTopOffset: 140, // exact Excel R1-R26 + 1 inch margin
  printLeftOffset: 43, // exact Excel Col A-C

  // Standard fixed items (managed via Admin Panel)
  activeNotes: [500, 200, 100, 50, 20, 10],
  fixedBanks: ['IOB TRF', 'BOB TRF ', 'SBI TRF'],
  fixedVouchers: ['MANDIRKHARCH', 'RASODAKHARCH', 'PAGAR'],

  // Employees & Salary/Upad state
  employeesList: [],
  selectedEmployeeForLedger: null,
  employeeMonthFilter: '',
  selectedStaffIds: new Set(),
  pendingBulkStaff: [],

  // Uchak / Advance state
  uchakList: [],
  uchakSummary: {
    totalCount: 0,
    pendingCount: 0,
    settledCount: 0,
    totalPendingAmount: 0,
    totalGivenAllTime: 0,
    totalVoucherAllTime: 0,
    totalCashReturnedAllTime: 0
  },
  uchakFilter: 'all',
  uchakSearch: '',
  activeUchakForSettle: null,

  // Temporary working lists inside Admin Modal
  adminData: {
    notes: [],
    banks: [],
    vouchers: []
  },
  showAllVouchers: false,
  authToken: null,

  async init() {
    this.initTheme();
    this.initPrintOffsets();

    // Ensure currentDate is initialized to today immediately
    if (!this.currentDate) {
      this.currentDate = this.getTodayDateStr();
    }

    this.setupEventListeners();

    // Check App Authentication & Auto-Login Gatekeeper
    const isAdminPortal = window.location.pathname.startsWith('/admin');
    const isAuthed = await this.checkAppAuth();

    if (!isAuthed) {
      if (isAdminPortal) {
        // Stay on admin portal so admin login overlay can be used
        const overlay = document.getElementById('admin-login-screen');
        if (overlay) overlay.style.display = 'flex';
        return;
      }
      window.location.replace('/login');
      return; // Stop initialization until authorized
    }

    if (isAdminPortal) {
      let u = null;
      try {
        u = JSON.parse(localStorage.getItem('hisab_user_info') || sessionStorage.getItem('hisab_user_info') || '{}');
      } catch (e) {}

      if (!u || u.role !== 'admin') {
        // Logged-in user is not admin (e.g. staff token). Show admin login screen
        const overlay = document.getElementById('admin-login-screen');
        if (overlay) overlay.style.display = 'flex';
        return;
      }

      this.adminAuthenticated = true;
      this.adminToken = this.authToken;
    }

    await this.initAppData();

    if (isAdminPortal) {
      this.openAdminModal();
    }
  },

  async initAppData() {
    if (!this.currentDate) {
      this.currentDate = this.getTodayDateStr();
    }

    // 1. Load settings first so notes denominations and bank accounts are available
    await this.loadSettings();

    // 2. Load auxiliary records in parallel
    await Promise.all([
      this.loadEmployees(),
      this.loadUchakRecords(),
      this.loadExpenseNameSuggestions(),
      this.loadDues()
    ]);

    const savedLang = localStorage.getItem('hisab_lang');
    const lang = savedLang || (this.settings && this.settings.language) || 'gu';
    i18n.setLang(lang);
    const langSelect = document.getElementById('lang-select');
    if (langSelect) langSelect.value = lang;
    const adminLangSelect = document.getElementById('admin-lang-select');
    if (adminLangSelect) adminLangSelect.value = lang;

    // 3. Set date and load records (updates date picker text and renders all tables)
    await this.setDateAndLoad(this.currentDate);

    this.updateDateControlsState();
    this.updateDateFriendlyDisplay(this.currentDate);
    this.renderRecord();
    this.recalcTotals();
    this.checkCloudStatus();
    this.initUserRoleUI();
  },

  async checkAppAuth() {
    const token = localStorage.getItem('hisab_auth_token') || sessionStorage.getItem('hisab_auth_token');
    if (!token) return false;

    // Verify token with backend
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (data && data.valid) {
        this.authToken = token;
        if (data.user) {
          localStorage.setItem('hisab_user_info', JSON.stringify(data.user));
        }
        return true;
      }
    } catch (e) {
      // Offline fallback: If server unreachable but token exists in localStorage, grant access
      if (token.startsWith('hisab_usr_')) {
        this.authToken = token;
        return true;
      }
    }
    return false;
  },

  showAuthLoginOverlay() {
    window.location.replace('/login');
  },

  hideAuthLoginOverlay() {
    // No-op
  },

  toggleAuthPasswordVisibility() {
    const passInput = document.getElementById('auth-input-password');
    if (!passInput) return;
    passInput.type = passInput.type === 'password' ? 'text' : 'password';
  },

  async handleAuthLogin() {
    const emailEl = document.getElementById('auth-input-email');
    const passEl = document.getElementById('auth-input-password');
    const remEl = document.getElementById('auth-remember-me');
    const errBox = document.getElementById('auth-error-msg');
    const errText = document.getElementById('auth-error-text');
    const submitBtn = document.getElementById('btn-auth-submit');

    const email = (emailEl && emailEl.value.trim()) || '';
    const password = (passEl && passEl.value) || '';
    const rememberMe = remEl ? remEl.checked : true;

    if (!email || !password) {
      if (errBox) errBox.style.display = 'block';
      if (errText) errText.textContent = 'કૃપા કરીને ઇમેઇલ અને પાસવર્ડ બંને દાખલ કરો.';
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>⏳ ચકાસી રહ્યા છીએ...</span>';
    }
    if (errBox) errBox.style.display = 'none';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, rememberMe })
      });
      const data = await res.json();

      if (data.success && data.token) {
        this.authToken = data.token;
        if (rememberMe) {
          localStorage.setItem('hisab_auth_token', data.token);
          localStorage.setItem('hisab_auth_email', data.email);
        } else {
          sessionStorage.setItem('hisab_auth_token', data.token);
        }

        this.hideAuthLoginOverlay();
        await this.initAppData();
        this.showToast('✅ સ્વાગત છે! પ્રવેશ સફળ રહ્યો.', 'success');
      } else {
        if (errBox) errBox.style.display = 'block';
        if (errText) errText.textContent = data.error || 'અમાન્ય ઇમેઇલ અથવા પાસવર્ડ!';
        if (passEl) {
          passEl.value = '';
          passEl.focus();
        }
      }
    } catch (err) {
      if (errBox) errBox.style.display = 'block';
      if (errText) errText.textContent = 'સર્વર સાથે કનેક્ટ થઈ શક્યું નથી: ' + err.message;
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>🔓 પ્રવેશ કરો (Login)</span>';
      }
    }
  },

  async handleAuthLogout() {
    try {
      const token = this.authToken || localStorage.getItem('hisab_auth_token') || sessionStorage.getItem('hisab_auth_token');
      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
      }
    } catch (e) { }
    this.authToken = null;
    localStorage.removeItem('hisab_auth_token');
    sessionStorage.removeItem('hisab_auth_token');
    localStorage.removeItem('hisab_user_info');
    window.location.replace('/login.html');
  },

  async checkCloudStatus(showToast = false) {
    const badge = document.getElementById('cloud-db-badge');
    if (!badge) return;

    // 1. Instant check: If client machine itself has no internet connection
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      badge.style.background = '#f59e0b';
      badge.style.boxShadow = '0 0 5px rgba(245, 158, 11, 0.6)';
      badge.title = 'Offline (Local Cache) - ઇન્ટરનેટ બંધ છે';
      if (showToast) {
        this.showToast('🟡 Offline: ઇન્ટરનેટ બંધ છે, હિસાબ લોકલ સુરક્ષિત રહેશે.', 'warning');
      }
      return;
    }

    // 2. Server check: Pings MongoDB Atlas cluster in real-time
    try {
      const res = await fetch('/api/cloud-status');
      const data = await res.json();
      if (data.online) {
        badge.style.background = '#16a34a';
        badge.style.boxShadow = '0 0 6px #22c55e';
        badge.title = 'Cloud DB Online: MongoDB Atlas Connected';
        if (showToast) {
          this.showToast('🟢 Cloud DB Online (MongoDB Atlas જોડાયેલ છે)', 'success');
        }
      } else {
        badge.style.background = '#f59e0b';
        badge.style.boxShadow = '0 0 5px rgba(245, 158, 11, 0.6)';
        badge.title = 'Offline (Local Cache) - ક્લાઉડ સાથે કનેક્શન નથી';
        if (showToast) {
          this.showToast('🟡 Offline: ક્લાઉડ સાથે કનેક્શન નથી, લોકલ સેવ ચાલુ છે.', 'warning');
        }
      }
    } catch (e) {
      badge.style.background = '#f59e0b';
      badge.style.boxShadow = '0 0 5px rgba(245, 158, 11, 0.6)';
      badge.title = 'Offline (Local Cache)';
      if (showToast) {
        this.showToast('🟡 Offline Mode (Local Cache)', 'warning');
      }
    }
  },

  initTheme() {
    // Only White Skin Theme (Permanent Single Theme)
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('hisab_theme', 'light');
  },

  initPrintOffsets() {
    const savedTop = localStorage.getItem('hisab_print_top');
    const savedLeft = localStorage.getItem('hisab_print_left');
    if (savedTop !== null) {
      const topNum = Number(savedTop);
      if (topNum === 10) {
        this.printTopOffset = 140;
        localStorage.setItem('hisab_print_top', 140);
      } else {
        this.printTopOffset = topNum;
      }
    } else {
      this.printTopOffset = 140;
    }
    if (savedLeft !== null) this.printLeftOffset = Number(savedLeft);
    this.applyOffsetsToCSS();
  },

  applyOffsetsToCSS() {
    document.documentElement.style.setProperty('--print-top-pos', `${this.printTopOffset}mm`);
    document.documentElement.style.setProperty('--print-left-pos', `${this.printLeftOffset}mm`);

    // 1. Admin Panel Sliders & Inputs
    const adminSliderTop = document.getElementById('admin-slider-top-offset');
    const adminSliderLeft = document.getElementById('admin-slider-left-offset');
    const adminNumTop = document.getElementById('admin-input-top-offset-num');
    const adminNumLeft = document.getElementById('admin-input-left-offset-num');
    const adminValTop = document.getElementById('admin-val-top-mm');
    const adminValLeft = document.getElementById('admin-val-left-mm');

    if (adminSliderTop) adminSliderTop.value = this.printTopOffset;
    if (adminSliderLeft) adminSliderLeft.value = this.printLeftOffset;
    if (adminNumTop) adminNumTop.value = this.printTopOffset;
    if (adminNumLeft) adminNumLeft.value = this.printLeftOffset;
    if (adminValTop) adminValTop.textContent = `${this.printTopOffset} mm`;
    if (adminValLeft) adminValLeft.textContent = `${this.printLeftOffset} mm`;

    const adminValTopSummary = document.getElementById('admin-val-top-summary');
    const adminValLeftSummary = document.getElementById('admin-val-left-summary');
    if (adminValTopSummary) adminValTopSummary.textContent = `${this.printTopOffset} mm`;
    if (adminValLeftSummary) adminValLeftSummary.textContent = `${this.printLeftOffset} mm`;

    // 2. Modal Print Preview Sliders & Inputs
    const modalSliderTop = document.getElementById('slider-top-offset');
    const modalSliderLeft = document.getElementById('slider-left-offset');
    const modalValTop = document.getElementById('val-top-mm');
    const modalValLeft = document.getElementById('val-left-mm');
    if (modalSliderTop) modalSliderTop.value = this.printTopOffset;
    if (modalSliderLeft) modalSliderLeft.value = this.printLeftOffset;
    if (modalValTop) modalValTop.textContent = `${this.printTopOffset} mm`;
    if (modalValLeft) modalValLeft.textContent = `${this.printLeftOffset} mm`;

    // 3. Modal Print Preview Box
    const previewBox = document.getElementById('preview-table-box');
    if (previewBox) {
      previewBox.style.top = `${this.printTopOffset}mm`;
      previewBox.style.left = `${this.printLeftOffset}mm`;
    }

    // 4. Admin Live A4 Sheet Preview Box with Real Cloned Table
    const adminPreviewBox = document.getElementById('admin-preview-table-box');
    if (adminPreviewBox) {
      adminPreviewBox.style.top = `${this.printTopOffset}mm`;
      adminPreviewBox.style.left = `${this.printLeftOffset}mm`;
      if (!adminPreviewBox.hasChildNodes() || adminPreviewBox.children.length === 0) {
        this.renderAdminPrintPreview();
      }
    }
    const adminGapText = document.getElementById('admin-preview-gap-text');
    if (adminGapText) {
      adminGapText.textContent = `${this.printTopOffset}mm`;
    }
  },

  renderAdminPrintPreview() {
    this.populateExactExcelPrintDOM();
    const adminPreviewBox = document.getElementById('admin-preview-table-box');
    const exactSheet = document.getElementById('excel-exact-sheet');
    const exactTable = exactSheet?.querySelector('#print-excel-table');
    if (adminPreviewBox && exactTable) {
      const clone = exactTable.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      adminPreviewBox.innerHTML = '';
      adminPreviewBox.appendChild(clone);
      adminPreviewBox.style.top = `${this.printTopOffset}mm`;
      adminPreviewBox.style.left = `${this.printLeftOffset}mm`;
    }
  },

  onOffsetChange(val, type) {
    if (type === 'top') {
      this.printTopOffset = Math.max(0, Number(val) || 0);
    } else if (type === 'left') {
      this.printLeftOffset = Math.max(0, Number(val) || 0);
    } else {
      const sliderTop = document.getElementById('admin-slider-top-offset') || document.getElementById('slider-top-offset');
      const sliderLeft = document.getElementById('admin-slider-left-offset') || document.getElementById('slider-left-offset');
      if (sliderTop) this.printTopOffset = Number(sliderTop.value) || 0;
      if (sliderLeft) this.printLeftOffset = Number(sliderLeft.value) || 0;
    }

    localStorage.setItem('hisab_print_top', this.printTopOffset);
    localStorage.setItem('hisab_print_left', this.printLeftOffset);
    localStorage.setItem('hisab_print_top_default', this.printTopOffset);
    localStorage.setItem('hisab_print_left_default', this.printLeftOffset);
    this.applyOffsetsToCSS();
  },

  savePrintDefault(showToast = true) {
    localStorage.setItem('hisab_print_top_default', this.printTopOffset);
    localStorage.setItem('hisab_print_left_default', this.printLeftOffset);
    localStorage.setItem('hisab_print_top', this.printTopOffset);
    localStorage.setItem('hisab_print_left', this.printLeftOffset);
    if (showToast) {
      const isEn = window.i18n && window.i18n.currentLang === 'en';
      this.showToast(isEn ? `✅ New default position saved! (Top: ${this.printTopOffset}mm, Left: ${this.printLeftOffset}mm)` : `✅ નવી ડિફૉલ્ટ પોઝિશન સેવ થઈ! (Top: ${this.printTopOffset}mm, Left: ${this.printLeftOffset}mm)`, 'success');
    }
  },

  resetPrintDefault() {
    const customTop = localStorage.getItem('hisab_print_top_default');
    const customLeft = localStorage.getItem('hisab_print_left_default');
    this.printTopOffset = customTop !== null ? Number(customTop) : 140;
    this.printLeftOffset = customLeft !== null ? Number(customLeft) : 43;
    localStorage.setItem('hisab_print_top', this.printTopOffset);
    localStorage.setItem('hisab_print_left', this.printLeftOffset);
    this.applyOffsetsToCSS();
    this.renderAdminPrintPreview();
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    this.showToast(isEn ? `↺ Original position reset! (Top: ${this.printTopOffset}mm, Left: ${this.printLeftOffset}mm)` : `↺ મૂળ પોઝિશન રીસેટ થઈ! (Top: ${this.printTopOffset}mm, Left: ${this.printLeftOffset}mm)`, 'info');
  },

  applyOffsetPreset(topMm, leftMm) {
    this.printTopOffset = topMm;
    this.printLeftOffset = leftMm;
    localStorage.setItem('hisab_print_top', this.printTopOffset);
    localStorage.setItem('hisab_print_left', this.printLeftOffset);
    localStorage.setItem('hisab_print_top_default', this.printTopOffset);
    localStorage.setItem('hisab_print_left_default', this.printLeftOffset);
    this.applyOffsetsToCSS();
    this.renderAdminPrintPreview();
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    this.showToast(isEn ? `Print position set: Top ${topMm}mm, Left ${leftMm}mm` : `પ્રિન્ટ પોઝિશન સેટ: Top ${topMm}mm, Left ${leftMm}mm`);
  },

  async loadSettings() {
    try {
      const res = await fetch('/api/settings');
      this.settings = await res.json();
      if (this.settings.notes && this.settings.notes.length > 0) {
        this.activeNotes = this.settings.notes;
      }
      if (this.settings.defaultBanks && this.settings.defaultBanks.length > 0) {
        this.fixedBanks = this.settings.defaultBanks;
      }
      if (this.settings.defaultVouchers && this.settings.defaultVouchers.length > 0) {
        this.fixedVouchers = this.settings.defaultVouchers;
      }
      this.applySettingsToUI();
    } catch (e) {
      console.error('Failed to load settings:', e);
      this.settings = {
        orgName: 'Gadisthan Jetpur',
        orgSubtitle: 'દૈનિક નોટ, બેંક ટ્રાન્સફર અને વાઉચર ખર્ચ હિસાબ પત્રક',
        phone: '9574527642',
        language: 'gu'
      };
    }
  },

  applySettingsToUI() {
    const titleEl = document.getElementById('org-title-display');
    if (titleEl) {
      const name = this.settings.orgName || 'Gadisthan Jetpur';
      if ('value' in titleEl && titleEl.tagName === 'INPUT') {
        titleEl.value = name;
      } else {
        titleEl.textContent = name;
      }
    }
    const subtitleEl = document.getElementById('org-subtitle-display');
    if (subtitleEl) subtitleEl.textContent = this.settings.orgSubtitle || '';
  },

  setupEventListeners() {
    // Live Cloud online/offline connection listeners
    window.addEventListener('online', () => this.checkCloudStatus());
    window.addEventListener('offline', () => this.checkCloudStatus());
    setInterval(() => this.checkCloudStatus(), 20000);

    // Date inputs
    const dateInput = document.getElementById('selected-date-input');
    if (dateInput) {
      dateInput.removeAttribute('max');
      dateInput.value = this.currentDate;
      dateInput.addEventListener('change', (e) => {
        const val = e.target.value;
        if (!val) return;
        this.setDateAndLoad(val);
      });
    }

    // Date Quick buttons
    const btnToday = document.getElementById('btn-date-today');
    if (btnToday) {
      btnToday.addEventListener('click', () => {
        this.setDateAndLoad(this.getTodayDateStr());
      });
    }
    document.getElementById('btn-prev-day').addEventListener('click', () => {
      const prevDate = this.shiftDate(-1);
      this.setDateAndLoad(prevDate);
    });
    document.getElementById('btn-next-day').addEventListener('click', () => {
      const nextDate = this.shiftDate(1);
      this.setDateAndLoad(nextDate);
    });

    // Fixed Header Title (editable via admin panel settings)
    const titleInput = document.getElementById('org-title-display');
    if (titleInput && titleInput.tagName === 'INPUT') {
      titleInput.addEventListener('change', async (e) => {
        this.settings.orgName = e.target.value.trim();
        this.applySettingsToUI();
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.settings)
        });
      });
    }

    // Header logo is display-only (Admin accessible only via secret /admin-login)

    // Expense Diary Button
    const btnExpense = document.getElementById('btn-expense-diary');
    if (btnExpense) {
      btnExpense.addEventListener('click', () => this.openExpenseDiaryModal());
    }

    // Accumulated Bank Cash Button (🏦 એકઠી રોકડ)
    const btnBankAccum = document.getElementById('btn-header-bank-accumulated');
    if (btnBankAccum) {
      btnBankAccum.addEventListener('click', () => this.openBankAccumulatedModal());
    }

    // Header More Menu click outside to auto close
    document.addEventListener('click', (e) => {
      const menuContainer = document.getElementById('header-menu-container');
      if (menuContainer && !menuContainer.contains(e.target)) {
        this.closeHeaderMenu();
      }

      // Custom Calendar Popover click outside to auto close
      const calPop = document.getElementById('custom-calendar-popover');
      const calTrigger = document.getElementById('date-picker-trigger');
      if (calPop && calPop.style.display !== 'none' && !calPop.contains(e.target) && (!calTrigger || !calTrigger.contains(e.target))) {
        this.closeCustomCalendar();
      }
    });

    // Language toggle: Only Gujarati & English
    const langSelect = document.getElementById('lang-select');
    const adminLangSelect = document.getElementById('admin-lang-select');

    const handleLanguageChange = (lang) => {
      const targetLang = lang === 'en' ? 'en' : 'gu';
      i18n.setLang(targetLang);
      this.settings.language = targetLang;
      if (langSelect && langSelect.value !== targetLang) langSelect.value = targetLang;
      if (adminLangSelect && adminLangSelect.value !== targetLang) adminLangSelect.value = targetLang;

      this.updateDateFriendlyDisplay(this.currentDate);
      this.renderRecord();
      this.recalcTotals();
      this.populateExactExcelPrintDOM();

      // Also update Expense Register table & KPIs if active
      if (typeof this.renderExpenseTable === 'function') {
        this.renderExpenseTable();
      }
      if (typeof this.renderExpenseKpis === 'function') {
        this.renderExpenseKpis();
      }

      // Always re-render staff, uchak, and bank summary components in the new language
      if (typeof this.renderEmployeesSummary === 'function' && this.employeesSummary) {
        this.renderEmployeesSummary(this.employeesSummary);
      }
      if (typeof this.renderEmployeesList === 'function') {
        this.renderEmployeesList();
      }
      if (typeof this.renderUchakKPIs === 'function') {
        this.renderUchakKPIs();
      }
      if (typeof this.renderUchakList === 'function') {
        this.renderUchakList();
      }
      if (typeof this.renderQuickUchakList === 'function') {
        this.renderQuickUchakList();
      }
      if (typeof this.updateQuickDrawerUI === 'function') {
        this.updateQuickDrawerUI();
      }
      if (typeof this.updateUchakHeaderBadge === 'function') {
        this.updateUchakHeaderBadge();
      }
      if (typeof this.updateUchakFloatingBanner === 'function') {
        this.updateUchakFloatingBanner();
      }
      if (typeof this.loadBankDepositSummary === 'function') {
        this.loadBankDepositSummary();
      }

      // Re-render Bhakt module components in the new language
      if (typeof this.updateBhaktToolbarActions === 'function') {
        this.updateBhaktToolbarActions();
      }
      if (typeof this.updateBhaktsStats === 'function') {
        this.updateBhaktsStats();
      }
      if (typeof this.renderBhaktsList === 'function' && this.bhaktsList) {
        this.renderBhaktsList(this.bhaktsList);
      }

      // Re-render Admin view components dynamically in the new language
      if (typeof this.adminRenderMasterHisabUI === 'function' && this.adminMasterRecord) {
        this.adminRenderMasterHisabUI();
      }
      if (typeof this.renderAdminLists === 'function') {
        this.renderAdminLists();
      }
      if (typeof this.renderAdminEmployeesList === 'function') {
        this.renderAdminEmployeesList();
      }
      if (typeof this.renderAdminBhaktsList === 'function') {
        this.renderAdminBhaktsList();
      }

      // Update active admin tab placeholders/labels
      const vInp = document.getElementById('admin-input-new-voucher');
      if (vInp) {
        vInp.placeholder = targetLang === 'en'
          ? 'ENTER VOUCHER NAME (E.G. MANDIRKHARCH, LIGHT BILL)'
          : 'ખાતા / વાઉચરનું નામ લખો (દા.ત. રસોઈ, મરામત, લાઈટ બિલ)';
      }
      const globalSaveBtn = document.getElementById('admin-btn-global-save');
      if (globalSaveBtn && globalSaveBtn.style.display !== 'none') {
        globalSaveBtn.innerHTML = `<span>💾</span> <span>${targetLang === 'en' ? 'Save & Apply' : 'સાચવો'}</span>`;
      }

      // Re-render currently open modals if any
      if (document.getElementById('modal-expense-diary')?.classList.contains('active')) {
        this.renderExpenseDiary();
      }
      if (document.getElementById('modal-history')?.classList.contains('active')) {
        this.renderHistoryTable();
      }
      if (document.getElementById('modal-bank-deposit-history')?.classList.contains('active')) {
        this.renderBankDepositHistory();
      }
      if (document.getElementById('modal-bank-accumulated-detail')?.classList.contains('active')) {
        this.fetchBankAccumulatedSummary();
      }

      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.settings)
      });
    };

    if (langSelect) {
      langSelect.addEventListener('change', (e) => handleLanguageChange(e.target.value));
    }
    if (adminLangSelect) {
      adminLangSelect.addEventListener('change', (e) => handleLanguageChange(e.target.value));
    }

    window.addEventListener('hisab-lang-changed', (e) => {
      const lang = e.detail?.lang || 'gu';
      if (langSelect && langSelect.value !== lang) langSelect.value = lang;
      if (adminLangSelect && adminLangSelect.value !== lang) adminLangSelect.value = lang;
      if (this.currentView === 'admin' || document.getElementById('view-admin-dashboard')?.style.display !== 'none') {
        if (typeof this.adminRenderMasterHisabUI === 'function' && this.adminMasterRecord) {
          this.adminRenderMasterHisabUI();
        }
        if (typeof this.renderAdminLists === 'function') {
          this.renderAdminLists();
        }
        if (typeof this.renderAdminEmployeesList === 'function') {
          this.renderAdminEmployeesList();
        }
        if (typeof this.renderAdminBhaktsList === 'function') {
          this.renderAdminBhaktsList();
        }
      }
      if (document.getElementById('modal-employees')?.classList.contains('active')) {
        const m = this.employeeMonthFilter || this.getDefaultSalaryMonth();
        const monthLabel = this.getGujaratiMonthName(m);
        const isEn = (lang === 'en');
        const badge = document.getElementById('emp-month-name-badge');
        if (badge) badge.textContent = monthLabel;
        const thOpening = document.getElementById('th-emp-opening-col');
        if (thOpening) thOpening.textContent = isEn ? 'Previous Due' : 'અગાઉની બાકી';
        const thUpad = document.getElementById('th-emp-upad-col');
        if (thUpad) thUpad.textContent = isEn ? `${monthLabel} Advance` : `${monthLabel} ઉપાડ`;
        const thPaid = document.getElementById('th-emp-paid-col');
        if (thPaid) thPaid.textContent = isEn ? `${monthLabel} Paid` : `${monthLabel} ચૂકવેલ`;
        const thBal = document.getElementById('th-emp-balance-col');
        if (thBal) thBal.textContent = isEn ? `${monthLabel} Payable Salary` : `${monthLabel} ચોખ્ખો બાકી પગાર`;
      }
    });

    // Action buttons
    document.getElementById('btn-print')?.addEventListener('click', () => this.triggerPrint());

    // Global keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      // Ctrl+S to save current record
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        this.saveCurrentRecord(true);
      }

      // Ctrl+P to trigger print
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        this.triggerPrint();
      }

      // Ctrl+T or Alt+T to select Today's Date
      if (((e.ctrlKey || e.metaKey) && (e.key === 't' || e.key === 'T')) ||
          (e.altKey && (e.key === 't' || e.key === 'T' || e.key === 'ત' || e.code === 'KeyT'))) {
        e.preventDefault();
        document.getElementById('btn-date-today')?.click();
      }

      // F1 (or Alt+V): Daily Expense Diary Modal (દૈનિક ખર્ચ ડાયરી)
      if (e.key === 'F1' || (e.altKey && (e.key === 'v' || e.key === 'V' || e.key === 'વ' || e.code === 'KeyV'))) {
        e.preventDefault();
        const expModal = document.getElementById('modal-expense-diary');
        if (expModal && expModal.classList.contains('active')) {
          this.closeModal('modal-expense-diary');
        } else {
          this.openExpenseDiaryModal();
        }
      }

      // F2 (or Alt+B): Unbanked Cash Modal (એકઠી થયેલ રોકડ)
      if (e.key === 'F2' || (e.altKey && (e.key === 'b' || e.key === 'B' || e.key === 'બ' || e.code === 'KeyB'))) {
        e.preventDefault();
        const accumModal = document.getElementById('modal-bank-accumulated-detail');
        const depModal = document.getElementById('modal-bank-deposit');
        if (depModal && depModal.classList.contains('active')) {
          this.closeModal('modal-bank-deposit');
        } else if (accumModal && accumModal.classList.contains('active')) {
          this.closeModal('modal-bank-accumulated-detail');
        } else {
          this.openBankAccumulatedModal();
        }
      }

      // F3 (or Alt+H): History Modal (પાછલો હિસાબ)
      if (e.key === 'F3' || (e.altKey && (e.key === 'h' || e.key === 'H' || e.code === 'KeyH'))) {
        e.preventDefault();
        const histModal = document.getElementById('modal-history');
        if (histModal && histModal.classList.contains('active')) {
          this.closeModal('modal-history');
        } else {
          this.openHistoryModal();
        }
      }

      // F4: Quick Uchak, Shift+F4: Full Uchak Register
      if (e.key === 'F4' || (e.altKey && (e.key === 'u' || e.key === 'U' || e.key === 'ઉ' || e.code === 'KeyU'))) {
        e.preventDefault();
        if (e.shiftKey) {
          this.openUchakModal();
        } else {
          this.toggleQuickUchak();
        }
      }

      // Note: F5 is kept default for browser page refresh (user requested)

      // F6 (or Alt+E): Staff Directory & Salary Modal (કર્મચારીઓ)
      if (e.key === 'F6' || (e.altKey && (e.key === 'e' || e.key === 'E' || e.code === 'KeyE'))) {
        e.preventDefault();
        const empModal = document.getElementById('modal-employees');
        if (empModal && empModal.classList.contains('active')) {
          this.closeModal('modal-employees');
        } else {
          this.openEmployeesModal();
        }
      }

      // F7 (or Alt+D): Dues Modal (લેણાં અને દેવાં / બાકી હિસાબ)
      if (e.key === 'F7' || (e.altKey && (e.key === 'd' || e.key === 'D' || e.key === 'દ' || e.code === 'KeyD'))) {
        e.preventDefault();
        const dModal = document.getElementById('modal-dues');
        if (dModal && dModal.classList.contains('active')) {
          this.closeModal('modal-dues');
        } else {
          this.openDuesModal();
        }
      }

      // F8 (or Alt+C): On-Screen Mini Calculator
      if (e.key === 'F8' || (e.altKey && (e.key === 'c' || e.key === 'C' || e.key === 'ક' || e.code === 'KeyC'))) {
        e.preventDefault();
        this.toggleCalculator();
      }

      // F12: Shortcuts Help Modal (શોર્ટકટ હેલ્પ)
      if (e.key === 'F12') {
        e.preventDefault();
        this.openShortcutsHelpModal();
      }

      // Alt+M to toggle Header Menu
      if (e.altKey && (e.key === 'm' || e.key === 'M' || e.key === 'મ' || e.code === 'KeyM')) {
        e.preventDefault();
        this.toggleHeaderMenu(e);
      }

      // Alt+Left to go to Previous Day
      if (e.altKey && (e.key === 'ArrowLeft' || e.code === 'ArrowLeft')) {
        e.preventDefault();
        document.getElementById('btn-prev-day')?.click();
      }

      // Alt+Right to go to Next Day
      if (e.altKey && (e.key === 'ArrowRight' || e.code === 'ArrowRight')) {
        e.preventDefault();
        document.getElementById('btn-next-day')?.click();
      }

      // If Floating Calculator is open, handle keyboard/numpad entries
      const calcWidget = document.getElementById('floating-calc-widget');
      if (calcWidget && calcWidget.style.display !== 'none') {
        if (e.key === 'Escape') {
          this.toggleCalculator(false);
          return;
        }
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        const isTyping = (activeTag === 'input' || activeTag === 'textarea' || document.activeElement?.isContentEditable);
        if (!isTyping) {
          if (e.key >= '0' && e.key <= '9') {
            e.preventDefault();
            this.calcInputDigit(e.key);
            return;
          } else if (e.key === '.') {
            e.preventDefault();
            this.calcInputDigit('.');
            return;
          } else if (e.key === '+' || e.key === '-' || e.key === '*' || e.key === '/') {
            e.preventDefault();
            this.calcInputOp(e.key);
            return;
          } else if (e.key === 'Enter' || e.key === '=') {
            e.preventDefault();
            this.calcEquals();
            return;
          } else if (e.key === 'Backspace') {
            e.preventDefault();
            this.calcBackspace();
            return;
          } else if (e.key === 'c' || e.key === 'C') {
            e.preventDefault();
            this.calcClear();
            return;
          }
        }
      }

      // Escape closes the topmost active modal or Quick Uchak Drawer
      if (e.key === 'Escape') {
        const activeModals = Array.from(document.querySelectorAll('.modal-overlay.active'));
        if (activeModals.length > 0) {
          // Sort descending by z-index so child modals close first
          activeModals.sort((a, b) => {
            const za = parseInt(window.getComputedStyle(a).zIndex) || 0;
            const zb = parseInt(window.getComputedStyle(b).zIndex) || 0;
            return zb - za;
          });
          this.closeModal(activeModals[0].id);
          return;
        }
        const drawer = document.getElementById('quick-uchak-drawer');
        if (drawer && drawer.classList.contains('open')) {
          this.toggleQuickUchak(false);
          return;
        }
      }
    });

    // Backdrop click-outside to close modals immediately
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          this.closeModal(overlay.id);
        }
      });
    });

    // Also quick uchak drawer backdrop click
    const quickOverlay = document.getElementById('quick-uchak-overlay');
    if (quickOverlay) {
      quickOverlay.addEventListener('click', () => {
        this.toggleQuickUchak(false);
      });
    }

    // Apply shortcut badges & hover tooltips to all interactive shortcut elements
    this.applyShortcutTooltips();
  },

  applyShortcutTooltips() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const shortcutMap = [
      { sel: '#btn-expense-diary', shortcut: 'F1', pos: 'bottom', title: isEn ? 'Daily Expense Diary (F1)' : 'ખર્ચ ડાયરી (F1)' },
      { sel: '#btn-header-bank-accumulated', shortcut: 'F2', pos: 'bottom', title: isEn ? 'Unbanked Cash (F2)' : 'એકઠી થયેલ રોકડ (F2)' },
      { sel: '#btn-history', shortcut: 'F3', pos: 'left', title: isEn ? 'Past History (F3)' : 'પાછલો હિસાબ (F3)' },
      { sel: '#btn-uchak-menu', shortcut: 'F4', pos: 'left', title: isEn ? 'Quick Uchak (F4)' : 'ઉચક હિસાબ (F4)' },
      { sel: '#btn-employees-menu', shortcut: 'F6', pos: 'left', title: isEn ? 'Staff Directory & Salary (F6)' : 'કર્મચારીઓ (F6)' },
      { sel: '#btn-dues-menu', shortcut: 'F7', pos: 'left', title: isEn ? 'Dues (F7)' : 'લેણાં - દેવાં (F7)' },
      { sel: '#btn-calc-menu', shortcut: 'F8', pos: 'left', title: isEn ? 'Calculator (F8)' : 'કેલ્ક્યુલેટર (F8)' },
      { sel: '#btn-shortcuts-help-menu', shortcut: 'F12', pos: 'left', title: isEn ? 'Shortcuts Guide (F12)' : 'શોર્ટકટ હેલ્પ (F12)' },
      { sel: '#btn-header-more-menu', shortcut: 'Alt+M', pos: 'bottom', title: isEn ? 'Menu (Alt+M)' : 'મેનુ (Alt+M)' },
      { sel: '#btn-prev-day', shortcut: 'Alt+←', pos: 'bottom', title: isEn ? 'Previous Day (Alt+←)' : 'અગાઉનો દિવસ (Alt+←)' },
      { sel: '#btn-next-day', shortcut: 'Alt+→', pos: 'bottom', title: isEn ? 'Next Day (Alt+→)' : 'આગળનો દિવસ (Alt+→)' },
      { sel: '#btn-date-today', shortcut: 'Ctrl+T', pos: 'bottom', title: isEn ? "Today's Record (Ctrl+T)" : 'આજનો હિસાબ (Ctrl+T)' },
      { sel: '#btn-print', shortcut: 'Ctrl+P', pos: 'top', title: isEn ? 'Print (Ctrl+P)' : 'પ્રિન્ટ કરો (Ctrl+P)' },
      { sel: '#btn-open-remarks-modal', shortcut: 'Ctrl+S', pos: 'top', title: isEn ? 'Save & Special Remarks (Ctrl+S)' : 'વિશેષ નોંધ અને સેવ (Ctrl+S)' },
      { sel: '.quick-drawer-close', shortcut: 'Esc', pos: 'left', title: isEn ? 'Close (Esc)' : 'બંધ કરો (Esc)' },
      { sel: '.btn-fast-uchak-add-modal', shortcut: 'F4', pos: 'top', title: isEn ? 'New Uchak (F4)' : 'નવા ઉચક આપો (F4)' },
      { sel: '.btn-uchak-banner-quick', shortcut: 'F4', pos: 'bottom', title: isEn ? 'Uchak Panel (F4)' : 'ઉચક પેનલ (F4)' }
    ];

    shortcutMap.forEach(item => {
      document.querySelectorAll(item.sel).forEach(el => {
        el.setAttribute('data-shortcut', item.shortcut);
        if (item.pos) el.setAttribute('data-shortcut-pos', item.pos);
        el.setAttribute('title', item.title);
      });
    });

    // Automatically tag all modal close buttons with 'Esc'
    document.querySelectorAll('.modal-close-btn, .btn-icon-close').forEach(btn => {
      if (!btn.hasAttribute('data-shortcut')) {
        btn.setAttribute('data-shortcut', 'Esc');
        btn.setAttribute('data-shortcut-pos', 'left');
      }
      btn.setAttribute('title', isEn ? 'Close (Esc)' : 'બંધ કરો (Esc)');
    });
  },

  openShortcutsHelpModal() {
    let modal = document.getElementById('modal-shortcuts-help');
    if (!modal) {
      this.createShortcutsHelpModal();
      modal = document.getElementById('modal-shortcuts-help');
    }
    if (modal) {
      if (modal.classList.contains('active')) {
        this.closeModal('modal-shortcuts-help');
      } else {
        this.openModal('modal-shortcuts-help');
      }
    }
  },

  createShortcutsHelpModal() {
    if (document.getElementById('modal-shortcuts-help')) return;
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'modal-shortcuts-help';
    modal.innerHTML = `
      <div class="modal-box" style="max-width: 580px; border-radius: 20px; overflow: hidden; box-shadow: 0 25px 60px rgba(0,0,0,0.3);">
        <div class="modal-header" style="background: linear-gradient(135deg, #1e293b, #0f172a); color: #ffffff; padding: 16px 20px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.4rem;">⌨️</span>
            <div>
              <h3 style="margin: 0; font-size: 1.15rem; color: #ffffff;">\${isEn ? 'Keyboard Shortcuts Guide' : 'કીબોર્ડ શોર્ટકટ્સ માર્ગદર્શિકા'}</h3>
              <p style="margin: 2px 0 0; font-size: 0.78rem; color: #94a3b8;">\${isEn ? 'Fast navigation & operations' : 'ઝડપી હિસાબ અને નેવિગેશન માટે શોર્ટકટ્સ'}</p>
            </div>
          </div>
          <button class="modal-close-btn" style="color: #ffffff;" onclick="App.closeModal('modal-shortcuts-help')">✕</button>
        </div>
        <div class="modal-body" style="padding: 20px; max-height: 70vh; overflow-y: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 0.88rem;">
            <thead>
              <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0; text-align: left;">
                <th style="padding: 10px; color: #475569; font-weight: 800;">\${isEn ? 'Shortcut Key' : 'શોર્ટકટ કી'}</th>
                <th style="padding: 10px; color: #475569; font-weight: 800;">\${isEn ? 'Function / Action' : 'કાર્ય / સુવિધા'}</th>
              </tr>
            </thead>
            <tbody>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">F1</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">📖 \${isEn ? 'Daily Expense Diary' : 'દૈનિક ખર્ચ ડાયરી'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">F2</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">🏦 \${isEn ? 'Unbanked Cash Balance' : 'એકઠી થયેલ રોકડ (બેંક જમા બાકી)'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">F3</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">📜 \${isEn ? 'Past History Ledger' : 'પાછલો હિસાબ / ઇતિહાસ'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">F4</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">💸 \${isEn ? 'Quick Uchak Drawer' : 'ઝડપી ઉચક પેનલ'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">F5</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">🔄 \${isEn ? 'Page Refresh (Browser)' : 'પેજ રિફ્રેશ (તાજું કરો)'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">F6</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">👥 \${isEn ? 'Staff Directory & Salary' : 'કર્મચારી યાદી અને પગાર'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">F7</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">⚖️ \${isEn ? 'Dues (Receivables & Payables)' : 'લેણાં - દેવાં (બાકી હિસાબ)'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">F8</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">🧮 \${isEn ? 'On-Screen Mini Calculator' : 'ઓન-સ્ક્રીન કેલ્ક્યુલેટર'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">F12</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">❓ \${isEn ? 'Shortcuts Guide (This Modal)' : 'શોર્ટકટ્સ હેલ્પ માર્ગદર્શિકા'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9; background: #fffdf5;">
                <td style="padding: 8px 10px;"><kbd style="background: #fef3c7; border: 1.5px solid #fde68a; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #92400e;">Ctrl + S</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">💾 \${isEn ? 'Save Record & Remarks' : 'હિસાબ સેવ કરો અને વિશેષ નોંધ'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9; background: #fffdf5;">
                <td style="padding: 8px 10px;"><kbd style="background: #fef3c7; border: 1.5px solid #fde68a; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #92400e;">Ctrl + P</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">🖨️ \${isEn ? 'Print Daily Report' : 'દૈનિક હિસાબ પ્રિન્ટ કરો'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9; background: #fffdf5;">
                <td style="padding: 8px 10px;"><kbd style="background: #fef3c7; border: 1.5px solid #fde68a; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #92400e;">Ctrl + T</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">📅 \${isEn ? "Select Today's Date" : 'આજની તારીખ પસંદ કરો'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">Alt + ← / →</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">⬅️ ➡️ \${isEn ? 'Previous / Next Day' : 'અગાઉનો દિવસ / આગળનો દિવસ'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">Esc</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">❌ \${isEn ? 'Close Active Modal / Drawer' : 'ખુલેલું મોડલ કે ડ્રોઅર બંધ કરો'}</td>
              </tr>
              <tr>
                <td style="padding: 8px 10px;"><kbd style="background: #f1f5f9; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 2px 8px; font-weight: 800; color: #0f172a;">Ctrl + G</kbd></td>
                <td style="padding: 8px 10px; font-weight: 600;">⌨️ \${isEn ? 'Toggle Gujarati / English Typing' : 'ગુજરાતી / અંગ્રેજી ટાઈપિંગ સ્વિચ'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="modal-footer" style="padding: 12px 20px; background: #f8fafc; border-top: 1px solid #e2e8f0; display: flex; justify-content: flex-end;">
          <button class="btn-primary" onclick="App.closeModal('modal-shortcuts-help')" style="padding: 8px 18px; font-weight: 700;">\${isEn ? 'Got it (Esc)' : 'સમજાયું (Esc)'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  },

  // =========================================================================
  // ON-SCREEN MINI CALCULATOR (Alt+C) LOGIC
  // =========================================================================
  calcExpr: '',
  calcCurrent: '0',
  calcPrev: null,
  calcOperator: null,
  calcResetOnNextDigit: false,

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

  calcDragInitialized: false,
  initCalcDrag() {
    if (this.calcDragInitialized) return;
    this.calcDragInitialized = true;
    const card = document.getElementById('floating-calc-widget');
    const handle = document.getElementById('calc-drag-handle');
    if (!card || !handle) return;

    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    handle.addEventListener('mousedown', (e) => {
      // Don't drag if clicking buttons inside header
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
  },

  getTodayDateStr() {
    try {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    } catch (e) {
      return new Date().toISOString().split('T')[0];
    }
  },

  getCurrentTimeStr() {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(new Date());
  },

  shiftDate(days) {
    if (!this.currentDate) return this.getTodayDateStr();
    const parts = this.currentDate.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2] + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  updateDateControlsState() {
    const today = this.getTodayDateStr();
    const btnNext = document.getElementById('btn-next-day');
    const isTodayOrFuture = this.currentDate >= today;
    if (btnNext) {
      btnNext.disabled = false;
      btnNext.style.opacity = '1';
      btnNext.style.cursor = 'pointer';
      btnNext.title = 'એક દિવસ આગળ';
    }
    const dateInput = document.getElementById('selected-date-input');
    if (dateInput) {
      dateInput.removeAttribute('max');
      dateInput.value = this.currentDate;
    }
    const dateText = document.getElementById('date-picker-text');
    if (dateText && this.currentDate) {
      const parts = this.currentDate.split('-');
      if (parts.length === 3) {
        dateText.textContent = `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
    }
    const btnToday = document.getElementById('btn-date-today');
    if (btnToday) {
      btnToday.classList.toggle('active', this.currentDate === today);
    }
    const trigger = document.getElementById('date-picker-trigger');
    if (trigger) {
      trigger.classList.toggle('locked', false);
    }
  },

  calActiveMonth: null,

  toggleCustomCalendar(e) {
    if (e) e.stopPropagation();
    const pop = document.getElementById('custom-calendar-popover');
    const trigger = document.getElementById('date-picker-trigger');
    if (!pop) return;

    if (pop.style.display === 'none' || !pop.style.display) {
      this.calActiveMonth = this.currentDate ? this.currentDate.slice(0, 7) : this.getTodayDateStr().slice(0, 7);
      this.renderCustomCalendar();
      pop.style.display = 'block';
      if (trigger) trigger.classList.add('open');
    } else {
      this.closeCustomCalendar();
    }
  },

  closeCustomCalendar() {
    const pop = document.getElementById('custom-calendar-popover');
    const trigger = document.getElementById('date-picker-trigger');
    if (pop) pop.style.display = 'none';
    if (trigger) trigger.classList.remove('open');
  },

  changeCalendarMonth(delta) {
    if (!this.calActiveMonth) {
      this.calActiveMonth = this.currentDate ? this.currentDate.slice(0, 7) : this.getTodayDateStr().slice(0, 7);
    }
    const [y, m] = this.calActiveMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const newY = d.getFullYear();
    const newM = String(d.getMonth() + 1).padStart(2, '0');
    const targetMonth = `${newY}-${newM}`;

    this.calActiveMonth = targetMonth;
    this.renderCustomCalendar();
  },

  async selectCalendarDate(dateStr) {
    if (!dateStr) return;
    this.closeCustomCalendar();
    await this.setDateAndLoad(dateStr);
  },

  renderCustomCalendar() {
    const pop = document.getElementById('custom-calendar-popover');
    if (!pop) return;

    const today = this.getTodayDateStr();
    const currentMonthStr = today.slice(0, 7);
    const targetMonth = this.calActiveMonth || this.currentDate.slice(0, 7);
    const [year, month] = targetMonth.split('-').map(Number);

    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const monthNamesGu = ['જાન્યુઆરી', 'ફેબ્રુઆરી', 'માર્ચ', 'એપ્રિલ', 'મે', 'જૂન', 'જુલાઈ', 'ઓગસ્ટ', 'સપ્ટેમ્બર', 'ઑક્ટોબર', 'નવેમ્બર', 'ડિસેમ્બર'];
    const monthNamesEn = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    const monthTitle = document.getElementById('cal-month-name');
    const yearTitle = document.getElementById('cal-year-name');
    if (monthTitle) monthTitle.textContent = (isEn ? monthNamesEn : monthNamesGu)[month - 1];
    if (yearTitle) yearTitle.textContent = String(year);

    const nextBtn = document.getElementById('cal-next-month-btn');
    if (nextBtn) {
      const isCurrentOrFuture = targetMonth >= currentMonthStr;
      nextBtn.disabled = isCurrentOrFuture;
    }

    // Dynamic weekdays row matching current language
    const weekdaysRow = document.getElementById('popcal-weekdays-row');
    if (weekdaysRow) {
      const weekdays = isEn
        ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        : ['રવિ', 'સોમ', 'મંગળ', 'બુધ', 'ગુરુ', 'શુક્ર', 'શનિ'];
      weekdaysRow.innerHTML = weekdays.map(w => `<span>${w}</span>`).join('');
    }

    // Dynamic Legend & Button text
    const legToday = document.getElementById('popcal-leg-today');
    const btnJump = document.getElementById('popcal-btn-jump-today');
    if (legToday) legToday.textContent = isEn ? 'Today' : 'આજે';
    if (btnJump) btnJump.textContent = isEn ? 'Today' : 'આજે જાઓ';

    const grid = document.getElementById('cal-days-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const firstDayIndex = new Date(year, month - 1, 1).getDay();
    const totalDays = new Date(year, month, 0).getDate();

    for (let i = 0; i < firstDayIndex; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'popcal-cell empty';
      grid.appendChild(emptyCell);
    }

    for (let dayNum = 1; dayNum <= totalDays; dayNum++) {
      const dayStr = String(dayNum).padStart(2, '0');
      const dateStr = `${targetMonth}-${dayStr}`;
      const isToday = (dateStr === today);
      const isSelected = (dateStr === this.currentDate);
      const isPast = (dateStr < today);
      const isFuture = (dateStr > today);

      const cell = document.createElement('div');
      cell.className = 'popcal-cell';
      if (isToday) cell.classList.add('today');
      if (isSelected) cell.classList.add('selected');
      if (isPast) cell.classList.add('past');
      if (isFuture) cell.classList.add('disabled');

      cell.innerHTML = `<span>${dayNum}</span>`;

      if (!isFuture) {
        cell.onclick = (e) => {
          e.stopPropagation();
          this.selectCalendarDate(dateStr);
        };
      }

      grid.appendChild(cell);
    }
  },

  adminUnlockedDate: null,

  isDateLocked(dateStr) {
    return false; // Free accounting editing enabled on all dates
  },

  isCurrentDateLocked() {
    return false;
  },

  async setDateAndLoad(dateStr) {
    await this.flushPendingSave();
    if (!dateStr) dateStr = this.getTodayDateStr();
    this.currentDate = dateStr;
    const dateInput = document.getElementById('selected-date-input');
    if (dateInput) {
      dateInput.value = dateStr;
      dateInput.removeAttribute('max');
    }
    this.updateDateControlsState();
    await this.loadDate(dateStr);
  },

  async loadDate(dateStr) {
    try {
      const today = this.getTodayDateStr();
      if (dateStr > today) {
        this.showToast(i18n.t('futureDateWarning'), 'warning');
        dateStr = today;
      }
      this.currentDate = dateStr;
      const dateInput = document.getElementById('selected-date-input');
      if (dateInput) {
        dateInput.value = dateStr;
        dateInput.max = today;
      }
      this.updateDateControlsState();
      this.updateDateFriendlyDisplay(dateStr);

      const res = await fetch(`/api/records/${dateStr}`);
      const data = await res.json();
      this.record = data;
      this.normalizeRecordStructure();
      this.renderRecord();
      await this.loadBankDepositSummary();
    } catch (e) {
      console.error('Error loading date record:', e);
      const isEn = window.i18n && window.i18n.currentLang === 'en';
      this.showToast(isEn ? 'Error loading date record!' : 'રેકોર્ડ લોડ કરવામાં ભૂલ આવી!', 'error');
    }
  },

  // Ensure fixed items match Admin configured lists
  // Ensure fixed items match Admin configured lists while preserving extra entries
  normalizeRecordStructure() {
    if (!this.record) return;

    if (!Array.isArray(this.record.expenseItems)) {
      this.record.expenseItems = [];
    }

    // 1. Notes sync
    const currentNotes = this.record.notes || [];
    const noteMap = {};
    currentNotes.forEach(n => { noteMap[n.note] = n; });
    this.record.notes = this.activeNotes.map(val => ({
      note: val,
      count: noteMap[val] ? noteMap[val].count : 0,
      amount: noteMap[val] ? noteMap[val].amount : 0
    }));

    // 2. Banks sync - keep fixed banks and preserve any extra bank entries
    const currentBanks = this.record.banks || [];
    const bankMap = {};
    const extraBanks = [];
    currentBanks.forEach(b => {
      if (!b || !b.name) return;
      const bName = b.name.trim();
      bankMap[bName.toUpperCase()] = b.amount;
      if (!this.fixedBanks.some(f => f.trim().toUpperCase() === bName.toUpperCase())) {
        extraBanks.push({ name: bName, amount: Number(b.amount) || 0 });
      }
    });
    this.record.banks = [
      ...this.fixedBanks.map(name => ({
        name: name,
        amount: bankMap[name.trim().toUpperCase()] !== undefined ? Number(bankMap[name.trim().toUpperCase()]) || 0 : 0
      })),
      ...extraBanks
    ];

    // 3. Vouchers sync - keep fixed vouchers (MANDIR, RASODA, PAGAR) and preserve any other vouchers (UPAD, GAUSHALA, etc.)
    const currentVouchers = this.record.vouchers || [];
    const voucherMap = {};
    const extraVouchers = [];
    currentVouchers.forEach(v => {
      if (!v || !v.name) return;
      const vName = v.name.trim();
      voucherMap[vName.toUpperCase()] = v.amount;
      if (!this.fixedVouchers.some(f => f.trim().toUpperCase() === vName.toUpperCase())) {
        extraVouchers.push({ name: vName, amount: Number(v.amount) || 0 });
      }
    });
    this.record.vouchers = [
      ...this.fixedVouchers.map(name => ({
        name: name,
        amount: voucherMap[name.trim().toUpperCase()] !== undefined ? Number(voucherMap[name.trim().toUpperCase()]) || 0 : 0
      })),
      ...extraVouchers
    ];

    // Auto-sync voucher amounts from expenseItems (Single source of truth)
    if (Array.isArray(this.record.expenseItems)) {
      const catSums = {};
      this.record.expenseItems.forEach(item => {
        const cat = (item.category || '').trim().toUpperCase();
        catSums[cat] = (catSums[cat] || 0) + (Number(item.amount) || 0);
      });
      this.record.vouchers.forEach(v => {
        const vKey = (v.name || '').trim().toUpperCase();
        v.amount = catSums[vKey] || 0;
      });
    }
  },

  updateDateFriendlyDisplay(dateStr) {
    const target = dateStr || this.currentDate || this.getTodayDateStr();
    if (!target) return;
    const d = new Date(target + 'T00:00:00');
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const locale = (window.i18n && window.i18n.currentLang === 'en') ? 'en-IN' : 'gu-IN';
    const friendly = d.toLocaleDateString(locale, options);
    const lbl = document.getElementById('date-friendly-label');
    if (lbl) lbl.textContent = friendly;
  },

  renderRecord() {
    if (!this.record) return;

    const isLocked = this.isCurrentDateLocked();
    const viewContainer = document.getElementById('view-daily-hisab');

    if (viewContainer) {
      if (isLocked) viewContainer.classList.add('is-date-locked');
      else viewContainer.classList.remove('is-date-locked');
    }

    const statusEl = document.getElementById('save-status-text');
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.style.opacity = '0';
    }

    // 1. Render Cash Notes Table
    const cashTbody = document.getElementById('tbody-cash');
    cashTbody.innerHTML = '';
    (this.record.notes || []).forEach((n, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <span class="denom-badge denom-${n.note}">₹ ${n.note}</span>
        </td>
        <td style="text-align: center;">
          <input type="number" min="0" class="input-num input-note-count" 
                 value="${n.count || 0}" 
                 id="note-input-${idx}"
                 ${isLocked ? 'readonly' : ''}
                 onfocus="this.select()"
                 oninput="App.onNoteCountChange(${idx}, this.value)"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();const nxt=document.getElementById('note-input-${idx + 1}');if(nxt){nxt.focus();nxt.select();}}"
                 onblur="App.flushPendingSave()">
        </td>
        <td>
          <span class="table-amount-val" id="note-amt-${idx}">₹ ${(n.amount || 0).toLocaleString('en-IN')}</span>
        </td>
      `;
      cashTbody.appendChild(tr);
    });

    // 2. Render Bank Table (Fixed labels, ONLY amount input, no text editing)
    const bankTbody = document.getElementById('tbody-bank');
    bankTbody.innerHTML = '';
    (this.record.banks || []).forEach((b, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <span class="fixed-label-name">${b.name}</span>
        </td>
        <td style="text-align: right;">
          <input type="number" min="0" class="input-num input-amount-field" 
                 value="${b.amount || 0}" 
                 id="bank-inp-${idx}"
                 ${isLocked ? 'readonly' : ''}
                 onfocus="this.select()"
                 oninput="App.onBankAmountChange(${idx}, this.value)"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();const nxt=document.getElementById('bank-inp-${idx + 1}');if(nxt){nxt.focus();nxt.select();}}"
                 onblur="App.flushPendingSave()">
        </td>
      `;
      bankTbody.appendChild(tr);
    });

    // 3. Render Voucher Table (Strictly hide 0 expense khata on main page as requested)
    const voucherTbody = document.getElementById('tbody-voucher');
    voucherTbody.innerHTML = '';
    const allVouchers = this.record.vouchers || [];
    const visibleVouchers = this.showAllVouchers
      ? allVouchers.map((v, realIdx) => ({ ...v, realIdx }))
      : allVouchers.map((v, realIdx) => ({ ...v, realIdx })).filter(v => Number(v.amount) > 0);

    const btnToggle = document.getElementById('btn-toggle-voucher-view');
    if (btnToggle) {
      btnToggle.textContent = this.showAllVouchers ? i18n.t('onlyPositiveKhata') : i18n.t('allKhata');
      btnToggle.title = this.showAllVouchers
        ? (i18n.currentLang === 'en' ? 'Show only accounts with expense > 0' : 'માત્ર ૦ થી વધારે ખર્ચવાળા ખાતા બતાવો')
        : (i18n.currentLang === 'en' ? 'Show all accounts (including ₹0)' : 'બધા જ ખાતા (૦ વાળા પણ) બતાવો');
    }

    if (visibleVouchers.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td colspan="2" style="text-align: center; padding: 25px 10px; color: #94a3b8;">
          <div style="font-size: 1.2rem; margin-bottom: 4px;">🧾</div>
          <div style="font-weight: 700; font-size: 0.92rem; color: #64748b;">${i18n.t('noVoucherToday')}</div>
          ${!isLocked ? `
            <div style="margin-top: 10px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
              <button type="button" class="btn-primary" onclick="App.openExpenseDiaryModal()" style="font-size: 0.78rem; padding: 4px 12px; background: #2563eb; border-color: #1d4ed8; color: #ffffff; cursor: pointer;">
                ${i18n.t('addNewExpenseBtn')}
              </button>
              <button type="button" class="btn-secondary" onclick="App.toggleAllVouchersView()" style="font-size: 0.78rem; padding: 4px 10px; cursor: pointer;">
                ${i18n.t('viewAllKhataBtn')}
              </button>
            </div>
          ` : ''}
        </td>
      `;
      voucherTbody.appendChild(tr);
    } else {
      visibleVouchers.forEach(v => {
        const tr = document.createElement('tr');
        const vName = (v.name || '').trim();
        const gujName = this.getKhataNameInGujarati(vName);
        const isPagarOrUpad = vName === 'PAGAR' || vName === 'UPAD';
        const hasAmount = (Number(v.amount) || 0) > 0;
        tr.innerHTML = `
          <td>
            <span class="fixed-label-name" style="cursor: pointer;" onclick="App.openExpenseDiaryModal('${vName}')" title="${i18n.t('clickToViewOrWriteKhata')}">${gujName || vName}</span>
          </td>
          <td style="text-align: right;">
            <input type="number" min="0" class="input-num input-amount-field" 
                   value="${v.amount || 0}" 
                   id="voucher-inp-${v.realIdx}"
                   readonly
                   onclick="App.openExpenseDiaryModal('${vName}')"
                   title="વિગત જોવા કે ખર્ચ ઉમેરવા/સુધારવા ક્લિક કરો"
                   style="background: #f8fafc; cursor: pointer; color: #1e3a8a; font-weight: 800; border-color: #cbd5e1;">
          </td>
        `;
        voucherTbody.appendChild(tr);
      });
    }

    // Remarks UI indicator
    this.updateRemarksIndicator();

    this.recalcTotals();
    this.populateExactExcelPrintDOM();
  },

  // Note Handlers
  stepNote(idx, delta) {
    if (this.isCurrentDateLocked()) return;
    if (!this.record || !this.record.notes[idx]) return;
    const cur = Number(this.record.notes[idx].count) || 0;
    const next = Math.max(0, cur + delta);
    this.record.notes[idx].count = next;
    this.record.notes[idx].amount = next * this.record.notes[idx].note;

    const inp = document.getElementById(`note-input-${idx}`);
    if (inp) inp.value = next;
    const amtSpan = document.getElementById(`note-amt-${idx}`);
    if (amtSpan) amtSpan.textContent = '₹ ' + this.record.notes[idx].amount.toLocaleString('en-IN');

    this.recalcTotals();
    this.populateExactExcelPrintDOM();
    this.markDirty();
  },

  onNoteCountChange(idx, val) {
    if (this.isCurrentDateLocked()) return;
    if (!this.record || !this.record.notes[idx]) return;
    const count = Math.max(0, parseInt(val, 10) || 0);
    this.record.notes[idx].count = count;
    this.record.notes[idx].amount = count * this.record.notes[idx].note;

    const amtSpan = document.getElementById(`note-amt-${idx}`);
    if (amtSpan) amtSpan.textContent = '₹ ' + this.record.notes[idx].amount.toLocaleString('en-IN');

    this.recalcTotals();
    this.populateExactExcelPrintDOM();
    this.markDirty();
  },

  // Bank Amount Change Handler
  onBankAmountChange(idx, val) {
    if (this.isCurrentDateLocked()) return;
    if (!this.record || !this.record.banks[idx]) return;
    this.record.banks[idx].amount = Math.max(0, Number(val) || 0);
    this.recalcTotals();
    this.populateExactExcelPrintDOM();
    this.markDirty();
  },

  // Voucher Amount Change Handler
  onVoucherAmountChange(idx, val) {
    if (this.isCurrentDateLocked()) return;
    if (!this.record || !this.record.vouchers[idx]) return;
    this.record.vouchers[idx].amount = Math.max(0, Number(val) || 0);
    this.recalcTotals();
    this.populateExactExcelPrintDOM();
    this.markDirty();
  },

  onVoucherAmountBlur() {
    if (!App.showAllVouchers) {
      App.renderRecord();
    }
  },

  toggleAllVouchersView() {
    App.showAllVouchers = !App.showAllVouchers;
    App.renderRecord();
  },

  // Recalculate Totals
  recalcTotals() {
    if (!this.record) return;

    const cashTotal = (this.record.notes || []).reduce((s, n) => s + (n.amount || 0), 0);
    const noteCountTotal = (this.record.notes || []).reduce((s, n) => s + (n.count || 0), 0);
    const bankTotal = (this.record.banks || []).reduce((s, b) => s + (Number(b.amount) || 0), 0);
    const voucherTotal = (this.record.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
    const grandTotal = cashTotal + bankTotal + voucherTotal;

    this.record.cashTotal = cashTotal;
    this.record.noteCountTotal = noteCountTotal;
    this.record.bankTotal = bankTotal;
    this.record.voucherTotal = voucherTotal;
    this.record.grandTotal = grandTotal;

    // Update UI elements safely
    const setTxt = (id, txt) => {
      const el = document.getElementById(id);
      if (el) el.textContent = txt;
    };

    setTxt('cash-total-display', '₹ ' + cashTotal.toLocaleString('en-IN'));
    setTxt('ribbon-cash-total', '₹ ' + cashTotal.toLocaleString('en-IN'));
    setTxt('cash-notes-count-badge', `${noteCountTotal} ${i18n.t('notesCountLabel')}`);

    setTxt('bank-total-display', '₹ ' + bankTotal.toLocaleString('en-IN'));
    setTxt('ribbon-bank-total', '₹ ' + bankTotal.toLocaleString('en-IN'));

    setTxt('voucher-total-display', '₹ ' + voucherTotal.toLocaleString('en-IN'));
    setTxt('ribbon-voucher-total', '₹ ' + voucherTotal.toLocaleString('en-IN'));

    setTxt('hero-grand-total', '₹ ' + grandTotal.toLocaleString('en-IN'));

    // Amount in Words (Gujarati & English)
    const wordsEnglish = NumberToWords.toEnglish(grandTotal);
    const wordsGujarati = NumberToWords.toGujarati(grandTotal);

    const lang = (window.i18n && window.i18n.currentLang) || 'gu';
    const selectedWords = lang === 'en' ? wordsEnglish : wordsGujarati;

    setTxt('words-display-main', selectedWords);
    setTxt('words-display-sub', lang === 'en' ? wordsGujarati : wordsEnglish);
  },

  syncVouchersWithExpenseDiary(silent = false) {
    if (!this.record) return;
    const items = this.record.expenseItems || [];
    const catSums = {};
    items.forEach(item => {
      const cat = (item.category || '').trim().toUpperCase();
      catSums[cat] = (catSums[cat] || 0) + (Number(item.amount) || 0);
    });

    (this.record.vouchers || []).forEach(v => {
      const vKey = (v.name || '').trim().toUpperCase();
      v.amount = catSums[vKey] || 0;
    });

    this.recalcTotals();
    this.renderRecord();
    this.markDirty();
  },

  async clearVoucherExpenses(vName) {
    if (this.isCurrentDateLocked()) {
      this.showToast('આ તારીખ લોક થયેલ છે!', 'error');
      return;
    }
    if (!this.record) return;
    const gujName = this.getKhataNameInGujarati(vName);
    const vKey = (vName || '').trim().toUpperCase();
    const itemsToDel = (this.record.expenseItems || []).filter(item => (item.category || '').trim().toUpperCase() === vKey);
    const currentV = (this.record.vouchers || []).find(v => (v.name || '').trim().toUpperCase() === vKey);
    const curAmt = currentV ? Number(currentV.amount) || 0 : 0;

    if (curAmt === 0 && itemsToDel.length === 0) {
      this.showToast(`'${gujName}' માં કોઈ ખર્ચ નથી.`, 'info');
      return;
    }

    if (!confirm(`શું તમે આજના હિસાબમાંથી '${gujName}' નો તમામ ખર્ચ (₹${curAmt.toLocaleString('en-IN')}) કાયમી ધોરણે કાઢી નાખવા માંગો છો? આ વાઉચર ૦ થઈ જશે.`)) {
      return;
    }

    // Handle employee transaction cleanup if any
    for (const item of itemsToDel) {
      if (item.employeeId) {
        try {
          const empRes = await fetch('/api/employees');
          const empData = await empRes.json();
          const empList = Array.isArray(empData) ? empData : (empData.employees || []);
          const emp = (empList || []).find(e => e.id === item.employeeId);
          if (emp) {
            const isPagar = vKey.includes('PAGAR');
            const isUpad = vKey.includes('UPAD');
            if (isPagar && Array.isArray(emp.pagars)) {
              const pEntry = emp.pagars.find(p => p.date === this.currentDate && Number(p.amount) === Number(item.amount));
              if (pEntry) await fetch(`/api/employees/${emp.id}/pagar/${pEntry.id}`, { method: 'DELETE' });
            } else if (isUpad && Array.isArray(emp.upads)) {
              const uEntry = emp.upads.find(u => u.date === this.currentDate && Number(u.amount) === Number(item.amount));
              if (uEntry) await fetch(`/api/employees/${emp.id}/upad/${uEntry.id}`, { method: 'DELETE' });
            }
          }
        } catch (e) {
          console.warn('Error clearing employee entry:', e);
        }
      }
    }

    // Filter out items for this voucher category
    this.record.expenseItems = (this.record.expenseItems || []).filter(item => (item.category || '').trim().toUpperCase() !== vKey);

    // Recalculate voucher amounts
    const catSums = {};
    this.record.expenseItems.forEach(it => {
      const k = (it.category || '').trim().toUpperCase();
      catSums[k] = (catSums[k] || 0) + (Number(it.amount) || 0);
    });
    (this.record.vouchers || []).forEach(v => {
      const k = (v.name || '').trim().toUpperCase();
      v.amount = catSums[k] || 0;
    });

    this.recalcTotals();
    this.renderRecord();
    if (document.getElementById('modal-expense-diary')?.classList.contains('active')) {
      this.renderExpenseDiary();
    }

    await this.saveCurrentRecord(false);
    await this.loadEmployees(this.employeeMonthFilter);

    this.showToast(`🗑️ '${gujName}' નો ખર્ચ કાઢી નાખ્યો (₹${curAmt.toLocaleString('en-IN')} બાદ કર્યા)!`, 'success');
  },

  // Populate EXACT Excel Print Table DOM
  populateExactExcelPrintDOM() {
    if (!this.record) return;
    const sheet = document.getElementById('excel-exact-sheet');
    if (!sheet) return;

    // 1. Render Print Notes
    const notesTbody = sheet.querySelector('#print-notes-body');
    if (notesTbody) {
      notesTbody.innerHTML = '';
      (this.record.notes || []).forEach(n => {
        const tr = document.createElement('tr');
        tr.className = 'r-note';
        tr.innerHTML = `
          <td class="cell-d">${n.note}</td>
          <td class="cell-e">${n.count || 0}</td>
          <td class="cell-f">${n.amount || 0}</td>
        `;
        notesTbody.appendChild(tr);
      });
    }

    // Cash Total
    const elCashTot = sheet.querySelector('#pe-cash-total');
    if (elCashTot) elCashTot.textContent = this.record.cashTotal || 0;

    // 2. Render Print Banks (with rowspan for BANK label)
    const banksTbody = sheet.querySelector('#print-banks-body');
    if (banksTbody) {
      banksTbody.innerHTML = '';
      const banks = this.record.banks || [];
      const rowCount = Math.max(banks.length, 3);

      for (let i = 0; i < rowCount; i++) {
        const b = banks[i] || { name: '', amount: 0 };
        const tr = document.createElement('tr');
        tr.className = i === 0 ? 'r36' : 'r37';
        let html = '';
        if (i === 0) {
          html += `<td rowspan="${rowCount}" class="cell-bank-label">BANK</td>`;
        }
        const bEng = b.name ? (this.getEnglishKhataName(b.name) || b.name).toUpperCase() : '';
        html += `
          <td class="cell-bank-name">${bEng}</td>
          <td class="cell-bank-amt">${b.amount || 0}</td>
        `;
        tr.innerHTML = html;
        banksTbody.appendChild(tr);
      }
    }
    const elBankTot = sheet.querySelector('#pe-bank-total');
    if (elBankTot) elBankTot.textContent = this.record.bankTotal || 0;

    // 3. Render Print Vouchers (VOUCHERS / EXPENSES MUST BE STRICTLY ENGLISH FOR PRINT)
    const vouchersTbody = sheet.querySelector('#print-vouchers-body');
    if (vouchersTbody) {
      vouchersTbody.innerHTML = '';
      const allVouchers = this.record.vouchers || [];
      // Only include khata where amount is NOT 0
      const activeVouchers = allVouchers.filter(v => Number(v.amount) > 0);
      // Keep exact 9 cells/rows (or more if activeVouchers > 9) so cells are NEVER deleted!
      const rowCount = Math.max(activeVouchers.length, 9);

      for (let i = 0; i < rowCount; i++) {
        const v = activeVouchers[i] || null;
        const tr = document.createElement('tr');
        tr.className = 'r-voucher' + (i === 5 ? ' r46' : (i === 8 ? ' r49' : ''));
        let html = '';
        if (i === 0) {
          html += `<td rowspan="${rowCount}" class="cell-voucher-label">VOUCHER</td>`;
        }
        if (v) {
          const vEng = (this.getEnglishKhataName(v.name) || v.name).toUpperCase();
          html += `
            <td class="cell-voucher-name">${vEng}</td>
            <td class="cell-voucher-amt">${Number(v.amount) || 0}</td>
          `;
        } else {
          // Empty cell: cells and borders are preserved, not deleted
          html += `
            <td class="cell-voucher-name"></td>
            <td class="cell-voucher-amt"></td>
          `;
        }
        tr.innerHTML = html;
        vouchersTbody.appendChild(tr);
      }
    }
    const elVouchTot = sheet.querySelector('#pe-voucher-total');
    if (elVouchTot) elVouchTot.textContent = this.record.voucherTotal || 0;

    // Headers in exact print sheet (STRICTLY ENGLISH)
    const peCashTitle = sheet.querySelector('#pe-cash-title');
    if (peCashTitle) peCashTitle.textContent = 'CASH TOTAL';

    const peBankTitle = sheet.querySelector('#pe-bank-title');
    if (peBankTitle) peBankTitle.textContent = 'BANK TOTAL';

    const peVoucherTitle = sheet.querySelector('#pe-voucher-title');
    if (peVoucherTitle) peVoucherTitle.textContent = 'VOUCHER TOTAL';

    const peGrandTitle = sheet.querySelector('#pe-grand-title');
    if (peGrandTitle) peGrandTitle.textContent = 'TOTAL';

    // Grand Total
    const elGrandTot = sheet.querySelector('#pe-grand-total');
    if (elGrandTot) elGrandTot.textContent = this.record.grandTotal || 0;
  },

  markDirty(fast = false) {
    if (this.isCurrentDateLocked()) return;
    this.isDirty = true;
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const st = document.getElementById('save-status-text');
    if (st) {
      clearTimeout(this.fadeSaveTimer);
      st.style.transition = 'opacity 0.2s ease';
      st.style.opacity = '1';
      st.textContent = isEn ? '⏳ Saving...' : '⏳ સાચવી રહ્યું છે...';
      st.style.color = '#d97706';
      st.style.background = 'rgba(217, 119, 6, 0.1)';
      st.style.borderColor = 'rgba(217, 119, 6, 0.25)';
    }

    clearTimeout(this.autoSaveTimer);
    const delay = fast ? 100 : 500;
    this.autoSaveTimer = setTimeout(() => {
      this.saveCurrentRecord(false);
    }, delay);
  },

  async flushPendingSave() {
    if (this.isDirty && !this.isCurrentDateLocked()) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
      await this.saveCurrentRecord(false);
    }
  },

  async notifyDataChanged(changeType = 'general', date = null) {
    try {
      // 1. Immediately update Header Bank Cash & Days badge in real-time
      if (typeof this.loadBankDepositSummary === 'function') {
        this.loadBankDepositSummary();
      }

      // 2. Invalidate History cache so next modal open fetches 100% fresh data
      this.allHistoryRecords = null;
      if (document.getElementById('modal-history')?.classList.contains('active')) {
        this.openHistoryModal();
      }

      // 3. If Expense Report view is active or open, refresh it live
      if (this.currentView === 'expenses' || document.getElementById('view-expense-ledger')?.style.display === 'block') {
        if (typeof this.applyExpenseFilter === 'function') {
          this.applyExpenseFilter();
        }
      }

      // 4. Update Expense Diary if open
      if (document.getElementById('modal-expense-diary')?.classList.contains('active')) {
        if (typeof this.renderExpenseDiary === 'function') {
          this.renderExpenseDiary();
        }
      }

      // 5. Update Uchak floating banner if active
      if (typeof this.updateUchakFloatingBanner === 'function') {
        this.updateUchakFloatingBanner();
      }

      // 6. Update expense name autocomplete suggestions
      if (typeof this.loadExpenseNameSuggestions === 'function') {
        this.loadExpenseNameSuggestions();
      }
    } catch (e) {
      console.warn('notifyDataChanged notice:', e);
    }
  },

  async saveCurrentRecord(showFeedback = true) {
    if (!this.record) return;
    if (this.isCurrentDateLocked()) {
      return;
    }
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    try {
      if (showFeedback) {
        const st = document.getElementById('save-status-text');
        if (st) {
          clearTimeout(this.fadeSaveTimer);
          st.style.transition = 'opacity 0.2s ease';
          st.style.opacity = '1';
          st.textContent = isEn ? '⏳ Saving...' : '⏳ સાચવી રહ્યું છે...';
        }
      }
      const isAdminOverridden = Boolean(this.adminUnlockedDate && this.adminUnlockedDate === this.currentDate);
      const payload = {
        ...this.record,
        adminOverride: isAdminOverridden
      };
      const res = await fetch(`/api/records/${this.currentDate}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(isAdminOverridden ? { 'x-admin-override': 'true' } : {})
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        this.isDirty = false;
        if (data.employeesUpdated) {
          this.loadEmployees(this.employeeMonthFilter);
        }
        // Real-time synchronization across all tabs and components
        this.notifyDataChanged('record_saved', this.currentDate);

        const st = document.getElementById('save-status-text');
        if (st) {
          st.style.transition = 'opacity 0.2s ease';
          st.style.opacity = '1';
          st.textContent = isEn ? '✅ Saved' : '✅ સાચવાઈ ગયું';
          st.style.color = 'var(--emerald)';
          st.style.background = 'rgba(5, 150, 105, 0.08)';
          st.style.borderColor = 'rgba(5, 150, 105, 0.22)';
          clearTimeout(this.fadeSaveTimer);
          this.fadeSaveTimer = setTimeout(() => {
            if (st && !this.isDirty) {
              st.style.transition = 'opacity 0.5s ease';
              st.style.opacity = '0';
            }
          }, 1800);
        }
        if (showFeedback) {
          this.showToast(i18n.t('successSaved'), 'success');
        }
      } else if (data.error) {
        this.showToast(data.error, 'error');
      }
    } catch (e) {
      console.error('Error saving record:', e);
      const saveEl = document.getElementById('save-status-text');
      if (saveEl) {
        saveEl.textContent = isEn ? 'Failed to save!' : 'સેવ થઈ શક્યું નહીં!';
        saveEl.style.color = 'var(--rose)';
      }
      if (showFeedback) {
        this.showToast(isEn ? 'Error saving record!' : 'હિસાબ સેવ કરવામાં ભૂલ આવી!', 'error');
      }
    }
  },

  clearDayValues() {
    if (this.isCurrentDateLocked()) {
      return;
    }
    if (!confirm(i18n.t('clearConfirm'))) return;
    // Reset cash notes count and amounts
    (this.record.notes || []).forEach(n => { n.count = 0; n.amount = 0; });
    // Reset bank transfer amounts
    (this.record.banks || []).forEach(b => { b.amount = 0; });
    // IMPORTANT: Vouchers (ખર્ચ) and expenseItems (ખર્ચ યાદી) remain untouched!
    // As per user requirement: "reset value me kharch me kuch badlav nahi karna"
    this.renderRecord();
    this.markDirty();
    const msg = (i18n.currentLang === 'en')
      ? 'Cash & Bank values reset (Expenses preserved)'
      : 'રોકડ અને બેંકના આંકડા ખાલી થયા (ખર્ચ સુરક્ષિત છે)';
    this.showToast(msg, 'success');
  },

  // =========================================================================
  // ADMIN PANEL METHODS & SECURE SESSION TOKEN MANAGEMENT
  // =========================================================================
  adminToken: (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('hisab_admin_token') : null),
  adminAuthenticated: false,
  adminPendingOpenTab: null,
  adminPendingEmpId: null,
  adminEmpStatusFilter: 'active', // 'all' | 'active' | 'inactive'

  getAdminAuthHeaders(extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (this.adminToken) {
      headers['Authorization'] = `Bearer ${this.adminToken}`;
      headers['x-admin-token'] = this.adminToken;
    }
    return headers;
  },

  handleAdminAuthError(res, data) {
    if (res && (res.status === 403 || res.status === 401 || (data && data.sessionExpired))) {
      this.adminToken = null;
      this.adminAuthenticated = false;
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('hisab_admin_token');
      const isEn = window.i18n && window.i18n.currentLang === 'en';
      this.showToast((data && data.error) || (isEn ? 'Security session expired. Please enter PIN to login.' : 'સુરક્ષા સેશન સમાપ્ત થઈ ગયું છે. ફરી પિન નાખી લૉગિન કરો.'), 'error');
      this.openAdminModal();
      return true;
    }
    return false;
  },

  async adminLogout() {
    try {
      if (this.adminToken) {
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: this.getAdminAuthHeaders()
        });
      }
    } catch (e) { }
    this.adminToken = null;
    this.adminAuthenticated = false;
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('hisab_admin_token');
    this.adminLockDateAgain();
    this.switchMainView('daily');
  },

  async ensureAdminAuth(reasonMsg = null) {
    if (this.adminAuthenticated && this.adminToken) {
      return true;
    }
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const promptMsg = reasonMsg || (isEn ? 'Admin PIN is required to edit locked record:' : 'પાછલી તારીખના લૉક હિસાબમાં સુધારો કરવા એડમિન પિન જરૂરી છે:');
    const enteredPin = prompt(promptMsg);
    if (!enteredPin) return false;
    try {
      const res = await fetch('/api/admin/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: enteredPin.trim() })
      });
      const data = await res.json();
      if (res.ok && data.success && data.token) {
        this.adminToken = data.token;
        this.adminAuthenticated = true;
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('hisab_admin_token', data.token);
        return true;
      } else {
        this.showToast(data.error || (isEn ? 'Incorrect Admin PIN!' : 'ખોટો એડમિન પિન!'), 'error');
        return false;
      }
    } catch (err) {
      this.showToast(isEn ? 'Error verifying PIN' : 'પિન ચકાસવામાં ભૂલ આવી', 'error');
      return false;
    }
  },

  async openAdminModal(initialTab = null, focusEmpId = null) {
    // 1. Session Token & PIN Security Check (RBAC: Only 'admin' role bypasses PIN, others require Admin PIN)
    let currentUser = null;
    try {
      currentUser = JSON.parse(localStorage.getItem('hisab_user_info') || sessionStorage.getItem('hisab_user_info') || '{}');
    } catch (e) {}

    const appToken = this.authToken || localStorage.getItem('hisab_auth_token') || sessionStorage.getItem('hisab_auth_token');
    if (currentUser && currentUser.role === 'admin' && appToken && !this.adminToken) {
      this.adminAuthenticated = true;
      this.adminToken = appToken;
    }

    if (!this.adminAuthenticated || !this.adminToken) {
      this.adminPendingOpenTab = initialTab || 'master-hisab';
      this.adminPendingEmpId = focusEmpId;
      this.openModal('modal-admin-pin', { isChild: true });
      const pinInp = document.getElementById('input-admin-pin-auth');
      if (pinInp) {
        pinInp.value = '';
        setTimeout(() => pinInp.focus(), 100);
      }
      return;
    }

    this.switchMainView('admin');
    const adminLangSelect = document.getElementById('admin-lang-select');
    if (adminLangSelect) adminLangSelect.value = i18n.currentLang;
    if (typeof i18n !== 'undefined' && typeof i18n.updateDOM === 'function') {
      i18n.updateDOM();
    }

    try {
      const res = await fetch('/api/admin/config');
      const cfg = await res.json();
      this.adminData.notes = [...(cfg.notes || this.activeNotes)];
      this.adminData.banks = [...(cfg.banks || this.fixedBanks)];
      this.adminData.inactiveBanks = [...(cfg.inactiveBanks || this.settings.inactiveBanks || [])];
      this.adminData.vouchers = [...(cfg.vouchers || this.fixedVouchers)];
      this.adminData.inactiveVouchers = [...(cfg.inactiveVouchers || this.settings.inactiveVouchers || [])];

      const orgInp = document.getElementById('admin-setting-org-name');
      if (orgInp) orgInp.value = cfg.orgName || this.settings.orgName || '';
      const subInp = document.getElementById('admin-setting-org-sub');
      if (subInp) subInp.value = cfg.orgSubtitle || this.settings.orgSubtitle || '';
      const phoneInp = document.getElementById('admin-setting-phone');
      if (phoneInp) phoneInp.value = cfg.phone || this.settings.phone || '';
      const folderInp = document.getElementById('admin-setting-folder');
      if (folderInp) folderInp.value = cfg.exportFolder || this.settings.exportFolder || 'D:\\Account Report';

      // Signatures
      const signPrep = document.getElementById('admin-setting-sign-prep');
      if (signPrep) signPrep.value = cfg.signPrepared || this.settings.signPrepared || 'હિસાબનીશ / એકાઉન્ટન્ટ';
      const signChk = document.getElementById('admin-setting-sign-chk');
      if (signChk) signChk.value = cfg.signChecked || this.settings.signChecked || 'તપાસનાર / સેક્રેટરી';
      const signPres = document.getElementById('admin-setting-sign-pres');
      if (signPres) signPres.value = cfg.signPresident || this.settings.signPresident || 'પ્રમુખ / ટ્રસ્ટી';
      const alertEmailInp = document.getElementById('admin-setting-alert-email');
      if (alertEmailInp) alertEmailInp.value = cfg.adminAlertEmail || this.settings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';

      this.renderAdminLists();
    } catch (e) {
      this.adminData.notes = [...this.activeNotes];
      this.adminData.banks = [...this.fixedBanks];
      this.adminData.inactiveBanks = [...(this.settings.inactiveBanks || [])];
      this.adminData.vouchers = [...this.fixedVouchers];
      this.adminData.inactiveVouchers = [...(this.settings.inactiveVouchers || [])];
      this.renderAdminLists();
    }

    const targetTab = initialTab || 'master-hisab';
    const navBtn = document.getElementById(`admin-nav-${targetTab}`);
    this.switchAdminTab(targetTab, navBtn);
    setTimeout(() => this.renderAdminPrintPreview(), 150);

    if (targetTab === 'employees') {
      if (focusEmpId) {
        setTimeout(() => this.adminEditEmployee(focusEmpId), 120);
      } else {
        setTimeout(() => this.adminCancelEditEmployee(), 80);
      }
    } else if (targetTab === 'bhakts') {
      setTimeout(() => this.adminCancelEditBhakt(), 80);
    }
  },

  async submitAdminPin(e) {
    if (e) e.preventDefault();
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const pinInput = document.getElementById('input-admin-pin-auth');
    const pin = pinInput ? pinInput.value.trim() : '';
    if (!pin) {
      this.showToast(isEn ? 'Please enter PIN' : 'કૃપા કરીને પિન નાખો', 'error');
      return;
    }

    try {
      const res = await fetch('/api/admin/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.adminToken = data.token;
        this.adminAuthenticated = true;
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('hisab_admin_token', data.token);

        this.closeModal('modal-admin-pin');
        if (pinInput) pinInput.value = '';
        const targetTab = this.adminPendingOpenTab || 'master-hisab';
        const empId = this.adminPendingEmpId;
        this.adminPendingOpenTab = null;
        this.adminPendingEmpId = null;

        if (targetTab === 'bhakts_admin_mode') {
          this.bhaktAdminMode = true;
          this.updateBhaktToolbarActions();
          this.renderBhaktsList(this.bhaktsList);
        } else {
          await this.openAdminModal(targetTab, empId);
        }
      } else {
        this.showToast(data.error || (isEn ? 'Incorrect Admin PIN!' : 'ખોટો એડમિન પિન!'), 'error');
        if (pinInput) { pinInput.value = ''; pinInput.focus(); }
      }
    } catch (err) {
      this.showToast(isEn ? 'Server connection error' : 'સર્વર કનેક્શનમાં ભૂલ આવી', 'error');
    }
  },

  openForgotPinModal() {
    this.closeModal('modal-admin-pin');
    const step1 = document.getElementById('forgot-pin-step-1');
    const step2 = document.getElementById('forgot-pin-step-2');
    if (step1) step1.style.display = 'block';
    if (step2) step2.style.display = 'none';
    const otpInp = document.getElementById('input-forgot-otp');
    if (otpInp) otpInp.value = '';
    const newPinInp = document.getElementById('input-forgot-new-pin');
    if (newPinInp) newPinInp.value = '';
    this.openModal('modal-admin-forgot-pin', { isChild: true });
  },

  async requestForgotPinOtp() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const btn = document.getElementById('btn-send-forgot-otp');
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = isEn ? '<span>⏳</span> <span>Sending...</span>' : '<span>⏳</span> <span>મોકલી રહ્યું છે...</span>';
    }

    try {
      const res = await fetch('/api/admin/forgot-pin-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast(data.message || (isEn ? 'OTP has been sent to your email!' : 'OTP તમારા ઈમેલ પર મોકલાઈ ગયો છે!'), 'success');
        const step1 = document.getElementById('forgot-pin-step-1');
        const step2 = document.getElementById('forgot-pin-step-2');
        if (step1) step1.style.display = 'none';
        if (step2) step2.style.display = 'block';
        const otpInp = document.getElementById('input-forgot-otp');
        if (otpInp) {
          otpInp.value = '';
          setTimeout(() => otpInp.focus(), 100);
        }
      } else {
        this.showToast(data.error || (isEn ? 'Error sending OTP' : 'OTP મોકલવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      this.showToast(isEn ? 'Error connecting to server' : 'સર્વર સાથે કનેક્ટ કરવામાં ભૂલ આવી', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  },

  async submitResetPinOtp() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const otpInp = document.getElementById('input-forgot-otp');
    const newPinInp = document.getElementById('input-forgot-new-pin');
    const otp = otpInp ? otpInp.value.trim() : '';
    const newPin = newPinInp ? newPinInp.value.trim() : '';

    if (!otp || otp.length < 6) {
      this.showToast(isEn ? 'Please enter valid 6-digit OTP' : 'કૃપા કરીને 6-અંકનો સાચો OTP નાખો', 'error');
      if (otpInp) otpInp.focus();
      return;
    }

    if (!newPin || newPin.length < 4) {
      this.showToast(isEn ? 'New PIN must be at least 4 digits' : 'નવો પિન ઓછામાં ઓછો 4 અંકનો હોવો જોઈએ', 'error');
      if (newPinInp) newPinInp.focus();
      return;
    }

    const btn = document.getElementById('btn-submit-forgot-reset');
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = isEn ? '<span>⏳</span> <span>Verifying...</span>' : '<span>⏳</span> <span>ચકાસી રહ્યું છે...</span>';
    }

    try {
      const res = await fetch('/api/admin/reset-pin-with-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp, newPin })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast('🎉 ' + (data.message || (isEn ? 'New PIN set successfully!' : 'નવો પિન સફળતાપૂર્વક સેટ થઈ ગયો!')), 'success');
        this.closeModal('modal-admin-forgot-pin');
        setTimeout(() => {
          this.openModal('modal-admin-pin', { isChild: true });
          const pinInp = document.getElementById('input-admin-pin-auth');
          if (pinInp) {
            pinInp.value = newPin;
            pinInp.focus();
          }
        }, 300);
      } else {
        this.showToast(data.error || (isEn ? 'Error resetting PIN' : 'પિન રીસેટ કરવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      this.showToast(isEn ? 'Error connecting to server' : 'સર્વર સાથે કનેક્ટ કરવામાં ભૂલ આવી', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  },

  async sendAdminTestEmail() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const alertEmailInp = document.getElementById('admin-setting-alert-email');
    const email = alertEmailInp ? alertEmailInp.value.trim() : '';
    const senderName = 'Gadisthan Jetpur';
    this.showToast(isEn ? '📧 Sending test email...' : '📧 ટેસ્ટ ઈમેલ મોકલાઈ રહ્યો છે...', 'info');

    try {
      const res = await fetch('/api/admin/test-email', {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ email, senderName })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;
      if (data.success) {
        this.showToast('✅ ' + data.message, 'success');
      } else {
        this.showToast('❌ ' + (data.error || (isEn ? 'Failed to send test email' : 'ટેસ્ટ ઈમેલ મોકલવામાં નિષ્ફળતા')), 'error');
      }
    } catch (e) {
      this.showToast(isEn ? 'Error connecting to server' : 'સર્વર સાથે કનેક્ટ કરવામાં ભૂલ આવી', 'error');
    }
  },

  switchAdminTab(tabName, btnElement = null) {
    document.querySelectorAll('.admin-tab-btn, .admin-sidebar-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.admin-tab-content').forEach(tab => tab.classList.remove('active'));

    const btn = btnElement || document.getElementById(`admin-nav-${tabName}`) || (window.event && window.event.currentTarget);
    if (btn) btn.classList.add('active');
    const tabEl = document.getElementById(`admin-tab-${tabName}`);
    if (tabEl) tabEl.classList.add('active');

    // Contextual footer button handling to prevent user confusion:
    const globalSaveBtn = document.getElementById('admin-btn-global-save');
    if (globalSaveBtn) {
      if (tabName === 'master-hisab' || tabName === 'employees' || tabName === 'bhakts' || tabName === 'history' || tabName === 'users') {
        globalSaveBtn.style.display = 'none'; // Each of these tabs has its own distinct, dedicated save action
      } else {
        const isEn = window.i18n && window.i18n.currentLang === 'en';
        globalSaveBtn.style.display = 'inline-flex';
        globalSaveBtn.innerHTML = `<span>💾</span> <span>${isEn ? 'Save & Apply' : 'સાચવો'}</span>`;
      }
    }

    // Reset scroll position to top when switching tabs
    const body = document.querySelector('.admin-modal-body');
    if (body) body.scrollTop = 0;

    if (tabName === 'master-hisab') {
      const dateInput = document.getElementById('admin-master-date-input');
      const targetDate = (dateInput && dateInput.value) ? dateInput.value : this.currentDate;
      this.adminLoadMasterHisab(targetDate);
    } else if (tabName === 'bhakts') {
      this.adminLoadBhaktsTab();
    } else if (tabName === 'vouchers') {
      const vInp = document.getElementById('admin-input-new-voucher');
      if (vInp) {
        const isEn = window.i18n && window.i18n.currentLang === 'en';
        vInp.placeholder = isEn
          ? 'ENTER VOUCHER NAME (E.G. MANDIRKHARCH, LIGHT BILL)'
          : 'ખર્ચ / વાઉચરનું નામ લખો (દા.ત. લાઈટ બિલ, રીપેરીંગ, સ્ટેશનરી, દૂધ ખર્ચ)';
        if (!isEn && window.GujaratiTyping) {
          window.GujaratiTyping.attach(vInp);
        }
      }
    } else if (tabName === 'general') {
      setTimeout(() => this.renderAdminPrintPreview(), 50);
    } else if (tabName === 'history') {
      this.loadAdminHistory();
    } else if (tabName === 'users') {
      this.loadUsersList();
      this.loadLoginHistory();
    }
  },

  adminBankStatusFilter: 'active',
  adminVoucherStatusFilter: 'active',
  adminBankEditMode: false,
  adminVoucherEditMode: false,
  adminEmpEditMode: false,
  adminBhaktEditMode: false,

  setAdminBankStatusFilter(filter) {
    this.adminBankStatusFilter = filter;
    ['all', 'active', 'inactive'].forEach(f => {
      const btn = document.getElementById(`admin-bank-filter-${f}`);
      if (btn) {
        if (f === filter) {
          btn.classList.add('active');
          btn.style.background = '#0f172a';
          btn.style.color = '#ffffff';
        } else {
          btn.classList.remove('active');
          btn.style.background = '#ffffff';
          btn.style.color = '#334155';
        }
      }
    });
    this.renderAdminLists();
  },

  setAdminVoucherStatusFilter(filter) {
    this.adminVoucherStatusFilter = filter;
    ['all', 'active', 'inactive'].forEach(f => {
      const btn = document.getElementById(`admin-voucher-filter-${f}`);
      if (btn) {
        if (f === filter) {
          btn.classList.add('active');
          btn.style.background = '#0f172a';
          btn.style.color = '#ffffff';
        } else {
          btn.classList.remove('active');
          btn.style.background = '#ffffff';
          btn.style.color = '#334155';
        }
      }
    });
    this.renderAdminLists();
  },

  toggleAdminBankEditMode() {
    this.adminBankEditMode = !this.adminBankEditMode;
    this.renderAdminLists();
  },

  toggleAdminVoucherEditMode() {
    this.adminVoucherEditMode = !this.adminVoucherEditMode;
    this.renderAdminLists();
  },

  toggleAdminEmpEditMode() {
    this.adminEmpEditMode = !this.adminEmpEditMode;
    this.renderAdminEmployeesList();
  },

  toggleAdminBhaktEditMode() {
    this.adminBhaktEditMode = !this.adminBhaktEditMode;
    this.renderAdminBhaktsList();
  },

  toggleAdminEmpAddForm(forceState) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const form = document.getElementById('admin-emp-form-container');
    const icon = document.getElementById('admin-emp-add-toggle-icon');
    const text = document.getElementById('admin-emp-add-toggle-text');
    if (!form) return;
    const shouldOpen = typeof forceState === 'boolean' ? forceState : form.style.display === 'none';
    form.style.display = shouldOpen ? 'block' : 'none';
    if (icon) icon.textContent = shouldOpen ? '✕' : '➕';
    if (text) text.textContent = shouldOpen ? (isEn ? 'Close Form' : 'ફોર્મ બંધ કરો') : (isEn ? 'Add Staff' : 'નવો કર્મચારી ઉમેરો');
    if (shouldOpen) {
      setTimeout(() => {
        const nameInp = document.getElementById('admin-emp-name');
        if (nameInp) nameInp.focus();
      }, 50);
    }
  },

  toggleAdminBhaktAddForm(forceState) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const form = document.getElementById('admin-bhakt-form-container');
    const icon = document.getElementById('admin-bhakt-add-toggle-icon');
    const text = document.getElementById('admin-bhakt-add-toggle-text');
    if (!form) return;
    const shouldOpen = typeof forceState === 'boolean' ? forceState : form.style.display === 'none';
    form.style.display = shouldOpen ? 'block' : 'none';
    if (icon) icon.textContent = shouldOpen ? '✕' : '➕';
    if (text) text.textContent = shouldOpen ? (isEn ? 'Close Form' : 'ફોર્મ બંધ કરો') : (isEn ? 'Add Member' : 'નવો હરિભક્ત ઉમેરો');
    if (shouldOpen) {
      setTimeout(() => {
        const nameInp = document.getElementById('admin-bhakt-name');
        if (nameInp) nameInp.focus();
      }, 50);
    }
  },

  toggleAdminBankAddForm(forceState) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const form = document.getElementById('admin-bank-add-container');
    const icon = document.getElementById('admin-bank-add-toggle-icon');
    const text = document.getElementById('admin-bank-add-toggle-text');
    if (!form) return;
    const shouldOpen = typeof forceState === 'boolean' ? forceState : form.style.display === 'none';
    form.style.display = shouldOpen ? 'block' : 'none';
    if (icon) icon.textContent = shouldOpen ? '✕' : '➕';
    if (text) text.textContent = shouldOpen ? (isEn ? 'Close' : 'બંધ કરો') : (isEn ? 'Add Bank' : 'નવી બેંક ઉમેરો');
    if (shouldOpen) {
      setTimeout(() => {
        const inp = document.getElementById('admin-input-new-bank');
        if (inp) inp.focus();
      }, 50);
    }
  },

  toggleAdminVoucherAddForm(forceState) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const form = document.getElementById('admin-voucher-add-container');
    const icon = document.getElementById('admin-voucher-add-toggle-icon');
    const text = document.getElementById('admin-voucher-add-toggle-text');
    if (!form) return;
    const shouldOpen = typeof forceState === 'boolean' ? forceState : form.style.display === 'none';
    form.style.display = shouldOpen ? 'block' : 'none';
    if (icon) icon.textContent = shouldOpen ? '✕' : '➕';
    if (text) text.textContent = shouldOpen ? (isEn ? 'Close' : 'બંધ કરો') : (isEn ? 'Add Voucher' : 'નવું વાઉચર ઉમેરો');
    if (shouldOpen) {
      setTimeout(() => {
        const inp = document.getElementById('admin-input-new-voucher');
        if (inp) inp.focus();
      }, 50);
    }
  },

  renderAdminLists() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';

    // Update Top Bank Buttons State
    const bBtn = document.getElementById('admin-bank-edit-toggle-btn');
    const bIcon = document.getElementById('admin-bank-edit-toggle-icon');
    const bText = document.getElementById('admin-bank-edit-toggle-text');
    if (bBtn && bIcon && bText) {
      if (this.adminBankEditMode) {
        bBtn.style.background = 'linear-gradient(135deg, #15803d, #166534)';
        bIcon.textContent = '✓';
        bText.textContent = isEn ? 'Done' : 'પૂર્ણ થયું';
      } else {
        bBtn.style.background = 'linear-gradient(135deg, #0284c7, #0369a1)';
        bIcon.textContent = '🛠️';
        bText.textContent = isEn ? 'Change / Manage' : 'ફેરફાર કરો';
      }
    }
    const bAddForm = document.getElementById('admin-bank-add-container');
    const bAddIcon = document.getElementById('admin-bank-add-toggle-icon');
    const bAddText = document.getElementById('admin-bank-add-toggle-text');
    if (bAddIcon && bAddText) {
      const isOpen = bAddForm && bAddForm.style.display !== 'none';
      bAddIcon.textContent = isOpen ? '✕' : '➕';
      bAddText.textContent = isOpen ? (isEn ? 'Close' : 'બંધ કરો') : (isEn ? 'Add Bank' : 'નવી બેંક ઉમેરો');
    }

    // Update Top Voucher Buttons State
    const vBtn = document.getElementById('admin-voucher-edit-toggle-btn');
    const vIcon = document.getElementById('admin-voucher-edit-toggle-icon');
    const vText = document.getElementById('admin-voucher-edit-toggle-text');
    if (vBtn && vIcon && vText) {
      if (this.adminVoucherEditMode) {
        vBtn.style.background = 'linear-gradient(135deg, #15803d, #166534)';
        vIcon.textContent = '✓';
        vText.textContent = isEn ? 'Done' : 'પૂર્ણ થયું';
      } else {
        vBtn.style.background = 'linear-gradient(135deg, #0284c7, #0369a1)';
        vIcon.textContent = '🛠️';
        vText.textContent = isEn ? 'Change / Manage' : 'ફેરફાર કરો';
      }
    }
    const vAddForm = document.getElementById('admin-voucher-add-container');
    const vAddIcon = document.getElementById('admin-voucher-add-toggle-icon');
    const vAddText = document.getElementById('admin-voucher-add-toggle-text');
    if (vAddIcon && vAddText) {
      const isOpen = vAddForm && vAddForm.style.display !== 'none';
      vAddIcon.textContent = isOpen ? '✕' : '➕';
      vAddText.textContent = isOpen ? (isEn ? 'Close' : 'બંધ કરો') : (isEn ? 'Add Voucher' : 'નવું વાઉચર ઉમેરો');
    }

    // 1. Render Admin Notes List
    const notesContainer = document.getElementById('admin-notes-list');
    if (notesContainer) {
      notesContainer.innerHTML = '';
      this.adminData.notes.forEach(noteVal => {
        const row = document.createElement('div');
        row.className = 'admin-item-row';
        row.innerHTML = `
          <div style="display: flex; align-items: center; gap: 10px;">
            <span class="denom-badge denom-${noteVal}">₹ ${noteVal}</span>
            <span class="admin-item-title">₹ ${noteVal} ${isEn ? 'Note / Coin' : 'નોટ / સિક્કો'}</span>
          </div>
          <button class="admin-item-del-btn" onclick="App.adminRemoveNote(${noteVal})" title="${isEn ? 'Remove' : 'કાઢો'}">✕</button>
        `;
        notesContainer.appendChild(row);
      });
    }

    // 2. Render Admin Banks List (Active & Inactive + Status Filter)
    const banksContainer = document.getElementById('admin-banks-list');
    if (banksContainer) {
      banksContainer.innerHTML = '';
      const activeBanks = (this.adminData.banks || []).map(b => ({ name: b, active: true }));
      const inactiveBanks = (this.adminData.inactiveBanks || []).map(b => ({ name: b, active: false }));

      const countAll = activeBanks.length + inactiveBanks.length;
      const countActive = activeBanks.length;
      const countInactive = inactiveBanks.length;

      const cAllEl = document.getElementById('admin-bank-count-all');
      const cActEl = document.getElementById('admin-bank-count-active');
      const cInEl = document.getElementById('admin-bank-count-inactive');
      if (cAllEl) cAllEl.textContent = `(${countAll})`;
      if (cActEl) cActEl.textContent = `(${countActive})`;
      if (cInEl) cInEl.textContent = `(${countInactive})`;

      let displayBanks = [];
      if (this.adminBankStatusFilter === 'active') {
        displayBanks = activeBanks;
      } else if (this.adminBankStatusFilter === 'inactive') {
        displayBanks = inactiveBanks;
      } else {
        displayBanks = [...activeBanks, ...inactiveBanks];
      }

      if (displayBanks.length === 0) {
        banksContainer.innerHTML = `
          <div style="text-align: center; padding: 24px 16px; color: var(--text-muted); background: #f8fafc; border-radius: var(--radius-sm); border: 1px dashed #cbd5e1;">
            <div style="font-size: 1.8rem; margin-bottom: 4px;">🏦</div>
            <div style="font-weight: 600;">${isEn ? 'No bank accounts found in this filter.' : 'આ ફિલ્ટરમાં કોઈ બેંક ખાતું મળ્યું નથી.'}</div>
          </div>
        `;
      } else {
        displayBanks.forEach(item => {
          const bankName = item.name;
          const isActive = item.active;
          const row = document.createElement('div');
          row.className = 'admin-item-row';
          row.style.background = isActive ? '#ffffff' : '#f8fafc';
          row.style.border = this.adminBankEditMode ? '1px solid #93c5fd' : (isActive ? '1px solid #e2e8f0' : '1px dashed #cbd5e1');

          const actionsHtml = this.adminBankEditMode ? `
            <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
              <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #1e40af; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; font-weight: 600;" onclick="App.openAdminRenameModal('bank', '${bankName.replace(/'/g, "\\'")}')" title="${isEn ? 'Rename' : 'નામ સુધારો'}">
                <span>✏️</span> <span>${isEn ? 'Edit' : 'સુધારો'}</span>
              </button>
              ${isActive ? `
                <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #b45309; background: #fef3c7; border: 1px solid #fde68a; border-radius: 6px; font-weight: 600;" onclick="App.adminToggleBankStatus('${bankName.replace(/'/g, "\\'")}', false)" title="${isEn ? 'Deactivate bank' : 'આ બેંક બંધ કરો'}">
                  <span>⏸️</span> <span>${isEn ? 'Deactivate' : 'બંધ કરો'}</span>
                </button>
              ` : `
                <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #15803d; background: #dcfce7; border: 1px solid #bbf7d0; border-radius: 6px; font-weight: 600;" onclick="App.adminToggleBankStatus('${bankName.replace(/'/g, "\\'")}', true)" title="${isEn ? 'Activate bank' : 'આ બેંક ફરી ચાલુ કરો'}">
                  <span>▶️</span> <span>${isEn ? 'Activate' : 'ચાલુ કરો'}</span>
                </button>
              `}
              <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #b91c1c; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 6px; font-weight: 600;" onclick="App.adminDeleteBank('${bankName.replace(/'/g, "\\'")}')" title="${isEn ? 'Permanently Delete' : 'કાયમી ડિલીટ'}">
                <span>🗑️</span> <span>${isEn ? 'Delete' : 'ડિલીટ'}</span>
              </button>
            </div>
          ` : ``;

          row.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <span style="font-size: 1.15rem;">🏦</span>
              <span class="admin-item-title" style="font-weight: 700; ${isActive ? '' : 'color: #64748b;'}">${bankName}</span>
              ${isActive ? '' : `
                <span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1;">
                  ${isEn ? '⏸️ Inactive' : '⏸️ નિષ્ક્રિય'}
                </span>
              `}
            </div>
            ${actionsHtml}
          `;
          banksContainer.appendChild(row);
        });
      }
    }

    // 3. Render Admin Vouchers List (Active & Inactive + Status Filter)
    const vouchersContainer = document.getElementById('admin-vouchers-list');
    if (vouchersContainer) {
      vouchersContainer.innerHTML = '';
      const activeVouchers = (this.adminData.vouchers || []).map(v => ({ name: v, active: true }));
      const inactiveVouchers = (this.adminData.inactiveVouchers || []).map(v => ({ name: v, active: false }));

      const countAll = activeVouchers.length + inactiveVouchers.length;
      const countActive = activeVouchers.length;
      const countInactive = inactiveVouchers.length;

      const cAllEl = document.getElementById('admin-voucher-count-all');
      const cActEl = document.getElementById('admin-voucher-count-active');
      const cInEl = document.getElementById('admin-voucher-count-inactive');
      if (cAllEl) cAllEl.textContent = `(${countAll})`;
      if (cActEl) cActEl.textContent = `(${countActive})`;
      if (cInEl) cInEl.textContent = `(${countInactive})`;

      let displayVouchers = [];
      if (this.adminVoucherStatusFilter === 'active') {
        displayVouchers = activeVouchers;
      } else if (this.adminVoucherStatusFilter === 'inactive') {
        displayVouchers = inactiveVouchers;
      } else {
        displayVouchers = [...activeVouchers, ...inactiveVouchers];
      }

      if (displayVouchers.length === 0) {
        vouchersContainer.innerHTML = `
          <div style="text-align: center; padding: 24px 16px; color: var(--text-muted); background: #f8fafc; border-radius: var(--radius-sm); border: 1px dashed #cbd5e1;">
            <div style="font-size: 1.8rem; margin-bottom: 4px;">🧾</div>
            <div style="font-weight: 600;">${isEn ? 'No voucher accounts found in this filter.' : 'આ ફિલ્ટરમાં કોઈ વાઉચર ખાતું મળ્યું નથી.'}</div>
          </div>
        `;
      } else {
        displayVouchers.forEach(item => {
          const vouchName = item.name;
          const isActive = item.active;
          const row = document.createElement('div');
          row.className = 'admin-item-row';
          row.style.background = isActive ? '#ffffff' : '#f8fafc';
          row.style.border = this.adminVoucherEditMode ? '1px solid #c7d2fe' : (isActive ? '1px solid #e2e8f0' : '1px dashed #cbd5e1');

          const gujName = this.getKhataNameInGujarati(vouchName);
          let sideEnglish = this.getEnglishKhataName(vouchName);
          if (gujName) {
            const canonicalEng = this.getEnglishKhataName(gujName);
            if (canonicalEng && canonicalEng.length >= (sideEnglish ? sideEnglish.length : 0)) {
              sideEnglish = canonicalEng;
            }
          }
          const displayName = isEn ? (sideEnglish || vouchName) : (gujName || vouchName);
          const secondaryBadge = isEn
            ? (gujName && gujName !== displayName ? `(${gujName})` : '')
            : (sideEnglish ? `(${sideEnglish})` : '');

          const actionsHtml = this.adminVoucherEditMode ? `
            <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
              <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #1e40af; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; font-weight: 600;" onclick="App.openAdminRenameModal('voucher', '${vouchName.replace(/'/g, "\\'")}')" title="${isEn ? 'Rename' : 'નામ સુધારો'}">
                <span>✏️</span> <span>${isEn ? 'Edit' : 'સુધારો'}</span>
              </button>
              ${isActive ? `
                <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #b45309; background: #fef3c7; border: 1px solid #fde68a; border-radius: 6px; font-weight: 600;" onclick="App.adminToggleVoucherStatus('${vouchName.replace(/'/g, "\\'")}', false)" title="${isEn ? 'Deactivate voucher' : 'આ વાઉચર બંધ કરો'}">
                  <span>⏸️</span> <span>${isEn ? 'Deactivate' : 'બંધ કરો'}</span>
                </button>
              ` : `
                <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #15803d; background: #dcfce7; border: 1px solid #bbf7d0; border-radius: 6px; font-weight: 600;" onclick="App.adminToggleVoucherStatus('${vouchName.replace(/'/g, "\\'")}', true)" title="${isEn ? 'Activate voucher' : 'આ વાઉચર ફરી ચાલુ કરો'}">
                  <span>▶️</span> <span>${isEn ? 'Activate' : 'ચાલુ કરો'}</span>
                </button>
              `}
              <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #b91c1c; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 6px; font-weight: 600;" onclick="App.adminDeleteVoucher('${vouchName.replace(/'/g, "\\'")}')" title="${isEn ? 'Permanently Delete' : 'કાયમી ડિલીટ'}">
                <span>🗑️</span> <span>${isEn ? 'Delete' : 'ડિલીટ'}</span>
              </button>
            </div>
          ` : ``;

          row.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <span style="font-size: 1.15rem;">🧾</span>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <span class="admin-item-title" style="font-weight: 800; font-size: 1.05rem; color: ${isActive ? '#1e3a8a' : '#64748b'};">${displayName}</span>
                ${secondaryBadge ? `<span class="admin-item-eng-badge" style="font-size: 0.82rem; color: #1e40af; background: #eff6ff; border: 1px solid #bfdbfe; padding: 2px 8px; border-radius: 4px; font-weight: 800; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: 0.5px;">${secondaryBadge}</span>` : ''}
                ${isActive ? '' : `
                  <span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1;">
                    ${isEn ? '⏸️ Inactive' : '⏸️ નિષ્ક્રિય'}
                  </span>
                `}
              </div>
            </div>
            ${actionsHtml}
          `;
          vouchersContainer.appendChild(row);
        });
      }
    }

    // 4. Render Admin Employees List
    this.renderAdminEmployeesList();
  },

  adminEmpPaymentFilter: 'all',

  setAdminEmpPaymentFilter(filter) {
    this.adminEmpPaymentFilter = filter;
    ['cycle-all', 'monthly', '15days'].forEach(f => {
      const btn = document.getElementById(`admin-emp-filter-${f}`);
      if (btn) {
        const isMatch = (f === 'cycle-all' && filter === 'all') || (f === filter);
        if (isMatch) {
          btn.classList.add('active');
          btn.style.background = '#0f172a';
          btn.style.color = '#ffffff';
        } else {
          btn.classList.remove('active');
          btn.style.background = '#ffffff';
          btn.style.color = '#334155';
        }
      }
    });
    this.renderAdminEmployeesList();
  },

  setAdminEmpStatusFilter(filter) {
    this.adminEmpStatusFilter = filter;
    ['all', 'active', 'inactive'].forEach(f => {
      const btn = document.getElementById(`admin-emp-filter-${f}`);
      if (btn) {
        if (f === filter) {
          btn.classList.add('active');
          btn.style.background = '#0f172a';
          btn.style.color = '#ffffff';
        } else {
          btn.classList.remove('active');
          btn.style.background = '#ffffff';
          btn.style.color = '#334155';
        }
      }
    });
    this.renderAdminEmployeesList();
  },

  renderAdminEmployeesList() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const container = document.getElementById('admin-employees-list');
    if (!container) return;
    container.innerHTML = '';

    // Update Top Toggle Button State
    const eBtn = document.getElementById('admin-emp-edit-toggle-btn');
    const eIcon = document.getElementById('admin-emp-edit-toggle-icon');
    const eText = document.getElementById('admin-emp-edit-toggle-text');
    if (eBtn && eIcon && eText) {
      if (this.adminEmpEditMode) {
        eBtn.style.background = 'linear-gradient(135deg, #15803d, #166534)';
        eIcon.textContent = '✓';
        eText.textContent = isEn ? 'Done' : 'પૂર્ણ થયું';
      } else {
        eBtn.style.background = 'linear-gradient(135deg, #2563eb, #1d4ed8)';
        eIcon.textContent = '🛠️';
        eText.textContent = isEn ? 'Change / Manage' : 'ફેરફાર કરો';
      }
    }

    const eAddForm = document.getElementById('admin-emp-form-container');
    const eAddIcon = document.getElementById('admin-emp-add-toggle-icon');
    const eAddText = document.getElementById('admin-emp-add-toggle-text');
    if (eAddIcon && eAddText) {
      const isOpen = eAddForm && eAddForm.style.display !== 'none';
      eAddIcon.textContent = isOpen ? '✕' : '➕';
      eAddText.textContent = isOpen ? (isEn ? 'Close Form' : 'ફોર્મ બંધ કરો') : (isEn ? 'Add Staff' : 'નવો કર્મચારી ઉમેરો');
    }

    const allEmps = this.employeesList || [];
    const countAll = allEmps.length;
    const countActive = allEmps.filter(e => e.status !== 'inactive').length;
    const countInactive = allEmps.filter(e => e.status === 'inactive').length;
    const countMonthly = allEmps.filter(e => (e.paymentType || 'monthly') === 'monthly').length;
    const count15Days = allEmps.filter(e => e.paymentType === '15days').length;

    const cAllEl = document.getElementById('admin-emp-count-all');
    const cActEl = document.getElementById('admin-emp-count-active');
    const cInEl = document.getElementById('admin-emp-count-inactive');
    const cMonthlyEl = document.getElementById('admin-emp-count-monthly');
    const c15DaysEl = document.getElementById('admin-emp-count-15days');
    if (cAllEl) cAllEl.textContent = `(${countAll})`;
    if (cActEl) cActEl.textContent = `(${countActive})`;
    if (cInEl) cInEl.textContent = `(${countInactive})`;
    if (cMonthlyEl) cMonthlyEl.textContent = `(${countMonthly})`;
    if (c15DaysEl) c15DaysEl.textContent = `(${count15Days})`;

    let list = allEmps;
    if (this.adminEmpStatusFilter === 'active') {
      list = list.filter(e => e.status !== 'inactive');
    } else if (this.adminEmpStatusFilter === 'inactive') {
      list = list.filter(e => e.status === 'inactive');
    }

    if (this.adminEmpPaymentFilter === 'monthly') {
      list = list.filter(e => (e.paymentType || 'monthly') === 'monthly');
    } else if (this.adminEmpPaymentFilter === '15days') {
      list = list.filter(e => e.paymentType === '15days');
    }

    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 24px 16px; color: var(--text-muted); background: #f8fafc; border-radius: var(--radius-sm);">
          <div style="font-size: 1.8rem; margin-bottom: 4px;">👥</div>
          <div>${isEn ? 'No employees found in this filter.' : 'આ ફિલ્ટરમાં કોઈ કર્મચારી મળ્યો નથી.'}</div>
        </div>
      `;
      return;
    }

    list.forEach(emp => {
      const initials = (emp.name || 'E').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
      const isInactive = emp.status === 'inactive';
      const is15Days = emp.paymentType === '15days';
      const paymentBadge = is15Days
        ? `<span style="font-size: 0.74rem; background: #fef3c7; color: #92400e; font-weight: 800; padding: 2px 7px; border-radius: 6px; border: 1px solid #fde68a;">⏳ ૧૫ દિવસ</span>`
        : `<span style="font-size: 0.74rem; background: #e0e7ff; color: #3730a3; font-weight: 800; padding: 2px 7px; border-radius: 6px; border: 1px solid #c7d2fe;">📅 માસિક</span>`;

      const row = document.createElement('div');
      row.className = 'admin-item-row';
      row.style.padding = '10px 14px';
      row.style.background = isInactive ? '#f8fafc' : '#ffffff';
      row.style.border = this.adminEmpEditMode ? '1px solid #93c5fd' : (isInactive ? '1px dashed #cbd5e1' : '1px solid #e2e8f0');
      if (isInactive) {
        row.style.opacity = '0.78';
      }

      const actionsHtml = this.adminEmpEditMode ? `
        <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
          <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #1e40af; background: #eff6ff; border: 1px solid #bfdbfe; font-weight: 700; border-radius: 6px;" onclick="App.adminEditEmployee('${emp.id}')" title="${isEn ? 'Edit Details' : 'વિગતો સુધારો'}">
            <span>✏️</span> <span>${isEn ? 'Edit' : 'સુધારો'}</span>
          </button>
          <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: ${isInactive ? '#15803d' : '#b45309'}; background: ${isInactive ? '#f0fdf4' : '#fffbeb'}; border: 1px solid ${isInactive ? '#86efac' : '#fde68a'}; font-weight: 700; border-radius: 6px;" onclick="App.adminToggleEmployeeStatus('${emp.id}')" title="${isInactive ? (isEn ? 'Activate' : 'ફરી સક્રિય કરો') : (isEn ? 'Deactivate' : 'છૂટા કરો (નિષ્ક્રિય)')}">
            ${isInactive ? (isEn ? '🟢 Activate' : '🟢 ચાલુ કરો') : (isEn ? '⚪ Deactivate' : '⚪ છૂટા કરો')}
          </button>
          <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #b91c1c; background: #fee2e2; border: 1px solid #fca5a5; font-weight: 700; border-radius: 6px;" onclick="App.adminDeleteEmployee('${emp.id}')" title="${isEn ? 'Permanently remove employee' : 'કર્મચારી કાયમી કાઢી નાખો'}">
            <span>🗑️</span> <span>${isEn ? 'Delete' : 'ડિલીટ'}</span>
          </button>
        </div>
      ` : ``;

      row.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
          <span class="emp-row-avatar" style="${isInactive ? 'background: #94a3b8;' : ''}">${initials}</span>
          <div style="min-width: 0;">
            <div style="font-weight: 700; color: var(--text-main); font-size: 0.95rem; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span>${emp.name}</span>
              <span class="emp-role-badge">${emp.role || (isEn ? 'Staff' : 'સ્ટાફ')}</span>
              ${paymentBadge}
              ${isInactive
          ? `<span style="font-size: 0.72rem; background: #fee2e2; color: #b91c1c; font-weight: 800; padding: 1px 6px; border-radius: 4px;">${isEn ? 'Inactive' : 'છૂટા કરેલ'}</span>`
          : ''}
            </div>
            <div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 2px;">
              ${emp.phone ? `📞 ${emp.phone} | ` : ''}${is15Days ? (isEn ? '15-Day Fixed Salary:' : '૧૫ દિવસીય નક્કી પગાર:') : (isEn ? 'Monthly Fixed Salary:' : 'માસિક નક્કી પગાર:')} <strong style="color: #059669;">₹ ${(Number(emp.salary) || 0).toLocaleString('en-IN')}</strong>
            </div>
          </div>
        </div>
        ${actionsHtml}
      `;
      container.appendChild(row);
    });
  },

  async adminToggleEmployeeStatus(empId) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const emp = (this.employeesList || []).find(e => e.id === empId);
    if (!emp) return;
    const newStatus = emp.status === 'inactive' ? 'active' : 'inactive';
    const actionLabel = newStatus === 'active'
      ? (isEn ? 'active' : 'સક્રિય')
      : (isEn ? 'inactive' : 'છૂટા (નિષ્ક્રિય)');
    if (!confirm(isEn ? `Do you want to set employee "${emp.name}" as ${actionLabel}?` : `શું તમે કર્મચારી "${emp.name}" ને ${actionLabel} કરવા માંગો છો?`)) return;

    try {
      const res = await fetch(`/api/employees/${empId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const data = await res.json();
      if (data.success) {
        emp.status = newStatus;
        this.renderAdminEmployeesList();
        this.showToast(isEn ? `Employee "${emp.name}" is now ${actionLabel}!` : `કર્મચારી "${emp.name}" ${actionLabel} થયા!`, 'success');
        if (typeof this.populateExpenseEmployeeDropdown === 'function') {
          this.populateExpenseEmployeeDropdown();
        }
      }
    } catch (e) {
      this.showToast(isEn ? 'Error updating status' : 'સ્ટેટસ બદલવામાં ભૂલ આવી', 'error');
    }
  },

  openAdminRenameModal(type, oldName) {
    const modal = document.getElementById('modal-admin-rename');
    const titleEl = document.getElementById('admin-rename-modal-title');
    const typeInp = document.getElementById('admin-rename-type');
    const oldInp = document.getElementById('admin-rename-old');
    const oldDisp = document.getElementById('admin-rename-old-disp');
    const newInp = document.getElementById('admin-rename-new-input');

    if (!modal) return;
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    typeInp.value = type;
    oldInp.value = oldName;
    const gujOld = this.getKhataNameInGujarati(oldName);
    oldDisp.value = (type === 'voucher') ? ((gujOld && gujOld !== oldName) ? `${gujOld} (${oldName})` : (gujOld || oldName)) : oldName;
    newInp.value = (type === 'voucher' && gujOld && !isEn) ? gujOld : oldName;
    titleEl.textContent = type === 'bank'
      ? (isEn ? '🏦 Rename Bank Account' : '🏦 બેંક ખાતાનું નામ સુધારો')
      : (isEn ? '🧾 Rename Voucher / Expense' : '🧾 વાઉચર / ખર્ચનું નામ સુધારો');

    if (type === 'voucher') {
      newInp.classList.add('auto-gujarati');
      newInp.style.textTransform = 'none';
      newInp.placeholder = isEn
        ? 'Enter new voucher name (e.g. Light Bill, Repairs, Stationery)...'
        : 'વાઉચરનું નવું નામ લખો (દા.ત. લાઈટ બિલ, રીપેરીંગ, સ્ટેશનરી)...';
      if (!isEn && window.GujaratiTyping) window.GujaratiTyping.attach(newInp);
    } else {
      newInp.classList.remove('auto-gujarati');
      newInp.style.textTransform = 'uppercase';
      newInp.placeholder = 'Enter new bank name in English (e.g. SBI, HDFC)...';
    }

    this.openModal('modal-admin-rename', { isChild: true });
    setTimeout(() => { newInp.focus(); newInp.select(); }, 100);
  },

  async submitAdminRename(e) {
    if (e) e.preventDefault();
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const type = document.getElementById('admin-rename-type').value;
    const oldName = document.getElementById('admin-rename-old').value;
    let newName = document.getElementById('admin-rename-new-input').value.trim();
    if (type === 'bank') {
      newName = newName.toUpperCase();
    }

    if (!newName) {
      this.showToast(isEn ? 'Enter a new name' : 'નવું નામ લખો', 'error');
      return;
    }
    if (newName === oldName) {
      this.closeModal('modal-admin-rename');
      return;
    }

    try {
      const url = type === 'bank' ? '/api/admin/rename-bank' : '/api/admin/rename-voucher';
      const res = await fetch(url, {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ oldName, newName })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;

      if (res.ok && data.success) {
        if (type === 'bank') {
          this.adminData.banks = data.banks || this.adminData.banks;
          this.adminData.inactiveBanks = data.inactiveBanks || this.adminData.inactiveBanks || [];
          this.fixedBanks = data.banks || this.fixedBanks;
          if (this.settings) {
            this.settings.defaultBanks = data.banks || this.settings.defaultBanks;
            this.settings.inactiveBanks = data.inactiveBanks || this.settings.inactiveBanks || [];
          }
        } else {
          this.adminData.vouchers = data.vouchers || this.adminData.vouchers;
          this.adminData.inactiveVouchers = data.inactiveVouchers || this.adminData.inactiveVouchers || [];
          this.fixedVouchers = data.vouchers || this.fixedVouchers;
          if (this.settings) {
            this.settings.defaultVouchers = data.vouchers || this.settings.defaultVouchers;
            this.settings.inactiveVouchers = data.inactiveVouchers || this.settings.inactiveVouchers || [];
          }
        }
        this.closeModal('modal-admin-rename');
        this.renderAdminLists();
        this.showToast(isEn ? `✅ Name changed to "${newName}"!` : `✅ નામ બદલાઈને "${newName}" થઈ ગયું!`, 'success');
      } else {
        this.showToast(data.error || (isEn ? 'Error changing name' : 'નામ બદલવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  openAdminBackupModal() {
    const backupOtp = document.getElementById('admin-backup-otp');
    if (backupOtp) backupOtp.value = '';
    this.openModal('modal-admin-backup-restore');
  },

  openAdminChangePinModal() {
    const pOld = document.getElementById('admin-pin-old');
    const pNew = document.getElementById('admin-pin-new');
    const pOtp = document.getElementById('admin-pin-otp');
    if (pOld) pOld.value = '';
    if (pNew) pNew.value = '';
    if (pOtp) pOtp.value = '';
    this.openModal('modal-admin-change-pin');
    setTimeout(() => pOld?.focus(), 150);
  },

  openAdminEmailSecurityModal() {
    const currentEmail = this.settings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';
    const emailDisplay = document.getElementById('admin-current-email-display');
    if (emailDisplay) emailDisplay.innerText = currentEmail;

    const alertEmailInp = document.getElementById('admin-setting-alert-email');
    if (alertEmailInp) alertEmailInp.value = '';

    const emailOtp = document.getElementById('admin-email-otp');
    if (emailOtp) emailOtp.value = '';

    this.openModal('modal-admin-email-security');
    setTimeout(() => alertEmailInp?.focus(), 150);
  },

  async requestActionOtp(actionType, btnId) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const btn = document.getElementById(btnId);
    const origHtml = btn ? btn.innerHTML : '';

    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>⏳</span> <span>${isEn ? 'Sending...' : 'મોકલાઈ રહ્યું છે...'}</span>`;
      }

      const res = await fetch('/api/admin/action-otp/request', {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ actionType })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;

      if (res.ok && data.success) {
        this.showToast(data.message || (isEn ? 'OTP sent to your registered email!' : 'OTP તમારા રજિસ્ટર્ડ ઈમેલ પર મોકલાઈ ગયો છે!'), 'success');

        // Cooldown timer 60s
        let countdown = 60;
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = `<span>⏳</span> <span>${countdown}s</span>`;
          const timer = setInterval(() => {
            countdown--;
            if (countdown <= 0) {
              clearInterval(timer);
              btn.disabled = false;
              btn.innerHTML = origHtml;
            } else {
              btn.innerHTML = `<span>⏳</span> <span>${countdown}s</span>`;
            }
          }, 1000);
        }
      } else {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = origHtml;
        }
        this.showToast(data.error || (isEn ? 'Failed to send OTP' : 'OTP મોકલવામાં નિષ્ફળતા'), 'error');
      }
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
      this.showToast(isEn ? 'Server connection error' : 'સર્વર કનેક્શન એરર', 'error');
    }
  },

  async saveAdminEmailSettings() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const alertEmailInp = document.getElementById('admin-setting-alert-email');
    const newEmail = (alertEmailInp ? alertEmailInp.value : '').trim();
    const otp = (document.getElementById('admin-email-otp')?.value || '').trim();

    if (!newEmail || !newEmail.includes('@') || !newEmail.includes('.')) {
      this.showToast(isEn ? 'Please enter a valid new email address' : 'કૃપા કરીને માન્ય નવું ઈમેલ એડ્રેસ લખો', 'error');
      return;
    }

    const currentEmail = (this.settings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com').trim().toLowerCase();
    if (newEmail.toLowerCase() === currentEmail) {
      this.showToast(isEn ? 'This email is already registered' : 'આ ઈમેલ પહેલેથી જ રજિસ્ટર્ડ છે.', 'info');
      return;
    }

    if (!otp) {
      this.showToast(isEn ? 'Please enter the 6-digit OTP sent to your email' : 'કૃપા કરીને હાલના ઈમેલ પર મોકલેલો ૬-અંકનો OTP દાખલ કરો!', 'error');
      return;
    }

    try {
      const res = await fetch('/api/admin/change-alert-email', {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ newEmail, otp })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;

      if (res.ok && data.success) {
        this.settings.adminAlertEmail = newEmail;
        const emailDisplay = document.getElementById('admin-current-email-display');
        if (emailDisplay) emailDisplay.innerText = newEmail;
        if (alertEmailInp) alertEmailInp.value = '';
        if (document.getElementById('admin-email-otp')) document.getElementById('admin-email-otp').value = '';
        this.closeModal('modal-admin-email-security');
        this.showToast(isEn ? '📧 Admin email updated successfully!' : '📧 એડમિન સિક્યુરિટી ઈમેલ સફળતાપૂર્વક બદલાઈ ગયું!', 'success');
      } else {
        this.showToast(data.error || (isEn ? 'Error updating email' : 'ઈમેલ બદલવામાં ભૂલ આવી'), 'error');
      }
    } catch (e) {
      this.showToast(isEn ? 'Error updating email settings' : 'ઈમેલ સેટિંગ્સ સાચવવામાં ભૂલ આવી', 'error');
    }
  },

  async adminChangePin() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const oldPin = (document.getElementById('admin-pin-old')?.value || '').trim();
    const newPin = (document.getElementById('admin-pin-new')?.value || '').trim();
    const otp = (document.getElementById('admin-pin-otp')?.value || '').trim();

    if (!oldPin) {
      this.showToast(isEn ? 'Enter current PIN' : 'હાલનો પિન લખો', 'error');
      return;
    }
    if (!newPin || newPin.length < 4) {
      this.showToast(isEn ? 'New PIN must be at least 4 digits' : 'નવો પિન ઓછામાં ઓછો 4 અંકનો લખો', 'error');
      return;
    }
    if (!otp) {
      this.showToast(isEn ? 'Please get and enter the OTP sent to your registered email' : 'કૃપા કરીને રજિસ્ટર્ડ ઈમેલ પર OTP મેળવો અને દાખલ કરો!', 'error');
      return;
    }

    try {
      const res = await fetch('/api/admin/change-pin', {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ oldPin, newPin, otp })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;

      if (res.ok && data.success) {
        if (document.getElementById('admin-pin-old')) document.getElementById('admin-pin-old').value = '';
        if (document.getElementById('admin-pin-new')) document.getElementById('admin-pin-new').value = '';
        if (document.getElementById('admin-pin-otp')) document.getElementById('admin-pin-otp').value = '';
        this.closeModal('modal-admin-change-pin');
        this.showToast(isEn ? '🔐 Admin PIN changed successfully!' : '🔐 એડમિન સિક્યુરિટી પિન સફળતાપૂર્વક બદલાઈ ગયો!', 'success');
      } else {
        this.showToast(data.error || (isEn ? 'Error changing PIN' : 'પિન બદલવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      this.showToast(isEn ? 'Server error' : 'સર્વર એરર', 'error');
    }
  },

  adminDownloadBackup() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const otp = (document.getElementById('admin-backup-otp')?.value || '').trim();
    if (!otp) {
      this.showToast(isEn ? 'Please get and enter the OTP first to download backup' : 'બેકઅપ ડાઉનલોડ કરવા માટે પહેલા OTP મેળવો અને લખો!', 'error');
      return;
    }
    const tokenQuery = this.adminToken ? `&token=${encodeURIComponent(this.adminToken)}` : '';
    window.location.href = `/api/admin/backup?otp=${encodeURIComponent(otp)}${tokenQuery}`;
  },

  async adminHandleRestore(e) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const otp = (document.getElementById('admin-backup-otp')?.value || '').trim();
    if (!otp) {
      this.showToast(isEn ? 'Please get and enter the OTP first to restore data' : 'ડેટા રિસ્ટોર કરવા માટે પહેલા OTP મેળવો અને લખો!', 'error');
      e.target.value = '';
      return;
    }

    if (!confirm(isEn ? '⚠️ Warning: Are you sure you want to restore all accounts from this backup file? This will overwrite existing data.' : '⚠️ સાવધાન: શું તમે ખરેખર આ બેકઅપ ફાઇલમાંથી તમામ હિસાબ રિસ્ટોર કરવા માંગો છો? આનાથી હાલનો ડેટા ઓવરરાઈટ થશે.')) {
      e.target.value = '';
      return;
    }

    try {
      const text = await file.text();
      const backupJson = JSON.parse(text);

      const res = await fetch('/api/admin/restore', {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ backupData: backupJson, otp })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;

      if (res.ok && data.success) {
        this.showToast(isEn ? `✅ ${data.message} (${data.recordCount} days restored)` : `✅ ${data.message} (${data.recordCount} દિવસો રિસ્ટોર થયા)`, 'success');
        setTimeout(() => {
          window.location.reload();
        }, 1200);
      } else {
        this.showToast(data.error || (isEn ? 'Restore failed' : 'રિસ્ટોર કરવામાં નિષ્ફળતા'), 'error');
      }
    } catch (err) {
      console.error('Restore error:', err);
      this.showToast((isEn ? 'Invalid backup file: ' : 'અમાન્ય બેકઅપ ફાઇલ: ') + err.message, 'error');
    } finally {
      e.target.value = '';
    }
  },

  adminHistoryData: [],
  adminHistoryActiveCategory: 'ALL',

  async loadAdminHistory() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const tbody = document.getElementById('admin-history-table-body');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 30px; color: #64748b;"><span>⏳</span> ${isEn ? 'Loading history...' : 'હિસ્ટ્રી લોડ થઈ રહી છે...'}</td></tr>`;
    }

    try {
      const res = await fetch('/api/admin/history', {
        headers: this.getAdminAuthHeaders()
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;

      if (res.ok && data.success) {
        this.adminHistoryData = data.history || [];
        this.updateAdminHistoryKpis();
        this.filterAdminHistory();
      } else {
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 25px; color: #b91c1c;">${data.error || (isEn ? 'Failed to load history' : 'હિસ્ટ્રી લોડ કરવામાં નિષ્ફળતા')}</td></tr>`;
      }
    } catch (err) {
      console.error('Error loading history:', err);
      if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 25px; color: #b91c1c;">${isEn ? 'Server connection error' : 'સર્વર કનેક્શન એરર'}</td></tr>`;
    }
  },

  updateAdminHistoryKpis() {
    const list = this.adminHistoryData || [];
    const totalEl = document.getElementById('admin-hist-stat-total');
    const secEl = document.getElementById('admin-hist-stat-security');
    const bakEl = document.getElementById('admin-hist-stat-backup');
    const setEl = document.getElementById('admin-hist-stat-settings');

    if (totalEl) totalEl.innerText = list.length;
    if (secEl) secEl.innerText = list.filter(i => i.category === 'SECURITY').length;
    if (bakEl) bakEl.innerText = list.filter(i => i.category === 'BACKUP').length;
    if (setEl) setEl.innerText = list.filter(i => i.category === 'SETTINGS' || i.category === 'HISAB' || i.category === 'STAFF').length;
  },

  setAdminHistoryCategory(cat, btn) {
    this.adminHistoryActiveCategory = cat;
    const pills = document.querySelectorAll('#admin-history-category-pills button');
    pills.forEach(p => {
      p.style.background = '#f1f5f9';
      p.style.color = '#334155';
      p.style.border = '1px solid #cbd5e1';
      p.classList.remove('active');
    });
    if (btn) {
      btn.style.background = '#6366f1';
      btn.style.color = '#ffffff';
      btn.style.border = 'none';
      btn.classList.add('active');
    }
    this.filterAdminHistory();
  },

  filterAdminHistory() {
    const searchInp = document.getElementById('admin-history-search');
    const q = (searchInp?.value || '').trim().toLowerCase();
    const cat = this.adminHistoryActiveCategory || 'ALL';

    let filtered = this.adminHistoryData || [];
    if (cat !== 'ALL') {
      filtered = filtered.filter(item => item.category === cat);
    }
    if (q) {
      filtered = filtered.filter(item =>
        (item.title && item.title.toLowerCase().includes(q)) ||
        (item.titleEn && item.titleEn.toLowerCase().includes(q)) ||
        (item.details && item.details.toLowerCase().includes(q)) ||
        (item.detailsEn && item.detailsEn.toLowerCase().includes(q)) ||
        (item.dateStr && item.dateStr.includes(q)) ||
        (item.timeStr && item.timeStr.toLowerCase().includes(q))
      );
    }
    this.renderAdminHistoryTable(filtered);
  },

  renderAdminHistoryTable(items) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const tbody = document.getElementById('admin-history-table-body');
    if (!tbody) return;

    if (!items || items.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 40px 20px; color: #64748b;">
            <div style="font-size: 2rem; margin-bottom: 8px;">📭</div>
            <div style="font-weight: 700; font-size: 0.95rem;">${isEn ? 'No activity history found.' : 'કોઈ પ્રવૃત્તિ હિસ્ટ્રી નોંધાયેલી નથી.'}</div>
          </td>
        </tr>
      `;
      return;
    }

    const catBadgeMap = {
      'SECURITY': { bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe', label: isEn ? '🔐 Security' : '🔐 સુરક્ષા' },
      'BACKUP': { bg: '#ecfdf5', color: '#047857', border: '#a7f3d0', label: isEn ? '💾 Backup' : '💾 બેકઅપ' },
      'SETTINGS': { bg: '#fffbeb', color: '#b45309', border: '#fde68a', label: isEn ? '⚙️ Settings' : '⚙️ સેટિંગ્સ' },
      'HISAB': { bg: '#fdf2f8', color: '#be185d', border: '#fbcfe8', label: isEn ? '📝 Hisab' : '📝 હિસાબ' },
      'STAFF': { bg: '#f5f3ff', color: '#6d28d9', border: '#ddd6fe', label: isEn ? '👥 Staff' : '👥 સ્ટાફ' }
    };

    const statusBadgeMap = {
      'success': (id) => `<button type="button" onclick="event.stopPropagation(); App.showAdminHistoryDetails('${id}')" style="background: #dcfce7; color: #15803d; border: 1.5px solid #86efac; padding: 3px 9px; border-radius: 6px; font-weight: 800; font-size: 0.75rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="ક્લિક કરી વિગત જુઓ">${isEn ? '✅ Success' : '✅ સફળ'} 🔍</button>`,
      'warning': (id) => `<button type="button" onclick="event.stopPropagation(); App.showAdminHistoryDetails('${id}')" style="background: #fef3c7; color: #b45309; border: 1.5px solid #fde68a; padding: 3px 9px; border-radius: 6px; font-weight: 800; font-size: 0.75rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="ક્લિક કરી વિગત જુઓ">${isEn ? '⚠️ Warning' : '⚠️ ચેતવણી'} 🔍</button>`,
      'danger': (id) => `<button type="button" onclick="event.stopPropagation(); App.showAdminHistoryDetails('${id}')" style="background: #fee2e2; color: #b91c1c; border: 1.5px solid #fca5a5; padding: 3px 9px; border-radius: 6px; font-weight: 800; font-size: 0.75rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="ક્લિક કરી વિગત જુઓ">${isEn ? '❌ Failed' : '❌ અસફળ'} 🔍</button>`,
      'info': (id) => `<button type="button" onclick="event.stopPropagation(); App.showAdminHistoryDetails('${id}')" style="background: #e0e7ff; color: #3730a3; border: 1.5px solid #818cf8; padding: 3px 9px; border-radius: 6px; font-weight: 800; font-size: 0.75rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 3px rgba(99,102,241,0.2);" title="ફેરફારો જોવા ક્લિક કરો">${isEn ? 'ℹ️ Info' : 'ℹ️ માહિતી'} 🔍</button>`
    };

    let html = '';
    items.forEach((item, idx) => {
      const catInfo = catBadgeMap[item.category] || { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1', label: item.category };
      const statusFunc = statusBadgeMap[item.status] || statusBadgeMap['info'];
      const statusHtml = typeof statusFunc === 'function' ? statusFunc(item.id) : statusFunc;
      const title = isEn ? (item.titleEn || item.title) : item.title;
      const details = isEn ? (item.detailsEn || item.details) : item.details;
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#fafafa';

      html += `
        <tr onclick="App.showAdminHistoryDetails('${item.id}')" style="background: ${rowBg}; border-bottom: 1px solid #e2e8f0; cursor: pointer; transition: background 0.15s;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='${rowBg}'" title="ક્લિક કરી સંપૂર્ણ ફેરફાર જુઓ">
          <td style="padding: 10px 14px; white-space: nowrap;">
            <div style="font-weight: 700; color: #1e293b; font-size: 0.85rem;">${item.dateStr || ''}</div>
            <div style="font-size: 0.76rem; color: #64748b;">${item.timeStr || ''}</div>
          </td>
          <td style="padding: 10px 14px; white-space: nowrap;">
            <span style="background: ${catInfo.bg}; color: ${catInfo.color}; border: 1px solid ${catInfo.border}; padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 0.76rem; display: inline-block;">
              ${catInfo.label}
            </span>
          </td>
          <td style="padding: 10px 14px;">
            <div style="font-weight: 800; color: #1e293b; font-size: 0.9rem;">${title}</div>
            <div style="font-size: 0.74rem; color: #94a3b8; font-family: monospace;">IP: ${item.ip || 'Local'}</div>
          </td>
          <td style="padding: 10px 14px; color: #334155; line-height: 1.4; font-size: 0.85rem;">
            ${details}
          </td>
          <td style="padding: 10px 14px; text-align: center; white-space: nowrap;">
            ${statusHtml}
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
  },

  showAdminHistoryDetails(id) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const item = (this.adminHistoryData || []).find(h => h.id === id);
    if (!item) return;

    const modalBody = document.getElementById('admin-history-details-content');
    if (!modalBody) return;

    const title = isEn ? (item.titleEn || item.title) : item.title;
    const details = isEn ? (item.detailsEn || item.details) : item.details;

    const catBadgeMap = {
      'SECURITY': { bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe', label: isEn ? '🔐 Security' : '🔐 સુરક્ષા' },
      'BACKUP': { bg: '#ecfdf5', color: '#047857', border: '#a7f3d0', label: isEn ? '💾 Backup' : '💾 બેકઅપ' },
      'SETTINGS': { bg: '#fffbeb', color: '#b45309', border: '#fde68a', label: isEn ? '⚙️ Settings' : '⚙️ સેટિંગ્સ' },
      'HISAB': { bg: '#fdf2f8', color: '#be185d', border: '#fbcfe8', label: isEn ? '📝 Hisab' : '📝 હિસાબ' },
      'STAFF': { bg: '#f5f3ff', color: '#6d28d9', border: '#ddd6fe', label: isEn ? '👥 Staff' : '👥 સ્ટાફ' }
    };

    const statusBadgeMap = {
      'success': `<span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; padding: 3px 10px; border-radius: 6px; font-weight: 800; font-size: 0.8rem;">${isEn ? '✅ Success' : '✅ સફળ'}</span>`,
      'warning': `<span style="background: #fef3c7; color: #b45309; border: 1px solid #fde68a; padding: 3px 10px; border-radius: 6px; font-weight: 800; font-size: 0.8rem;">${isEn ? '⚠️ Warning' : '⚠️ ચેતવણી'}</span>`,
      'danger': `<span style="background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; padding: 3px 10px; border-radius: 6px; font-weight: 800; font-size: 0.8rem;">${isEn ? '❌ Failed' : '❌ અસફળ'}</span>`,
      'info': `<span style="background: #e0e7ff; color: #3730a3; border: 1px solid #c7d2fe; padding: 3px 10px; border-radius: 6px; font-weight: 800; font-size: 0.8rem;">${isEn ? 'ℹ️ Info' : 'ℹ️ માહિતી'}</span>`
    };

    const catInfo = catBadgeMap[item.category] || { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1', label: item.category };
    const statusHtml = statusBadgeMap[item.status] || statusBadgeMap['info'];

    // Render Changes Diff Table if meta.changes exists
    let changesHtml = '';
    const changes = (item.meta && Array.isArray(item.meta.changes)) ? item.meta.changes : [];

    if (changes.length > 0) {
      let rows = '';
      changes.forEach(c => {
        rows += `
          <tr style="border-bottom: 1px solid #e2e8f0;">
            <td style="padding: 10px 14px; font-weight: 700; color: #1e293b; width: 34%;">
              ${c.field || 'ફીલ્ડ'}
            </td>
            <td style="padding: 10px 14px; width: 33%; background: #fff1f2; color: #9f1239; font-family: monospace; font-size: 0.88rem; word-break: break-all;">
              <span style="display: inline-block; padding: 2px 7px; background: #ffe4e6; border-radius: 4px; border: 1px solid #fecdd3;">🔴 ${c.before !== undefined ? c.before : '-'}</span>
            </td>
            <td style="padding: 10px 14px; width: 33%; background: #f0fdf4; color: #166534; font-family: monospace; font-size: 0.88rem; word-break: break-all;">
              <span style="display: inline-block; padding: 2px 7px; background: #dcfce7; border-radius: 4px; border: 1px solid #bbf7d0;">🟢 ${c.after !== undefined ? c.after : '-'}</span>
            </td>
          </tr>
        `;
      });

      changesHtml = `
        <div style="margin-top: 20px;">
          <h4 style="margin: 0 0 10px 0; color: #1e293b; font-size: 0.95rem; font-weight: 800; display: flex; align-items: center; gap: 8px;">
            <span>🔄</span> ${isEn ? 'Exact Changes & Value Diff' : 'કરેલા ચોક્કસ ફેરફારો (Before ➔ After)'}
          </h4>
          <div style="border: 1.5px solid #cbd5e1; border-radius: 10px; overflow: hidden;">
            <table style="width: 100%; border-collapse: collapse; font-size: 0.88rem;">
              <thead>
                <tr style="background: #f8fafc; border-bottom: 2px solid #cbd5e1; text-align: left;">
                  <th style="padding: 9px 14px; font-weight: 800; color: #475569;">${isEn ? 'Parameter / Field' : 'વિગત / ફીલ્ડ'}</th>
                  <th style="padding: 9px 14px; font-weight: 800; color: #9f1239; background: #fff1f2;">${isEn ? '🔴 Before' : '🔴 પહેલા (Before)'}</th>
                  <th style="padding: 9px 14px; font-weight: 800; color: #166534; background: #f0fdf4;">${isEn ? '🟢 After' : '🟢 પછી (After)'}</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>
        </div>
      `;
    } else {
      changesHtml = `
        <div style="margin-top: 18px; padding: 14px 16px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; color: #64748b; font-size: 0.88rem; display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.4rem;">ℹ️</span>
          <div>
            <div style="font-weight: 700; color: #334155;">${isEn ? 'System Operation Audit' : 'સિસ્ટમ ઓપરેશન નોંધ'}</div>
            <div style="font-size: 0.82rem; margin-top: 2px;">
              ${isEn 
                ? 'This action is a system/security event (login, logout, backup, or OTP verification). No fields were directly overwritten.' 
                : 'આ પ્રવૃત્તિ સિસ્ટમ કે સુરક્ષા ઇવેન્ટ છે (દા.ત. લૉગિન, લૉગઆઉટ, બેકઅપ અથવા OTP ચકાસણી). કોઈ ડેટા ફીલ્ડ સીધું ઓવરરાઇટ થયું નથી.'}
            </div>
          </div>
        </div>
      `;
    }

    modalBody.innerHTML = `
      <!-- Top Overview Cards -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 16px;">
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px;">
          <div style="font-size: 0.72rem; color: #64748b; font-weight: 700;">${isEn ? 'Date & Time' : 'તારીખ & સમય'}</div>
          <div style="font-weight: 800; color: #1e293b; font-size: 0.85rem; margin-top: 2px;">${item.dateStr} | ${item.timeStr}</div>
        </div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px;">
          <div style="font-size: 0.72rem; color: #64748b; font-weight: 700;">${isEn ? 'Category' : 'કેટેગરી'}</div>
          <div style="margin-top: 2px;">
            <span style="background: ${catInfo.bg}; color: ${catInfo.color}; border: 1px solid ${catInfo.border}; padding: 2px 7px; border-radius: 5px; font-weight: 700; font-size: 0.75rem;">
              ${catInfo.label}
            </span>
          </div>
        </div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px;">
          <div style="font-size: 0.72rem; color: #64748b; font-weight: 700;">${isEn ? 'Status' : 'સ્થિતિ'}</div>
          <div style="margin-top: 2px;">${statusHtml}</div>
        </div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px;">
          <div style="font-size: 0.72rem; color: #64748b; font-weight: 700;">IP Address</div>
          <div style="font-family: monospace; font-size: 0.82rem; color: #334155; margin-top: 2px; font-weight: 700;">${item.ip || 'Local'}</div>
        </div>
      </div>

      <!-- Action & Details Card -->
      <div style="background: linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%); border: 1.5px solid #c7d2fe; border-radius: 10px; padding: 14px 18px; margin-bottom: 14px;">
        <div style="font-size: 0.75rem; color: #4338ca; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;">${item.action || 'ACTION'}</div>
        <div style="font-size: 1.1rem; font-weight: 900; color: #1e1b4b; margin: 4px 0 6px 0;">${title}</div>
        <div style="font-size: 0.9rem; color: #334155; line-height: 1.5;">${details}</div>
      </div>

      <!-- Diff / Changes Section -->
      ${changesHtml}
    `;

    this.openModal('modal-admin-history-details');
  },

  exportAdminHistory() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const tokenQuery = this.adminToken ? `?token=${encodeURIComponent(this.adminToken)}` : '';
    window.location.href = `/api/admin/history/export${tokenQuery}`;
    this.showToast(isEn ? 'Downloading history log...' : 'હિસ્ટ્રી લોગ ડાઉનલોડ થઈ રહ્યો છે...', 'info');
  },

  onAdminHistorySearchInput() {
    const input = document.getElementById('admin-history-search');
    const clearBtn = document.getElementById('admin-history-search-clear-btn');
    if (clearBtn) {
      clearBtn.style.display = (input && input.value.trim()) ? 'flex' : 'none';
    }
    this.filterAdminHistory();
  },

  clearAdminHistorySearch() {
    const input = document.getElementById('admin-history-search');
    const clearBtn = document.getElementById('admin-history-search-clear-btn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    this.filterAdminHistory();
  },

  openAdminHistoryClearModal() {
    this.selectClearOption('30days');
    this.openModal('modal-admin-history-clear');
  },

  selectClearOption(mode) {
    const r30 = document.getElementById('clear-mode-30days');
    const r7 = document.getElementById('clear-mode-7days');
    const rAll = document.getElementById('clear-mode-all');
    const l30 = document.getElementById('clear-opt-label-30days');
    const l7 = document.getElementById('clear-opt-label-7days');
    const lAll = document.getElementById('clear-opt-label-all');

    if (r30) r30.checked = (mode === '30days');
    if (r7) r7.checked = (mode === '7days');
    if (rAll) rAll.checked = (mode === 'all');

    if (l30) l30.style.border = (mode === '30days') ? '2px solid #6366f1' : '1.5px solid #cbd5e1';
    if (l7) l7.style.border = (mode === '7days') ? '2px solid #6366f1' : '1.5px solid #cbd5e1';
    if (lAll) lAll.style.border = (mode === 'all') ? '2px solid #dc2626' : '1.5px solid #fecdd3';
  },

  async confirmExecuteAdminHistoryClear() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const checked = document.querySelector('input[name="admin-clear-mode"]:checked');
    const mode = checked ? checked.value : '30days';
    const btn = document.getElementById('btn-admin-confirm-clear');

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span>⏳</span> <span>${isEn ? 'Clearing...' : 'સાફ થઈ રહ્યું છે...'}</span>`;
    }

    try {
      const res = await fetch('/api/admin/history/clear', {
        method: 'POST',
        headers: this.getAdminAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mode })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) {
        this.closeModal('modal-admin-history-clear');
        return;
      }

      if (res.ok && data.success) {
        this.closeModal('modal-admin-history-clear');
        this.showToast(data.message || (isEn ? 'History cleared successfully' : 'હિસ્ટ્રી સફળતાપૂર્વક સાફ થઈ ગઈ'), 'success');
        await this.loadAdminHistory();
      } else {
        this.showToast(data.error || (isEn ? 'Failed to clear history' : 'હિસ્ટ્રી સાફ કરવામાં ભૂલ'), 'error');
      }
    } catch (err) {
      console.error('Error clearing admin history:', err);
      this.showToast(isEn ? 'Server connection error' : 'સર્વર કનેક્શન એરર', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<span>🗑️</span> <span>${isEn ? 'Confirm Clear' : 'સાફ કરો (Confirm Clear)'}</span>`;
      }
    }
  },

  async clearAdminHistory() {
    this.openAdminHistoryClearModal();
  },

  // =========================================================================
  // USER MANAGEMENT & LOGIN LOGS (RBAC)
  // =========================================================================
  usersList: [],
  loginHistoryList: [],

  initUserRoleUI() {
    try {
      const rawUser = localStorage.getItem('hisab_user_info');
      if (rawUser) {
        const u = JSON.parse(rawUser);

        // Show admin button ONLY for admin role; hide for staff/accountant
        const adminMenuBtn = document.getElementById('btn-admin-panel-menu');
        if (adminMenuBtn) {
          if (u.role === 'admin') {
            adminMenuBtn.style.display = 'flex';
            adminMenuBtn.onclick = () => {
              window.location.href = '/admin';
            };
          } else {
            adminMenuBtn.style.display = 'none';
          }
        }
      }
    } catch (e) {
      console.error('Error initializing user role UI:', e);
    }
  },

  logoutUser() {
    if (confirm('શું તમે ખરેખર લૉગઆઉટ કરવા માંગો છો?')) {
      const token = localStorage.getItem('hisab_auth_token') || sessionStorage.getItem('hisab_auth_token');
      if (token) {
        fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
        }).catch(() => {});
      }
      localStorage.removeItem('hisab_auth_token');
      sessionStorage.removeItem('hisab_auth_token');
      localStorage.removeItem('hisab_user_info');
      window.location.replace('/login.html');
    }
  },

  toggleAddUserForm(show) {
    const card = document.getElementById('admin-user-form-card');
    if (!card) return;
    if (show) {
      card.style.display = 'block';
      const idInput = document.getElementById('user-form-id');
      if (idInput && !idInput.value) {
        document.getElementById('user-form-title').textContent = '➕ નવો વપરાશકર્તા ઉમેરો';
        document.getElementById('user-form-username').disabled = false;
        document.getElementById('user-form-password').required = true;
        document.getElementById('user-form-password').placeholder = 'પાસવર્ડ દાખલ કરો';
      }
      const nameInput = document.getElementById('user-form-name');
      if (nameInput) nameInput.focus();
    } else {
      card.style.display = 'none';
      document.getElementById('user-form-id').value = '';
      document.getElementById('user-form-name').value = '';
      document.getElementById('user-form-username').value = '';
      document.getElementById('user-form-password').value = '';
      document.getElementById('user-form-phone').value = '';
      document.getElementById('user-form-role').value = 'user';
      document.getElementById('user-form-status').value = 'active';
    }
  },

  async loadUsersList() {
    const tbody = document.getElementById('admin-users-table-body');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px; color: #64748b;">⏳ યુઝર્સ લોડ થઈ રહ્યા છે...</td></tr>';
    }
    try {
      const res = await fetch('/api/users');
      const data = await res.json();
      if (res.ok && data.success) {
        this.usersList = data.users || [];
        this.renderUsersList(this.usersList);
      } else {
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 20px; color:#ef4444;">${data.error || 'યુઝર્સ લોડ કરવામાં ભૂલ થઈ.'}</td></tr>`;
      }
    } catch (err) {
      console.error('Error loading users:', err);
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px; color:#ef4444;">સર્વર કનેક્શન એરર</td></tr>';
    }
  },

  renderUsersList(users) {
    const tbody = document.getElementById('admin-users-table-body');
    const badge = document.getElementById('admin-users-count-badge');
    if (badge) badge.textContent = `કુલ: ${users.length}`;
    if (!tbody) return;

    if (!users || users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 30px; color: #94a3b8;">કોઈ યુઝર મળ્યા નથી. "નવો યુઝર ઉમેરો" પર ક્લિક કરો.</td></tr>';
      return;
    }

    tbody.innerHTML = users.map((u, idx) => {
      const roleBadge = (u.role === 'accountant')
        ? '<span style="background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 6px; font-weight: 800; font-size: 0.78rem;">💼 એકાઉન્ટન્ટ</span>'
        : '<span style="background: #e0e7ff; color: #3730a3; padding: 2px 8px; border-radius: 6px; font-weight: 800; font-size: 0.78rem;">👤 કાઉન્ટર સ્ટાફ</span>';
      
      const statusBadge = (u.status === 'inactive')
        ? '<span style="background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 6px; font-weight: 700; font-size: 0.76rem;">🔴 નિષ્ક્રિય</span>'
        : '<span style="background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 6px; font-weight: 700; font-size: 0.76rem;">🟢 સક્રિય</span>';

      let lastLoginText = '-';
      if (u.lastLogin) {
        try {
          const d = new Date(u.lastLogin);
          lastLoginText = d.toLocaleDateString('gu-IN') + ' ' + d.toLocaleTimeString('gu-IN', { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
          lastLoginText = u.lastLogin;
        }
      }

      return `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px 14px; color: #64748b; font-weight: 700;">${idx + 1}</td>
          <td style="padding: 10px 14px; font-weight: 800; color: #0f172a;">${this.escapeHtml(u.name)}</td>
          <td style="padding: 10px 14px; font-family: monospace; font-weight: 700; color: #2563eb;">${this.escapeHtml(u.username)}</td>
          <td style="padding: 10px 14px;">${roleBadge}</td>
          <td style="padding: 10px 14px; color: #475569;">
            ${this.escapeHtml(u.phone || '-')}
            ${u.email ? `<div style="font-size: 0.74rem; color: #2563eb; margin-top: 2px;">✉️ ${this.escapeHtml(u.email)}</div>` : ''}
          </td>
          <td style="padding: 10px 14px; font-size: 0.8rem; color: #64748b;">${lastLoginText}</td>
          <td style="padding: 10px 14px; text-align: center;">${statusBadge}</td>
          <td style="padding: 10px 14px; text-align: center;">
            <div style="display: flex; gap: 6px; justify-content: center;">
              <button type="button" class="btn-icon" onclick="App.editUser('${u.id}')"
                style="padding: 4px 8px; font-size: 0.78rem; font-weight: 700; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px;"
                title="સુધારો અથવા પાસવર્ડ બદલો">✏️ સુધારો</button>
              <button type="button" class="btn-icon" onclick="App.deleteUser('${u.id}')"
                style="padding: 4px 8px; font-size: 0.78rem; font-weight: 700; background: #fff1f2; color: #be123c; border: 1px solid #fecdd3; border-radius: 6px;"
                title="યુઝર ડિલીટ કરો">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  editUser(userId) {
    const u = (this.usersList || []).find(item => item.id === userId);
    if (!u) return;

    this.toggleAddUserForm(true);
    document.getElementById('user-form-id').value = u.id;
    document.getElementById('user-form-name').value = u.name || '';
    document.getElementById('user-form-username').value = u.username || '';
    document.getElementById('user-form-username').disabled = true; // Username immutable once created
    document.getElementById('user-form-password').value = '';
    document.getElementById('user-form-password').required = false;
    document.getElementById('user-form-password').placeholder = 'પાસવર્ડ બદલવો હોય તો જ લખો';
    document.getElementById('user-form-role').value = u.role || 'user';
    document.getElementById('user-form-phone').value = u.phone || '';
    const emailInp = document.getElementById('user-form-email');
    if (emailInp) emailInp.value = u.email || '';
    document.getElementById('user-form-status').value = u.status || 'active';
    document.getElementById('user-form-title').innerHTML = `✏️ <strong>${u.name}</strong> ની વિગતો સુધારો`;

    const card = document.getElementById('admin-user-form-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  async deleteUser(userId) {
    const u = (this.usersList || []).find(item => item.id === userId);
    if (!u) return;
    if (!confirm(`શું તમે ખરેખર યુઝર "${u.name} (${u.username})" ને ડિલીટ કરવા માંગો છો?`)) return;

    try {
      const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast(data.message || 'યુઝર ડિલીટ કર્યો!', 'success');
        await this.loadUsersList();
      } else {
        this.showToast(data.error || 'યુઝર ડિલીટ કરવામાં નિષ્ફળતા!', 'error');
      }
    } catch (err) {
      console.error('Error deleting user:', err);
      this.showToast('સર્વર કનેક્શન એરર', 'error');
    }
  },

  async submitUserForm(e) {
    if (e) e.preventDefault();

    const id = document.getElementById('user-form-id').value.trim();
    const name = document.getElementById('user-form-name').value.trim();
    const username = document.getElementById('user-form-username').value.trim();
    const password = document.getElementById('user-form-password').value.trim();
    const role = document.getElementById('user-form-role').value;
    const phone = document.getElementById('user-form-phone').value.trim();
    const email = (document.getElementById('user-form-email')?.value || '').trim();
    const status = document.getElementById('user-form-status').value;

    if (!name) {
      this.showToast('કૃપા કરીને પૂરું નામ લખો!', 'error');
      return;
    }

    try {
      let res, data;
      if (id) {
        // Edit existing user
        res = await fetch(`/api/users/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, password, role, phone, email, status })
        });
        data = await res.json();
      } else {
        // Add new user
        if (!username || !password) {
          this.showToast('યુઝરનેમ અને પાસવર્ડ ફરજિયાત છે!', 'error');
          return;
        }
        res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, username, password, role, phone, email })
        });
        data = await res.json();
      }

      if (res.ok && data.success) {
        this.showToast(data.message || 'યુઝર વિગતો સાચવી!', 'success');
        this.toggleAddUserForm(false);
        await this.loadUsersList();
      } else {
        this.showToast(data.error || 'સાચવવામાં નિષ્ફળતા!', 'error');
      }
    } catch (err) {
      console.error('Error saving user:', err);
      this.showToast('સર્વર કનેક્શન એરર', 'error');
    }
  },

  async loadLoginHistory() {
    const tbody = document.getElementById('admin-login-history-table-body');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: #64748b;">⏳ લૉગ્સ લોડ થઈ રહ્યા છે...</td></tr>';
    }
    try {
      const res = await fetch('/api/login-history');
      const data = await res.json();
      if (res.ok && data.success) {
        this.loginHistoryList = data.history || [];
        this.renderLoginHistory(this.loginHistoryList);
      } else {
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px; color:#ef4444;">લૉગ્સ લોડ કરવામાં ભૂલ થઈ.</td></tr>';
      }
    } catch (err) {
      console.error('Error loading login history:', err);
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px; color:#ef4444;">સર્વર કનેક્શન એરર</td></tr>';
    }
  },

  renderLoginHistory(list) {
    const tbody = document.getElementById('admin-login-history-table-body');
    if (!tbody) return;

    if (!list || list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 25px; color: #94a3b8;">કોઈ લૉગિન ઇતિહાસ ઉપલબ્ધ નથી.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(item => {
      let dtStr = '-';
      try {
        const d = new Date(item.timestamp);
        dtStr = d.toLocaleDateString('gu-IN') + ' ' + d.toLocaleTimeString('gu-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch (e) {
        dtStr = item.timestamp;
      }

      const statusBadge = (item.status === 'success')
        ? '<span style="background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 6px; font-weight: 800; font-size: 0.76rem;">🟢 સફળ</span>'
        : '<span style="background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 6px; font-weight: 800; font-size: 0.76rem;">🔴 નિષ્ફળ</span>';

      const roleBadge = (item.role === 'accountant')
        ? '<span style="background: #fef3c7; color: #92400e; padding: 1px 6px; border-radius: 4px; font-weight: 700; font-size: 0.74rem;">એકાઉન્ટન્ટ</span>'
        : (item.role === 'admin')
        ? '<span style="background: #fee2e2; color: #991b1b; padding: 1px 6px; border-radius: 4px; font-weight: 700; font-size: 0.74rem;">એડમિન</span>'
        : '<span style="background: #e0e7ff; color: #3730a3; padding: 1px 6px; border-radius: 4px; font-weight: 700; font-size: 0.74rem;">કાઉન્ટર સ્ટાફ</span>';

      return `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 9px 14px; font-size: 0.82rem; color: #64748b; font-weight: 600;">${dtStr}</td>
          <td style="padding: 9px 14px; font-family: monospace; font-weight: 700; color: #1e293b;">${this.escapeHtml(item.username || '-')}</td>
          <td style="padding: 9px 14px; font-weight: 700; color: #334155;">${this.escapeHtml(item.name || '-')}</td>
          <td style="padding: 9px 14px;">${roleBadge}</td>
          <td style="padding: 9px 14px; text-align: center;">${statusBadge}</td>
          <td style="padding: 9px 14px; font-size: 0.8rem; color: #64748b;">${this.escapeHtml(item.ip || 'Local')}</td>
        </tr>
      `;
    }).join('');
  },

  onAdminEmpPaymentTypeChange(type) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const is15Days = type === '15days';
    const lbl = document.getElementById('admin-emp-salary-lbl');
    const inp = document.getElementById('admin-emp-salary');
    if (lbl) {
      if (is15Days) {
        lbl.textContent = isEn ? '15 Days Fixed Salary (₹) *:' : '૧૫ દિવસીય નક્કી પગાર (₹) *:';
      } else {
        lbl.textContent = isEn ? 'Monthly Fixed Salary (₹) *:' : 'માસિક નક્કી પગાર (₹) *:';
      }
    }
    if (inp) {
      inp.placeholder = is15Days ? (isEn ? 'e.g. 5000' : 'દા.ત. 5000') : (isEn ? 'e.g. 15000' : 'દા.ત. 15000');
    }
  },

  adminEditEmployee(empId) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const emp = (this.employeesList || []).find(e => e.id === empId);
    if (!emp) return;

    document.getElementById('admin-emp-id').value = emp.id;
    document.getElementById('admin-emp-name').value = emp.name || '';
    document.getElementById('admin-emp-role').value = emp.role || '';
    document.getElementById('admin-emp-phone').value = emp.phone || '';
    document.getElementById('admin-emp-salary').value = emp.salary || '';

    const payTypeEl = document.getElementById('admin-emp-payment-type');
    if (payTypeEl) {
      payTypeEl.value = emp.paymentType || 'monthly';
      this.onAdminEmpPaymentTypeChange(payTypeEl.value);
    }

    document.getElementById('admin-emp-form-title').innerHTML = isEn
      ? `✏️ Edit details of <strong>${emp.name}</strong>`
      : `✏️ <strong>${emp.name}</strong> ની વિગતો સુધારો `;
    const saveBtn = document.getElementById('admin-btn-save-emp');
    saveBtn.innerHTML = isEn ? `<span>💾</span> <span>Save Changes</span>` : `<span>💾</span> <span>સુધારો સાચવો</span>`;
    saveBtn.style.background = 'linear-gradient(135deg, #2563eb, #3b82f6)';
    document.getElementById('admin-btn-cancel-emp').style.display = 'inline-flex';

    this.toggleAdminEmpAddForm(true);
    const body = document.querySelector('.admin-modal-body');
    if (body) body.scrollTop = 0;
    setTimeout(() => {
      const nameInp = document.getElementById('admin-emp-name');
      if (nameInp) nameInp.focus();
    }, 100);
  },

  adminCancelEditEmployee() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    document.getElementById('admin-emp-id').value = '';
    document.getElementById('admin-emp-name').value = '';
    document.getElementById('admin-emp-role').value = '';
    document.getElementById('admin-emp-phone').value = '';
    document.getElementById('admin-emp-salary').value = '';

    const payTypeEl = document.getElementById('admin-emp-payment-type');
    if (payTypeEl) {
      payTypeEl.value = 'monthly';
      this.onAdminEmpPaymentTypeChange('monthly');
    }

    document.getElementById('admin-emp-form-title').textContent = isEn ? '➕ Add Employee / Edit Details' : '➕ કર્મચારી ઉમેરો / વિગતો સુધારો ';
    const saveBtn = document.getElementById('admin-btn-save-emp');
    saveBtn.innerHTML = isEn ? `<span>➕</span> <span>Add Employee</span>` : `<span>➕</span> <span>કર્મચારી ઉમેરો</span>`;
    saveBtn.style.background = '';
    document.getElementById('admin-btn-cancel-emp').style.display = 'none';
    this.toggleAdminEmpAddForm(false);
  },

  async adminSaveEmployee() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const id = document.getElementById('admin-emp-id').value;
    const name = document.getElementById('admin-emp-name').value.trim();
    const role = document.getElementById('admin-emp-role').value.trim();
    const phone = document.getElementById('admin-emp-phone').value.trim();
    const salary = Number(document.getElementById('admin-emp-salary').value);
    const paymentType = document.getElementById('admin-emp-payment-type')?.value || 'monthly';

    if (!name) {
      this.showToast(isEn ? 'Please enter employee name' : 'કૃપા કરીને કર્મચારીનું નામ લખો', 'error');
      document.getElementById('admin-emp-name').focus();
      return;
    }
    if (isNaN(salary) || salary < 0) {
      this.showToast(isEn ? 'Please enter valid salary' : 'કૃપા કરીને સાચો પગાર લખો', 'error');
      document.getElementById('admin-emp-salary').focus();
      return;
    }

    try {
      if (id) {
        // Update existing employee
        const res = await fetch(`/api/employees/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, role, phone, salary, paymentType })
        });
        const data = await res.json();
        if (data && data.success) {
          this.showToast(isEn ? `'${name}' details updated by admin!` : `'${name}' ની વિગતો એડમિન દ્વારા સફળતાપૂર્વક અપડેટ થઈ ગઈ!`, 'success');
        }
      } else {
        // Add new employee
        const res = await fetch('/api/employees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, role, phone, salary, paymentType })
        });
        const data = await res.json();
        if (data && data.success) {
          this.showToast(isEn ? `New employee '${name}' added by admin!` : `નવા કર્મચારી '${name}' એડમિન દ્વારા સફળતાપૂર્વક ઉમેરાયા!`, 'success');
        }
      }

      await this.loadEmployees();
      this.renderAdminEmployeesList();
      this.adminCancelEditEmployee();
    } catch (e) {
      this.showToast(isEn ? 'Error saving employee' : 'કર્મચારી સેવ કરવામાં ભૂલ આવી', 'error');
    }
  },

  async adminDeleteEmployee(empId) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const emp = (this.employeesList || []).find(e => e.id === empId);
    const empName = emp ? emp.name : (isEn ? 'This employee' : 'આ કર્મચારી');
    if (!confirm(isEn ? `Are you sure you want to delete ${empName}? This will remove all records of this employee.` : `શું તમે ખરેખર ${empName} ને કાઢી નાખવા માંગો છો? આનાથી કર્મચારીનો તમામ રેકોર્ડ નીકળી જશે.`)) return;

    try {
      const res = await fetch(`/api/employees/${empId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data && data.success) {
        this.showToast(isEn ? `${empName} deleted by admin.` : `${empName} ને એડમિન દ્વારા સફળતાપૂર્વક કાઢી નાખવામાં આવ્યા.`, 'success');
        await this.loadEmployees();
        this.renderAdminEmployeesList();
        this.adminCancelEditEmployee();
      }
    } catch (e) {
      this.showToast(isEn ? 'Error deleting' : 'કાઢી નાખવામાં ભૂલ આવી', 'error');
    }
  },

  // ==================== ADMIN: NITYA BHAGAT / BHAKT SEVA MANAGEMENT ====================
  adminBhaktStatusFilter: 'active', // 'all' | 'active' | 'inactive'
  adminBhaktSearchQuery: '',

  async adminLoadBhaktsTab() {
    await this.loadBhakts();
    this.renderAdminBhaktsList();

    const nameInp = document.getElementById('admin-bhakt-name');
    if (nameInp && window.GujaratiTyping) {
      window.GujaratiTyping.attach(nameInp);
    }
    const searchInp = document.getElementById('admin-bhakt-search-input');
    if (searchInp && window.GujaratiTyping) {
      window.GujaratiTyping.attach(searchInp);
    }
  },

  setAdminBhaktFilter(filter) {
    this.adminBhaktStatusFilter = filter;
    ['all', 'active', 'inactive'].forEach(f => {
      const btn = document.getElementById(`admin-bhakt-filter-${f}`);
      if (btn) {
        if (f === filter) {
          btn.classList.add('active');
          btn.style.background = '#0f172a';
          btn.style.color = '#ffffff';
        } else {
          btn.classList.remove('active');
          btn.style.background = '#ffffff';
          btn.style.color = '#334155';
        }
      }
    });
    this.renderAdminBhaktsList();
  },

  adminFilterBhaktsList(query) {
    this.adminBhaktSearchQuery = (query || '').toLowerCase().trim();
    this.renderAdminBhaktsList();
  },

  renderAdminBhaktsList() {
    const container = document.getElementById('admin-bhakts-list');
    if (!container) return;
    container.innerHTML = '';

    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    // Update Top Toggle Button State
    const bBtn = document.getElementById('admin-bhakt-edit-toggle-btn');
    const bIcon = document.getElementById('admin-bhakt-edit-toggle-icon');
    const bText = document.getElementById('admin-bhakt-edit-toggle-text');
    if (bBtn && bIcon && bText) {
      if (this.adminBhaktEditMode) {
        bBtn.style.background = 'linear-gradient(135deg, #15803d, #166534)';
        bIcon.textContent = '✓';
        bText.textContent = isEn ? 'Done' : 'પૂર્ણ થયું';
      } else {
        bBtn.style.background = 'linear-gradient(135deg, #d97706, #b45309)';
        bIcon.textContent = '🛠️';
        bText.textContent = isEn ? 'Change / Manage' : 'ફેરફાર કરો';
      }
    }

    const bhAddForm = document.getElementById('admin-bhakt-form-container');
    const bhAddIcon = document.getElementById('admin-bhakt-add-toggle-icon');
    const bhAddText = document.getElementById('admin-bhakt-add-toggle-text');
    if (bhAddIcon && bhAddText) {
      const isOpen = bhAddForm && bhAddForm.style.display !== 'none';
      bhAddIcon.textContent = isOpen ? '✕' : '➕';
      bhAddText.textContent = isOpen ? (isEn ? 'Close Form' : 'ફોર્મ બંધ કરો') : (isEn ? 'Add Member' : 'નવો હરિભક્ત ઉમેરો');
    }

    const allBhakts = this.bhaktsList || [];
    const countAll = allBhakts.length;
    const countActive = allBhakts.filter(b => b.status !== 'inactive').length;
    const countInactive = allBhakts.filter(b => b.status === 'inactive').length;

    const cAllEl = document.getElementById('admin-bhakt-count-all');
    const cActEl = document.getElementById('admin-bhakt-count-active');
    const cInEl = document.getElementById('admin-bhakt-count-inactive');
    if (cAllEl) cAllEl.textContent = `(${countAll})`;
    if (cActEl) cActEl.textContent = `(${countActive})`;
    if (cInEl) cInEl.textContent = `(${countInactive})`;

    let list = allBhakts;

    // Filter by status
    if (this.adminBhaktStatusFilter === 'active') {
      list = list.filter(b => b.status !== 'inactive');
    } else if (this.adminBhaktStatusFilter === 'inactive') {
      list = list.filter(b => b.status === 'inactive');
    }

    // Filter by search query
    if (this.adminBhaktSearchQuery) {
      const q = this.adminBhaktSearchQuery;
      list = list.filter(b => {
        const nameMatch = (b.name || '').toLowerCase().includes(q);
        const donorMatch = (b.donorId || '').toLowerCase().includes(q);
        const phoneMatch = (b.phone || '').toLowerCase().includes(q);
        return nameMatch || donorMatch || phoneMatch;
      });
    }

    const badge = document.getElementById('admin-bhakts-count-badge');
    if (badge) {
      badge.textContent = isEn ? `${list.length} Members` : `${list.length} સભ્યો`;
    }

    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 28px 16px; color: var(--text-muted); background: #f8fafc; border-radius: var(--radius-sm); border: 1.5px dashed #cbd5e1;">
          <div style="font-size: 2rem; margin-bottom: 6px;">🙏</div>
          <div style="font-weight: 700; color: #475569;">${isEn ? 'No Members Found in this filter' : 'આ ફિલ્ટરમાં કોઈ હરિભક્ત મળ્યા નથી'}</div>
          <div style="font-size: 0.82rem; color: #94a3b8; margin-top: 4px;">${isEn ? 'Use the form above to add a new devotee.' : 'નવો હરિભક્ત ઉમેરવા માટે ઉપરના ફોર્મનો ઉપયોગ કરો.'}</div>
        </div>
      `;
      return;
    }

    list.forEach(bhakt => {
      const isInactive = bhakt.status === 'inactive';
      const initials = (bhakt.name || 'ભ').split(' ').map(p => p[0]).join('').slice(0, 2);
      const row = document.createElement('div');
      row.className = 'admin-item-row';
      row.style.padding = '10px 14px';
      row.style.background = isInactive ? '#f8fafc' : '#ffffff';
      row.style.border = this.adminBhaktEditMode ? '1px solid #fcd34d' : (isInactive ? '1px dashed #cbd5e1' : '1px solid #e2e8f0');
      row.style.borderLeft = isInactive ? '4px solid #94a3b8' : '4px solid #f59e0b';
      if (isInactive) {
        row.style.opacity = '0.82';
      }

      const payTypeLabel = bhakt.payType === 'month_wise'
        ? `<span style="font-size: 0.72rem; background: #f3e8ff; color: #6b21a8; font-weight: 800; padding: 2px 7px; border-radius: 4px;">${isEn ? '🗓️ Monthly' : '🗓️ માસિક'}</span>`
        : `<span style="font-size: 0.72rem; background: #fef3c7; color: #92400e; font-weight: 800; padding: 2px 7px; border-radius: 4px;">${isEn ? '📅 Date-wise' : '📅 તારીખવાર'}</span>`;

      const statusBadge = isInactive
        ? `<span style="font-size: 0.72rem; background: #fee2e2; color: #b91c1c; font-weight: 800; padding: 2px 7px; border-radius: 4px;">${isEn ? '⚪ Inactive' : '⚪ બંધ'}</span>`
        : '';

      const idBadge = bhakt.donorId
        ? `<span style="font-size: 0.72rem; background: #e0e7ff; color: #3730a3; font-weight: 800; padding: 2px 7px; border-radius: 4px;">ID: ${bhakt.donorId}</span>`
        : '';

      let lastDepFormatted = '';
      if (bhakt.lastDeposit && bhakt.lastDeposit.periodEnd) {
        const parts = String(bhakt.lastDeposit.periodEnd).split('-');
        lastDepFormatted = parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : bhakt.lastDeposit.periodEnd;
      }
      const lastDepInfo = lastDepFormatted
        ? `<span style="color: #64748b; font-size: 0.78rem;"> | ${isEn ? 'Last Paid:' : 'છેલ્લે ચૂકવેલ:'} <strong>${lastDepFormatted}</strong>${isEn ? '' : ' સુધી'}</span>`
        : '';

      const actionsHtml = this.adminBhaktEditMode ? `
        <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
          <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #1e40af; background: #eff6ff; border: 1px solid #bfdbfe; font-weight: 700; border-radius: 6px;" onclick="App.adminEditBhakt('${bhakt.id}')" title="${isEn ? 'Edit' : 'સુધારો'}">
            <span>✏️</span> <span>${isEn ? 'Edit' : 'સુધારો'}</span>
          </button>
          <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #0f766e; background: #f0fdfa; border: 1px solid #99f6e4; font-weight: 700; border-radius: 6px;" onclick="App.openBhaktPassbook('${bhakt.id}')" title="${isEn ? 'Passbook' : 'પાસબુક'}">
            <span>📜</span> <span>${isEn ? 'Passbook' : 'પાસબુક'}</span>
          </button>
          <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: ${isInactive ? '#15803d' : '#b45309'}; background: ${isInactive ? '#f0fdf4' : '#fffbeb'}; border: 1px solid ${isInactive ? '#86efac' : '#fde68a'}; font-weight: 700; border-radius: 6px;" onclick="App.adminToggleBhaktStatus('${bhakt.id}')" title="${isInactive ? (isEn ? 'Activate' : 'સક્રિય કરો') : (isEn ? 'Deactivate' : 'મોકૂફ કરો')}">
            ${isInactive ? (isEn ? '🟢 Activate' : '🟢 ચાલુ કરો') : (isEn ? '⚪ Deactivate' : '⚪ બંધ')}
          </button>
          <button class="btn-icon" style="padding: 4px 10px; font-size: 0.8rem; color: #b91c1c; background: #fee2e2; border: 1px solid #fca5a5; font-weight: 700; border-radius: 6px;" onclick="App.adminDeleteBhakt('${bhakt.id}')" title="${isEn ? 'Delete' : 'કાઢી નાખો'}">
            <span>🗑️</span> <span>${isEn ? 'Delete' : 'ડિલીટ'}</span>
          </button>
        </div>
      ` : ``;

      row.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
          <span style="width: 38px; height: 38px; border-radius: 50%; background: ${isInactive ? '#e2e8f0' : 'linear-gradient(135deg, #fef3c7, #fde68a)'}; color: ${isInactive ? '#64748b' : '#b45309'}; display: inline-flex; align-items: center; justify-content: center; font-weight: 900; font-size: 0.88rem; flex-shrink: 0; border: 1.5px solid ${isInactive ? '#cbd5e1' : '#fcd34d'};">
            ${initials}
          </span>
          <div style="min-width: 0;">
            <div style="font-weight: 800; color: #0f172a; font-size: 0.95rem; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <span>${bhakt.name}</span>
              ${idBadge}
              ${payTypeLabel}
              ${statusBadge}
            </div>
            <div style="font-size: 0.82rem; color: #64748b; margin-top: 3px;">
              ${isEn ? 'Daily Rate:' : 'રોજનો દર:'} <strong style="color: #b45309; font-size: 0.88rem;">₹ ${(Number(bhakt.dailyAmount) || 0).toLocaleString('en-IN')}</strong> ${isEn ? '/ day' : '/ દિવસ'}
              ${bhakt.phone ? ` | 📞 <a href="tel:${bhakt.phone}" style="color: #475569; text-decoration: none;">${bhakt.phone}</a>` : ''}
              ${bhakt.totalDaysPaid ? ` | ${isEn ? 'Total Received:' : 'કુલ જમા:'} <strong style="color: #059669;">₹ ${(Number(bhakt.totalAmountPaid) || 0).toLocaleString('en-IN')}</strong> (${bhakt.totalDaysPaid} ${isEn ? 'days' : 'દિન'})` : ''}
              ${lastDepInfo}
            </div>
          </div>
        </div>
        ${actionsHtml}
      `;
      container.appendChild(row);
    });
  },

  adminEditBhakt(bhaktId) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const bhakt = (this.bhaktsList || []).find(b => b.id === bhaktId);
    if (!bhakt) return;

    document.getElementById('admin-bhakt-id').value = bhakt.id;
    document.getElementById('admin-bhakt-donor-id').value = bhakt.donorId || '';
    document.getElementById('admin-bhakt-name').value = bhakt.name || '';
    document.getElementById('admin-bhakt-rate').value = bhakt.dailyAmount || '';
    document.getElementById('admin-bhakt-phone').value = bhakt.phone || '';

    const payTypeSel = document.getElementById('admin-bhakt-pay-type');
    if (payTypeSel) payTypeSel.value = bhakt.payType || 'date_wise';

    const statusSel = document.getElementById('admin-bhakt-status');
    if (statusSel) statusSel.value = bhakt.status || 'active';

    document.getElementById('admin-bhakt-form-title').innerHTML = isEn
      ? `✏️ Edit <strong>${bhakt.name}</strong> Details`
      : `✏️ <strong>${bhakt.name}</strong> વિગત સુધારો`;
    const saveBtn = document.getElementById('admin-btn-save-bhakt');
    saveBtn.innerHTML = `<span>💾</span> <span>${isEn ? 'Save' : 'સાચવો'}</span>`;
    saveBtn.style.background = 'linear-gradient(135deg, #2563eb, #1d4ed8)';
    const cancelBtn = document.getElementById('admin-btn-cancel-bhakt');
    cancelBtn.textContent = isEn ? 'Cancel' : 'રદ કરો';
    cancelBtn.style.display = 'inline-flex';

    this.toggleAdminBhaktAddForm(true);
    const body = document.querySelector('.admin-modal-body');
    if (body) body.scrollTop = 0;
    setTimeout(() => {
      const nameInp = document.getElementById('admin-bhakt-name');
      if (nameInp) nameInp.focus();
    }, 100);
  },

  adminCancelEditBhakt() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    document.getElementById('admin-bhakt-id').value = '';
    document.getElementById('admin-bhakt-donor-id').value = '';
    document.getElementById('admin-bhakt-name').value = '';
    document.getElementById('admin-bhakt-rate').value = '';
    document.getElementById('admin-bhakt-phone').value = '';

    const payTypeSel = document.getElementById('admin-bhakt-pay-type');
    if (payTypeSel) payTypeSel.value = 'date_wise';

    const statusSel = document.getElementById('admin-bhakt-status');
    if (statusSel) statusSel.value = 'active';

    document.getElementById('admin-bhakt-form-title').innerHTML = isEn ? '➕ Add Devotee' : '➕ નવો હરિભક્ત ઉમેરો';
    const saveBtn = document.getElementById('admin-btn-save-bhakt');
    saveBtn.innerHTML = `<span>💾</span> <span>${isEn ? 'Save' : 'સાચવો'}</span>`;
    saveBtn.style.background = 'linear-gradient(135deg, #d97706, #b45309)';
    document.getElementById('admin-btn-cancel-bhakt').style.display = 'none';
    this.toggleAdminBhaktAddForm(false);
  },

  async adminSaveBhakt() {
    const id = document.getElementById('admin-bhakt-id').value;
    const donorId = (document.getElementById('admin-bhakt-donor-id').value || '').trim();
    const name = document.getElementById('admin-bhakt-name').value.trim();
    const dailyAmount = Number(document.getElementById('admin-bhakt-rate').value);
    const phone = document.getElementById('admin-bhakt-phone').value.trim();
    const payType = document.getElementById('admin-bhakt-pay-type').value || 'date_wise';
    const status = document.getElementById('admin-bhakt-status').value || 'active';

    if (!name) {
      this.showToast('કૃપા કરીને ભક્તનું પૂરું નામ લખો', 'error');
      document.getElementById('admin-bhakt-name').focus();
      return;
    }
    if (isNaN(dailyAmount) || dailyAmount <= 0) {
      this.showToast('કૃપા કરીને સાચી રોજીંદી રકમ (દા.ત. ૧૫ અથવા ૧૦૦) લખો', 'error');
      document.getElementById('admin-bhakt-rate').focus();
      return;
    }

    try {
      let res;
      if (id) {
        // Update existing Bhakt
        res = await fetch(`/api/bhakts/${id}`, {
          method: 'PUT',
          headers: this.getAdminAuthHeaders(),
          body: JSON.stringify({ name, dailyAmount, phone, donorId, payType, status })
        });
      } else {
        // Add new Bhakt
        res = await fetch('/api/bhakts', {
          method: 'POST',
          headers: this.getAdminAuthHeaders(),
          body: JSON.stringify({ name, dailyAmount, phone, donorId, payType, status })
        });
      }

      const data = await res.json();
      if (data && data.success) {
        this.showToast(`✅ ભક્ત '${name}' ની વિગતો એડમિન દ્વારા સાચવી લેવાઈ!`, 'success');
        await this.loadBhakts();
        this.renderAdminBhaktsList();
        this.adminCancelEditBhakt();
      } else {
        this.showToast((data && data.error) || 'ભક્ત સેવ કરવામાં ભૂલ આવી', 'error');
      }
    } catch (e) {
      console.error('Error saving bhakt:', e);
      this.showToast('સર્વર કનેક્શનમાં ભૂલ આવી', 'error');
    }
  },

  async adminToggleBhaktStatus(bhaktId) {
    const bhakt = (this.bhaktsList || []).find(b => b.id === bhaktId);
    if (!bhakt) return;
    const newStatus = bhakt.status === 'inactive' ? 'active' : 'inactive';
    const actionLabel = newStatus === 'active' ? 'સક્રિય' : 'બંધ / મોકૂફ';
    if (!confirm(`શું તમે ભક્ત "${bhakt.name}" ની સેવા ${actionLabel} કરવા માંગો છો?`)) return;

    try {
      const res = await fetch(`/api/bhakts/${bhaktId}`, {
        method: 'PUT',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ status: newStatus })
      });
      const data = await res.json();
      if (data && data.success) {
        bhakt.status = newStatus;
        this.showToast(`ભક્ત "${bhakt.name}" ની સેવા ${actionLabel} થઈ!`, 'success');
        await this.loadBhakts();
        this.renderAdminBhaktsList();
      } else {
        this.showToast((data && data.error) || 'સ્ટેટસ બદલવામાં ભૂલ આવી', 'error');
      }
    } catch (e) {
      this.showToast('સ્ટેટસ બદલવામાં ભૂલ આવી', 'error');
    }
  },

  async adminDeleteBhakt(bhaktId) {
    const bhakt = (this.bhaktsList || []).find(b => b.id === bhaktId);
    const bhaktName = bhakt ? bhakt.name : 'આ ભક્ત';
    if (!confirm(`શું તમે ખરેખર "${bhaktName}" ને કાઢી નાખવા માંગો છો? આનાથી ભક્તનો તમામ રેકોર્ડ નીકળી જશે.`)) return;

    try {
      const res = await fetch(`/api/bhakts/${bhaktId}`, {
        method: 'DELETE',
        headers: this.getAdminAuthHeaders()
      });
      const data = await res.json();
      if (data && data.success) {
        this.showToast(`🗑️ "${bhaktName}" ને એડમિન દ્વારા સફળતાપૂર્વક કાઢી નાખવામાં આવ્યા.`, 'info');
        await this.loadBhakts();
        this.renderAdminBhaktsList();
        this.adminCancelEditBhakt();
      } else {
        this.showToast((data && data.error) || 'કાઢી નાખવામાં ભૂલ આવી', 'error');
      }
    } catch (e) {
      this.showToast('કાઢી નાખવામાં ભૂલ આવી', 'error');
    }
  },

  // Note Admin Actions
  adminAddNote() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const inp = document.getElementById('admin-input-new-note');
    const val = parseInt(inp.value.trim(), 10);
    if (isNaN(val) || val <= 0) {
      this.showToast(isEn ? 'Please enter a valid note denomination' : 'કૃપા કરીને માન્ય નોટની કિંમત લખો', 'error');
      return;
    }
    if (this.adminData.notes.includes(val)) {
      this.showToast(isEn ? `₹${val} note already exists!` : `₹${val} ની નોટ પહેલેથી અસ્તિત્વમાં છે!`, 'error');
      return;
    }
    this.adminData.notes.push(val);
    this.adminData.notes.sort((a, b) => b - a);
    inp.value = '';
    this.renderAdminLists();
    this.showToast(isEn ? `₹${val} note added to list` : `₹${val} ની નોટ યાદીમાં ઉમેરાઈ ગઈ`);
  },

  adminAddNotePreset(val) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (this.adminData.notes.includes(val)) {
      this.showToast(isEn ? `₹${val} note already in list!` : `₹${val} ની નોટ પહેલેથી યાદીમાં છે!`);
      return;
    }
    this.adminData.notes.push(val);
    this.adminData.notes.sort((a, b) => b - a);
    this.renderAdminLists();
    this.showToast(isEn ? `₹${val} note added` : `₹${val} નોટ ઉમેરાઈ`);
  },

  adminRemoveNote(val) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (this.adminData.notes.length <= 1) {
      this.showToast(isEn ? 'At least one note must be present!' : 'ઓછામાં ઓછી એક નોટ હોવી જરૂરી છે!', 'error');
      return;
    }
    this.adminData.notes = this.adminData.notes.filter(n => n !== val);
    this.renderAdminLists();
    this.showToast(isEn ? `₹${val} note removed` : `₹${val} નોટ કાઢી નાખવામાં આવી`);
  },

  // Bank Admin Actions
  async adminAddBank(presetName = null) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const inp = document.getElementById('admin-input-new-bank');
    const name = (presetName || (inp ? inp.value : '')).trim().toUpperCase();
    if (!name) {
      this.showToast(isEn ? 'Please enter bank name in English' : 'કૃપા કરીને બેંકનું નામ અંગ્રેજીમાં લખો', 'error');
      return;
    }

    // Check if in active list
    if (this.adminData.banks && this.adminData.banks.includes(name)) {
      this.showToast(isEn ? `Bank "${name}" is already active in the list!` : `"${name}" બેંક પહેલાંથી સક્રિય યાદીમાં છે!`, 'warning');
      return;
    }

    // Check if in inactive list - if so, offer to reactivate
    if (this.adminData.inactiveBanks && this.adminData.inactiveBanks.includes(name)) {
      const doReactivate = confirm(isEn
        ? `Bank "${name}" is currently Inactive. Do you want to activate it?`
        : `"${name}" બેંક હાલમાં નિષ્ક્રિય છે. શું તમે તેને ફરી સક્રિય (ચાલુ) કરવા માંગો છો?`);
      if (doReactivate) {
        if (inp) inp.value = '';
        await this.adminToggleBankStatus(name, true);
      }
      return;
    }

    this.adminData.banks.push(name);
    if (inp) inp.value = '';
    this.renderAdminLists();
    await this.adminSaveAndApply();
    this.toggleAdminBankAddForm(false);
    this.showToast(isEn ? `🏦 Bank ${name} added successfully` : `🏦 ${name} બેંક સફળતાપૂર્વક ઉમેરાઈ ગઈ`, 'success');
  },

  async adminToggleBankStatus(name, active) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (!name) return;
    if (!active && (this.adminData.banks || []).length <= 1) {
      this.showToast(isEn ? 'At least one bank account must remain active!' : 'ઓછામાં ઓછું એક બેંક ખાતું સક્રિય હોવું જરૂરી છે!', 'error');
      return;
    }
    try {
      const res = await fetch('/api/admin/toggle-bank-status', {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ name, active })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;
      if (res.ok && data.success) {
        this.adminData.banks = data.banks || [];
        this.adminData.inactiveBanks = data.inactiveBanks || [];
        this.fixedBanks = data.banks || [];
        if (this.settings) {
          this.settings.defaultBanks = data.banks || [];
          this.settings.inactiveBanks = data.inactiveBanks || [];
        }
        this.renderAdminLists();
        this.normalizeRecordStructure();
        this.renderRecord();
        const msg = active
          ? (isEn ? `🏦 Bank "${name}" activated!` : `🏦 "${name}" બેંક ફરી સક્રિય (ચાલુ) થઈ ગઈ!`)
          : (isEn ? `⏸️ Bank "${name}" deactivated! It will no longer show in new daily entries.` : `⏸️ "${name}" બેંક બંધ (નિષ્ક્રિય) કરવામાં આવી! નવો હિસાબ દાખલ કરતી વખતે તે નહીં દેખાય.`);
        this.showToast(msg, 'success');
      } else {
        this.showToast(data.error || (isEn ? 'Failed to update bank status' : 'સ્થિતિ બદલવામાં ભૂલ આવી'), 'error');
      }
    } catch (e) {
      this.showToast(isEn ? 'Server error' : 'સર્વર સાથે સંપર્ક થઈ શક્યો નહીં', 'error');
    }
  },

  async adminDeleteBank(name) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (!name) return;
    const total = (this.adminData.banks || []).length + (this.adminData.inactiveBanks || []).length;
    if (total <= 1) {
      this.showToast(isEn ? 'At least one bank account is required in settings!' : 'સેટિંગ્સમાં ઓછામાં ઓછું એક બેંક ખાતું હોવું અનિવાર્ય છે!', 'error');
      return;
    }
    const confirmMsg = isEn
      ? `Are you sure you want to permanently delete '${name}'?\nHistorical financial entries will remain intact, but it will be removed permanently from settings.`
      : `શું તમે ખાતરીપૂર્વક '${name}' બેંક ખાતું કાયમી ડિલીટ કરવા માંગો છો?\nજો આ બેંકમાં જૂનો હિસાબ હશે તો તે સલામત રહેશે, પરંતુ સેટિંગ્સમાંથી કાયમ માટે નીકળી જશે.`;
    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch('/api/admin/delete-bank', {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;
      if (res.ok && data.success) {
        this.adminData.banks = data.banks || [];
        this.adminData.inactiveBanks = data.inactiveBanks || [];
        this.fixedBanks = data.banks || [];
        if (this.settings) {
          this.settings.defaultBanks = data.banks || [];
          this.settings.inactiveBanks = data.inactiveBanks || [];
        }
        this.renderAdminLists();
        this.normalizeRecordStructure();
        this.renderRecord();
        this.showToast(isEn ? `🗑️ Bank "${name}" permanently deleted!` : `🗑️ "${name}" બેંક કાયમી ડિલીટ થઈ ગઈ!`, 'success');
      } else {
        this.showToast(data.error || (isEn ? 'Failed to delete bank' : 'ડિલીટ કરવામાં ભૂલ આવી'), 'error');
      }
    } catch (e) {
      this.showToast(isEn ? 'Server error' : 'સર્વર સાથે સંપર્ક થઈ શક્યો નહીં', 'error');
    }
  },

  adminRemoveBank(idx) {
    if (this.adminData.banks && this.adminData.banks[idx]) {
      this.adminDeleteBank(this.adminData.banks[idx]);
    }
  },

  // Voucher Admin Actions
  async adminAddVoucher(presetName = null) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const inp = document.getElementById('admin-input-new-voucher');
    let name = (presetName || (inp ? inp.value : '')).trim();
    if (!name) {
      this.showToast(isEn ? 'Please enter voucher / expense name' : 'કૃપા કરીને વાઉચર / ખર્ચનું નામ લખો', 'error');
      return;
    }

    const gujName = this.getKhataNameInGujarati(name);
    const engName = this.getEnglishKhataName(name);
    const storeKey = engName || name;

    // Check if in active list
    const existsActive = (this.adminData.vouchers || []).some(v =>
      v.trim().toUpperCase() === storeKey.toUpperCase() ||
      v.trim().toUpperCase() === name.toUpperCase() ||
      this.getKhataNameInGujarati(v).trim().toUpperCase() === gujName.toUpperCase()
    );
    if (existsActive) {
      this.showToast(isEn ? `Voucher "${gujName} (${storeKey})" is already active!` : `"${gujName} (${storeKey})" વાઉચર પહેલાંથી સક્રિય છે!`, 'warning');
      return;
    }

    // Check if in inactive list - if so, offer to reactivate
    const inactiveMatch = (this.adminData.inactiveVouchers || []).find(v =>
      v.trim().toUpperCase() === storeKey.toUpperCase() ||
      v.trim().toUpperCase() === name.toUpperCase() ||
      this.getKhataNameInGujarati(v).trim().toUpperCase() === gujName.toUpperCase()
    );
    if (inactiveMatch) {
      const doReactivate = confirm(isEn
        ? `Voucher "${gujName} (${inactiveMatch})" is currently Inactive. Do you want to activate it?`
        : `"${gujName} (${inactiveMatch})" વાઉચર હાલમાં નિષ્ક્રિય છે. શું તમે તેને ફરી સક્રિય (ચાલુ) કરવા માંગો છો?`);
      if (doReactivate) {
        if (inp) {
          inp.value = '';
          this.onAdminVoucherInput('');
        }
        await this.adminToggleVoucherStatus(inactiveMatch, true);
      }
      return;
    }

    this.adminData.vouchers.push(storeKey);
    if (inp) {
      inp.value = '';
      this.onAdminVoucherInput('');
    }
    this.renderAdminLists();
    await this.adminSaveAndApply();
    this.toggleAdminVoucherAddForm(false);
    this.showToast(isEn ? `🧾 Voucher ${gujName} (${storeKey}) added successfully` : `🧾 ${gujName} (${storeKey}) વાઉચર સફળતાપૂર્વક ઉમેરાઈ ગયું`, 'success');
  },

  async adminToggleVoucherStatus(name, active) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (!name) return;
    const gujName = this.getKhataNameInGujarati(name) || name;
    if (!active && (this.adminData.vouchers || []).length <= 1) {
      this.showToast(isEn ? 'At least one voucher account must remain active!' : 'ઓછામાં ઓછું એક વાઉચર ખાતું સક્રિય હોવું જરૂરી છે!', 'error');
      return;
    }
    try {
      const res = await fetch('/api/admin/toggle-voucher-status', {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ name, active })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;
      if (res.ok && data.success) {
        this.adminData.vouchers = data.vouchers || [];
        this.adminData.inactiveVouchers = data.inactiveVouchers || [];
        this.fixedVouchers = data.vouchers || [];
        if (this.settings) {
          this.settings.defaultVouchers = data.vouchers || [];
          this.settings.inactiveVouchers = data.inactiveVouchers || [];
        }
        this.renderAdminLists();
        this.normalizeRecordStructure();
        this.renderRecord();
        const msg = active
          ? (isEn ? `🧾 Voucher "${gujName}" activated!` : `🧾 "${gujName}" વાઉચર ફરી સક્રિય (ચાલુ) થઈ ગયું!`)
          : (isEn ? `⏸️ Voucher "${gujName}" deactivated! Past records stay safe, but it won't appear on new entries.` : `⏸️ "${gujName}" વાઉચર બંધ (નિષ્ક્રિય) કરવામાં આવ્યું! જૂનો હિસાબ સલામત રહેશે પરંતુ નવા વાઉચરમાં નહીં દેખાય.`);
        this.showToast(msg, 'success');
      } else {
        this.showToast(data.error || (isEn ? 'Failed to update voucher status' : 'સ્થિતિ બદલવામાં ભૂલ આવી'), 'error');
      }
    } catch (e) {
      this.showToast(isEn ? 'Server error' : 'સર્વર સાથે સંપર્ક થઈ શક્યો નહીં', 'error');
    }
  },

  async adminDeleteVoucher(name) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (!name) return;
    const gujName = this.getKhataNameInGujarati(name) || name;
    const total = (this.adminData.vouchers || []).length + (this.adminData.inactiveVouchers || []).length;
    if (total <= 1) {
      this.showToast(isEn ? 'At least one voucher account is required in settings!' : 'સેટિંગ્સમાં ઓછામાં ઓછું એક વાઉચર ખાતું હોવું અનિવાર્ય છે!', 'error');
      return;
    }
    const confirmMsg = isEn
      ? `Are you sure you want to permanently delete '${gujName}'?\nPast financial vouchers will remain safe, but it will be removed permanently from settings.`
      : `શું તમે ખાતરીપૂર્વક '${gujName}' વાઉચર કાયમી ડિલીટ કરવા માંગો છો?\nજો આ ખાતામાં જૂના વાઉચર હશે તો તે રેકોર્ડમાં સલામત રહેશે, પરંતુ સેટિંગ્સમાંથી કાયમ માટે નીકળી જશે.`;
    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch('/api/admin/delete-voucher', {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;
      if (res.ok && data.success) {
        this.adminData.vouchers = data.vouchers || [];
        this.adminData.inactiveVouchers = data.inactiveVouchers || [];
        this.fixedVouchers = data.vouchers || [];
        if (this.settings) {
          this.settings.defaultVouchers = data.vouchers || [];
          this.settings.inactiveVouchers = data.inactiveVouchers || [];
        }
        this.renderAdminLists();
        this.normalizeRecordStructure();
        this.renderRecord();
        this.showToast(isEn ? `🗑️ Voucher "${gujName}" permanently deleted!` : `🗑️ "${gujName}" વાઉચર કાયમી ડિલીટ થઈ ગયું!`, 'success');
      } else {
        this.showToast(data.error || (isEn ? 'Failed to delete voucher' : 'ડિલીટ કરવામાં ભૂલ આવી'), 'error');
      }
    } catch (e) {
      this.showToast(isEn ? 'Server error' : 'સર્વર સાથે સંપર્ક થઈ શક્યો નહીં', 'error');
    }
  },

  adminRemoveVoucher(idx) {
    if (this.adminData.vouchers && this.adminData.vouchers[idx]) {
      this.adminDeleteVoucher(this.adminData.vouchers[idx]);
    }
  },

  // Save All Admin Settings & Apply to Daily Screen
  async adminSaveAndApply() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const payload = {
      notes: this.adminData.notes,
      banks: this.adminData.banks,
      inactiveBanks: this.adminData.inactiveBanks || [],
      vouchers: this.adminData.vouchers,
      inactiveVouchers: this.adminData.inactiveVouchers || [],
      orgName: (document.getElementById('admin-setting-org-name')?.value || this.settings.orgName || 'Gadisthan Jetpur').trim(),
      orgSubtitle: (document.getElementById('admin-setting-org-sub')?.value || this.settings.orgSubtitle || '').trim(),
      phone: (document.getElementById('admin-setting-phone')?.value || this.settings.phone || '').trim(),
      exportFolder: (document.getElementById('admin-setting-folder')?.value || this.settings.exportFolder || 'D:\\Account Report').trim(),
      signPrepared: (document.getElementById('admin-setting-sign-prep')?.value || this.settings.signPrepared || 'હિસાબનીશ / એકાઉન્ટન્ટ').trim(),
      signChecked: (document.getElementById('admin-setting-sign-chk')?.value || this.settings.signChecked || 'તપાસનાર / સેક્રેટરી').trim(),
      signPresident: (document.getElementById('admin-setting-sign-pres')?.value || this.settings.signPresident || 'પ્રમુખ / ટ્રસ્ટી').trim(),
      smtpSenderName: 'Gadisthan Jetpur',
      adminAlertEmail: (document.getElementById('admin-setting-alert-email')?.value || this.settings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com').trim()
    };

    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: this.getAdminAuthHeaders(),
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;
      if (data.success) {
        this.settings = data.settings;
        this.activeNotes = this.settings.notes;
        this.fixedBanks = this.settings.defaultBanks;
        this.fixedVouchers = this.settings.defaultVouchers;
        this.adminData.inactiveBanks = this.settings.inactiveBanks || [];
        this.adminData.inactiveVouchers = this.settings.inactiveVouchers || [];

        this.savePrintDefault(false);
        this.applySettingsToUI();
        this.normalizeRecordStructure();
        this.renderRecord();

        if (this.currentView === 'admin' && this.adminMasterDate) {
          this.adminRenderMasterHisabUI();
        }
        this.showToast(isEn ? '✅ Admin settings saved successfully!' : '✅ એડમિન સેટિંગ્સ સફળતાપૂર્વક સાચવી લેવાઈ!', 'success');
      }
    } catch (e) {
      this.showToast(isEn ? 'Error saving admin settings' : 'એડમિન સેટિંગ્સ સાચવવામાં ક્ષતિ આવી', 'error');
    }
  },

  async adminResetDefaults() {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (!confirm(isEn ? 'Do you want to reset all notes, banks and expenses back to Excel defaults?' : 'શું તમે તમામ નોટ, બેંક અને ખર્ચને મૂળ એક્સેલ ડિફૉલ્ટ પર રીસેટ કરવા માંગો છો?')) return;
    try {
      const res = await fetch('/api/admin/reset-defaults', {
        method: 'POST',
        headers: this.getAdminAuthHeaders()
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;
      if (data.success) {
        this.settings = data.settings;
        this.activeNotes = this.settings.notes;
        this.fixedBanks = this.settings.defaultBanks;
        this.fixedVouchers = this.settings.defaultVouchers;

        this.adminData.notes = [...this.activeNotes];
        this.adminData.banks = [...this.fixedBanks];
        this.adminData.inactiveBanks = [];
        this.adminData.vouchers = [...this.fixedVouchers];
        this.adminData.inactiveVouchers = [];

        this.renderAdminLists();
        this.applySettingsToUI();
        this.normalizeRecordStructure();
        this.renderRecord();
      }
    } catch (e) {
      this.showToast(isEn ? 'Error resetting' : 'રીસેટ કરવામાં ભૂલ આવી', 'error');
    }
  },

  // =========================================================================
  // ADMIN MASTER HISAB EDIT (સંપૂર્ણ હિસાબ એડિટર - સર્વ તારીખો)
  // =========================================================================
  adminMasterRecord: null,
  adminMasterDate: null,
  adminMasterEditMode: false,

  adminEnableMasterEdit() {
    this.adminMasterEditMode = true;
    this.adminRenderMasterHisabUI();
  },

  adminCancelMasterEdit() {
    this.adminMasterEditMode = false;
    this.adminLoadMasterHisab(this.adminMasterDate);
  },

  adminLockDateAgain() {
    this.adminUnlockedDate = null;
    this.renderRecord();
    this.updateDateControlsState();
  },

  adminLoadMasterYesterday() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yStr = d.toISOString().split('T')[0];
    const dateInput = document.getElementById('admin-master-date-input');
    if (dateInput) dateInput.value = yStr;
    this.adminLoadMasterHisab(yStr);
  },

  async adminLoadMasterHisab(targetDate = null) {
    this.adminMasterEditMode = false;
    const dateInput = document.getElementById('admin-master-date-input');
    const d = targetDate || (dateInput ? dateInput.value : '') || this.currentDate;
    if (!d) return;
    if (dateInput) dateInput.value = d;
    this.adminMasterDate = d;

    const container = document.getElementById('admin-master-hisab-content');
    if (container) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: #64748b; background: #f8fafc; border: 1.5px dashed #cbd5e1; border-radius: 12px;">
          <div style="font-size: 2rem; animation: spin 1s infinite linear; display: inline-block;">⏳</div>
          <div style="font-weight: 800; font-size: 1.05rem; color: #1e293b; margin-top: 8px;">તારીખ ${d} નો હિસાબ લોડ થઈ રહ્યો છે...</div>
        </div>
      `;
    }

    try {
      const res = await fetch(`/api/records/${d}`);
      const data = await res.json();
      this.adminMasterRecord = JSON.parse(JSON.stringify(data));

      if (!Array.isArray(this.adminMasterRecord.notes)) this.adminMasterRecord.notes = [];
      if (!Array.isArray(this.adminMasterRecord.banks)) this.adminMasterRecord.banks = [];
      if (!Array.isArray(this.adminMasterRecord.vouchers)) this.adminMasterRecord.vouchers = [];
      if (!Array.isArray(this.adminMasterRecord.expenseItems)) this.adminMasterRecord.expenseItems = [];

      this.adminRenderMasterHisabUI();
    } catch (e) {
      console.error('Error loading master hisab:', e);
      if (container) {
        container.innerHTML = `<div style="color: #dc2626; padding: 20px; font-weight: 800;">❌ હિસાબ લોડ કરવામાં ભૂલ આવી. ફરી પ્રયાસ કરો.</div>`;
      }
    }
  },

  adminRenderMasterHisabUI() {
    const container = document.getElementById('admin-master-hisab-content');
    const rec = this.adminMasterRecord;
    if (!container || !rec) return;

    const cashTotal = (rec.notes || []).reduce((s, n) => s + (Number(n.note) * Number(n.count || 0)), 0);
    const bankTotal = (rec.banks || []).reduce((s, b) => s + (Number(b.amount) || 0), 0);
    const voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
    const grandTotal = cashTotal + bankTotal + voucherTotal;
    const isToday = this.adminMasterDate === this.getTodayDateStr();

    container.innerHTML = `
      <div style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 18px; box-shadow: 0 4px 16px rgba(0,0,0,0.04);">
        
        <!-- 4 Top KPI Stat Cards -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 16px;">
          <!-- Card 1: Grand Total -->
          <div style="background: linear-gradient(135deg, #2563eb 0%, #3b82f6 60%, #60a5fa 100%); color: #ffffff; padding: 14px 18px; border-radius: 12px; box-shadow: 0 4px 14px rgba(37, 99, 235, 0.22); display: flex; flex-direction: column; justify-content: space-between;">
            <span style="font-size: 0.85rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.95;">🌟 ગ્રાન્ડ ટોટલ</span>
            <div style="font-size: 1.65rem; font-weight: 900; margin-top: 6px; font-family: var(--font-heading);" id="admin-master-disp-grand">₹ ${grandTotal.toLocaleString('en-IN')}</div>
          </div>

          <!-- Card 2: Cash Total -->
          <div style="background: #fffbeb; border: 1.5px solid #fde68a; padding: 14px 18px; border-radius: 12px; box-shadow: 0 2px 8px rgba(245, 158, 11, 0.08);">
            <span style="font-size: 0.85rem; font-weight: 800; color: #78350f;">💵 રોકડ નોટો</span>
            <div style="font-size: 1.5rem; font-weight: 900; color: #b45309; margin-top: 6px; font-family: var(--font-heading);" id="admin-master-disp-cash">₹ ${cashTotal.toLocaleString('en-IN')}</div>
          </div>

          <!-- Card 3: Bank Total -->
          <div style="background: #f0fdf4; border: 1.5px solid #bbf7d0; padding: 14px 18px; border-radius: 12px; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.08);">
            <span style="font-size: 0.85rem; font-weight: 800; color: #14532d;">🏦 બેંક ખાતાઓ</span>
            <div style="font-size: 1.5rem; font-weight: 900; color: #15803d; margin-top: 6px; font-family: var(--font-heading);" id="admin-master-disp-bank">₹ ${bankTotal.toLocaleString('en-IN')}</div>
          </div>

          <!-- Card 4: Voucher Total -->
          <div style="background: #eff6ff; border: 1.5px solid #bfdbfe; padding: 14px 18px; border-radius: 12px; box-shadow: 0 2px 8px rgba(59, 130, 246, 0.08);">
            <span style="font-size: 0.85rem; font-weight: 800; color: #2563eb;">🧾 વાઉચર ખર્ચ</span>
            <div style="font-size: 1.5rem; font-weight: 900; color: #2563eb; margin-top: 6px; font-family: var(--font-heading);" id="admin-master-disp-voucher">₹ ${voucherTotal.toLocaleString('en-IN')}</div>
          </div>
        </div>

        <!-- Date Context & Action Toolbar -->
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 10px 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 16px;">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <span style="font-size: 1.15rem; font-weight: 900; color: #0f172a;">📅 તારીખ: ${this.adminMasterDate}</span>
            ${this.adminMasterEditMode ? `
              <span style="font-size: 0.78rem; font-weight: 800; padding: 3px 10px; border-radius: 12px; background: #fef3c7; color: #92400e; border: 1px solid #fcd34d;">
                ✏️ એડિટ મોડ ચાલુ છે
              </span>
            ` : ''}
          </div>

          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            ${!this.adminMasterEditMode ? `
              <button type="button" class="btn-primary" onclick="App.adminEnableMasterEdit()" style="background: linear-gradient(135deg, #2563eb, #1d4ed8); font-weight: 800; font-size: 0.92rem; padding: 8px 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(37,99,235,0.25);">
                <span>✏️</span> <span>એડિટ કરો</span>
              </button>
            ` : `
              <button type="button" class="btn-success" onclick="App.adminSaveMasterHisab()" style="font-weight: 800; font-size: 0.92rem; padding: 8px 22px; border-radius: 8px; background: linear-gradient(135deg, #059669, #10b981); box-shadow: 0 2px 8px rgba(16,185,129,0.25);">
                <span>💾</span> <span>સાચવો</span>
              </button>
              <button type="button" class="btn-icon" onclick="App.adminCancelMasterEdit()" style="background: #ffffff; border: 1.5px solid #cbd5e1; font-weight: 800; font-size: 0.88rem; padding: 7px 14px; border-radius: 8px;">
                <span>✕</span> <span>રદ કરો</span>
              </button>
            `}
          </div>
        </div>

        <!-- 3 Pillars Grid (Cash, Bank, Voucher) -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 16px; margin-bottom: 18px;">
          
          <!-- Column 1: Cash Notes -->
          <div style="background: #fafaf9; border: 1.5px solid #e7e5e4; border-radius: 10px; padding: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #e7e5e4;">
              <h5 style="margin: 0; font-size: 0.95rem; font-weight: 800; color: #78350f;">💵 રોકડ નોટોની સંખ્યા</h5>
              <span style="font-weight: 900; color: #b45309; font-size: 0.95rem;">કુલ: ₹ ${cashTotal.toLocaleString('en-IN')}</span>
            </div>
            <div style="display: grid; grid-template-columns: 1fr; gap: 8px; max-height: 290px; overflow-y: auto; padding-right: 4px;">
              ${(this.activeNotes || [500, 200, 100, 50, 20, 10, 5]).map(val => {
      const existing = (rec.notes || []).find(n => Number(n.note) === val);
      const cnt = existing ? existing.count : 0;
      const lineTotal = val * cnt;
      return `
                  <div style="display: flex; align-items: center; justify-content: space-between; background: #ffffff; border: 1px solid #e7e5e4; padding: 6px 10px; border-radius: 8px;">
                    <div style="display: flex; align-items: center; gap: 6px; width: 80px;">
                      <span style="font-weight: 900; font-size: 0.9rem; color: #292524;">₹ ${val}</span>
                      <span style="color: #a8a29e; font-size: 0.8rem;">×</span>
                    </div>
                    <input type="number" min="0" value="${cnt}" ${!this.adminMasterEditMode ? 'disabled' : ''} class="input-text" style="width: 75px; padding: 4px 6px; font-weight: 800; text-align: right; ${!this.adminMasterEditMode ? 'background: #f8fafc; color: #64748b; cursor: not-allowed; border-color: #e2e8f0;' : 'background: #ffffff; border-color: #3b82f6;'}" oninput="App.onAdminMasterNoteInput(${val}, this.value)">
                    <span style="font-weight: 800; font-size: 0.85rem; color: #78350f; min-width: 80px; text-align: right;">= ₹ ${lineTotal.toLocaleString('en-IN')}</span>
                  </div>
                `;
    }).join('')}
            </div>
          </div>

          <!-- Column 2: Banks -->
          <div style="background: #f0fdf4; border: 1.5px solid #bbf7d0; border-radius: 10px; padding: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #bbf7d0;">
              <h5 style="margin: 0; font-size: 0.95rem; font-weight: 800; color: #14532d;">🏦 બેંક ખાતાઓ</h5>
              <span style="font-weight: 900; color: #15803d; font-size: 0.95rem;">કુલ: ₹ ${bankTotal.toLocaleString('en-IN')}</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px; max-height: 290px; overflow-y: auto; padding-right: 4px;">
              ${(this.fixedBanks || ['IOB', 'BOB', 'SBI']).map(bName => {
      const existing = (rec.banks || []).find(b => b.name === bName);
      const amt = existing ? existing.amount : 0;
      return `
                  <div style="display: flex; align-items: center; justify-content: space-between; background: #ffffff; border: 1px solid #86efac; padding: 6px 10px; border-radius: 8px;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                      <span style="font-size: 0.9rem;">🏦</span>
                      <span style="font-weight: 900; font-size: 0.88rem; color: #14532d; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: 0.3px;">${bName}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                      <span style="font-size: 0.85rem; color: #64748b; font-weight: 700;">₹</span>
                      <input type="number" min="0" value="${amt}" ${!this.adminMasterEditMode ? 'disabled' : ''} class="input-text" style="width: 110px; padding: 4px 6px; font-weight: 800; text-align: right; ${!this.adminMasterEditMode ? 'background: #f8fafc; color: #64748b; cursor: not-allowed; border-color: #e2e8f0;' : 'background: #ffffff; border-color: #10b981;'}" oninput="App.onAdminMasterBankInput('${bName}', this.value)">
                    </div>
                  </div>
                `;
    }).join('')}
            </div>
          </div>

          <!-- Column 3: Vouchers -->
          <div style="background: #eff6ff; border: 1.5px solid #bfdbfe; border-radius: 10px; padding: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #bfdbfe;">
              <h5 style="margin: 0; font-size: 0.95rem; font-weight: 800; color: #1e3a8a;">🧾 મુખ્ય વાઉચરો</h5>
              <span style="font-weight: 900; color: #1d4ed8; font-size: 0.95rem;">કુલ: ₹ ${voucherTotal.toLocaleString('en-IN')}</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px; max-height: 290px; overflow-y: auto; padding-right: 4px;">
              ${(this.fixedVouchers || ['Mandir kharch', 'Rasoda kharch', 'Pagar']).map(vName => {
      const existing = (rec.vouchers || []).find(v => v.name === vName);
      const amt = existing ? existing.amount : 0;
      return `
                  <div style="display: flex; align-items: center; justify-content: space-between; background: #ffffff; border: 1px solid #93c5fd; padding: 6px 10px; border-radius: 8px;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                      <span style="font-size: 0.9rem;">🧾</span>
                      <span style="font-weight: 900; font-size: 0.88rem; color: #1e40af;">${this.getKhataNameInGujarati(vName)}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                      <span style="font-size: 0.85rem; color: #64748b; font-weight: 700;">₹</span>
                      <input type="number" min="0" value="${amt}" ${!this.adminMasterEditMode ? 'disabled' : ''} class="input-text" style="width: 110px; padding: 4px 6px; font-weight: 800; text-align: right; ${!this.adminMasterEditMode ? 'background: #f8fafc; color: #64748b; cursor: not-allowed; border-color: #e2e8f0;' : 'background: #ffffff; border-color: #6366f1;'}" oninput="App.onAdminMasterVoucherInput('${vName}', this.value)">
                    </div>
                  </div>
                `;
    }).join('')}
            </div>
          </div>
        </div>

        <!-- Section 4: Detailed Expense Diary List for this Date -->
        <div style="background: #fafaf9; border: 1.5px solid #e2e8f0; border-radius: 10px; padding: 14px; margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <h5 style="margin: 0; font-size: 0.95rem; font-weight: 800; color: #1e293b;">📝 આ તારીખના ખર્ચ ડાયરી વાઉચરો</h5>
              <span style="font-size: 0.78rem; font-weight: 800; background: #e2e8f0; color: #475569; padding: 2px 8px; border-radius: 10px;">
                ${(rec.expenseItems || []).length} નોંધો
              </span>
            </div>
            ${this.adminMasterEditMode ? `
              <button type="button" class="btn-primary" onclick="App.openAdminAddExpenseModal('${this.adminMasterDate}')" style="font-size: 0.82rem; padding: 6px 14px; background: linear-gradient(135deg, #2563eb, #1d4ed8); font-weight: 800; border-radius: 8px;">
                <span>➕</span> <span>આ તારીખમાં નવો ખર્ચ લખો</span>
              </button>
            ` : ''}
          </div>

          <div style="max-height: 220px; overflow-y: auto; border: 1px solid #cbd5e1; border-radius: 8px; background: #ffffff;">
            <table class="table-hisab" style="font-size: 0.85rem;">
              <thead>
                <tr>
                  <th style="width: 40px;">#</th>
                  <th>ખર્ચ વિગત</th>
                  <th style="width: 130px;">ખાતો</th>
                  <th style="width: 110px; text-align: right;">રકમ (₹)</th>
                  <th>નામ</th>
                  <th style="width: 90px; text-align: center;">સુધારો / કાઢો</th>
                </tr>
              </thead>
              <tbody>
                ${(rec.expenseItems && rec.expenseItems.length > 0) ? rec.expenseItems.map((item, idx) => `
                  <tr>
                    <td>${idx + 1}</td>
                    <td style="font-weight: 800; color: #0f172a;">${item.title}</td>
                    <td><span class="denom-badge denom-100" style="padding: 2px 7px; font-size: 0.75rem;">${this.getKhataNameInGujarati(item.category)}</span></td>
                    <td style="text-align: right; font-weight: 900; color: #b91c1c;">₹ ${(item.amount || 0).toLocaleString('en-IN')}</td>
                    <td style="color: #64748b;">${item.remarks || '-'}</td>
                    <td style="text-align: center;">
                      ${this.adminMasterEditMode ? `
                        <div style="display: flex; gap: 4px; justify-content: center;">
                          <button type="button" class="btn-icon" style="padding: 3px 6px; font-size: 0.8rem; color: #2563eb;" onclick="App.openEditExpenseItemModal('${item.id}', '${this.adminMasterDate}', 'admin')" title="સુધારો">✏️</button>
                          <button type="button" class="btn-icon" style="padding: 3px 6px; font-size: 0.8rem; color: #ef4444;" onclick="App.deleteExpenseItemDirect('${item.id}', '${this.adminMasterDate}', 'admin')" title="કાઢી નાખો">🗑️</button>
                        </div>
                      ` : `<span style="color: #94a3b8; font-weight: 700;">-</span>`}
                    </td>
                  </tr>
                `).join('') : `
                  <tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 20px; font-weight: 700;">આ તારીખમાં કોઈ અલગ ખર્ચ ડાયરી નોંધ નથી.</td></tr>
                `}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Remarks -->
        <div style="margin-bottom: 10px;">
          <label style="font-weight: 800; font-size: 0.88rem; color: #334155; display: block; margin-bottom: 6px;">📝 દૈનિક નોંધ / રીમાર્ક્સ:</label>
          <input type="text" id="admin-master-remarks-input" class="input-text auto-gujarati" value="${rec.remarks || ''}" ${!this.adminMasterEditMode ? 'disabled' : ''} style="${!this.adminMasterEditMode ? 'background: #f8fafc; color: #64748b; cursor: not-allowed; border-color: #e2e8f0;' : 'background: #ffffff; border-color: #3b82f6;'}" placeholder="આ તારીખ માટે કોઈ નોંધ લખો...">
        </div>
      </div>
      </div>
    `;

    if (window.GujaratiTyping) window.GujaratiTyping.init();
  },

  onAdminMasterNoteInput(noteVal, countVal) {
    if (!this.adminMasterRecord) return;
    const notes = this.adminMasterRecord.notes || [];
    let entry = notes.find(n => Number(n.note) === Number(noteVal));
    const cnt = Math.max(0, parseInt(countVal, 10) || 0);
    if (!entry) {
      entry = { note: Number(noteVal), count: cnt, amount: Number(noteVal) * cnt };
      notes.push(entry);
    } else {
      entry.count = cnt;
      entry.amount = Number(noteVal) * cnt;
    }
    this.adminMasterRecord.notes = notes;
    this.adminRecalcMasterTotals();
  },

  onAdminMasterBankInput(bName, amtVal) {
    if (!this.adminMasterRecord) return;
    const banks = this.adminMasterRecord.banks || [];
    let entry = banks.find(b => b.name === bName);
    const amt = Math.max(0, Number(amtVal) || 0);
    if (!entry) {
      entry = { name: bName, amount: amt };
      banks.push(entry);
    } else {
      entry.amount = amt;
    }
    this.adminMasterRecord.banks = banks;
    this.adminRecalcMasterTotals();
  },

  onAdminMasterVoucherInput(vName, amtVal) {
    if (!this.adminMasterRecord) return;
    const vouchers = this.adminMasterRecord.vouchers || [];
    let entry = vouchers.find(v => v.name === vName);
    const amt = Math.max(0, Number(amtVal) || 0);
    if (!entry) {
      entry = { name: vName, amount: amt };
      vouchers.push(entry);
    } else {
      entry.amount = amt;
    }
    this.adminMasterRecord.vouchers = vouchers;
    this.adminRecalcMasterTotals();
  },

  adminRecalcMasterTotals() {
    const rec = this.adminMasterRecord;
    if (!rec) return;
    const cashTotal = (rec.notes || []).reduce((s, n) => s + (Number(n.note) * Number(n.count || 0)), 0);
    const bankTotal = (rec.banks || []).reduce((s, b) => s + (Number(b.amount) || 0), 0);
    const voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
    const grandTotal = cashTotal + bankTotal + voucherTotal;

    const dispCash = document.getElementById('admin-master-disp-cash');
    const dispBank = document.getElementById('admin-master-disp-bank');
    const dispVoucher = document.getElementById('admin-master-disp-voucher');
    const dispGrand = document.getElementById('admin-master-disp-grand');

    if (dispCash) dispCash.textContent = `₹ ${cashTotal.toLocaleString('en-IN')}`;
    if (dispBank) dispBank.textContent = `₹ ${bankTotal.toLocaleString('en-IN')}`;
    if (dispVoucher) dispVoucher.textContent = `₹ ${voucherTotal.toLocaleString('en-IN')}`;
    if (dispGrand) dispGrand.textContent = `₹ ${grandTotal.toLocaleString('en-IN')}`;
  },

  async adminSaveMasterHisab() {
    if (!this.adminMasterRecord || !this.adminMasterDate) return;
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const targetDate = this.adminMasterDate;
    const remInput = document.getElementById('admin-master-remarks-input');
    if (remInput) {
      this.adminMasterRecord.remarks = remInput.value.trim();
    }

    try {
      const res = await fetch(`/api/records/${targetDate}`, {
        method: 'POST',
        headers: this.getAdminAuthHeaders({ 'x-admin-override': 'true' }),
        body: JSON.stringify({
          ...this.adminMasterRecord,
          adminOverride: true
        })
      });

      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;
      if (res.ok && data.success) {
        this.showToast(isEn ? `✅ Record of date ${targetDate} saved successfully!` : `✅ તારીખ ${targetDate} નો સંપૂર્ણ હિસાબ સફળતાપૂર્વક સાચવાઈ ગયો!`, 'success');
        if (this.currentDate === targetDate) {
          await this.loadDate(targetDate);
        }
        await this.adminLoadMasterHisab(targetDate);
      } else {
        this.showToast(data.error || (isEn ? 'Error saving record' : 'હિસાબ સાચવવામાં ભૂલ આવી'), 'error');
      }
    } catch (e) {
      console.error('Error saving admin master hisab:', e);
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  adminUnlockDateOnMainScreen(dateStr) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    this.adminUnlockedDate = dateStr;
    this.switchMainView('daily');
    this.setDateAndLoad(dateStr);
    this.showToast(isEn ? `🔓 Date ${dateStr} record unlocked on main screen!` : `🔓 તારીખ ${dateStr} નો હિસાબ મુખ્ય સ્ક્રીન પર અનલૉક થઈ ગયો છે!`, 'warning');
  },

  openAdminAddExpenseModal(dateStr) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const targetDate = dateStr || this.adminMasterDate || this.currentDate;
    const modal = document.getElementById('modal-admin-add-expense');
    if (!modal) return;

    const dateInp = document.getElementById('admin-add-exp-date');
    const titleInp = document.getElementById('admin-add-exp-title');
    const amtInp = document.getElementById('admin-add-exp-amount');
    const catSelect = document.getElementById('admin-add-exp-category');
    const remInp = document.getElementById('admin-add-exp-remarks');
    const headerTitle = document.getElementById('admin-add-exp-modal-title');

    if (dateInp) dateInp.value = targetDate;
    if (titleInp) titleInp.value = '';
    if (amtInp) amtInp.value = '';
    if (remInp) remInp.value = '';
    if (headerTitle) headerTitle.textContent = isEn ? `➕ Add New Expense to Date (${targetDate})` : `➕ આ તારીખમાં નવો ખર્ચ ઉમેરો (${targetDate})`;

    if (catSelect) {
      catSelect.innerHTML = '';
      (this.fixedVouchers || ['MANDIRKHARCH', 'RASODAKHARCH', 'PAGAR', 'UPAD']).forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = `🧾 ${this.getKhataNameInGujarati(v)}`;
        catSelect.appendChild(opt);
      });
    }

    this.renderExpenseNameSuggestions();
    this.openModal('modal-admin-add-expense', { isChild: true });
    setTimeout(() => { if (titleInp) titleInp.focus(); }, 100);
  },

  async submitAdminAddExpense(e) {
    e.preventDefault();
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const date = document.getElementById('admin-add-exp-date')?.value || this.adminMasterDate;
    const title = (document.getElementById('admin-add-exp-title')?.value || '').trim();
    const amount = Number(document.getElementById('admin-add-exp-amount')?.value) || 0;
    const category = document.getElementById('admin-add-exp-category')?.value;
    const remarks = (document.getElementById('admin-add-exp-remarks')?.value || '').trim();

    if (!title) {
      this.showToast(isEn ? 'Please enter expense detail' : 'કૃપા કરીને ખર્ચ વિગત લખો', 'error');
      return;
    }
    if (amount <= 0) {
      this.showToast(isEn ? 'Please enter valid amount' : 'કૃપા કરીને સાચી રકમ લખો', 'error');
      return;
    }
    if (!category) {
      this.showToast(isEn ? 'Please select voucher account' : 'કૃપા કરીને વાઉચર ખાતો પસંદ કરો', 'error');
      return;
    }

    try {
      const res = await fetch(`/api/records/${date}`);
      const rec = await res.json();
      if (!Array.isArray(rec.expenseItems)) rec.expenseItems = [];
      if (!Array.isArray(rec.vouchers)) rec.vouchers = [];

      const now = new Date();
      const timeStr = this.getCurrentTimeStr();

      const newItem = {
        id: 'exp_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        time: timeStr,
        title: title,
        amount: amount,
        category: category,
        categoryType: 'voucher',
        employeeId: null,
        employeeName: null,
        forMonth: date.slice(0, 7),
        remarks: remarks
      };

      rec.expenseItems.unshift(newItem);

      // Auto-update vouchers table for this specific date
      let vEntry = rec.vouchers.find(v => (v.name || '').trim().toUpperCase() === category.trim().toUpperCase());
      if (vEntry) {
        vEntry.amount = (Number(vEntry.amount) || 0) + amount;
      } else {
        rec.vouchers.push({ name: category.trim(), amount: amount });
      }

      rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
      rec.grandTotal = (Number(rec.cashTotal) || 0) + (Number(rec.bankTotal) || 0) + rec.voucherTotal;

      const saveRes = await fetch(`/api/records/${date}`, {
        method: 'POST',
        headers: this.getAdminAuthHeaders({ 'x-admin-override': 'true' }),
        body: JSON.stringify({
          ...rec,
          adminOverride: true
        })
      });

      const saveData = await saveRes.json();
      if (this.handleAdminAuthError(saveRes, saveData)) return;
      if (saveRes.ok && saveData.success) {
        this.registerNewExpenseName(remarks);
        this.closeModal('modal-admin-add-expense');
        this.showToast(isEn ? `✅ Added expense "${title}" (₹${amount.toLocaleString('en-IN')}) to date ${date}!` : `✅ તારીખ ${date} માં "${title}" (₹${amount.toLocaleString('en-IN')}) ખર્ચ ઉમેરાઈ ગયો!`, 'success');

        // Refresh admin master hisab for this date
        await this.adminLoadMasterHisab(date);

        // If this date happened to be today, sync daily record
        if (this.currentDate === date) {
          await this.loadDate(date);
        }
        this.notifyDataChanged('admin_expense_added', date);
      } else {
        this.showToast(saveData.error || (isEn ? 'Error adding expense' : 'ખર્ચ ઉમેરવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error adding admin expense item:', err);
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  openEditExpenseItemModal(id, date, source = 'register') {
    const editIdInp = document.getElementById('edit-exp-id');
    const editDateInp = document.getElementById('edit-exp-date');
    const editTitleInp = document.getElementById('edit-exp-title');
    const editAmtInp = document.getElementById('edit-exp-amount');
    const editCatSelect = document.getElementById('edit-exp-category');
    const editRemInp = document.getElementById('edit-exp-remarks');
    const origAmtInp = document.getElementById('edit-exp-orig-amount');
    const origCatInp = document.getElementById('edit-exp-orig-category');
    const sourceInp = document.getElementById('edit-exp-source');

    if (!editIdInp || !editTitleInp) return;

    let targetItem = null;
    if (this.currentExpenseReport && this.currentExpenseReport.expenses) {
      targetItem = this.currentExpenseReport.expenses.find(x => x.id === id);
    }
    if (!targetItem && this.record && this.record.expenseItems) {
      targetItem = this.record.expenseItems.find(x => x.id === id);
    }
    if (!targetItem && this.adminMasterRecord && this.adminMasterRecord.expenseItems) {
      targetItem = this.adminMasterRecord.expenseItems.find(x => x.id === id);
    }
    if (!targetItem) {
      this.showToast('ખર્ચ એન્ટ્રી મળી નથી', 'error');
      return;
    }

    editIdInp.value = id;
    editDateInp.value = date;
    editTitleInp.value = targetItem.title || '';
    editAmtInp.value = targetItem.amount || '';
    editRemInp.value = targetItem.remarks || '';
    origAmtInp.value = targetItem.amount || 0;
    origCatInp.value = targetItem.category || '';
    sourceInp.value = source;

    editCatSelect.innerHTML = '';
    const allCats = new Set([...(this.fixedVouchers || []), 'Mandir kharch', 'Rasoda kharch', 'Pagar', 'Upad']);
    if (targetItem.category) allCats.add(targetItem.category);
    allCats.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = `🧾 ${this.getKhataNameInGujarati(c)}`;
      if (c === targetItem.category) opt.selected = true;
      editCatSelect.appendChild(opt);
    });

    this.renderExpenseNameSuggestions();
    this.openModal('modal-edit-expense-item', { isChild: true });

    setTimeout(() => {
      if (editTitleInp) editTitleInp.focus();
    }, 100);
  },

  async submitEditExpenseItem(e) {
    e.preventDefault();
    const id = document.getElementById('edit-exp-id').value;
    const date = document.getElementById('edit-exp-date').value;
    const title = document.getElementById('edit-exp-title').value.trim();
    const newAmt = Number(document.getElementById('edit-exp-amount').value) || 0;
    const newCat = document.getElementById('edit-exp-category').value;
    const remarks = document.getElementById('edit-exp-remarks').value.trim();
    const origAmt = Number(document.getElementById('edit-exp-orig-amount').value) || 0;
    const origCat = document.getElementById('edit-exp-orig-category').value;
    const source = document.getElementById('edit-exp-source').value;

    if (!title) {
      this.showToast('ખર્ચ વિગત લખો', 'error');
      return;
    }
    if (newAmt <= 0) {
      this.showToast('સાચી રકમ લખો', 'error');
      return;
    }

    const isPast = (date < this.getTodayDateStr());

    try {
      const res = await fetch(`/api/records/${date}`);
      const rec = await res.json();
      if (!Array.isArray(rec.expenseItems)) rec.expenseItems = [];
      if (!Array.isArray(rec.vouchers)) rec.vouchers = [];

      const itemIdx = rec.expenseItems.findIndex(x => x.id === id);
      if (itemIdx === -1) {
        this.showToast('ખર્ચ એન્ટ્રી મળી નથી', 'error');
        return;
      }

      const editedItem = rec.expenseItems[itemIdx];
      editedItem.title = title;
      editedItem.amount = newAmt;
      editedItem.category = newCat;
      editedItem.remarks = remarks;

      // Handle employee ledger update if item was linked to an employee
      if (editedItem.employeeId) {
        try {
          const empRes = await fetch('/api/employees');
          const empData = await empRes.json();
          const empList = Array.isArray(empData) ? empData : (empData.employees || []);
          const emp = (empList || []).find(e => e.id === editedItem.employeeId);
          if (emp) {
            let empChanged = false;
            const isNewPagar = (newCat || '').toUpperCase().includes('PAGAR');
            const isNewUpad = (newCat || '').toUpperCase().includes('UPAD');

            // Find and remove existing entry in pagars or upads
            let existingEntry = null;
            let existingType = null;
            if (Array.isArray(emp.pagars)) {
              const pIdx = emp.pagars.findIndex(p => (editedItem.employeeEntryId && p.id === editedItem.employeeEntryId) || (p.date === date && Number(p.amount) === origAmt));
              if (pIdx !== -1) {
                existingEntry = emp.pagars.splice(pIdx, 1)[0];
                existingType = 'pagar';
                empChanged = true;
              }
            }
            if (!existingEntry && Array.isArray(emp.upads)) {
              const uIdx = emp.upads.findIndex(u => (editedItem.employeeEntryId && u.id === editedItem.employeeEntryId) || (u.date === date && Number(u.amount) === origAmt));
              if (uIdx !== -1) {
                existingEntry = emp.upads.splice(uIdx, 1)[0];
                existingType = 'upad';
                empChanged = true;
              }
            }

            // Now re-assign to new category if PAGAR or UPAD
            if (isNewPagar) {
              if (!Array.isArray(emp.pagars)) emp.pagars = [];
              const entryToSave = {
                ...(existingEntry || {}),
                id: (existingEntry && existingType === 'pagar') ? existingEntry.id : ('pgr_' + Date.now() + '_' + Math.floor(Math.random() * 1000)),
                date: date,
                amount: newAmt,
                title: title,
                remarks: remarks,
                forMonth: (existingEntry && existingEntry.forMonth) || date.slice(0, 7)
              };
              emp.pagars.unshift(entryToSave);
              editedItem.employeeEntryId = entryToSave.id;
              empChanged = true;
            } else if (isNewUpad) {
              if (!Array.isArray(emp.upads)) emp.upads = [];
              const entryToSave = {
                ...(existingEntry || {}),
                id: (existingEntry && existingType === 'upad') ? existingEntry.id : ('upd_' + Date.now() + '_' + Math.floor(Math.random() * 1000)),
                date: date,
                amount: newAmt,
                title: title,
                remarks: remarks,
                forMonth: (existingEntry && existingEntry.forMonth) || date.slice(0, 7)
              };
              emp.upads.unshift(entryToSave);
              editedItem.employeeEntryId = entryToSave.id;
              empChanged = true;
            } else {
              // Changed to another category, clear staff link
              editedItem.employeeEntryId = null;
            }

            if (empChanged) {
              await fetch(`/api/employees/${emp.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(emp)
              });
            }
          }
        } catch (e) {
          console.warn('Could not sync employee ledger on edit:', e);
        }
      }

      // Recalculate all voucher amounts strictly from rec.expenseItems
      const catSums = {};
      (rec.expenseItems || []).forEach(it => {
        const c = (it.category || '').trim().toUpperCase();
        catSums[c] = (catSums[c] || 0) + (Number(it.amount) || 0);
      });
      (rec.vouchers || []).forEach(v => {
        const k = (v.name || '').trim().toUpperCase();
        v.amount = catSums[k] || 0;
      });

      // Ensure new category exists in vouchers array
      const newCatKey = (newCat || '').trim().toUpperCase();
      if (!rec.vouchers.some(v => (v.name || '').trim().toUpperCase() === newCatKey)) {
        rec.vouchers.push({ name: newCat.trim(), amount: catSums[newCatKey] || 0 });
      }

      rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
      rec.grandTotal = (Number(rec.cashTotal) || 0) + (Number(rec.bankTotal) || 0) + rec.voucherTotal;

      const saveRes = await fetch(`/api/records/${date}`, {
        method: 'POST',
        headers: this.getAdminAuthHeaders(isPast ? { 'x-admin-override': 'true' } : {}),
        body: JSON.stringify({
          ...rec,
          adminOverride: isPast
        })
      });

      const saveData = await saveRes.json();
      if (this.handleAdminAuthError(saveRes, saveData)) return;
      const isEn = window.i18n && window.i18n.currentLang === 'en';
      if (saveRes.ok && saveData.success) {
        this.registerNewExpenseName(remarks);
        this.closeModal('modal-edit-expense-item');
        this.showToast(isEn ? `✅ Expense "${title}" (₹${newAmt.toLocaleString('en-IN')}) updated!` : `✅ ખર્ચ "${title}" (₹${newAmt.toLocaleString('en-IN')}) સુધારી લેવાયો!`, 'success');

        if (this.currentDate === date) {
          await this.loadDate(date);
          if (document.getElementById('modal-expense-diary')?.classList.contains('active')) {
            this.renderExpenseDiary();
          }
        }
        if (source === 'admin' && this.adminMasterDate === date) {
          await this.adminLoadMasterHisab(date);
        }
        if (this.currentView === 'expenses') {
          await this.applyExpenseFilter();
        }
        if (editedItem.employeeId) {
          await this.loadEmployees(this.employeeMonthFilter);
        }
        this.notifyDataChanged('expense_updated', date);
      } else {
        this.showToast(saveData.error || (isEn ? 'Error saving changes' : 'સુધારો સાચવવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error updating expense item:', err);
      const isEn = window.i18n && window.i18n.currentLang === 'en';
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  async deleteExpenseItemDirect(id, date, source = 'register') {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (!confirm(isEn ? 'Are you sure you want to permanently delete this expense? This will also be deducted from the voucher total.' : 'શું તમે આ ખર્ચ કાયમી ધોરણે કાઢી નાખવા માંગો છો? આ વાઉચર હિસાબમાંથી પણ બાદ થશે.')) return;

    const isPast = (date < this.getTodayDateStr());

    try {
      const res = await fetch(`/api/records/${date}`);
      const rec = await res.json();
      if (!Array.isArray(rec.expenseItems)) rec.expenseItems = [];
      if (!Array.isArray(rec.vouchers)) rec.vouchers = [];

      const itemIdx = rec.expenseItems.findIndex(x => x.id === id);
      if (itemIdx === -1) {
        this.showToast(isEn ? 'Expense entry not found' : 'ખર્ચ એન્ટ્રી મળી નથી', 'error');
        return;
      }

      const item = rec.expenseItems[itemIdx];
      const amt = Number(item.amount) || 0;
      const cat = item.category || '';

      rec.expenseItems.splice(itemIdx, 1);

      // Handle employee ledger cleanup if any
      if (item.employeeId) {
        try {
          const empRes = await fetch('/api/employees');
          const empData = await empRes.json();
          const empList = Array.isArray(empData) ? empData : (empData.employees || []);
          const emp = (empList || []).find(e => e.id === item.employeeId);
          if (emp) {
            let empChanged = false;
            if (Array.isArray(emp.pagars)) {
              const pIdx = emp.pagars.findIndex(p =>
                (p.expenseItemId && (p.expenseItemId === item.id || p.expenseItemId === ('exp_' + p.id))) ||
                (item.id && (item.id === ('exp_' + p.id) || item.id === p.id)) ||
                (item.employeeEntryId && p.id === item.employeeEntryId) ||
                (p.date === (item.date || date) && Number(p.amount) === Number(item.amount))
              );
              if (pIdx !== -1) {
                emp.pagars.splice(pIdx, 1);
                empChanged = true;
              }
            }
            if (Array.isArray(emp.upads)) {
              const uIdx = emp.upads.findIndex(u =>
                (u.expenseItemId && (u.expenseItemId === item.id || u.expenseItemId === ('exp_' + u.id))) ||
                (item.id && (item.id === ('exp_' + u.id) || item.id === u.id)) ||
                (item.employeeEntryId && u.id === item.employeeEntryId) ||
                (u.date === (item.date || date) && Number(u.amount) === Number(item.amount))
              );
              if (uIdx !== -1) {
                emp.upads.splice(uIdx, 1);
                empChanged = true;
              }
            }
            if (empChanged) {
              await fetch(`/api/employees/${emp.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(emp)
              });
              await this.loadEmployees(this.employeeMonthFilter);
            }
          }
        } catch (err) {
          console.warn('Could not sync employee ledger on delete:', err);
        }
      }

      // Recalculate voucher amounts strictly from remaining expenseItems
      const catSums = {};
      (rec.expenseItems || []).forEach(it => {
        const c = (it.category || '').trim().toUpperCase();
        catSums[c] = (catSums[c] || 0) + (Number(it.amount) || 0);
      });
      (rec.vouchers || []).forEach(v => {
        const k = (v.name || '').trim().toUpperCase();
        v.amount = catSums[k] || 0;
      });
      rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
      rec.grandTotal = (Number(rec.cashTotal) || 0) + (Number(rec.bankTotal) || 0) + rec.voucherTotal;

      const saveRes = await fetch(`/api/records/${date}`, {
        method: 'POST',
        headers: this.getAdminAuthHeaders(isPast ? { 'x-admin-override': 'true' } : {}),
        body: JSON.stringify({
          ...rec,
          adminOverride: isPast
        })
      });

      const saveData = await saveRes.json();
      if (this.handleAdminAuthError(saveRes, saveData)) return;
      if (saveRes.ok && saveData.success) {
        this.showToast(isEn ? `🗑️ Expense deleted and ₹${amt.toLocaleString('en-IN')} deducted from voucher` : `🗑️ ખર્ચ કાઢી નાખ્યો અને વાઉચરમાંથી ₹${amt.toLocaleString('en-IN')} બાદ કર્યા`, 'success');
        if (this.currentDate === date) {
          await this.loadDate(date);
          if (document.getElementById('modal-expense-diary')?.classList.contains('active')) {
            this.renderExpenseDiary();
          }
        }
        if (source === 'admin' && this.adminMasterDate === date) {
          await this.adminLoadMasterHisab(date);
        }
        if (this.currentView === 'expenses') {
          await this.applyExpenseFilter();
        }
        if (item.employeeId) {
          await this.loadEmployees(this.employeeMonthFilter);
        }
        this.notifyDataChanged('expense_deleted', date);
      } else {
        this.showToast(saveData.error || (isEn ? 'Error deleting' : 'કાઢવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error deleting expense item:', err);
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  // =========================================================================
  // EXPENSE DIARY & AUTO-ALLOCATION METHODS (ખર્ચ ડાયરી અને નામ સજેશન)
  // =========================================================================
  savedExpenseNames: [],

  async loadExpenseNameSuggestions() {
    try {
      const res = await fetch('/api/expenses/names');
      const data = await res.json();
      if (data && Array.isArray(data.names)) {
        this.savedExpenseNames = data.names;
      }
    } catch (e) {
      this.savedExpenseNames = this.savedExpenseNames || [];
    }
    this.renderExpenseNameSuggestions();
  },

  renderExpenseNameSuggestions() {
    let datalist = document.getElementById('expense-name-suggestions');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'expense-name-suggestions';
      document.body.appendChild(datalist);
    }

    const set = new Set(this.savedExpenseNames || []);
    if (this.record && Array.isArray(this.record.expenseItems)) {
      this.record.expenseItems.forEach(item => {
        if (item.remarks && typeof item.remarks === 'string' && item.remarks.trim()) {
          set.add(item.remarks.trim());
        }
      });
    }
    if (this.currentExpenseReport && Array.isArray(this.currentExpenseReport.expenses)) {
      this.currentExpenseReport.expenses.forEach(item => {
        if (item.remarks && typeof item.remarks === 'string' && item.remarks.trim()) {
          set.add(item.remarks.trim());
        }
      });
    }

    const sorted = Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b, 'gu'));
    datalist.innerHTML = sorted.map(name => `<option value="${name}">`).join('');
  },

  registerNewExpenseName(name) {
    if (!name || typeof name !== 'string') return;
    const clean = name.trim();
    if (!clean) return;
    if (!Array.isArray(this.savedExpenseNames)) this.savedExpenseNames = [];
    if (!this.savedExpenseNames.includes(clean)) {
      this.savedExpenseNames.push(clean);
    }
    this.renderExpenseNameSuggestions();
  },

  toggleHeaderMenu(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const menu = document.getElementById('header-dropdown-menu');
    const btn = document.getElementById('btn-header-more-menu');
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    if (isShown) {
      this.closeHeaderMenu();
    } else {
      menu.classList.add('show');
      if (btn) btn.classList.add('active');
    }
  },

  closeHeaderMenu() {
    const menu = document.getElementById('header-dropdown-menu');
    const btn = document.getElementById('btn-header-more-menu');
    if (menu) menu.classList.remove('show');
    if (btn) btn.classList.remove('active');
  },

  async openExpenseDiaryModal(preselectedCategory = null) {
    await this.flushPendingSave();
    if (!this.record) return;
    if (!Array.isArray(this.record.expenseItems)) {
      this.record.expenseItems = [];
    }

    if (!this.employeesList || this.employeesList.length === 0) {
      await this.loadEmployees();
    }

    // Populate category select dropdown - ONLY Expense Vouchers (ખર્ચ વાઉચરો)
    const sel = document.getElementById('expense-select-category');
    sel.innerHTML = '';

    const allCats = new Set();
    (this.fixedVouchers || []).forEach(v => allCats.add(v));
    if (this.record && Array.isArray(this.record.vouchers)) {
      this.record.vouchers.forEach(v => {
        if (v && v.name) allCats.add(v.name);
      });
    }

    allCats.forEach(v => {
      const opt = document.createElement('option');
      opt.value = `voucher:${v}`;
      opt.textContent = `🧾 ${this.getKhataNameInGujarati(v)}`;
      sel.appendChild(opt);
    });

    if (preselectedCategory) {
      const targetVal = `voucher:${preselectedCategory.trim()}`;
      for (let opt of sel.options) {
        if (opt.value.toUpperCase() === targetVal.toUpperCase() || opt.value.toUpperCase().includes(preselectedCategory.trim().toUpperCase())) {
          sel.value = opt.value;
          break;
        }
      }
    }

    // Default month input to current month or selected hisab month
    const defaultMonth = this.employeeMonthFilter || (this.currentDate ? this.currentDate.slice(0, 7) : new Date().toISOString().slice(0, 7));
    const mInput = document.getElementById('expense-select-month');
    if (mInput) {
      mInput.value = defaultMonth;
    }

    // Populate employees dropdown
    this.populateExpenseEmployeeDropdown();

    // Clear form inputs
    const isLocked = this.isCurrentDateLocked();
    const titleInp = document.getElementById('expense-input-title');
    const amtInp = document.getElementById('expense-input-amount');
    const remInp = document.getElementById('expense-input-remark');
    const catSel = document.getElementById('expense-select-category');
    const addBtn = document.getElementById('btn-add-expense-item');

    if (titleInp) { titleInp.value = ''; titleInp.disabled = isLocked; }
    if (amtInp) { amtInp.value = ''; amtInp.disabled = isLocked; }
    if (remInp) { remInp.value = ''; remInp.disabled = isLocked; }
    if (catSel) catSel.disabled = isLocked;
    if (addBtn) {
      addBtn.disabled = isLocked;
      addBtn.style.opacity = isLocked ? '0.5' : '1';
      addBtn.style.cursor = isLocked ? 'not-allowed' : 'pointer';
      addBtn.title = isLocked ? '' : 'આ ખર્ચ હિસાબમાં ઉમેરો';
    }

    this.onExpenseCategoryChange();
    this.renderExpenseDiary();
    this.renderExpenseNameSuggestions();
    this.openModal('modal-expense-diary');

    if (window.GujaratiTyping) {
      window.GujaratiTyping.init();
    }

    setTimeout(() => {
      const catSelect = document.getElementById('expense-select-category');
      const val = (catSelect && catSelect.value || '').toUpperCase();
      if (val.includes('PAGAR') || val.includes('UPAD')) {
        const empSel = document.getElementById('expense-select-employee');
        if (empSel) empSel.focus();
      } else {
        const titleInp = document.getElementById('expense-input-title');
        if (titleInp) titleInp.focus();
      }
    }, 150);
  },

  onExpenseCategoryChange() {
    const catSelect = document.getElementById('expense-select-category');
    const staffBox = document.getElementById('expense-staff-allocation-box');
    const liveInfo = document.getElementById('expense-employee-live-info');
    if (!catSelect || !staffBox) return;

    const val = (catSelect.value || '').toUpperCase();
    const isPagar = val.includes('PAGAR');
    const isUpad = val.includes('UPAD');

    if (isPagar || isUpad) {
      staffBox.style.display = 'block';

      const defaultMonth = this.employeeMonthFilter || (isPagar ? this.getDefaultSalaryMonth() : (this.currentDate ? this.currentDate.slice(0, 7) : new Date().toISOString().slice(0, 7)));
      const mInput = document.getElementById('expense-select-month');
      if (mInput && !mInput.value) {
        mInput.value = defaultMonth;
      }
      const currentMonth = (mInput && mInput.value) || defaultMonth;
      const monthLabel = this.getGujaratiMonthName(currentMonth);

      const boxIcon = document.getElementById('expense-staff-box-icon');
      const boxTitle = document.getElementById('expense-staff-box-title');
      const monthLbl = document.getElementById('lbl-expense-month');
      const monthBadge = document.getElementById('expense-month-name-badge');
      const empLbl = document.getElementById('lbl-expense-employee');

      if (isPagar) {
        if (boxIcon) boxIcon.textContent = '💵';
        if (boxTitle) boxTitle.textContent = 'પગાર માસ અને કર્મચારી વિગત';
        if (monthLbl) {
          monthLbl.textContent = '📅 કયા માસનો પગાર ચૂકવો છો? *:';
          monthLbl.style.color = '#065f46';
        }
        if (monthBadge) {
          monthBadge.textContent = `${monthLabel} માસનો પગાર`;
          monthBadge.style.color = '#065f46';
          monthBadge.style.background = '#d1fae5';
        }
        if (empLbl) {
          empLbl.textContent = '👤 કયા કર્મચારીનો પગાર કરવો છે? *:';
          empLbl.style.color = '#065f46';
        }
      } else {
        if (boxIcon) boxIcon.textContent = '💸';
        if (boxTitle) boxTitle.textContent = 'ઉપાડ માસ અને કર્મચારી વિગત';
        if (monthLbl) {
          monthLbl.textContent = '📅 કયા માસના પગાર સામે ઉપાડ? *:';
          monthLbl.style.color = '#9f1239';
        }
        if (monthBadge) {
          monthBadge.textContent = `${monthLabel} માસ સામે ઉપાડ`;
          monthBadge.style.color = '#9f1239';
          monthBadge.style.background = '#ffe4e6';
        }
        if (empLbl) {
          empLbl.textContent = '👤 કયા કર્મચારીને ઉપાડ આપવો છે? *:';
          empLbl.style.color = '#9f1239';
        }
      }

      this.populateExpenseEmployeeDropdown();
      this.onExpenseEmployeeChange();
    } else {
      staffBox.style.display = 'none';
      if (liveInfo) liveInfo.style.display = 'none';
    }
  },

  onExpenseMonthChange(monthVal) {
    const catSelect = document.getElementById('expense-select-category');
    const val = (catSelect && catSelect.value || '').toUpperCase();
    const isPagar = val.includes('PAGAR');
    const isUpad = val.includes('UPAD');

    const m = monthVal || document.getElementById('expense-select-month')?.value || (this.currentDate ? this.currentDate.slice(0, 7) : new Date().toISOString().slice(0, 7));
    const monthLabel = this.getGujaratiMonthName(m);

    const monthBadge = document.getElementById('expense-month-name-badge');
    if (monthBadge) {
      if (isPagar) {
        monthBadge.textContent = `${monthLabel} માસનો પગાર`;
      } else if (isUpad) {
        monthBadge.textContent = `${monthLabel} માસ સામે ઉપાડ`;
      } else {
        monthBadge.textContent = monthLabel;
      }
    }

    this.onExpenseEmployeeChange();
  },

  populateExpenseEmployeeDropdown() {
    const sel = document.getElementById('expense-select-employee');
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = '<option value="">-- કર્મચારી પસંદ કરો --</option>';
    (this.employeesList || []).forEach(emp => {
      const opt = document.createElement('option');
      opt.value = emp.id;
      opt.textContent = `👤 ${emp.name} (${emp.role}) - નક્કી પગાર: ₹${(emp.salary || 0).toLocaleString('en-IN')}`;
      sel.appendChild(opt);
    });
    if (currentVal) sel.value = currentVal;
  },

  onExpenseEmployeeChange() {
    const empSelect = document.getElementById('expense-select-employee');
    const liveInfo = document.getElementById('expense-employee-live-info');
    if (!empSelect || !liveInfo) return;

    const empId = empSelect.value;
    if (!empId) {
      liveInfo.style.display = 'none';
      return;
    }

    const emp = (this.employeesList || []).find(e => e.id === empId);
    if (!emp) {
      liveInfo.style.display = 'none';
      return;
    }

    const targetMonth = document.getElementById('expense-select-month')?.value || (this.currentDate ? this.currentDate.slice(0, 7) : new Date().toISOString().slice(0, 7));
    const monthLabel = this.getGujaratiMonthName(targetMonth);

    // Calculate figures specifically for the selected targetMonth!
    const upads = emp.upads || [];
    const pagars = emp.pagars || [];
    const monthUpads = upads.filter(u => (u.forMonth || (u.date ? u.date.slice(0, 7) : '')) === targetMonth);
    const monthUpadTotal = monthUpads.reduce((s, u) => s + (Number(u.amount) || 0), 0);

    const monthPagars = pagars.filter(p => (p.forMonth || (p.date ? p.date.slice(0, 7) : '')) === targetMonth);
    const monthPagarTotal = monthPagars.reduce((s, p) => s + (Number(p.amount) || 0), 0);

    const salary = Number(emp.salary) || 0;
    const balance = Math.max(0, salary - monthUpadTotal - monthPagarTotal);

    const catSelect = document.getElementById('expense-select-category');
    const catVal = ((catSelect && catSelect.value) || '').toUpperCase();
    const isPagar = catVal.includes('PAGAR');
    const isUpad = catVal.includes('UPAD');
    const titleInp = document.getElementById('expense-input-title');
    const amtInp = document.getElementById('expense-input-amount');

    if (isPagar) {
      if (titleInp) titleInp.value = `${emp.name} - ${monthLabel} માસનો પગાર`;
      if (amtInp && (!amtInp.value || amtInp.value == '0') && balance > 0) amtInp.value = balance;
    } else if (isUpad) {
      if (titleInp) titleInp.value = `${emp.name} - ${monthLabel} માસનો ઉપાડ`;
    }

    liveInfo.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; width: 100%;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.5rem;">${isPagar ? '💵' : '💸'}</span>
          <div>
            <div style="font-weight: 800; color: #1e3a8a; font-size: 0.98rem;">${emp.name} <span class="emp-role-badge">${emp.role}</span></div>
            <div style="font-size: 0.8rem; color: #64748b; margin-top: 2px;">
              📅 હિસાબ માસ: <strong style="color: #0284c7; background: #e0f2fe; padding: 1px 6px; border-radius: 4px;">${monthLabel}</strong> | ફોન: ${emp.phone || '-'}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 12px; align-items: center; font-size: 0.86rem; flex-wrap: wrap;">
          <div>💼 નક્કી પગાર: <strong style="color: #0f172a;">₹ ${salary.toLocaleString('en-IN')}</strong></div>
          <div>🔻 ${monthLabel} ઉપાડ: <strong style="color: #b91c1c;">₹ ${monthUpadTotal.toLocaleString('en-IN')}</strong></div>
          ${monthPagarTotal > 0 ? `<div>💵 ${monthLabel} ચૂકવેલ: <strong style="color: #2563eb;">₹ ${monthPagarTotal.toLocaleString('en-IN')}</strong></div>` : ''}
          <div>🟢 ${monthLabel} બાકી રકમ: <strong style="color: #059669; font-size: 1.05rem; font-family: var(--font-heading);">₹ ${balance.toLocaleString('en-IN')}</strong></div>
        </div>
      </div>
    `;
    liveInfo.style.display = 'block';
  },

  renderExpenseDiary() {
    if (!this.record) return;
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const items = this.record.expenseItems || [];

    // 1. Render Summary Chips
    const chipsContainer = document.getElementById('expense-category-summary-chips');
    chipsContainer.innerHTML = '';

    const voucherTotals = {};
    (this.record.vouchers || []).forEach(v => {
      const name = (v.name || '').trim();
      if (!name) return;
      voucherTotals[name] = (voucherTotals[name] || 0) + (Number(v.amount) || 0);
    });

    const activeKhataTotals = Object.entries(voucherTotals).filter(([name, amt]) => (Number(amt) || 0) > 0);

    if (activeKhataTotals.length === 0) {
      chipsContainer.innerHTML = `<div style="color: var(--text-muted); font-size: 0.88rem; padding: 6px 4px; font-style: italic;">${isEn ? 'No expense recorded in accounts.' : 'કોઈ ખાતામાં ખર્ચ નોંધાયેલ નથી.'}</div>`;
    } else {
      activeKhataTotals.forEach(([name, amt]) => {
        const chip = document.createElement('div');
        chip.className = 'cat-chip';
        chip.innerHTML = `
          <span class="cat-chip-name">🧾 ${this.getKhataNameInGujarati(name)}:</span>
          <span class="cat-chip-amt">₹ ${(amt || 0).toLocaleString('en-IN')}</span>
        `;
        chipsContainer.appendChild(chip);
      });
    }

    // 2. Render Expense Items Table
    const tbody = document.getElementById('tbody-expense-diary-list');
    tbody.innerHTML = '';

    let totalDiaryExpense = 0;
    items.forEach(item => {
      totalDiaryExpense += Number(item.amount) || 0;
    });

    if (items.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td colspan="7" style="text-align: center; padding: 20px; color: var(--text-muted); font-weight: 600;">
          <span>${isEn ? 'No expenses recorded today.' : 'આજે કોઈ ખર્ચ નોંધાયેલ નથી.'}</span>
        </td>
      `;
      tbody.appendChild(tr);
    } else {
      items.forEach((item, idx) => {
        const tr = document.createElement('tr');
        const icon = item.employeeId ? '👤' : '🧾';
        const gujKhata = this.getKhataNameInGujarati(item.category);
        tr.innerHTML = `
          <td>${idx + 1}</td>
          <td style="color: var(--text-muted); font-size: 0.85rem;">${item.time || ''}</td>
          <td style="font-weight: 700; color: var(--text-main);">${item.title}</td>
          <td>
            <span class="denom-badge denom-100" style="padding: 2px 8px; font-size: 0.8rem; border-radius: 4px;">
              ${icon} ${gujKhata}
            </span>
          </td>
          <td style="text-align: right; font-family: var(--font-heading); font-weight: 800; font-size: 1.05rem; color: #dc2626; font-variant-numeric: tabular-nums;">
            ₹ ${(Number(item.amount) || 0).toLocaleString('en-IN')}
          </td>
          <td style="color: var(--text-muted); font-size: 0.85rem;">${item.remarks || '-'}</td>
          <td style="text-align: center;">
            ${this.isCurrentDateLocked()
            ? `<span style="color:#94a3b8; font-size:0.85rem;">🔒</span>`
            : `<button class="btn-icon" style="padding: 2px 6px; font-size: 0.8rem; color: var(--rose);" onclick="App.removeExpenseItem('${item.id}')" title="કાઢો">🗑️</button>`}
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    // 3. Update count and grand total
    document.getElementById('expense-items-count-badge').textContent = `${items.length} એન્ટ્રીઓ`;
    document.getElementById('expense-diary-grand-total').textContent = `₹ ${totalDiaryExpense.toLocaleString('en-IN')}`;
  },

  addExpenseFromDiary() {
    if (this.isCurrentDateLocked()) {
      return;
    }
    const titleInp = document.getElementById('expense-input-title');
    const amountInp = document.getElementById('expense-input-amount');
    const catSelect = document.getElementById('expense-select-category');
    const remarkInp = document.getElementById('expense-input-remark');

    const title = titleInp.value.trim();
    const amount = Number(amountInp.value);
    const catVal = catSelect.value;
    const remarks = remarkInp.value.trim();

    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (!title) {
      this.showToast(isEn ? 'Please enter expense detail' : 'કૃપા કરીને ખર્ચનું નામ / વિગત લખો', 'error');
      titleInp.focus();
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      this.showToast(isEn ? 'Please enter valid expense amount' : 'કૃપા કરીને સાચી ખર્ચ રકમ લખો', 'error');
      amountInp.focus();
      return;
    }
    if (!catVal) {
      this.showToast(isEn ? 'Please select voucher account' : 'કૃપા કરીને વાઉચર ખાતો પસંદ કરો', 'error');
      return;
    }

    const [type, category] = catVal.split(':');
    const isPagar = category.toUpperCase().includes('PAGAR');
    const isUpad = category.toUpperCase().includes('UPAD');

    // Check if an employee is linked
    const empSelect = document.getElementById('expense-select-employee');
    const empId = (empSelect && empSelect.value) ? empSelect.value : null;
    let linkedEmp = null;
    if (empId) {
      linkedEmp = (this.employeesList || []).find(e => e.id === empId);
    }

    const forMonth = document.getElementById('expense-select-month')?.value || (this.currentDate ? this.currentDate.slice(0, 7) : new Date().toISOString().slice(0, 7));
    const monthLabel = this.getGujaratiMonthName(forMonth);

    let itemTitle = title;
    if (linkedEmp) {
      if (isPagar) {
        itemTitle = `${linkedEmp.name} - ${monthLabel} માસનો પગાર`;
      } else if (isUpad) {
        itemTitle = `${linkedEmp.name} - ${monthLabel} માસનો ઉપાડ${title && title !== 'ઉપાડ' && !title.includes('ઉપાડ') ? ` (${title})` : ''}`;
      } else {
        itemTitle = `${linkedEmp.name} - ${title}`;
      }
    } else if (isPagar || isUpad) {
      itemTitle = `${monthLabel} માસનો ${isPagar ? 'પગાર' : 'ઉપાડ'}${title ? ` (${title})` : ''}`;
    }

    const now = new Date();
    const timeStr = this.getCurrentTimeStr();

    const newItem = {
      id: 'exp_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      time: timeStr,
      title: itemTitle,
      amount: amount,
      category: category,
      categoryType: type, // 'voucher'
      employeeId: linkedEmp ? linkedEmp.id : null,
      employeeName: linkedEmp ? linkedEmp.name : null,
      forMonth: forMonth,
      remarks: remarks
    };

    if (!Array.isArray(this.record.expenseItems)) {
      this.record.expenseItems = [];
    }
    this.record.expenseItems.unshift(newItem); // add to top of list

    // Automatically allocate / add to that category in main daily record
    if (type === 'voucher') {
      let v = (this.record.vouchers || []).find(x => x.name.trim() === category.trim());
      if (v) {
        v.amount = (Number(v.amount) || 0) + amount;
      } else {
        this.record.vouchers.push({ name: category.trim(), amount: amount });
      }
    }

    // If an employee was linked, route to either Pagar or Upad with forMonth
    if (linkedEmp) {
      if (isPagar) {
        fetch(`/api/employees/${linkedEmp.id}/pagar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: amount,
            title: itemTitle,
            remarks: remarks || `${monthLabel} માસનો પગાર ચૂકવ્યો`,
            date: this.currentDate,
            time: timeStr,
            forMonth: forMonth,
            expenseItemId: newItem.id,
            addToHisab: false
          })
        }).then(r => r.json()).then(data => {
          if (data && data.pagar) newItem.employeeEntryId = data.pagar.id;
          this.loadEmployees(this.employeeMonthFilter);
        }).catch(() => { });
      } else if (isUpad) {
        fetch(`/api/employees/${linkedEmp.id}/upad`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: amount,
            title: itemTitle,
            remarks: remarks || `${monthLabel} માસ સામે ઉપાડ આપ્યો`,
            date: this.currentDate,
            time: timeStr,
            forMonth: forMonth,
            expenseItemId: newItem.id,
            addToHisab: false
          })
        }).then(r => r.json()).then(data => {
          if (data && data.upad) newItem.employeeEntryId = data.upad.id;
          this.loadEmployees(this.employeeMonthFilter);
        }).catch(() => { });
      }
    }

    // Recalculate totals and refresh UI
    this.recalcTotals();
    this.renderRecord();
    this.markDirty(true);
    this.flushPendingSave();
    this.renderExpenseDiary();
    this.registerNewExpenseName(remarks);

    const toastMsg = isEn
      ? (linkedEmp
        ? `Successfully added ${linkedEmp.name}'s ${isPagar ? 'Salary' : 'Advance'} (₹${amount.toLocaleString('en-IN')}) for ${monthLabel}!`
        : `Added ₹${amount.toLocaleString('en-IN')} expense to '${category}' for ${monthLabel}!`)
      : (linkedEmp
        ? `સફળતાપૂર્વક ${linkedEmp.name} નો ${monthLabel} માસનો ${isPagar ? 'પગાર' : 'ઉપાડ'} (₹${amount.toLocaleString('en-IN')}) ખર્ચમાં ચડી ગયો!`
        : `₹${amount.toLocaleString('en-IN')} નો ${monthLabel} માસનો '${this.getKhataNameInGujarati(category)}' ખર્ચ સફળતાપૂર્વક ઉમેરાઈ ગયો!`);
    this.showToast(toastMsg, 'success');

    // Reset inputs for next rapid entry
    titleInp.value = '';
    amountInp.value = '';
    remarkInp.value = '';
    if (empSelect) empSelect.value = '';
    this.onExpenseEmployeeChange();
    titleInp.focus();
  },

  async removeExpenseItem(id) {
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (this.isCurrentDateLocked()) {
      this.showToast(isEn ? 'This date is locked!' : 'આ તારીખ લોક થયેલ છે!', 'error');
      return;
    }
    if (!this.record || !Array.isArray(this.record.expenseItems)) return;
    const idx = this.record.expenseItems.findIndex(x => x.id === id);
    if (idx === -1) return;

    const item = this.record.expenseItems[idx];
    const gujCat = this.getKhataNameInGujarati(item.category);
    if (!confirm(isEn ? `Are you sure you want to delete "${item.title}" (₹${(Number(item.amount) || 0).toLocaleString('en-IN')})? This will also be deducted from the voucher total.` : `શું તમે "${item.title}" (₹${(Number(item.amount) || 0).toLocaleString('en-IN')}) કાયમી ધોરણે કાઢી નાખવા માંગો છો? આ વાઉચર હિસાબમાંથી પણ બાદ થશે.`)) {
      return;
    }

    // 1. Remove from expense items array
    this.record.expenseItems.splice(idx, 1);

    // 2. If this item was linked to an employee (Pagar or Upad), delete corresponding entry in employee record
    if (item.employeeId) {
      try {
        const empRes = await fetch('/api/employees');
        const empData = await empRes.json();
        const empList = Array.isArray(empData) ? empData : (empData.employees || []);
        const emp = (empList || []).find(e => e.id === item.employeeId);
        if (emp) {
          let empChanged = false;
          if (Array.isArray(emp.pagars)) {
            const pIdx = emp.pagars.findIndex(p =>
              (p.expenseItemId && (p.expenseItemId === item.id || p.expenseItemId === ('exp_' + p.id))) ||
              (item.id && (item.id === ('exp_' + p.id) || item.id === p.id)) ||
              (item.employeeEntryId && p.id === item.employeeEntryId) ||
              (p.date === (item.date || this.currentDate) && Number(p.amount) === Number(item.amount))
            );
            if (pIdx !== -1) {
              emp.pagars.splice(pIdx, 1);
              empChanged = true;
            }
          }
          if (Array.isArray(emp.upads)) {
            const uIdx = emp.upads.findIndex(u =>
              (u.expenseItemId && (u.expenseItemId === item.id || u.expenseItemId === ('exp_' + u.id))) ||
              (item.id && (item.id === ('exp_' + u.id) || item.id === u.id)) ||
              (item.employeeEntryId && u.id === item.employeeEntryId) ||
              (u.date === (item.date || this.currentDate) && Number(u.amount) === Number(item.amount))
            );
            if (uIdx !== -1) {
              emp.upads.splice(uIdx, 1);
              empChanged = true;
            }
          }
          if (empChanged) {
            await fetch(`/api/employees/${emp.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(emp)
            });
            await this.loadEmployees(this.employeeMonthFilter);
          }
        }
      } catch (err) {
        console.warn('Could not sync employee ledger on expense item delete:', err);
      }
    }

    // 3. Recalculate voucher amounts strictly from remaining expenseItems
    const catSums = {};
    this.record.expenseItems.forEach(it => {
      const k = (it.category || '').trim().toUpperCase();
      catSums[k] = (catSums[k] || 0) + (Number(it.amount) || 0);
    });
    (this.record.vouchers || []).forEach(v => {
      const vKey = (v.name || '').trim().toUpperCase();
      v.amount = catSums[vKey] || 0;
    });

    // 4. Recalculate totals and refresh UI
    this.recalcTotals();
    this.renderRecord();
    this.renderExpenseDiary();

    // 5. Immediately save to backend so deletion is saved permanently!
    await this.saveCurrentRecord(false);

    // 6. Reload employees list if linked
    if (item.employeeId) {
      await this.loadEmployees(this.employeeMonthFilter);
    }

    this.showToast(isEn ? `🗑️ Expense "${item.title}" deleted and ₹${item.amount} deducted from voucher` : `🗑️ ખર્ચ "${item.title}" કાઢી નાખ્યો અને વાઉચરમાંથી ₹${item.amount} બાદ કર્યા`, 'success');
  },

  async shareExpenseDiaryWhatsApp() {
    if (!this.record) return;
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const items = this.record.expenseItems || [];
    if (items.length === 0) {
      this.showToast(isEn ? 'No expenses recorded to share' : 'શેર કરવા માટે કોઈ ખર્ચ નોંધાયેલ નથી', 'error');
      return;
    }

    const total = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    const dateInfo = this.formatDateHeaderForPrint(this.currentDate);
    const orgName = this.settings.orgName || 'સંસ્થાન હિસાબ';

    let text = `📝 *દૈનિક ખર્ચ ડાયરી પત્રક*\n`;
    text += `📅 તારીખ: ${dateInfo.formattedDate} (${dateInfo.guDay})\n`;
    text += `🏛️ ${orgName}\n`;
    text += `--------------------------------\n`;

    items.forEach((item, idx) => {
      text += `${idx + 1}. *${item.title}*: ₹${(Number(item.amount) || 0).toLocaleString('en-IN')}\n`;
      text += `   ↳ ખાતો: ${this.getKhataNameInGujarati(item.category)}${item.remarks ? ' | નોંધ: ' + item.remarks : ''}\n`;
    });

    text += `--------------------------------\n`;
    text += `💰 *કુલ ખર્ચ: ₹${total.toLocaleString('en-IN')}*\n`;
    text += `(વિગતવાર પ્રિન્ટ રિપોર્ટ PDF સાથે જોડેલ છે)\n`;

    const phone = this.settings.phone ? this.settings.phone.replace(/[^0-9]/g, '') : '';
    const fullPhone = phone.length === 10 ? '91' + phone : phone;
    const waUrl = `https://wa.me/${fullPhone}?text=${encodeURIComponent(text)}`;

    if (typeof html2pdf !== 'undefined') {
      this.showToast(isEn ? '⏳ Generating PDF report...' : '⏳ પ્રિન્ટ રિપોર્ટ PDF તૈયાર થઈ રહી છે...', 'info');

      try {
        const printHtml = this.generateDateWiseExpensePrintHtml({
          title: 'દૈનિક ખર્ચ ડાયરી પત્રક',
          subtitle: `તારીખ: ${dateInfo.formattedDate} (${dateInfo.guDay})`,
          items: items,
          grandTotal: total
        });

        const parser = new DOMParser();
        const doc = parser.parseFromString(printHtml, 'text/html');
        doc.querySelectorAll('.no-print').forEach(el => el.remove());
        doc.querySelectorAll('script').forEach(el => el.remove());

        const wrapper = document.createElement('div');
        wrapper.id = 'temp-diary-pdf-wrap';
        wrapper.style.position = 'fixed';
        wrapper.style.left = '-9999px';
        wrapper.style.top = '0';
        wrapper.style.width = '210mm';
        wrapper.style.background = '#ffffff';
        wrapper.style.padding = '8mm';
        wrapper.style.boxSizing = 'border-box';
        wrapper.innerHTML = `<style>${doc.querySelector('style')?.innerHTML || ''}</style>` + doc.body.innerHTML;
        document.body.appendChild(wrapper);

        const fileName = `Kharch_Diary_${this.currentDate}.pdf`;
        const opt = {
          margin: [8, 8, 8, 8],
          filename: fileName,
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true, letterRendering: true, logging: false },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };

        const pdfBlob = await html2pdf().set(opt).from(wrapper).output('blob');
        document.body.removeChild(wrapper);

        let sharedDirectly = false;
        const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });

        if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
          try {
            await navigator.share({
              files: [pdfFile],
              title: 'દૈનિક ખર્ચ ડાયરી પત્રક',
              text: text
            });
            sharedDirectly = true;
            this.showToast('✅ ખર્ચ ડાયરી PDF વોટ્સએપ પર શેર થઈ ગઈ!', 'success');
            return;
          } catch (shareErr) {
            if (shareErr.name === 'AbortError') {
              return;
            }
            console.warn('Web Share failed, fallback to download & WhatsApp Web:', shareErr);
          }
        }

        if (!sharedDirectly) {
          const blobUrl = URL.createObjectURL(pdfBlob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          }, 1000);

          window.open(waUrl, '_blank');
          this.showToast('📄 પ્રિન્ટ રિપોર્ટ PDF ડાઉનલોડ થઈ ગઈ છે! વોટ્સએપમાં 📎 Document તરીકે મોકલો.', 'success');
          return;
        }
      } catch (err) {
        console.error('Error generating PDF for WhatsApp:', err);
      }
    }

    // Fallback if html2pdf not available
    window.open(waUrl, '_blank');
  },

  getKhataNameInGujarati(khataName) {
    if (!khataName) return '';
    const trimmed = String(khataName).trim();
    const upper = trimmed.toUpperCase();

    const khataMap = {
      'MANDIRKHARCH': 'મંદિર ખર્ચ',
      'MANDIR KHARCH': 'મંદિર ખર્ચ',
      'MANDIR_KHARCH': 'મંદિર ખર્ચ',
      'MANDIR': 'મંદિર ખર્ચ',
      'RASODAKHARCH': 'રસોડા ખર્ચ',
      'RASODA KHARCH': 'રસોડા ખર્ચ',
      'RASODA_KHARCH': 'રસોડા ખર્ચ',
      'RASODA': 'રસોડા ખર્ચ',
      'PAGAR': 'પગાર',
      'PAGARKHARCH': 'પગાર ખર્ચ',
      'SALARY': 'પગાર',
      'UPAD': 'ઉપાડ',
      'ADVANCE': 'ઉપાડ',
      'HINDOLA KHARCH': 'હિંડોળા ખર્ચ',
      'HINDOLAKHARCH': 'હિંડોળા ખર્ચ',
      'HILDOLAKHARCH': 'હિંડોળા ખર્ચ',
      'HINDOLA': 'હિંડોળા ખર્ચ',
      'GAUSHALA': 'ગૌશાળા',
      'GAUSALA': 'ગૌશાળા',
      'GOSHALA': 'ગૌશાળા',
      'BIJLI BILL': 'વીજળી બિલ',
      'BIJLIBILL': 'વીજળી બિલ',
      'LIGHT BILL': 'લાઈટ બિલ',
      'LIGHTBILL': 'લાઈટ બિલ',
      'ELECTRICITY': 'વીજળી બિલ',
      'PETROL': 'પેટ્રોલ ખર્ચ',
      'PETROL KHARCH': 'પેટ્રોલ ખર્ચ',
      'DUDH': 'દૂધ ખર્ચ',
      'DUDH KHARCH': 'દૂધ ખર્ચ',
      'CHAI': 'ચા-નાસ્તો',
      'CHAI NASTA': 'ચા-નાસ્તો',
      'KIRANA': 'કિરાણા',
      'REPAIR': 'રીપેરીંગ ખર્ચ',
      'REPAIRING': 'રીપેરીંગ ખર્ચ',
      'MAINTENANCE': 'મેન્ટેનન્સ',
      'OFFICE': 'ઓફિસ ખર્ચ',
      'OFFICE KHARCH': 'ઓફિસ ખર્ચ',
      'OTHER': 'અન્ય ખર્ચ',
      'MISC': 'પરચૂરણ ખર્ચ',
      'IOB TRF': 'આઈ.ઓ.બી. બેંક ટ્રાન્સફર',
      'IOB': 'આઈ.ઓ.બી. બેંક',
      'BOB TRF': 'બી.ઓ.બી. બેંક ટ્રાન્સફર',
      'BOB': 'બી.ઓ.બી. બેંક',
      'SBI TRF': 'એસ.બી.આઈ. બેંક ટ્રાન્સફર',
      'SBI': 'એસ.બી.આઈ. બેંક'
    };

    if (khataMap[upper]) {
      return khataMap[upper];
    }

    if (/[\u0A80-\u0AFF]/.test(trimmed)) {
      return trimmed;
    }

    if (window.GujaratiTyping) {
      if (typeof window.GujaratiTyping.transliterateSentence === 'function') {
        const transliterated = window.GujaratiTyping.transliterateSentence(trimmed);
        if (transliterated && transliterated.toLowerCase() !== trimmed.toLowerCase()) {
          return transliterated;
        }
      } else if (typeof window.GujaratiTyping.transliterateWord === 'function') {
        const transliterated = window.GujaratiTyping.transliterateWord(trimmed);
        if (transliterated && transliterated.toLowerCase() !== trimmed.toLowerCase()) {
          return transliterated;
        }
      }
    }

    return trimmed;
  },

  getEnglishKhataName(khataName) {
    if (!khataName) return '';
    const trimmed = String(khataName).trim();
    const upper = trimmed.toUpperCase();

    // 1. Direct Comprehensive Dictionary (exact matches)
    const gujToEngMap = {
      // Core expense vouchers
      'મંદિર ખર્ચ': 'MANDIR KHARCH',
      'મંદિરખર્ચ': 'MANDIR KHARCH',
      'મંદિર': 'MANDIR',
      'રસોડા ખર્ચ': 'RASODA KHARCH',
      'રસોડાખર્ચ': 'RASODA KHARCH',
      'રસોડા': 'RASODA',
      'રસોડું': 'RASODU',
      'પગાર': 'PAGAR',
      'પગાર ખર્ચ': 'PAGAR KHARCH',
      'ઉપાડ': 'UPAD',
      'એડવાન્સ': 'ADVANCE',
      'હિંડોળા ખર્ચ': 'HINDOLA KHARCH',
      'હિંડોળાખર્ચ': 'HINDOLA KHARCH',
      'હિંડોળા': 'HINDOLA',
      'હિલ્દોલખર્ચ': 'HINDOLA KHARCH',
      'હિલ્દોળખર્ચ': 'HINDOLA KHARCH',
      'ગૌશાળા': 'GAUSHALA',
      'ગૌશાળા ખર્ચ': 'GAUSHALA KHARCH',
      'લાઈટ બિલ': 'LIGHT BILL',
      'લાઈટબિલ': 'LIGHT BILL',
      'લાઈટ બિલ ખર્ચ': 'LIGHT BILL KHARCH',
      'વીજળી બિલ': 'LIGHT BILL',
      'વીજળી બિલ ખર્ચ': 'LIGHT BILL KHARCH',
      'પેટ્રોલ': 'PETROL',
      'પેટ્રોલ ખર્ચ': 'PETROL KHARCH',
      'ડીઝલ': 'DIESEL',
      'ડીઝલ ખર્ચ': 'DIESEL KHARCH',
      'ઓઈલ': 'OIL',
      'ઓઈલ ખર્ચ': 'OIL KHARCH',
      'દૂધ': 'DUDH',
      'દૂધ ખર્ચ': 'DUDH KHARCH',
      'ચા': 'CHAI',
      'ચા ખર્ચ': 'CHAI KHARCH',
      'ચા નાસ્તો': 'CHAI NASTO',
      'ચા-નાસ્તો': 'CHAI NASTO',
      'નાસ્તો': 'NASTO',
      'કરિયાણું': 'KIRANA',
      'કરિયાણા ખર્ચ': 'KIRANA KHARCH',
      'કરિયાણું ખર્ચ': 'KIRANA KHARCH',
      'કિરાણા': 'KIRANA',
      'રીપેરીંગ': 'REPAIRING',
      'રીપેરીંગ ખર્ચ': 'REPAIRING KHARCH',
      'સમારકામ': 'REPAIRING',
      'સમારકામ ખર્ચ': 'REPAIRING KHARCH',
      'મેન્ટેનન્સ': 'MAINTENANCE',
      'મેન્ટેનન્સ ખર્ચ': 'MAINTENANCE KHARCH',
      'ઓફિસ': 'OFFICE',
      'ઓફિસ ખર્ચ': 'OFFICE KHARCH',
      'પરચૂરણ': 'PARCHURAN',
      'પરચૂરણ ખર્ચ': 'PARCHURAN KHARCH',
      'અન્ય': 'ANYA',
      'અન્ય ખર્ચ': 'ANYA KHARCH',
      'સ્ટેશનરી': 'STATIONERY',
      'સ્ટેશનરી ખર્ચ': 'STATIONERY KHARCH',
      'ટેમ્પો': 'TEMPO',
      'ટેમ્પો ભાડું': 'TEMPO BHADU',
      'ભાડું': 'BHADU',
      'ભાડા ખર્ચ': 'BHADU KHARCH',
      'દવા': 'DAVA',
      'દવા ખર્ચ': 'DAVA KHARCH',
      'સાબુ': 'SABU',
      'સાબુ ખર્ચ': 'SABU KHARCH',
      'સફાઈ': 'SAFAI',
      'સફાઈ ખર્ચ': 'SAFAI KHARCH',
      'પ્રસાદ': 'PRASAD',
      'પ્રસાદ ખર્ચ': 'PRASAD KHARCH',
      'પ્રસાદી': 'PRASADI',
      'પૂજા': 'PUJA',
      'પૂજા ખર્ચ': 'PUJA KHARCH',
      'પૂજા સામગ્રી': 'PUJA SAMAGRI',
      'ઘાસ': 'GHAS',
      'ઘાસચારો': 'GHASCHARO',
      'ખોળ': 'KHOL',
      'ખોળ ખર્ચ': 'KHOL KHARCH',
      'શાકભાજી': 'SHAKBHAJI',
      'શાકભાજી ખર્ચ': 'SHAKBHAJI KHARCH',
      'શાક': 'SHAK',
      'તેલ': 'TEL',
      'ઘી': 'GHEE',
      'ચોખા': 'CHOKHA',
      'દાળ': 'DAL',
      'ખાંડ': 'KHAND',
      'ગોળ': 'GOL',
      'મસાલા': 'MASALA',
      'પાણી': 'PANI',
      'ચાંદી': 'CHANDI',
      'સોનું': 'SONU',
      'વાસણ': 'VASAN',
      'વાસણ ખર્ચ': 'VASAN KHARCH',
      'મકાન': 'MAKAN',
      'મકાન ખર્ચ': 'MAKAN KHARCH',
      'વાહન': 'VAHAN',
      'વાહન ખર્ચ': 'VAHAN KHARCH',
      'ગાડી': 'GADI',
      'ગાડી ભાડું': 'GADI BHADU',
      'મજૂરી': 'MAJURI',
      'મજૂરી ખર્ચ': 'MAJURI KHARCH',
      'હમાલી': 'HAMALI',
      'ટ્રાન્સપોર્ટ': 'TRANSPORT',
      'ટ્રાન્સપોર્ટ ખર્ચ': 'TRANSPORT KHARCH',
      'ફર્નિચર': 'FURNITURE',
      'કલર': 'COLOR',
      'કલરકામ': 'COLOR WORK',
      'ઇલેક્ટ્રિક': 'ELECTRIC',
      'ઇલેક્ટ્રિક ખર્ચ': 'ELECTRIC KHARCH',
      'પ્લમ્બિંગ': 'PLUMBING',
      'દાન': 'DAAN',
      'ભેટ': 'BHET',
      'ખર્ચ': 'KHARCH'
    };

    if (gujToEngMap[trimmed]) {
      return gujToEngMap[trimmed];
    }

    // 2. If it's already in pure English/ASCII (e.g. MANDIRKHARCH, PAGAR, LIGHT BILL)
    if (/^[A-Za-z0-9_\-\s\.\(\)\/]+$/.test(trimmed)) {
      return upper;
    }

    // Helper: Intelligent Gujarati to English phonetic word transliteration
    const transliterateGujaratiWord = (word) => {
      if (!word) return '';
      const w = word.trim();
      if (gujToEngMap[w]) return gujToEngMap[w];

      const consonants = {
        'ક': 'K', 'ખ': 'KH', 'ગ': 'G', 'ઘ': 'GH', 'ઙ': 'NG',
        'ચ': 'CH', 'છ': 'CHH', 'જ': 'J', 'ઝ': 'Z', 'ઞ': 'NY',
        'ટ': 'T', 'ઠ': 'TH', 'ડ': 'D', 'ઢ': 'DH', 'ણ': 'N',
        'ત': 'T', 'થ': 'TH', 'દ': 'D', 'ધ': 'DH', 'ન': 'N',
        'પ': 'P', 'ફ': 'F', 'બ': 'B', 'ભ': 'BH', 'મ': 'M',
        'ય': 'Y', 'ર': 'R', 'લ': 'L', 'ળ': 'L', 'વ': 'V',
        'શ': 'SH', 'ષ': 'SH', 'સ': 'S', 'હ': 'H'
      };

      const vowels = {
        'અ': 'A', 'આ': 'A', 'ઇ': 'I', 'ઈ': 'I', 'ઉ': 'U', 'ઊ': 'U', 'ઋ': 'RU',
        'એ': 'E', 'ઐ': 'AI', 'ઓ': 'O', 'ઔ': 'AU'
      };

      const matras = {
        'ા': 'A', 'િ': 'I', 'ી': 'I', 'ુ': 'U', 'ૂ': 'U', 'ૃ': 'RU',
        'ે': 'E', 'ૈ': 'AI', 'ો': 'O', 'ૌ': 'AU'
      };

      let out = '';
      for (let i = 0; i < w.length; i++) {
        const ch = w[i];
        const next = w[i + 1] || '';
        const next2 = w[i + 2] || '';

        if (vowels[ch]) {
          out += vowels[ch];
          continue;
        }

        if (consonants[ch]) {
          const cEng = consonants[ch];
          if (next === '્') {
            out += cEng;
            i++; // skip halant
          } else if (matras[next]) {
            out += cEng + matras[next];
            i++; // skip matra
          } else if (next === 'ં') {
            const isLabial = ['પ', 'ફ', 'બ', 'ભ', 'મ'].includes(next2);
            out += cEng + 'A' + (isLabial ? 'M' : 'N');
            i++; // skip anusvara
          } else {
            const isTerminal = (i === w.length - 1);
            out += isTerminal ? cEng : (cEng + 'A');
          }
          continue;
        }

        if (matras[ch]) {
          out += matras[ch];
          continue;
        }

        if (ch === 'ં') {
          out += 'N';
          continue;
        }

        if (/[a-zA-Z0-9]/.test(ch)) {
          out += ch.toUpperCase();
          continue;
        }

        if (/[\s\-_]/.test(ch)) {
          out += ' ';
        }
      }

      return out.replace(/\s+/g, ' ').trim();
    };

    // 3. Suffix Preservation: If ends with 'ખર્ચ' (e.g. 'દૂધ ખર્ચ', 'પેટ્રોલ ખર્ચ', 'શાકભાજી ખર્ચ')
    if (trimmed.endsWith(' ખર્ચ') || (trimmed.endsWith('ખર્ચ') && trimmed.length > 4)) {
      const base = trimmed.replace(/\s*ખર્ચ$/, '').trim();
      const baseEng = gujToEngMap[base] || transliterateGujaratiWord(base);
      return (baseEng + ' KHARCH').replace(/\s+/g, ' ').trim();
    }

    // 4. Multi-word phrase handling (token by token)
    const words = trimmed.split(/\s+/);
    if (words.length > 1) {
      const translatedWords = words.map(w => gujToEngMap[w] || transliterateGujaratiWord(w));
      return translatedWords.join(' ').replace(/\s+/g, ' ').trim();
    }

    return transliterateGujaratiWord(trimmed) || upper;
  },

  onAdminVoucherInput(val) {
    const previewEl = document.getElementById('admin-voucher-auto-eng-preview');
    if (!previewEl) return;
    const trimmed = (val || '').trim();
    if (!trimmed) {
      previewEl.textContent = '-';
      return;
    }
    const engName = this.getEnglishKhataName(trimmed);
    previewEl.textContent = engName || '-';
  },

  formatDateHeaderForPrint(dateStr) {
    if (!dateStr) return { formattedDate: '', guDay: '', enDay: '', fullLabel: '' };
    try {
      const daysGu = ['રવિવાર', 'સોમવાર', 'મંગળવાર', 'બુધવાર', 'ગુરુવાર', 'શુક્રવાર', 'શનિવાર'];
      const daysEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const parts = String(dateStr).split('-');
      if (parts.length === 3) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const d = parseInt(parts[2], 10);
        const dt = new Date(y, m, d);
        const dayIdx = dt.getDay();
        const guDay = daysGu[dayIdx] || '';
        const enDay = daysEn[dayIdx] || '';
        const formattedDate = `${String(d).padStart(2, '0')}-${String(m + 1).padStart(2, '0')}-${y}`;
        return {
          formattedDate,
          guDay,
          enDay,
          fullLabel: `${formattedDate} (${guDay} / ${enDay})`
        };
      }
    } catch (e) {
      console.warn('Date format err:', e);
    }
    return { formattedDate: dateStr, guDay: '', enDay: '', fullLabel: dateStr };
  },

  openPrintWindow(htmlContent) {
    const printWin = window.open('', '_blank', 'width=950,height=750');
    if (!printWin) {
      const isEn = window.i18n && window.i18n.currentLang === 'en';
      alert(isEn ? 'Please disable browser popup blocker so the print window can open.' : 'કૃપા કરીને બ્રાઉઝર પોપ-અપ બ્લૉકર બંધ કરો જેથી પ્રિન્ટ વિન્ડો ખુલી શકે.');
      return;
    }
    printWin.document.open();
    printWin.document.write(htmlContent);
    printWin.document.close();
  },

  generateDateWiseExpensePrintHtml({ title, subtitle, items = [], categoryTotals = null, grandTotal = null, fromDate = null, toDate = null, includeAllDates = false }) {
    const orgName = this.settings.orgName || 'સંસ્થાન હિસાબ';
    const orgSubtitle = this.settings.orgSubtitle || 'દૈનિક ખર્ચ અને રોકડ હિસાબ પત્રક';

    // Group items by date
    const dateGroups = {};
    const effectiveCategoryTotals = categoryTotals ? { ...categoryTotals } : {};
    let calculatedGrandTotal = 0;

    items.forEach(item => {
      const d = item.date || this.currentDate || new Date().toISOString().slice(0, 10);
      if (!dateGroups[d]) dateGroups[d] = [];
      dateGroups[d].push(item);

      const amt = Number(item.amount) || 0;
      calculatedGrandTotal += amt;
      if (!categoryTotals) {
        const cat = item.category || 'OTHER';
        effectiveCategoryTotals[cat] = (effectiveCategoryTotals[cat] || 0) + amt;
      }
    });

    // If includeAllDates is true and fromDate & toDate are provided, populate empty arrays for dates with no expense
    if (includeAllDates && fromDate && toDate) {
      let cur = new Date(fromDate + 'T00:00:00');
      const stop = new Date(toDate + 'T00:00:00');
      while (cur <= stop) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, '0');
        const d = String(cur.getDate()).padStart(2, '0');
        const dtStr = `${y}-${m}-${d}`;
        if (!dateGroups[dtStr]) {
          dateGroups[dtStr] = [];
        }
        cur.setDate(cur.getDate() + 1);
      }
    }

    const finalGrandTotal = (grandTotal !== null && grandTotal !== undefined) ? grandTotal : calculatedGrandTotal;
    const sortedDates = Object.keys(dateGroups).sort();

    let dateSectionsHtml = '';

    if (sortedDates.length === 0) {
      const defaultDateInfo = this.formatDateHeaderForPrint(this.currentDate);
      dateSectionsHtml = `
        <div class="date-group-card">
          <div class="date-main-heading">
            <div class="date-heading-text">
              <span>📅</span>
              <span>તારીખ: <b>${defaultDateInfo.formattedDate}</b></span>
              <span class="day-badge">(${defaultDateInfo.guDay})</span>
            </div>
          </div>
          <table class="expense-table">
            <thead>
              <tr>
                <th style="width: 45px; text-align: center;">#</th>
                <th style="width: 150px; text-align: right;">રકમ (₹ Amount)</th>
                <th style="text-align: left;">ખર્ચ વિગત</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colspan="3" style="text-align: center; padding: 24px; color: #64748b; font-style: italic;">
                  આ તારીખે કોઈ ખર્ચ નોંધાયેલ નથી
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      `;
    } else {
      sortedDates.forEach(dateStr => {
        const dateInfo = this.formatDateHeaderForPrint(dateStr);
        const dayItems = dateGroups[dateStr] || [];
        const daySubtotal = dayItems.reduce((acc, it) => acc + (Number(it.amount) || 0), 0);

        let rowsHtml = '';
        if (dayItems.length === 0) {
          rowsHtml = `
            <tr>
              <td class="col-idx" style="text-align: center; color: #94a3b8;">-</td>
              <td class="col-amount" style="color: #64748b; font-weight: 700;">₹ 0</td>
              <td class="col-vigat" style="color: #64748b; font-style: italic;">
                આ તારીખે કોઈ ખર્ચ થયેલ નથી
              </td>
            </tr>
          `;
        } else {
          dayItems.forEach((it, idx) => {
            const amt = Number(it.amount) || 0;
            const gujKhata = this.getKhataNameInGujarati(it.category);
            rowsHtml += `
              <tr>
                <td class="col-idx">${idx + 1}</td>
                <td class="col-amount">₹ ${amt.toLocaleString('en-IN')}</td>
                <td class="col-vigat">
                  <div class="vigat-main">
                    <span class="vigat-title">${it.title || '-'}</span>
                    ${gujKhata ? `<span class="khata-badge">${gujKhata}</span>` : ''}
                  </div>
                  ${it.remarks ? `<div class="vigat-remarks">${it.remarks}</div>` : ''}
                </td>
              </tr>
            `;
          });
        }

        dateSectionsHtml += `
          <div class="date-group-card">
            <!-- 1. MAIN HEADING DATE -->
            <div class="date-main-heading">
              <div class="date-heading-text">
                <span class="cal-icon">📅</span>
                <span>તારીખ: <b>${dateInfo.formattedDate}</b></span>
                <span class="day-badge">(${dateInfo.guDay} / ${dateInfo.enDay})</span>
              </div>
            </div>

            <!-- 2. PEHLE RAKAM, PAS ME USKI VIGAT (KHATA JOINED, NO SAMAY) -->
            <table class="expense-table">
              <thead>
                <tr>
                  <th style="width: 45px; text-align: center;">#</th>
                  <th style="width: 150px; text-align: right;">રકમ (₹ Amount)</th>
                  <th style="text-align: left;">ખર્ચ વિગત</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
              <tfoot>
                <tr class="date-subtotal-row">
                  <td style="text-align: center;">-</td>
                  <td class="date-subtotal-amount">₹ ${daySubtotal.toLocaleString('en-IN')}</td>
                  <td class="date-subtotal-label">Total</td>
                </tr>
              </tfoot>
            </table>
          </div>
        `;
      });
    }

    return `
      <!DOCTYPE html>
      <html lang="gu">
      <head>
        <meta charset="utf-8">
        <title>${title} - ${orgName}</title>
        <style>
          @page {
            size: A4 portrait;
            margin: 10mm 12mm 12mm 12mm;
          }
          * { box-sizing: border-box; }
          body {
            font-family: Arial, "Noto Sans Gujarati", 'Segoe UI', sans-serif;
            margin: 0;
            padding: 20px;
            color: #0f172a;
            background: #ffffff;
            font-size: 13px;
            line-height: 1.4;
          }

          /* Top Preview / Action Bar (hidden when printing) */
          .print-toolbar {
            position: sticky;
            top: 0;
            background: #1e293b;
            color: #ffffff;
            padding: 10px 18px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 1000;
          }
          .print-toolbar-title {
            font-size: 14px;
            font-weight: 700;
          }
          .print-toolbar-actions {
            display: flex;
            gap: 10px;
          }
          .print-toolbar button {
            border: none;
            padding: 8px 16px;
            font-size: 13px;
            font-weight: bold;
            border-radius: 6px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
          }
          .btn-do-print {
            background: #10b981;
            color: #ffffff;
          }
          .btn-do-print:hover { background: #059669; }
          .btn-do-close {
            background: #475569;
            color: #ffffff;
          }
          .btn-do-close:hover { background: #334155; }

          @media print {
            body { padding: 0 !important; }
            .no-print { display: none !important; }
            .date-group-card {
              page-break-inside: avoid;
              break-inside: avoid;
            }
            table { page-break-inside: auto; }
            tr { page-break-inside: avoid; page-break-after: auto; }
            thead { display: table-header-group; }
            tfoot { display: table-footer-group; }
          }

          /* Date Group Card */
          .date-group-card {
            margin-bottom: 20px;
            border: 1.5px solid #0f172a;
            border-radius: 6px;
            overflow: hidden;
            background: #ffffff;
          }

          /* 1. Main Heading Date */
          .date-main-heading {
            background: #e2e8f0;
            border-bottom: 1.5px solid #0f172a;
            padding: 8px 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .date-heading-text {
            font-size: 15px;
            font-weight: 900;
            color: #0f172a;
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .day-badge {
            font-size: 13px;
            font-weight: 700;
            color: #1e293b;
          }
          .date-sub-badge {
            font-size: 12px;
            font-weight: 700;
            color: #0f172a;
            background: #ffffff;
            border: 1px solid #94a3b8;
            padding: 3px 10px;
            border-radius: 4px;
          }

          /* 2. Table: Rakam first, Vigat next */
          table.expense-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
          }
          table.expense-table th {
            background: #f8fafc;
            border-bottom: 1.5px solid #0f172a;
            border-right: 1px solid #cbd5e1;
            padding: 8px 10px;
            font-weight: 800;
            color: #0f172a;
          }
          table.expense-table th:last-child {
            border-right: none;
          }
          table.expense-table td {
            border-bottom: 1px solid #cbd5e1;
            border-right: 1px solid #cbd5e1;
            padding: 7px 10px;
            vertical-align: middle;
          }
          table.expense-table td:last-child {
            border-right: none;
          }
          table.expense-table tbody tr:nth-child(even) {
            background: #fdfdfd;
          }

          .col-idx {
            width: 45px;
            text-align: center;
            color: #475569;
            font-weight: bold;
          }
          /* PEHLE RAKAM LIKHI HUYI HO */
          .col-amount {
            width: 150px;
            text-align: right;
            font-weight: 900;
            font-size: 14.5px;
            color: #000000;
            white-space: nowrap;
            background: #fffdf5;
            padding-right: 14px;
          }
          /* PAS ME USKI VIGAT (KHATA JOINED) */
          .col-vigat {
            padding: 8px 12px;
          }
          .vigat-main {
            font-weight: 700;
            font-size: 13.5px;
            color: #0f172a;
            line-height: 1.4;
          }
          .khata-badge {
            display: inline-block;
            background: #f1f5f9;
            border: 1px solid #cbd5e1;
            padding: 1px 7px;
            border-radius: 4px;
            font-size: 11.5px;
            font-weight: 700;
            color: #1e293b;
            margin-left: 6px;
          }
          .vigat-remarks {
            font-size: 11.5px;
            color: #475569;
            margin-top: 3px;
            font-weight: 500;
          }

          /* Date Subtotal */
          tr.date-subtotal-row td {
            background: #f1f5f9;
            border-top: 1.5px solid #0f172a;
            border-bottom: none;
            font-weight: 800;
            padding: 8px 10px;
          }
          .date-subtotal-amount {
            text-align: right;
            font-size: 14.5px;
            font-weight: 900;
            color: #000000;
            background: #fef08a !important;
            padding-right: 14px;
          }
          .date-subtotal-label {
            font-weight: 800;
            color: #0f172a;
            padding-left: 12px;
          }
        </style>
      </head>
      <body>
        <!-- Toolbar for Screen Mode (hidden when printing) -->
        <div class="print-toolbar no-print">
          <div class="print-toolbar-title">🖨️ ખર્ચ પ્રિન્ટ પ્રિવ્યૂ</div>
          <div class="print-toolbar-actions">
            <button class="btn-do-print" onclick="window.print()">
              <span>🖨️</span> <span>પ્રિન્ટ કાઢો</span>
            </button>
            <button class="btn-do-close" onclick="window.close()">
              <span>✕</span> <span>બંધ કરો</span>
            </button>
          </div>
        </div>

        <!-- Date-Wise Expense Blocks -->
        ${dateSectionsHtml}

        <script>
          window.addEventListener('load', function() {
            setTimeout(function() {
              window.print();
            }, 350);
          });
        </script>
      </body>
      </html>
    `;
  },

  printExpenseDiaryList() {
    if (!this.record) return;
    const items = this.record.expenseItems || [];
    const dateInfo = this.formatDateHeaderForPrint(this.currentDate);
    const html = this.generateDateWiseExpensePrintHtml({
      title: 'દૈનિક ખર્ચ ડાયરી પત્રક',
      subtitle: `તારીખ: ${dateInfo.formattedDate} (${dateInfo.guDay})`,
      items: items,
      grandTotal: items.reduce((s, it) => s + (Number(it.amount) || 0), 0)
    });
    this.openPrintWindow(html);
  },

  // Open Exact Print Preview Modal
  openPrintPreviewModal() {
    this.populateExactExcelPrintDOM();
    this.openModal('modal-print-preview');

    const previewContainer = document.getElementById('preview-table-box');
    const exactSheet = document.getElementById('excel-exact-sheet');
    const tableEl = exactSheet?.querySelector('#print-excel-table');
    if (previewContainer && tableEl) {
      const clone = tableEl.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      previewContainer.innerHTML = '';
      previewContainer.appendChild(clone);
    }
    this.applyOffsetsToCSS();
  },

  // Trigger Print (Exact Excel Size & Position)
  triggerPrint() {
    this.populateExactExcelPrintDOM();
    this.applyOffsetsToCSS();
    setTimeout(() => {
      window.print();
    }, 60);

    // Auto save report copy to disk mimicking VBA
    const printHtml = document.getElementById('excel-exact-sheet').innerHTML;
    fetch('/api/save-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: this.currentDate,
        htmlContent: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>HISAB ${this.currentDate}</title><style>${document.querySelector('link[href*="print.css"]').outerHTML}</style></head><body><div id="excel-exact-sheet" style="display:block; position:absolute; top:${this.printTopOffset}mm; left:${this.printLeftOffset}mm;">${printHtml}</div></body></html>`
      })
    }).catch(e => console.log('Disk report auto-save err:', e));
  },

  // WhatsApp Share
  async shareWhatsApp() {
    if (!this.record) return;
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const phone = this.settings.phone || '9574527642';
    const org = this.settings.orgName || (isEn ? 'Daily Cash Register' : 'દૈનિક રોકડ હિસાબ');
    const dateFormatted = new Date(this.currentDate + 'T00:00:00').toLocaleDateString(isEn ? 'en-IN' : 'gu-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    let msg = `🏛️ *${org}*\n`;
    msg += `📅 *${isEn ? 'Date' : 'તારીખ'}:* ${dateFormatted}\n\n`;

    msg += isEn ? `💵 *CASH ACCOUNT:*\n` : `💵 *રોકડ હિસાબ:*\n`;
    (this.record.notes || []).forEach(n => {
      if (n.count > 0) {
        msg += `• ₹${n.note} × ${n.count} = ₹${n.amount.toLocaleString('en-IN')}\n`;
      }
    });
    msg += isEn
      ? `*👉 CASH TOTAL: ₹${this.record.cashTotal.toLocaleString('en-IN')}* (Total Notes: ${this.record.noteCountTotal})\n\n`
      : `*👉 CASH TOTAL: ₹${this.record.cashTotal.toLocaleString('en-IN')}* (કુલ નોટો: ${this.record.noteCountTotal})\n\n`;

    if (this.record.banks && this.record.banks.length > 0) {
      msg += isEn ? `🏦 *BANK TRANSFER:*\n` : `🏦 *બેંક ટ્રાન્સફર:*\n`;
      this.record.banks.forEach(b => {
        if (b.amount > 0) {
          msg += `• ${b.name}: ₹${Number(b.amount).toLocaleString('en-IN')}\n`;
        }
      });
      msg += `*👉 BANK TOTAL: ₹${this.record.bankTotal.toLocaleString('en-IN')}*\n\n`;
    }

    if (this.record.vouchers && this.record.vouchers.length > 0) {
      msg += isEn ? `🧾 *VOUCHER EXPENSES:*\n` : `🧾 *વાઉચર ખર્ચ:*\n`;
      this.record.vouchers.forEach(v => {
        if (v.amount > 0) {
          const gujName = this.getKhataNameInGujarati(v.name);
          const vDispName = isEn ? (this.getEnglishKhataName(v.name) || v.name) : (gujName || v.name);
          msg += `• ${vDispName}: ₹${Number(v.amount).toLocaleString('en-IN')}\n`;
        }
      });
      msg += isEn
        ? `*👉 VOUCHER TOTAL: ₹${this.record.voucherTotal.toLocaleString('en-IN')}*\n\n`
        : `*👉 વાઉચર ખર્ચ કુલ: ₹${this.record.voucherTotal.toLocaleString('en-IN')}*\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += isEn
      ? `💰 *GRAND TOTAL: ₹${this.record.grandTotal.toLocaleString('en-IN')}*\n`
      : `💰 *કુલ સરવાળો: ₹${this.record.grandTotal.toLocaleString('en-IN')}*\n`;
    msg += isEn
      ? `📝 *In Words:* ${typeof NumberToWords !== 'undefined' ? NumberToWords.toWords(this.record.grandTotal) : ''}\n`
      : `📝 *શબ્દોમાં:* ${typeof NumberToWords !== 'undefined' ? NumberToWords.toGujarati(this.record.grandTotal) : ''}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;

    if (this.record.remarks) {
      msg += `📌 *${isEn ? 'Note' : 'વિશેષ નોંધ'}:* ${this.record.remarks}\n`;
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const fullPhone = cleanPhone.length === 10 ? '91' + cleanPhone : cleanPhone;
    const waUrl = `https://wa.me/${fullPhone}?text=${encodeURIComponent(msg)}`;

    if (typeof html2pdf !== 'undefined') {
      try {
        this.populateExactExcelPrintDOM();
        const sheet = document.getElementById('excel-exact-sheet');
        if (sheet) {
          this.showToast(isEn ? '⏳ Generating PDF report...' : '⏳ પ્રિન્ટ રિપોર્ટ PDF તૈયાર થઈ રહી છે...', 'info');
          const fileName = `HISAB_${this.currentDate}.pdf`;
          const clone = sheet.cloneNode(true);
          clone.style.display = 'block';
          clone.style.position = 'fixed';
          clone.style.left = '-9999px';
          clone.style.top = '0';
          clone.style.background = '#ffffff';
          clone.style.transform = 'none';
          document.body.appendChild(clone);

          const opt = {
            margin: [this.printTopOffset || 8, this.printLeftOffset || 8, 8, 8],
            filename: fileName,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, letterRendering: true, logging: false },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
          };

          const pdfBlob = await html2pdf().set(opt).from(clone).output('blob');
          document.body.removeChild(clone);

          const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });
          if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
            try {
              await navigator.share({
                files: [pdfFile],
                title: `દૈનિક હિસાબ - ${this.currentDate}`,
                text: msg
              });
              this.showToast('✅ હિસાબ રિપોર્ટ PDF વોટ્સએપ પર શેર થઈ ગઈ!', 'success');
              return;
            } catch (shareErr) {
              if (shareErr.name === 'AbortError') return;
            }
          }

          const blobUrl = URL.createObjectURL(pdfBlob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          }, 1000);

          window.open(waUrl, '_blank');
          this.showToast('📄 હિસાબ રિપોર્ટ PDF ડાઉનલોડ થઈ ગઈ છે! વોટ્સએપમાં 📎 Document તરીકે મોકલો.', 'success');
          return;
        }
      } catch (e) {
        console.warn('PDF generation err in shareWhatsApp:', e);
      }
    }

    window.open(waUrl, '_blank');
  },

  // Excel Import
  async handleExcelUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('date', this.currentDate);

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    try {
      const res = await fetch('/api/import/excel', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        this.record = data.record;
        this.normalizeRecordStructure();
        this.renderRecord();
        this.showToast(i18n.t('importSuccess'), 'success');
      } else {
        this.showToast((isEn ? 'Import failed: ' : 'આયાત નિષ્ફળ: ') + (data.error || (isEn ? 'Error' : 'ક્ષતિ')), 'error');
      }
    } catch (err) {
      this.showToast((isEn ? 'Upload problem: ' : 'અપલોડમાં સમસ્યા: ') + err.message, 'error');
    } finally {
      e.target.value = '';
    }
  },

  historyMode: 'all',
  allHistoryRecords: [],
  historySelectedMonth: '',
  historyDisplayedMonths: [],
  historyFilterMode: 'month',
  historyShowCalendarGrid: false,
  historySelectedFY: '2026-2027',
  historyCalendarScope: 'single',

  getFinancialYearFromDate(dateStr) {
    if (!dateStr) return '2026-2027';
    const [yearStr, monthStr] = dateStr.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    return month >= 4 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
  },

  getAvailableFinancialYears() {
    const yearsSet = new Set();
    const todayFY = this.getFinancialYearFromDate(this.getTodayDateStr());
    yearsSet.add(todayFY);

    (this.allHistoryRecords || []).forEach(r => {
      if (r && r.date) {
        yearsSet.add(this.getFinancialYearFromDate(r.date));
      }
    });

    const curStartYear = parseInt(todayFY.split('-')[0], 10);
    for (let i = 0; i < 4; i++) {
      const y = curStartYear - i;
      yearsSet.add(`${y}-${y + 1}`);
    }

    return Array.from(yearsSet).sort().reverse();
  },

  populateFinancialYearDropdown() {
    const fySelect = document.getElementById('hist-fy-select');
    if (!fySelect) return;

    const availableFYs = this.getAvailableFinancialYears();
    const todayFY = this.getFinancialYearFromDate(this.getTodayDateStr());
    if (!this.historySelectedFY) {
      this.historySelectedFY = todayFY;
    }

    let optionsHtml = '';
    availableFYs.forEach(fy => {
      const [start, end] = fy.split('-');
      const isCur = fy === todayFY;
      const label = `FY ${start}-${end.slice(2)} ${isCur ? '(ચાલુ વર્ષ)' : ''}`;
      const selected = fy === this.historySelectedFY ? 'selected' : '';
      optionsHtml += `<option value="${fy}" ${selected}>${label}</option>`;
    });
    optionsHtml += `<option value="all" ${this.historySelectedFY === 'all' ? 'selected' : ''}>તમામ વર્ષો</option>`;

    fySelect.innerHTML = optionsHtml;
  },

  onHistoryFinancialYearChange(newFY) {
    this.historySelectedFY = newFY;
    const todayStr = this.getTodayDateStr();

    if (newFY === 'all') {
      if (this.allHistoryRecords && this.allHistoryRecords.length > 0) {
        const sorted = [...this.allHistoryRecords].sort((a, b) => a.date.localeCompare(b.date));
        this.historyStartDate = sorted[0].date;
        this.historyEndDate = sorted[sorted.length - 1].date;
      } else {
        this.historyStartDate = '2020-04-01';
        this.historyEndDate = todayStr;
      }
      this.historyFilterMode = 'all_months';
    } else {
      const [startYear, endYear] = newFY.split('-').map(Number);
      const fyStart = `${startYear}-04-01`;
      let fyEnd = `${endYear}-03-31`;
      if (fyEnd > todayStr) {
        fyEnd = todayStr;
      }
      this.historyStartDate = fyStart;
      this.historyEndDate = fyEnd;
      this.historyFilterMode = 'range';
    }

    const startInp = document.getElementById('hist-start-date');
    const endInp = document.getElementById('hist-end-date');
    if (startInp) startInp.value = this.historyStartDate;
    if (endInp) endInp.value = this.historyEndDate;

    this.renderHistoryTable();
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    const fyLabel = newFY === 'all'
      ? (isEn ? 'All Years' : 'તમામ વર્ષો')
      : `FY ${newFY.split('-')[0]}-${newFY.split('-')[1].slice(2)}`;
    this.showToast(isEn
      ? `Financial Year: ${fyLabel} - Full year record (${this.historyStartDate} to ${this.historyEndDate}) loaded`
      : `નાણાકીય વર્ષ: ${fyLabel} - આખા વર્ષનો હિસાબ (${this.historyStartDate} થી ${this.historyEndDate}) લોડ થયો`, 'success');
  },

  onExpenseFinancialYearChange(selectedFY) {
    if (!selectedFY || selectedFY === 'all') {
      this.setExpenseDatePreset('all');
      return;
    }
    const [fyStart, fyEnd] = selectedFY.split('-').map(Number);
    const fromInput = document.getElementById('exp-filter-from');
    const toInput = document.getElementById('exp-filter-to');
    const today = this.getTodayDateStr();
    const fyEndLimit = `${fyEnd}-03-31`;
    if (fromInput) fromInput.value = `${fyStart}-04-01`;
    if (toInput) toInput.value = today < fyEndLimit ? today : fyEndLimit;

    document.querySelectorAll('.preset-chips-group .preset-chip-btn').forEach(btn => btn.classList.remove('active'));

    this.applyExpenseFilter();
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    this.showToast(isEn ? `Loaded FY ${fyStart}-${fyEnd.toString().slice(2)} expense report` : `FY ${fyStart}-${fyEnd.toString().slice(2)} નો ખર્ચ રિપોર્ટ લોડ થયો`);
  },

  switchHistoryMode(mode) {
    this.historyMode = mode;
    this.updateHistoryModeButtons();
    this.renderHistoryTable();
  },

  openSpecificCalendar(mode) {
    this.switchHistoryMode(mode);
  },

  showHistoryTableView() {
    this.renderHistoryTable();
  },

  toggleHistoryViewMode() {
    this.renderHistoryTable();
  },

  updateHistoryModeButtons() {
    const isAll = (this.historyMode || 'all') === 'all';
    const btnAll = document.getElementById('btn-hist-cal-all');
    const btnCash = document.getElementById('btn-hist-cal-cash');
    if (btnAll) btnAll.classList.toggle('active-all', isAll);
    if (btnCash) btnCash.classList.toggle('active-cash', !isAll);
  },

  jumpHistoryToToday() {
    const today = this.getTodayDateStr();
    const todayMonth = today.slice(0, 7);
    this.onHistoryMonthChange(todayMonth);
  },

  // History Modal
  async openHistoryModal() {
    await this.flushPendingSave();
    this.openModal('modal-history');

    const todayStr = this.getTodayDateStr();
    const currentMonth = this.currentDate ? this.currentDate.slice(0, 7) : todayStr.slice(0, 7);
    this.historySelectedMonth = currentMonth;
    this.historyDisplayedMonths = [currentMonth];
    this.historyFilterMode = 'range';

    const currentFY = this.getFinancialYearFromDate(this.currentDate || todayStr);
    if (!this.historySelectedFY) {
      this.historySelectedFY = currentFY;
    }

    // Pure list table ledger view
    const tableWrapper = document.getElementById('history-table-wrapper');
    if (tableWrapper) tableWrapper.style.display = 'block';

    const tableBar = document.getElementById('hist-table-range-bar');
    const fyWrap = document.getElementById('hist-fy-wrapper');
    if (tableBar) tableBar.style.display = 'flex';
    if (fyWrap) fyWrap.style.display = 'flex';

    this.updateHistoryModeButtons();

    const tbody = document.getElementById('history-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 20px;">લોડ થઈ રહ્યું છે...</td></tr>';

    try {
      const [recRes, depRes] = await Promise.all([
        fetch('/api/records'),
        fetch('/api/bank-deposits')
      ]);
      const list = await recRes.json();
      const depData = await depRes.json();
      this.allHistoryRecords = Array.isArray(list) ? list : [];
      this.allBankDeposits = (depData && Array.isArray(depData.deposits)) ? depData.deposits : [];

      // If current month has NO records, select latest month that has records
      if (this.allHistoryRecords.length > 0) {
        const hasRecordsInCurrent = this.allHistoryRecords.some(r => r.date && r.date.startsWith(this.historySelectedMonth));
        if (!hasRecordsInCurrent) {
          const sorted = [...this.allHistoryRecords].sort((a, b) => b.date.localeCompare(a.date));
          if (sorted[0] && sorted[0].date) {
            this.historySelectedMonth = sorted[0].date.slice(0, 7);
            this.historyDisplayedMonths = [this.historySelectedMonth];
          }
        }
      }

      // Default start and end date to the selected active month range (or today)
      if (!this.historyStartDate || !this.historyEndDate) {
        const curM = this.historySelectedMonth || todayStr.slice(0, 7);
        const [cy, cm] = curM.split('-').map(Number);
        const lastDay = new Date(cy, cm, 0).getDate();
        this.historyStartDate = `${curM}-01`;
        this.historyEndDate = `${curM}-${String(lastDay).padStart(2, '0')}`;
        if (this.historyEndDate > todayStr) this.historyEndDate = todayStr;
      }

      const startInp = document.getElementById('hist-start-date');
      const endInp = document.getElementById('hist-end-date');
      if (startInp) startInp.value = this.historyStartDate;
      if (endInp) endInp.value = this.historyEndDate;

      this.populateFinancialYearDropdown();
      this.renderHistoryTable();
    } catch (e) {
      console.error('Error loading history:', e);
      if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--rose); padding: 20px;">રેકોર્ડ લોડ કરવામાં ભૂલ આવી</td></tr>';
    }
  },

  onHistoryDateRangeChange() {
    const startInp = document.getElementById('hist-start-date');
    const endInp = document.getElementById('hist-end-date');
    if (startInp) this.historyStartDate = startInp.value;
    if (endInp) this.historyEndDate = endInp.value;

    if (this.historyStartDate && this.historyEndDate && this.historyStartDate > this.historyEndDate) {
      const isEn = window.i18n && window.i18n.currentLang === 'en';
      this.showToast(isEn ? 'Start date cannot be after end date!' : 'શરૂઆત તારીખ અંતિમ તારીખ કરતાં મોટી ન હોઈ શકે!', 'warning');
      const temp = this.historyStartDate;
      this.historyStartDate = this.historyEndDate;
      this.historyEndDate = temp;
      if (startInp) startInp.value = this.historyStartDate;
      if (endInp) endInp.value = this.historyEndDate;
    }

    if (this.historyStartDate) {
      this.historySelectedMonth = this.historyStartDate.slice(0, 7);
    }

    this.renderHistoryTable();
  },

  setHistoryDateRangePreset(preset) {
    const today = this.getTodayDateStr();
    const [y, m, d] = today.split('-').map(Number);
    let start = '';
    let end = '';

    if (preset === 'month') {
      const curM = this.historySelectedMonth || today.slice(0, 7);
      const [cy, cm] = curM.split('-').map(Number);
      const lastDay = new Date(cy, cm, 0).getDate();
      start = `${curM}-01`;
      end = `${curM}-${String(lastDay).padStart(2, '0')}`;
      if (end > today) end = today;
    } else if (preset === 'prev_month') {
      const curM = this.historySelectedMonth || today.slice(0, 7);
      const [cy, cm] = curM.split('-').map(Number);
      const prevD = new Date(cy, cm - 2, 1);
      const prevY = prevD.getFullYear();
      const prevM = String(prevD.getMonth() + 1).padStart(2, '0');
      const lastDay = new Date(prevY, prevD.getMonth() + 1, 0).getDate();
      start = `${prevY}-${prevM}-01`;
      end = `${prevY}-${prevM}-${String(lastDay).padStart(2, '0')}`;
      this.historySelectedMonth = `${prevY}-${prevM}`;
    } else if (preset === '30days') {
      end = today;
      const prev30 = new Date(y, m - 1, d - 29);
      start = `${prev30.getFullYear()}-${String(prev30.getMonth() + 1).padStart(2, '0')}-${String(prev30.getDate()).padStart(2, '0')}`;
    } else if (preset === 'all') {
      if (this.allHistoryRecords && this.allHistoryRecords.length > 0) {
        const sorted = [...this.allHistoryRecords].sort((a, b) => a.date.localeCompare(b.date));
        start = sorted[0].date;
        end = sorted[sorted.length - 1].date;
      } else {
        start = `${y}-01-01`;
        end = today;
      }
    }

    this.historyStartDate = start;
    this.historyEndDate = end;

    const startInp = document.getElementById('hist-start-date');
    const endInp = document.getElementById('hist-end-date');
    if (startInp) startInp.value = start;
    if (endInp) endInp.value = end;

    this.onHistoryDateRangeChange();
  },

  updateHistoryPresetButtons(activeKey) {
    // Safe no-op
  },

  onHistoryMonthChange(newMonth) {
    if (!newMonth) return;
    const maxMonth = this.getTodayDateStr().slice(0, 7);
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (newMonth > maxMonth) {
      this.showToast(isEn ? 'Future month record not available!' : 'ભવિષ્યના મહિનાનો હિસાબ ઉપલબ્ધ નથી!', 'warning');
      newMonth = maxMonth;
    }

    // Automatically update selected FY if new month belongs to a different FY
    const inferredFY = this.getFinancialYearFromDate(`${newMonth}-01`);
    if (this.historySelectedFY !== 'all' && this.historySelectedFY !== inferredFY) {
      this.historySelectedFY = inferredFY;
      const fySelect = document.getElementById('hist-fy-select');
      if (fySelect) fySelect.value = inferredFY;
    }

    this.historySelectedMonth = newMonth;
    this.historyDisplayedMonths = [newMonth];
    this.historyFilterMode = 'month';

    const monthInput = document.getElementById('hist-month-input');
    if (monthInput) monthInput.value = newMonth;

    this.renderHistoryTable();
  },

  navigateHistoryMonth(dir) {
    if (!this.historySelectedMonth) {
      this.historySelectedMonth = this.getTodayDateStr().slice(0, 7);
    }
    const [y, m] = this.historySelectedMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    const nextM = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const maxM = this.getTodayDateStr().slice(0, 7);
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (nextM > maxM) {
      this.showToast(isEn ? 'Future month record not available!' : 'ભવિષ્યના મહિનાનો હિસાબ ઉપલબ્ધ નથી!', 'warning');
      return;
    }
    this.onHistoryMonthChange(nextM);
  },

  jumpHistoryToSpecificDate(dateVal) {
    if (!dateVal) return;
    this.setDateAndLoad(dateVal);
    this.closeModal('modal-history');
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    this.showToast(isEn ? `Loaded date: ${dateVal}` : `તારીખ ${dateVal} નો હિસાબ ખોલ્યો`, 'success');
  },

  renderHistoryTable() {
    const tbody = document.getElementById('history-tbody');
    const thead = document.getElementById('history-thead');
    const tfoot = document.getElementById('history-tfoot');
    const countEl = document.getElementById('history-summary-count');

    if (!tbody) return;

    // Map existing records for quick lookup
    const existingMap = new Map();
    (this.allHistoryRecords || []).forEach(r => {
      if (r && r.date) existingMap.set(r.date, r);
    });

    let list = [];
    if (this.historyStartDate && this.historyEndDate) {
      const startD = new Date(this.historyStartDate + 'T00:00:00');
      const endD = new Date(this.historyEndDate + 'T00:00:00');
      const cur = new Date(startD);
      const defaultNotes = this.settings?.notes || [500, 200, 100, 50, 20, 10];

      while (cur <= endD) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, '0');
        const d = String(cur.getDate()).padStart(2, '0');
        const dStr = `${y}-${m}-${d}`;

        if (existingMap.has(dStr)) {
          list.push(existingMap.get(dStr));
        } else {
          // If a day has no record saved or is all 0, show it with all 0s
          list.push({
            date: dStr,
            notes: defaultNotes.map(n => ({ note: n, count: 0, amount: 0 })),
            cashTotal: 0,
            bankTotal: 0,
            voucherTotal: 0,
            grandTotal: 0,
            noteCountTotal: 0,
            banksCount: 0,
            vouchersCount: 0,
            updatedAt: dStr
          });
        }
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      list = [...(this.allHistoryRecords || [])];
      if (this.historySelectedFY && this.historySelectedFY !== 'all') {
        const [fyStart, fyEnd] = this.historySelectedFY.split('-').map(Number);
        const minDate = `${fyStart}-04-01`;
        const maxDate = `${fyEnd}-03-31`;
        list = list.filter(r => r.date >= minDate && r.date <= maxDate);
      }
    }

    const fyTitle = this.historySelectedFY === 'all' ? 'તમામ વર્ષો' : `FY ${this.historySelectedFY.split('-')[0]}-${this.historySelectedFY.split('-')[1].slice(2)}`;
    const monthTitle = this.getGujaratiMonthName(this.historySelectedMonth);

    if (countEl) {
      const isFY = this.historySelectedFY && this.historySelectedFY !== 'all' && this.historyStartDate === `${this.historySelectedFY.split('-')[0]}-04-01`;
      const rangeLabel = isFY
        ? fyTitle
        : ((this.historyStartDate && this.historyEndDate)
          ? `${this.historyStartDate} થી ${this.historyEndDate}`
          : (this.historyFilterMode === 'all_months' ? fyTitle : `${monthTitle} (${fyTitle})`));
      countEl.textContent = `કુલ: ${list.length} દિવસો | ${rangeLabel}`;
    }

    if (!list || list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 25px; color: #94a3b8;">આ સમયગાળા માટે કોઈ હિસાબ મળ્યો નથી</td></tr>`;
      if (tfoot) tfoot.innerHTML = '';
      return;
    }

    // Sort descending by date (latest first)
    list.sort((a, b) => b.date.localeCompare(a.date));

    let totCash = 0;
    let totBank = 0;
    let totVoucher = 0;
    let totGrand = 0;
    let totNotes = 0;
    let tot500 = 0, tot200 = 0, tot100 = 0, tot50 = 0, tot20 = 0, tot10 = 0;

    // Filter deposits for current active date range
    const periodDeposits = (this.allBankDeposits || []).filter(d => {
      const dDate = d.depositDate;
      if (!dDate) return false;
      if (this.historyStartDate && dDate < this.historyStartDate) return false;
      if (this.historyEndDate && dDate > this.historyEndDate) return false;
      return true;
    });
    const totDeposited = periodDeposits.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

    const getDepositHtmlForDate = (dateStr) => {
      const deposits = (this.allBankDeposits || []).filter(d => d.depositDate === dateStr);
      if (!deposits || deposits.length === 0) {
        return `<span style="color: #cbd5e1; font-weight: 600;">—</span>`;
      }
      return deposits.map(d => `
        <div style="background: #ffffff; border: 1.5px solid #16a34a; border-radius: 6px; padding: 4px 8px; margin-bottom: 3px; text-align: left;" title="બેંક જમા: ${d.bankName} | ${d.fromDate} થી ${d.toDate}">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <span style="font-weight: 800; color: #15803d; font-size: 0.83rem;">🏦 ${d.bankName || 'બેંક'}</span>
            <span style="font-weight: 900; color: #047857; font-size: 0.88rem;">₹ ${Number(d.amount).toLocaleString('en-IN')}</span>
          </div>
          <div style="font-size: 0.74rem; color: #166534; font-weight: 700;">
            📅 ${d.fromDate} થી ${d.toDate} (${d.daysCount || '-'} દિવસ)
          </div>
        </div>
      `).join('');
    };

    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    if (this.historyMode === 'cash') {
      if (thead) {
        thead.innerHTML = `
          <tr>
            <th style="padding: 10px 12px; font-weight: 800; font-size: 0.85rem;">${isEn ? 'Date' : 'તારીખ'}</th>
            <th style="padding: 10px 12px; font-weight: 800; font-size: 0.88rem; text-align: right; color: #15803d;">${isEn ? 'Total Cash (₹)' : 'કુલ રોકડ (₹)'}</th>
            <th style="padding: 10px 8px; font-weight: 800; font-size: 0.83rem; text-align: center; background: #eff6ff;">₹ 500</th>
            <th style="padding: 10px 8px; font-weight: 800; font-size: 0.83rem; text-align: center; background: #f0fdf4;">₹ 200</th>
            <th style="padding: 10px 8px; font-weight: 800; font-size: 0.83rem; text-align: center; background: #fff7ed;">₹ 100</th>
            <th style="padding: 10px 8px; font-weight: 800; font-size: 0.83rem; text-align: center; background: #fefce8;">₹ 50</th>
            <th style="padding: 10px 8px; font-weight: 800; font-size: 0.83rem; text-align: center; background: #faf5ff;">₹ 20</th>
            <th style="padding: 10px 8px; font-weight: 800; font-size: 0.83rem; text-align: center; background: #f0fdfa;">${isEn ? '₹ 10/Coins' : '₹ 10/સિક્કા'}</th>
            <th style="padding: 10px 10px; font-weight: 800; font-size: 0.85rem; text-align: center;">${isEn ? 'Total Notes' : 'કુલ નોટો'}</th>
            <th style="padding: 10px 12px; font-weight: 800; font-size: 0.85rem; text-align: left; background: #ecfdf5; color: #166534;">${isEn ? '🏦 Bank Deposit' : '🏦 બેંક જમા'}</th>
          </tr>
        `;
      }

      tbody.innerHTML = '';
      list.forEach(item => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.title = 'આ તારીખનો હિસાબ ખોલવા ક્લિક કરો';
        tr.onclick = () => {
          this.setDateAndLoad(item.date);
          this.closeModal('modal-history');
        };

        const notes = item.notes || [];
        const getNoteCell = (val) => {
          const found = notes.find(n => Number(n.note) === val);
          if (!found || !found.count) {
            return `<span style="color: #94a3b8; font-weight: 700;">0</span>`;
          }
          return `<div style="font-weight: 800; color: #1e3a8a; font-size: 0.85rem;">${found.count} <small style="font-weight: 600; color: #64748b;">${isEn ? 'pcs' : 'નંગ'}</small></div><div style="font-size: 0.75rem; font-weight: 800; color: #15803d;">₹ ${found.amount.toLocaleString('en-IN')}</div>`;
        };

        const getCountOnly = (val) => {
          const found = notes.find(n => Number(n.note) === val);
          return found ? Number(found.count) || 0 : 0;
        };

        const c500 = getCountOnly(500), c200 = getCountOnly(200), c100 = getCountOnly(100), c50 = getCountOnly(50), c20 = getCountOnly(20), c10 = getCountOnly(10);
        tot500 += c500; tot200 += c200; tot100 += c100; tot50 += c50; tot20 += c20; tot10 += c10;
        const nCount = item.noteCountTotal || (c500 + c200 + c100 + c50 + c20 + c10);
        totNotes += nCount;
        const cAmt = Number(item.cashTotal) || 0;
        totCash += cAmt;

        tr.innerHTML = `
          <td style="padding: 10px 12px;"><strong>${item.date}</strong></td>
          <td style="text-align: right;"><strong style="color: #15803d; font-size: 1.05rem; font-weight: 900;">₹ ${cAmt.toLocaleString('en-IN')}</strong></td>
          <td style="text-align: center; background: #eff6ff;">${getNoteCell(500)}</td>
          <td style="text-align: center; background: #f0fdf4;">${getNoteCell(200)}</td>
          <td style="text-align: center; background: #fff7ed;">${getNoteCell(100)}</td>
          <td style="text-align: center; background: #fefce8;">${getNoteCell(50)}</td>
          <td style="text-align: center; background: #faf5ff;">${getNoteCell(20)}</td>
          <td style="text-align: center; background: #f0fdfa;">${getNoteCell(10)}</td>
          <td style="text-align: center; font-weight: 800; color: #475569;">${nCount} ${isEn ? 'notes' : 'નંગ'}</td>
          <td style="padding: 6px 10px; background: #f0fdf4; border-left: 1px solid #bbf7d0;">${getDepositHtmlForDate(item.date)}</td>
        `;
        tbody.appendChild(tr);
      });

      if (tfoot) {
        tfoot.innerHTML = `
          <tr style="background: #f1f5f9; font-weight: 900; border-top: 2.5px solid #cbd5e1; font-size: 0.95rem;">
            <td style="padding: 12px; color: #0f172a;">કુલ (${list.length} દિવસો)</td>
            <td style="text-align: right; font-weight: 900; color: #15803d; font-family: var(--font-heading); font-size: 1.1rem;">₹ ${totCash.toLocaleString('en-IN')}</td>
            <td style="text-align: center; background: #eff6ff; font-weight: 800;">${tot500}</td>
            <td style="text-align: center; background: #f0fdf4; font-weight: 800;">${tot200}</td>
            <td style="text-align: center; background: #fff7ed; font-weight: 800;">${tot100}</td>
            <td style="text-align: center; background: #fefce8; font-weight: 800;">${tot50}</td>
            <td style="text-align: center; background: #faf5ff; font-weight: 800;">${tot20}</td>
            <td style="text-align: center; background: #f0fdfa; font-weight: 800;">${tot10}</td>
            <td style="text-align: center; font-weight: 900; color: #1e3a8a;">${totNotes} નંગ</td>
            <td style="padding: 12px; text-align: left; background: #ecfdf5; color: #15803d; font-weight: 900;">🏦 જમા: ₹ ${totDeposited.toLocaleString('en-IN')}</td>
          </tr>
        `;
      }
    } else {
      if (thead) {
        thead.innerHTML = `
          <tr>
            <th style="padding: 10px 12px; font-weight: 800; font-size: 0.85rem;">${isEn ? 'Date' : 'તારીખ'}</th>
            <th style="padding: 10px 12px; font-weight: 800; font-size: 0.85rem; text-align: right; color: #1e3a8a;">${isEn ? 'Grand Total (₹)' : 'કુલ સરવાળો (₹)'}</th>
            <th style="padding: 10px 12px; font-weight: 800; font-size: 0.85rem; text-align: right;">${isEn ? 'Cash (₹)' : 'રોકડ (₹)'}</th>
            <th style="padding: 10px 12px; font-weight: 800; font-size: 0.85rem; text-align: right;">${isEn ? 'Bank Transfer (₹)' : 'બેંક ટ્રાન્સફર (₹)'}</th>
            <th style="padding: 10px 12px; font-weight: 800; font-size: 0.85rem; text-align: right;">${isEn ? 'Voucher (₹)' : 'વાઉચર (₹)'}</th>
            <th style="padding: 10px 14px; font-weight: 800; font-size: 0.85rem; text-align: left; background: #ecfdf5; color: #166534;">${isEn ? '🏦 Bank Deposit' : '🏦 બેંક જમા'}</th>
          </tr>
        `;
      }

      tbody.innerHTML = '';
      list.forEach(item => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.title = 'આ તારીખનો હિસાબ ખોલવા ક્લિક કરો';
        tr.onclick = () => {
          this.setDateAndLoad(item.date);
          this.closeModal('modal-history');
        };

        const cAmt = Number(item.cashTotal) || 0;
        const bAmt = Number(item.bankTotal) || 0;
        const vAmt = Number(item.voucherTotal) || 0;
        const gAmt = Number(item.grandTotal) || (cAmt + bAmt + vAmt);

        totCash += cAmt;
        totBank += bAmt;
        totVoucher += vAmt;
        totGrand += gAmt;

        tr.innerHTML = `
          <td style="padding: 10px 12px;"><strong>${item.date}</strong></td>
          <td style="text-align: right;"><strong style="color: #1e3a8a; font-weight: 900; font-size: 1.05rem; font-family: var(--font-heading);">₹ ${gAmt.toLocaleString('en-IN')}</strong></td>
          <td style="text-align: right; color: #15803d; font-weight: 800; font-family: var(--font-heading);">₹ ${cAmt.toLocaleString('en-IN')}</td>
          <td style="text-align: right; color: #0369a1; font-weight: 700; font-family: var(--font-heading);">₹ ${bAmt.toLocaleString('en-IN')}</td>
          <td style="text-align: right; color: #b91c1c; font-weight: 700; font-family: var(--font-heading);">₹ ${vAmt.toLocaleString('en-IN')}</td>
          <td style="padding: 8px 10px; background: #f0fdf4; border-left: 1px solid #bbf7d0;">${getDepositHtmlForDate(item.date)}</td>
        `;
        tbody.appendChild(tr);
      });

      if (tfoot) {
        tfoot.innerHTML = `
          <tr style="background: #f1f5f9; font-weight: 900; border-top: 2.5px solid #cbd5e1; font-size: 0.95rem;">
            <td style="padding: 12px; color: #0f172a;">${isEn ? 'Total' : 'કુલ'} (${list.length} ${isEn ? 'days' : 'દિવસો'})</td>
            <td style="padding: 12px; text-align: right; color: #1e3a8a; font-family: var(--font-heading); font-size: 1.1rem; background: #eff6ff;">₹ ${totGrand.toLocaleString('en-IN')}</td>
            <td style="padding: 12px; text-align: right; color: #15803d; font-family: var(--font-heading);">₹ ${totCash.toLocaleString('en-IN')}</td>
            <td style="padding: 12px; text-align: right; color: #0369a1; font-family: var(--font-heading);">₹ ${totBank.toLocaleString('en-IN')}</td>
            <td style="padding: 12px; text-align: right; color: #b91c1c; font-family: var(--font-heading);">₹ ${totVoucher.toLocaleString('en-IN')}</td>
            <td style="padding: 12px; text-align: left; background: #ecfdf5; color: #15803d; font-family: var(--font-heading); font-weight: 900;">
              ${isEn ? '🏦 Deposit' : '🏦 જમા'}: ₹ ${totDeposited.toLocaleString('en-IN')}
            </td>
          </tr>
        `;
      }
    }
  },

  printHistoryStatement() {
    const existingMap = new Map();
    (this.allHistoryRecords || []).forEach(r => {
      if (r && r.date) existingMap.set(r.date, r);
    });

    let list = [];
    if (this.historyStartDate && this.historyEndDate) {
      const startD = new Date(this.historyStartDate + 'T00:00:00');
      const endD = new Date(this.historyEndDate + 'T00:00:00');
      const cur = new Date(startD);
      const defaultNotes = this.settings?.notes || [500, 200, 100, 50, 20, 10];

      while (cur <= endD) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, '0');
        const d = String(cur.getDate()).padStart(2, '0');
        const dStr = `${y}-${m}-${d}`;

        if (existingMap.has(dStr)) {
          list.push(existingMap.get(dStr));
        } else {
          list.push({
            date: dStr,
            notes: defaultNotes.map(n => ({ note: n, count: 0, amount: 0 })),
            cashTotal: 0,
            bankTotal: 0,
            voucherTotal: 0,
            grandTotal: 0,
            noteCountTotal: 0,
            banksCount: 0,
            vouchersCount: 0,
            updatedAt: dStr
          });
        }
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      list = [...(this.allHistoryRecords || [])];
      if (this.historySelectedFY && this.historySelectedFY !== 'all') {
        const [fyStart, fyEnd] = this.historySelectedFY.split('-').map(Number);
        const minDate = `${fyStart}-04-01`;
        const maxDate = `${fyEnd}-03-31`;
        list = list.filter(r => r.date >= minDate && r.date <= maxDate);
      }
    }

    list.sort((a, b) => a.date.localeCompare(b.date)); // chronological order for print

    const orgName = this.settings.orgName || 'સંસ્થાન હિસાબ';
    const orgSubtitle = this.settings.orgSubtitle || 'દૈનિક રોકડ, બેંક અને વાઉચર હિસાબ પત્રક';
    const monthLabel = this.getGujaratiMonthName(this.historySelectedMonth);
    const fyLabel = this.historySelectedFY === 'all' ? 'તમામ નાણાકીય વર્ષ' : `નાણાકીય વર્ષ ${this.historySelectedFY}`;
    const isFY = this.historySelectedFY && this.historySelectedFY !== 'all' && this.historyStartDate === `${this.historySelectedFY.split('-')[0]}-04-01`;
    const periodTitle = isFY
      ? `નાણાકીય વર્ષ ${this.historySelectedFY} નો સંપૂર્ણ વાર્ષિક હિસાબ (${this.historyStartDate} થી ${this.historyEndDate})`
      : ((this.historyStartDate && this.historyEndDate)
        ? `તારીખ ${this.historyStartDate} થી ${this.historyEndDate}`
        : (this.historyFilterMode === 'all_months' ? fyLabel : `${monthLabel} (${fyLabel})`));

    let totCash = 0, totBank = 0, totVoucher = 0, totGrand = 0;
    let rowsHtml = '';

    const periodDeposits = (this.allBankDeposits || []).filter(d => {
      const dDate = d.depositDate;
      if (!dDate) return false;
      if (this.historyStartDate && dDate < this.historyStartDate) return false;
      if (this.historyEndDate && dDate > this.historyEndDate) return false;
      return true;
    });
    const totDeposited = periodDeposits.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

    if (list.length === 0) {
      rowsHtml = `<tr><td colspan="7" style="text-align:center; padding: 25px; color: #64748b;">આ સમયગાળા માટે કોઈ હિસાબ ઉપલબ્ધ નથી</td></tr>`;
    } else {
      list.forEach((item, idx) => {
        const cAmt = Number(item.cashTotal) || 0;
        const bAmt = Number(item.bankTotal) || 0;
        const vAmt = Number(item.voucherTotal) || 0;
        const gAmt = Number(item.grandTotal) || (cAmt + bAmt + vAmt);
        totCash += cAmt; totBank += bAmt; totVoucher += vAmt; totGrand += gAmt;

        const deposits = (this.allBankDeposits || []).filter(d => d.depositDate === item.date);
        let depPrintText = '<span style="color:#cbd5e1;">-</span>';
        if (deposits.length > 0) {
          depPrintText = deposits.map(d => `<div style="font-size:0.8rem; line-height:1.3;"><strong>🏦 ${d.bankName}</strong>: ₹ ${Number(d.amount).toLocaleString('en-IN')}<br><span style="color:#166534; font-size:0.75rem;">📅 ${d.fromDate} થી ${d.toDate} (${d.daysCount || '-'} દિવસ)</span>${d.slipNo ? `<br><span style="color:#64748b; font-size:0.72rem;">સ્લિપ: ${d.slipNo}</span>` : ''}</div>`).join('<hr style="margin:3px 0; border:none; border-top:1px dashed #cbd5e1;">');
        }

        rowsHtml += `
          <tr>
            <td style="text-align: center; font-weight: 600;">${idx + 1}</td>
            <td style="font-weight: 700;">${item.date}</td>
            <td style="text-align: right; font-weight: 900; color: #1e3a8a; font-size: 1rem;">₹ ${gAmt.toLocaleString('en-IN')}</td>
            <td style="text-align: right; color: #15803d; font-weight: 700;">₹ ${cAmt.toLocaleString('en-IN')}</td>
            <td style="text-align: right; color: #0369a1; font-weight: 700;">₹ ${bAmt.toLocaleString('en-IN')}</td>
            <td style="text-align: right; color: #b91c1c; font-weight: 700;">₹ ${vAmt.toLocaleString('en-IN')}</td>
            <td style="text-align: left; background: #f0fdf4;">${depPrintText}</td>
          </tr>
        `;
      });
    }

    const printHtml = `
      <!DOCTYPE html>
      <html lang="gu">
      <head>
        <meta charset="UTF-8">
        <title>હિસાબ ઇતિહાસ પત્રક - ${periodTitle}</title>
        <style>
          @page { size: A4 landscape; margin: 10mm 12mm; }
          * { box-sizing: border-box; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Gujarati", sans-serif; color: #0f172a; margin: 0; padding: 20px; font-size: 13px; line-height: 1.45; }
          .header-box { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px; }
          .org-title { font-size: 1.55rem; font-weight: 800; color: #1e3a8a; margin: 0; }
          .org-sub { font-size: 0.95rem; color: #475569; margin-top: 2px; font-weight: 600; }
          .slip-title { display: inline-block; margin-top: 8px; background: #f1f5f9; border: 1px solid #cbd5e1; padding: 4px 18px; border-radius: 20px; font-weight: 800; font-size: 0.95rem; }
          .kpi-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 18px; }
          .kpi-box { border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 8px 12px; text-align: center; }
          .kpi-box.kpi-cash { background: #f0fdf4; border-color: #86efac; }
          .kpi-box.kpi-bank { background: #eff6ff; border-color: #93c5fd; }
          .kpi-box.kpi-voucher { background: #fff1f2; border-color: #fecdd3; }
          .kpi-box.kpi-deposit { background: #ecfdf5; border-color: #86efac; }
          .kpi-box.kpi-grand { background: #eef2ff; border-color: #c7d2fe; }
          .kpi-title { font-size: 0.78rem; font-weight: 700; color: #475569; margin-bottom: 2px; }
          .kpi-num { font-size: 1.15rem; font-weight: 900; }
          .table-hisab { width: 100%; border-collapse: collapse; margin-bottom: 25px; }
          .table-hisab th { background: #1e293b; color: #fff; font-weight: 700; padding: 8px 10px; font-size: 0.85rem; border: 1px solid #0f172a; }
          .table-hisab td { padding: 7px 10px; border: 1px solid #cbd5e1; font-size: 0.85rem; }
          .table-hisab tbody tr:nth-child(even) { background: #f8fafc; }
          .footer-summary { background: #f1f5f9; font-weight: 900; }
          .sign-area { display: flex; justify-content: space-between; margin-top: 45px; padding: 0 20px; }
          .sign-box { text-align: center; width: 200px; border-top: 1.5px dashed #475569; padding-top: 8px; font-weight: 800; font-size: 0.88rem; }
          .action-bar-no-print { position: fixed; top: 15px; right: 20px; display: flex; gap: 10px; z-index: 1000; }
          .print-btn { background: #0284c7; color: #fff; border: none; padding: 8px 16px; font-weight: 700; border-radius: 6px; cursor: pointer; }
          .close-btn { background: #475569; color: #fff; border: none; padding: 8px 16px; font-weight: 700; border-radius: 6px; cursor: pointer; }
          @media print { .action-bar-no-print { display: none !important; } body { padding: 0; } }
        </style>
      </head>
      <body>
        <div class="action-bar-no-print">
          <button class="print-btn" onclick="window.print()">🖨️ પ્રિન્ટ કાઢો (Print)</button>
          <button class="close-btn" onclick="window.close()">✕ બંધ કરો</button>
        </div>

        <div class="header-box">
          <h1 class="org-title">${orgName}</h1>
          <div class="org-sub">${orgSubtitle}</div>
          <div class="slip-title">📅 દૈનિક હિસાબ માસિક / વાર્ષિક ખાતાવહી પત્રક - ${periodTitle}</div>
          <div style="font-size: 0.78rem; color: #64748b; margin-top: 6px;">
            કુલ નોંધાયેલ દિવસો: ${list.length} | તારીખ: ${new Date().toLocaleDateString('gu-IN')} | સમય: ${new Date().toLocaleTimeString('gu-IN', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

        <div class="kpi-row">
          <div class="kpi-box kpi-cash">
            <div class="kpi-title">કુલ રોકડ રકમ</div>
            <div class="kpi-num" style="color: #15803d;">₹ ${totCash.toLocaleString('en-IN')}</div>
          </div>
          <div class="kpi-box kpi-bank">
            <div class="kpi-title">કુલ બેંક ટ્રાન્સફર</div>
            <div class="kpi-num" style="color: #0369a1;">₹ ${totBank.toLocaleString('en-IN')}</div>
          </div>
          <div class="kpi-box kpi-voucher">
            <div class="kpi-title">કુલ વાઉચર ખર્ચ</div>
            <div class="kpi-num" style="color: #b91c1c;">₹ ${totVoucher.toLocaleString('en-IN')}</div>
          </div>
          <div class="kpi-box kpi-deposit">
            <div class="kpi-title">🏦 બેંકમાં જમા રોકડ</div>
            <div class="kpi-num" style="color: #166534;">₹ ${totDeposited.toLocaleString('en-IN')}</div>
          </div>
          <div class="kpi-box kpi-grand">
            <div class="kpi-title">કુલ મહાસરવાળો</div>
            <div class="kpi-num" style="color: #4338ca;">₹ ${totGrand.toLocaleString('en-IN')}</div>
          </div>
        </div>

        <table class="table-hisab">
          <thead>
            <tr>
              <th style="width: 40px; text-align: center;">#</th>
              <th style="width: 110px;">તારીખ</th>
              <th style="text-align: right; width: 140px;">દૈનિક સરવાળો (₹)</th>
              <th style="text-align: right; width: 130px;">રોકડ રકમ (₹)</th>
              <th style="text-align: right; width: 130px;">બેંક ટ્રાન્સફર (₹)</th>
              <th style="text-align: right; width: 130px;">વાઉચર ખર્ચ (₹)</th>
              <th style="text-align: left; min-width: 200px; background: #14532d;">🏦 બેંક જમા</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
          <tfoot>
            <tr class="footer-summary">
              <td colspan="2" style="text-align: right; padding: 10px;">કુલ (${list.length} દિવસો):</td>
              <td style="text-align: right; color: #1e3a8a; font-size: 1.05rem;">₹ ${totGrand.toLocaleString('en-IN')}</td>
              <td style="text-align: right; color: #15803d;">₹ ${totCash.toLocaleString('en-IN')}</td>
              <td style="text-align: right; color: #0369a1;">₹ ${totBank.toLocaleString('en-IN')}</td>
              <td style="text-align: right; color: #b91c1c;">₹ ${totVoucher.toLocaleString('en-IN')}</td>
              <td style="text-align: left; color: #15803d; font-weight: 900; background: #ecfdf5;">🏦 જમા: ₹ ${totDeposited.toLocaleString('en-IN')}</td>
            </tr>
          </tfoot>
        </table>

        <div class="sign-area">
          <div class="sign-box">
            હિસાબનીશની સહી<br>
            <span style="font-size: 0.75rem; font-weight: normal; color: #64748b;">(તૈયાર કરનાર)</span>
          </div>
          <div class="sign-box">
            ટ્રસ્ટી / વહીવટકર્તાની સહી<br>
            <span style="font-size: 0.75rem; font-weight: normal; color: #64748b;">(ઓથોરાઇઝ્ડ સિગ્નેચર)</span>
          </div>
        </div>

        <script>
          window.addEventListener('load', () => {
            setTimeout(() => { window.print(); }, 300);
          });
        </script>
      </body>
      </html>
    `;
    this.openPrintWindow(printHtml);
  },

  exportHistoryExcel() {
    const month = this.historyFilterMode === 'all_months' ? '' : (this.historySelectedMonth || '');
    const fy = this.historySelectedFY || 'all';
    const mode = this.historyMode || 'all';
    const startDate = this.historyStartDate || '';
    const endDate = this.historyEndDate || '';
    window.location.href = `/api/export/history-excel?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&month=${encodeURIComponent(month)}&fy=${encodeURIComponent(fy)}&mode=${encodeURIComponent(mode)}`;
  },

  deleteRecord(dateStr) {
    // Audit protection: cannot delete past or saved records
  },

  // Analytics Modal
  openAnalyticsModal() {
    this.openModal('modal-analytics');

    if (window.HisabCharts && typeof HisabCharts.open === 'function') {
      HisabCharts.open(this.record, this.currentDate);
    } else if (window.HisabCharts) {
      HisabCharts.renderBreakdownChart('chart-breakdown-container', this.record);
      HisabCharts.renderComparisonBars('chart-bars-container', this.record);
    }
  },

  // Settings Modal - Consolidated in Admin Panel
  openSettingsModal() {
    this.openAdminModal('general');
  },

  openExportFolder() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    fetch('/api/open-folder', { method: 'POST' })
      .then(res => res.json())
      .then(d => {
        if (d.success) this.showToast(isEn ? `Folder opened: ${d.folder}` : `ફોલ્ડર ખોલવામાં આવ્યું: ${d.folder}`);
      })
      .catch(e => console.warn('Could not open folder', e));
  },

  // =========================================================================
  // VIEW SWITCHING (DAILY HISAB VS COMPLETE EXPENSE LEDGER)
  // =========================================================================
  async switchMainView(viewName) {
    await this.flushPendingSave();
    this.closeAllModals();
    this.currentView = viewName;
    const viewDaily = document.getElementById('view-daily-hisab');
    const viewExpenses = document.getElementById('view-expense-ledger');
    const viewAdmin = document.getElementById('view-admin-dashboard');
    const tabDaily = document.getElementById('tab-btn-daily-hisab');
    const tabExpenses = document.getElementById('tab-btn-expense-report');
    const topHeader = document.querySelector('.top-header');
    const mainViewSwitcher = document.querySelector('.main-view-switcher');
    const floatingUchak = document.getElementById('floating-uchak-toggle');

    if (viewName === 'daily') {
      document.body.classList.remove('admin-mode-active');
      if (topHeader) topHeader.style.display = '';
      if (mainViewSwitcher) mainViewSwitcher.style.display = '';
      if (floatingUchak) floatingUchak.style.display = '';
      if (viewDaily) viewDaily.style.display = 'block';
      if (viewExpenses) viewExpenses.style.display = 'none';
      if (viewAdmin) viewAdmin.style.display = 'none';
      if (tabDaily) tabDaily.classList.add('active');
      if (tabExpenses) tabExpenses.classList.remove('active');
    } else if (viewName === 'expenses') {
      document.body.classList.remove('admin-mode-active');
      if (topHeader) topHeader.style.display = '';
      if (mainViewSwitcher) mainViewSwitcher.style.display = '';
      if (floatingUchak) floatingUchak.style.display = '';
      if (viewDaily) viewDaily.style.display = 'none';
      if (viewExpenses) viewExpenses.style.display = 'block';
      if (viewAdmin) viewAdmin.style.display = 'none';
      if (tabDaily) tabDaily.classList.remove('active');
      if (tabExpenses) tabExpenses.classList.add('active');

      this.initExpenseReportView();
    } else if (viewName === 'admin') {
      document.body.classList.add('admin-mode-active');
      if (topHeader) topHeader.style.display = 'none';
      if (mainViewSwitcher) mainViewSwitcher.style.display = 'none';
      if (floatingUchak) floatingUchak.style.display = 'none';
      if (viewDaily) viewDaily.style.display = 'none';
      if (viewExpenses) viewExpenses.style.display = 'none';
      if (viewAdmin) viewAdmin.style.display = 'block';
      if (tabDaily) tabDaily.classList.remove('active');
      if (tabExpenses) tabExpenses.classList.remove('active');
      // Scroll to top of window
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  },

  initExpenseReportView() {
    // Populate category dropdown dynamically with latest vouchers
    const catSelect = document.getElementById('exp-filter-category');
    if (catSelect) {
      const prevVal = catSelect.value || 'all';
      const allLabel = (i18n.currentLang === 'en') ? '🔍 All Categories' : '🔍 બધા ખાતાઓ';
      catSelect.innerHTML = `<option value="all">${allLabel}</option>`;
      const allCategories = new Set();
      (this.fixedVouchers || []).forEach(v => allCategories.add(v));
      if (this.record && Array.isArray(this.record.vouchers)) {
        this.record.vouchers.forEach(v => {
          if (v && v.name) allCategories.add(v.name);
        });
      }
      allCategories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = `🧾 ${this.getKhataNameInGujarati(cat)}`;
        catSelect.appendChild(opt);
      });
      if ([...catSelect.options].some(o => o.value === prevVal)) {
        catSelect.value = prevVal;
      }
    }

    // Set initial date range if empty (Default: today)
    const fromInp = document.getElementById('exp-filter-from');
    if (fromInp && !fromInp.value) {
      this.setExpenseDatePreset('today', false);
    }
    this.applyExpenseFilter();
  },

  setExpenseDatePreset(preset, triggerApply = true) {
    document.querySelectorAll('.preset-chip-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`chip-preset-${preset}`);
    if (btn) btn.classList.add('active');

    const fromInp = document.getElementById('exp-filter-from');
    const toInp = document.getElementById('exp-filter-to');
    if (!fromInp || !toInp) return;

    const pad = n => String(n).padStart(2, '0');
    const toYMD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const todayObj = new Date();
    const todayStr = this.getTodayDateStr ? this.getTodayDateStr() : toYMD(todayObj);

    if (preset === 'today') {
      fromInp.value = todayStr;
      toInp.value = todayStr;
    } else if (preset === 'yesterday') {
      const y = new Date(todayObj.getFullYear(), todayObj.getMonth(), todayObj.getDate() - 1);
      fromInp.value = toYMD(y);
      toInp.value = toYMD(y);
    } else if (preset === '7days') {
      const d7 = new Date(todayObj.getFullYear(), todayObj.getMonth(), todayObj.getDate() - 6);
      fromInp.value = toYMD(d7);
      toInp.value = todayStr;
    } else if (preset === 'month') {
      const curY = todayObj.getFullYear();
      const curM = todayObj.getMonth();
      fromInp.value = `${curY}-${pad(curM + 1)}-01`;
      toInp.value = todayStr;
    } else if (preset === 'lastmonth') {
      const curY = todayObj.getFullYear();
      const curM = todayObj.getMonth();
      const firstDayLastMonth = new Date(curY, curM - 1, 1);
      const lastDayLastMonth = new Date(curY, curM, 0);
      fromInp.value = toYMD(firstDayLastMonth);
      toInp.value = toYMD(lastDayLastMonth);
    } else if (preset === 'all') {
      fromInp.value = '2020-01-01';
      toInp.value = todayStr;
    }

    if (triggerApply) {
      this.applyExpenseFilter();
    }
  },

  onExpenseFinancialYearChange(fy) {
    const fromInp = document.getElementById('exp-filter-from');
    const toInp = document.getElementById('exp-filter-to');
    if (!fromInp || !toInp) return;

    document.querySelectorAll('.preset-chip-btn').forEach(b => b.classList.remove('active'));

    if (fy === 'all') {
      fromInp.value = '2020-01-01';
      toInp.value = this.getTodayDateStr ? this.getTodayDateStr() : new Date().toISOString().split('T')[0];
    } else {
      const parts = fy.split('-');
      const startYear = parseInt(parts[0], 10);
      const endYear = parts[1] ? parseInt(parts[1], 10) : startYear + 1;
      fromInp.value = `${startYear}-04-01`;
      toInp.value = `${endYear}-03-31`;
    }
    this.applyExpenseFilter();
  },

  async applyExpenseFilter() {
    const fromInp = document.getElementById('exp-filter-from');
    const toInp = document.getElementById('exp-filter-to');
    const catSelect = document.getElementById('exp-filter-category');

    const from = fromInp ? fromInp.value : '';
    const to = toInp ? toInp.value : '';
    const category = catSelect ? catSelect.value : 'all';

    try {
      const res = await fetch(`/api/expenses/report?from=${from}&to=${to}&category=${category}`);
      const data = await res.json();
      this.currentExpenseReport = data;
      this.renderExpenseReportUI(data);
    } catch (e) {
      console.error('Error fetching expense report:', e);
      const isEn = (window.i18n && window.i18n.currentLang === 'en');
      this.showToast(isEn ? 'Error loading expense report' : 'ખર્ચ અહેવાલ લોડ કરવામાં ભૂલ આવી', 'error');
    }
  },

  renderExpenseReportUI(data) {
    if (!data) return;

    // 1. KPI Cards
    const totalEl = document.getElementById('exp-kpi-total');
    if (totalEl) totalEl.textContent = `₹ ${(data.grandTotal || 0).toLocaleString('en-IN')}`;

    const avgEl = document.getElementById('exp-kpi-avg');
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    if (avgEl) avgEl.textContent = isEn ? `₹ ${(data.dailyAverage || 0).toLocaleString('en-IN')} / day` : `₹ ${(data.dailyAverage || 0).toLocaleString('en-IN')} / દિવસ`;

    const highestEl = document.getElementById('exp-kpi-highest');
    if (highestEl) {
      if (data.highestCategory && data.highestCategory.amount > 0) {
        highestEl.textContent = `${this.getKhataNameInGujarati(data.highestCategory.name)} (₹${data.highestCategory.amount.toLocaleString('en-IN')})`;
      } else {
        highestEl.textContent = '-';
      }
    }

    const entriesEl = document.getElementById('exp-kpi-entries');
    if (entriesEl) {
      entriesEl.textContent = isEn
        ? `${data.totalEntries || 0} Entries (${data.daysCount || 0} Days)`
        : `${data.totalEntries || 0} એન્ટ્રીઓ (${data.daysCount || 0} દિવસ)`;
    }

    // 2. Category Breakdown Grid
    const catGrid = document.getElementById('exp-category-breakdown-grid');
    if (catGrid) {
      catGrid.innerHTML = '';
      const catTotals = data.categoryTotals || {};
      const catKeys = Object.keys(catTotals);

      if (catKeys.length === 0) {
        catGrid.innerHTML = '<div style="color: var(--text-muted); padding: 10px;">આ સમયગાળામાં કોઈ ખર્ચ મળ્યો નથી.</div>';
      } else {
        catKeys.sort((a, b) => catTotals[b] - catTotals[a]);
        catKeys.forEach(catName => {
          const amt = catTotals[catName];
          const pct = data.grandTotal > 0 ? Math.round((amt / data.grandTotal) * 100) : 0;

          const card = document.createElement('div');
          card.className = 'cat-breakdown-card';
          card.title = `ક્લિક કરીને માત્ર ${this.getKhataNameInGujarati(catName)} ના ખર્ચ જુઓ`;
          card.onclick = () => {
            const catSel = document.getElementById('exp-filter-category');
            if (catSel) {
              catSel.value = catName;
              this.applyExpenseFilter();
            }
          };
          card.innerHTML = `
            <div class="cat-breakdown-header">
              <span class="cat-breakdown-title">🧾 ${this.getKhataNameInGujarati(catName)}</span>
              <span class="cat-breakdown-amt">₹ ${amt.toLocaleString('en-IN')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--text-muted);">
              <span>હિસ્સો:</span>
              <span style="font-weight: 700; color: #7c3aed;">${pct}%</span>
            </div>
            <div class="cat-progress-bar-bg">
              <div class="cat-progress-bar-fill" style="width: ${Math.max(4, pct)}%;"></div>
            </div>
          `;
          catGrid.appendChild(card);
        });
      }
    }

    // 3. Render Table
    this.renderExpenseTable(data.expenses || []);
  },

  renderExpenseTable(expenses) {
    if (!expenses && this.currentExpenseReport && this.currentExpenseReport.expenses) {
      expenses = this.currentExpenseReport.expenses;
    }
    expenses = expenses || [];
    const tbody = document.getElementById('tbody-full-expenses');
    const badgeCount = document.getElementById('exp-table-count-badge');
    const footTotal = document.getElementById('exp-table-foot-total');
    const footEntries = document.getElementById('exp-table-foot-entries');
    if (!tbody) return;
    tbody.innerHTML = '';

    const totalAmount = expenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    if (badgeCount) {
      badgeCount.textContent = `${expenses.length} ${isEn ? 'Entries' : 'એન્ટ્રીઓ'}`;
    }
    if (footTotal) {
      footTotal.textContent = `₹ ${totalAmount.toLocaleString('en-IN')}`;
    }
    if (footEntries) {
      footEntries.textContent = `${expenses.length} ${isEn ? 'Entries' : 'એન્ટ્રીઓ'}`;
    }

    if (expenses.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: 36px 20px; color: var(--text-muted); font-size: 0.95rem;">
            <span>${isEn ? '🔍 No expense entries found in this period or filter.' : '🔍 આ તારીખ સમયગાળા કે ફિલ્ટરમાં કોઈ ખર્ચ એન્ટ્રી ઉપલબ્ધ નથી.'}</span>
          </td>
        </tr>
      `;
      return;
    }

    expenses.forEach((item, idx) => {
      const tr = document.createElement('tr');
      const gujKhata = this.getKhataNameInGujarati(item.category);

      tr.innerHTML = `
        <td style="color: var(--text-muted); font-size: 0.85rem; text-align: center;">${idx + 1}</td>
        <td style="font-family: var(--font-heading); font-weight: 700; color: var(--text-main); white-space: nowrap;">
          ${item.date}
        </td>
        <td>
          <div style="font-weight: 700; color: var(--text-main); font-size: 0.95rem;">${item.title}</div>
          ${item.remarks ? `<div style="font-size: 0.78rem; color: #64748b; margin-top: 2px;">📝 ${item.remarks}</div>` : ''}
        </td>
        <td>
          <span class="denom-badge denom-100" style="padding: 3px 10px; font-size: 0.82rem; border-radius: 6px; font-weight: 700; display: inline-block;">
            ${gujKhata}
          </span>
        </td>
        <td style="text-align: right; font-family: var(--font-heading); font-weight: 800; font-size: 1.1rem; color: #b91c1c;">
          ₹ ${(item.amount || 0).toLocaleString('en-IN')}
        </td>
        <td style="text-align: center;">
          ${!this.isDateLocked(item.date) ? `
            <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
              <button type="button" class="btn-icon" style="padding: 4px 8px; font-size: 0.82rem; color: #2563eb; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 4px; cursor: pointer; font-weight: 700;" onclick="App.openEditExpenseItemModal('${item.id}', '${item.date}', 'register')" title="આ ખર્ચ વિગત સુધારો">
                ✏️
              </button>
              <button type="button" class="btn-icon" style="padding: 4px 8px; font-size: 0.82rem; color: #ef4444; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; cursor: pointer;" onclick="App.deleteExpenseItemDirect('${item.id}', '${item.date}')" title="આ ખર્ચ કાઢી નાખો">
                🗑️
              </button>
            </div>
          ` : `<span style="color: #94a3b8; font-weight: 600;">🔒</span>`}
        </td>
      `;
      tbody.appendChild(tr);
    });
  },

  onExpenseSearchInput(query) {
    if (!this.currentExpenseReport || !this.currentExpenseReport.expenses) return;
    const q = (query || '').toLowerCase().trim();
    if (!q) {
      this.currentFilteredExpenses = null;
      this.renderExpenseTable(this.currentExpenseReport.expenses);
      return;
    }
    const filtered = this.currentExpenseReport.expenses.filter(item => {
      const matchTitle = (item.title || '').toLowerCase().includes(q);
      const matchCat = (item.category || '').toLowerCase().includes(q);
      const matchRemarks = (item.remarks || '').toLowerCase().includes(q);
      const matchDate = (item.date || '').toLowerCase().includes(q);
      const matchAmt = String(item.amount || '').includes(q);
      return matchTitle || matchCat || matchRemarks || matchDate || matchAmt;
    });
    this.currentFilteredExpenses = filtered;
    this.renderExpenseTable(filtered);
  },

  goToDayFromReport(dateStr) {
    this.switchMainView('daily');
    this.setDateAndLoad(dateStr);
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    this.showToast(isEn ? `Loaded daily record for ${dateStr}` : `તારીખ ${dateStr} નો દૈનિક હિસાબ લોડ કર્યો`);
  },

  isExpenseAnalyticsVisible: false,

  toggleExpenseAnalyticsCards(forceState = null) {
    const wrapper = document.getElementById('expense-analytics-wrapper');
    const btn = document.getElementById('btn-toggle-expense-analytics');
    const label = document.getElementById('toggle-analytics-label');
    const icon = document.getElementById('toggle-analytics-icon');
    if (!wrapper) return;

    const nextState = forceState !== null ? forceState : !this.isExpenseAnalyticsVisible;
    this.isExpenseAnalyticsVisible = nextState;

    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (nextState) {
      wrapper.style.display = 'block';
      if (btn) btn.classList.add('active');
      if (label) label.textContent = isEn ? 'Hide Analytics' : 'વિશ્લેષણ છુપાવો';
      if (icon) icon.textContent = '✕';
    } else {
      wrapper.style.display = 'none';
      if (btn) btn.classList.remove('active');
      if (label) label.textContent = isEn ? 'View Analytics' : 'વિશ્લેષણ જુઓ';
      if (icon) icon.textContent = '👁️';
    }
  },

  exportExpensesExcel() {
    const from = document.getElementById('exp-filter-from')?.value || '';
    const to = document.getElementById('exp-filter-to')?.value || '';
    const cat = document.getElementById('exp-filter-category')?.value || 'all';
    window.location.href = `/api/export/expenses-excel?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&category=${encodeURIComponent(cat)}`;
  },

  printExpenseReport() {
    if (!this.currentExpenseReport) return;
    const data = this.currentExpenseReport;
    const fromDate = data.fromDate || document.getElementById('exp-filter-from')?.value || '';
    const toDate = data.toDate || document.getElementById('exp-filter-to')?.value || '';

    const expensesToPrint = (this.currentFilteredExpenses && this.currentFilteredExpenses.length > 0)
      ? this.currentFilteredExpenses
      : (data.expenses || []);

    const fromFormatted = this.formatDateHeaderForPrint(fromDate).formattedDate;
    const toFormatted = this.formatDateHeaderForPrint(toDate).formattedDate;

    let daysDiff = data.daysCount || 1;
    if (fromDate && toDate) {
      const d1 = new Date(fromDate + 'T00:00:00');
      const d2 = new Date(toDate + 'T00:00:00');
      daysDiff = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1);
    }

    const html = this.generateDateWiseExpensePrintHtml({
      title: 'તારીખવાર ખર્ચ હિસાબ રજિસ્ટર',
      subtitle: `સમયગાળો: ${fromFormatted} થી ${toFormatted} (${daysDiff} દિવસ) | કુલ એન્ટ્રીઓ: ${expensesToPrint.length}`,
      items: expensesToPrint,
      categoryTotals: data.categoryTotals,
      grandTotal: (this.currentFilteredExpenses && this.currentFilteredExpenses.length > 0)
        ? expensesToPrint.reduce((s, it) => s + (Number(it.amount) || 0), 0)
        : data.grandTotal,
      fromDate: fromDate,
      toDate: toDate,
      includeAllDates: true
    });
    this.openPrintWindow(html);
  },

  shareExpenseReportWhatsApp() {
    if (!this.currentExpenseReport) return;
    const data = this.currentExpenseReport;
    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    let text = isEn ? `📊 *Complete Expense Report*\n` : `📊 *સંપૂર્ણ ખર્ચ અહેવાલ*\n`;
    text += `🏛️ ${this.settings.orgName || (isEn ? 'Sansthan' : 'સંસ્થાન')}\n`;
    text += isEn
      ? `📅 Period: *${data.fromDate}* to *${data.toDate}* (${data.daysCount} days)\n`
      : `📅 મુદત: *${data.fromDate}* થી *${data.toDate}* (${data.daysCount} દિવસ)\n`;
    text += `--------------------------------\n`;
    text += isEn
      ? `💰 *Total Expenses: ₹${(data.grandTotal || 0).toLocaleString('en-IN')}*\n`
      : `💰 *કુલ ખર્ચ સરવાળો: ₹${(data.grandTotal || 0).toLocaleString('en-IN')}*\n`;
    text += isEn
      ? `📈 Daily Average: ₹${(data.dailyAverage || 0).toLocaleString('en-IN')} / day\n`
      : `📈 દૈનિક સરેરાશ: ₹${(data.dailyAverage || 0).toLocaleString('en-IN')} / દિવસ\n`;
    text += `--------------------------------\n`;
    text += isEn ? `🏷️ *Account-wise Breakdown:*\n` : `🏷️ *ખાતાવહી મુજબ વિગત:*\n`;

    const catTotals = data.categoryTotals || {};
    Object.keys(catTotals).forEach(cat => {
      const catLabel = isEn ? cat : this.getKhataNameInGujarati(cat);
      text += `• ${catLabel}: ₹${catTotals[cat].toLocaleString('en-IN')}\n`;
    });

    text += isEn ? `(Total ${data.totalEntries} expense entries recorded)\n` : `(કુલ ${data.totalEntries} ખર્ચ વિગતો નોંધાયેલ છે)\n`;

    const phone = this.settings.phone ? this.settings.phone.replace(/[^0-9]/g, '') : '';
    const url = `https://wa.me/${phone ? '91' + phone : ''}?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  },

  // =========================================================================
  // EMPLOYEE MANAGEMENT METHODS (કર્મચારી પગાર અને ઉપાડ ખાતાવહી)
  // =========================================================================
  // Default salary month: returns active current month YYYY-MM
  getDefaultSalaryMonth(dateStr = null) {
    const dStr = dateStr || this.currentDate || new Date().toISOString().split('T')[0];
    return dStr.slice(0, 7);
  },

  async openEmployeesModal(month = null) {
    if (window.i18n) window.i18n.updateDOM();
    this.openModal('modal-employees');

    const m = month || this.getDefaultSalaryMonth();
    const mInput = document.getElementById('emp-month-filter');
    if (mInput) mInput.value = m;
    this.employeeMonthFilter = m;

    await this.loadEmployees(m);
  },

  async loadEmployees(month = null) {
    const m = month || this.employeeMonthFilter || this.getDefaultSalaryMonth();
    try {
      const res = await fetch(`/api/employees?month=${m}`);
      const data = await res.json();
      if (data && data.success) {
        this.employeesList = data.employees || [];
        this.renderEmployeesSummary(data.summary);
        this.renderEmployeesList();
        this.renderUchakEmployeeHelpers();
      }
    } catch (e) {
      console.error('Failed to load employees:', e);
    }
  },

  getGujaratiMonthName(ym) {
    if (!ym) return '';
    const parts = String(ym).split('-');
    const y = parts[0];
    const m = parseInt(parts[1], 10);
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    if (isEn) {
      const enMonths = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
      ];
      return `${enMonths[m - 1] || ym} ${y}`;
    }
    const guMonths = [
      'જાન્યુઆરી', 'ફેબ્રુઆરી', 'માર્ચ', 'એપ્રિલ', 'મે', 'જૂન',
      'જુલાઈ', 'ઓગસ્ટ', 'સપ્ટેમ્બર', 'ઓક્ટોબર', 'નવેમ્બર', 'ડિસેમ્બર'
    ];
    const name = guMonths[m - 1] || ym;
    return `${name} ${y}`;
  },

  renderEmployeesSummary(summary) {
    if (!summary) return;
    const m = this.employeeMonthFilter || this.getDefaultSalaryMonth();
    const monthLabel = this.getGujaratiMonthName(m);
    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    const countEl = document.getElementById('emp-summary-total-count');
    const payEl = document.getElementById('emp-summary-payroll');
    const updEl = document.getElementById('emp-summary-upad');
    const balEl = document.getElementById('emp-summary-balance');

    if (countEl) countEl.textContent = summary.totalEmployees || 0;
    if (payEl) payEl.textContent = '₹ ' + (summary.totalPayroll || 0).toLocaleString('en-IN');
    if (updEl) updEl.textContent = '₹ ' + (summary.totalMonthUpad || 0).toLocaleString('en-IN');
    if (balEl) balEl.textContent = '₹ ' + (summary.totalNetPayable || 0).toLocaleString('en-IN');

    // Dynamic month badges & table headers
    const badge = document.getElementById('emp-month-name-badge');
    if (badge) badge.textContent = monthLabel;
    const upadTitle = document.getElementById('emp-kpi-upad-title');
    if (upadTitle) upadTitle.textContent = isEn ? 'Total Advance' : 'કુલ ઉપાડ';
    const paidTitle = document.getElementById('emp-kpi-paid-title');
    if (paidTitle) paidTitle.textContent = isEn ? 'Paid Salary' : 'ચૂકવેલ પગાર';
    const paidVal = document.getElementById('emp-summary-paid');
    if (paidVal) paidVal.textContent = '₹ ' + (summary.totalMonthPagarPaid || 0).toLocaleString('en-IN');
    const balTitle = document.getElementById('emp-kpi-balance-title');
    if (balTitle) balTitle.textContent = isEn ? 'Total Balance Due' : 'કુલ બાકી પગાર';
    const thOpening = document.getElementById('th-emp-opening-col');
    if (thOpening) thOpening.textContent = isEn ? 'Previous Due' : 'અગાઉની બાકી';
    const thUpad = document.getElementById('th-emp-upad-col');
    if (thUpad) thUpad.textContent = isEn ? 'Advance' : 'ઉપાડ';
    const thPaid = document.getElementById('th-emp-paid-col');
    if (thPaid) thPaid.textContent = isEn ? 'Paid' : 'ચૂકવેલ';
    const thBal = document.getElementById('th-emp-balance-col');
    if (thBal) thBal.textContent = isEn ? 'Payable Salary' : 'બાકી પગાર';

    // Table Footer Totals (કુલ સરવાળો)
    const footSalary = document.getElementById('emp-foot-total-salary');
    const footOpening = document.getElementById('emp-foot-total-opening');
    const footUpad = document.getElementById('emp-foot-total-upad');
    const footPaid = document.getElementById('emp-foot-total-paid');
    const footBal = document.getElementById('emp-foot-total-balance');

    if (footSalary) footSalary.textContent = '₹ ' + (summary.totalPayroll || 0).toLocaleString('en-IN');
    if (footOpening) {
      const op = summary.totalOpeningBalance || 0;
      footOpening.textContent = (op >= 0 ? '+₹ ' : '-₹ ') + Math.abs(op).toLocaleString('en-IN');
      footOpening.style.color = op >= 0 ? '#4338ca' : '#ea580c';
    }
    if (footUpad) footUpad.textContent = '₹ ' + (summary.totalMonthUpad || 0).toLocaleString('en-IN');
    if (footPaid) footPaid.textContent = '₹ ' + (summary.totalMonthPagarPaid || 0).toLocaleString('en-IN');
    if (footBal) {
      const net = summary.totalNetPayable || 0;
      footBal.textContent = '₹ ' + net.toLocaleString('en-IN');
    }
  },

  employeeCycleFilter: 'all',

  setEmployeeCycleFilter(cycle) {
    this.employeeCycleFilter = cycle;
    ['all', 'monthly', '15days'].forEach(c => {
      const btn = document.getElementById(`emp-filter-cycle-${c}`);
      if (btn) {
        if (c === cycle) {
          btn.classList.add('active');
          btn.style.background = '#0f172a';
          btn.style.color = '#ffffff';
        } else {
          btn.classList.remove('active');
          btn.style.background = '#ffffff';
          btn.style.color = '#334155';
        }
      }
    });
    const searchInp = document.getElementById('emp-search-input');
    this.renderEmployeesList(searchInp ? searchInp.value : '');
  },

  renderEmployeesList(filterQuery = '') {
    const tbody = document.getElementById('tbody-employees-list');
    if (!tbody) return;
    tbody.innerHTML = '';

    const q = (filterQuery || '').toLowerCase().trim();
    let list = (this.employeesList || []).filter(e => {
      if (!q) return true;
      return (e.name || '').toLowerCase().includes(q) ||
        (e.role || '').toLowerCase().includes(q) ||
        (e.phone || '').toLowerCase().includes(q);
    });

    if (this.employeeCycleFilter === 'monthly') {
      list = list.filter(e => (e.paymentType || 'monthly') === 'monthly');
    } else if (this.employeeCycleFilter === '15days') {
      list = list.filter(e => e.paymentType === '15days');
    }

    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align: center; padding: 36px 20px; color: var(--text-muted); background: #f8fafc;">
            <div style="font-size: 2rem; margin-bottom: 6px;">👥</div>
            <div style="font-weight: 700; font-size: 0.95rem; color: var(--text-main);">${isEn ? 'No staff members found' : 'કોઈ કર્મચારી મળ્યો નથી'}</div>
            <p style="margin-top: 4px; font-size: 0.82rem; color: var(--text-muted);">${isEn ? 'Use the "+ Add Employee" button to add staff.' : 'નવો કર્મચારી ઉમેરવા માટે એડમિન પેનલ માં જાઓ.'}</p>
          </td>
        </tr>
      `;
      return;
    }

    list.forEach((emp, idx) => {
      const initials = (emp.name || 'E').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
      const salary = Number(emp.salary) || 0;
      const opening = Number(emp.openingBalance) || 0;
      const upad = Number(emp.currentMonthUpad) || 0;
      const pagarPaid = Number(emp.currentMonthPagarPaid) || 0;
      const balance = Number(emp.netBalance) || 0;
      const isSelected = this.selectedStaffIds && this.selectedStaffIds.has(emp.id);

      const is15Days = emp.paymentType === '15days';
      const cycleBadge = is15Days
        ? `<span style="font-size: 0.68rem; background: #fef3c7; color: #92400e; font-weight: 800; padding: 1px 6px; border-radius: 4px; border: 1px solid #fde68a;">⏳ ૧૫ દિવસ</span>`
        : `<span style="font-size: 0.68rem; background: #e0e7ff; color: #3730a3; font-weight: 800; padding: 1px 6px; border-radius: 4px; border: 1px solid #c7d2fe;">📅 માસિક</span>`;

      // Opening balance badge
      // Opening balance badge
      let openingBadge = '<span style="color: #94a3b8; font-weight: 500;">-</span>';
      if (opening > 0) {
        openingBadge = `<div style="color: #4338ca; font-weight: 700; font-size: 0.90rem;">+₹ ${opening.toLocaleString('en-IN')}</div><div style="font-size: 0.68rem; color: #6366f1; font-weight: 500;">(જૂનો બાકી)</div>`;
      } else if (opening < 0) {
        openingBadge = `<div style="color: #ea580c; font-weight: 700; font-size: 0.90rem;">-₹ ${Math.abs(opening).toLocaleString('en-IN')}</div><div style="font-size: 0.68rem; color: #f97316; font-weight: 500;">(જૂનો ઉપાડ)</div>`;
      }

      // Upad display
      const upadDisplay = upad > 0
        ? `<div style="font-weight: 700; color: #b91c1c; font-size: 0.92rem;">₹ ${upad.toLocaleString('en-IN')}</div>${emp.monthUpadsCount > 0 ? `<div style="font-size: 0.68rem; color: var(--text-muted); font-weight: 500;">(${emp.monthUpadsCount} ${isEn ? 'advances' : 'વાર ઉપાડ'})</div>` : ''}`
        : `<span style="color: #94a3b8; font-weight: 500;">-</span>`;

      // Paid display
      const paidDisplay = pagarPaid > 0
        ? `<div style="font-weight: 700; color: #2563eb; font-size: 0.92rem;">₹ ${pagarPaid.toLocaleString('en-IN')}</div><div style="font-size: 0.68rem; color: #16a34a; font-weight: 600;">${isEn ? '✓ Paid' : '✓ ચૂકવેલ'}</div>`
        : `<span style="color: #94a3b8; font-weight: 500;">-</span>`;

      // Balance badge
      let balanceBadge = '';
      if (balance > 0) {
        balanceBadge = `<span style="color: #059669; font-weight: 800; font-size: 0.98rem;">₹ ${balance.toLocaleString('en-IN')}</span>`;
      } else if (balance < 0) {
        balanceBadge = `<div style="color: #b91c1c; font-weight: 800; font-size: 0.98rem;">-₹ ${Math.abs(balance).toLocaleString('en-IN')}</div><div style="font-size: 0.68rem; color: #b91c1c; font-weight: 500;">(વધારાનો ઉપાડ)</div>`;
      } else {
        balanceBadge = `<span style="color: #059669; font-weight: 600; font-size: 0.88rem;">₹ 0</span> <span style="font-size: 0.70rem; color: #16a34a; font-weight: 600;">(✓ ચૂકતે)</span>`;
      }

      const tr = document.createElement('tr');
      tr.className = 'emp-compact-row';
      tr.innerHTML = `
        <td style="text-align: center;">
          <input type="checkbox" class="emp-row-check" data-id="${emp.id}" 
            ${isSelected ? 'checked' : ''} 
            ${balance <= 0 ? (isEn ? 'disabled title="No salary pending"' : 'disabled title="પગાર બાકી નથી"') : (isEn ? 'title="Select for salary payout"' : 'title="પગાર ચૂકવણી માટે પસંદ કરો"')}
            onchange="App.toggleEmployeeSelection('${emp.id}', this.checked)" 
            style="width: 16px; height: 16px; cursor: ${balance <= 0 ? 'not-allowed' : 'pointer'};">
        </td>
        <td style="text-align: center; font-weight: 600; color: var(--text-muted); font-size: 0.82rem;">${idx + 1}</td>
        <td>
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-weight: 800; color: var(--text-main); font-size: 0.92rem; cursor: pointer;" onclick="App.editEmployee('${emp.id}')" title="${isEn ? 'Click to edit employee details or monthly salary' : 'કર્મચારી વિગત અથવા માસિક પગાર બદલવા ક્લિક કરો'}">${emp.name}</span>
            <button class="btn-icon" style="padding: 1px 5px; font-size: 0.72rem; color: #475569; background: #f1f5f9; border-radius: 4px; border: 1px solid #cbd5e1;" onclick="App.editEmployee('${emp.id}')" title="${isEn ? 'Edit employee or salary' : 'માસિક પગાર કે વિગત સુધારો'}">✏️</button>
          </div>
          ${emp.role ? `<div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 500;">${emp.role}</div>` : ''}
        </td>
        <td style="text-align: right; font-family: var(--font-heading); font-weight: 700; font-size: 0.92rem; color: var(--text-main); cursor: pointer;" onclick="App.editEmployee('${emp.id}')" title="${isEn ? 'Click to edit salary' : 'માસિક પગાર બદલવા ક્લિક કરો'}">
          <span style="color: #0284c7; font-weight: 800;">₹ ${salary.toLocaleString('en-IN')}</span>
          <div style="font-size: 0.66rem; color: var(--text-muted); font-weight: 500;">${is15Days ? (isEn ? '/ 15 days' : '/ ૧૫ દિવસ') : (isEn ? '/ month' : '/ માસ')}</div>
        </td>
        <td style="text-align: right; font-family: var(--font-heading);">
          ${openingBadge}
        </td>
        <td style="text-align: right; font-family: var(--font-heading);">
          ${upadDisplay}
        </td>
        <td style="text-align: right; font-family: var(--font-heading);">
          ${paidDisplay}
        </td>
        <td style="text-align: right; font-family: var(--font-heading);">
          ${balanceBadge}
        </td>
        <td style="text-align: center; white-space: nowrap;">
          <div style="display: inline-flex; gap: 5px; align-items: center; justify-content: center;">
            <button class="emp-btn-upad-mini" onclick="App.openQuickUpadModal('${emp.id}')" title="${isEn ? 'Give Cash Advance' : 'રોકડ ઉપાડ આપો'}" style="background: linear-gradient(135deg, #dc2626, #b91c1c); color: #ffffff; font-weight: 700; border: none; padding: 4px 8px; border-radius: 5px; cursor: pointer;">
              <span>💸</span> <span>${isEn ? 'Advance' : 'ઉપાડ'}</span>
            </button>
            <button class="emp-btn-pagar-mini" onclick="App.openQuickPagarModal('${emp.id}')" title="${isEn ? 'Pay Salary' : 'પગાર ચૂકવો'}" style="background: linear-gradient(135deg, #059669, #047857); color: #ffffff; font-weight: 700; border: none; padding: 4px 8px; border-radius: 5px; cursor: pointer;">
              <span>💵</span> <span>${isEn ? 'Salary' : 'પગાર'}</span>
            </button>
            <button class="emp-btn-ledger-mini" onclick="App.openEmployeeLedger('${emp.id}')" title="${isEn ? 'View Ledger & History' : 'ખાતાવહી અને ઇતિહાસ જુઓ'}" style="background: #f1f5f9; color: #1e293b; font-weight: 600; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 5px; cursor: pointer;">
              <span>📋</span> <span>${isEn ? 'Ledger' : 'ખાતાવહી'}</span>
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    this.updateSelectedStaffUI();
  },

  toggleSelectAllEmployees(checked) {
    if (!this.selectedStaffIds) this.selectedStaffIds = new Set();
    this.selectedStaffIds.clear();

    if (checked) {
      (this.employeesList || []).forEach(emp => {
        if (Number(emp.netBalance) > 0) {
          this.selectedStaffIds.add(emp.id);
        }
      });
    }

    const cbs = document.querySelectorAll('.emp-row-check');
    cbs.forEach(cb => {
      const empId = cb.getAttribute('data-id');
      if (empId && !cb.disabled) {
        cb.checked = this.selectedStaffIds.has(empId);
      }
    });

    this.updateSelectedStaffUI();
  },

  toggleEmployeeSelection(empId, checked) {
    if (!this.selectedStaffIds) this.selectedStaffIds = new Set();
    if (checked) {
      this.selectedStaffIds.add(empId);
    } else {
      this.selectedStaffIds.delete(empId);
    }
    this.updateSelectedStaffUI();
  },

  updateSelectedStaffUI() {
    let selectedCount = 0;
    let selectedTotal = 0;
    (this.employeesList || []).forEach(emp => {
      if (this.selectedStaffIds && this.selectedStaffIds.has(emp.id)) {
        selectedCount++;
        selectedTotal += Number(emp.netBalance) || 0;
      }
    });

    const totalNetPayable = (this.employeesList || []).reduce((s, e) => s + (Number(e.netBalance) || 0), 0);
    const eligibleCount = (this.employeesList || []).filter(e => Number(e.netBalance) > 0).length;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    const lbl = document.getElementById('lbl-pay-selected-staff');
    const selBtn = document.getElementById('btn-pay-selected-staff');
    if (selBtn) {
      selBtn.style.display = selectedCount > 0 ? 'inline-flex' : 'none';
    }
    if (lbl) {
      if (selectedCount > 0) {
        lbl.textContent = `Selected Salary Paid (${selectedCount})`;
      } else {
        lbl.textContent = `Selected Salary Paid`;
      }
    }

    const allBtnLbl = document.getElementById('lbl-pay-all-staff');
    if (allBtnLbl) {
      allBtnLbl.textContent = 'All Salary Paid';
    }

    const footInfo = document.getElementById('emp-foot-selected-info');
    if (footInfo) {
      if (selectedCount > 0) {
        footInfo.innerHTML = `<span style="color: #059669; font-weight: 800;">${isEn ? 'Selected:' : 'પસંદ:'} ${selectedCount} ${isEn ? 'Staff' : 'સ્ટાફ'} (₹ ${selectedTotal.toLocaleString('en-IN')})</span>`;
      } else {
        footInfo.innerHTML = `<span style="color: var(--text-muted);">${isEn ? 'All Staff Summary' : 'બધા સ્ટાફનો હિસાબ'}</span>`;
      }
    }

    const allCb = document.getElementById('emp-select-all');
    if (allCb) {
      const eligibleStaff = (this.employeesList || []).filter(e => Number(e.netBalance) > 0);
      if (eligibleStaff.length > 0 && selectedCount === eligibleStaff.length) {
        allCb.checked = true;
        allCb.indeterminate = false;
      } else if (selectedCount > 0) {
        allCb.checked = false;
        allCb.indeterminate = true;
      } else {
        allCb.checked = false;
        allCb.indeterminate = false;
      }
    }
  },

  openBulkPagarModal(payAll = false) {
    const currentMonth = this.employeeMonthFilter || this.getDefaultSalaryMonth();
    const monthLabel = this.getGujaratiMonthName(currentMonth);

    let targets = [];
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    if (payAll) {
      targets = (this.employeesList || []).filter(e => Number(e.netBalance) > 0);
      if (targets.length === 0) {
        this.showToast(isEn ? `All employees' salary for ${monthLabel} has been paid (no balance remaining).` : `${monthLabel} માસનો બધા કર્મચારીઓનો પગાર ચૂકવાઈ ગયેલ છે (કોઈ બાકી નથી).`, 'info');
        return;
      }
    } else {
      if (!this.selectedStaffIds || this.selectedStaffIds.size === 0) {
        this.showToast(isEn ? 'Please select staff to pay salary first.' : 'કૃપા કરીને પહેલા પગાર ચૂકવવા માટે સ્ટાફ પસંદ કરો.', 'warning');
        return;
      }
      targets = (this.employeesList || []).filter(e => this.selectedStaffIds.has(e.id) && Number(e.netBalance) > 0);
      if (targets.length === 0) {
        return;
      }
    }

    this.pendingBulkStaff = targets;
    const totalAmount = targets.reduce((sum, e) => sum + (Number(e.netBalance) || 0), 0);
    const totalUpad = targets.reduce((sum, e) => sum + (Number(e.currentMonthUpad) || 0), 0);

    const banner = document.getElementById('bulk-pagar-summary-banner');
    if (banner) {
      const staffCountLabel = isEn ? `👥 Selected Staff: ${targets.length} Employees` : `👥 પસંદ કરેલ સ્ટાફ: ${targets.length} કર્મચારી`;
      const salaryMonthLabel = isEn ? `${monthLabel} Salary` : `${monthLabel} માસનો પગાર`;
      const addedToHisabNote = isEn ? `Will be added as expense in today's daily hisab 'PAGAR' voucher` : `આજના દૈનિક હિસાબના 'PAGAR' વાઉચરમાં ખર્ચ ઉમેરાશે`;
      const totalBalanceLabel = isEn ? `Total Payable Balance Salary:` : `કુલ ચૂકવવાપાત્ર બાકી પગાર:`;
      banner.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div>
            <span style="font-weight: 800; color: #065f46; font-size: 1.05rem;">${staffCountLabel}</span>
            <div style="font-size: 0.85rem; color: #047857; margin-top: 3px; font-weight: 700;">
              📅 <span style="background: #a7f3d0; color: #065f46; padding: 2px 8px; border-radius: 4px;">${salaryMonthLabel}</span> | ${addedToHisabNote}
            </div>
          </div>
          <div style="text-align: right;">
            <span style="font-size: 0.82rem; color: #047857; font-weight: 700;">${totalBalanceLabel}</span>
            <div style="font-size: 1.4rem; font-weight: 900; color: #065f46; font-family: var(--font-heading);">₹ ${totalAmount.toLocaleString('en-IN')}</div>
          </div>
        </div>
      `;
    }

    const tbody = document.getElementById('tbody-bulk-pagar-list');
    if (tbody) {
      tbody.innerHTML = '';
      targets.forEach((emp, i) => {
        const tr = document.createElement('tr');
        const roleText = emp.role || (isEn ? 'Staff' : 'સ્ટાફ');
        const salaryText = isEn ? 'Monthly Salary' : 'માસિક પગાર';
        tr.innerHTML = `
          <td style="text-align: center; font-weight: 700; color: var(--text-muted);">${i + 1}</td>
          <td>
            <div style="font-weight: 700; color: var(--text-main); font-size: 0.92rem;">${emp.name}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${roleText} | ${salaryText}: ₹${(emp.salary || 0).toLocaleString('en-IN')}</div>
          </td>
          <td style="text-align: right; color: #b91c1c; font-weight: 700;">₹ ${(emp.currentMonthUpad || 0).toLocaleString('en-IN')}</td>
          <td style="text-align: right; font-weight: 800; color: #059669; font-size: 1.05rem; font-family: var(--font-heading);">
            ₹ ${(emp.netBalance || 0).toLocaleString('en-IN')}
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    const footUpad = document.getElementById('bulk-foot-total-upad');
    const footBal = document.getElementById('bulk-foot-total-balance');
    if (footUpad) footUpad.textContent = '₹ ' + totalUpad.toLocaleString('en-IN');
    if (footBal) footBal.textContent = '₹ ' + totalAmount.toLocaleString('en-IN');

    const confirmBtn = document.getElementById('btn-confirm-bulk-pagar');
    if (confirmBtn) {
      const confirmText = isEn
        ? `Yes, Post ₹ ${totalAmount.toLocaleString('en-IN')} Salary of ${monthLabel} into Expenses`
        : `હા, ${monthLabel} નો ₹ ${totalAmount.toLocaleString('en-IN')} પગાર ખર્ચમાં ચડાવો`;
      confirmBtn.innerHTML = `<span>✅</span> <span>${confirmText}</span>`;
      confirmBtn.disabled = false;
    }

    if (window.i18n) window.i18n.updateDOM();
    this.openModal('modal-bulk-pagar-confirm', { isChild: true });
  },

  async executeBulkPagar() {
    if (!this.pendingBulkStaff || this.pendingBulkStaff.length === 0) return;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const currentMonth = this.employeeMonthFilter || new Date().toISOString().slice(0, 7);
    const monthLabel = this.getGujaratiMonthName(currentMonth);

    const confirmBtn = document.getElementById('btn-confirm-bulk-pagar');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = `<span>⏳</span> <span>${isEn ? `Posting salary of ${monthLabel} into expenses...` : `${monthLabel} માસનો પગાર ખર્ચમાં ચડાવી રહ્યા છીએ...`}</span>`;
    }

    const items = this.pendingBulkStaff.map(emp => {
      const is15 = emp.paymentType === '15days';
      return {
        id: emp.id,
        amount: Number(emp.netBalance),
        title: is15
          ? (isEn ? `${emp.name} - 15-Day Salary` : `${emp.name} - ૧૫ દિવસનો પગાર`)
          : (isEn ? `${emp.name} - ${monthLabel} Salary` : `${emp.name} - ${monthLabel} માસનો પગાર`),
        remarks: is15
          ? (isEn ? `15-Day Salary: ₹${emp.salary}, Advance Deduction: ₹${emp.currentMonthUpad || 0}` : `૧૫ દિવસીય પગાર: ₹${emp.salary}, ઉપાડ કપાત: ₹${emp.currentMonthUpad || 0}`)
          : (isEn ? `Monthly Salary: ₹${emp.salary}, ${monthLabel} Advance Deduction: ₹${emp.currentMonthUpad || 0}` : `માસિક પગાર: ₹${emp.salary}, ${monthLabel} ઉપાડ કપાત: ₹${emp.currentMonthUpad || 0}`)
      };
    });

    try {
      const res = await fetch('/api/employees/bulk-pagar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          date: this.getTodayDateStr(),
          forMonth: currentMonth,
          addToHisab: true
        })
      });
      const data = await res.json();
      if (data && data.success) {
        this.closeModal('modal-bulk-pagar-confirm');
        const successMsg = isEn
          ? `Successfully paid ${data.count} employees' salary for ${monthLabel} (₹${data.totalPaid.toLocaleString('en-IN')}) and added to today's hisab 'PAGAR' voucher!`
          : `સફળતાપૂર્વક ${monthLabel} માસનો ${data.count} કર્મચારીઓનો પગાર (₹${data.totalPaid.toLocaleString('en-IN')}) ચૂકવાયો અને દૈનિક હિસાબના 'PAGAR' વાઉચરમાં ખર્ચ ચડી ગયો!`;
        this.showToast(successMsg, 'success');

        if (this.selectedStaffIds) this.selectedStaffIds.clear();
        await this.loadEmployees(currentMonth);
        await this.loadDate(this.currentDate);
      } else {
        this.showToast(data.error || (isEn ? 'Error processing salary payment' : 'પગાર ચૂકવણીમાં ભૂલ આવી'), 'error');
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.innerHTML = `<span>✅</span> <span>${isEn ? 'Yes, Post Salary to Expenses' : 'હા, પગાર ખર્ચમાં ચડાવો'}</span>`;
        }
      }
    } catch (e) {
      this.showToast(isEn ? 'Server connection error' : 'સર્વર કનેક્શનમાં ભૂલ આવી', 'error');
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = `<span>✅</span> <span>${isEn ? 'Yes, Post Salary to Expenses' : 'હા, પગાર ખર્ચમાં ચડાવો'}</span>`;
      }
    }
  },

  onEmployeeSearch(val) {
    this.renderEmployeesList(val);
  },

  onEmployeeMonthChange(m) {
    this.employeeMonthFilter = m;
    this.loadEmployees(m);
  },

  openAddEmployeeModal() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const idEl = document.getElementById('emp-form-id');
    const nameEl = document.getElementById('emp-form-name');
    const roleEl = document.getElementById('emp-form-role');
    const salEl = document.getElementById('emp-form-salary');
    const phEl = document.getElementById('emp-form-phone');
    const jInp = document.getElementById('emp-form-joining');
    const delBtn = document.getElementById('btn-emp-form-delete');
    const titleEl = document.getElementById('modal-employee-form-title');

    if (idEl) idEl.value = '';
    if (nameEl) nameEl.value = '';
    if (roleEl) roleEl.value = '';
    if (salEl) salEl.value = '';
    if (phEl) phEl.value = '';
    if (jInp) jInp.value = this.getTodayDateStr();
    if (delBtn) delBtn.style.display = 'none';
    if (titleEl) titleEl.textContent = isEn ? '➕ Add New Employee' : '➕ નવો કર્મચારી ઉમેરો';

    this.openModal('modal-employee-form', { isChild: true });
    setTimeout(() => {
      document.getElementById('emp-form-name')?.focus();
    }, 150);
  },

  editEmployee(id) {
    const emp = (this.employeesList || []).find(e => e.id === id);
    if (!emp) return;
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const idEl = document.getElementById('emp-form-id');
    const nameEl = document.getElementById('emp-form-name');
    const roleEl = document.getElementById('emp-form-role');
    const salEl = document.getElementById('emp-form-salary');
    const phEl = document.getElementById('emp-form-phone');
    const jInp = document.getElementById('emp-form-joining');
    const delBtn = document.getElementById('btn-emp-form-delete');
    const titleEl = document.getElementById('modal-employee-form-title');

    if (idEl) idEl.value = emp.id;
    if (nameEl) nameEl.value = emp.name || '';
    if (roleEl) roleEl.value = emp.role || emp.designation || '';
    if (salEl) salEl.value = emp.salary || '';
    if (phEl) phEl.value = emp.phone || '';
    if (jInp) jInp.value = emp.joiningDate || this.getTodayDateStr();
    if (delBtn) delBtn.style.display = 'inline-block';
    if (titleEl) titleEl.textContent = isEn ? '✏️ Edit Employee' : '✏️ કર્મચારી સુધારો';

    this.openModal('modal-employee-form', { isChild: true });
  },

  async deleteCurrentEditingEmployee() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const id = document.getElementById('emp-form-id').value;
    if (!id) return;
    const emp = (this.employeesList || []).find(e => e.id === id);
    const name = emp ? emp.name : (isEn ? 'this employee' : 'આ કર્મચારી');
    if (!confirm(isEn ? `Are you sure you want to delete "${name}"?` : `શું તમે ખરેખર "${name}" ને કાઢી નાખવા માંગો છો?`)) return;
    try {
      const res = await fetch(`/api/employees/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data && data.success) {
        this.closeModal('modal-employee-form');
        this.showToast(isEn ? 'Employee has been deleted.' : 'કર્મચારી કાઢી નાખવામાં આવ્યો છે.', 'success');
        await this.loadEmployees();
      } else {
        this.showToast(data.error || (isEn ? 'Error deleting employee' : 'કાઢી નાખવામાં ભૂલ આવી'), 'error');
      }
    } catch (e) {
      this.showToast(isEn ? 'Error deleting employee' : 'કાઢી નાખવામાં ભૂલ આવી', 'error');
    }
  },

  async saveEmployeeForm() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const id = document.getElementById('emp-form-id').value;
    const name = document.getElementById('emp-form-name').value.trim();
    const role = document.getElementById('emp-form-role').value.trim();
    const salary = Number(document.getElementById('emp-form-salary').value);
    const phone = document.getElementById('emp-form-phone').value.trim();
    const joiningDate = document.getElementById('emp-form-joining').value;

    if (!name) {
      this.showToast(isEn ? 'Employee name is required' : 'કર્મચારીનું નામ લખવું જરૂરી છે', 'error');
      document.getElementById('emp-form-name').focus();
      return;
    }
    if (isNaN(salary) || salary < 0) {
      this.showToast(isEn ? 'Enter valid monthly salary' : 'સાચો માસિક પગાર લખો', 'error');
      document.getElementById('emp-form-salary').focus();
      return;
    }

    try {
      const url = id ? `/api/employees/${id}` : '/api/employees';
      const method = id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role, salary, phone, joiningDate })
      });
      const data = await res.json();
      if (data && data.success) {
        this.closeModal('modal-employee-form');
        const saveMsg = id
          ? (isEn ? 'Employee details saved!' : 'કર્મચારી વિગત સાચવાઈ ગઈ!')
          : (isEn ? 'New employee added!' : 'નવો કર્મચારી ઉમેરાયો!');
        this.showToast(saveMsg, 'success');
        await this.loadEmployees();
      } else {
        this.showToast(data.error || (isEn ? 'Error saving employee' : 'સેવ કરવામાં ભૂલ આવી'), 'error');
      }
    } catch (e) {
      this.showToast(isEn ? 'Server connection error' : 'સર્વર કનેક્શનમાં ભૂલ આવી', 'error');
    }
  },

  async deleteEmployee(id) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const emp = (this.employeesList || []).find(e => e.id === id);
    if (!emp) return;

    if (!confirm(isEn ? `Are you sure you want to delete "${emp.name}"?` : `શું તમે ખરેખર "${emp.name}" ને કાઢી નાખવા માંગો છો?`)) return;

    try {
      const res = await fetch(`/api/employees/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data && data.success) {
        this.showToast(isEn ? 'Employee has been deleted.' : 'કર્મચારી કાઢી નાખવામાં આવ્યો છે.', 'success');
        await this.loadEmployees();
      }
    } catch (e) {
      this.showToast(isEn ? 'Error deleting employee' : 'કાઢી નાખવામાં ભૂલ આવી', 'error');
    }
  },

  openEmployeeLedger(id) {
    const emp = (this.employeesList || []).find(e => e.id === id);
    if (!emp) return;
    this.selectedEmployeeForLedger = emp;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    document.getElementById('ledger-emp-name-title').textContent = isEn ? `📋 ${emp.name} - Ledger` : `📋 ${emp.name} - ખાતાવહી`;
    const joinedLabel = isEn ? 'Joined:' : 'જોડાયા:';
    document.getElementById('ledger-emp-sub-title').textContent = `${emp.role} | 📞 ${emp.phone || '-'} | ${joinedLabel} ${emp.joiningDate || '-'}`;

    const banner = document.getElementById('ledger-summary-banner');
    const salary = Number(emp.salary) || 0;
    const opening = Number(emp.openingBalance) || 0;
    const upad = Number(emp.currentMonthUpad) || 0;
    const pagarPaid = Number(emp.currentMonthPagarPaid) || 0;
    const balance = Number(emp.netBalance) || 0;
    const totalUpadAllTime = Number(emp.totalUpadAllTime) || 0;

    let balHtml = `<span class="ledger-banner-val" style="color: #059669;">₹ ${balance.toLocaleString('en-IN')}</span>`;
    if (balance < 0) {
      balHtml = `<span class="ledger-banner-val" style="color: #b91c1c;">-₹ ${Math.abs(balance).toLocaleString('en-IN')}</span><div style="font-size: 0.70rem; color: #b91c1c; font-weight: 700;">(વધારાનો ઉપાડ)</div>`;
    } else if (balance === 0) {
      balHtml = `<span class="ledger-banner-val" style="color: #16a34a;">₹ 0</span><div style="font-size: 0.70rem; color: #16a34a; font-weight: 700;">(✓ ચૂકતે)</div>`;
    }

    banner.innerHTML = `
      <div class="ledger-banner-item">
        <span class="ledger-banner-lbl">${emp.paymentType === '15days' ? (isEn ? '15-Day Salary:' : '૧૫ દિવસનો પગાર:') : (isEn ? 'Monthly Salary:' : 'માસિક પગાર:')}</span>
        <span class="ledger-banner-val" style="color: var(--text-main);">₹ ${salary.toLocaleString('en-IN')}</span>
      </div>
      <div class="ledger-banner-item">
        <span class="ledger-banner-lbl">${isEn ? 'Old Balance:' : 'અગાઉની બાકી:'}</span>
        <span class="ledger-banner-val" style="color: ${opening >= 0 ? '#4338ca' : '#ea580c'};">${opening >= 0 ? '+₹ ' : '-₹ '}${Math.abs(opening).toLocaleString('en-IN')}</span>
      </div>
      <div class="ledger-banner-item">
        <span class="ledger-banner-lbl">${emp.paymentType === '15days' ? (isEn ? 'Advance:' : 'ઉપાડ:') : (isEn ? 'This Month Advance:' : 'આ મહિને ઉપાડ:')}</span>
        <span class="ledger-banner-val" style="color: #b91c1c;">₹ ${upad.toLocaleString('en-IN')}</span>
      </div>
      <div class="ledger-banner-item">
        <span class="ledger-banner-lbl">${isEn ? 'Paid Salary:' : 'ચૂકવેલ પગાર:'}</span>
        <span class="ledger-banner-val" style="color: #2563eb;">₹ ${pagarPaid.toLocaleString('en-IN')}</span>
      </div>
      <div class="ledger-banner-item">
        <span class="ledger-banner-lbl">${isEn ? 'Net Balance:' : 'ચોખ્ખો બાકી પગાર:'}</span>
        ${balHtml}
      </div>
      <div class="ledger-banner-item">
        <span class="ledger-banner-lbl">${isEn ? 'Total Advance:' : 'કુલ ઉપાડ:'}</span>
        <span class="ledger-banner-val" style="color: #7c3aed;">₹ ${totalUpadAllTime.toLocaleString('en-IN')}</span>
      </div>
    `;

    const tbody = document.getElementById('tbody-employee-upads');
    tbody.innerHTML = '';

    const entries = [
      ...(emp.upads || []).map(u => ({ ...u, entryType: 'upad' })),
      ...(emp.pagars || []).map(p => ({ ...p, entryType: 'pagar' }))
    ];
    entries.sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));

    if (entries.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 24px; color: var(--text-muted);">
            ${isEn ? 'ℹ️ No advance or salary payments recorded for this employee yet. Use the buttons above to add entries.' : 'ℹ️ આ કર્મચારીનો કોઈ ઉપાડ કે પગાર ચૂકવણી નોંધાયેલ નથી. ઉપરના બટનો દ્વારા નવી એન્ટ્રી કરી શકો છો.'}
          </td>
        </tr>
      `;
    } else {
      entries.forEach((item, idx) => {
        const isUpad = item.entryType === 'upad';
        const typeBadge = isUpad
          ? `<span style="background: #fff1f2; color: #b91c1c; padding: 2px 7px; border-radius: 4px; font-weight: 700; font-size: 0.78rem;">${isEn ? '🔻 Advance' : '🔻 ઉપાડ'}</span>`
          : `<span style="background: #ecfdf5; color: #059669; padding: 2px 7px; border-radius: 4px; font-weight: 700; font-size: 0.78rem;">${isEn ? '💵 Salary' : '💵 પગાર'}</span>`;
        const amtColor = isUpad ? '#b91c1c' : '#059669';

        const defaultTitle = isUpad ? (isEn ? 'Advance' : 'ઉપાડ') : (isEn ? 'Salary' : 'પગાર');
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${idx + 1}</td>
          <td style="font-weight: 700;">${item.date}</td>
          <td style="font-size: 0.85rem; color: var(--text-muted);">${item.time || '-'}</td>
          <td>${typeBadge}</td>
          <td style="font-weight: 600; color: #1e293b;">${item.title || defaultTitle}</td>
          <td style="text-align: right; font-family: var(--font-heading); font-weight: 800; font-size: 1.05rem; color: ${amtColor};">
            ₹ ${(Number(item.amount) || 0).toLocaleString('en-IN')}
          </td>
          <td style="font-size: 0.85rem; color: var(--text-muted);">${item.remarks || '-'}</td>
          <td style="text-align: center;">
            <button class="admin-item-del-btn" onclick="${isUpad ? `App.deleteEmployeeUpad('${emp.id}', '${item.id}')` : `App.deleteEmployeePagar('${emp.id}', '${item.id}')`}" title="${isEn ? 'Delete' : 'કાઢી નાખો'}">✕</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    if (window.i18n) window.i18n.updateDOM();
    this.openModal('modal-employee-ledger', { isChild: true });
  },

  openQuickUpadFromLedger() {
    if (!this.selectedEmployeeForLedger) return;
    this.openQuickUpadModal(this.selectedEmployeeForLedger.id);
  },

  openQuickPagarFromLedger() {
    if (!this.selectedEmployeeForLedger) return;
    this.openQuickPagarModal(this.selectedEmployeeForLedger.id);
  },

  openQuickUpadModal(id) {
    const emp = (this.employeesList || []).find(e => e.id === id);
    if (!emp) return;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const today = this.getTodayDateStr();
    document.getElementById('quick-upad-emp-id').value = emp.id;
    document.getElementById('quick-upad-amount').value = '';
    document.getElementById('quick-upad-title-input').value = isEn ? 'Advance Given' : 'ઉપાડ આપ્યો';
    const upadDateInp = document.getElementById('quick-upad-date');
    if (upadDateInp) {
      upadDateInp.value = today;
      upadDateInp.max = today;
    }
    document.getElementById('quick-upad-remarks').value = '';

    const defaultMonth = this.employeeMonthFilter || this.getDefaultSalaryMonth(today);
    const mInput = document.getElementById('quick-upad-month');
    if (mInput) {
      mInput.value = defaultMonth;
      this.onQuickUpadMonthChange(defaultMonth);
    }

    if (window.i18n) window.i18n.updateDOM();
    this.openModal('modal-employee-quick-upad', { isChild: true });
    setTimeout(() => {
      const amtInput = document.getElementById('quick-upad-amount');
      if (amtInput) amtInput.focus();
    }, 150);
  },

  async onQuickUpadDateChange(newDate) {
    if (!newDate) return;
    const today = this.getTodayDateStr();
    if (newDate > today) {
      this.showToast(i18n.t('futureDateWarning'), 'warning');
      document.getElementById('quick-upad-date').value = today;
      newDate = today;
    } else if (newDate < today) {
      const isEn = (window.i18n && window.i18n.currentLang === 'en');
      const auth = await this.ensureAdminAuth(isEn ? `Date ${newDate} is locked! Enter Admin PIN to give advance on past date:` : `તારીખ ${newDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં ઉપાડ આપવા એડમિન પિન નાખો:`);
      if (!auth) {
        document.getElementById('quick-upad-date').value = today;
        newDate = today;
      }
    }
    const suggestedMonth = this.getDefaultSalaryMonth(newDate);
    const mInput = document.getElementById('quick-upad-month');
    if (mInput) {
      mInput.value = suggestedMonth;
      this.onQuickUpadMonthChange(suggestedMonth);
    }
  },

  onQuickUpadMonthChange(val) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const monthLabel = this.getGujaratiMonthName(val);
    const empId = document.getElementById('quick-upad-emp-id').value;
    const emp = (this.employeesList || []).find(e => e.id === empId);
    const is15Days = emp && emp.paymentType === '15days';

    const textEl = document.getElementById('quick-upad-month-text');
    if (textEl) {
      textEl.textContent = is15Days
        ? (isEn ? 'This advance will be deducted against 15-day salary' : '૧૫ દિવસના પગાર સામે આ ઉપાડ કપાશે')
        : (isEn ? `This advance will be deducted against ${monthLabel} salary` : `${monthLabel} માસના પગાર સામે આ ઉપાડ કપાશે`);
    }

    if (emp) {
      const monthUpads = (emp.upads || []).filter(u => {
        const m = u.forMonth || (u.date ? u.date.slice(0, 7) : '');
        return m === val;
      });
      const monthUpad = monthUpads.reduce((s, u) => s + (Number(u.amount) || 0), 0);

      const monthPagars = (emp.pagars || []).filter(p => {
        const m = p.forMonth || (p.date ? p.date.slice(0, 7) : '');
        return m === val;
      });
      const monthPagarPaid = monthPagars.reduce((s, p) => s + (Number(p.amount) || 0), 0);

      const salary = Number(emp.salary) || 0;
      const monthBalance = Math.max(0, salary - monthUpad - monthPagarPaid);

      const infoBox = document.getElementById('quick-upad-emp-info');
      if (infoBox) {
        const salaryLabel = isEn ? 'Salary:' : 'પગાર:';
        const advanceLabel = isEn ? 'Advance:' : 'ઉપાડ:';
        const roleBadge = (emp.role && emp.role.trim() && emp.role !== 'undefined') ? `<span style="font-size: 0.75rem; background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 9999px; font-weight: 700;">${emp.role}</span>` : '';
        const badgeType = is15Days
          ? `<span style="background: #fef3c7; color: #92400e; font-size: 0.75rem; padding: 2px 8px; border-radius: 9999px; font-weight: 800;">૧૫ દિવસીય</span>`
          : `<span style="background: #e0e7ff; color: #3730a3; font-size: 0.75rem; padding: 2px 8px; border-radius: 9999px; font-weight: 800;">માસિક</span>`;

        infoBox.innerHTML = `
          <div style="font-weight: 800; font-size: 1.05rem; color: #9f1239; display: flex; align-items: center; gap: 8px;">
            <span>👤 ${emp.name}</span>
            ${roleBadge}
            ${badgeType}
          </div>
          <div style="display: flex; gap: 14px; margin-top: 6px; font-size: 0.88rem; flex-wrap: wrap;">
            <span>💼 ${salaryLabel} <strong>₹${salary.toLocaleString('en-IN')}</strong></span>
            <span>🔻 ${advanceLabel} <strong style="color: #b91c1c;">₹${monthUpad.toLocaleString('en-IN')}</strong></span>
            <span>🟢 ${isEn ? 'Balance:' : 'બાકી રકમ:'} <strong style="color: #059669;">₹${monthBalance.toLocaleString('en-IN')}</strong></span>
          </div>
        `;
      }
    }
  },

  async submitQuickUpad() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const id = document.getElementById('quick-upad-emp-id').value;
    const amount = Number(document.getElementById('quick-upad-amount').value);
    const title = document.getElementById('quick-upad-title-input').value.trim();
    const date = document.getElementById('quick-upad-date').value;
    const forMonth = document.getElementById('quick-upad-month').value || (date ? date.slice(0, 7) : '');
    const remarks = document.getElementById('quick-upad-remarks').value.trim();
    const addToHisab = document.getElementById('quick-upad-add-to-hisab').checked;

    if (isNaN(amount) || amount <= 0) {
      this.showToast(isEn ? 'Enter valid advance amount' : 'સાચી ઉપાડ રકમ લખો', 'error');
      document.getElementById('quick-upad-amount').focus();
      return;
    }

    try {
      const res = await fetch(`/api/employees/${id}/upad`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          title,
          date,
          forMonth,
          remarks,
          addToHisab
        })
      });
      const data = await res.json();
      if (data && data.success) {
        this.closeModal('modal-employee-quick-upad');
        const monthLabel = this.getGujaratiMonthName(forMonth);
        this.showToast(isEn ? `Advance of ₹${amount.toLocaleString('en-IN')} for ${monthLabel} recorded successfully!` : `₹${amount.toLocaleString('en-IN')} નો ${monthLabel} માસનો ઉપાડ સફળતાપૂર્વક નોંધાયો!`, 'success');
        await this.loadEmployees(this.employeeMonthFilter);

        // If open in ledger, refresh ledger
        if (this.selectedEmployeeForLedger && this.selectedEmployeeForLedger.id === id) {
          this.openEmployeeLedger(id);
        }

        // If added to hisab for today, reload today's record
        if (addToHisab && date === this.currentDate) {
          await this.loadDate(this.currentDate);
        }
        this.notifyDataChanged('employee_upad', date);
      }
    } catch (e) {
      this.showToast(isEn ? 'Error saving advance' : 'ઉપાડ સેવ કરવામાં ભૂલ આવી', 'error');
    }
  },

  openQuickPagarModal(id) {
    const emp = (this.employeesList || []).find(e => e.id === id);
    if (!emp) return;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const is15Days = emp.paymentType === '15days';
    const today = this.getTodayDateStr();
    document.getElementById('quick-pagar-emp-id').value = emp.id;
    const pagarDateInp = document.getElementById('quick-pagar-date');
    if (pagarDateInp) {
      pagarDateInp.value = today;
      pagarDateInp.max = today;
    }
    document.getElementById('quick-pagar-remarks').value = '';

    // Default salary month: 1st to 25th of month defaults to previous month
    const defaultMonth = this.employeeMonthFilter || this.getDefaultSalaryMonth(today);
    const mInput = document.getElementById('quick-pagar-month');
    if (mInput) {
      mInput.value = defaultMonth;
    }

    if (window.i18n) window.i18n.updateDOM();

    // Configure 15-day / monthly dynamic modal header and containers
    const titleEl = document.getElementById('quick-pagar-title');
    if (titleEl) {
      titleEl.textContent = is15Days
        ? (isEn ? '💵 Pay 15-Day Salary (Pagar)' : '💵 ૧૫ દિવસનો પગાર ચૂકવણી')
        : (isEn ? '💵 Pay Staff Salary (Pagar)' : '💵 પગાર ચૂકવણી');
    }

    const monthBox = document.getElementById('quick-pagar-month-container');
    const box15Days = document.getElementById('quick-pagar-15days-container');
    if (monthBox && box15Days) {
      if (is15Days) {
        monthBox.style.display = 'none';
        box15Days.style.display = 'block';
      } else {
        monthBox.style.display = 'block';
        box15Days.style.display = 'none';
      }
    }

    const totalDaysLbl = document.getElementById('quick-pagar-total-days-lbl');
    const totInput = document.getElementById('quick-pagar-total-days');
    if (totalDaysLbl) {
      totalDaysLbl.textContent = is15Days
        ? (isEn ? '15 Days (Locked):' : '૧૫ દિવસ (ફિક્સ):')
        : (isEn ? 'Month Days:' : 'મહિનાના દિવસો:');
    }
    if (totInput) {
      if (is15Days) {
        totInput.readOnly = true;
        totInput.style.backgroundColor = '#e2e8f0';
        totInput.style.color = '#065f46';
        totInput.style.cursor = 'not-allowed';
      } else {
        totInput.readOnly = false;
        totInput.style.backgroundColor = '#ffffff';
        totInput.style.color = 'inherit';
        totInput.style.cursor = 'text';
      }
    }

    if (is15Days) {
      const autoPreset = this.autoPick15DaysCycle(emp, today);
      this.set15DaysCyclePreset(autoPreset);
    } else {
      this.onQuickPagarMonthChange(defaultMonth);
    }

    this.openModal('modal-employee-quick-pagar', { isChild: true });
    setTimeout(() => {
      const amtInput = document.getElementById('quick-pagar-amount');
      if (amtInput) amtInput.focus();
    }, 150);
  },

  autoPick15DaysCycle(emp, pagarDate) {
    const ym = (pagarDate || this.getTodayDateStr()).slice(0, 7);
    const cycle1From = `${ym}-01`;
    const cycle1To = `${ym}-15`;

    const pagars = emp && Array.isArray(emp.pagars) ? emp.pagars : [];
    const cycle1Paid = pagars.some(p => {
      const fromMatch = p.fromDate === cycle1From && p.toDate === cycle1To;
      const titleMatch = p.title && p.title.includes(this.formatDateDisplay(cycle1From)) && p.title.includes(this.formatDateDisplay(cycle1To));
      return (p.forMonth === ym && (fromMatch || titleMatch)) || fromMatch;
    });

    return cycle1Paid ? 2 : 1;
  },

  set15DaysCyclePreset(halfNum) {
    const pagarDate = document.getElementById('quick-pagar-date')?.value || this.getTodayDateStr();
    const ym = pagarDate.slice(0, 7); // YYYY-MM
    const [yearStr, monthStr] = ym.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    let fromStr = '';
    let toStr = '';

    if (halfNum === 1) {
      // 1 to 15
      fromStr = `${ym}-01`;
      toStr = `${ym}-15`;
    } else {
      // 16 to end of month
      fromStr = `${ym}-16`;
      const lastDay = new Date(year, month, 0).getDate(); // last day of month
      toStr = `${ym}-${String(lastDay).padStart(2, '0')}`;
    }

    const fromEl = document.getElementById('quick-pagar-from-date');
    const toEl = document.getElementById('quick-pagar-to-date');
    if (fromEl) fromEl.value = fromStr;
    if (toEl) toEl.value = toStr;

    // Highlight active preset button
    const b1 = document.getElementById('btn-15days-preset-1');
    const b2 = document.getElementById('btn-15days-preset-2');
    if (b1 && b2) {
      if (halfNum === 1) {
        b1.style.background = '#059669';
        b1.style.borderColor = '#059669';
        b1.style.color = '#ffffff';
        b2.style.background = '#ffffff';
        b2.style.borderColor = '#10b981';
        b2.style.color = '#065f46';
      } else {
        b2.style.background = '#059669';
        b2.style.borderColor = '#059669';
        b2.style.color = '#ffffff';
        b1.style.background = '#ffffff';
        b1.style.borderColor = '#10b981';
        b1.style.color = '#065f46';
      }
    }

    this.on15DaysRangeChange();
  },

  on15DaysRangeChange() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const fromEl = document.getElementById('quick-pagar-from-date');
    const toEl = document.getElementById('quick-pagar-to-date');
    if (!fromEl || !toEl) return;

    let fromVal = fromEl.value;
    let toVal = toEl.value;
    if (!fromVal || !toVal) return;

    if (fromVal > toVal) {
      toVal = fromVal;
      toEl.value = toVal;
    }

    const fromObj = new Date(fromVal + 'T00:00:00');
    const toObj = new Date(toVal + 'T00:00:00');
    const diffTime = toObj - fromObj;
    const diffDays = Math.max(1, Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1);

    const fromFmt = this.formatDateDisplay(fromVal);
    const toFmt = this.formatDateDisplay(toVal);

    const badgeEl = document.getElementById('quick-pagar-15days-calc-badge');
    if (badgeEl) badgeEl.textContent = `${diffDays} ${isEn ? 'Days' : 'દિવસ'}`;

    const summaryEl = document.getElementById('quick-pagar-15days-summary-text');
    if (summaryEl) {
      summaryEl.textContent = isEn
        ? `From ${fromFmt} to ${toFmt} (${diffDays} Days Salary)`
        : `તા. ${fromFmt} થી ${toFmt} સુધી (${diffDays} દિવસનો પગાર)`;
    }

    const totInput = document.getElementById('quick-pagar-total-days');
    if (totInput) totInput.value = String(diffDays);

    const empId = document.getElementById('quick-pagar-emp-id').value;
    const emp = (this.employeesList || []).find(e => e.id === empId);
    if (emp) {
      document.getElementById('quick-pagar-title-input').value = isEn
        ? `${emp.name} - ${fromFmt} to ${toFmt} (${diffDays} Days Salary)`
        : `${emp.name} - તા. ${fromFmt} થી ${toFmt} (${diffDays} દિવસનો પગાર)`;
    }

    this.onQuickPagarAttendanceChange();
  },

  async onQuickPagarDateChange(newDate) {
    if (!newDate) return;
    const today = this.getTodayDateStr();
    if (newDate > today) {
      this.showToast(i18n.t('futureDateWarning'), 'warning');
      document.getElementById('quick-pagar-date').value = today;
      newDate = today;
    } else if (newDate < today) {
      const isEn = (window.i18n && window.i18n.currentLang === 'en');
      const auth = await this.ensureAdminAuth(isEn ? `Date ${newDate} is locked! Enter Admin PIN to pay salary on past date:` : `તારીખ ${newDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં પગાર ચૂકવવા એડમિન પિન નાખો:`);
      if (!auth) {
        document.getElementById('quick-pagar-date').value = today;
        newDate = today;
      }
    }

    const empId = document.getElementById('quick-pagar-emp-id')?.value;
    const emp = (this.employeesList || []).find(e => e.id === empId);
    if (emp && emp.paymentType === '15days') {
      const autoPreset = this.autoPick15DaysCycle(emp, newDate);
      this.set15DaysCyclePreset(autoPreset);
    } else {
      const suggestedMonth = this.getDefaultSalaryMonth(newDate);
      const mInput = document.getElementById('quick-pagar-month');
      if (mInput) {
        mInput.value = suggestedMonth;
        this.onQuickPagarMonthChange(suggestedMonth);
      }
    }
  },

  onQuickPagarMonthChange(val) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const monthLabel = this.getGujaratiMonthName(val);
    const empId = document.getElementById('quick-pagar-emp-id').value;
    const emp = (this.employeesList || []).find(e => e.id === empId);
    const is15Days = emp && emp.paymentType === '15days';

    const lblEl = document.getElementById('quick-pagar-month-lbl');
    if (lblEl) {
      lblEl.innerHTML = is15Days
        ? (isEn ? '⏳ Payment Cycle *:' : '⏳ ચૂકવણી સમયગાળો *:')
        : (isEn ? '📅 Which month salary are you paying? *:' : '📅 કયા માસનો પગાર ચૂકવો છો? *:');
    }

    const textEl = document.getElementById('quick-pagar-month-text');
    if (textEl) {
      if (is15Days) {
        textEl.textContent = isEn
          ? `15-day salary will be recorded in expenses`
          : `૧૫ દિવસનો પગાર આજના ખર્ચમાં ચડશે`;
      } else {
        textEl.textContent = isEn
          ? `${monthLabel} salary will be paid and recorded in today's expenses`
          : `${monthLabel} માસનો પગાર ચૂકવાશે અને આજના ખર્ચમાં ચડશે`;
      }
    }

    const totalDaysLbl = document.getElementById('quick-pagar-total-days-lbl');
    if (totalDaysLbl) {
      totalDaysLbl.textContent = is15Days
        ? (isEn ? '15 Days:' : '૧૫ દિવસ:')
        : (isEn ? 'Month Days:' : 'મહિનાના દિવસો:');
    }

    if (emp && !is15Days) {
      document.getElementById('quick-pagar-title-input').value = isEn
        ? `${emp.name} - ${monthLabel} Salary`
        : `${emp.name} - ${monthLabel} પગાર`;

      // Reset absent days to 0 on month change
      const absInput = document.getElementById('quick-pagar-absent-days');
      if (absInput) absInput.value = '0';
      const totInput = document.getElementById('quick-pagar-total-days');
      if (totInput) totInput.value = '30';

      this.onQuickPagarAttendanceChange();
    }
  },

  onQuickPagarAttendanceChange() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const empId = document.getElementById('quick-pagar-emp-id').value;
    const emp = (this.employeesList || []).find(e => e.id === empId);
    if (!emp) return;

    const is15Days = emp.paymentType === '15days';
    const val = document.getElementById('quick-pagar-month').value;
    const monthLabel = this.getGujaratiMonthName(val);
    const salary = Number(emp.salary) || 0;

    const totalDays = Math.max(1, Number(document.getElementById('quick-pagar-total-days')?.value) || (is15Days ? 15 : 30));
    const absentDays = Math.max(0, Number(document.getElementById('quick-pagar-absent-days')?.value) || 0);

    const dailyRate = Math.round(salary / totalDays);
    const absentDeduction = Math.min(salary, Math.round(absentDays * dailyRate));
    const earnedSalary = Math.max(0, salary - absentDeduction);

    // Update attendance display
    const rateEl = document.getElementById('quick-pagar-daily-rate');
    if (rateEl) rateEl.textContent = `દરરોજ: ₹${dailyRate.toLocaleString('en-IN')}`;

    const earnedEl = document.getElementById('quick-pagar-earned-display');
    if (earnedEl) earnedEl.textContent = `₹ ${earnedSalary.toLocaleString('en-IN')}`;

    const noticeEl = document.getElementById('quick-pagar-attendance-notice');
    if (noticeEl) {
      if (absentDays > 0) {
        noticeEl.style.display = 'block';
        noticeEl.textContent = is15Days
          ? `⚠️ ગેરહાજર ${absentDays} દિવસની કપાત: -₹${absentDeduction.toLocaleString('en-IN')} (${totalDays} દિવસ ચક્ર)`
          : `⚠️ ગેરહાજર ${absentDays} દિવસની કપાત: -₹${absentDeduction.toLocaleString('en-IN')} (${totalDays} દિવસ માસ)`;
      } else {
        noticeEl.style.display = 'none';
      }
    }

    // Extract opening balance from monthlyHistory for this month
    let openingBalance = 0;
    if (Array.isArray(emp.monthlyHistory)) {
      const histItem = emp.monthlyHistory.find(h => h.month === val);
      if (histItem) {
        openingBalance = Number(histItem.openingBalance) || 0;
      }
    } else {
      openingBalance = Number(emp.openingBalance) || 0;
    }

    // Calculate this month's upad and paid salary
    const monthUpads = (emp.upads || []).filter(u => {
      const m = u.forMonth || (u.date ? u.date.slice(0, 7) : '');
      return m === val;
    });
    const monthUpad = monthUpads.reduce((s, u) => s + (Number(u.amount) || 0), 0);

    const monthPagars = (emp.pagars || []).filter(p => {
      const m = p.forMonth || (p.date ? p.date.slice(0, 7) : '');
      return m === val;
    });
    const monthPagarPaid = monthPagars.reduce((s, p) => s + (Number(p.amount) || 0), 0);

    // Net payable formula: Opening Balance + Earned Salary - Month Upad - Month Pagar Paid
    const netBalance = openingBalance + earnedSalary - monthUpad - monthPagarPaid;

    const amtInput = document.getElementById('quick-pagar-amount');
    if (amtInput) {
      amtInput.value = netBalance > 0 ? netBalance : '';
    }

    // Update Formula Helper text
    const helperEl = document.getElementById('quick-pagar-formula-helper');
    if (helperEl) {
      let formulaText = `ગણતરી: કમાયેલ ₹${earnedSalary.toLocaleString('en-IN')}`;
      if (openingBalance !== 0) {
        formulaText += openingBalance > 0 ? ` + જૂની બાકી ₹${openingBalance.toLocaleString('en-IN')}` : ` - જૂનો ઉપાડ ₹${Math.abs(openingBalance).toLocaleString('en-IN')}`;
      }
      if (monthUpad > 0) formulaText += ` - ઉપાડ ₹${monthUpad.toLocaleString('en-IN')}`;
      if (monthPagarPaid > 0) formulaText += ` - ચૂકવેલ ₹${monthPagarPaid.toLocaleString('en-IN')}`;
      formulaText += ` = ચોખ્ખો બાકી ₹${netBalance.toLocaleString('en-IN')}`;
      helperEl.textContent = formulaText;
    }

    const infoBox = document.getElementById('quick-pagar-emp-info');
    if (infoBox) {
      let opBadge = '';
      if (openingBalance > 0) {
        opBadge = `<span>🔄 અગાઉની બાકી: <strong style="color: #4338ca;">+₹${openingBalance.toLocaleString('en-IN')}</strong></span>`;
      } else if (openingBalance < 0) {
        opBadge = `<span>🔄 જૂનો ઉપાડ: <strong style="color: #ea580c;">-₹${Math.abs(openingBalance).toLocaleString('en-IN')}</strong></span>`;
      }

      const salaryLabel = isEn ? 'Salary:' : 'પગાર:';
      const advanceLabel = isEn ? 'Advance:' : 'ઉપાડ:';
      const roleBadge = (emp.role && emp.role.trim() && emp.role !== 'undefined') ? `<span style="font-size: 0.75rem; background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 9999px; font-weight: 700;">${emp.role}</span>` : '';
      const badgeType = is15Days
        ? `<span style="background: #fef3c7; color: #92400e; font-size: 0.75rem; padding: 2px 8px; border-radius: 9999px; font-weight: 800;">૧૫ દિવસીય</span>`
        : `<span style="background: #e0e7ff; color: #3730a3; font-size: 0.75rem; padding: 2px 8px; border-radius: 9999px; font-weight: 800;">માસિક</span>`;

      infoBox.innerHTML = `
        <div style="font-weight: 800; font-size: 1.05rem; color: #065f46; display: flex; align-items: center; gap: 8px;">
          <span>👤 ${emp.name}</span>
          ${roleBadge}
          ${badgeType}
        </div>
        <div style="display: flex; gap: 12px; margin-top: 6px; font-size: 0.86rem; flex-wrap: wrap;">
          <span>💼 ${salaryLabel} <strong>₹${salary.toLocaleString('en-IN')}</strong></span>
          ${opBadge}
          <span>🔻 ${advanceLabel} <strong style="color: #b91c1c;">₹${monthUpad.toLocaleString('en-IN')}</strong></span>
          ${monthPagarPaid > 0 ? `<span>💵 ${isEn ? 'Paid Salary:' : 'ચૂકવેલ પગાર:'} <strong style="color: #2563eb;">₹${monthPagarPaid.toLocaleString('en-IN')}</strong></span>` : ''}
          <span>🟢 ${isEn ? 'Net Payable:' : 'ચોખ્ખો બાકી પગાર:'} <strong style="color: ${netBalance >= 0 ? '#059669' : '#b91c1c'}; font-size: 1rem;">${netBalance >= 0 ? '₹' : '-₹'}${Math.abs(netBalance).toLocaleString('en-IN')}</strong></span>
        </div>
      `;
    }
  },

  async submitQuickPagar() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const id = document.getElementById('quick-pagar-emp-id').value;
    const amount = Number(document.getElementById('quick-pagar-amount').value);
    const title = document.getElementById('quick-pagar-title-input').value.trim();
    const date = document.getElementById('quick-pagar-date').value;
    const forMonth = document.getElementById('quick-pagar-month').value || (date ? date.slice(0, 7) : '');
    const remarks = document.getElementById('quick-pagar-remarks').value.trim();
    const pagarHisabEl = document.getElementById('quick-pagar-add-to-hisab');
    const addToHisab = pagarHisabEl ? (pagarHisabEl.type === 'checkbox' ? pagarHisabEl.checked : true) : true;

    if (isNaN(amount) || amount <= 0) {
      this.showToast(isEn ? 'Enter valid salary amount' : 'સાચી પગાર રકમ લખો', 'error');
      document.getElementById('quick-pagar-amount').focus();
      return;
    }

    const emp = (this.employeesList || []).find(e => e.id === id);
    const salary = emp ? Number(emp.salary) || 0 : 0;
    const totalMonthDays = Math.max(1, Number(document.getElementById('quick-pagar-total-days')?.value) || 30);
    const absentDays = Math.max(0, Number(document.getElementById('quick-pagar-absent-days')?.value) || 0);
    const dailyRate = Math.round(salary / totalMonthDays);
    const absentDeduction = Math.min(salary, Math.round(absentDays * dailyRate));
    const earnedSalary = Math.max(0, salary - absentDeduction);

    let openingBalance = 0;
    if (emp && Array.isArray(emp.monthlyHistory)) {
      const histItem = emp.monthlyHistory.find(h => h.month === forMonth);
      if (histItem) openingBalance = Number(histItem.openingBalance) || 0;
    } else if (emp) {
      openingBalance = Number(emp.openingBalance) || 0;
    }

    const monthUpads = emp ? (emp.upads || []).filter(u => (u.forMonth || (u.date ? u.date.slice(0, 7) : '')) === forMonth) : [];
    const upadDeduction = monthUpads.reduce((s, u) => s + (Number(u.amount) || 0), 0);

    const fromDate = document.getElementById('quick-pagar-from-date')?.value || null;
    const toDate = document.getElementById('quick-pagar-to-date')?.value || null;

    try {
      const res = await fetch(`/api/employees/${id}/pagar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          title,
          date,
          forMonth,
          fromDate,
          toDate,
          remarks,
          addToHisab,
          totalMonthDays,
          absentDays,
          absentDeduction,
          earnedSalary,
          openingBalance,
          upadDeduction
        })
      });
      const data = await res.json();
      if (data && data.success) {
        this.closeModal('modal-employee-quick-pagar');
        const is15Days = emp && emp.paymentType === '15days';
        const monthLabel = this.getGujaratiMonthName(forMonth);
        let successMsg = '';
        if (is15Days) {
          const fromFmt = fromDate ? this.formatDateDisplay(fromDate) : '';
          const toFmt = toDate ? this.formatDateDisplay(toDate) : '';
          const rangeInfo = (fromFmt && toFmt) ? ` (તા. ${fromFmt} થી ${toFmt})` : '';
          successMsg = isEn
            ? `₹${amount.toLocaleString('en-IN')} 15-day salary${rangeInfo} paid and added to expenses under 'PAGAR' voucher!`
            : `₹${amount.toLocaleString('en-IN')} નો ૧૫ દિવસનો પગાર${rangeInfo} ચૂકવાયો અને ખર્ચમાં 'PAGAR' વાઉચરમાં ચડી ગયો!`;
        } else {
          successMsg = isEn
            ? `₹${amount.toLocaleString('en-IN')} salary of ${monthLabel} paid and added to expenses under 'PAGAR' voucher!`
            : `₹${amount.toLocaleString('en-IN')} નો ${monthLabel} માસનો પગાર ચૂકવાયો અને ખર્ચમાં 'PAGAR' વાઉચરમાં ચડી ગયો!`;
        }
        this.showToast(successMsg, 'success');
        await this.loadEmployees(this.employeeMonthFilter);

        // If open in ledger, refresh ledger
        if (this.selectedEmployeeForLedger && this.selectedEmployeeForLedger.id === id) {
          this.openEmployeeLedger(id);
        }

        // If added to hisab for today, reload today's record
        if (addToHisab && date === this.currentDate) {
          await this.loadDate(this.currentDate);
        }
        this.notifyDataChanged('employee_pagar', date);
      }
    } catch (e) {
      this.showToast(isEn ? 'Error saving salary' : 'પગાર સેવ કરવામાં ભૂલ આવી', 'error');
    }
  },

  async deleteEmployeeUpad(empId, upadId) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const emp = (this.employeesList || []).find(e => e.id === empId);
    const targetEntry = emp && Array.isArray(emp.upads) ? emp.upads.find(u => u.id === upadId) : null;
    const entryDate = targetEntry?.date;
    const isPast = entryDate && (entryDate < this.getTodayDateStr());

    if (isPast) {
      const authMsg = isEn
        ? `⚠️ Warning: This advance entry (${targetEntry.title || 'Advance'} - ₹${Number(targetEntry.amount || 0).toLocaleString('en-IN')}) is recorded in locked hisab of ${entryDate}!\n\nEnter Admin PIN to delete this entry from locked hisab and staff account:`
        : `⚠️ ચેતવણી: આ ઉપાડ (${targetEntry.title || 'ઉપાડ'} - ₹${Number(targetEntry.amount || 0).toLocaleString('en-IN')}) તારીખ ${entryDate} ના લૉક થયેલા હિસાબમાં નોંધાયેલ છે!\n\nલૉક હિસાબ અને સ્ટાફ ખાતામાંથી આ એન્ટ્રી રદ કરવા માટે એડમિન પિન દાખલ કરો:`;
      const hasAuth = await this.ensureAdminAuth(authMsg);
      if (!hasAuth) return;
    } else {
      const confirmMsg = isEn
        ? 'Are you sure you want to delete this advance entry? This voucher will also be deducted from today\'s daily hisab.'
        : 'શું તમે આ ઉપાડ એન્ટ્રી કાઢી નાખવા માંગો છો? આ વાઉચર આજના દૈનિક હિસાબમાંથી પણ બાદ થશે.';
      if (!confirm(confirmMsg)) return;
    }

    try {
      const res = await fetch(`/api/employees/${empId}/upad/${upadId}`, {
        method: 'DELETE',
        headers: this.getAdminAuthHeaders()
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;
      if (data && data.success) {
        const successMsg = isEn
          ? `✅ Advance entry deleted and deducted from ${isPast ? `locked hisab of ${entryDate}` : "today's"} hisab.`
          : `✅ ઉપાડ એન્ટ્રી કાઢી નાખવામાં આવી અને ${isPast ? `તારીખ ${entryDate} ના લૉક` : 'આજના'} હિસાબમાંથી પણ બાદ થઈ.`;
        this.showToast(successMsg, 'success');
        await this.loadEmployees();
        this.openEmployeeLedger(empId);
        if (data.removed && data.removed.date === this.currentDate) {
          await this.loadDate(this.currentDate);
        }
      } else {
        this.showToast(data.error || (isEn ? 'Error deleting entry' : 'કાઢી નાખવામાં ભૂલ આવી'), 'error');
      }
    } catch (e) {
      this.showToast(isEn ? 'Error deleting entry' : 'કાઢી નાખવામાં ભૂલ આવી', 'error');
    }
  },

  async deleteEmployeePagar(empId, pagarId) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const emp = (this.employeesList || []).find(e => e.id === empId);
    const targetEntry = emp && Array.isArray(emp.pagars) ? emp.pagars.find(p => p.id === pagarId) : null;
    const entryDate = targetEntry?.date;
    const isPast = entryDate && (entryDate < this.getTodayDateStr());

    if (isPast) {
      const authMsg = isEn
        ? `⚠️ Warning: This salary payment (${targetEntry.title || 'Salary'} - ₹${Number(targetEntry.amount || 0).toLocaleString('en-IN')}) is recorded in locked hisab of ${entryDate}!\n\nEnter Admin PIN to delete this entry from locked hisab and staff account:`
        : `⚠️ ચેતવણી: આ પગાર ચૂકવણી (${targetEntry.title || 'પગાર'} - ₹${Number(targetEntry.amount || 0).toLocaleString('en-IN')}) તારીખ ${entryDate} ના લૉક થયેલા હિસાબમાં નોંધાયેલ છે!\n\nલૉક હિસાબ અને સ્ટાફ ખાતામાંથી આ એન્ટ્રી રદ કરવા માટે એડમિન પિન દાખલ કરો:`;
      const hasAuth = await this.ensureAdminAuth(authMsg);
      if (!hasAuth) return;
    } else {
      const confirmMsg = isEn
        ? 'Are you sure you want to delete this salary payment entry? This voucher will automatically be deducted from today\'s daily hisab.'
        : 'શું તમે આ પગાર ચૂકવણી એન્ટ્રી કાઢી નાખવા માંગો છો? આ વાઉચર આજના દૈનિક હિસાબમાંથી પણ આપોઆપ બાદ થઈ જશે.';
      if (!confirm(confirmMsg)) return;
    }

    try {
      const res = await fetch(`/api/employees/${empId}/pagar/${pagarId}`, {
        method: 'DELETE',
        headers: this.getAdminAuthHeaders()
      });
      const data = await res.json();
      if (this.handleAdminAuthError(res, data)) return;
      if (data && data.success) {
        const successMsg = isEn
          ? `✅ Salary payment entry deleted and deducted from ${isPast ? `locked hisab of ${entryDate}` : "today's"} hisab.`
          : `✅ પગાર ચૂકવણી એન્ટ્રી કાઢી નાખવામાં આવી અને ${isPast ? `તારીખ ${entryDate} ના લૉક` : 'આજના'} હિસાબમાંથી પણ બાદ થઈ.`;
        this.showToast(successMsg, 'success');
        await this.loadEmployees();
        this.openEmployeeLedger(empId);
        if (data.removed && data.removed.date === this.currentDate) {
          await this.loadDate(this.currentDate);
        }
      } else {
        this.showToast(data.error || (isEn ? 'Error deleting entry' : 'કાઢી નાખવામાં ભૂલ આવી'), 'error');
      }
    } catch (e) {
      this.showToast(isEn ? 'Error deleting entry' : 'કાઢી નાખવામાં ભૂલ આવી', 'error');
    }
  },

  shareEmployeeLedgerWhatsApp() {
    const emp = this.selectedEmployeeForLedger;
    if (!emp) return;

    let msg = `*👥 Gadisthan Jetpur - કર્મચારી પગાર અને ઉપાડ સ્ટેટમેન્ટ*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `👤 *કર્મચારી:* ${emp.name} (${emp.role})\n`;
    if (emp.phone) msg += `📞 *મોબાઇલ:* ${emp.phone}\n`;
    msg += `💼 *માસિક પગાર:* ₹${(emp.salary || 0).toLocaleString('en-IN')}\n`;
    msg += `🔻 *આ મહિનાનો ઉપાડ:* ₹${(emp.currentMonthUpad || 0).toLocaleString('en-IN')}\n`;
    if ((emp.currentMonthPagarPaid || 0) > 0) {
      msg += `💵 *આ મહિને ચૂકવેલ પગાર:* ₹${(emp.currentMonthPagarPaid || 0).toLocaleString('en-IN')}\n`;
    }
    msg += `🟢 *બાકી ચૂકવવાપાત્ર રકમ:* ₹${(emp.netBalance || 0).toLocaleString('en-IN')}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📜 *વિગતવાર ખાતાવહી હિસાબ:*\n`;

    const entries = [
      ...(emp.upads || []).map(u => ({ ...u, entryType: 'upad' })),
      ...(emp.pagars || []).map(p => ({ ...p, entryType: 'pagar' }))
    ];
    entries.sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));

    if (entries.length === 0) {
      msg += `• કોઈ એન્ટ્રી નથી.\n`;
    } else {
      entries.forEach((item, i) => {
        const isUpad = item.entryType === 'upad';
        const typeStr = isUpad ? '[ઉપાડ]' : '[પગાર ચૂકવણી]';
        msg += `${i + 1}. ${item.date}: ${typeStr} ₹${(item.amount || 0).toLocaleString('en-IN')} - ${item.title || ''}${item.remarks ? ` (${item.remarks})` : ''}\n`;
      });
    }
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;

    const cleanPhone = (emp.phone || '').replace(/[^0-9]/g, '');
    const fullPhone = cleanPhone.length === 10 ? '91' + cleanPhone : cleanPhone;
    const url = fullPhone ? `https://wa.me/${fullPhone}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
  },

  printEmployeeLedger() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const emp = this.selectedEmployeeForLedger;
    if (!emp) {
      this.showToast(isEn ? 'Employee ledger not available' : 'કર્મચારી ખાતાવહી ઉપલબ્ધ નથી', 'warning');
      return;
    }

    const orgName = this.settings.orgName || 'સંસ્થાન હિસાબ';
    const orgSubtitle = this.settings.orgSubtitle || 'દૈનિક ખર્ચ અને રોકડ હિસાબ પત્રક';
    const currentMonth = this.employeeMonthFilter || new Date().toISOString().slice(0, 7);
    const monthLabel = this.getGujaratiMonthName(currentMonth);

    const salary = Number(emp.salary) || 0;
    const upad = Number(emp.currentMonthUpad) || 0;
    const pagarPaid = Number(emp.currentMonthPagarPaid) || 0;
    const balance = Number(emp.netBalance) || 0;
    const totalUpadAllTime = Number(emp.totalUpadAllTime) || 0;

    const entries = [
      ...(emp.upads || []).map(u => ({ ...u, entryType: 'upad' })),
      ...(emp.pagars || []).map(p => ({ ...p, entryType: 'pagar' }))
    ];
    entries.sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));

    let totalTableUpad = 0;
    let totalTablePagar = 0;
    entries.forEach(item => {
      const amt = Number(item.amount) || 0;
      if (item.entryType === 'upad') totalTableUpad += amt;
      else totalTablePagar += amt;
    });

    let rowsHtml = '';
    if (entries.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="6" style="text-align: center; padding: 25px; color: #64748b; font-style: italic;">
            કોઈ ઉપાડ કે પગાર ચૂકવણી નોંધાયેલ નથી.
          </td>
        </tr>
      `;
    } else {
      entries.forEach((item, idx) => {
        const isUpad = item.entryType === 'upad';
        const typeBadge = isUpad ? '🔻 ઉપાડ' : '💵 પગાર';
        const amtColor = isUpad ? '#b91c1c' : '#059669';
        rowsHtml += `
          <tr>
            <td style="text-align: center; font-weight: 600;">${idx + 1}</td>
            <td style="font-weight: 700;">${item.date} ${item.time ? `<span style="font-size: 0.75rem; color: #64748b;">(${item.time})</span>` : ''}</td>
            <td style="font-weight: 700; color: ${amtColor};">${typeBadge}</td>
            <td style="font-weight: 600;">${item.title || (isUpad ? 'ઉપાડ' : 'પગાર')}</td>
            <td style="text-align: right; font-weight: 800; color: ${amtColor}; font-family: monospace, sans-serif; font-size: 1rem;">
              ₹ ${(Number(item.amount) || 0).toLocaleString('en-IN')}
            </td>
            <td style="font-size: 0.82rem; color: #475569;">${item.remarks || '-'}</td>
          </tr>
        `;
      });
    }

    const printHtml = `
      <!DOCTYPE html>
      <html lang="gu">
      <head>
        <meta charset="UTF-8">
        <title>કર્મચારી ખાતાવહી - ${emp.name}</title>
        <style>
          @page { size: A4 portrait; margin: 12mm 15mm; }
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Gujarati", sans-serif;
            color: #0f172a;
            margin: 0;
            padding: 20px;
            background: #ffffff;
            font-size: 13px;
            line-height: 1.45;
          }
          .header-box {
            text-align: center;
            border-bottom: 2px solid #0f172a;
            padding-bottom: 12px;
            margin-bottom: 16px;
          }
          .org-title {
            font-size: 1.55rem;
            font-weight: 800;
            color: #1e3a8a;
            margin: 0;
          }
          .org-sub {
            font-size: 0.95rem;
            color: #475569;
            margin-top: 2px;
            font-weight: 600;
          }
          .slip-title {
            display: inline-block;
            margin-top: 8px;
            background: #f1f5f9;
            border: 1px solid #cbd5e1;
            padding: 4px 18px;
            border-radius: 20px;
            font-weight: 800;
            font-size: 0.95rem;
            color: #0f172a;
            letter-spacing: 0.5px;
          }
          .info-grid {
            display: grid;
            grid-template-columns: 1.2fr 1fr;
            gap: 12px;
            margin-bottom: 16px;
          }
          .info-card {
            border: 1px solid #cbd5e1;
            border-radius: 8px;
            padding: 10px 14px;
            background: #f8fafc;
          }
          .info-table {
            width: 100%;
            border-collapse: collapse;
          }
          .info-table td {
            padding: 4px 6px;
            font-size: 0.9rem;
          }
          .info-lbl {
            font-weight: 700;
            color: #475569;
            width: 40%;
          }
          .info-val {
            font-weight: 800;
            color: #0f172a;
          }
          .kpi-row {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 10px;
            margin-bottom: 18px;
          }
          .kpi-box {
            border: 1.5px solid #cbd5e1;
            border-radius: 8px;
            padding: 8px 12px;
            text-align: center;
          }
          .kpi-box.kpi-salary { background: #eff6ff; border-color: #93c5fd; }
          .kpi-box.kpi-upad { background: #fff1f2; border-color: #fecdd3; }
          .kpi-box.kpi-paid { background: #ecfeff; border-color: #a5f3fc; }
          .kpi-box.kpi-balance { background: #f0fdf4; border-color: #86efac; }
          .kpi-title { font-size: 0.78rem; font-weight: 700; color: #475569; margin-bottom: 2px; }
          .kpi-num { font-size: 1.2rem; font-weight: 900; }
          .table-ledger {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 25px;
          }
          .table-ledger th {
            background: #1e293b;
            color: #ffffff;
            font-weight: 700;
            padding: 8px 10px;
            font-size: 0.85rem;
            border: 1px solid #0f172a;
          }
          .table-ledger td {
            padding: 7px 10px;
            border: 1px solid #cbd5e1;
            font-size: 0.85rem;
          }
          .table-ledger tbody tr:nth-child(even) {
            background: #f8fafc;
          }
          .footer-summary {
            background: #f1f5f9;
            font-weight: 800;
          }
          .sign-area {
            display: flex;
            justify-content: space-between;
            margin-top: 45px;
            padding: 0 20px;
          }
          .sign-box {
            text-align: center;
            width: 200px;
            border-top: 1.5px dashed #475569;
            padding-top: 8px;
            font-weight: 800;
            font-size: 0.88rem;
          }
          .action-bar-no-print {
            position: fixed;
            top: 15px;
            right: 20px;
            display: flex;
            gap: 10px;
            z-index: 1000;
          }
          .print-btn {
            background: #0284c7;
            color: #fff;
            border: none;
            padding: 8px 16px;
            font-weight: 700;
            border-radius: 6px;
            cursor: pointer;
            box-shadow: 0 4px 6px rgba(0,0,0,0.15);
          }
          .close-btn {
            background: #475569;
            color: #fff;
            border: none;
            padding: 8px 16px;
            font-weight: 700;
            border-radius: 6px;
            cursor: pointer;
          }
          @media print {
            .action-bar-no-print { display: none !important; }
            body { padding: 0; }
          }
        </style>
      </head>
      <body>
        <div class="action-bar-no-print">
          <button class="print-btn" onclick="window.print()">🖨️ પ્રિન્ટ કાઢો (Print)</button>
          <button class="close-btn" onclick="window.close()">✕ બંધ કરો</button>
        </div>

        <div class="header-box">
          <h1 class="org-title">${orgName}</h1>
          <div class="org-sub">${orgSubtitle}</div>
          <div class="slip-title">📋 કર્મચારી ખાતાવહી / પાસબુક સ્ટેટમેન્ટ</div>
          <div style="font-size: 0.78rem; color: #64748b; margin-top: 6px;">
            તારીખ: ${new Date().toLocaleDateString('gu-IN')} | સમય: ${new Date().toLocaleTimeString('gu-IN', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

        <div class="info-grid">
          <div class="info-card">
            <table class="info-table">
              <tr>
                <td class="info-lbl">👤 કર્મચારીનું નામ:</td>
                <td class="info-val">${emp.name}</td>
              </tr>
              <tr>
                <td class="info-lbl">🏷️ હોદ્દો / કામગીરી:</td>
                <td class="info-val">${emp.role || 'સ્ટાફ'}</td>
              </tr>
              <tr>
                <td class="info-lbl">📞 મોબાઇલ નંબર:</td>
                <td class="info-val">${emp.phone || '-'}</td>
              </tr>
            </table>
          </div>
          <div class="info-card">
            <table class="info-table">
              <tr>
                <td class="info-lbl">📅 જોડાવાની તારીખ:</td>
                <td class="info-val">${emp.joiningDate || '-'}</td>
              </tr>
              <tr>
                <td class="info-lbl">💼 નિયત માસિક પગાર:</td>
                <td class="info-val" style="color: #1e3a8a;">₹ ${salary.toLocaleString('en-IN')}</td>
              </tr>
              <tr>
                <td class="info-lbl">🗓️ ચાલુ હિસાબી માસ:</td>
                <td class="info-val" style="color: #059669;">${monthLabel}</td>
              </tr>
            </table>
          </div>
        </div>

        <div class="kpi-row">
          <div class="kpi-box kpi-salary">
            <div class="kpi-title">માસિક પગાર</div>
            <div class="kpi-num" style="color: #1e40af;">₹ ${salary.toLocaleString('en-IN')}</div>
          </div>
          <div class="kpi-box kpi-upad">
            <div class="kpi-title">${monthLabel} ઉપાડ</div>
            <div class="kpi-num" style="color: #b91c1c;">₹ ${upad.toLocaleString('en-IN')}</div>
          </div>
          <div class="kpi-box kpi-paid">
            <div class="kpi-title">${monthLabel} ચૂકવેલ પગાર</div>
            <div class="kpi-num" style="color: #0284c7;">₹ ${pagarPaid.toLocaleString('en-IN')}</div>
          </div>
          <div class="kpi-box kpi-balance">
            <div class="kpi-title">ચોખ્ખી બાકી રકમ</div>
            <div class="kpi-num" style="color: #059669;">₹ ${balance.toLocaleString('en-IN')}</div>
          </div>
        </div>

        <div style="font-weight: 800; font-size: 0.95rem; margin-bottom: 6px; color: #1e293b;">
          📜 વિગતવાર ખાતાવહી વ્યવહારો (Ledger Transactions):
        </div>
        <table class="table-ledger">
          <thead>
            <tr>
              <th style="width: 40px; text-align: center;">#</th>
              <th style="width: 110px;">તારીખ</th>
              <th style="width: 90px;">પ્રકાર</th>
              <th>વિગત / બાબત</th>
              <th style="width: 120px; text-align: right;">રકમ (₹)</th>
              <th style="width: 160px;">વિશેષ નોંધ</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
          <tfoot>
            <tr class="footer-summary">
              <td colspan="4" style="text-align: right; padding: 8px 10px;">કુલ હિસાબ સરવાળો:</td>
              <td style="text-align: right; padding: 8px 10px; font-size: 0.95rem; color: #0f172a;">
                ઉપાડ: ₹ ${totalTableUpad.toLocaleString('en-IN')}<br>
                પગાર: ₹ ${totalTablePagar.toLocaleString('en-IN')}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>

        <div class="sign-area">
          <div class="sign-box">
            કર્મચારીની સહી<br>
            <span style="font-size: 0.75rem; font-weight: normal; color: #64748b;">(${emp.name})</span>
          </div>
          <div class="sign-box">
            હિસાબનીશ / વહીવટકર્તાની સહી<br>
            <span style="font-size: 0.75rem; font-weight: normal; color: #64748b;">(ઓથોરાઇઝ્ડ સિગ્નેચર)</span>
          </div>
        </div>

        <script>
          window.addEventListener('load', () => {
            setTimeout(() => {
              window.print();
            }, 300);
          });
        </script>
      </body>
      </html>
    `;

    this.openPrintWindow(printHtml);
  },

  // =========================================================================
  // EMPLOYEE SALARY & CASH ADVANCE STATEMENT (કર્મચારી પગાર અને રોકડ ઉપાડ પત્રક)
  // =========================================================================
  salarySheetEmployees: [],
  salarySheetSummary: null,
  salarySheetMonth: null,

  async openEmployeeSalarySheetModal(month = null) {
    if (window.i18n) window.i18n.updateDOM();
    const m = month || this.employeeMonthFilter || this.getDefaultSalaryMonth();
    this.salarySheetMonth = m;
    const mInput = document.getElementById('sheet-month-filter');
    if (mInput) mInput.value = m;
    const sInput = document.getElementById('sheet-search-input');
    if (sInput) sInput.value = '';

    this.openModal('modal-employee-salary-sheet');
    await this.loadAndRenderSalarySheet();
  },

  async onSalarySheetMonthChange(newMonth) {
    if (!newMonth) return;
    this.salarySheetMonth = newMonth;
    await this.loadAndRenderSalarySheet();
  },

  async loadAndRenderSalarySheet() {
    const m = this.salarySheetMonth || this.getDefaultSalaryMonth();
    try {
      const res = await fetch(`/api/employees?month=${m}`);
      const data = await res.json();
      if (data && data.success) {
        this.salarySheetEmployees = data.employees || [];
        this.salarySheetSummary = data.summary || {};
        this.renderSalarySheetTable();
      }
    } catch (e) {
      console.error('Failed to load salary sheet data:', e);
      this.showToast('પગાર પત્રક લોડ કરવામાં ભૂલ આવી', 'error');
    }
  },

  filterSalarySheet(query = '') {
    this.renderSalarySheetTable(query);
  },

  renderSalarySheetTable(query = '') {
    const list = this.salarySheetEmployees || [];
    const q = (query || (document.getElementById('sheet-search-input')?.value || '')).trim().toLowerCase();
    const filtered = list.filter(e => {
      if (!q) return true;
      return (e.name || '').toLowerCase().includes(q) ||
             (e.role || e.designation || '').toLowerCase().includes(q) ||
             (e.phone || '').toLowerCase().includes(q);
    });

    const m = this.salarySheetMonth || this.getDefaultSalaryMonth();

    // Totals of filtered list
    let totPayroll = 0;
    let totUpad = 0;
    let totOpening = 0;
    let totPayable = 0;

    filtered.forEach(e => {
      totPayroll += (Number(e.salary) || 0);
      totUpad += (Number(e.currentMonthUpad) || 0);
      totOpening += (Number(e.openingBalance) || 0);
      totPayable += (Number(e.netBalance) || 0);
    });

    // Update KPI summary cards
    const countEl = document.getElementById('sheet-summary-count');
    const payEl = document.getElementById('sheet-summary-payroll');
    const upadEl = document.getElementById('sheet-summary-upad');
    const payableEl = document.getElementById('sheet-summary-payable');

    if (countEl) countEl.textContent = filtered.length;
    if (payEl) payEl.textContent = '₹ ' + totPayroll.toLocaleString('en-IN');
    if (upadEl) upadEl.textContent = '₹ ' + totUpad.toLocaleString('en-IN');
    if (payableEl) payableEl.textContent = '₹ ' + totPayable.toLocaleString('en-IN');

    // Update Table Footers
    const footSalary = document.getElementById('sheet-foot-total-salary');
    const footUpad = document.getElementById('sheet-foot-total-upad');
    const footOpening = document.getElementById('sheet-foot-total-opening');
    const footPayable = document.getElementById('sheet-foot-total-payable');

    if (footSalary) footSalary.textContent = '₹ ' + totPayroll.toLocaleString('en-IN');
    if (footUpad) footUpad.textContent = '₹ ' + totUpad.toLocaleString('en-IN');
    if (footOpening) footOpening.textContent = (totOpening >= 0 ? '+₹ ' : '-₹ ') + Math.abs(totOpening).toLocaleString('en-IN');
    if (footPayable) footPayable.textContent = '₹ ' + totPayable.toLocaleString('en-IN');

    const tbody = document.getElementById('tbody-salary-sheet');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 30px; color: #64748b; font-size: 0.95rem;">
            🔍 કોઈ કર્મચારી મળ્યો નથી.
          </td>
        </tr>
      `;
      return;
    }

    filtered.forEach((emp, idx) => {
      const salary = Number(emp.salary) || 0;
      const upad = Number(emp.currentMonthUpad) || 0;
      const opening = Number(emp.openingBalance) || 0;
      const netPayable = Number(emp.netBalance) || 0;
      const is15Days = emp.paymentType === '15days';

      let upadDetail = '<span style="color: #94a3b8;">ઉપાડ નથી</span>';
      if (upad > 0) {
        upadDetail = `<span style="color: #dc2626; font-weight: 700;">₹ ${upad.toLocaleString('en-IN')}</span>${emp.monthUpadsCount > 0 ? `<div style="font-size: 0.72rem; color: #64748b;">(${emp.monthUpadsCount} વખત ઉપાડ)</div>` : ''}`;
      }

      let openingDetail = '<span style="color: #94a3b8;">-</span>';
      if (opening > 0) {
        openingDetail = `<span style="color: #4338ca; font-weight: 700;">+₹ ${opening.toLocaleString('en-IN')}</span><div style="font-size: 0.68rem; color: #6366f1;">(અગાઉની બાકી)</div>`;
      } else if (opening < 0) {
        openingDetail = `<span style="color: #ea580c; font-weight: 700;">-₹ ${Math.abs(opening).toLocaleString('en-IN')}</span><div style="font-size: 0.68rem; color: #f97316;">(જૂનો ઉપાડ)</div>`;
      }

      let payableBadge = '';
      if (netPayable > 0) {
        payableBadge = `<span style="color: #059669; font-weight: 900; font-size: 1rem;">₹ ${netPayable.toLocaleString('en-IN')}</span>`;
      } else if (netPayable < 0) {
        payableBadge = `<span style="color: #dc2626; font-weight: 800; font-size: 0.95rem;">-₹ ${Math.abs(netPayable).toLocaleString('en-IN')}</span><div style="font-size: 0.68rem; color: #b91c1c;">(વધારાનો ઉપાડ)</div>`;
      } else {
        payableBadge = `<span style="color: #059669; font-weight: 700;">₹ 0</span> <span style="font-size: 0.72rem; color: #16a34a;">(✓ હિસાબ પૂર્ણ)</span>`;
      }

      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid #e2e8f0';
      tr.innerHTML = `
        <td style="text-align: center; font-weight: 600; color: #64748b; padding: 9px 8px;">${idx + 1}</td>
        <td style="padding: 9px 10px;">
          <div style="font-weight: 800; color: #0f172a; font-size: 0.95rem;">${emp.name}</div>
          ${emp.phone ? `<div style="font-size: 0.72rem; color: #64748b;">📞 ${emp.phone}</div>` : ''}
        </td>
        <td style="padding: 9px 8px; font-size: 0.85rem; color: #334155;">
          ${emp.role || emp.designation || 'કર્મચારી'}
          <div style="font-size: 0.68rem; color: #64748b;">${is15Days ? '૧૫ દિવસીય' : 'માસિક'}</div>
        </td>
        <td style="text-align: right; padding: 9px 10px; font-weight: 700; font-size: 0.95rem; color: #0284c7; font-family: monospace, sans-serif;">
          ₹ ${salary.toLocaleString('en-IN')}
        </td>
        <td style="text-align: right; padding: 9px 10px; font-family: monospace, sans-serif;">
          ${upadDetail}
        </td>
        <td style="text-align: right; padding: 9px 10px; font-family: monospace, sans-serif;">
          ${openingDetail}
        </td>
        <td style="text-align: right; padding: 9px 10px; background: #ecfdf5; font-family: monospace, sans-serif;">
          ${payableBadge}
        </td>
        <td style="text-align: center; padding: 9px 8px;">
          <span style="font-size: 0.75rem; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; font-weight: 700; padding: 3px 8px; border-radius: 12px; display: inline-flex; align-items: center; gap: 3px;">
            🏦 બેંક ટ્રાન્સફર
          </span>
        </td>
      `;
      tbody.appendChild(tr);
    });
  },

  async printEmployeeSalarySheet(targetMonth = null) {
    const m = targetMonth || this.salarySheetMonth || this.employeeMonthFilter || this.getDefaultSalaryMonth();
    let emps = this.salarySheetEmployees;

    if (!emps || emps.length === 0 || (this.salarySheetMonth && this.salarySheetMonth !== m)) {
      try {
        const res = await fetch(`/api/employees?month=${m}`);
        const data = await res.json();
        if (data && data.success) {
          emps = data.employees || [];
        }
      } catch (e) {
        console.error('Fetch error:', e);
      }
    }

    const monthLabel = this.getGujaratiMonthName(m);
    const todayStr = this.getTodayDateStr();

    let totPayroll = 0;
    let totUpad = 0;
    let totOpening = 0;
    let totPayable = 0;

    let rowsHtml = '';
    (emps || []).forEach((emp, idx) => {
      const sal = Number(emp.salary) || 0;
      const upd = Number(emp.currentMonthUpad) || 0;
      const op = Number(emp.openingBalance) || 0;
      const pay = Number(emp.netBalance) || 0;

      totPayroll += sal;
      totUpad += upd;
      totOpening += op;
      totPayable += pay;

      rowsHtml += `
        <tr>
          <td style="text-align: center; font-weight: 600;">${idx + 1}</td>
          <td style="font-weight: 800; color: #0f172a;">${emp.name}</td>
          <td style="color: #334155;">${emp.role || emp.designation || 'કર્મચારી'}</td>
          <td style="text-align: right; font-weight: 700; font-family: monospace, sans-serif;">₹ ${sal.toLocaleString('en-IN')}</td>
          <td style="text-align: right; font-weight: 700; color: #dc2626; font-family: monospace, sans-serif;">${upd > 0 ? '₹ ' + upd.toLocaleString('en-IN') : '-'}</td>
          <td style="text-align: right; font-weight: 600; color: #4338ca; font-family: monospace, sans-serif;">${op !== 0 ? (op > 0 ? '+₹ ' : '-₹ ') + Math.abs(op).toLocaleString('en-IN') : '-'}</td>
          <td style="text-align: right; font-weight: 900; color: #047857; background: #f0fdf4; font-family: monospace, sans-serif; font-size: 1.05rem;">₹ ${pay.toLocaleString('en-IN')}</td>
          <td style="text-align: center; font-size: 11px; color: #1e40af;">બેંક ટ્રાન્સફર</td>
        </tr>
      `;
    });

    const printHtml = `
      <!DOCTYPE html>
      <html lang="gu">
      <head>
        <meta charset="UTF-8">
        <title>કર્મચારી માસિક પગાર અને રોકડ ઉપાડ પત્રક - ${monthLabel}</title>
        <style>
          @page { size: A4 portrait; margin: 12mm 14mm; }
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Gujarati", sans-serif;
            color: #0f172a;
            margin: 0;
            padding: 16px;
            background: #ffffff;
            font-size: 12px;
            line-height: 1.4;
          }
          .header-box {
            text-align: center;
            border-bottom: 2px solid #0f172a;
            padding-bottom: 10px;
            margin-bottom: 14px;
          }
          .org-title {
            font-size: 18px;
            font-weight: 900;
            letter-spacing: 0.5px;
            color: #1e3a8a;
            margin-bottom: 3px;
          }
          .sheet-title {
            font-size: 15px;
            font-weight: 800;
            color: #0f172a;
            margin-bottom: 4px;
          }
          .meta-row {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: #475569;
            margin-top: 6px;
          }
          .kpi-bar {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
            margin-bottom: 14px;
          }
          .kpi-cell {
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            padding: 6px 10px;
            text-align: center;
          }
          .kpi-title { font-size: 10.5px; font-weight: 700; color: #475569; }
          .kpi-val { font-size: 14px; font-weight: 900; margin-top: 2px; }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 16px;
          }
          th {
            background: #1e293b;
            color: #ffffff;
            font-weight: 800;
            padding: 7px 8px;
            font-size: 11px;
            border: 1px solid #0f172a;
            text-align: left;
          }
          td {
            padding: 6px 8px;
            border: 1px solid #cbd5e1;
            font-size: 11.5px;
          }
          .total-row td {
            background: #e2e8f0;
            font-weight: 900;
            font-size: 12px;
            border-top: 2px solid #0f172a;
          }
          .note-box {
            background: #f8fafc;
            border: 1px dashed #94a3b8;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 10.5px;
            color: #334155;
            margin-bottom: 24px;
            line-height: 1.45;
          }
          .sign-row {
            display: flex;
            justify-content: space-between;
            margin-top: 40px;
            padding: 0 20px;
          }
          .sign-col {
            text-align: center;
            border-top: 1px dashed #475569;
            width: 160px;
            padding-top: 5px;
            font-size: 11px;
            font-weight: 700;
          }
          .action-bar-no-print {
            position: fixed;
            top: 15px;
            right: 20px;
            display: flex;
            gap: 10px;
            z-index: 1000;
          }
          .print-btn {
            background: #1e3a8a;
            color: #fff;
            border: none;
            padding: 8px 16px;
            font-weight: 700;
            border-radius: 6px;
            cursor: pointer;
            box-shadow: 0 4px 6px rgba(0,0,0,0.15);
          }
          .close-btn {
            background: #475569;
            color: #fff;
            border: none;
            padding: 8px 16px;
            font-weight: 700;
            border-radius: 6px;
            cursor: pointer;
          }
          @media print {
            .action-bar-no-print { display: none !important; }
            body { padding: 0; }
          }
        </style>
      </head>
      <body>
        <div class="action-bar-no-print">
          <button class="print-btn" onclick="window.print()">🖨️ પ્રિન્ટ કરો / PDF</button>
          <button class="close-btn" onclick="window.close()">✖️ બંધ કરો</button>
        </div>

        <div class="header-box">
          <div class="org-title">શ્રી ગાદીસ્થાન સ્વામિનારાયણ મંદિર</div>
          <div class="sheet-title">📋 કર્મચારી માસિક પગાર અને રોકડ ઉપાડ હિસાબ પત્રક</div>
          <div class="meta-row">
            <span><strong>હિસાબી માસ:</strong> ${monthLabel}</span>
            <span><strong>કુલ સ્ટાફ:</strong> ${(emps || []).length} કર્મચારીઓ</span>
            <span><strong>પ્રિન્ટ તારીખ:</strong> ${todayStr}</span>
          </div>
        </div>

        <div class="kpi-bar">
          <div class="kpi-cell" style="background: #eff6ff;">
            <div class="kpi-title">કુલ માસિક પગાર</div>
            <div class="kpi-val" style="color: #1e40af;">₹ ${totPayroll.toLocaleString('en-IN')}</div>
          </div>
          <div class="kpi-cell" style="background: #fff1f2;">
            <div class="kpi-title">લીધેલ રોકડ ઉપાડ</div>
            <div class="kpi-val" style="color: #b91c1c;">₹ ${totUpad.toLocaleString('en-IN')}</div>
          </div>
          <div class="kpi-cell" style="background: #fdf4ff;">
            <div class="kpi-title">અગાઉની બાકી</div>
            <div class="kpi-val" style="color: #6b21a8;">${totOpening >= 0 ? '+₹ ' : '-₹ '}${Math.abs(totOpening).toLocaleString('en-IN')}</div>
          </div>
          <div class="kpi-cell" style="background: #ecfdf5;">
            <div class="kpi-title">બેંક ચૂકવવાપાત્ર બાકી</div>
            <div class="kpi-val" style="color: #047857;">₹ ${totPayable.toLocaleString('en-IN')}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th style="width: 30px; text-align: center;">#</th>
              <th>કર્મચારીનું નામ</th>
              <th style="width: 120px;">હોદ્દો / કામ</th>
              <th style="width: 100px; text-align: right;">માસિક પગાર</th>
              <th style="width: 100px; text-align: right;">રોકડ ઉપાડ</th>
              <th style="width: 90px; text-align: right;">અગાઉની બાકી</th>
              <th style="width: 120px; text-align: right;">ચૂકવવાપાત્ર બાકી</th>
              <th style="width: 100px; text-align: center;">ચુકવણી માધ્યમ</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td colspan="3" style="text-align: right; padding-right: 10px;">કુલ સરવાળો (Grand Total):</td>
              <td style="text-align: right; font-family: monospace, sans-serif;">₹ ${totPayroll.toLocaleString('en-IN')}</td>
              <td style="text-align: right; color: #b91c1c; font-family: monospace, sans-serif;">₹ ${totUpad.toLocaleString('en-IN')}</td>
              <td style="text-align: right; color: #4338ca; font-family: monospace, sans-serif;">${totOpening >= 0 ? '+₹ ' : '-₹ '}${Math.abs(totOpening).toLocaleString('en-IN')}</td>
              <td style="text-align: right; color: #047857; background: #d1fae5; font-size: 13px; font-family: monospace, sans-serif;">₹ ${totPayable.toLocaleString('en-IN')}</td>
              <td style="text-align: center; font-size: 10.5px; color: #475569;">બેંક ટ્રાન્સફર</td>
            </tr>
          </tfoot>
        </table>

        <div class="note-box">
          <strong>💡 હિસાબી નોંધ:</strong> રોકડ ઉપાડ રોજમેળમાં દૈનિક રોકડ સિલકમાંથી બાદ થઈ ગયેલ છે. ઉપરોક્ત ચૂકવવાપાત્ર ચોખ્ખી રકમ (₹ ${totPayable.toLocaleString('en-IN')}) સંસ્થા/ટ્રસ્ટ દ્વારા કર્મચારીઓના બેંક ખાતામાં જમા કરવાની રહેશે, જેથી દૈનિક રોકડ હિસાબમાં ફરીથી કોઈ ખર્ચ બાદ કરવાનો રહેતો નથી.
        </div>

        <div class="sign-row">
          <div class="sign-col">તૈયાર કરનાર<br><span style="font-size: 9px; font-weight: normal; color: #64748b;">(હિસાબનીશ / કમ્પ્યુટર ઓપરેટર)</span></div>
          <div class="sign-col">તપાસનાર<br><span style="font-size: 9px; font-weight: normal; color: #64748b;">(ઓડિટર / મેનેજર)</span></div>
          <div class="sign-col">મંજૂર કરનાર<br><span style="font-size: 9px; font-weight: normal; color: #64748b;">(ટ્રસ્ટી / પૂજ્ય કોઠારી સ્વામી)</span></div>
        </div>

        <script>
          window.addEventListener('load', () => {
            setTimeout(() => {
              window.print();
            }, 300);
          });
        </script>
      </body>
      </html>
    `;

    this.openPrintWindow(printHtml);
  },

  async shareEmployeeSalaryWhatsApp(targetMonth = null) {
    const m = targetMonth || this.salarySheetMonth || this.employeeMonthFilter || this.getDefaultSalaryMonth();
    let emps = this.salarySheetEmployees;

    if (!emps || emps.length === 0 || (this.salarySheetMonth && this.salarySheetMonth !== m)) {
      try {
        const res = await fetch(`/api/employees?month=${m}`);
        const data = await res.json();
        if (data && data.success) {
          emps = data.employees || [];
        }
      } catch (e) {
        console.error('Fetch error:', e);
      }
    }

    if (!emps || emps.length === 0) {
      this.showToast('કર્મચારીઓ મળ્યા નથી', 'info');
      return;
    }

    const monthLabel = this.getGujaratiMonthName(m);
    let totSalary = 0;
    let totUpad = 0;
    let totPayable = 0;

    let text = `📋 *કર્મચારી માસિક પગાર અને રોકડ ઉપાડ હિસાબ પત્રક*\n`;
    text += `📅 *માસ:* ${monthLabel}\n`;
    text += `🏛️ *સંસ્થા:* શ્રી ગાદીસ્થાન હિસાબ\n`;
    text += `━━━━━━━━━━━━━━━━━━━━\n`;

    emps.forEach((emp, idx) => {
      const sal = Number(emp.salary) || 0;
      const upd = Number(emp.currentMonthUpad) || 0;
      const pay = Number(emp.netBalance) || 0;

      totSalary += sal;
      totUpad += upd;
      totPayable += pay;

      const role = emp.role || emp.designation ? ` (${emp.role || emp.designation})` : '';
      text += `${idx + 1}. *${emp.name}*${role}\n`;
      text += `   • પગાર: ₹ ${sal.toLocaleString('en-IN')}\n`;
      text += `   • રોકડ ઉપાડ: ₹ ${upd.toLocaleString('en-IN')}\n`;
      text += `   • *ચૂકવવાપાત્ર બાકી: ₹ ${pay.toLocaleString('en-IN')}*\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📊 *કુલ સરવાળો:*\n`;
    text += `👥 કુલ કર્મચારીઓ: ${emps.length}\n`;
    text += `💼 કુલ માસિક પગાર: ₹ ${totSalary.toLocaleString('en-IN')}\n`;
    text += `🔻 કુલ રોકડ ઉપાડ: ₹ ${totUpad.toLocaleString('en-IN')}\n`;
    text += `🏦 *બેંક દ્વારા ચૂકવવાપાત્ર ચોખ્ખી રકમ: ₹ ${totPayable.toLocaleString('en-IN')}*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `_નોંધ: રોકડ ઉપાડ રોજમેળમાં રોકડ ખાતામાંથી બાદ થયેલ છે. બાકી રકમ બેંક ટ્રાન્સફર દ્વારા ચૂકવવાની રહેશે._\n`;

    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  },

  // =========================================================================
  // UCHAK / ADVANCE & SETTLEMENT CONTROLLER
  // =========================================================================

  async loadUchakRecords() {
    try {
      const res = await fetch('/api/uchak');
      if (res.ok) {
        const data = await res.json();
        this.uchakList = data.items || [];
        this.uchakSummary = data.summary || {
          totalCount: 0,
          pendingCount: 0,
          settledCount: 0,
          totalPendingAmount: 0,
          totalGivenAllTime: 0,
          totalVoucherAllTime: 0,
          totalCashReturnedAllTime: 0
        };
        this.updateUchakHeaderBadge();
        this.updateUchakFloatingBanner();
        this.updateQuickDrawerUI();
      }
    } catch (e) {
      console.error('Error loading uchak records:', e);
    }
  },

  async toggleQuickUchak(forceState = null) {
    const modal = document.getElementById('modal-quick-uchak');
    if (!modal) return;

    const isOpen = modal.classList.contains('active') || modal.style.display === 'flex';
    const shouldOpen = forceState !== null ? forceState : !isOpen;

    if (shouldOpen) {
      this.openModal('modal-quick-uchak', { isChild: true });

      if (window.i18n) {
        window.i18n.updateDOM();
      }

      // Populate default date & time (Clean 3-field fast form)
      const dateInp = document.getElementById('fast-uchak-date');
      const timeInp = document.getElementById('fast-uchak-time');
      const nameInp = document.getElementById('fast-uchak-name');
      const amtInp = document.getElementById('fast-uchak-amount');
      const empIdInp = document.getElementById('fast-uchak-emp-id');
      const wordsEl = document.getElementById('fast-uchak-amount-words');

      const todayStr = this.getTodayDateStr();
      if (dateInp) {
        dateInp.value = todayStr;
        dateInp.max = todayStr;
      }
      if (timeInp) timeInp.value = this.getCurrentTimeStr();
      if (nameInp) nameInp.value = '';
      if (amtInp) amtInp.value = '';
      if (empIdInp) empIdInp.value = '';
      if (wordsEl) wordsEl.textContent = '';

      this.renderUchakEmployeeHelpers();

      // Reliable auto-focus on employee name input
      const focusNameInput = () => {
        const inp = document.getElementById('fast-uchak-name');
        if (inp && modal.classList.contains('active')) {
          inp.focus();
          inp.select?.();
        }
      };
      focusNameInput();
      requestAnimationFrame(focusNameInput);
      setTimeout(focusNameInput, 80);
      setTimeout(focusNameInput, 180);

      if (window.GujaratiTyping) {
        window.GujaratiTyping.init();
      }
    } else {
      this.closeModal('modal-quick-uchak');
    }
  },

  onFastUchakAmountInput(val) {
    const wordsEl = document.getElementById('fast-uchak-amount-words');
    if (!wordsEl) return;
    const n = Number(val);
    if (!isNaN(n) && n > 0 && window.numberToWords) {
      const words = window.numberToWords.toGujarati(n);
      wordsEl.textContent = `✍️ ${words}`;
    } else {
      wordsEl.textContent = '';
    }
  },

  async onFastUchakDateChange(newDate) {
    if (!newDate) return;
    // Date changed freely without artificial blocking
  },

  renderUchakEmployeeHelpers() {
    const list = this.employeesList || [];
    const activeEmployees = list.filter(e => e.status !== 'inactive');

    // Count how many times each employee has taken uchak in the past
    const uchakCounts = {};
    (this.uchakList || []).forEach(u => {
      const key = u.employeeId || (u.personName || '').trim().toLowerCase();
      if (key) uchakCounts[key] = (uchakCounts[key] || 0) + 1;
    });

    // Sort: frequent uchak takers first, then by name
    const sortedEmployees = activeEmployees.slice().sort((a, b) => {
      const countA = uchakCounts[a.id] || uchakCounts[a.name.trim().toLowerCase()] || 0;
      const countB = uchakCounts[b.id] || uchakCounts[b.name.trim().toLowerCase()] || 0;
      if (countB !== countA) return countB - countA;
      return a.name.localeCompare(b.name, 'gu');
    });

    // If some employees have history, only show those who regularly/frequently take uchak
    const hasHistory = Object.values(uchakCounts).some(c => c > 0);
    const frequentStaff = hasHistory
      ? sortedEmployees.filter(e => (uchakCounts[e.id] || uchakCounts[e.name.trim().toLowerCase()] || 0) > 0)
      : sortedEmployees;
    const displayList = frequentStaff.length > 0 ? frequentStaff : sortedEmployees;

    // 1. Datalist for autocomplete suggestions (pure clean staff names)
    let datalist = document.getElementById('uchak-employees-datalist');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'uchak-employees-datalist';
      document.body.appendChild(datalist);
    }
    datalist.innerHTML = displayList.map(e => `<option value="${e.name}">`).join('');
  },

  pickUchakEmployee(mode, empId) {
    const emp = (this.employeesList || []).find(e => e.id === empId);
    if (!emp) return;

    if (mode === 'fast') {
      const nameInp = document.getElementById('fast-uchak-name');
      const idInp = document.getElementById('fast-uchak-emp-id');
      const sel = document.getElementById('fast-uchak-emp-select');
      const amtInp = document.getElementById('fast-uchak-amount');

      if (nameInp) nameInp.value = emp.name;
      if (idInp) idInp.value = emp.id;
      if (sel) sel.value = emp.id;

      // Highlight active chip
      const chips = document.querySelectorAll('#fast-uchak-emp-chips .btn-uchak-emp-chip');
      chips.forEach(c => {
        if (c.getAttribute('data-empid') === empId) c.classList.add('active');
        else c.classList.remove('active');
      });

      if (amtInp) {
        amtInp.focus();
        amtInp.select();
      }
    } else if (mode === 'modal') {
      const nameInp = document.getElementById('uchak-input-name');
      const phoneInp = document.getElementById('uchak-input-phone');
      const idInp = document.getElementById('uchak-modal-emp-id');
      const sel = document.getElementById('uchak-modal-emp-select');
      const amtInp = document.getElementById('uchak-input-amount');

      if (nameInp) nameInp.value = emp.name;
      if (phoneInp && emp.phone) phoneInp.value = emp.phone;
      if (idInp) idInp.value = emp.id;
      if (sel) sel.value = emp.id;

      // Highlight active chip
      const chips = document.querySelectorAll('#uchak-modal-emp-chips .btn-uchak-emp-chip');
      chips.forEach(c => {
        if (c.getAttribute('data-empid') === empId) c.classList.add('active');
        else c.classList.remove('active');
      });

      if (amtInp) {
        amtInp.focus();
        amtInp.select();
      }
    }
  },

  onUchakEmpSelectChange(mode, empId) {
    if (empId) {
      this.pickUchakEmployee(mode, empId);
    } else {
      if (mode === 'fast') {
        const idInp = document.getElementById('fast-uchak-emp-id');
        if (idInp) idInp.value = '';
        const chips = document.querySelectorAll('#fast-uchak-emp-chips .btn-uchak-emp-chip');
        chips.forEach(c => c.classList.remove('active'));
      } else if (mode === 'modal') {
        const idInp = document.getElementById('uchak-modal-emp-id');
        if (idInp) idInp.value = '';
        const chips = document.querySelectorAll('#uchak-modal-emp-chips .btn-uchak-emp-chip');
        chips.forEach(c => c.classList.remove('active'));
      }
    }
  },

  onUchakNameInput(mode, val) {
    const trimmed = (val || '').trim().toLowerCase();
    const matched = (this.employeesList || []).find(e =>
      e.name.toLowerCase() === trimmed ||
      e.name.toLowerCase().startsWith(trimmed) ||
      (trimmed.length >= 3 && e.name.toLowerCase().includes(trimmed))
    );

    if (mode === 'fast') {
      const idInp = document.getElementById('fast-uchak-emp-id');
      const sel = document.getElementById('fast-uchak-emp-select');
      if (idInp) idInp.value = matched ? matched.id : '';
      if (sel) sel.value = matched ? matched.id : '';

      const chips = document.querySelectorAll('#fast-uchak-emp-chips .btn-uchak-emp-chip');
      chips.forEach(c => {
        if (matched && c.getAttribute('data-empid') === matched.id) c.classList.add('active');
        else c.classList.remove('active');
      });
    } else if (mode === 'modal') {
      const idInp = document.getElementById('uchak-modal-emp-id');
      const sel = document.getElementById('uchak-modal-emp-select');
      const phoneInp = document.getElementById('uchak-input-phone');

      if (idInp) idInp.value = matched ? matched.id : '';
      if (sel) sel.value = matched ? matched.id : '';
      if (matched && phoneInp && !phoneInp.value) {
        phoneInp.value = matched.phone || '';
      }

      const chips = document.querySelectorAll('#uchak-modal-emp-chips .btn-uchak-emp-chip');
      chips.forEach(c => {
        if (matched && c.getAttribute('data-empid') === matched.id) c.classList.add('active');
        else c.classList.remove('active');
      });
    }
  },

  updateQuickDrawerUI() {
    const s = this.uchakSummary || {};
    const sumAmt = document.getElementById('quick-sum-pending-amt');
    const sumCnt = document.getElementById('quick-sum-pending-cnt');
    const floatBadge = document.getElementById('floating-uchak-badge');
    const qCntPending = document.getElementById('q-cnt-pending');

    const pAmt = s.totalPendingAmount || 0;
    const pCnt = s.pendingCount || 0;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    if (sumAmt) sumAmt.textContent = `₹ ${pAmt.toLocaleString('en-IN')}`;
    if (sumCnt) sumCnt.textContent = isEn ? `${pCnt} Pending` : `${pCnt} બાકી`;
    if (qCntPending) qCntPending.textContent = pCnt;

    if (floatBadge) {
      if (pCnt > 0) {
        floatBadge.textContent = pCnt;
        floatBadge.style.display = 'inline-block';
      } else {
        floatBadge.style.display = 'none';
      }
    }
  },

  async submitFastUchak(e) {
    e.preventDefault();
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const date = document.getElementById('fast-uchak-date').value;
    const time = document.getElementById('fast-uchak-time').value;
    const name = document.getElementById('fast-uchak-name').value.trim();
    const amt = Number(document.getElementById('fast-uchak-amount').value);
    const empId = document.getElementById('fast-uchak-emp-id')?.value || null;

    if (!name) {
      this.showToast(isEn ? 'Please enter person name' : 'કૃપા કરીને વ્યક્તિનું નામ લખો', 'error');
      return;
    }
    if (isNaN(amt) || amt <= 0) {
      this.showToast(isEn ? 'Please enter valid amount' : 'કૃપા કરીને સાચી રકમ લખો', 'error');
      return;
    }

    const today = this.getTodayDateStr();
    if (date < today) {
      const authorized = await this.ensureAdminAuth(isEn ? `Date ${date} is locked! Enter Admin PIN to give advance on past date:` : `તારીખ ${date} નો હિસાબ લૉક છે! પાછલી તારીખમાં ઉચક આપવા માટે એડમિન પિન જરૂરી છે.`);
      if (!authorized) {
        const dEl = document.getElementById('fast-uchak-date');
        if (dEl) dEl.value = today;
        return;
      }
    }

    try {
      const res = await fetch('/api/uchak', {
        method: 'POST',
        headers: this.getAdminHeaders ? this.getAdminHeaders() : { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          givenDate: date || new Date().toISOString().split('T')[0],
          givenTime: time || this.getCurrentTimeStr(),
          personName: name,
          givenAmount: amt,
          purpose: isEn ? 'Advance Cash Given' : 'ઉચક આપેલ રકમ',
          employeeId: empId
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast(isEn ? `✅ Recorded ₹${amt.toLocaleString('en-IN')} advance for ${name}!` : `✅ ${name} ને ₹${amt.toLocaleString('en-IN')} ઉચક નોંધાઈ ગયા!`, 'success');
        this.toggleQuickUchak(false);

        await this.loadUchakRecords();
        this.renderUchakKPIs();
        this.renderUchakList();
        this.renderActiveUchakBanner();
        this.notifyDataChanged('uchak_recorded', date);
      } else {
        this.showToast(data.error || (isEn ? 'Error recording advance' : 'ઉચક નોંધવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error in fast uchak:', err);
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  async quickSettleAllCash(id) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const item = (this.uchakList || []).find(x => x.id === id);
    if (!item) return;

    const remaining = item.status === 'settled' ? 0 : (item.remainingAmount !== undefined ? Number(item.remainingAmount) : (Number(item.givenAmount) || 0));

    try {
      const res = await fetch(`/api/uchak/${id}/settle`, {
        method: 'POST',
        headers: this.getAdminHeaders ? this.getAdminHeaders() : { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settledDate: this.getTodayDateStr(),
          settleType: 'all_cash_returned',
          voucherAmount: 0,
          cashReturned: remaining,
          notes: isEn ? 'All cash returned to drawer' : 'બધા રોકડા ગલ્લામાં પરત જમા થયા',
          isFinalSettlement: true
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast(isEn ? `✅ ₹${remaining.toLocaleString('en-IN')} cash returned for ${item.personName}! (Settled)` : `✅ ${item.personName} ના બાકી ₹${remaining.toLocaleString('en-IN')} રોકડા જમા થઈ ગયા! (પતી ગયેલ)`, 'success');
        await this.loadDate(this.currentDate);
        await this.loadUchakRecords();
        this.renderQuickUchakList();
        this.renderUchakKPIs();
        this.renderUchakList();
        this.updateQuickDrawerUI();
        this.notifyDataChanged('uchak_settled', this.currentDate);
      } else {
        this.showToast(data.error || (isEn ? 'Error in settlement' : 'પતાવટમાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error quick cash return:', err);
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  renderQuickUchakList() {
    this.updateQuickDrawerUI();
    const container = document.getElementById('quick-uchak-items-list');
    if (!container) return;

    // In speed drawer, only show active pending or partial items!
    const items = (this.uchakList || []).filter(x => x.status === 'pending' || x.status === 'partial');

    const qCntPending = document.getElementById('q-cnt-pending');
    if (qCntPending) qCntPending.textContent = items.length;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    if (items.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 32px 14px; color: #64748b; background: #fffcf5; border: 1.5px dashed #fed7aa; border-radius: 10px;">
          <div style="font-size: 2rem; margin-bottom: 6px;">🎉</div>
          <div style="font-weight: 800; font-size: 0.95rem; color: #92400e;">${isEn ? 'No active advance cash pending!' : 'હાલ કોઈ ઉચક રકમ બાકી નથી!'}</div>
          <div style="font-size: 0.78rem; color: #b45309; margin-top: 4px;">${isEn ? 'All advances are settled. To issue new advance, fill form above.' : 'બધા હિસાબો સરભર થઈ ગયા છે. નવા ઉચક આપવા ઉપર વિગત ભરો.'}</div>
        </div>
      `;
      return;
    }

    container.innerHTML = items.map(item => {
      const isPartial = item.status === 'partial';
      const given = Number(item.givenAmount) || 0;
      const remaining = item.remainingAmount !== undefined ? Number(item.remainingAmount) : given;

      // Match employee by ID or Name
      const matchedEmp = (this.employeesList || []).find(e =>
        (item.employeeId && e.id === item.employeeId) ||
        (e.name && item.personName && (
          e.name.toLowerCase() === item.personName.toLowerCase() ||
          e.name.toLowerCase().includes(item.personName.toLowerCase()) ||
          item.personName.toLowerCase().includes(e.name.toLowerCase())
        ))
      );
      const isEmployee = Boolean(item.employeeId || matchedEmp);

      // Calculate days elapsed since item.givenDate for badge
      let dayTagHtml = '';
      if (item.givenDate) {
        try {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const [gy, gm, gd] = item.givenDate.split('-').map(Number);
          const gDate = new Date(gy, gm - 1, gd);
          gDate.setHours(0, 0, 0, 0);
          const diffDays = Math.round((today - gDate) / (1000 * 60 * 60 * 24));
          if (diffDays <= 0) {
            dayTagHtml = `<span class="uchak-day-tag today">🟢 ${isEn ? 'Today' : 'આજે'}</span>`;
          } else if (diffDays === 1) {
            dayTagHtml = `<span class="uchak-day-tag recent">🟡 ${isEn ? 'Yesterday' : 'ગઈકાલે'}</span>`;
          } else {
            dayTagHtml = `<span class="uchak-day-tag ${diffDays >= 3 ? 'overdue' : 'recent'}">${diffDays >= 3 ? '⚠️ ' : ''}${diffDays} ${isEn ? 'days ago' : 'દિવસ જૂનું'}</span>`;
          }
        } catch (e) { }
      }

      // Mini progress bar if partial
      let miniProgressHtml = '';
      if (isPartial && given > 0) {
        const settledAmount = Math.max(0, given - remaining);
        const percent = Math.min(100, Math.max(0, Math.round((settledAmount / given) * 100)));
        miniProgressHtml = `
          <div class="uchak-mini-progress-wrap" title="${isEn ? 'Settled:' : 'પતાવટ થયેલ:'} ₹${settledAmount.toLocaleString('en-IN')} / ₹${given.toLocaleString('en-IN')} (${percent}%)">
            <div class="uchak-mini-progress-bar" style="width: ${percent}%;"></div>
          </div>
        `;
      }

      return `
        <div class="quick-card ${isPartial ? 'is-partial' : 'is-pending'}" id="quick-card-${item.id}">
          <div class="quick-card-row-1">
            <span class="quick-card-name">
              👤 ${item.personName}
              ${isEmployee ? `<span class="uchak-emp-badge">👔 ${isEn ? 'Staff' : 'સ્ટાફ'}</span>` : ''}
              ${isPartial ? `<span style="background: #fff7ed; color: #ea580c; border: 1px solid #fed7aa; padding: 1px 6px; border-radius: 4px; font-size: 0.72rem; font-weight: 800;">${isEn ? 'Partial' : 'અંશતઃ'}</span>` : ''}
            </span>
            <span class="quick-card-amt" style="color: ${isPartial ? '#ea580c' : '#b45309'};">₹ ${remaining.toLocaleString('en-IN')}</span>
          </div>
          <div class="quick-card-row-2">
            <span>📅 ${item.givenDate}</span> ${dayTagHtml} &bull; <span>⏰ ${item.givenTime || ''}</span>
            ${isPartial ? ` &bull; <span style="color:#ea580c; font-weight:700;">(${isEn ? 'Orig' : 'મૂળ'}: ₹${given.toLocaleString('en-IN')})</span>` : ''}
            ${item.purpose && item.purpose !== 'ઉચક ખર્ચ' && item.purpose !== 'ઉચક આપેલ રકમ' && item.purpose !== 'Advance Cash Given' ? ` &bull; <span style="color:#0284c7;">(${item.purpose})</span>` : ''}
          </div>
          ${miniProgressHtml}

          <div class="quick-card-actions">
            <button type="button" class="btn-q-cash-back" onclick="App.quickSettleAllCash('${item.id}')" title="${isEn ? 'Return Cash' : 'બાકી પૈસા રોકડા પાછા આવ્યા'}">
              💵 ${isPartial ? (isEn ? 'Return Cash' : 'બાકી રોકડા પરત') : (isEn ? 'Full Cash Return' : 'પૂરા રોકડા પરત')}
            </button>
            <button type="button" class="btn-q-voucher-give" onclick="App.openSettleModal('${item.id}')" title="${isEn ? 'Submit Voucher / Bill' : 'વાઉચર / બિલ આપ્યું'}">
              🧾 ${isEn ? 'Voucher Bill' : 'વાઉચર આપ્યું'}
            </button>
            <button type="button" class="btn-q-del" onclick="App.deleteUchak('${item.id}')" title="${isEn ? 'Delete' : 'કાઢી નાખો'}">
              🗑️
            </button>
          </div>
        </div>
      `;
    }).join('');
    if (window.GujaratiTyping) {
      window.GujaratiTyping.init();
    }
  },

  updateUchakHeaderBadge() {
    const badge = document.getElementById('header-uchak-badge');
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const pCount = (this.uchakSummary && this.uchakSummary.pendingCount) || 0;
    if (badge) {
      if (pCount > 0) {
        badge.textContent = isEn ? `${pCount} Pending` : `${pCount} બાકી`;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
  },

  updateUchakFloatingBanner() {
    const banner = document.getElementById('banner-active-uchak');
    const floatBtn = document.getElementById('floating-uchak-toggle');
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const pCount = (this.uchakSummary && this.uchakSummary.pendingCount) || 0;
    const pAmt = (this.uchakSummary && this.uchakSummary.totalPendingAmount) || 0;

    // Corner floating button is ALWAYS visible so users can always access it
    if (floatBtn) {
      floatBtn.style.display = 'flex';
      const floatBadge = document.getElementById('floating-uchak-badge');
      if (floatBadge) {
        if (pCount > 0) {
          floatBadge.textContent = pCount;
          floatBadge.style.display = 'inline-block';
        } else {
          floatBadge.style.display = 'none';
        }
      }
    }

    if (banner) {
      if (pCount > 0 && pAmt > 0) {
        banner.style.display = 'flex';
        const amtEl = document.getElementById('banner-uchak-amount');
        const countEl = document.getElementById('banner-uchak-count');
        if (amtEl) amtEl.textContent = `₹ ${pAmt.toLocaleString('en-IN')}`;
        if (countEl) countEl.textContent = isEn ? `(${pCount} persons pending)` : `(${pCount} વ્યક્તિ પાસે બાકી)`;
      } else {
        banner.style.display = 'none';
      }
    }
  },

  async openUchakModal() {
    if (window.i18n) window.i18n.updateDOM();
    await this.loadUchakRecords();
    this.renderUchakKPIs();
    this.renderUchakList();
    this.openModal('modal-uchak');

    if (window.GujaratiTyping) {
      window.GujaratiTyping.init();
    }
  },

  openNewUchakModal() {
    this.closeModal('modal-uchak');
    this.toggleQuickUchak(true);
  },

  switchUchakTab(tab) {
    if (tab === 'new') {
      this.closeModal('modal-uchak');
      this.toggleQuickUchak(true);
    } else {
      this.renderUchakList();
    }
  },

  renderUchakKPIs() {
    const s = this.uchakSummary || {};
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const pAmtEl = document.getElementById('uchak-kpi-pending-amt');
    const pCountEl = document.getElementById('uchak-kpi-pending-count');
    const cRetEl = document.getElementById('uchak-kpi-cash-returned');
    const vAmtEl = document.getElementById('uchak-kpi-voucher-amt');

    if (pAmtEl) pAmtEl.textContent = `₹ ${(s.totalPendingAmount || 0).toLocaleString('en-IN')}`;
    if (pCountEl) pCountEl.textContent = isEn ? `${s.pendingCount || 0} persons pending` : `${s.pendingCount || 0} વ્યક્તિ પાસે બાકી`;
    if (cRetEl) cRetEl.textContent = `₹ ${(s.totalCashReturnedAllTime || 0).toLocaleString('en-IN')}`;
    if (vAmtEl) vAmtEl.textContent = `₹ ${(s.totalVoucherAllTime || 0).toLocaleString('en-IN')}`;
  },

  setUchakFilter(filter) {
    this.uchakFilter = filter;
    ['all', 'pending', 'partial', 'settled'].forEach(f => {
      const pill = document.getElementById(`pill-uchak-${f}`);
      if (pill) {
        if (f === filter) pill.classList.add('active');
        else pill.classList.remove('active');
      }
    });
    this.renderUchakList();
  },

  onUchakSearch(term) {
    this.uchakSearch = (term || '').trim().toLowerCase();
    this.renderUchakList();
  },

  onUchakAmountInput(val) {
    const wordsEl = document.getElementById('uchak-amount-words');
    if (!wordsEl) return;
    const n = Number(val);
    if (!isNaN(n) && n > 0 && window.numberToWords) {
      const words = window.numberToWords.toGujarati(n);
      wordsEl.textContent = `✍️ ${words}`;
    } else {
      wordsEl.textContent = '';
    }
  },

  async submitNewUchak(e) {
    e.preventDefault();
    const date = document.getElementById('uchak-input-date').value;
    const time = document.getElementById('uchak-input-time').value;
    const personName = document.getElementById('uchak-input-name').value;
    const phone = document.getElementById('uchak-input-phone').value;
    const givenAmount = document.getElementById('uchak-input-amount').value;
    const purpose = document.getElementById('uchak-input-purpose').value;
    const remarks = document.getElementById('uchak-input-remarks').value;
    const employeeId = document.getElementById('uchak-modal-emp-id')?.value || null;

    const amt = Number(givenAmount);
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    if (isNaN(amt) || amt <= 0) {
      this.showToast(isEn ? 'Please enter valid amount' : 'કૃપા કરીને સાચી રકમ લખો', 'error');
      return;
    }

    try {
      const res = await fetch('/api/uchak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          givenDate: date,
          givenTime: time,
          personName,
          phone,
          givenAmount: amt,
          purpose,
          remarks,
          employeeId
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast(isEn ? `✅ Recorded ₹${amt.toLocaleString('en-IN')} advance for ${personName}!` : `✅ ${personName} ને ₹${amt.toLocaleString('en-IN')} ઉચક નોંધાઈ ગયા!`, 'success');
        const modalEmpId = document.getElementById('uchak-modal-emp-id');
        if (modalEmpId) modalEmpId.value = '';
        const modalSelect = document.getElementById('uchak-modal-emp-select');
        if (modalSelect) modalSelect.value = '';
        const modalChips = document.querySelectorAll('#uchak-modal-emp-chips .btn-uchak-emp-chip');
        modalChips.forEach(c => c.classList.remove('active'));

        await this.loadUchakRecords();
        this.renderUchakKPIs();
        this.switchUchakTab('list');
      } else {
        this.showToast(data.error || (isEn ? 'Error recording advance' : 'ઉચક નોંધવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error saving uchak:', err);
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  renderUchakList() {
    const container = document.getElementById('uchak-items-container');
    if (!container) return;

    let items = (this.uchakList || []).slice();

    // Filter by status
    if (this.uchakFilter === 'pending') {
      items = items.filter(x => x.status === 'pending');
    } else if (this.uchakFilter === 'partial') {
      items = items.filter(x => x.status === 'partial');
    } else if (this.uchakFilter === 'settled') {
      items = items.filter(x => x.status === 'settled');
    }

    // Filter by search
    if (this.uchakSearch) {
      items = items.filter(x => {
        const text = `${x.personName} ${x.purpose} ${x.phone || ''} ${x.remarks || ''}`.toLowerCase();
        return text.includes(this.uchakSearch);
      });
    }

    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    if (items.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: #64748b; background: #f8fafc; border: 1.5px dashed #cbd5e1; border-radius: var(--radius-md);">
          <div style="font-size: 2.5rem; margin-bottom: 8px;">💼</div>
          <div style="font-size: 1.05rem; font-weight: 700; color: #334155;">${isEn ? 'No advance cash records found' : 'કોઈ ઉચક નોંધ મળી નથી'}</div>
          <div style="font-size: 0.85rem; margin-top: 4px;">${isEn ? 'To issue new advance cash, click "+ Give Advance Cash" above.' : 'નવા ઉચક પૈસા આપવા માટે ઉપરના "➕ નવા ઉચક પૈસા આપો" બટન પર ક્લિક કરો.'}</div>
        </div>
      `;
      return;
    }

    container.innerHTML = items.map(item => {
      const isSettled = item.status === 'settled';
      const isPartial = item.status === 'partial';
      const isPending = !isSettled && !isPartial;
      const given = Number(item.givenAmount) || 0;
      const remaining = isSettled ? 0 : (item.remainingAmount !== undefined ? Number(item.remainingAmount) : given);
      const givenAmt = given.toLocaleString('en-IN');
      const remainingAmt = remaining.toLocaleString('en-IN');
      const st = item.settlement || {};

      // Match employee by ID or Name
      const matchedEmp = (this.employeesList || []).find(e =>
        (item.employeeId && e.id === item.employeeId) ||
        (e.name && item.personName && (
          e.name.toLowerCase() === item.personName.toLowerCase() ||
          e.name.toLowerCase().includes(item.personName.toLowerCase()) ||
          item.personName.toLowerCase().includes(e.name.toLowerCase())
        ))
      );
      const isEmployee = Boolean(item.employeeId || matchedEmp);

      // Calculate days elapsed for Ageing badge
      let dayTagHtml = '';
      if (item.givenDate && !isSettled) {
        try {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const [gy, gm, gd] = item.givenDate.split('-').map(Number);
          const gDate = new Date(gy, gm - 1, gd);
          gDate.setHours(0, 0, 0, 0);
          const diffDays = Math.round((today - gDate) / (1000 * 60 * 60 * 24));
          if (diffDays <= 0) {
            dayTagHtml = `<span class="uchak-day-tag today">🟢 ${isEn ? 'Given Today' : 'આજે આપેલ'}</span>`;
          } else if (diffDays === 1) {
            dayTagHtml = `<span class="uchak-day-tag recent">🟡 ${isEn ? 'Given Yesterday' : 'ગઈકાલે આપેલ'}</span>`;
          } else {
            dayTagHtml = `<span class="uchak-day-tag ${diffDays >= 3 ? 'overdue' : 'recent'}">${diffDays >= 3 ? '⚠️ ' : ''}${diffDays} ${isEn ? 'days ago' : 'દિવસ જૂનું'}</span>`;
          }
        } catch (e) { }
      }

      // Mini progress bar for partial settlement
      let miniProgressHtml = '';
      if (isPartial && given > 0) {
        const settledAmount = Math.max(0, given - remaining);
        const percent = Math.min(100, Math.max(0, Math.round((settledAmount / given) * 100)));
        miniProgressHtml = `
          <div style="margin-top: 10px; background: #fff7ed; padding: 8px 12px; border-radius: 8px; border: 1px solid #fed7aa;">
            <div style="display: flex; justify-content: space-between; font-size: 0.78rem; font-weight: 800; color: #c2410c; margin-bottom: 4px;">
              <span>${isEn ? 'Settlement Progress:' : 'પતાવટ પ્રગતિ:'}</span>
              <span>${percent}% (${isEn ? 'Settled:' : 'ચૂકવાયા:'} ₹ ${settledAmount.toLocaleString('en-IN')} / ${isEn ? 'Orig:' : 'મૂળ:'} ₹ ${givenAmt})</span>
            </div>
            <div class="uchak-mini-progress-wrap" style="margin-top: 0;" title="${isEn ? 'Settled:' : 'પતાવટ થયેલ:'} ₹${settledAmount.toLocaleString('en-IN')} / ₹${givenAmt} (${percent}%)">
              <div class="uchak-mini-progress-bar" style="width: ${percent}%;"></div>
            </div>
          </div>
        `;
      }

      let settlementHtml = '';
      if (Array.isArray(item.installments) && item.installments.length > 0) {
        const totalVouchersSubmitted = item.installments.reduce((s, inst) => s + (Number(inst.voucherAmount) || 0), 0);
        const totalCashBack = item.installments.reduce((s, inst) => s + (Number(inst.cashReturned) || 0), 0);
        const lastInst = item.installments[item.installments.length - 1];

        settlementHtml = `
          <div class="uchak-settlement-breakdown" style="${isPartial ? 'background: #fff7ed; border-color: #fed7aa;' : ''}">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap;">
              <div style="font-weight: 800; font-size: 0.86rem; color: ${isPartial ? '#c2410c' : '#065f46'};">
                ${isPartial ? (isEn ? `🟠 Partial Settlement (${item.installments.length} installments paid)` : `🟠 અંશતઃ પતાવટ થયેલ (${item.installments.length} હપ્તા જમા)`) : (isEn ? `✅ Fully Settled Date: ${lastInst.settledDate || '-'}` : `✅ સંપૂર્ણ પતાવટ તારીખ: ${lastInst.settledDate || '-'}`)}
              </div>
              ${isPartial ? `<span style="font-size: 0.76rem; font-weight: 800; background: #fed7aa; color: #9a3412; padding: 2px 6px; border-radius: 4px;">${isEn ? `Pending ₹ ${remainingAmt} to collect` : `હજી ₹ ${remainingAmt} લેવાના બાકી`}</span>` : `<span style="font-size: 0.76rem; font-weight: 800; background: #bbf7d0; color: #065f46; padding: 2px 6px; border-radius: 4px;">${isEn ? 'Added to Daily Accounts' : 'દૈનિક હિસાબમાં ચડેલ છે'}</span>`}
            </div>
            <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
              ${totalVouchersSubmitted > 0 ? `
                <div style="background: #dbeafe; color: #1e40af; padding: 3px 8px; border-radius: 4px; font-weight: 800;">
                  🧾 ${isEn ? 'Vouchers Submitted:' : 'જમા થયેલ વાઉચરો:'} ₹ ${totalVouchersSubmitted.toLocaleString('en-IN')}
                </div>
              ` : ''}
              ${totalCashBack > 0 ? `
                <div style="background: #d1fae5; color: #065f46; padding: 3px 8px; border-radius: 4px; font-weight: 800;">
                  💵 ${isEn ? 'Cash Returned:' : 'રોકડા પરત:'} ₹ ${totalCashBack.toLocaleString('en-IN')}
                </div>
              ` : ''}
            </div>
            ${lastInst.voucherTitle ? `<div style="font-size: 0.82rem; color: #475569; margin-top: 4px;"><strong>${isEn ? 'Last Bill:' : 'છેલ્લું બિલ:'}</strong> ${lastInst.voucherTitle} (₹${(Number(lastInst.voucherAmount) || 0).toLocaleString('en-IN')})</div>` : ''}
          </div>
        `;
      } else if (!isPending && item.settlement) {
        const vAmt = Number(st.voucherAmount) || 0;
        const cRet = Number(st.cashReturned) || 0;
        const extra = Number(st.extraPaid) || 0;

        let breakdownBadges = '';
        if (vAmt === 0 && cRet > 0) {
          breakdownBadges = `
            <div style="font-weight: 800; color: #047857; display: flex; align-items: center; gap: 6px;">
              <span>💵</span> <span>${isEn ? 'All Cash Returned:' : 'બધા રોકડા પાછા આવ્યા:'} <strong>₹ ${cRet.toLocaleString('en-IN')}</strong> (${isEn ? 'in cash drawer' : 'ગલ્લામાં જમા'})</span>
            </div>
          `;
        } else {
          breakdownBadges = `
            <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
              <div style="background: #dbeafe; color: #1e40af; padding: 3px 8px; border-radius: 4px; font-weight: 800;">
                🧾 ${isEn ? 'Voucher Amount:' : 'વાઉચર રકમ:'} ₹ ${vAmt.toLocaleString('en-IN')} (${st.voucherCategory || (isEn ? 'Voucher' : 'વાઉચર')})
              </div>
              ${cRet > 0 ? `
                <div style="background: #d1fae5; color: #065f46; padding: 3px 8px; border-radius: 4px; font-weight: 800;">
                  💵 ${isEn ? 'Cash Returned:' : 'રોકડા પરત:'} ₹ ${cRet.toLocaleString('en-IN')}
                </div>
              ` : ''}
              ${extra > 0 ? `
                <div style="background: #fee2e2; color: #991b1b; padding: 3px 8px; border-radius: 4px; font-weight: 800;">
                  🔴 ${isEn ? 'Extra Paid:' : 'વધારાના ચૂકવ્યા:'} ₹ ${extra.toLocaleString('en-IN')}
                </div>
              ` : ''}
            </div>
            ${st.voucherTitle ? `<div style="font-size: 0.82rem; color: #475569; margin-top: 4px;"><strong>${isEn ? 'Bill Detail:' : 'બિલ વિગત:'}</strong> ${st.voucherTitle}</div>` : ''}
          `;
        }

        settlementHtml = `
          <div class="uchak-settlement-breakdown">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap;">
              <div style="font-weight: 800; font-size: 0.86rem; color: #065f46;">
                ✅ ${isEn ? 'Settled Date:' : 'હિસાબ પતાવટ તારીખ:'} ${st.settledDate || '-'} ${st.settledTime ? `(${st.settledTime})` : ''}
              </div>
              ${st.addedToHisab ? `<span style="font-size: 0.76rem; font-weight: 800; background: #bbf7d0; color: #065f46; padding: 2px 6px; border-radius: 4px;">${isEn ? 'Voucher posted to daily accounts' : 'દૈનિક હિસાબમાં વાઉચર ચડેલ છે'}</span>` : ''}
            </div>
            ${breakdownBadges}
            ${st.notes ? `<div style="font-size: 0.8rem; color: #64748b; margin-top: 4px;"><em>${isEn ? 'Note:' : 'નોંધ:'} ${st.notes}</em></div>` : ''}
          </div>
        `;
      }

      let amountDisplayHtml = '';
      if (isPartial) {
        amountDisplayHtml = `
          <div class="uchak-card-amount" style="color: #ea580c;">₹ ${remainingAmt}</div>
          <div style="font-size: 0.75rem; color: #c2410c; font-weight: 800;">${isEn ? `Pending (Orig: ₹${givenAmt})` : `બાકી (મૂળ: ₹${givenAmt})`}</div>
        `;
      } else {
        amountDisplayHtml = `
          <div class="uchak-card-amount" style="color: ${isSettled ? '#059669' : '#b45309'};">₹ ${givenAmt}</div>
          <div style="font-size: 0.75rem; color: ${isSettled ? '#047857' : '#b45309'}; font-weight: 700;">${isSettled ? (isEn ? 'Settled' : 'મૂળ રકમ (પતી ગયેલ)') : (isEn ? 'Amount' : 'મૂળ રકમ')}</div>
        `;
      }

      const personInitial = (item.personName || 'P').trim().charAt(0);

      return `
        <div class="uchak-item-card ${isSettled ? 'is-settled' : (isPartial ? 'is-partial' : 'is-pending')}" id="card-uchak-${item.id}">
          <div class="uchak-card-top">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div class="uchak-person-avatar" style="${isSettled ? 'background: #dcfce7; color: #047857; border-color: #a7f3d0;' : (isPartial ? 'background: #ffedd5; color: #c2410c; border-color: #fed7aa;' : '')}">
                ${personInitial}
              </div>
              <div>
                <div class="uchak-card-person">
                  <span>${item.personName}</span>
                  ${isEmployee ? `<span class="uchak-emp-badge">👔 ${isEn ? 'Staff' : 'સ્ટાફ'}</span>` : ''}
                  ${item.phone ? `<span style="font-size: 0.8rem; font-weight: 600; color: #64748b;">(📱 ${item.phone})</span>` : ''}
                </div>
                <div class="uchak-card-meta">
                  <span>📅 <strong>${item.givenDate}</strong></span>
                  ${dayTagHtml}
                  <span>⏰ ${item.givenTime || ''}</span>
                </div>
              </div>
            </div>

            <div style="text-align: right;">
              ${amountDisplayHtml}
            </div>
          </div>

          <div class="uchak-card-purpose">
            <strong>🎯 ${isEn ? 'Detail:' : 'વિગત:'}</strong> ${item.purpose}
            ${item.remarks ? `<span style="display: block; font-size: 0.82rem; color: #64748b; font-weight: normal; margin-top: 2px;">${isEn ? 'Remark:' : 'નોંધ:'} ${item.remarks}</span>` : ''}
          </div>

          ${settlementHtml}
          ${miniProgressHtml}

          <div class="uchak-card-footer">
            <div>
              ${isSettled ? `
                <span class="uchak-status-badge settled">
                  <span>🟢</span> <span>${isEn ? 'Settled' : 'પતી ગયેલ'}</span>
                </span>
              ` : (isPartial ? `
                <span class="uchak-status-badge partial">
                  <span>🟠</span> <span>${isEn ? `Partial (Pending: ₹ ${remainingAmt})` : `અંશતઃ (બાકી: ₹ ${remainingAmt})`}</span>
                </span>
              ` : `
                <span class="uchak-status-badge pending">
                  <span>🟡</span> <span>${isEn ? 'Pending' : 'બાકી'}</span>
                </span>
              `)}
            </div>

            <div style="display: flex; gap: 8px; align-items: center;">
              ${!isSettled ? `
                <button type="button" class="btn-uchak-settle-trigger" onclick="App.openSettleModal('${item.id}')" title="${isEn ? 'Settle this advance' : 'આ ઉચક રકમનો હિસાબ પતાવો'}">
                  <span>⚖️</span> <span>${isPartial ? (isEn ? 'Settle Balance' : 'બાકી હિસાબ પતાવો') : (isEn ? 'Settle' : 'હિસાબ પતાવો')}</span>
                </button>
              ` : `
                <button type="button" class="btn-uchak-unsettle" onclick="App.unsettleUchak('${item.id}')" title="${isEn ? 'Reopen this settlement' : 'આ પતાવટ રદ કરી ફરી બાકી કરો'}">
                  <span>↩️</span> <span>${isEn ? 'Reopen' : 'ફરી ખોલો'}</span>
                </button>
              `}
              ${isPartial ? `
                <button type="button" class="btn-uchak-unsettle" onclick="App.unsettleUchak('${item.id}')" title="${isEn ? 'Undo last installment' : 'છેલ્લો હપ્તો રદ કરો'}" style="padding: 4px 8px; font-size: 0.8rem;">
                  <span>↩️</span> <span>${isEn ? 'Undo Last' : 'છેલ્લું રદ'}</span>
                </button>
              ` : ''}
              <button type="button" class="btn-icon" onclick="App.deleteUchak('${item.id}')" title="${isEn ? 'Delete this record' : 'આ ઉચક નોંધ કાઢી નાખો'}" style="color: #ef4444; padding: 5px 8px;">
                🗑️
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  },

  openSettleModal(uchakId) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const item = (this.uchakList || []).find(x => x.id === uchakId);
    if (!item) {
      this.showToast(isEn ? 'Advance record not found' : 'ઉચક નોંધ મળી નથી', 'error');
      return;
    }

    this.activeUchakForSettle = item;
    const given = Number(item.givenAmount) || 0;
    const remaining = item.status === 'settled' ? 0 : (item.remainingAmount !== undefined ? Number(item.remainingAmount) : given);

    // Populate Category Dropdown from fixedVouchers
    const catSelect = document.getElementById('settle-voucher-category');
    if (catSelect) {
      catSelect.innerHTML = '';
      (this.fixedVouchers || []).forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = `🧾 ${this.getKhataNameInGujarati(v)} (${v})`;
        catSelect.appendChild(opt);
      });
      // Default to RASODAKHARCH or MANDIRKHARCH if available
      for (let opt of catSelect.options) {
        if (opt.value.toUpperCase().includes('RASODA') || opt.value.toUpperCase().includes('MANDIR')) {
          catSelect.value = opt.value;
          break;
        }
      }
    }

    // Populate employees dropdown
    const empSelect = document.getElementById('settle-select-employee');
    if (empSelect) {
      empSelect.innerHTML = `<option value="">-- ${isEn ? 'Select Staff' : 'કર્મચારી પસંદ કરો'} --</option>`;
      (this.employeesList || []).forEach(emp => {
        const opt = document.createElement('option');
        opt.value = emp.id;
        opt.textContent = `👤 ${emp.name} (${emp.role}) - ${isEn ? 'Salary:' : 'નક્કી પગાર:'} ₹${(emp.salary || 0).toLocaleString('en-IN')}`;
        empSelect.appendChild(opt);
      });
    }

    // Default month
    const mInput = document.getElementById('settle-select-month');
    if (mInput) {
      mInput.value = this.currentDate ? this.currentDate.slice(0, 7) : new Date().toISOString().slice(0, 7);
    }

    // Set Hidden ID and header labels
    document.getElementById('settle-uchak-id').value = item.id;
    document.getElementById('settle-disp-name').textContent = `👤 ${item.personName}`;
    document.getElementById('settle-disp-amount').textContent = `₹ ${given.toLocaleString('en-IN')}`;
    const remEl = document.getElementById('settle-disp-remaining');
    if (remEl) remEl.textContent = `₹ ${remaining.toLocaleString('en-IN')}`;
    document.getElementById('settle-disp-purpose').textContent = isEn ? `Purpose: ${item.purpose}` : `શેના માટે આપ્યા હતા: ${item.purpose}`;
    document.getElementById('settle-disp-date').textContent = isEn ? `Given Date: ${item.givenDate} (${item.givenTime || ''})` : `આપ્યા તારીખ: ${item.givenDate} (${item.givenTime || ''})`;
    const allCashAmt = document.getElementById('settle-allcash-amt');
    if (allCashAmt) allCashAmt.textContent = `₹ ${remaining.toLocaleString('en-IN')}`;

    // Default settlement date (always real today)
    document.getElementById('settle-input-date').value = this.getTodayDateStr();

    // Reset inputs: default to remaining amount
    document.getElementById('settle-voucher-amount').value = remaining;
    document.getElementById('settle-voucher-title').value = item.purpose && item.purpose !== 'ઉચક ખર્ચ' && item.purpose !== 'ઉચક આપેલ રકમ' && item.purpose !== 'Advance Cash Given' ? item.purpose : '';
    document.getElementById('settle-input-notes').value = '';
    const fullCashChk = document.getElementById('settle-chk-full-cashback');
    if (fullCashChk) fullCashChk.checked = false;

    // Reset mode to voucher
    const radioVoucher = document.querySelector('input[name="uchak_settle_type"][value="voucher"]');
    if (radioVoucher) radioVoucher.checked = true;
    this.onSettleTypeChange('voucher');
    this.onSettleCategoryChange();
    this.onSettleVoucherAmountInput(remaining);

    if (window.i18n) window.i18n.updateDOM();
    this.openModal('modal-uchak-settle', { isChild: true });

    if (window.GujaratiTyping) {
      window.GujaratiTyping.init();
    }
  },

  onSettleCategoryChange() {
    const catSelect = document.getElementById('settle-voucher-category');
    const staffBox = document.getElementById('settle-staff-box');
    if (!catSelect || !staffBox) return;

    const val = (catSelect.value || '').toUpperCase();
    if (val.includes('PAGAR') || val.includes('UPAD')) {
      staffBox.style.display = 'block';
      const item = this.activeUchakForSettle;
      const targetEmpId = item?.employeeId || (
        item?.personName ? (this.employeesList || []).find(e =>
          e.name && (e.name.toLowerCase().includes(item.personName.toLowerCase()) || item.personName.toLowerCase().includes(e.name.toLowerCase()))
        )?.id : null
      );

      const populateOptions = () => {
        const empSelect = document.getElementById('settle-select-employee');
        if (empSelect) {
          const isEn = (window.i18n && window.i18n.currentLang === 'en');
          empSelect.innerHTML = `<option value="">-- ${isEn ? 'Select Staff' : 'કર્મચારી પસંદ કરો'} --</option>`;
          (this.employeesList || []).forEach(emp => {
            const opt = document.createElement('option');
            opt.value = emp.id;
            opt.textContent = `👤 ${emp.name} (${emp.role}) - ${isEn ? 'Salary:' : 'નક્કી પગાર:'} ₹${(emp.salary || 0).toLocaleString('en-IN')}`;
            if (targetEmpId && emp.id === targetEmpId) {
              opt.selected = true;
            }
            empSelect.appendChild(opt);
          });
          if (targetEmpId) empSelect.value = targetEmpId;
        }
      };

      if (!this.employeesList || this.employeesList.length === 0) {
        this.loadEmployees().then(populateOptions);
      } else {
        populateOptions();
      }
    } else {
      staffBox.style.display = 'none';
    }
  },

  onSettleTypeChange(type) {
    ['voucher', 'all_cash_returned', 'extra_paid'].forEach(t => {
      const card = document.getElementById(`mode-card-${t === 'all_cash_returned' ? 'allcash' : (t === 'extra_paid' ? 'extrapaid' : 'voucher')}`);
      if (card) {
        if (t === type) card.classList.add('active');
        else card.classList.remove('active');
      }
    });

    const vFields = document.getElementById('settle-voucher-fields');
    const allCashFields = document.getElementById('settle-allcash-fields');
    const vAmtInput = document.getElementById('settle-voucher-amount');
    const item = this.activeUchakForSettle;
    const remaining = item ? (item.status === 'settled' ? 0 : (item.remainingAmount !== undefined ? Number(item.remainingAmount) : Number(item.givenAmount))) : 0;

    if (type === 'all_cash_returned') {
      if (vFields) vFields.style.display = 'none';
      if (allCashFields) allCashFields.style.display = 'block';
    } else if (type === 'extra_paid') {
      if (vFields) vFields.style.display = 'block';
      if (allCashFields) allCashFields.style.display = 'none';
      if (item && vAmtInput) {
        if (Number(vAmtInput.value) <= remaining) {
          vAmtInput.value = remaining + 200;
        }
      }
      this.onSettleVoucherAmountInput(vAmtInput ? vAmtInput.value : '');
    } else {
      // voucher
      if (vFields) vFields.style.display = 'block';
      if (allCashFields) allCashFields.style.display = 'none';
      if (item && vAmtInput && Number(vAmtInput.value) > remaining) {
        vAmtInput.value = remaining;
      }
      this.onSettleVoucherAmountInput(vAmtInput ? vAmtInput.value : '');
    }
  },

  onSettleVoucherAmountInput(val) {
    const pill = document.getElementById('settle-calc-pill');
    const cashReturnBox = document.getElementById('settle-cashreturn-check-box');
    const cashReturnLabel = document.getElementById('settle-chk-full-cashback-label');
    if (!pill || !this.activeUchakForSettle) return;

    const item = this.activeUchakForSettle;
    const given = Number(item.givenAmount) || 0;
    const remaining = item.status === 'settled' ? 0 : (item.remainingAmount !== undefined ? Number(item.remainingAmount) : given);
    const vAmt = Number(val) || 0;
    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    if (vAmt <= 0) {
      pill.style.display = 'none';
      if (cashReturnBox) cashReturnBox.style.display = 'none';
      return;
    }

    pill.style.display = 'block';
    if (vAmt < remaining) {
      const diff = remaining - vAmt;
      const isFullCashBack = Boolean(document.getElementById('settle-chk-full-cashback')?.checked);

      pill.style.background = isFullCashBack ? '#ecfdf5' : '#fff7ed';
      pill.style.color = isFullCashBack ? '#065f46' : '#9a3412';
      pill.style.border = isFullCashBack ? '1.5px solid #a7f3d0' : '1.5px solid #fed7aa';

      if (isFullCashBack) {
        pill.innerHTML = isEn ? `
          💵 Voucher: <strong>₹ ${vAmt.toLocaleString('en-IN')}</strong> + Cash Returned: <strong>₹ ${diff.toLocaleString('en-IN')}</strong> (Drawer Deposit)<br>
          <span style="font-size: 0.8rem; font-weight: normal; color: #047857;">(With this entry, advance balance is 100% closed and 0 pending)</span>
        ` : `
          💵 વાઉચર: <strong>₹ ${vAmt.toLocaleString('en-IN')}</strong> + બાકી વધેલા રોકડા પરત: <strong>₹ ${diff.toLocaleString('en-IN')}</strong> (ગલ્લામાં જમા)<br>
          <span style="font-size: 0.8rem; font-weight: normal; color: #047857;">(આ એન્ટ્રી સાથે સમગ્ર ઉચક હિસાબ પૂરેપૂરો પતી જશે અને 0 બાકી રહેશે)</span>
        `;
      } else {
        pill.innerHTML = isEn ? `
          🟠 Partial Settlement: Still <strong>₹ ${diff.toLocaleString('en-IN')}</strong> will remain pending!<br>
          <span style="font-size: 0.8rem; font-weight: normal; color: #c2410c;">(This ₹${vAmt.toLocaleString('en-IN')} voucher will be added to today's expenses, remaining will stay pending)</span>
        ` : `
          🟠 અંશતઃ પતાવટ: આ બિલ પછી હજી <strong>₹ ${diff.toLocaleString('en-IN')}</strong> બાકી રહેશે!<br>
          <span style="font-size: 0.8rem; font-weight: normal; color: #c2410c;">(આ ₹${vAmt.toLocaleString('en-IN')} નું વાઉચર આજના દૈનિક ખર્ચમાં ઉમેરાશે, બાકી રકમ પેન્ડિંગ રહેશે)</span>
        `;
      }

      if (cashReturnBox) {
        cashReturnBox.style.display = 'block';
        if (cashReturnLabel) {
          cashReturnLabel.textContent = isEn
            ? `Remaining ₹${diff.toLocaleString('en-IN')} cash returned to drawer (Close full advance)`
            : `બાકી વધેલા ₹${diff.toLocaleString('en-IN')} પણ રોકડા પાછા આવી ગયા છે (પૂરો હિસાબ ક્લોઝ કરો)`;
        }
      }
    } else if (vAmt === remaining) {
      if (cashReturnBox) cashReturnBox.style.display = 'none';
      pill.style.background = '#eff6ff';
      pill.style.color = '#1e40af';
      pill.style.border = '1.5px solid #bfdbfe';
      pill.innerHTML = isEn
        ? `✅ Full pending amount ₹ ${remaining.toLocaleString('en-IN')} voucher submitted (Advance fully settled).`
        : `✅ પૂરેપૂરી બાકી રકમ ₹ ${remaining.toLocaleString('en-IN')} નું વાઉચર આવી ગયું (હિસાબ સરભર / સંપૂર્ણ પતી જશે).`;
    } else {
      if (cashReturnBox) cashReturnBox.style.display = 'none';
      const extra = vAmt - remaining;
      pill.style.background = '#fff1f2';
      pill.style.color = '#9f1239';
      pill.style.border = '1.5px solid #fecdd3';
      pill.innerHTML = isEn ? `
        🔴 Extra Expense Paid: <strong>₹ ${extra.toLocaleString('en-IN')}</strong> extra paid out!<br>
        <span style="font-size: 0.8rem; font-weight: normal; color: #be123c;">(Pending was ₹${remaining.toLocaleString('en-IN')} but bill came for ₹${vAmt.toLocaleString('en-IN')}, so extra ₹${extra.toLocaleString('en-IN')} paid)</span>
      ` : `
        🔴 ખર્ચ વધુ થયો: <strong>₹ ${extra.toLocaleString('en-IN')}</strong> વધારાના ચૂકવ્યા!<br>
        <span style="font-size: 0.8rem; font-weight: normal; color: #be123c;">(બાકી ₹${remaining.toLocaleString('en-IN')} હતા પણ બિલ ₹${vAmt.toLocaleString('en-IN')} નું આવ્યું, તેથી ₹${extra.toLocaleString('en-IN')} સામેથી આપ્યા)</span>
      `;
    }
  },

  onFullCashBackToggle() {
    const vAmtInput = document.getElementById('settle-voucher-amount');
    if (vAmtInput) {
      this.onSettleVoucherAmountInput(vAmtInput.value);
    }
  },

  async submitUchakSettlement(e) {
    e.preventDefault();
    const id = document.getElementById('settle-uchak-id').value;
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const settledDate = document.getElementById('settle-input-date')?.value || this.getTodayDateStr();
    const today = this.getTodayDateStr();
    if (settledDate < today) {
      const authorized = await this.ensureAdminAuth(isEn ? `Date ${settledDate} is locked! Enter Admin PIN to settle advance on past date:` : `તારીખ ${settledDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં ઉચક જમા કરવા માટે એડમિન પિન જરૂરી છે.`);
      if (!authorized) {
        const sDateEl = document.getElementById('settle-input-date');
        if (sDateEl) sDateEl.value = today;
        return;
      }
    }
    const settleTypeRadio = document.querySelector('input[name="uchak_settle_type"]:checked');
    const settleType = settleTypeRadio ? settleTypeRadio.value : 'voucher';
    const notes = document.getElementById('settle-input-notes').value;

    const item = (this.uchakList || []).find(x => x.id === id);
    if (!item) return;

    let voucherAmount = 0;
    let voucherCategory = '';
    let voucherTitle = '';
    let cashReturned = 0;
    let extraPaid = 0;
    let employeeId = null;
    let employeeName = null;
    let forMonth = null;
    let isFinalSettlement = false;
    const addToHisab = true;

    const given = Number(item.givenAmount) || 0;
    const remaining = item.status === 'settled' ? 0 : (item.remainingAmount !== undefined ? Number(item.remainingAmount) : given);

    if (settleType === 'all_cash_returned') {
      voucherAmount = 0;
      cashReturned = remaining;
      extraPaid = 0;
      isFinalSettlement = true;
    } else {
      voucherAmount = Number(document.getElementById('settle-voucher-amount').value) || 0;
      voucherCategory = document.getElementById('settle-voucher-category').value;
      voucherTitle = document.getElementById('settle-voucher-title').value.trim();

      const isEn = (window.i18n && window.i18n.currentLang === 'en');
      if (!voucherTitle) {
        this.showToast(isEn ? 'Please enter expense description' : 'કૃપા કરીને ખર્ચ વિગત લખો', 'error');
        document.getElementById('settle-voucher-title').focus();
        return;
      }

      if (voucherAmount <= 0) {
        this.showToast(isEn ? 'Please enter valid voucher amount' : 'કૃપા કરીને સાચી વાઉચર રકમ લખો', 'error');
        document.getElementById('settle-voucher-amount').focus();
        return;
      }

      if (voucherAmount < remaining) {
        const isFullCashBack = Boolean(document.getElementById('settle-chk-full-cashback')?.checked);
        if (isFullCashBack) {
          cashReturned = remaining - voucherAmount;
          isFinalSettlement = true;
        } else {
          cashReturned = 0;
          isFinalSettlement = false;
        }
      } else if (voucherAmount === remaining) {
        cashReturned = 0;
        extraPaid = 0;
        isFinalSettlement = true;
      } else {
        extraPaid = voucherAmount - remaining;
        isFinalSettlement = true;
      }

      // Check staff fields
      const isPagarOrUpad = voucherCategory.toUpperCase().includes('PAGAR') || voucherCategory.toUpperCase().includes('UPAD');
      if (isPagarOrUpad) {
        const empSel = document.getElementById('settle-select-employee');
        const monthInp = document.getElementById('settle-select-month');
        if (empSel && empSel.value) {
          employeeId = empSel.value;
          const emp = (this.employeesList || []).find(e => e.id === employeeId);
          if (emp) employeeName = emp.name;
        }
        if (monthInp && monthInp.value) {
          forMonth = monthInp.value;
        }
      }
    }

    try {
      const res = await fetch(`/api/uchak/${id}/settle`, {
        method: 'POST',
        headers: this.getAdminHeaders ? this.getAdminHeaders() : { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settledDate,
          settleType,
          voucherAmount,
          voucherCategory,
          voucherTitle,
          remarks: notes,
          notes,
          cashReturned,
          extraPaid,
          addToHisab,
          employeeId,
          employeeName,
          forMonth,
          isFinalSettlement
        })
      });

      const data = await res.json();
      const isEn = (window.i18n && window.i18n.currentLang === 'en');
      if (res.ok && data.success) {
        const updatedItem = data.item;
        if (updatedItem && updatedItem.status === 'partial') {
          this.showToast(isEn ? `🟠 Voucher of ₹${voucherAmount.toLocaleString('en-IN')} added for ${item.personName}! (Pending: ₹${(updatedItem.remainingAmount || 0).toLocaleString('en-IN')})` : `🟠 ${item.personName} નું વાઉચર ₹${voucherAmount.toLocaleString('en-IN')} ઉમેરાયું! (બાકી ₹${(updatedItem.remainingAmount || 0).toLocaleString('en-IN')})`, 'success');
        } else {
          this.showToast(isEn ? `✅ Advance account for ${item.personName} fully settled!` : `✅ ${item.personName} નો ઉચક હિસાબ સંપૂર્ણ પતી ગયો!`, 'success');
        }
        this.closeModal('modal-uchak-settle');

        // If added to hisab and settled date matches active date, reload that date
        if (voucherAmount > 0 && addToHisab && settledDate === this.currentDate) {
          await this.loadDate(this.currentDate);
        }
        if (employeeId) {
          await this.loadEmployees();
        }

        await this.loadUchakRecords();
        this.renderUchakKPIs();
        this.renderUchakList();
        this.renderQuickUchakList();
      } else {
        this.showToast(data.error || (isEn ? 'Error in settlement' : 'પતાવટમાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error submitting uchak settlement:', err);
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  async unsettleUchak(id) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const item = (this.uchakList || []).find(x => x.id === id);

    try {
      const res = await fetch(`/api/uchak/${id}/unsettle`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        const pName = item ? item.personName : (isEn ? 'Advance account' : 'ઉચક હિસાબ');
        this.showToast(isEn ? `↩️ Account for ${pName} is set back to pending!` : `↩️ ${pName} નો હિસાબ ફરીથી "બાકી" થઈ ગયો છે!`, 'info');
        await this.loadDate(this.currentDate);
        await this.loadUchakRecords();
        this.renderQuickUchakList();
        this.renderUchakKPIs();
        this.renderUchakList();
        this.updateQuickDrawerUI();
      } else {
        this.showToast(data.error || (isEn ? 'Error' : 'ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error unsettling:', err);
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  async deleteUchak(id) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    try {
      const res = await fetch(`/api/uchak/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.success) {
        await this.loadDate(this.currentDate);
        await this.loadUchakRecords();
        this.renderQuickUchakList();
        this.renderUchakKPIs();
        this.renderUchakList();
        this.updateQuickDrawerUI();
      } else {
        this.showToast(data.error || (isEn ? 'Error deleting' : 'કાઢવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error deleting uchak:', err);
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  async openBankAccumulatedModal() {
    await this.flushPendingSave();
    await this.loadBankDepositSummary();
    if (window.i18n) window.i18n.updateDOM();
    this.openModal('modal-bank-accumulated-detail');
  },

  // Bank Cash Deposit & Rolling Day-by-Day Accumulator Summary
  async loadBankDepositSummary() {
    try {
      const res = await fetch(`/api/bank-deposits?date=${this.currentDate}`);
      const data = await res.json();
      if (!data) return;

      this.bankDepositData = data;
      const summary = data.unbankedSummary || {};
      const noteTotals = summary.noteTotals || {};

      const amtEl = document.getElementById('side-accumulated-total-amount');
      const notesCntEl = document.getElementById('side-accumulated-notes-count');
      const badgeEl = document.getElementById('side-accumulated-days-badge');
      const rangeEl = document.getElementById('side-accumulated-date-range');
      const depositedBadgeEl = document.getElementById('side-deposited-summary-badge');
      const gridEl = document.getElementById('side-notes-summary-grid');
      const tbody = document.getElementById('side-tbody-daily-cash');

      const remainingCash = summary.remainingCashToBank !== undefined ? summary.remainingCashToBank : (summary.accumulatedCashTotal || 0);

      // Update Top-Right Header Pill Amount & Days
      const headerAmtEl = document.getElementById('header-bank-accumulated-amount');
      const headerDaysEl = document.getElementById('header-bank-accumulated-days');
      if (headerAmtEl) {
        headerAmtEl.textContent = `₹ ${remainingCash.toLocaleString('en-IN')}`;
      }
      if (headerDaysEl) {
        headerDaysEl.textContent = `${summary.accumulatedDaysCount || 0}d`;
      }

      if (amtEl) {
        amtEl.textContent = `₹ ${remainingCash.toLocaleString('en-IN')}`;
      }

      const isEn = (window.i18n && window.i18n.currentLang === 'en');

      if (depositedBadgeEl) {
        const depositedTotal = summary.periodDepositedTotal || 0;
        const depositCount = summary.periodDepositsCount || 0;
        if (depositedTotal > 0) {
          depositedBadgeEl.style.display = 'inline-block';
          depositedBadgeEl.textContent = isEn
            ? `🏦 Deposited: ₹ ${depositedTotal.toLocaleString('en-IN')} (${depositCount} entries)`
            : `🏦 જમા ભરેલ: ₹ ${depositedTotal.toLocaleString('en-IN')} (${depositCount} એન્ટ્રી)`;
        } else {
          depositedBadgeEl.style.display = 'none';
        }
      }

      if (notesCntEl) {
        notesCntEl.textContent = isEn
          ? `(Total Notes: ${summary.accumulatedNoteCount || 0} pcs)`
          : `(કુલ નોટો: ${summary.accumulatedNoteCount || 0} નંગ)`;
      }

      if (badgeEl) {
        badgeEl.textContent = isEn
          ? `${summary.accumulatedDaysCount || 0} Days Pending`
          : `${summary.accumulatedDaysCount || 0} દિવસ બાકી`;
      }

      if (rangeEl) {
        if (summary.unbankedFromDate && summary.unbankedToDate) {
          rangeEl.textContent = isEn
            ? `Period: ${summary.unbankedFromDate} to ${summary.unbankedToDate}`
            : `સમયગાળો: ${summary.unbankedFromDate} થી ${summary.unbankedToDate}`;
        } else {
          rangeEl.textContent = isEn ? `Period: -` : `સમયગાળો: -`;
        }
      }

      // Render Denominations Summary Grid
      if (gridEl) {
        const denoms = [500, 200, 100, 50, 20, 10];
        const itemsHtml = denoms.map(val => {
          const obj = noteTotals[val] || { count: 0, amount: 0 };
          return `
            <div style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 8px 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.02); display: flex; flex-direction: column; gap: 3px;">
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <span style="font-weight: 800; color: #475569; font-size: 0.85rem;">₹ ${val}</span>
                <span style="font-weight: 800; color: #1e293b; font-size: 0.9rem;">${obj.count} <small style="font-size: 0.72rem; color: #64748b;">${isEn ? 'pcs' : 'નંગ'}</small></span>
              </div>
              <div style="font-size: 0.88rem; font-weight: 800; color: #15803d; text-align: right;">₹ ${(obj.amount || 0).toLocaleString('en-IN')}</div>
            </div>
          `;
        });
        gridEl.innerHTML = itemsHtml.join('');
      }

      if (tbody) {
        const breakdown = summary.dailyBreakdown || [];
        if (breakdown.length === 0) {
          tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 24px; color: #94a3b8; font-weight: 700;">${isEn ? 'No unbanked cash remaining' : 'કોઈ રોકડ બાકી નથી'}</td></tr>`;
        } else {
          tbody.innerHTML = breakdown.map(item => `
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 10px 16px;"><strong>${item.date}</strong></td>
              <td style="padding: 10px 16px; text-align: center; font-weight: 800; color: #1e3a8a;">${item.noteCountTotal || 0} ${isEn ? 'pcs' : 'નંગ'}</td>
              <td style="padding: 10px 16px; text-align: right; font-weight: 800; color: #15803d; font-size: 0.96rem;">₹ ${(item.cashTotal || 0).toLocaleString('en-IN')}</td>
            </tr>
          `).join('');
        }
      }
    } catch (e) {
      console.error('Error loading bank deposit summary:', e);
    }
  },

  toggleSideBreakdown() {
    const el = document.getElementById('side-accumulated-breakdown');
    const btnText = document.getElementById('side-breakdown-btn-text');
    if (!el) return;
    const isHidden = el.style.display === 'none' || !el.style.display;
    el.style.display = isHidden ? 'block' : 'none';
    if (btnText) {
      const isEn = (window.i18n && window.i18n.currentLang === 'en');
      btnText.textContent = isHidden
        ? (isEn ? 'Hide Details' : 'વિગત બંધ કરો')
        : (isEn ? 'View Daily Details' : 'દૈનિક વિગત જુઓ');
    }
  },

  openBankDepositModal() {
    const summary = (this.bankDepositData && this.bankDepositData.unbankedSummary) || {};
    const availableBanks = (this.bankDepositData && this.bankDepositData.availableBanks) || this.activeBanks || ['IOB TRF', 'BOB TRF ', 'SBI TRF'];

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const selectBankEl = document.getElementById('bank-deposit-select-bank');
    if (selectBankEl) {
      selectBankEl.innerHTML = availableBanks.map(b => `<option value="${b.trim()}">${b.trim()}</option>`).join('');
    }

    const dateEl = document.getElementById('bank-deposit-date');
    if (dateEl) dateEl.value = this.currentDate;

    const amtEl = document.getElementById('bank-deposit-amount');
    const remainingCash = summary.remainingCashToBank !== undefined ? summary.remainingCashToBank : (summary.accumulatedCashTotal || 0);
    if (amtEl) amtEl.value = remainingCash;

    const slipEl = document.getElementById('bank-deposit-slip');
    if (slipEl) slipEl.value = '';

    const remEl = document.getElementById('bank-deposit-remarks');
    if (remEl) {
      const days = summary.accumulatedDaysCount || 1;
      remEl.value = isEn ? `Cash deposited into bank from ${days} accumulated days` : `${days} દિવસની એકઠી થયેલી રોકડમાંથી બેંકમાં જમા`;
    }

    if (window.i18n) window.i18n.updateDOM();
    this.openModal('modal-bank-deposit', { isChild: true });
  },

  async saveBankDeposit(e) {
    e.preventDefault();
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const summary = (this.bankDepositData && this.bankDepositData.unbankedSummary) || {};

    const depositDate = document.getElementById('bank-deposit-date').value;
    const bankName = document.getElementById('bank-deposit-select-bank').value;
    const amount = Number(document.getElementById('bank-deposit-amount').value);
    const slipNo = document.getElementById('bank-deposit-slip').value;
    const remarks = document.getElementById('bank-deposit-remarks').value;

    if (!bankName) {
      return this.showToast(isEn ? 'Please select bank name' : 'કૃપા કરીને બેંકનું નામ પસંદ કરો', 'error');
    }
    if (isNaN(amount) || amount < 0) {
      return this.showToast(isEn ? 'Please enter amount' : 'કૃપા કરીને રકમ દાખલ કરો', 'error');
    }

    try {
      const res = await fetch('/api/bank-deposits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          depositDate,
          bankName,
          amount,
          slipNo,
          remarks,
          fromDate: summary.unbankedFromDate || depositDate,
          toDate: summary.unbankedToDate || depositDate,
          daysCount: summary.accumulatedDaysCount || 1
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast(isEn ? `🏦 Recorded ₹ ${amount.toLocaleString('en-IN')} cash deposit in ${bankName}!` : `🏦 ${bankName} માં ₹ ${amount.toLocaleString('en-IN')} ની રોકડ જમા સાચવાઈ ગઈ છે!`, 'success');
        this.closeModal('modal-bank-deposit');
        await this.loadBankDepositSummary();
      } else {
        this.showToast(data.error || (isEn ? 'Error saving deposit' : 'સાચવવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error saving bank deposit:', err);
      this.showToast(isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો', 'error');
    }
  },

  async openBankDepositHistoryModal() {
    try {
      const res = await fetch(`/api/bank-deposits?date=${this.currentDate}`);
      const data = await res.json();
      const deposits = (data && data.deposits) || [];

      const tbody = document.getElementById('tbody-bank-deposit-history');
      const countEl = document.getElementById('history-deposit-total-count');

      let totalDepositedAmount = 0;
      let totalDaysCovered = 0;
      deposits.forEach(d => {
        totalDepositedAmount += (Number(d.amount) || 0);
        totalDaysCovered += (Number(d.daysCount) || 1);
      });

      if (window.i18n) window.i18n.updateDOM();

      const isEn = (window.i18n && window.i18n.currentLang === 'en');
      const kpiCount = document.getElementById('history-kpi-count');
      const kpiAmt = document.getElementById('history-kpi-total-amount');
      const kpiDays = document.getElementById('history-kpi-total-days');

      if (kpiCount) kpiCount.textContent = isEn ? `${deposits.length} Records` : `${deposits.length} નોંધો`;
      if (kpiAmt) kpiAmt.textContent = `₹ ${totalDepositedAmount.toLocaleString('en-IN')}`;
      if (kpiDays) kpiDays.textContent = isEn ? `${totalDaysCovered} Days` : `${totalDaysCovered} દિવસો`;
      if (countEl) countEl.textContent = isEn
        ? `Total Deposit Records: ${deposits.length} (Total Deposited: ₹ ${totalDepositedAmount.toLocaleString('en-IN')})`
        : `કુલ જમા નોંધો: ${deposits.length} (કુલ જમા: ₹ ${totalDepositedAmount.toLocaleString('en-IN')})`;

      if (!tbody) return;

      if (!deposits || deposits.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 35px; color: #94a3b8; font-size: 0.95rem;">${isEn ? 'No bank cash deposits recorded yet' : 'અત્યાર સુધી કોઈ બેંક રોકડ જમા નોંધાયેલ નથી'}</td></tr>`;
      } else {
        let html = '';
        deposits.forEach((d) => {
          const toWord = isEn ? 'to' : 'થી';
          const daysText = isEn ? `(${d.daysCount || 1} days account)` : `(${d.daysCount || 1} દિવસનો હિસાબ)`;
          const slipText = d.slipNo ? `<div style="font-size: 0.8rem; font-weight: 800; color: #4338ca;">${isEn ? 'Slip No:' : 'સ્લિપ નં:'} ${d.slipNo}</div>` : '';
          html += `
            <tr style="background: #ffffff; border-bottom: 1px solid #e2e8f0; vertical-align: top;">
              <td style="padding: 12px; white-space: nowrap;">
                <div style="font-weight: 800; font-size: 0.95rem; color: #0f172a;">${d.depositDate}</div>
                <span class="badge-history-saved" style="background: #ecfdf5; color: #047857; padding: 2px 7px; border-radius: 10px; font-size: 0.72rem; font-weight: 700; border: 1px solid #a7f3d0; margin-top: 4px; display: inline-block;">${isEn ? '✅ Deposited to Bank' : '✅ બેંકમાં જમા'}</span>
              </td>
              <td style="padding: 12px; white-space: nowrap;">
                <span style="background: #e0f2fe; color: #0369a1; font-weight: 800; padding: 4px 10px; border-radius: 6px; border: 1px solid #bae6fd; font-size: 0.88rem; display: inline-flex; align-items: center; gap: 4px;">
                  🏦 ${d.bankName}
                </span>
              </td>
              <td style="padding: 12px; text-align: right; white-space: nowrap;">
                <div style="font-weight: 900; color: #15803d; font-size: 1.15rem;">₹ ${Number(d.amount).toLocaleString('en-IN')}</div>
              </td>
              <td style="padding: 12px; white-space: nowrap;">
                <div style="font-weight: 700; font-size: 0.85rem; color: #1e3a8a;">${d.fromDate || d.depositDate} ${toWord} ${d.toDate || d.depositDate}</div>
                <div style="font-size: 0.78rem; color: #64748b; font-weight: 600;">${daysText}</div>
              </td>
              <td style="padding: 12px;">
                ${slipText}
                <div style="font-size: 0.8rem; color: #475569;">${d.remarks || '-'}</div>
              </td>
              <td style="padding: 12px; text-align: center; white-space: nowrap;">
                <button type="button" class="btn-icon" style="color: #ef4444; background: #fef2f2; border: 1px solid #fecaca; padding: 6px 12px; border-radius: 6px; font-size: 0.85rem; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" onclick="App.promptDeleteBankDeposit('${d.id}')" title="${isEn ? 'Cancel this entry (Admin password required)' : 'આ નોંધ રદ કરો (એડમિન પાસવર્ડ જરૂરી)'}">
                  <span>🗑️</span> <span>${isEn ? 'Cancel' : 'રદ કરો'}</span>
                </button>
              </td>
            </tr>
          `;
        });
        tbody.innerHTML = html;
      }

      this.openModal('modal-bank-deposit-history', { isChild: true });
    } catch (err) {
      console.error('Error loading bank deposit history:', err);
      const isEn = (window.i18n && window.i18n.currentLang === 'en');
      this.showToast(isEn ? 'Error loading deposit history' : 'ઇતિહાસ લોડ કરવામાં ભૂલ આવી', 'error');
    }
  },

  promptDeleteBankDeposit(id) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const deposits = (this.bankDepositData && this.bankDepositData.deposits) || [];
    const deposit = deposits.find(d => d.id === id);

    const hiddenId = document.getElementById('bank-dep-delete-id');
    const cardEl = document.getElementById('bank-dep-delete-info-card');
    const pinInput = document.getElementById('input-bank-dep-delete-pin');
    const errEl = document.getElementById('bank-dep-delete-error');

    if (hiddenId) hiddenId.value = id;
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    if (pinInput) { pinInput.value = ''; }

    if (cardEl && deposit) {
      cardEl.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-weight: 800; color: #0284c7; background: #e0f2fe; border: 1px solid #bae6fd; padding: 3px 8px; border-radius: 6px; font-size: 0.85rem;">
            🏦 ${deposit.bankName}
          </span>
          <span style="font-weight: 900; color: #15803d; font-size: 1.25rem;">
            ₹ ${Number(deposit.amount).toLocaleString('en-IN')}
          </span>
        </div>
        <div style="font-size: 0.84rem; color: #1e293b; font-weight: 700; margin-bottom: 4px;">
          📅 ${isEn ? 'Deposit Date:' : 'જમા તારીખ:'} <strong>${deposit.depositDate}</strong>
        </div>
        <div style="font-size: 0.8rem; color: #475569; font-weight: 600;">
          ⏳ ${isEn ? 'Period Covered:' : 'કવર કરેલ સમયગાળો:'} ${deposit.fromDate || deposit.depositDate} ${isEn ? 'to' : 'થી'} ${deposit.toDate || deposit.depositDate} (${deposit.daysCount || 1} ${isEn ? 'days' : 'દિવસ'})
        </div>
        ${deposit.slipNo ? `<div style="font-size: 0.78rem; color: #4338ca; font-weight: 700; margin-top: 4px;">🔢 ${isEn ? 'Slip No:' : 'સ્લિપ નં:'} ${deposit.slipNo}</div>` : ''}
      `;
    }

    this.openModal('modal-bank-deposit-delete-confirm', { isChild: true });
    if (pinInput) {
      setTimeout(() => pinInput.focus(), 120);
    }
  },

  async confirmDeleteBankDeposit(e) {
    if (e) e.preventDefault();
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const idInput = document.getElementById('bank-dep-delete-id');
    const pinInput = document.getElementById('input-bank-dep-delete-pin');
    const errEl = document.getElementById('bank-dep-delete-error');
    const submitBtn = document.getElementById('btn-submit-delete-bank-deposit');

    const id = idInput ? idInput.value : '';
    const pin = pinInput ? pinInput.value.trim() : '';

    if (!id) {
      this.showToast(isEn ? 'Invalid deposit ID' : 'અમાન્ય ડિપોઝિટ ID', 'error');
      return;
    }
    if (!pin) {
      if (errEl) {
        errEl.textContent = isEn ? 'Please enter admin password' : 'કૃપા કરીને એડમિન પાસવર્ડ દાખલ કરો';
        errEl.style.display = 'block';
      }
      if (pinInput) pinInput.focus();
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span>⏳</span> <span>${isEn ? 'Cancelling...' : 'રદ થઈ રહ્યું છે...'}</span>`;
    }

    try {
      const res = await fetch(`/api/bank-deposits/${id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-pin': pin
        },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();

      if (res.ok && data.success) {
        this.closeModal('modal-bank-deposit-delete-confirm');
        this.showToast(isEn ? '🗑️ Bank deposit entry cancelled successfully' : '🗑️ બેંક જમા નોંધ સફળતાપૂર્વક રદ કરવામાં આવી', 'success');

        // Refresh registers and balances immediately
        await this.loadBankDepositSummary();
        await this.openBankDepositHistoryModal();

        // If History Modal (Alt+H) is open, also refresh its table
        if (typeof this.renderHistoryTable === 'function') {
          try {
            const depRes = await fetch('/api/bank-deposits');
            const depData = await depRes.json();
            this.allBankDeposits = (depData && Array.isArray(depData.deposits)) ? depData.deposits : [];
            this.renderHistoryTable();
          } catch (_) { }
        }
      } else {
        const errorMsg = data.error || (isEn ? 'Incorrect admin password!' : 'ખોટો એડમિન પાસવર્ડ!');
        if (errEl) {
          errEl.textContent = errorMsg;
          errEl.style.display = 'block';
        }
        this.showToast(errorMsg, 'error');
        if (pinInput) {
          pinInput.value = '';
          pinInput.focus();
        }
      }
    } catch (err) {
      console.error('Error deleting bank deposit:', err);
      const errMsg = isEn ? 'Server error - please try again' : 'સર્વર એરર - ફરી પ્રયત્ન કરો';
      if (errEl) {
        errEl.textContent = errMsg;
        errEl.style.display = 'block';
      }
      this.showToast(errMsg, 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<span>🗑️</span> <span>${isEn ? 'Confirm Delete' : 'કાયમી રદ કરો'}</span>`;
      }
    }
  },

  deleteBankDeposit(id) {
    this.promptDeleteBankDeposit(id);
  },

  updateRemarksIndicator() {
    const btn = document.getElementById('btn-open-remarks-modal');
    const dot = document.getElementById('remarks-btn-dot');
    const hasRemarks = !!(this.record && this.record.remarks && this.record.remarks.trim());
    if (dot) dot.style.display = hasRemarks ? 'block' : 'none';
    if (btn) {
      if (hasRemarks) {
        btn.style.background = 'rgba(245, 158, 11, 0.15)';
        btn.style.borderColor = '#f59e0b';
        btn.title = `વિશેષ નોંધ: "${this.record.remarks}" (સુધારવા માટે ક્લિક કરો)`;
      } else {
        btn.style.background = 'var(--bg-card)';
        btn.style.borderColor = 'var(--border-color)';
        btn.title = 'વિશેષ નોંધ ઉમેરો / જુઓ';
      }
    }
  },

  openRemarksModal() {
    const modal = document.getElementById('modal-remarks');
    const txt = document.getElementById('modal-remarks-textarea');
    const dateLbl = document.getElementById('remarks-modal-date-label');
    if (dateLbl) dateLbl.textContent = this.currentDate || '';
    if (txt) {
      txt.value = (this.record && this.record.remarks) ? this.record.remarks : '';
      txt.readOnly = this.isCurrentDateLocked();
    }
    this.openModal('modal-remarks');
    if (txt) setTimeout(() => txt.focus(), 100);
  },

  closeRemarksModal() {
    this.closeModal('modal-remarks');
  },

  saveRemarksModal() {
    if (this.isCurrentDateLocked()) {
      this.closeRemarksModal();
      return;
    }
    const txt = document.getElementById('modal-remarks-textarea');
    if (txt && this.record) {
      this.record.remarks = txt.value.trim();
      this.saveCurrentRecord(true);
      this.updateRemarksIndicator();
    }
    this.closeRemarksModal();
  },

  clearRemarksModal() {
    if (this.isCurrentDateLocked()) {
      this.closeRemarksModal();
      return;
    }
    const txt = document.getElementById('modal-remarks-textarea');
    if (txt) txt.value = '';
    if (this.record) {
      this.record.remarks = '';
      this.saveCurrentRecord(true);
      this.updateRemarksIndicator();
    }
    this.closeRemarksModal();
  },

  openModal(modalId, options = {}) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    if (window.i18n) {
      window.i18n.updateDOM();
    }

    const isChild = options.isChild || false;

    // Sub / Child Modals that stack cleanly on top of parent modals
    const childModalIds = [
      'modal-admin-pin',
      'modal-admin-rename',
      'modal-edit-expense-item',
      'modal-uchak-settle',
      'modal-quick-uchak',
      'modal-employee-form',
      'modal-employee-ledger',
      'modal-employee-quick-upad',
      'modal-employee-quick-pagar',
      'modal-bulk-pagar-confirm',
    ];

    const isExplicitChild = isChild || childModalIds.includes(modalId);

    if (!isExplicitChild) {
      // Opening a top-level modal: automatically close ANY currently open modal so there is zero overlap!
      document.querySelectorAll('.modal-overlay.active').forEach(openM => {
        if (openM.id !== modalId) {
          this.closeModal(openM.id);
        }
      });
    } else {
      // Ensure child modals always have elevated z-index above base modals
      if (modalId === 'modal-admin-pin') {
        modal.style.zIndex = '10002';
      } else if (modalId === 'modal-quick-uchak') {
        modal.style.zIndex = '10001';
      } else {
        modal.style.zIndex = '9999';
      }
    }

    modal.style.display = 'flex';
    modal.classList.add('active');
    document.body.classList.add('modal-open');
  },

  closeModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) {
      m.classList.remove('active');
      m.style.display = '';
    }
    const remaining = document.querySelectorAll('.modal-overlay.active');
    if (remaining.length === 0) {
      document.body.classList.remove('modal-open');
    }
  },

  closeAllModals() {
    document.querySelectorAll('.modal-overlay.active').forEach(m => {
      m.classList.remove('active');
      m.style.display = '';
    });
    document.body.classList.remove('modal-open');
    const drawer = document.getElementById('quick-uchak-drawer');
    if (drawer && drawer.classList.contains('open')) {
      this.toggleQuickUchak(false);
    }
  },

  showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let text = msg;
    if (typeof msg === 'object' && msg !== null) {
      const lang = (window.i18n && window.i18n.currentLang) || 'gu';
      text = msg[lang] || msg['gu'] || msg['en'] || JSON.stringify(msg);
    } else if (typeof msg === 'string' && window.i18n && window.i18n.translations && window.i18n.translations[window.i18n.currentLang]?.[msg]) {
      text = window.i18n.t(msg);
    }

    toast.textContent = text;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  },

  // =========================================================================
  // BHAKT RECURRING DONATION / SEVA REGISTER METHODS
  // =========================================================================
  bhaktsList: [],
  activeBhaktForDeposit: null,
  activeBhaktReceiptData: null,
  bhaktAdminMode: false,
  bhaktDepositMode: 'date_wise',

  async openBhaktsModal() {
    this.openModal('modal-bhakts');
    this.bhaktAdminMode = Boolean(this.adminAuthenticated);
    this.updateBhaktToolbarActions();
    await this.loadBhakts();
    const searchInp = document.getElementById('bhakt-search-input');
    if (searchInp) searchInp.value = '';
  },

  updateBhaktToolbarActions() {
    const container = document.getElementById('bhakt-toolbar-actions');
    if (!container) return;
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    if (this.bhaktAdminMode) {
      container.innerHTML = `
        <span style="font-size: 0.76rem; font-weight: 800; color: #047857; background: #dcfce7; padding: 4px 10px; border-radius: 12px; border: 1px solid #86efac;">
          ${isEn ? '🛡️ Admin Active' : '🛡️ એડમિન ચાલુ'}
        </span>
        <button type="button" class="btn-primary" onclick="App.openAddBhaktModal()"
          style="background: linear-gradient(135deg, #059669, #10b981); border: none; font-weight: 800; font-size: 0.88rem; padding: 7px 16px; border-radius: 8px; cursor: pointer; white-space: nowrap;">
          <span>➕</span> <span>${isEn ? 'Add Devotee' : 'નવો હરિભક્ત ઉમેરો'}</span>
        </button>
        <button type="button" class="btn-secondary" onclick="App.exitBhaktAdminMode()"
          style="padding: 7px 12px; font-size: 0.82rem; font-weight: 700; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; cursor: pointer;" title="${isEn ? 'Normal User Mode' : 'સામાન્ય યુઝર મોડ'}">
          ${isEn ? '🔒 Exit Admin' : '🔒 એડમિન બંધ'}
        </button>
      `;
    } else {
      container.innerHTML = `
        <button type="button" class="btn-primary" onclick="App.enableBhaktAdminMode()"
          style="background: linear-gradient(135deg, #0284c7, #0369a1); border: none; font-weight: 800; font-size: 0.84rem; padding: 8px 14px; border-radius: 8px; cursor: pointer; white-space: nowrap;" title="${isEn ? 'Admin PIN required to manage devotees' : 'નવો હરિભક્ત ઉમેરવા કે વિગતો સુધારવા માટે એડમિન પિન જરૂરી છે'}">
          <span>🔐</span> <span>${isEn ? 'Admin Manage' : 'એડમિન મેનેજ'}</span>
        </button>
      `;
    }
  },

  enableBhaktAdminMode() {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    if (this.adminAuthenticated && this.adminToken) {
      this.bhaktAdminMode = true;
      this.updateBhaktToolbarActions();
      this.renderBhaktsList(this.bhaktsList);
    } else {
      this.adminPendingOpenTab = 'bhakts_admin_mode';
      this.openModal('modal-admin-pin', { isChild: true });
      const pinInp = document.getElementById('input-admin-pin-auth');
      if (pinInp) {
        pinInp.value = '';
        setTimeout(() => pinInp.focus(), 100);
      }
    }
  },

  exitBhaktAdminMode() {
    this.bhaktAdminMode = false;
    this.updateBhaktToolbarActions();
    this.renderBhaktsList(this.bhaktsList);
  },

  async loadBhakts() {
    try {
      const res = await fetch('/api/bhakts');
      const data = await res.json();
      if (data && data.success) {
        this.bhaktsList = data.bhakts || [];
        this.renderBhaktsList(this.bhaktsList);
        this.updateBhaktsStats();
      }
    } catch (e) {
      console.error('Error loading bhakts:', e);
      const isEn = (window.i18n && window.i18n.currentLang === 'en');
      this.showToast(isEn ? 'Error loading devotees list' : 'હરિભક્તોની યાદી લોડ કરવામાં ભૂલ આવી', 'error');
    }
  },

  calculateBhaktPending(b) {
    const todayStr = this.currentDate || this.getTodayDateStr();
    const [tY, tM, tD] = todayStr.split('-').map(Number);
    const todayDate = new Date(tY, tM - 1, tD);
    const dailyRate = Number(b.dailyAmount) || 0;

    let bakiDays = 0;
    if (b.lastDeposit && b.lastDeposit.periodEnd) {
      const [pY, pM, pD] = b.lastDeposit.periodEnd.split('-').map(Number);
      const lastPaidDate = new Date(pY, pM - 1, pD);
      const diffDays = Math.round((todayDate - lastPaidDate) / (1000 * 60 * 60 * 24));
      if (diffDays > 0) {
        bakiDays = diffDays;
      }
    } else {
      const regStr = b.createdAt ? b.createdAt.split('T')[0] : todayStr;
      const [cY, cM, cD] = regStr.split('-').map(Number);
      const startDate = new Date(cY, cM - 1, cD);
      const diffDays = Math.round((todayDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
      bakiDays = Math.max(0, diffDays);
    }
    const bakiAmount = bakiDays * dailyRate;
    return { bakiDays, bakiAmount };
  },

  updateBhaktsStats() {
    const list = this.bhaktsList || [];
    const jamaEl = document.getElementById('bhakts-stat-total-jama');
    const bakiEl = document.getElementById('bhakts-stat-current-baki');
    const bakiSubEl = document.getElementById('bhakts-stat-baki-subtext');

    let totalJama = 0;
    let totalBaki = 0;
    let bakiCount = 0;

    list.forEach(b => {
      const jama = Number(b.totalAmountPaid) || Number(b.totalCollected) || 0;
      totalJama += jama;

      const { bakiDays, bakiAmount } = this.calculateBhaktPending(b);
      if (bakiDays > 0) {
        totalBaki += bakiAmount;
        bakiCount++;
      }
    });

    if (jamaEl) jamaEl.textContent = `₹ ${totalJama.toLocaleString('en-IN')}`;
    if (bakiEl) bakiEl.textContent = `₹ ${totalBaki.toLocaleString('en-IN')}`;
    if (bakiSubEl) {
      const isEn = (window.i18n && window.i18n.currentLang === 'en');
      bakiSubEl.textContent = isEn ? `${bakiCount} Due` : `${bakiCount} હરિભક્તો બાકી`;
    }
  },

  renderBhaktsList(list) {
    const container = document.getElementById('bhakts-cards-list');
    if (!container) return;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    if (!list || list.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; background: #ffffff; border: 1.5px dashed #cbd5e1; border-radius: 12px; color: #64748b;">
          <div style="font-size: 2.2rem; margin-bottom: 6px;">🙏</div>
          <div style="font-weight: 800; font-size: 1.05rem; color: #1e293b;">${isEn ? 'No Devotees Found' : 'કોઈ હરિભક્ત મળ્યા નથી'}</div>
          <div style="font-size: 0.85rem; margin-top: 4px;">
            ${isEn
          ? (this.bhaktAdminMode ? 'Click "+ Add Devotee" button above to add new members.' : 'Click "Admin Manage" to add or edit devotees.')
          : (this.bhaktAdminMode ? 'નવો હરિભક્ત ઉમેરવા માટે ઉપર "➕ નવો હરિભક્ત ઉમેરો" બટન દબાવો.' : 'નવો હરિભક્ત ઉમેરવા માટે "🔐 એડમિન મેનેજ" કરો.')}
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div style="background: #ffffff; border: 1.5px solid #cbd5e1; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.03);">
        <div style="max-height: 56vh; overflow-y: auto;">
          <table class="table-hisab" style="width: 100%; border-collapse: collapse; font-size: 0.88rem; margin: 0;">
            <thead style="position: sticky; top: 0; background: #f8fafc; z-index: 2; border-bottom: 2px solid #cbd5e1;">
              <tr>
                <th style="width: 40px; text-align: center;">#</th>
                <th style="width: 95px; text-align: center;">${isEn ? 'Donor ID' : 'દાતા ID'}</th>
                <th>${isEn ? 'Member Name' : 'હરિભક્તનું નામ'}</th>
                <th style="width: 110px; text-align: right;">${isEn ? 'Daily Rate' : 'રોજનો દર'}</th>
                <th>${isEn ? 'Last Period' : 'છેલ્લે જમા મુદત'}</th>
                <th style="width: 125px; text-align: right;">${isEn ? 'Last Amount' : 'છેલ્લી રકમ'}</th>
                <th style="width: 145px; text-align: center;">${isEn ? 'Status' : 'સ્થિતિ'}</th>
                <th style="width: ${this.bhaktAdminMode ? '220px' : '150px'}; text-align: center;">
                  ${isEn ? (this.bhaktAdminMode ? 'Actions (Admin)' : 'Actions') : (this.bhaktAdminMode ? 'કાર્યવાહી (Admin)' : 'કાર્યવાહી')}
                </th>
              </tr>
            </thead>
            <tbody>
              ${list.map((b, idx) => {
      const last = b.lastDeposit;
      const { bakiDays, bakiAmount } = this.calculateBhaktPending(b);
      return `
                  <tr style="border-bottom: 1px solid #e2e8f0; transition: background 0.15s ease;" onmouseover="this.style.background='#f0fdf4'" onmouseout="this.style.background=''">
                    <td style="text-align: center; font-weight: 700; color: #64748b;">${idx + 1}</td>
                    <td style="text-align: center;">
                      <span style="background: #e0f2fe; color: #0284c7; border: 1.5px solid #bae6fd; font-weight: 900; font-size: 0.82rem; padding: 2px 8px; border-radius: 6px; letter-spacing: 0.5px;">
                        ${b.donorId || (idx + 101)}
                      </span>
                    </td>
                    <td>
                      <div style="font-weight: 900; font-size: 0.96rem; color: #0f172a;">${b.name}</div>
                      ${b.phone ? `<div style="font-size: 0.76rem; color: #64748b; font-weight: 600; margin-top: 1px;">📞 ${b.phone}</div>` : ''}
                    </td>
                    <td style="text-align: right;">
                      <span style="font-weight: 900; color: #0369a1; font-size: 1.05rem;">₹ ${b.dailyAmount}</span>
                    </td>
                    <td>
                      ${last ? `
                        <span style="font-weight: 800; color: #1e293b; font-size: 0.86rem;">
                          ${last.periodStart} ${isEn ? 'to' : 'થી'} ${last.periodEnd}
                        </span>
                      ` : `
                        <span style="color: #94a3b8; font-size: 0.85rem;">-</span>
                      `}
                    </td>
                    <td style="text-align: right;">
                      ${last ? `
                        <span style="font-weight: 900; color: #15803d; font-size: 0.98rem;">₹ ${Number(last.totalAmount).toLocaleString('en-IN')}</span>
                      ` : `
                        <span style="color: #94a3b8; font-weight: 700;">-</span>
                      `}
                    </td>
                    <td style="text-align: center;">
                      ${bakiDays > 0 ? `
                        <span style="background: #fff7ed; color: #c2410c; border: 1.5px solid #fed7aa; font-size: 0.76rem; font-weight: 800; padding: 3px 8px; border-radius: 12px; display: inline-block; white-space: nowrap;">
                          ⚠️ ${bakiDays} ${isEn ? 'Days Due' : 'દિન બાકી'} (₹${bakiAmount.toLocaleString('en-IN')})
                        </span>
                      ` : `
                        <span style="background: #ecfdf5; color: #065f46; border: 1.5px solid #a7f3d0; font-size: 0.76rem; font-weight: 800; padding: 3px 8px; border-radius: 12px; display: inline-block; white-space: nowrap;">
                          ${isEn ? '✅ Paid' : '✅ ચૂકતે'}
                        </span>
                      `}
                    </td>
                    <td style="text-align: center;">
                      <div style="display: flex; align-items: center; justify-content: center; gap: 5px;">
                        <button type="button" class="btn-primary" onclick="App.openBhaktDepositModal('${b.id}')"
                          style="background: linear-gradient(135deg, #15803d, #16a34a); border: none; font-weight: 800; font-size: 0.78rem; padding: 5px 11px; border-radius: 6px; cursor: pointer; white-space: nowrap;" title="${isEn ? 'Deposit' : 'જમા કરો'}">
                          <span>${isEn ? '💵 Deposit' : '💵 જમા'}</span>
                        </button>
                        <button type="button" class="btn-secondary" onclick="App.openBhaktPassbook('${b.id}')"
                          style="font-weight: 800; font-size: 0.78rem; padding: 5px 9px; border-radius: 6px; cursor: pointer; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; white-space: nowrap;" title="${isEn ? 'Passbook' : 'પાસબુક'}">
                          <span>📜</span>
                        </button>
                        ${this.bhaktAdminMode ? `
                          <button type="button" class="btn-icon" onclick="App.editBhaktProfile('${b.id}')"
                            style="padding: 4px 7px; font-size: 0.8rem; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; cursor: pointer;" title="${isEn ? 'Edit' : 'વિગત સુધારો'}">
                            ✏️
                          </button>
                          <button type="button" class="btn-icon" onclick="App.deleteBhakt('${b.id}')"
                            style="padding: 4px 7px; font-size: 0.8rem; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; cursor: pointer; color: #dc2626;" title="${isEn ? 'Delete' : 'કાઢી નાખો'}">
                            🗑️
                          </button>
                        ` : ''}
                      </div>
                    </td>
                  </tr>
                `;
    }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  filterBhaktsList(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) {
      this.renderBhaktsList(this.bhaktsList);
      return;
    }
    const filtered = (this.bhaktsList || []).filter(b => {
      const name = (b.name || '').toLowerCase();
      const phone = (b.phone || '').toLowerCase();
      const donorId = (b.donorId || '').toLowerCase();
      return name.includes(q) || phone.includes(q) || donorId.includes(q);
    });
    this.renderBhaktsList(filtered);
  },

  openAddBhaktModal() {
    if (!this.bhaktAdminMode) {
      this.enableBhaktAdminMode();
      return;
    }

    document.getElementById('bhakt-form-id').value = '';

    // Auto-suggest next numerical donor ID if available
    let nextNum = 101;
    (this.bhaktsList || []).forEach(b => {
      const n = parseInt(b.donorId, 10);
      if (!isNaN(n) && n >= nextNum) nextNum = n + 1;
    });
    const donorIdInp = document.getElementById('bhakt-form-donor-id');
    if (donorIdInp) donorIdInp.value = nextNum;

    document.getElementById('bhakt-form-name').value = '';
    document.getElementById('bhakt-form-rate').value = '';
    document.getElementById('bhakt-form-phone').value = '';

    // Default payType radio
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const payRadio = document.querySelector('input[name="bhakt_form_pay_type"][value="date_wise"]');
    if (payRadio) payRadio.checked = true;

    document.getElementById('modal-bhakt-form-title').textContent = isEn ? '➕ Add Devotee' : '➕ નવો હરિભક્ત ઉમેરો';
    this.openModal('modal-bhakt-form');
    setTimeout(() => {
      const nameInp = document.getElementById('bhakt-form-name');
      if (nameInp) nameInp.focus();
    }, 150);
  },

  editBhaktProfile(id) {
    if (!this.bhaktAdminMode) {
      this.enableBhaktAdminMode();
      return;
    }

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const bhakt = (this.bhaktsList || []).find(b => b.id === id);
    if (!bhakt) return;
    document.getElementById('bhakt-form-id').value = bhakt.id;
    const donorIdInp = document.getElementById('bhakt-form-donor-id');
    if (donorIdInp) donorIdInp.value = bhakt.donorId || '';
    document.getElementById('bhakt-form-name').value = bhakt.name;
    document.getElementById('bhakt-form-rate').value = bhakt.dailyAmount;
    document.getElementById('bhakt-form-phone').value = bhakt.phone || '';

    const pType = bhakt.payType || 'date_wise';
    const payRadio = document.querySelector(`input[name="bhakt_form_pay_type"][value="${pType}"]`);
    if (payRadio) payRadio.checked = true;

    document.getElementById('modal-bhakt-form-title').textContent = isEn
      ? `✏️ Edit ${bhakt.name}`
      : `✏️ ${bhakt.name} - વિગત સુધારો`;
    this.openModal('modal-bhakt-form');
  },

  async saveBhaktProfile(e) {
    e.preventDefault();
    if (!this.bhaktAdminMode && !this.adminAuthenticated) {
      this.enableBhaktAdminMode();
      return;
    }

    const id = document.getElementById('bhakt-form-id').value;
    const donorId = (document.getElementById('bhakt-form-donor-id')?.value || '').trim();
    const name = document.getElementById('bhakt-form-name').value.trim();
    const dailyAmount = Number(document.getElementById('bhakt-form-rate').value);
    const phone = document.getElementById('bhakt-form-phone').value.trim();
    const payType = document.querySelector('input[name="bhakt_form_pay_type"]:checked')?.value || 'date_wise';

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    if (!name) {
      this.showToast(isEn ? 'Please enter devotee name' : 'કૃપા કરીને ભક્તનું નામ લખો', 'error');
      return;
    }
    if (isNaN(dailyAmount) || dailyAmount <= 0) {
      this.showToast(isEn ? 'Please enter valid daily rate' : 'કૃપા કરીને રોજના નક્કી કરેલા રૂપિયા લખો', 'error');
      return;
    }

    try {
      let res;
      if (id) {
        res = await fetch(`/api/bhakts/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...this.getAdminAuthHeaders() },
          body: JSON.stringify({ name, dailyAmount, phone, donorId, payType })
        });
      } else {
        res = await fetch('/api/bhakts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.getAdminAuthHeaders() },
          body: JSON.stringify({ name, dailyAmount, phone, donorId, payType })
        });
      }
      const data = await res.json();
      if (data && data.success) {
        this.closeModal('modal-bhakt-form');
        this.showToast(isEn ? `✅ Saved ${name} (${donorId ? 'ID: ' + donorId : ''}) profile!` : `✅ ${name} (${donorId ? 'ID: ' + donorId : ''}) ની વિગત સાચવી લેવાઈ!`, 'success');
        await this.loadBhakts();
      } else {
        this.showToast(data.error || (isEn ? 'Error saving devotee' : 'સેવ કરવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error saving bhakt:', err);
      this.showToast(isEn ? 'Server error' : 'સર્વર એરર', 'error');
    }
  },

  async deleteBhakt(id) {
    if (!this.bhaktAdminMode) {
      this.enableBhaktAdminMode();
      return;
    }

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const bhakt = (this.bhaktsList || []).find(b => b.id === id);
    const name = bhakt ? bhakt.name : (isEn ? 'this devotee' : 'આ ભક્ત');
    if (!confirm(isEn ? `Are you sure you want to delete ${name}?` : `શું તમે ખરેખર ${name} ને કાઢી નાખવા માંગો છો?`)) return;

    try {
      const res = await fetch(`/api/bhakts/${id}`, {
        method: 'DELETE',
        headers: this.getAdminAuthHeaders()
      });
      const data = await res.json();
      if (data && data.success) {
        this.showToast(isEn ? `🗑️ ${name} deleted.` : `🗑️ ${name} કાઢી નાખવામાં આવ્યા.`, 'info');
        await this.loadBhakts();
      }
    } catch (e) {
      this.showToast(isEn ? 'Error deleting devotee' : 'કાઢવામાં ભૂલ આવી', 'error');
    }
  },

  formatDateToYMD(dateInput) {
    if (!dateInput) return '';
    const d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  formatDisplayDate(d) {
    if (!d) return '';
    const parts = String(d).split('T')[0].split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return String(d);
  },

  openBhaktDepositModal(id) {
    const bhakt = (this.bhaktsList || []).find(b => b.id === id);
    if (!bhakt) return;
    this.activeBhaktForDeposit = bhakt;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    document.getElementById('bhakt-deposit-bhakt-id').value = bhakt.id;
    const isMonthWise = (bhakt.payType === 'month_wise');
    document.getElementById('bhakt-deposit-target-name').textContent = isEn
      ? `${bhakt.name} ${bhakt.donorId ? `(ID: ${bhakt.donorId})` : ''} • ₹${bhakt.dailyAmount}/day`
      : `${bhakt.name} ${bhakt.donorId ? `(ID: ${bhakt.donorId})` : ''} • ₹${bhakt.dailyAmount}/દિન`;
    document.getElementById('bhakt-dep-rate').value = bhakt.dailyAmount;
    document.getElementById('bhakt-dep-remarks').value = '';

    const receiptDate = this.currentDate || this.getTodayDateStr();
    const dateInp = document.getElementById('bhakt-dep-date');
    if (dateInp) dateInp.value = receiptDate;

    // Smart period calculation: Next pending date
    let startDate = receiptDate;
    if (bhakt.lastDeposit && bhakt.lastDeposit.periodEnd) {
      const parts = bhakt.lastDeposit.periodEnd.split('-').map(Number);
      const nextDay = new Date(parts[0], parts[1] - 1, parts[2] + 1);
      startDate = this.formatDateToYMD(nextDay);
    } else if (bhakt.createdAt) {
      startDate = bhakt.createdAt.split('T')[0];
    }

    this.activeBhaktDepositStartDate = startDate;
    document.getElementById('bhakt-dep-period-start').value = startDate;

    const fromDateInp = document.getElementById('bhakt-dep-from-date-input');
    if (fromDateInp) fromDateInp.value = startDate;

    const toDateInp = document.getElementById('bhakt-dep-to-date-input');
    if (toDateInp) toDateInp.value = '';

    const daysInp = document.getElementById('bhakt-dep-days-input');
    if (daysInp) daysInp.value = '';

    const simpleInp = document.getElementById('bhakt-dep-simple-amount-input');
    if (simpleInp) simpleInp.value = '';

    const simpleResultBox = document.getElementById('bhakt-dep-simple-result-box');
    if (simpleResultBox) {
      simpleResultBox.style.display = 'none';
      simpleResultBox.innerHTML = '';
    }

    // Populate upcoming months for Month-wise mode
    this.populateBhaktMonthOptions(startDate);

    // Render payment modes (Cash checked by default + configured Banks)
    this.renderBhaktPaymentModes();

    // Set initial mode based on bhakt's registered payType
    const initMode = isMonthWise ? 'month_wise' : 'date_wise';
    this.setBhaktDepositMode(initMode);

    this.openModal('modal-bhakt-deposit');

    setTimeout(() => {
      if (initMode === 'date_wise' && simpleInp) {
        simpleInp.focus();
      }
    }, 150);
  },

  setBhaktDepositMode(mode) {
    this.bhaktDepositMode = mode;
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const panelMonth = document.getElementById('bhakt-dep-panel-month');
    const panelDate = document.getElementById('bhakt-dep-panel-date');
    const badge = document.getElementById('bhakt-dep-mode-badge');

    if (mode === 'month_wise') {
      if (panelMonth) panelMonth.style.display = 'block';
      if (panelDate) panelDate.style.display = 'none';

      if (badge) {
        badge.textContent = isEn ? '📅 Monthly (Month-wise)' : '📅 માસિક (Month-wise)';
        badge.style.background = '#e0e7ff';
        badge.style.color = '#3730a3';
        badge.style.border = '1.5px solid #c7d2fe';
      }

      // Trigger calculation for the currently selected month
      const select = document.getElementById('bhakt-dep-single-month-select');
      if (select && select.value) {
        this.onBhaktSingleMonthChange(select.value);
      }
    } else {
      if (panelDate) panelDate.style.display = 'block';
      if (panelMonth) panelMonth.style.display = 'none';

      if (badge) {
        badge.textContent = isEn ? '📆 Date-to-Date' : '📆 તારીખવાર (Date-to-Date)';
        badge.style.background = '#ecfdf5';
        badge.style.color = '#065f46';
        badge.style.border = '1.5px solid #a7f3d0';
      }

      // Restore From Date input to activeBhaktDepositStartDate if available
      const fromDateInp = document.getElementById('bhakt-dep-from-date-input');
      const startVal = (fromDateInp && fromDateInp.value) ? fromDateInp.value : (this.activeBhaktDepositStartDate || this.getTodayDateStr());
      document.getElementById('bhakt-dep-period-start').value = startVal;
      if (fromDateInp) fromDateInp.value = startVal;

      const simpleInp = document.getElementById('bhakt-dep-simple-amount-input');
      if (simpleInp) {
        simpleInp.focus();
        if (simpleInp.value) {
          this.onBhaktSimpleAmountInput(simpleInp.value);
        } else {
          document.getElementById('bhakt-dep-btn-submit').innerHTML = `<span>✅</span> <span>${isEn ? 'Deposit & Receipt' : 'જમા કરો & રસીદ'}</span>`;
        }
      }
    }
  },

  populateBhaktMonthOptions(startDateStr) {
    const select = document.getElementById('bhakt-dep-single-month-select');
    if (!select || !startDateStr) return;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const gujMonths = ['જાન્યુઆરી', 'ફેબ્રુઆરી', 'માર્ચ', 'એપ્રિલ', 'મે', 'જૂન', 'જુલાઈ', 'ઓગસ્ટ', 'સપ્ટેમ્બર', 'ઓક્ટોબર', 'નવેમ્બર', 'ડિસેમ્બર'];
    const enMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const months = isEn ? enMonths : gujMonths;
    const [sY, sM, sD] = startDateStr.split('-').map(Number);
    const rate = Number(document.getElementById('bhakt-dep-rate')?.value) || 0;

    let html = '';
    for (let i = 0; i < 3; i++) {
      const targetDate = new Date(sY, (sM - 1) + i, 1);
      const yr = targetDate.getFullYear();
      const mIdx = targetDate.getMonth();
      const mName = months[mIdx];
      const mNumStr = String(mIdx + 1).padStart(2, '0');

      const lastDayObj = new Date(yr, mIdx + 1, 0);
      const lastDay = lastDayObj.getDate();

      let daysInMonth = lastDay;
      let isPartial = false;
      if (i === 0 && sD > 1) {
        daysInMonth = (lastDay - sD + 1);
        isPartial = true;
      }
      const estTotal = daysInMonth * rate;

      const optVal = `${yr}-${mNumStr}`;
      const isFirst = (i === 0);
      html += `<option value="${optVal}" ${isFirst ? 'selected' : ''}>
        🗓️ ${mName} ${yr}${isPartial ? ` (${daysInMonth} ${isEn ? 'days' : 'દિવસ'})` : ''} ➔ ₹ ${estTotal.toLocaleString('en-IN')}
      </option>`;
    }
    select.innerHTML = html;

    // Only auto-trigger month change calculation if month_wise tab is currently active
    if (this.bhaktDepositMode === 'month_wise' && select.value) {
      this.onBhaktSingleMonthChange(select.value);
    }
  },

  onBhaktSingleMonthChange(val) {
    if (!val) return;
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const [sY, sM] = val.split('-').map(Number);
    const rate = Number(document.getElementById('bhakt-dep-rate').value) || 0;
    const baseStart = this.activeBhaktDepositStartDate || `${sY}-${String(sM).padStart(2, '0')}-01`;
    const [baseY, baseM, baseD] = baseStart.split('-').map(Number);

    let startStr = `${sY}-${String(sM).padStart(2, '0')}-01`;
    if (sY === baseY && sM === baseM && baseD > 1) {
      startStr = baseStart;
    }

    const lastDayObj = new Date(sY, sM, 0);
    const endStr = this.formatDateToYMD(lastDayObj);

    const [stY, stM, stD] = startStr.split('-').map(Number);
    const stDate = new Date(stY, stM - 1, stD);
    const days = Math.round((lastDayObj - stDate) / (1000 * 60 * 60 * 24)) + 1;
    const total = days * rate;

    // Set hidden inputs
    document.getElementById('bhakt-dep-period-start').value = startStr;
    document.getElementById('bhakt-dep-period-end').value = endStr;
    document.getElementById('bhakt-dep-days').value = days;
    document.getElementById('bhakt-dep-total').value = total;

    // Display updates
    const amtEl = document.getElementById('bhakt-dep-month-amount-display');
    if (amtEl) amtEl.textContent = `₹ ${total.toLocaleString('en-IN')}`;

    const detailEl = document.getElementById('bhakt-dep-month-detail-display');
    if (detailEl) {
      detailEl.textContent = isEn
        ? `🗓️ ${this.formatDisplayDate(startStr)} to ${this.formatDisplayDate(endStr)} (${days} days)`
        : `🗓️ ${this.formatDisplayDate(startStr)} થી ${this.formatDisplayDate(endStr)} (${days} દિવસ)`;
    }

    const submitBtn = document.getElementById('bhakt-dep-btn-submit');
    if (submitBtn) {
      submitBtn.innerHTML = `<span>✅</span> <span>${isEn ? `Deposit (₹ ${total.toLocaleString('en-IN')})` : `જમા કરો (₹ ${total.toLocaleString('en-IN')})`}</span>`;
    }
  },

  onBhaktFromDateChange(val) {
    if (!val) return;
    document.getElementById('bhakt-dep-period-start').value = val;

    const daysVal = Number(document.getElementById('bhakt-dep-days-input')?.value);
    const amtVal = Number(document.getElementById('bhakt-dep-simple-amount-input')?.value);
    const toDateVal = document.getElementById('bhakt-dep-to-date-input')?.value;

    if (daysVal > 0) {
      this.onBhaktDaysInput(daysVal);
    } else if (amtVal > 0) {
      this.onBhaktSimpleAmountInput(amtVal);
    } else if (toDateVal && toDateVal >= val) {
      this.onBhaktToDateChange(toDateVal);
    }
  },

  onBhaktToDateChange(val) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    if (!val) return;
    const fromStr = document.getElementById('bhakt-dep-from-date-input')?.value || this.getTodayDateStr();

    if (val < fromStr) {
      this.showToast(isEn ? 'End date cannot be earlier than start date' : 'અંતિમ તારીખ શરૂઆતની તારીખ કરતાં પહેલાંની ન હોઈ શકે', 'warning');
      document.getElementById('bhakt-dep-to-date-input').value = fromStr;
      return;
    }

    const [fY, fM, fD] = fromStr.split('-').map(Number);
    const [tY, tM, tD] = val.split('-').map(Number);
    const fDate = new Date(fY, fM - 1, fD);
    const tDate = new Date(tY, tM - 1, tD);
    const days = Math.round((tDate - fDate) / (1000 * 60 * 60 * 24)) + 1;
    const rate = Number(document.getElementById('bhakt-dep-rate').value) || 0;
    const total = days * rate;

    const daysInp = document.getElementById('bhakt-dep-days-input');
    if (daysInp) daysInp.value = days;

    const amtInp = document.getElementById('bhakt-dep-simple-amount-input');
    if (amtInp) amtInp.value = total;

    document.getElementById('bhakt-dep-period-start').value = fromStr;
    document.getElementById('bhakt-dep-period-end').value = val;
    document.getElementById('bhakt-dep-days').value = days;
    document.getElementById('bhakt-dep-total').value = total;

    this.updateBhaktDateResultCard(fromStr, val, days, total, 0);
  },

  onBhaktDaysInput(val) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const days = Math.floor(Number(val)) || 0;
    const rate = Number(document.getElementById('bhakt-dep-rate').value) || 0;
    const fromStr = document.getElementById('bhakt-dep-from-date-input')?.value || this.getTodayDateStr();

    if (days < 1) {
      document.getElementById('bhakt-dep-to-date-input').value = '';
      document.getElementById('bhakt-dep-simple-amount-input').value = '';
      document.getElementById('bhakt-dep-days').value = 0;
      document.getElementById('bhakt-dep-total').value = 0;
      const resultBox = document.getElementById('bhakt-dep-simple-result-box');
      if (resultBox) resultBox.style.display = 'none';
      const submitBtn = document.getElementById('bhakt-dep-btn-submit');
      if (submitBtn) submitBtn.innerHTML = `<span>✅</span> <span>${isEn ? 'Deposit & Receipt' : 'જમા કરો & રસીદ'}</span>`;
      return;
    }

    const [fY, fM, fD] = fromStr.split('-').map(Number);
    const endObj = new Date(fY, fM - 1, fD + (days - 1));
    const endStr = this.formatDateToYMD(endObj);
    const total = days * rate;

    const toDateInp = document.getElementById('bhakt-dep-to-date-input');
    if (toDateInp) toDateInp.value = endStr;

    const amtInp = document.getElementById('bhakt-dep-simple-amount-input');
    if (amtInp) amtInp.value = total;

    document.getElementById('bhakt-dep-period-start').value = fromStr;
    document.getElementById('bhakt-dep-period-end').value = endStr;
    document.getElementById('bhakt-dep-days').value = days;
    document.getElementById('bhakt-dep-total').value = total;

    this.updateBhaktDateResultCard(fromStr, endStr, days, total, 0);
  },

  onBhaktSimpleAmountInput(val) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const amt = Number(val) || 0;
    const rate = Number(document.getElementById('bhakt-dep-rate').value) || 0;
    const fromStr = document.getElementById('bhakt-dep-from-date-input')?.value || this.getTodayDateStr();
    const resultBox = document.getElementById('bhakt-dep-simple-result-box');
    const submitBtn = document.getElementById('bhakt-dep-btn-submit');

    if (amt <= 0 || rate <= 0) {
      if (resultBox) {
        resultBox.style.display = 'none';
        resultBox.innerHTML = '';
      }
      document.getElementById('bhakt-dep-to-date-input').value = '';
      document.getElementById('bhakt-dep-days-input').value = '';
      document.getElementById('bhakt-dep-days').value = 0;
      document.getElementById('bhakt-dep-total').value = 0;
      if (submitBtn) submitBtn.innerHTML = `<span>✅</span> <span>${isEn ? 'Deposit & Receipt' : 'જમા કરો & રસીદ'}</span>`;
      return;
    }

    const days = Math.floor(amt / rate);
    const remainder = amt % rate;

    if (days < 1) {
      if (resultBox) {
        resultBox.style.display = 'block';
        resultBox.innerHTML = `<div style="color: #dc2626; font-weight: 800; font-size: 0.85rem; text-align: center;">${isEn ? `⚠️ Amount is less than daily rate (₹ ${rate})` : `⚠️ રકમ રોજના દર (₹ ${rate}) કરતાં ઓછી છે`}</div>`;
      }
      document.getElementById('bhakt-dep-to-date-input').value = '';
      document.getElementById('bhakt-dep-days-input').value = 0;
      document.getElementById('bhakt-dep-days').value = 0;
      document.getElementById('bhakt-dep-total').value = 0;
      if (submitBtn) submitBtn.innerHTML = `<span>✅</span> <span>${isEn ? 'Deposit & Receipt' : 'જમા કરો & રસીદ'}</span>`;
      return;
    }

    const [fY, fM, fD] = fromStr.split('-').map(Number);
    const endObj = new Date(fY, fM - 1, fD + (days - 1));
    const endStr = this.formatDateToYMD(endObj);

    const toDateInp = document.getElementById('bhakt-dep-to-date-input');
    if (toDateInp) toDateInp.value = endStr;

    const daysInp = document.getElementById('bhakt-dep-days-input');
    if (daysInp) daysInp.value = days;

    document.getElementById('bhakt-dep-period-start').value = fromStr;
    document.getElementById('bhakt-dep-period-end').value = endStr;
    document.getElementById('bhakt-dep-days').value = days;
    document.getElementById('bhakt-dep-total').value = amt;

    this.updateBhaktDateResultCard(fromStr, endStr, days, amt, remainder);
  },

  updateBhaktDateResultCard(fromStr, endStr, days, total, remainder = 0) {
    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const resultBox = document.getElementById('bhakt-dep-simple-result-box');
    const submitBtn = document.getElementById('bhakt-dep-btn-submit');
    const fDisp = this.formatDisplayDate(fromStr);
    const eDisp = this.formatDisplayDate(endStr);

    if (resultBox) {
      resultBox.style.display = 'block';
      resultBox.innerHTML = `
        <div style="font-size: 0.95rem; font-weight: 900; color: #15803d; text-align: center;">
          🗓️ ${fDisp} ${isEn ? 'to' : 'થી'} ${eDisp}
        </div>
        <div style="font-size: 0.86rem; font-weight: 800; color: #166534; margin-top: 3px; text-align: center;">
          ✅ ${days} ${isEn ? 'Days' : 'દિવસ'} • ${isEn ? 'Total:' : 'કુલ:'} <strong>₹ ${total.toLocaleString('en-IN')}</strong>${remainder > 0 ? `<span style="color: #b45309; font-size: 0.8rem;"> (+ ₹${remainder} ${isEn ? 'advance' : 'વધારો'})</span>` : ''}
        </div>
      `;
    }
    if (submitBtn) {
      submitBtn.innerHTML = `<span>✅</span> <span>${isEn ? `Deposit (₹ ${total.toLocaleString('en-IN')})` : `જમા કરો (₹ ${total.toLocaleString('en-IN')})`}</span>`;
    }
  },

  renderBhaktPaymentModes() {
    const container = document.getElementById('bhakt-deposit-payment-modes');
    if (!container) return;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const banks = (this.fixedBanks && this.fixedBanks.length > 0) ? this.fixedBanks : ['IOB', 'BOB', 'SBI'];

    let html = `
      <label style="display: inline-flex; align-items: center; gap: 6px; background: #ecfdf5; border: 1.5px solid #10b981; border-radius: 6px; padding: 5px 10px; cursor: pointer; font-weight: 800; color: #047857; font-size: 0.82rem;">
        <input type="radio" name="bhakt_payment_mode" value="cash" checked style="accent-color: #059669; transform: scale(1.1);">
        <span>${isEn ? '💵 Cash' : '💵 રોકડ'}</span>
      </label>
    `;

    banks.forEach(b => {
      html += `
        <label style="display: inline-flex; align-items: center; gap: 6px; background: #ffffff; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 5px 10px; cursor: pointer; font-weight: 800; color: #1e3a8a; font-size: 0.82rem;">
          <input type="radio" name="bhakt_payment_mode" value="${b}" style="accent-color: #2563eb; transform: scale(1.1);">
          <span>🏦 ${b}</span>
        </label>
      `;
    });

    container.innerHTML = html;
  },

  async submitBhaktDeposit(e) {
    e.preventDefault();
    const bhaktId = document.getElementById('bhakt-deposit-bhakt-id').value;
    const date = document.getElementById('bhakt-dep-date').value;
    const periodStart = document.getElementById('bhakt-dep-period-start').value;
    const periodEnd = document.getElementById('bhakt-dep-period-end').value;
    const days = Number(document.getElementById('bhakt-dep-days').value);
    const dailyAmount = Number(document.getElementById('bhakt-dep-rate').value);
    const totalAmount = Number(document.getElementById('bhakt-dep-total').value);
    const remarks = document.getElementById('bhakt-dep-remarks').value.trim();

    const modeInput = document.querySelector('input[name="bhakt_payment_mode"]:checked');
    const paymentMode = modeInput ? modeInput.value : 'cash';

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    if (!bhaktId || days <= 0 || totalAmount <= 0) {
      this.showToast(isEn ? 'Please fill valid deposit details' : 'કૃપા કરીને સાચી વિગત ભરો', 'error');
      return;
    }

    try {
      const res = await fetch(`/api/bhakts/${bhaktId}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          periodStart,
          periodEnd,
          days,
          dailyAmount,
          totalAmount,
          paymentMode,
          settlementMode: this.bhaktDepositMode || 'date_wise',
          remarks
        })
      });

      const data = await res.json();
      if (data && data.success) {
        this.closeModal('modal-bhakt-deposit');
        this.showToast(`✅ ${data.message}`, 'success');
        await this.loadBhakts();
        this.showBhaktReceipt(data.deposit);
      } else {
        this.showToast(data.error || (isEn ? 'Error making deposit' : 'જમા કરવામાં ભૂલ આવી'), 'error');
      }
    } catch (err) {
      console.error('Error submitting bhakt deposit:', err);
      this.showToast(isEn ? 'Server error' : 'સર્વર એરર', 'error');
    }
  },

  async openBhaktPassbook(id) {
    const bhakt = (this.bhaktsList || []).find(b => b.id === id);
    if (!bhakt) return;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    document.getElementById('bhakt-passbook-title').textContent = isEn
      ? `📜 ${bhakt.name} - Passbook`
      : `📜 ${bhakt.name} - સેવા પાસબુક`;
    document.getElementById('bhakt-passbook-subtitle').textContent = isEn
      ? `Daily Rate: ₹${bhakt.dailyAmount} | Phone: ${bhakt.phone || '-'}`
      : `રોજનો દર: ₹${bhakt.dailyAmount} | ફોન: ${bhakt.phone || '-'}`;

    const container = document.getElementById('bhakt-passbook-table-container');
    container.innerHTML = `<div style="text-align: center; padding: 20px; color: #64748b;">${isEn ? '⏳ Loading passbook...' : '⏳ પાસબુક લોડ થઈ રહી છે...'}</div>`;

    this.openModal('modal-bhakt-passbook');

    try {
      const res = await fetch(`/api/bhakts/${id}/deposits`);
      const data = await res.json();
      const deposits = data.deposits || [];

      if (deposits.length === 0) {
        container.innerHTML = `
          <div style="text-align: center; padding: 30px; color: #64748b; font-weight: 700;">
            ${isEn ? 'No Deposit Records Found' : 'કોઈ જમા એન્ટ્રી નથી'}
          </div>
        `;
        return;
      }

      container.innerHTML = `
        <table class="table-hisab" style="font-size: 0.88rem; width: 100%;">
          <thead>
            <tr>
              <th style="width: 80px; text-align: center;">${isEn ? 'Receipt #' : 'રસીદ નં.'}</th>
              <th style="width: 110px;">${isEn ? 'Date' : 'તારીખ'}</th>
              <th>${isEn ? 'Period' : 'મુદત (ગાળો)'}</th>
              <th style="text-align: center; width: 85px;">${isEn ? 'Days' : 'દિવસ'}</th>
              <th style="text-align: right; width: 120px;">${isEn ? 'Amount (₹)' : 'રકમ (₹)'}</th>
              <th style="width: 80px; text-align: center;">${isEn ? 'Receipt' : 'રસીદ'}</th>
            </tr>
          </thead>
          <tbody>
            ${deposits.map(d => `
              <tr>
                <td style="font-weight: 800; color: #1e3a8a; text-align: center;">#${d.receiptNo}</td>
                <td>${d.date}</td>
                <td style="font-weight: 600;">
                  ${d.periodStart} ${isEn ? 'to' : 'થી'} ${d.periodEnd}
                </td>
                <td style="text-align: center; font-weight: 800; color: #047857;">${d.days} ${isEn ? 'Days' : 'દિન'}</td>
                <td style="text-align: right; font-weight: 900; color: #15803d; font-size: 0.95rem;">₹ ${Number(d.totalAmount).toLocaleString('en-IN')}</td>
                <td style="text-align: center;">
                  <button type="button" class="btn-icon" style="padding: 3px 8px; font-size: 0.82rem; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px;"
                    onclick='App.showBhaktReceipt(${JSON.stringify(d).replace(/'/g, "&apos;")})' title="${isEn ? 'View Receipt' : 'રસીદ જુઓ'}">
                    🧾
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (e) {
      container.innerHTML = `<div style="color: red; padding: 20px;">${isEn ? 'Error loading passbook.' : 'પાસબુક લોડ કરવામાં ક્ષતિ આવી.'}</div>`;
    }
  },

  showBhaktReceipt(deposit) {
    this.activeBhaktReceiptData = deposit;
    const container = document.getElementById('bhakt-printable-receipt-slip');
    if (!container) return;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const orgName = this.settings?.orgName || 'Gadisthan Jetpur';
    const orgSub = this.settings?.orgSubtitle || (isEn ? 'Shree Swaminarayan Temple' : 'શ્રી સ્વામિનારાયણ મંદિર');

    container.innerHTML = `
      <div style="text-align: center; border-bottom: 2px dashed #059669; padding-bottom: 10px; margin-bottom: 12px;">
        <div style="font-size: 1.25rem; font-weight: 900; color: #064e3b;">${orgSub}</div>
        <div style="font-size: 1.05rem; font-weight: 800; color: #1e3a8a;">${orgName}</div>
        <div style="display: inline-block; background: #059669; color: white; padding: 2px 14px; border-radius: 20px; font-size: 0.82rem; font-weight: 800; margin-top: 6px;">
          ${isEn ? 'Nitya Hari Bhakto Donation Receipt' : 'નિત્ય હરિભક્તો સેવા પહોંચ'}
        </div>
      </div>

      <div style="display: flex; justify-content: space-between; font-size: 0.86rem; margin-bottom: 8px;">
        <div><b>${isEn ? 'Receipt #:' : 'પહોંચ નં.:'}</b> #${deposit.receiptNo}</div>
        <div><b>${isEn ? 'Date:' : 'તારીખ:'}</b> ${deposit.date}</div>
      </div>

      <div style="background: white; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; font-size: 0.92rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div><b>${isEn ? 'Member Name:' : 'હરિભક્ત:'}</b> <span style="font-size: 1.05rem; font-weight: 900; color: #0f172a;">${deposit.bhaktName}</span></div>
          ${deposit.donorId ? `<span style="background: #e0f2fe; color: #0284c7; border: 1px solid #bae6fd; font-weight: 800; font-size: 0.78rem; padding: 2px 8px; border-radius: 6px;">${isEn ? 'Donor ID:' : 'દાતા ID:'} ${deposit.donorId}</span>` : ''}
        </div>
        <div style="margin-bottom: 4px;"><b>${isEn ? 'Period:' : 'જમા મુદત:'}</b> <b>${deposit.periodStart} ${isEn ? 'to' : 'થી'} ${deposit.periodEnd}</b> (${deposit.days} ${isEn ? 'Days' : 'દિવસ'})</div>
        ${deposit.remarks ? `<div style="margin-top: 6px; color: #64748b; font-size: 0.84rem;"><b>${isEn ? 'Remarks:' : 'નોંધ:'}</b> ${deposit.remarks}</div>` : ''}
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; background: #ecfdf5; border: 2px solid #059669; border-radius: 8px; padding: 10px 14px; margin-bottom: 14px;">
        <span style="font-size: 1rem; font-weight: 800; color: #065f46;">${isEn ? 'Total Received:' : 'કુલ જમા રકમ:'}</span>
        <span style="font-size: 1.45rem; font-weight: 900; color: #047857;">₹ ${Number(deposit.totalAmount).toLocaleString('en-IN')}</span>
      </div>

      <div style="text-align: center; padding-top: 8px; font-size: 0.9rem; font-weight: 800; color: #059669;">
        ${isEn ? '🙏 Jay Swaminarayan' : '🙏 જય સ્વામિનારાયણ'}
      </div>
    `;

    this.openModal('modal-bhakt-receipt');
  },

  printBhaktReceiptSlip() {
    const slip = document.getElementById('bhakt-printable-receipt-slip');
    if (!slip) return;
    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    const printWin = window.open('', '', 'width=600,height=700');
    printWin.document.write(`
      <html>
        <head>
          <title>${isEn ? 'Donation Receipt Print' : 'પહોંચ પ્રિન્ટ'}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; margin: 0; }
          </style>
        </head>
        <body>
          \${slip.outerHTML}
          <script>
            window.onload = function() { window.print(); window.close(); }
          </script>
        </body>
      </html>
    `);
    printWin.document.close();
  },

  shareBhaktReceiptWhatsApp() {
    const d = this.activeBhaktReceiptData;
    if (!d) return;

    const isEn = (window.i18n && window.i18n.currentLang === 'en');
    const orgName = this.settings?.orgName || 'Gadisthan Jetpur';
    const text = isEn ? (
      `*${orgName} - Nitya Hari Bhakto Receipt*%0A` +
      `--------------------------------%0A` +
      `*Receipt #:* #${d.receiptNo}%0A` +
      `*Date:* ${d.date}%0A` +
      `*Member Name:* ${d.bhaktName}%0A` +
      `*Period:* ${d.periodStart} to ${d.periodEnd} (${d.days} Days)%0A` +
      `*Total Received:* ₹${Number(d.totalAmount).toLocaleString('en-IN')}%0A` +
      `--------------------------------%0A` +
      `🙏 Jay Swaminarayan`
    ) : (
      `*${orgName} - નિત્ય હરિભક્તો સેવા પહોંચ*%0A` +
      `--------------------------------%0A` +
      `*પહોંચ નં.:* #${d.receiptNo}%0A` +
      `*તારીખ:* ${d.date}%0A` +
      `*હરિભક્ત:* ${d.bhaktName}%0A` +
      `*મુદત:* ${d.periodStart} થી ${d.periodEnd} (${d.days} દિવસ)%0A` +
      `*કુલ જમા રકમ:* ₹${Number(d.totalAmount).toLocaleString('en-IN')}%0A` +
      `--------------------------------%0A` +
      `🙏 જય સ્વામિનારાયણ`
    );

    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  },

  // =========================================================================
  // AI REPORT ASSISTANT (STRICT READ-ONLY Q&A, ANALYTICS & PDF EXPORT)
  // =========================================================================
  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  // =========================================================================
  // DUES REGISTER (લેણાં અને દેવાં / બાકી હિસાબ) MODULE
  // =========================================================================
  currentDuesTab: 'all', // 'all' | 'receivable' | 'payable'
  duesList: [],
  duesSummary: null,

  async openDuesModal() {
    this.openModal('modal-dues');
    const dateInp = document.getElementById('due-input-date');
    if (dateInp) dateInp.value = this.currentDate || new Date().toISOString().split('T')[0];
    const searchInp = document.getElementById('due-search-input');
    if (searchInp) searchInp.value = '';
    const statusSel = document.getElementById('due-filter-status');
    if (statusSel) statusSel.value = 'pending';

    // Attach Gujarati typing to inputs if library available
    if (window.GujaratiTyping) {
      ['due-input-name', 'due-input-desc', 'due-search-input', 'due-settle-input-note'].forEach(id => {
        const el = document.getElementById(id);
        if (el) window.GujaratiTyping.attach(el);
      });
    }

    // Default to 'all' so entries are never hidden
    await this.loadDues();
    this.switchDuesTab('all');
  },

  switchDuesTab(tab) {
    this.currentDuesTab = tab || 'all';

    const tabAll = document.getElementById('tab-due-all');
    const tabRec = document.getElementById('tab-due-receivable');
    const tabPay = document.getElementById('tab-due-payable');

    // Reset pill styles
    [tabAll, tabRec, tabPay].forEach(btn => {
      if (btn) {
        btn.style.background = 'transparent';
        btn.style.color = '#334155';
        btn.style.fontWeight = '700';
      }
    });

    if (this.currentDuesTab === 'receivable') {
      if (tabRec) {
        tabRec.style.background = '#059669';
        tabRec.style.color = '#ffffff';
        tabRec.style.fontWeight = '800';
      }
      const radioRec = document.getElementById('due-type-receivable');
      if (radioRec) { radioRec.checked = true; this.onDueTypeRadioChange(); }
    } else if (this.currentDuesTab === 'payable') {
      if (tabPay) {
        tabPay.style.background = '#dc2626';
        tabPay.style.color = '#ffffff';
        tabPay.style.fontWeight = '800';
      }
      const radioPay = document.getElementById('due-type-payable');
      if (radioPay) { radioPay.checked = true; this.onDueTypeRadioChange(); }
    } else {
      if (tabAll) {
        tabAll.style.background = '#0f172a';
        tabAll.style.color = '#ffffff';
        tabAll.style.fontWeight = '800';
      }
    }

    this.filterDuesList();
  },

  onDueTypeRadioChange() {
    const isPayable = document.getElementById('due-type-payable')?.checked;
    const submitBtn = document.getElementById('btn-due-submit');
    const btnText = document.getElementById('lbl-due-btn-text');
    const nameInput = document.getElementById('due-input-name');
    const descInput = document.getElementById('due-input-desc');
    const amountInput = document.getElementById('due-input-amount');
    const lblRec = document.getElementById('due-type-lbl-receivable');
    const lblPay = document.getElementById('due-type-lbl-payable');
    const lblName = document.getElementById('lbl-due-name');

    if (isPayable) {
      if (lblPay) {
        lblPay.style.borderColor = '#dc2626';
        lblPay.style.background = '#fef2f2';
        lblPay.style.color = '#991b1b';
      }
      if (lblRec) {
        lblRec.style.borderColor = '#cbd5e1';
        lblRec.style.background = '#ffffff';
        lblRec.style.color = '#64748b';
      }
      if (submitBtn) {
        submitBtn.style.background = 'linear-gradient(135deg, #dc2626, #ef4444)';
      }
      if (btnText) btnText.textContent = 'આપવાના ઉમેરો';
      if (lblName) lblName.textContent = 'વેપારી કે વ્યક્તિનું નામ *:';
      if (nameInput) nameInput.placeholder = 'વેપારી કે વ્યક્તિનું નામ લખો...';
      if (descInput) descInput.placeholder = 'વિગત (દા.ત. કરિયાણું, કલર કામ...)';
      if (amountInput) amountInput.style.color = '#dc2626';
    } else {
      if (lblRec) {
        lblRec.style.borderColor = '#10b981';
        lblRec.style.background = '#ecfdf5';
        lblRec.style.color = '#065f46';
      }
      if (lblPay) {
        lblPay.style.borderColor = '#cbd5e1';
        lblPay.style.background = '#ffffff';
        lblPay.style.color = '#64748b';
      }
      if (submitBtn) {
        submitBtn.style.background = 'linear-gradient(135deg, #059669, #10b981)';
      }
      if (btnText) btnText.textContent = 'લેવાના ઉમેરો';
      if (lblName) lblName.textContent = 'વ્યક્તિ કે ભક્તનું નામ *:';
      if (nameInput) nameInput.placeholder = 'વ્યક્તિ કે ભક્તનું નામ લખો...';
      if (descInput) descInput.placeholder = 'વિગત (દા.ત. મંદિર કામ, ઉછીના આપ્યા...)';
      if (amountInput) amountInput.style.color = '#059669';
    }
  },

  async loadDues() {
    try {
      const res = await fetch('/api/dues');
      const data = await res.json();
      if (!data.success) {
        console.error('Failed to load dues:', data.error);
        return;
      }

      this.duesList = data.dues || [];
      this.duesSummary = data.summary || {
        totalReceivable: 0,
        settledReceivable: 0,
        pendingReceivable: 0,
        countReceivablePending: 0,
        totalPayable: 0,
        settledPayable: 0,
        pendingPayable: 0,
        countPayablePending: 0
      };

      this.updateDuesKPI();
      this.filterDuesList();
    } catch (err) {
      console.error('Error fetching dues:', err);
    }
  },

  updateDuesKPI() {
    const s = this.duesSummary || {};
    const recAmt = s.pendingReceivable || 0;
    const payAmt = s.pendingPayable || 0;
    const net = recAmt - payAmt;

    const elRecAmt = document.getElementById('dues-stat-receivable-amount');
    const elRecCnt = document.getElementById('dues-stat-receivable-count');
    const elPayAmt = document.getElementById('dues-stat-payable-amount');
    const elPayCnt = document.getElementById('dues-stat-payable-count');
    const elNetAmt = document.getElementById('dues-stat-net-amount');
    const elNetDesc = document.getElementById('dues-stat-net-desc');

    const badgeAllTab = document.getElementById('badge-tab-all');
    const badgeRecTab = document.getElementById('badge-tab-receivable');
    const badgePayTab = document.getElementById('badge-tab-payable');
    const headerBadge = document.getElementById('header-dues-badge');

    if (elRecAmt) elRecAmt.textContent = '₹ ' + recAmt.toLocaleString('en-IN');
    if (elRecCnt) elRecCnt.textContent = `${s.countReceivablePending || 0} બાકી`;

    if (elPayAmt) elPayAmt.textContent = '₹ ' + payAmt.toLocaleString('en-IN');
    if (elPayCnt) elPayCnt.textContent = `${s.countPayablePending || 0} બાકી`;

    if (elNetAmt) {
      elNetAmt.textContent = (net >= 0 ? '₹ ' : '-₹ ') + Math.abs(net).toLocaleString('en-IN');
      elNetAmt.style.color = (net >= 0 ? '#15803d' : '#b91c1c');
    }
    if (elNetDesc) {
      if (net === 0) {
        elNetDesc.textContent = 'સરભર';
        elNetDesc.style.color = '#2563eb';
      } else {
        elNetDesc.textContent = (net > 0 ? 'લેણાં વધુ' : 'દેવાં વધુ');
        elNetDesc.style.color = (net > 0 ? '#16a34a' : '#dc2626');
      }
    }

    const totalCount = (this.duesList || []).length;
    if (badgeAllTab) badgeAllTab.textContent = totalCount;
    if (badgeRecTab) badgeRecTab.textContent = s.countReceivablePending || 0;
    if (badgePayTab) badgePayTab.textContent = s.countPayablePending || 0;

    const totalPendingCount = (s.countReceivablePending || 0) + (s.countPayablePending || 0);
    if (headerBadge) {
      if (totalPendingCount > 0) {
        headerBadge.style.display = 'inline-block';
        headerBadge.textContent = totalPendingCount;
      } else {
        headerBadge.style.display = 'none';
      }
    }
  },

  formatDateDisplay(dateStr) {
    if (!dateStr) return '-';
    try {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
      }
      return dateStr;
    } catch (e) {
      return dateStr;
    }
  },

  filterDuesList() {
    const activeTab = this.currentDuesTab || 'all';
    const statusFilter = document.getElementById('due-filter-status')?.value || 'pending';
    const searchVal = (document.getElementById('due-search-input')?.value || '').trim().toLowerCase();

    let items = [...(this.duesList || [])];

    if (activeTab === 'receivable') {
      items = items.filter(d => d.type === 'receivable');
    } else if (activeTab === 'payable') {
      items = items.filter(d => d.type === 'payable');
    }

    if (statusFilter === 'pending') {
      items = items.filter(d => (d.remainingAmount || 0) > 0);
    } else if (statusFilter === 'settled') {
      items = items.filter(d => (d.remainingAmount || 0) === 0);
    }

    if (searchVal) {
      items = items.filter(d =>
        (d.name && d.name.toLowerCase().includes(searchVal)) ||
        (d.description && d.description.toLowerCase().includes(searchVal)) ||
        (d.date && d.date.includes(searchVal))
      );
    }

    this.renderDuesTable(items);
  },

  renderDuesTable(items) {
    const tbody = document.getElementById('dues-table-tbody');
    const tfoot = document.getElementById('dues-table-tfoot');
    if (!tbody) return;

    if (!items || items.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 36px 16px; color: #94a3b8;">
            <div style="font-size: 2rem; margin-bottom: 6px;">🤝</div>
            <div style="font-size: 0.95rem; font-weight: 800; color: #64748b;">કોઈ એન્ટ્રી મળી નથી</div>
            <div style="font-size: 0.78rem; color: #94a3b8; margin-top: 2px;">ઉપરના ફોર્મમાંથી નવી એન્ટ્રી ઉમેરી શકો છો.</div>
          </td>
        </tr>
      `;
      if (tfoot) tfoot.innerHTML = '';
      const countBadge = document.getElementById('dues-items-count-badge');
      if (countBadge) countBadge.textContent = '0 એન્ટ્રી';
      const footerTotal = document.getElementById('dues-footer-total');
      if (footerTotal) footerTotal.textContent = '₹ 0';
      return;
    }

    let sumRemaining = 0;

    tbody.innerHTML = items.map((item, idx) => {
      const amt = Number(item.amount) || 0;
      const settled = Number(item.settledAmount) || 0;
      const remaining = Number(item.remainingAmount) || 0;
      const isReceivable = (item.type === 'receivable');

      sumRemaining += remaining;

      let statusBadge = '';
      if (remaining === 0) {
        statusBadge = `<span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; border-radius: 12px; padding: 2px 7px; font-size: 0.74rem; font-weight: 800;">🟢 પૂર્ણ</span>`;
      } else if (settled > 0) {
        statusBadge = `<span style="background: #fef9c3; color: #854d0e; border: 1px solid #fde047; border-radius: 12px; padding: 2px 7px; font-size: 0.74rem; font-weight: 800;">🟡 આંશિક</span>`;
      } else {
        statusBadge = `<span style="background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; border-radius: 12px; padding: 2px 7px; font-size: 0.74rem; font-weight: 800;">🔴 બાકી</span>`;
      }

      const formattedDate = this.formatDateDisplay(item.date);
      const typeBadge = isReceivable
        ? `<span style="background: #f0fdf4; color: #166534; border: 1px solid #86efac; border-radius: 6px; padding: 2px 6px; font-size: 0.74rem; font-weight: 800;">🟢 લેવાના</span>`
        : `<span style="background: #fef2f2; color: #991b1b; border: 1px solid #fca5a5; border-radius: 6px; padding: 2px 6px; font-size: 0.74rem; font-weight: 800;">🔴 આપવાના</span>`;

      const settleBtnTitle = isReceivable ? 'જમા લો' : 'ચૂકવણી કરો';
      const settleBtnBg = isReceivable ? '#059669' : '#dc2626';

      return `
        <tr style="border-bottom: 1px solid #e2e8f0; transition: background 0.15s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
          <td style="padding: 10px 8px; text-align: center; font-weight: 700; color: #64748b;">${idx + 1}</td>
          <td style="padding: 10px 10px; font-weight: 700; color: #334155; text-align: center; white-space: nowrap; font-size: 0.88rem;">${formattedDate}</td>
          <td style="padding: 10px 10px; text-align: center; white-space: nowrap;">${typeBadge}</td>
          <td style="padding: 10px 14px; font-weight: 800; color: #0f172a; font-size: 0.96rem;">
            ${item.name || '-'}
          </td>
          <td style="padding: 10px 14px; color: #334155; font-size: 0.88rem;">
            ${item.description || '-'}
          </td>
          <td style="padding: 10px 12px; text-align: right; white-space: nowrap;">
            <div style="font-weight: 900; color: ${remaining > 0 ? (isReceivable ? '#15803d' : '#b91c1c') : '#64748b'}; font-size: 1.05rem; font-family: var(--font-heading);">
              ₹ ${remaining.toLocaleString('en-IN')}
            </div>
            ${settled > 0 ? `
              <div style="font-size: 0.76rem; color: #64748b; margin-top: 2px;">
                કુલ ₹${amt.toLocaleString('en-IN')} | જમા ₹${settled.toLocaleString('en-IN')}
              </div>
            ` : (remaining === 0 ? `
              <div style="font-size: 0.76rem; color: #15803d; font-weight: 700; margin-top: 2px;">
                કુલ ₹${amt.toLocaleString('en-IN')} પૂર્ણ
              </div>
            ` : '')}
          </td>
          <td style="padding: 10px 8px; text-align: center;">${statusBadge}</td>
          <td style="padding: 10px 10px; text-align: center; white-space: nowrap;">
            <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
              ${remaining > 0 ? `
                <button type="button" class="btn-primary" onclick="App.openDueSettleModal('${item.id}')"
                  style="background: ${settleBtnBg}; border-color: ${settleBtnBg}; padding: 5px 12px; font-size: 0.82rem; font-weight: 800; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px;" title="${settleBtnTitle}">
                  <span>💰</span> <span>${settleBtnTitle}</span>
                </button>
              ` : `
                <button type="button" class="btn-secondary" onclick="App.openDueSettleModal('${item.id}')"
                  style="padding: 5px 12px; font-size: 0.82rem; font-weight: 700; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px;" title="ઇતિહાસ જુઓ">
                  <span>📜</span> <span>ઇતિહાસ</span>
                </button>
              `}
              <button type="button" class="btn-icon" onclick="App.deleteDue('${item.id}', '${(item.name || '').replace(/'/g, "\\'")}')"
                style="padding: 5px 8px; color: #dc2626; border-radius: 6px; border: 1px solid #fecaca; background: #fff5f5;" title="કાઢી નાખો">
                🗑️
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    if (tfoot) {
      tfoot.innerHTML = `
        <tr style="background: #f8fafc; font-weight: 900;">
          <td colspan="5" style="padding: 8px 10px; text-align: right; font-size: 0.88rem; color: #1e293b;">
            કુલ બાકી (${items.length} એન્ટ્રીઓ):
          </td>
          <td style="padding: 8px 8px; text-align: right; font-size: 0.95rem; color: #0f172a;">
            ₹ ${sumRemaining.toLocaleString('en-IN')}
          </td>
          <td colspan="2"></td>
        </tr>
      `;
    }

    const countBadge = document.getElementById('dues-items-count-badge');
    if (countBadge) countBadge.textContent = `${items.length} એન્ટ્રી${items.length === 1 ? '' : 'ઓ'}`;

    const footerTotal = document.getElementById('dues-footer-total');
    if (footerTotal) {
      footerTotal.textContent = '₹ ' + sumRemaining.toLocaleString('en-IN');
      if (this.currentDuesTab === 'receivable') {
        footerTotal.style.color = '#15803d';
      } else if (this.currentDuesTab === 'payable') {
        footerTotal.style.color = '#dc2626';
      } else {
        footerTotal.style.color = 'var(--text-main)';
      }
    }
  },

  async submitAddDue() {
    const date = document.getElementById('due-input-date')?.value;
    const name = (document.getElementById('due-input-name')?.value || '').trim();
    const amount = Number(document.getElementById('due-input-amount')?.value);
    const description = (document.getElementById('due-input-desc')?.value || '').trim();
    const type = document.querySelector('input[name="due-type-choice"]:checked')?.value || (this.currentDuesTab === 'payable' ? 'payable' : 'receivable');

    if (!name) {
      this.showToast('⚠️ કૃપા કરીને નામ લખો', 'warning');
      document.getElementById('due-input-name')?.focus();
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ કૃપા કરીને માન્ય રકમ લખો', 'warning');
      document.getElementById('due-input-amount')?.focus();
      return;
    }
    if (!description) {
      this.showToast('⚠️ કૃપા કરીને વિગત લખો', 'warning');
      document.getElementById('due-input-desc')?.focus();
      return;
    }

    try {
      const res = await fetch('/api/dues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, date, name, amount, description })
      });
      const data = await res.json();
      if (!data.success) {
        this.showToast('❌ ' + (data.error || 'ભૂલ આવી'), 'danger');
        return;
      }

      // Reset form fields
      document.getElementById('due-input-name').value = '';
      document.getElementById('due-input-amount').value = '';
      document.getElementById('due-input-desc').value = '';

      this.showToast(`✅ ${type === 'receivable' ? 'લેવાના બાકી' : 'આપવાના બાકી'} સફળતાપૂર્વક ઉમેરાયા!`, 'success');
      await this.loadDues();
      if (this.currentDuesTab !== 'all' && this.currentDuesTab !== type) {
        this.switchDuesTab(type);
      }
    } catch (err) {
      console.error('Error submitting due:', err);
      this.showToast('❌ સર્વર કનેક્શનમાં ક્ષતિ થઈ', 'danger');
    }
  },

  openDueSettleModal(dueId) {
    const due = (this.duesList || []).find(d => d.id === dueId);
    if (!due) return;

    const isReceivable = (due.type === 'receivable');

    document.getElementById('due-settle-id').value = due.id;
    document.getElementById('due-settle-input-date').value = this.currentDate || new Date().toISOString().split('T')[0];
    document.getElementById('due-settle-input-amount').value = due.remainingAmount > 0 ? due.remainingAmount : '';
    document.getElementById('due-settle-input-amount').max = due.remainingAmount;
    document.getElementById('due-settle-input-note').value = '';

    const titleEl = document.getElementById('due-settle-title');
    const subEl = document.getElementById('due-settle-subtitle');
    const totalEl = document.getElementById('due-settle-card-total');
    const settledEl = document.getElementById('due-settle-card-settled');
    const remEl = document.getElementById('due-settle-card-remaining');
    const submitBtn = document.getElementById('btn-due-settle-submit');
    const labelAmt = document.getElementById('due-settle-label-amount');

    if (titleEl) titleEl.textContent = isReceivable ? '💰 રકમ જમા નોંધો' : '💸 ચુકવણી નોંધો';
    if (subEl) subEl.textContent = `${due.name} (${due.description || ''})`;
    if (totalEl) totalEl.textContent = '₹ ' + (due.amount || 0).toLocaleString('en-IN');
    if (settledEl) settledEl.textContent = '₹ ' + (due.settledAmount || 0).toLocaleString('en-IN');
    if (remEl) remEl.textContent = '₹ ' + (due.remainingAmount || 0).toLocaleString('en-IN');
    if (labelAmt) labelAmt.textContent = isReceivable ? 'જમા રકમ (₹) *' : 'ચૂકવેલ રકમ (₹) *';

    if (submitBtn) {
      submitBtn.style.background = isReceivable ? '#059669' : '#dc2626';
      submitBtn.style.borderColor = isReceivable ? '#059669' : '#dc2626';
      submitBtn.innerHTML = isReceivable ? '<span>✅</span> <span>રકમ જમા કરો</span>' : '<span>✅</span> <span>ચુકવણી સેવ કરો</span>';
    }

    // Render history
    this.renderDueSettlementHistory(due);

    this.openModal('modal-due-settle');
  },

  renderDueSettlementHistory(due) {
    const listEl = document.getElementById('due-settle-history-list');
    if (!listEl) return;

    const hist = due.history || [];
    if (hist.length === 0) {
      listEl.innerHTML = `<div style="text-align: center; color: #94a3b8; font-size: 0.82rem; padding: 10px;">અગાઉ કોઈ જમા/ચુકવણી થયેલ નથી.</div>`;
      return;
    }

    listEl.innerHTML = `
      <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
        <thead>
          <tr style="border-bottom: 1px solid #cbd5e1; color: #64748b; text-align: left;">
            <th style="padding: 4px 6px;">તારીખ</th>
            <th style="padding: 4px 6px;">રકમ</th>
            <th style="padding: 4px 6px;">નોંધ</th>
            <th style="padding: 4px 6px; text-align: center;">રદ</th>
          </tr>
        </thead>
        <tbody>
          ${hist.map(h => `
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 5px 6px; font-weight: 600;">${this.formatDateDisplay(h.date)}</td>
              <td style="padding: 5px 6px; font-weight: 800; color: #16a34a;">₹ ${(Number(h.amount) || 0).toLocaleString('en-IN')}</td>
              <td style="padding: 5px 6px; color: #475569;">${h.note || '-'}</td>
              <td style="padding: 5px 6px; text-align: center;">
                <button type="button" class="btn-icon" onclick="App.deleteDueSettlement('${due.id}', '${h.id}')"
                  style="color: #dc2626; padding: 2px 6px; font-size: 0.75rem;" title="આ હપ્તો રદ કરો">✕</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  },

  async submitDueSettlement() {
    const dueId = document.getElementById('due-settle-id')?.value;
    const date = document.getElementById('due-settle-input-date')?.value;
    const amount = Number(document.getElementById('due-settle-input-amount')?.value);
    const note = (document.getElementById('due-settle-input-note')?.value || '').trim();

    if (!dueId) return;
    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ કૃપા કરીને માન્ય રકમ લખો', 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/dues/${dueId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, amount, note })
      });
      const data = await res.json();
      if (!data.success) {
        this.showToast('❌ ' + (data.error || 'ભૂલ આવી'), 'danger');
        return;
      }

      this.showToast('✅ રકમ સફળતાપૂર્વક સાચવાઈ ગઈ!', 'success');
      this.closeModal('modal-due-settle');
      await this.loadDues();
    } catch (err) {
      console.error('Error submitting settlement:', err);
      this.showToast('❌ સર્વર કનેક્શનમાં ક્ષતિ થઈ', 'danger');
    }
  },

  async deleteDueSettlement(dueId, settleId) {
    if (!confirm('શું તમે આ ચુકવણી/જમા હપ્તો રદ કરવા માંગો છો? બાકી રકમ ફરી પૂર્વવત થઈ જશે.')) return;

    try {
      const res = await fetch(`/api/dues/${dueId}/settle/${settleId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) {
        this.showToast('❌ ' + (data.error || 'ભૂલ આવી'), 'danger');
        return;
      }

      this.showToast('✅ હપ્તો રદ કરવામાં આવ્યો.', 'success');
      await this.loadDues();
      const updatedDue = (this.duesList || []).find(d => d.id === dueId);
      if (updatedDue) {
        this.openDueSettleModal(dueId);
      } else {
        this.closeModal('modal-due-settle');
      }
    } catch (err) {
      console.error('Error deleting settlement:', err);
    }
  },

  async deleteDue(dueId, dueName) {
    if (!confirm(`શું તમે "${dueName || 'આ રેકોર્ડ'}" કાઢી નાખવા માંગો છો?`)) return;

    try {
      const res = await fetch(`/api/dues/${dueId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) {
        this.showToast('❌ ' + (data.error || 'ભૂલ આવી'), 'danger');
        return;
      }

      this.showToast('✅ રેકોર્ડ સફળતાપૂર્વક કાઢી નાખવામાં આવ્યો.', 'success');
      await this.loadDues();
    } catch (err) {
      console.error('Error deleting due:', err);
    }
  },

  printDuesReport() {
    const activeTab = this.currentDuesTab || 'all';
    const statusFilter = document.getElementById('due-filter-status')?.value || 'pending';
    const searchVal = (document.getElementById('due-search-input')?.value || '').trim().toLowerCase();

    let items = [...(this.duesList || [])];
    if (activeTab === 'receivable') items = items.filter(d => d.type === 'receivable');
    else if (activeTab === 'payable') items = items.filter(d => d.type === 'payable');

    if (statusFilter === 'pending') {
      items = items.filter(d => (d.remainingAmount || 0) > 0);
    } else if (statusFilter === 'settled') {
      items = items.filter(d => (d.remainingAmount || 0) === 0);
    }
    if (searchVal) {
      items = items.filter(d =>
        (d.name && d.name.toLowerCase().includes(searchVal)) ||
        (d.description && d.description.toLowerCase().includes(searchVal)) ||
        (d.date && d.date.includes(searchVal))
      );
    }

    const title = activeTab === 'receivable'
      ? 'લેવાના બાકી પૈસાનો હિસાબ રિપોર્ટ'
      : (activeTab === 'payable' ? 'ચૂકવવાના બાકી હિસાબ (દેવાં) રિપોર્ટ' : 'લેણાં અને દેવાં રજિસ્ટર (બાકી હિસાબ) રિપોર્ટ');
    const subtitle = `તારીખ: ${new Date().toLocaleDateString('en-GB')} | સ્થિતિ: ${statusFilter === 'pending' ? 'માત્ર બાકી' : (statusFilter === 'settled' ? 'પૂર્ણ થયેલ' : 'તમામ')}`;

    let totalAmt = 0;
    let totalSettled = 0;
    let totalRemaining = 0;

    items.forEach(d => {
      totalAmt += (Number(d.amount) || 0);
      totalSettled += (Number(d.settledAmount) || 0);
      totalRemaining += (Number(d.remainingAmount) || 0);
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>${title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; color: #1e293b; }
          .header { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 16px; }
          .title { font-size: 20px; font-weight: bold; margin-bottom: 4px; color: ${activeTab === 'receivable' ? '#166534' : (activeTab === 'payable' ? '#991b1b' : '#1e3a8a')}; }
          .subtitle { font-size: 13px; color: #64748b; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
          th { background: #f1f5f9; border: 1px solid #cbd5e1; padding: 8px; text-align: left; }
          td { border: 1px solid #cbd5e1; padding: 7px 8px; }
          .amt { text-align: right; font-weight: bold; }
          .total-row { background: #e2e8f0; font-weight: bold; }
          .footer { margin-top: 30px; display: flex; justify-content: space-between; font-size: 12px; font-weight: bold; }
          @media print {
            body { margin: 10mm; }
            button { display: none; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">${title}</div>
          <div class="subtitle">${subtitle}</div>
        </div>

        <table>
          <thead>
            <tr>
              <th style="width: 30px; text-align: center;">#</th>
              <th style="width: 80px;">તારીખ</th>
              <th style="width: 80px; text-align: center;">પ્રકાર</th>
              <th>નામ</th>
              <th>વિગત / કારણ</th>
              <th class="amt" style="width: 90px;">કુલ રકમ</th>
              <th class="amt" style="width: 90px;">જમા/ચૂકવેલ</th>
              <th class="amt" style="width: 90px;">બાકી રકમ</th>
              <th style="width: 60px; text-align: center;">સ્થિતિ</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((d, i) => `
              <tr>
                <td style="text-align: center;">${i + 1}</td>
                <td>${this.formatDateDisplay(d.date)}</td>
                <td style="text-align: center; font-weight: bold; color: ${d.type === 'receivable' ? '#166534' : '#991b1b'};">${d.type === 'receivable' ? 'લેવાના' : 'આપવાના'}</td>
                <td style="font-weight: bold;">${d.name || '-'}</td>
                <td>${d.description || '-'}</td>
                <td class="amt">₹ ${(Number(d.amount) || 0).toLocaleString('en-IN')}</td>
                <td class="amt" style="color: #16a34a;">₹ ${(Number(d.settledAmount) || 0).toLocaleString('en-IN')}</td>
                <td class="amt" style="color: ${d.type === 'receivable' ? '#166534' : '#b91c1c'};">₹ ${(Number(d.remainingAmount) || 0).toLocaleString('en-IN')}</td>
                <td style="text-align: center;">${d.remainingAmount === 0 ? 'પૂર્ણ' : (d.settledAmount > 0 ? 'આંશિક' : 'બાકી')}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td colspan="5" style="text-align: right;">કુલ સરવાળો (${items.length} એન્ટ્રીઓ):</td>
              <td class="amt">₹ ${totalAmt.toLocaleString('en-IN')}</td>
              <td class="amt" style="color: #16a34a;">₹ ${totalSettled.toLocaleString('en-IN')}</td>
              <td class="amt">₹ ${totalRemaining.toLocaleString('en-IN')}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>

        <div class="footer">
          <div>તૈયાર કરનાર: ______________</div>
          <div>તપાસનાર: ______________</div>
          <div>મંજૂર કરનાર: ______________</div>
        </div>
      </body>
      </html>
    `;

    this.openPrintWindow(html);
  },

  shareDuesWhatsApp() {
    const activeTab = this.currentDuesTab || 'all';
    let items = [...(this.duesList || [])].filter(d => (d.remainingAmount || 0) > 0);
    if (activeTab === 'receivable') items = items.filter(d => d.type === 'receivable');
    else if (activeTab === 'payable') items = items.filter(d => d.type === 'payable');

    if (items.length === 0) {
      this.showToast('કોઈ બાકી રકમની એન્ટ્રી નથી', 'info');
      return;
    }

    let text = `*${activeTab === 'receivable' ? '🟢 લેવાના બાકી પૈસાની યાદી' : (activeTab === 'payable' ? '🔴 ચૂકવવાના બાકી પૈસાની યાદી' : '⚖️ લેણાં અને દેવાં બાકી યાદી')}*\n`;
    text += `તારીખ: ${new Date().toLocaleDateString('en-GB')}\n`;
    text += `----------------------------------------\n`;

    let totalDue = 0;
    items.forEach((d, idx) => {
      const rem = Number(d.remainingAmount) || 0;
      totalDue += rem;
      const typeTag = d.type === 'receivable' ? '[લેવાના]' : '[આપવાના]';
      text += `${idx + 1}. *${d.name}* ${typeTag}: ₹ ${rem.toLocaleString('en-IN')}\n   વિગત: ${d.description || '-'}\n`;
    });

    text += `----------------------------------------\n`;
    text += `*કુલ બાકી રકમ: ₹ ${totalDue.toLocaleString('en-IN')}* (${items.length} એન્ટ્રીઓ)`;

    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  }
};

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());

