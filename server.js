process.env.TZ = 'Asia/Kolkata';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const multer = require('multer');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  console.warn('Note: nodemailer running in fallback mode:', e.message);
}
const dbSync = require('./db');
const registerAuthRoutes = require('./routes/auth');
const registerAdminRoutes = require('./routes/admin');
const registerEmployeeRoutes = require('./routes/employees');
const registerRecordsRoutes = require('./routes/records');
const registerSubsystemRoutes = require('./routes/subsystems');

const app = express();
const PORT = process.env.PORT || 3000;

// In-Memory Admin Session Token Store & Brute-Force Rate Limiting
const adminSessions = new Map(); // token -> { createdAt, expiresAt }
const appAuthSessions = new Map(); // token -> { userId, username, name, role, expiresAt }

// =========================================================================
// SECURITY & RBAC HELPERS
// =========================================================================

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), 10);
}

function verifyPassword(plain, storedHashOrPlain) {
  if (!plain || !storedHashOrPlain) return false;
  const s = String(storedHashOrPlain);
  if (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$')) {
    try {
      return bcrypt.compareSync(String(plain), s);
    } catch (e) {
      return false;
    }
  }
  // Constant-time comparison for legacy plain passwords
  const bufA = Buffer.from(String(plain));
  const bufB = Buffer.from(s);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Brute-Force Rate Limiting for Login (5 failed attempts -> 15 min lockout)
const loginAttempts = new Map(); // key -> { count: number, firstAttempt: number, lockedUntil: number }
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 mins

function getLoginRateLimitKey(req, loginIdentifier) {
  const ip = (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || req.ip || '127.0.0.1').toString().replace(/^.*:/, '');
  return `${ip}_${String(loginIdentifier || '').toLowerCase().trim()}`;
}

function checkLoginRateLimit(key) {
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record) return { allowed: true, remaining: MAX_LOGIN_ATTEMPTS };

  if (record.lockedUntil && now < record.lockedUntil) {
    const minutesLeft = Math.ceil((record.lockedUntil - now) / 60000);
    return {
      allowed: false,
      locked: true,
      minutesLeft,
      error: `Security Lockout! Too many failed attempts. Login blocked for ${minutesLeft} minutes.`
    };
  }

  if (now - record.firstAttempt > LOGIN_LOCKOUT_MS) {
    loginAttempts.delete(key);
    return { allowed: true, remaining: MAX_LOGIN_ATTEMPTS };
  }

  const remaining = Math.max(0, MAX_LOGIN_ATTEMPTS - record.count);
  return { allowed: true, remaining };
}

function recordFailedLoginAttempt(key) {
  const now = Date.now();
  let record = loginAttempts.get(key);
  if (!record || (now - record.firstAttempt > LOGIN_LOCKOUT_MS)) {
    record = { count: 1, firstAttempt: now, lockedUntil: 0 };
  } else {
    record.count += 1;
  }

  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
  loginAttempts.set(key, record);
  return record;
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

// Temporary Store for 2-Step Login OTPs
const pendingLoginOtps = new Map(); // tempToken -> { user, otp, expiresAt, attempts, rememberMe }

function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-token'] || req.headers['x-auth-token'] || (req.query && req.query.token);
  if (!authHeader) return null;
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  if (appAuthSessions.has(token)) {
    const session = appAuthSessions.get(token);
    if (Date.now() > session.expiresAt) {
      appAuthSessions.delete(token);
      return null;
    }
    return session;
  }

  if (adminSessions.has(token)) {
    const session = adminSessions.get(token);
    if (Date.now() > session.expiresAt) {
      adminSessions.delete(token);
      return null;
    }
    return { userId: 'usr_admin', username: 'admin', name: 'સુપર એડમિન', role: 'admin' };
  }

  return null;
}

function isValidAdminSession(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-token'] || (req.query && req.query.token);
  if (!authHeader) return false;
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;

  // 1. Dedicated Admin Session Token (from Admin PIN verification)
  if (adminSessions.has(token)) {
    const session = adminSessions.get(token);
    if (Date.now() > session.expiresAt) {
      adminSessions.delete(token);
      return false;
    }
    return true;
  }

  // 2. Application session token: ONLY if user role is explicitly 'admin' (RBAC enforcement)
  if (appAuthSessions.has(token)) {
    const session = appAuthSessions.get(token);
    if (Date.now() > session.expiresAt) {
      appAuthSessions.delete(token);
      return false;
    }
    if (session.role === 'admin') {
      return true;
    }
  }

  return false;
}

function requireAdminAuth(req, res, next) {
  if (isValidAdminSession(req)) {
    return next();
  }
  return res.status(403).json({
    success: false,
    error: 'સુરક્ષા સેશન સમાપ્ત થઈ ગયું છે અથવા અમાન્ય છે! કૃપા કરીને ફરી એડમિન પિન નાખી લૉગિન કરો.',
    sessionExpired: true
  });
}

function requireAuth(req, res, next) {
  const user = getAuthUser(req);
  if (user) {
    req.authUser = user;
    return next();
  }
  return res.status(401).json({
    success: false,
    error: 'સુરક્ષા સેશન સમાપ્ત થઈ ગયું છે. કૃપા કરીને ફરી લૉગિન કરો.',
    sessionExpired: true
  });
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'કૃપા કરીને લૉગિન કરો.', sessionExpired: true });
    }
    req.authUser = user;
    if (user.role === 'admin' || allowedRoles.includes(user.role)) {
      return next();
    }
    return res.status(403).json({
      success: false,
      error: `અધિકૃતતા નથી! આ પ્રક્રિયા કરવા માટે '${allowedRoles.join('/')}' ની પરવાનગી જરૂરી છે.`
    });
  };
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Initialize MongoDB Atlas Cloud Database on Server Startup
if (dbSync && typeof dbSync.initMongoDB === 'function') {
  dbSync.initMongoDB().then(() => {
    console.log('[DB] MongoDB Atlas initialization complete.');
  }).catch(err => {
    console.warn('[DB] MongoDB Atlas auto-connect notice:', err.message);
  });

  // Background bidirectional cloud sync every 15s to keep multiple computers in sync
  setInterval(async () => {
    try {
      if (dbSync && typeof dbSync.syncFromCloudToLocal === 'function' && dbSync.getCloudStatus()) {
        await dbSync.syncFromCloudToLocal();
      }
    } catch (e) { }
  }, 15000);
}

app.post('/api/cloud-sync-pull', async (req, res) => {
  try {
    if (dbSync && typeof dbSync.syncFromCloudToLocal === 'function') {
      await dbSync.syncFromCloudToLocal();
      return res.json({ success: true, message: 'Cloud sync complete' });
    }
    res.json({ success: false, message: 'Cloud sync not available' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dynamic caching: APIs are never cached, while static assets use fast ETag validation
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Realtime Cloud Database Health / Status Endpoint
app.get('/api/cloud-status', async (req, res) => {
  try {
    const isOnline = dbSync ? await dbSync.checkRealtimeCloudStatus() : false;
    res.json({ online: isOnline, cloud: 'MongoDB Atlas', database: 'hisab_db' });
  } catch (err) {
    res.json({ online: false, error: err.message });
  }
});

const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true
}));

// Explicit Root Route - Guaranteed to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Dedicated Login Page
app.get('/login', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// Dedicated Admin Portal
app.get('/admin', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
});

const DATA_DIR = path.join(__dirname, 'data');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const REPORTS_DIR = path.join(__dirname, 'reports');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// Setup multer for excel import
const upload = multer({ dest: path.join(__dirname, 'uploads') });
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
}

// Default settings with fixed notes, banks, and vouchers matching HISAB.xlsm
const DEFAULT_SETTINGS = {
  orgName: 'Gadisthan Jetpur',
  orgSubtitle: '',
  phone: '9574527642',
  currencySymbol: '₹',
  exportFolder: 'D:\\Account Report',
  language: 'gu', // 'gu', 'en'
  theme: 'light',
  printTopOffset: 140,
  printLeftOffset: 43,
  // Master lists manageable from Admin Panel:
  notes: [500, 200, 100, 50, 20, 10],
  defaultBanks: ['IOB TRF', 'BOB TRF ', 'SBI TRF'],
  inactiveBanks: [],
  defaultVouchers: ['MANDIRKHARCH', 'RASODAKHARCH', 'PAGAR'],
  inactiveVouchers: [],
  smtpSenderName: process.env.SMTP_SENDER_NAME || 'Gadisthan Jetpur',
  smtpEmail: process.env.SMTP_EMAIL || 'Teraiya.Kaushik24@gmail.com',
  smtpAppPassword: process.env.SMTP_APP_PASSWORD || 'bkqxvlmeqnpvoomb',
  adminAlertEmail: process.env.ADMIN_ALERT_EMAIL || 'Teraiya.Kaushik24@gmail.com',
  adminPin: '1234'
};

const KHATA_GUJARATI_MAP = {
  'MANDIRKHARCH': 'મંદિર ખર્ચ',
  'MANDIR KHARCH': 'મંદિર ખર્ચ',
  'MANDIR_KHARCH': 'મંદિર ખર્ચ',
  'MANDIR': 'મંદિર ખર્ચ',
  'TEMPLE': 'મંદિર ખર્ચ',
  'RASODAKHARCH': 'રસોડા ખર્ચ',
  'RASODA KHARCH': 'રસોડા ખર્ચ',
  'RASODA_KHARCH': 'રસોડા ખર્ચ',
  'RASODA': 'રસોડા ખર્ચ',
  'KITCHEN': 'રસોડા ખર્ચ',
  'PAGAR': 'પગાર',
  'PAGARKHARCH': 'પગાર ખર્ચ',
  'SALARY': 'પગાર',
  'UPAD': 'ઉપાડ',
  'ADVANCE': 'ઉપાડ',
  'HINDOLA KHARCH': 'હિંડોળા ખર્ચ',
  'HINDOLAKHARCH': 'હિંડોળા ખર્ચ',
  'GAUSHALA': 'ગૌશાળા',
  'BIJLI BILL': 'વીજળી બિલ',
  'LIGHT BILL': 'લાઈટ બિલ',
  'ELECTRICITY': 'વીજળી બિલ',
  'PETROL': 'પેટ્રોલ ખર્ચ',
  'PETROL KHARCH': 'પેટ્રોલ ખર્ચ',
  'DUDH': 'દૂધ ખર્ચ',
  'DUDH KHARCH': 'દૂધ ખર્ચ',
  'CHAI': 'ચા-નાસ્તો',
  'CHAI NASTA': 'ચા-નાસ્તો',
  'KIRANA': 'કરિયાણું / કિરાણા',
  'REPAIR': 'રીપેરીંગ ખર્ચ',
  'REPAIRING': 'રીપેરીંગ ખર્ચ',
  'MAINTENANCE': 'મેન્ટેનન્સ',
  'OFFICE': 'ઓફિસ ખર્ચ',
  'OTHER': 'અન્ય ખર્ચ',
  'MISC': 'પરચૂરણ ખર્ચ'
};

function getGujaratiKhataName(name) {
  if (!name) return '';
  const trimmed = String(name).trim();
  const upper = trimmed.toUpperCase();
  if (KHATA_GUJARATI_MAP[upper]) return KHATA_GUJARATI_MAP[upper];
  return trimmed;
}

function getGujaratiMonthLabel(ym) {
  if (!ym) return '';
  const parts = String(ym).split('-');
  const y = parts[0];
  const m = parseInt(parts[1], 10);
  const guMonths = [
    'જાન્યુઆરી', 'ફેબ્રુઆરી', 'માર્ચ', 'એપ્રિલ', 'મે', 'જૂન',
    'જુલાઈ', 'ઓગસ્ટ', 'સપ્ટેમ્બર', 'ઓક્ટોબર', 'નવેમ્બર', 'ડિસેમ્બર'
  ];
  const name = guMonths[m - 1] || ym;
  return `${name} ${y}`;
}

function isSameKhata(a, b) {
  if (!a || !b) return false;
  const s1 = String(a).trim().toUpperCase();
  const s2 = String(b).trim().toUpperCase();
  if (s1 === s2) return true;
  const clean1 = s1.replace(/[\s_\-]+/g, '');
  const clean2 = s2.replace(/[\s_\-]+/g, '');
  if (clean1 && clean2 && clean1 === clean2) return true;

  const g1 = (getGujaratiKhataName(a) || '').trim();
  const g2 = (getGujaratiKhataName(b) || '').trim();
  if (g1 && g2 && g1 === g2) return true;
  return false;
}

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    }
  } catch (e) {
    console.error('Error reading settings:', e);
  }
  return DEFAULT_SETTINGS;
}

function safeWriteJson(filePath, data) {
  if (dbSync && typeof dbSync.atomicWriteJson === 'function') {
    dbSync.atomicWriteJson(filePath, data);
  } else {
    fs.writeFileSync(filePath, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
  }
}

function saveSettings(settings) {
  safeWriteJson(SETTINGS_FILE, settings);
  dbSync.syncSettingsToCloud(settings);
}

// =========================================================================
// EMAIL NOTIFICATIONS & OTP RECOVERY ENGINE (Gmail SMTP)
// =========================================================================
function getMailTransporter() {
  const currentSettings = getSettings();
  const email = process.env.SMTP_EMAIL || currentSettings.smtpEmail || 'Teraiya.Kaushik24@gmail.com';
  const pass = process.env.SMTP_APP_PASSWORD || currentSettings.smtpAppPassword || 'bkqxvlmeqnpvoomb';
  if (!nodemailer || !email || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: email, pass: pass }
  });
}

function getSenderDisplayName(customName = null) {
  const currentSettings = getSettings();
  return (customName && String(customName).trim()) || currentSettings.smtpSenderName || currentSettings.orgName || 'Gadisthan Jetpur';
}

function getEmailSenderString(customName = null) {
  const currentSettings = getSettings();
  const name = getSenderDisplayName(customName);
  const email = process.env.SMTP_EMAIL || currentSettings.smtpEmail || 'Teraiya.Kaushik24@gmail.com';
  return `"${name}" <${email}>`;
}

function getRecords() {
  try {
    if (fs.existsSync(RECORDS_FILE)) {
      return JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading records:', e);
  }
  return {};
}

function saveRecords(records) {
  safeWriteJson(RECORDS_FILE, records);
  try {
    const backupDir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    safeWriteJson(path.join(backupDir, 'records_backup.json'), records);
  } catch (err) { }
  dbSync.syncAllRecordsToCloud(records);
}

function getTodayDateStr() {
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  } catch (e) {
    return new Date().toISOString().split('T')[0];
  }
}

function getTodayTimeStr() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(new Date());
}

const EMPLOYEES_FILE = path.join(DATA_DIR, 'employees.json');

function getEmployees() {
  try {
    if (fs.existsSync(EMPLOYEES_FILE)) {
      const list = JSON.parse(fs.readFileSync(EMPLOYEES_FILE, 'utf8'));
      if (Array.isArray(list)) {
        list.forEach(e => {
          if (!e.paymentType) e.paymentType = 'monthly';
        });
        return list;
      }
    }
  } catch (e) {
    console.error('Error reading employees:', e);
  }
  return [];
}

function saveEmployees(employees) {
  safeWriteJson(EMPLOYEES_FILE, employees);
  dbSync.syncListToCloud('employees', employees);
}

const UCHAK_FILE = path.join(DATA_DIR, 'uchak.json');

function getUchakRecords() {
  try {
    if (fs.existsSync(UCHAK_FILE)) {
      return JSON.parse(fs.readFileSync(UCHAK_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading uchak records:', e);
  }
  return [];
}

function saveUchakRecords(records) {
  safeWriteJson(UCHAK_FILE, records);
  dbSync.syncListToCloud('uchak', records);
}

const BANK_DEPOSITS_FILE = path.join(DATA_DIR, 'bank_deposits.json');

function getBankDeposits() {
  try {
    if (fs.existsSync(BANK_DEPOSITS_FILE)) {
      return JSON.parse(fs.readFileSync(BANK_DEPOSITS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading bank deposits:', e);
  }
  return [];
}

function saveBankDeposits(deposits) {
  safeWriteJson(BANK_DEPOSITS_FILE, deposits);
  dbSync.syncListToCloud('bank_deposits', deposits);
}

const BHAKTS_FILE = path.join(DATA_DIR, 'bhakts.json');
const BHAKT_DEPOSITS_FILE = path.join(DATA_DIR, 'bhakt_deposits.json');

function getBhakts() {
  try {
    if (fs.existsSync(BHAKTS_FILE)) {
      return JSON.parse(fs.readFileSync(BHAKTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading bhakts:', e);
  }
  return [];
}

function saveBhakts(bhakts) {
  safeWriteJson(BHAKTS_FILE, bhakts);
  dbSync.syncListToCloud('bhakts', bhakts);
}

function getBhaktDeposits() {
  try {
    if (fs.existsSync(BHAKT_DEPOSITS_FILE)) {
      return JSON.parse(fs.readFileSync(BHAKT_DEPOSITS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading bhakt deposits:', e);
  }
  return [];
}

function saveBhaktDeposits(deposits) {
  safeWriteJson(BHAKT_DEPOSITS_FILE, deposits);
  dbSync.syncListToCloud('bhakt_deposits', deposits);
}

// =========================================================================
// DUES (લેણાં અને દેવાં / બાકી હિસાબ રજિસ્ટર)
// =========================================================================
const DUES_FILE = path.join(DATA_DIR, 'dues.json');

function getDues() {
  try {
    if (fs.existsSync(DUES_FILE)) {
      let raw = fs.readFileSync(DUES_FILE, 'utf8');
      if (raw && raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('Error reading dues:', e);
  }
  return [];
}

function saveDues(dues) {
  try {
    safeWriteJson(DUES_FILE, dues);
    dbSync.syncListToCloud('dues', dues);
  } catch (e) {
    console.error('Error saving dues:', e);
  }
}

// =========================================================================
// ADMIN AUDIT LOG / ACTIVITY HISTORY
// =========================================================================
const ADMIN_HISTORY_FILE = path.join(DATA_DIR, 'admin_history.json');

function getAdminHistory() {
  try {
    if (fs.existsSync(ADMIN_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADMIN_HISTORY_FILE, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('Error reading admin history:', e);
  }
  return [];
}

function saveAdminHistory(history) {
  try {
    safeWriteJson(ADMIN_HISTORY_FILE, history);
    dbSync.syncListToCloud('admin_history', history);
  } catch (e) {
    console.error('Error saving admin history:', e);
  }
}

// =========================================================================
// USERS & LOGIN HISTORY (MULTI-USER RBAC: USER & ACCOUNTANT)
// =========================================================================
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LOGIN_HISTORY_FILE = path.join(DATA_DIR, 'login_history.json');

function getUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      let raw = fs.readFileSync(USERS_FILE, 'utf8');
      if (raw && raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('Error reading users:', e);
  }
  return [];
}

function saveUsers(users) {
  try {
    safeWriteJson(USERS_FILE, users);
    dbSync.syncListToCloud('users', users);
  } catch (e) {
    console.error('Error saving users:', e);
  }
}

function getLoginHistory() {
  try {
    if (fs.existsSync(LOGIN_HISTORY_FILE)) {
      let raw = fs.readFileSync(LOGIN_HISTORY_FILE, 'utf8');
      if (raw && raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('Error reading login history:', e);
  }
  return [];
}

function recordLoginEvent(user, status, ip, req) {
  try {
    const list = getLoginHistory();
    const entry = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      dateStr: new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }),
      userId: user ? user.id : 'unknown',
      username: user ? user.username : (req.body?.username || req.body?.email || 'unknown'),
      name: user ? user.name : 'અજ્ઞાત',
      role: user ? user.role : 'none',
      status: status, // 'success' | 'failed'
      ip: ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1',
      userAgent: req.headers['user-agent'] || ''
    };
    list.unshift(entry);
    if (list.length > 150) list.length = 150;
    safeWriteJson(LOGIN_HISTORY_FILE, list);
    dbSync.syncListToCloud('login_history', list);
  } catch (e) {
    console.error('Error recording login event:', e);
  }
}


function logAdminActivity(action, category, title, titleEn, details, detailsEn, status = 'success', req = null, meta = null) {
  try {
    const history = getAdminHistory();
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
    const fullDate = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    let ip = 'Local';
    if (req) {
      ip = (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'Local').toString().replace(/^.*:/, '');
      if (ip === '1') ip = 'Localhost';
    }

    const newEntry = {
      id: 'hist_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: Date.now(),
      dateStr,
      timeStr,
      fullDate,
      action,
      category, // 'SECURITY' | 'BACKUP' | 'HISAB' | 'STAFF' | 'SETTINGS'
      title,
      titleEn,
      details,
      detailsEn,
      status, // 'success' | 'warning' | 'info' | 'danger'
      ip,
      meta: meta || null
    };

    history.unshift(newEntry); // newest first
    if (history.length > 500) {
      history.length = 500; // retain latest 500 entries
    }
    saveAdminHistory(history);
    return newEntry;
  } catch (err) {
    console.error('Error logging admin activity:', err);
  }
}


function createBlankRecord(date, settings) {
  const noteList = settings.notes || [500, 200, 100, 50, 20, 10];
  const bankList = settings.defaultBanks || ['IOB TRF', 'BOB TRF ', 'SBI TRF'];
  const voucherList = settings.defaultVouchers || ['MANDIRKHARCH', 'RASODAKHARCH', 'PAGAR'];
  return {
    date,
    expenseItems: [],
    notes: noteList.map(note => ({ note, count: 0, amount: 0 })),
    cashTotal: 0,
    banks: bankList.map(name => ({ name, amount: 0 })),
    bankTotal: 0,
    vouchers: voucherList.map(name => ({ name, amount: 0 })),
    voucherTotal: 0,
    grandTotal: 0,
    noteCountTotal: 0,
    remarks: '',
    updatedAt: new Date().toISOString(),
    isNew: true
  };
}

// Ensure settings file exists
if (!fs.existsSync(SETTINGS_FILE)) {
  saveSettings(DEFAULT_SETTINGS);
}

// API Routes

// 1. Get Settings (Used by App and Admin Panel)
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

// 2. Update Settings
app.post('/api/settings', (req, res) => {
  const current = getSettings();
  const updated = { ...current, ...req.body };
  saveSettings(updated);
  res.json({ success: true, settings: updated });
});

// APP-WIDE AUTHENTICATION & AUTO-LOGIN (EMAIL & PASSWORD GATEKEEPER)
// =========================================================================

// Register modular Auth & User Management routes
registerAuthRoutes(app, {
  adminSessions,
  appAuthSessions,
  pendingLoginOtps,
  loginAttempts,
  MAX_LOGIN_ATTEMPTS,
  requireAuth,
  requireAdminAuth,
  getSettings,
  saveSettings,
  getUsers,
  saveUsers,
  getLoginHistory,
  recordLoginEvent,
  logAdminActivity,
  hashPassword,
  verifyPassword,
  getLoginRateLimitKey,
  checkLoginRateLimit,
  clearLoginAttempts,
  recordFailedLoginAttempt,
  getMailTransporter,
  getEmailSenderString,
  getSenderDisplayName
});

// Register modular Admin & Configuration routes
registerAdminRoutes(app, {
  adminSessions,
  requireAdminAuth,
  getSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  logAdminActivity,
  getAdminHistory,
  saveAdminHistory,
  getTodayDateStr,
  getRecords,
  saveRecords,
  getEmployees,
  saveEmployees,
  getUchakRecords,
  saveUchakRecords,
  getBankDeposits,
  saveBankDeposits,
  getBhakts,
  saveBhakts,
  getBhaktDeposits,
  saveBhaktDeposits,
  getMailTransporter,
  getEmailSenderString,
  getSenderDisplayName,
  isSameKhata,
  getGujaratiKhataName
});

// Register modular Employee & Salary/Upad routes
registerEmployeeRoutes(app, {
  getEmployees,
  saveEmployees,
  getRecords,
  saveRecords,
  getSettings,
  createBlankRecord,
  isValidAdminSession,
  getTodayDateStr,
  getTodayTimeStr,
  logAdminActivity,
  getGujaratiMonthLabel
});

// Register modular Daily Records & Expense routes
registerRecordsRoutes(app, {
  getRecords,
  saveRecords,
  getSettings,
  saveSettings,
  getEmployees,
  saveEmployees,
  getUchakRecords,
  saveUchakRecords,
  getBankDeposits,
  getBhaktDeposits,
  getTodayDateStr,
  getTodayTimeStr,
  isValidAdminSession,
  isSameKhata,
  getGujaratiKhataName,
  getGujaratiMonthLabel,
  createBlankRecord,
  logAdminActivity
});

// Register modular Subsystems (Uchak, Bank Deposits, Bhakts, Dues, Export/Import, Voice AI)
registerSubsystemRoutes(app, {
  getUchakRecords,
  saveUchakRecords,
  getBankDeposits,
  saveBankDeposits,
  getBhakts,
  saveBhakts,
  getBhaktDeposits,
  saveBhaktDeposits,
  getDues,
  saveDues,
  getRecords,
  saveRecords,
  getEmployees,
  saveEmployees,
  getSettings,
  saveSettings,
  createBlankRecord,
  isValidAdminSession,
  requireAdminAuth,
  getTodayDateStr,
  getTodayTimeStr,
  logAdminActivity,
  dbSync,
  upload,
  REPORTS_DIR
});





// Catch-all route to serve index.html for any non-API page request
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  const targetFile = path.join(PUBLIC_DIR, req.path);
  if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
    return res.sendFile(targetFile);
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`======================================================`);
  console.log(`   HISAB PRO - Daily Accounting Software running!     `);
  console.log(`   URL: http://localhost:${PORT}                       `);
  console.log(`======================================================`);
  
  // Initialize MongoDB Atlas Cloud Connection
  await dbSync.initMongoDB();
});
