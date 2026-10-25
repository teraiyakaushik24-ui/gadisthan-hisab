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


// 6. Get all records summary
app.get('/api/records', (req, res) => {
  const records = getRecords();
  const summaryList = Object.keys(records).map(date => {
    const r = records[date];
    return {
      date,
      notes: r.notes || [],
      cashTotal: r.cashTotal || 0,
      bankTotal: r.bankTotal || 0,
      voucherTotal: r.voucherTotal || 0,
      grandTotal: r.grandTotal || 0,
      noteCountTotal: r.noteCountTotal || 0,
      banksCount: (r.banks || []).length,
      vouchersCount: (r.vouchers || []).length,
      updatedAt: r.updatedAt || date
    };
  }).sort((a, b) => b.date.localeCompare(a.date));

  res.json(summaryList);
});

// 6.5. Get Analytics Aggregations for visual charts
app.get('/api/analytics', (req, res) => {
  const { date, range, from, to } = req.query;
  const records = getRecords();
  const settings = getSettings();
  const baseDate = date || getTodayDateStr();

  let startDate = baseDate;
  let endDate = baseDate;

  if (from && to) {
    startDate = from;
    endDate = to;
  } else if (range === '7days') {
    const endD = new Date(baseDate);
    const startD = new Date(baseDate);
    startD.setDate(startD.getDate() - 6);
    startDate = startD.toISOString().split('T')[0];
    endDate = endD.toISOString().split('T')[0];
  } else if (range === 'month') {
    const [y, m] = baseDate.split('-');
    startDate = `${y}-${m}-01`;
    const lastDay = new Date(Number(y), Number(m), 0).getDate();
    endDate = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
  } else {
    // default 'today'
    startDate = baseDate;
    endDate = baseDate;
  }

  // Filter matching records
  const matchingDates = Object.keys(records)
    .filter(d => d >= startDate && d <= endDate)
    .sort();

  let totalCash = 0;
  let totalBank = 0;
  let totalVouchers = 0;
  const noteMap = {};
  const bankMap = {};
  const voucherMap = {};
  const dailyTrend = [];

  const defaultNotes = settings.notes || [500, 200, 100, 50, 20, 10];
  defaultNotes.forEach(n => { noteMap[n] = { note: n, count: 0, amount: 0 }; });

  matchingDates.forEach(d => {
    const r = records[d];
    const cTotal = Number(r.cashTotal) || 0;
    const bTotal = Number(r.bankTotal) || 0;
    const vTotal = Number(r.voucherTotal) || 0;
    const gTotal = Number(r.grandTotal) || (cTotal + bTotal + vTotal);

    totalCash += cTotal;
    totalBank += bTotal;
    totalVouchers += vTotal;

    // notes
    (r.notes || []).forEach(n => {
      const val = Number(n.note);
      if (!noteMap[val]) noteMap[val] = { note: val, count: 0, amount: 0 };
      noteMap[val].count += (Number(n.count) || 0);
      noteMap[val].amount += (Number(n.amount) || 0);
    });

    // banks
    (r.banks || []).forEach(b => {
      const bName = (b.name || '').trim();
      if (bName) {
        if (!bankMap[bName]) bankMap[bName] = { name: bName, amount: 0 };
        bankMap[bName].amount += (Number(b.amount) || 0);
      }
    });

    // vouchers
    (r.vouchers || []).forEach(v => {
      const vName = (v.name || '').trim();
      if (vName) {
        if (!voucherMap[vName]) voucherMap[vName] = { name: vName, amount: 0 };
        voucherMap[vName].amount += (Number(v.amount) || 0);
      }
    });

    dailyTrend.push({
      date: d,
      cashTotal: cTotal,
      bankTotal: bTotal,
      voucherTotal: vTotal,
      grandTotal: gTotal
    });
  });

  const grandTotal = totalCash + totalBank + totalVouchers;

  res.json({
    success: true,
    range: range || 'today',
    startDate,
    endDate,
    recordCount: matchingDates.length,
    totalCash,
    totalBank,
    totalVouchers,
    grandTotal,
    noteTotals: Object.values(noteMap).sort((a, b) => b.note - a.note),
    bankTotals: Object.values(bankMap).sort((a, b) => b.amount - a.amount),
    voucherTotals: Object.values(voucherMap).sort((a, b) => b.amount - a.amount),
    dailyTrend
  });
});

// 7. Get record by date (or blank template based on current settings)
app.get('/api/records/:date', (req, res) => {
  const { date } = req.params;
  const records = getRecords();
  const settings = getSettings();

  const noteList = settings.notes || [500, 200, 100, 50, 20, 10];
  const bankList = settings.defaultBanks || ['IOB TRF', 'BOB TRF ', 'SBI TRF'];
  const voucherList = settings.defaultVouchers || ['MANDIRKHARCH', 'RASODAKHARCH', 'PAGAR'];

  if (records[date]) {
    const rec = records[date];
    // Map with configured master items
    const noteMap = {};
    (rec.notes || []).forEach(n => { noteMap[n.note] = n; });
    const notes = noteList.map(val => ({
      note: val,
      count: noteMap[val] ? noteMap[val].count : 0,
      amount: noteMap[val] ? noteMap[val].amount : 0
    }));

    const bankMap = {};
    const extraBanks = [];
    (rec.banks || []).forEach(b => {
      const bName = (b.name || '').trim();
      bankMap[bName.toUpperCase()] = b.amount;
      if (!bankList.some(master => master.trim().toUpperCase() === bName.toUpperCase())) {
        extraBanks.push({ name: bName, amount: Number(b.amount) || 0 });
      }
    });
    const banks = [
      ...bankList.map(name => ({
        name,
        amount: bankMap[name.trim().toUpperCase()] !== undefined ? bankMap[name.trim().toUpperCase()] : 0
      })),
      ...extraBanks
    ];

    const extraVouchers = [];
    (rec.vouchers || []).forEach(v => {
      const vName = (v.name || '').trim();
      if (!vName) return;
      if (!voucherList.some(master => isSameKhata(master, vName))) {
        const existing = extraVouchers.find(e => isSameKhata(e.name, vName));
        if (existing) {
          existing.amount = (Number(existing.amount) || 0) + (Number(v.amount) || 0);
        } else {
          extraVouchers.push({ name: vName, amount: Number(v.amount) || 0 });
        }
      }
    });
    const vouchers = [
      ...voucherList.map(masterName => {
        const matching = (rec.vouchers || []).filter(v => v && isSameKhata(v.name, masterName));
        const totalAmt = matching.reduce((sum, v) => sum + (Number(v.amount) || 0), 0);
        return {
          name: masterName,
          amount: totalAmt
        };
      }),
      ...extraVouchers
    ];

    const cashTotal = notes.reduce((s, n) => s + n.amount, 0);
    const bankTotal = banks.reduce((s, b) => s + b.amount, 0);
    const voucherTotal = vouchers.reduce((s, v) => s + v.amount, 0);

    return res.json({
      ...rec,
      expenseItems: rec.expenseItems || [],
      notes,
      cashTotal,
      noteCountTotal: notes.reduce((s, n) => s + n.count, 0),
      banks,
      bankTotal,
      vouchers,
      voucherTotal,
      grandTotal: cashTotal + bankTotal + voucherTotal
    });
  }

  // Generate blank template for this date
  const blankTemplate = {
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

  res.json(blankTemplate);
});

// 8. Save record by date (Past dates are strictly locked and cannot be edited)
app.post('/api/records/:date', (req, res) => {
  const { date } = req.params;
  const today = getTodayDateStr();

  const isPast = (date < today);

  const data = req.body;
  const records = getRecords();
  const prevRecord = records[date] ? JSON.parse(JSON.stringify(records[date])) : null;

  // Validate negative values: negative counts or amounts are strictly prohibited in accounting
  const hasNegativeNote = (data.notes || []).some(n => Number(n.count) < 0 || Number(n.amount) < 0);
  const hasNegativeBank = (data.banks || []).some(b => Number(b.amount) < 0);
  const hasNegativeVoucher = (data.vouchers || []).some(v => Number(v.amount) < 0);
  if (hasNegativeNote || hasNegativeBank || hasNegativeVoucher) {
    return res.status(400).json({ error: 'ઋણ (Negative) રકમ અથવા નોટોની સંખ્યા માન્ય નથી!' });
  }

  const notes = (data.notes || []).map(n => ({
    note: Number(n.note) || 0,
    count: Math.max(0, parseInt(n.count, 10) || 0),
    amount: (Number(n.note) || 0) * Math.max(0, parseInt(n.count, 10) || 0)
  }));
  const cashTotal = notes.reduce((s, n) => s + n.amount, 0);
  const noteCountTotal = notes.reduce((s, n) => s + n.count, 0);

  const banks = (data.banks || []).map(b => ({
    name: String(b.name || '').trim(),
    amount: Number(b.amount) || 0
  }));
  const bankTotal = banks.reduce((s, b) => s + b.amount, 0);

  // Deduplicate and aggregate incoming vouchers by isSameKhata
  const rawVouchers = (data.vouchers || []).map(v => ({
    name: String(v.name || '').trim(),
    amount: Number(v.amount) || 0
  })).filter(v => v.name);

  const deduplicatedVouchers = [];
  rawVouchers.forEach(v => {
    const existing = deduplicatedVouchers.find(d => isSameKhata(d.name, v.name));
    if (existing) {
      existing.amount = (Number(existing.amount) || 0) + (Number(v.amount) || 0);
    } else {
      deduplicatedVouchers.push({ name: v.name, amount: Number(v.amount) || 0 });
    }
  });

  const vouchers = deduplicatedVouchers;
  const voucherTotal = vouchers.reduce((s, v) => s + v.amount, 0);

  const grandTotal = cashTotal + bankTotal + voucherTotal;

  const record = {
    date,
    notes,
    cashTotal,
    noteCountTotal,
    banks,
    bankTotal,
    vouchers,
    voucherTotal,
    grandTotal,
    expenseItems: Array.isArray(data.expenseItems) ? data.expenseItems : [],
    remarks: data.remarks || '',
    updatedAt: new Date().toISOString()
  };

  records[date] = record;
  saveRecords(records);

  // Auto-reconcile Employee ledger (Pagar & Upad) for this date
  let empModified = false;
  try {
    const employees = getEmployees();
    const currentItems = record.expenseItems || [];
    const pagarVoucher = (record.vouchers || []).find(v => (v.name || '').trim().toUpperCase() === 'PAGAR');
    const pagarVoucherAmt = pagarVoucher ? Number(pagarVoucher.amount) || 0 : 0;
    const upadVoucher = (record.vouchers || []).find(v => (v.name || '').trim().toUpperCase() === 'UPAD');
    const upadVoucherAmt = upadVoucher ? Number(upadVoucher.amount) || 0 : 0;

    employees.forEach(emp => {
      // 1. Reconcile pagars on this date
      if (Array.isArray(emp.pagars)) {
        const initialPagarCount = emp.pagars.length;
        emp.pagars = emp.pagars.filter(p => {
          if (p.date !== date) return true; // keep transactions of other dates
          // If PAGAR voucher is 0 and no PAGAR expenseItems exist, clean up
          if (pagarVoucherAmt === 0 && !currentItems.some(it => (it.category || '').toUpperCase().includes('PAGAR'))) {
            return false;
          }
          // If there are expense items, check if this pagar is still present in expenseItems
          const stillInExpenses = currentItems.some(it => 
            (it.employeeId === emp.id || it.employeeName === emp.name) &&
            (it.employeeEntryId === p.id || it.id === p.expenseItemId || it.id === ('exp_' + p.id) || (Number(it.amount) === Number(p.amount) && (it.category || '').toUpperCase().includes('PAGAR')))
          );
          return stillInExpenses;
        });
        if (emp.pagars.length !== initialPagarCount) empModified = true;
      }

      // 2. Reconcile upads on this date
      if (Array.isArray(emp.upads)) {
        const initialUpadCount = emp.upads.length;
        emp.upads = emp.upads.filter(u => {
          if (u.date !== date) return true; // keep transactions of other dates
          // If UPAD voucher is 0 and no UPAD expenseItems exist, clean up
          if (upadVoucherAmt === 0 && !currentItems.some(it => (it.category || '').toUpperCase().includes('UPAD'))) {
            return false;
          }
          // If there are expense items, check if this upad is still present in expenseItems
          const stillInExpenses = currentItems.some(it => 
            (it.employeeId === emp.id || it.employeeName === emp.name) &&
            (it.employeeEntryId === u.id || it.id === u.expenseItemId || it.id === ('exp_' + u.id) || (Number(it.amount) === Number(u.amount) && (it.category || '').toUpperCase().includes('UPAD')))
          );
          return stillInExpenses;
        });
        if (emp.upads.length !== initialUpadCount) empModified = true;
      }
    });

    if (empModified) {
      saveEmployees(employees);
    }
  } catch (err) {
    console.error('Error auto-reconciling employees on record save:', err);
  }

  if (isPast || isValidAdminSession(req)) {
    const hisabChanges = [];
    if (prevRecord) {
      if ((prevRecord.cashTotal || 0) !== cashTotal) {
        hisabChanges.push({ field: 'રોકડ રકમ (Cash Total)', before: '₹' + (prevRecord.cashTotal || 0).toLocaleString('en-IN'), after: '₹' + cashTotal.toLocaleString('en-IN') });
      }
      if ((prevRecord.bankTotal || 0) !== bankTotal) {
        hisabChanges.push({ field: 'બેંક જમા (Bank Total)', before: '₹' + (prevRecord.bankTotal || 0).toLocaleString('en-IN'), after: '₹' + bankTotal.toLocaleString('en-IN') });
      }
      if ((prevRecord.voucherTotal || 0) !== voucherTotal) {
        hisabChanges.push({ field: 'વાઉચર ખર્ચ (Voucher Total)', before: '₹' + (prevRecord.voucherTotal || 0).toLocaleString('en-IN'), after: '₹' + voucherTotal.toLocaleString('en-IN') });
      }
      if ((prevRecord.grandTotal || 0) !== grandTotal) {
        hisabChanges.push({ field: 'કુલ હિસાબ (Grand Total)', before: '₹' + (prevRecord.grandTotal || 0).toLocaleString('en-IN'), after: '₹' + grandTotal.toLocaleString('en-IN') });
      }
    }
    if (hisabChanges.length === 0) {
      hisabChanges.push({ field: 'કુલ હિસાબ (Grand Total)', before: prevRecord ? ('₹' + (prevRecord.grandTotal || 0).toLocaleString('en-IN')) : 'નવો હિસાબ', after: '₹' + grandTotal.toLocaleString('en-IN') });
    }

    logAdminActivity(
      'HISAB_UPDATE',
      'HISAB',
      `તારીખ ${date} નો હિસાબ સાચવ્યો`,
      `Updated Hisab for ${date}`,
      `કુલ રકમ: ₹${grandTotal.toLocaleString('en-IN')} (રોકડ: ₹${cashTotal}, બેંક: ₹${bankTotal}, વાઉચર: ₹${voucherTotal})`,
      `Total: ₹${grandTotal.toLocaleString('en-IN')} (Cash: ₹${cashTotal}, Bank: ₹${bankTotal}, Voucher: ₹${voucherTotal})`,
      'info',
      req,
      {
        type: 'HISAB_UPDATE',
        date,
        changes: hisabChanges
      }
    );
  }

  res.json({ success: true, record, employeesUpdated: empModified });
});

// 9. Delete record (Protected - permanent financial audit trail)
app.delete('/api/records/:date', (req, res) => {
  return res.status(403).json({
    error: 'રેકોર્ડ ડિલીટ કરી શકાતો નથી.'
  });
});

// 9b. Get Expenses Report (Date to Date Filter & Analytics)
app.get('/api/expenses/report', (req, res) => {
  const { from, to, category } = req.query;
  const records = getRecords();
  const allDates = Object.keys(records).sort();

  const fromDate = from || (allDates.length > 0 ? allDates[0] : getTodayDateStr());
  const toDate = to || getTodayDateStr();

  const filteredDates = allDates.filter(d => d >= fromDate && d <= toDate);

  let allExpenses = [];
  const categoryTotals = {};

  filteredDates.forEach(date => {
    const rec = records[date];
    const diaryItems = rec.expenseItems || [];

    // If day has itemized diary entries
    if (diaryItems.length > 0) {
      diaryItems.forEach(item => {
        if (!category || category === 'all' || item.category.trim() === category.trim()) {
          allExpenses.push({
            id: item.id || `exp_${date}_${Math.random()}`,
            date,
            time: item.time || '',
            title: item.title,
            category: item.category,
            categoryType: item.categoryType || 'voucher',
            amount: Number(item.amount) || 0,
            remarks: item.remarks || ''
          });
          categoryTotals[item.category] = (categoryTotals[item.category] || 0) + (Number(item.amount) || 0);
        }
      });
    } else {
      // If no granular diary items, use the day's vouchers
      (rec.vouchers || []).forEach(v => {
        if (v.amount > 0 && (!category || category === 'all' || v.name.trim() === category.trim())) {
          allExpenses.push({
            id: `vouch_${date}_${v.name}`,
            date,
            time: '',
            title: `${v.name} (दैनिक योग)`,
            category: v.name,
            categoryType: 'voucher',
            amount: Number(v.amount) || 0,
            remarks: 'वाउचर हिसाब'
          });
          categoryTotals[v.name] = (categoryTotals[v.name] || 0) + (Number(v.amount) || 0);
        }
      });
    }
  });

  // Sort descending by date, then time
  allExpenses.sort((a, b) => b.date.localeCompare(a.date));

  const grandTotal = allExpenses.reduce((s, x) => s + x.amount, 0);
  const daysCount = Math.max(1, filteredDates.length);
  const dailyAverage = Math.round(grandTotal / daysCount);

  // Find highest spending category
  let highestCategory = { name: '-', amount: 0 };
  Object.keys(categoryTotals).forEach(cat => {
    if (categoryTotals[cat] > highestCategory.amount) {
      highestCategory = { name: cat, amount: categoryTotals[cat] };
    }
  });

  res.json({
    fromDate,
    toDate,
    daysCount,
    totalEntries: allExpenses.length,
    grandTotal,
    dailyAverage,
    highestCategory,
    categoryTotals,
    expenses: allExpenses
  });
});

// 9b-2. Get Unique Expense Names / Person Names for Autocomplete Suggestions
app.get('/api/expenses/names', (req, res) => {
  try {
    const records = getRecords();
    const namesSet = new Set();
    Object.values(records).forEach(rec => {
      (rec.expenseItems || []).forEach(item => {
        if (item.remarks && typeof item.remarks === 'string') {
          const trimmed = item.remarks.trim();
          if (trimmed && trimmed !== '-' && !trimmed.startsWith('વાઉચર હિસાબ') && !trimmed.includes('નક્કી પગાર') && !trimmed.includes('હપ્તો પતાવટ') && trimmed.length < 40) {
            namesSet.add(trimmed);
          }
        }
      });
    });
    const list = Array.from(namesSet).sort((a, b) => a.localeCompare(b, 'gu'));
    res.json({ success: true, names: list });
  } catch (e) {
    res.json({ success: true, names: [] });
  }
});

// 9c. Comprehensive Analytics & Chart Data Endpoint
app.get('/api/analytics', (req, res) => {
  const { from, to, date } = req.query;
  const records = getRecords();
  const allDates = Object.keys(records).sort();

  let targetDates = [];
  if (date) {
    targetDates = [date];
  } else if (from && to) {
    targetDates = allDates.filter(d => d >= from && d <= to);
  } else {
    // Default to all available dates (e.g. September 2026)
    targetDates = allDates;
  }

  let totalCash = 0;
  let totalBank = 0;
  let totalVouchers = 0;
  let totalGrand = 0;
  let totalNotesCount = 0;

  const noteTotals = {
    500: { count: 0, amount: 0 },
    200: { count: 0, amount: 0 },
    100: { count: 0, amount: 0 },
    50: { count: 0, amount: 0 },
    20: { count: 0, amount: 0 },
    10: { count: 0, amount: 0 }
  };
  const bankTotals = {};
  const categoryTotals = {};
  const dailyTrend = [];

  targetDates.forEach(d => {
    const r = records[d] || { cashTotal: 0, bankTotal: 0, voucherTotal: 0, grandTotal: 0 };
    totalCash += Number(r.cashTotal) || 0;
    totalBank += Number(r.bankTotal) || 0;
    totalVouchers += Number(r.voucherTotal) || 0;
    totalGrand += Number(r.grandTotal) || 0;
    totalNotesCount += Number(r.noteCountTotal) || 0;

    (r.notes || []).forEach(n => {
      if (noteTotals[n.note]) {
        noteTotals[n.note].count += Number(n.count) || 0;
        noteTotals[n.note].amount += Number(n.amount) || 0;
      }
    });

    (r.banks || []).forEach(b => {
      bankTotals[b.name] = (bankTotals[b.name] || 0) + (Number(b.amount) || 0);
    });

    (r.vouchers || []).forEach(v => {
      categoryTotals[v.name] = (categoryTotals[v.name] || 0) + (Number(v.amount) || 0);
    });

    dailyTrend.push({
      date: d,
      cashTotal: Number(r.cashTotal) || 0,
      bankTotal: Number(r.bankTotal) || 0,
      voucherTotal: Number(r.voucherTotal) || 0,
      grandTotal: Number(r.grandTotal) || 0
    });
  });

  res.json({
    success: true,
    daysCount: targetDates.length,
    fromDate: targetDates[0] || '',
    toDate: targetDates[targetDates.length - 1] || '',
    totalCash,
    totalBank,
    totalVouchers,
    totalGrand,
    totalNotesCount,
    noteTotals,
    bankTotals,
    categoryTotals,
    dailyTrend
  });
});

// 9d. Export Filtered Expenses to Excel (.xlsx)
app.get('/api/export/expenses-excel', (req, res) => {
  const { from, to, category } = req.query;
  const records = getRecords();
  const allDates = Object.keys(records).sort();

  const fromDate = from || (allDates.length > 0 ? allDates[0] : getTodayDateStr());
  const toDate = to || getTodayDateStr();

  const filteredDates = allDates.filter(d => d >= fromDate && d <= toDate);
  const settings = getSettings();

  const rows = [];
  rows.push([settings.orgName || 'સંસ્થાન', '', '', '', '']);
  rows.push([`તારીખવાર ખર્ચ હિસાબ રિપોર્ટ: ${fromDate} થી ${toDate}`, '', '', '', '']);
  rows.push(['']);
  rows.push(['ક્રમ', 'તારીખ', 'રકમ (₹)', 'ખર્ચ વિગત', 'ખાતો / મદ', 'સમય', 'નોંધ']);

  let grandTotal = 0;
  let idx = 1;

  filteredDates.forEach(date => {
    const rec = records[date];
    const diaryItems = rec.expenseItems || [];

    if (diaryItems.length > 0) {
      diaryItems.forEach(item => {
        if (!category || category === 'all' || item.category.trim() === category.trim()) {
          const amt = Number(item.amount) || 0;
          grandTotal += amt;
          rows.push([idx++, date, amt, item.title, getGujaratiKhataName(item.category), item.time || '', item.remarks || '']);
        }
      });
    } else {
      (rec.vouchers || []).forEach(v => {
        if (v.amount > 0 && (!category || category === 'all' || v.name.trim() === category.trim())) {
          const amt = Number(v.amount) || 0;
          grandTotal += amt;
          const guj = getGujaratiKhataName(v.name);
          rows.push([idx++, date, amt, `${guj} (દૈનિક યોગ)`, guj, '', 'વાઉચર હિસાબ']);
        }
      });
    }
  });

  rows.push(['']);
  rows.push(['', '', grandTotal, 'કુલ ખર્ચનો મહાસરવાળો (GRAND TOTAL)', '', '', '']);

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(rows);

  ws['!cols'] = [
    { wch: 6 },
    { wch: 14 },
    { wch: 16 },
    { wch: 34 },
    { wch: 22 },
    { wch: 12 },
    { wch: 25 }
  ];

  xlsx.utils.book_append_sheet(wb, ws, 'Expense_Report');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', `attachment; filename=Expense_Report_${fromDate}_to_${toDate}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// 9e. Export Accounting History to Excel (.xlsx)
app.get('/api/export/history-excel', (req, res) => {
  const { month, fy, mode, startDate, endDate } = req.query;
  const records = getRecords();
  const allDates = Object.keys(records).sort();
  const settings = getSettings();

  let targetDates = allDates;
  let reportLabel = 'તમામ ઇતિહાસ હિસાબ';

  if (startDate || endDate) {
    targetDates = allDates.filter(d => {
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    });
    reportLabel = `${startDate || 'શરૂઆત'} થી ${endDate || 'અંતિમ'} નો હિસાબ`;
  } else if (month) {
    targetDates = allDates.filter(d => d.startsWith(month));
    reportLabel = `${getGujaratiMonthLabel(month)} માસનો હિસાબ`;
  } else if (fy && fy !== 'all') {
    const [fyStart, fyEnd] = fy.split('-').map(Number);
    const minD = `${fyStart}-04-01`;
    const maxD = `${fyEnd}-03-31`;
    targetDates = allDates.filter(d => d >= minD && d <= maxD);
    reportLabel = `નાણાકીય વર્ષ ${fy} હિસાબ`;
  }

  const isCashMode = mode === 'cash';
  const rows = [];
  rows.push([settings.orgName || 'સંસ્થાન હિસાબ', '', '', '', '', '', '']);
  rows.push([`દૈનિક રોકડ, બેંક અને વાઉચર હિસાબ પત્રક - ${reportLabel}`, '', '', '', '', '', '']);
  rows.push(['']);

  let totCash = 0;
  let totBank = 0;
  let totVoucher = 0;
  let totGrand = 0;
  let totNotes = 0;
  let tot500 = 0, tot200 = 0, tot100 = 0, tot50 = 0, tot20 = 0, tot10 = 0;

  const allDeposits = getBankDeposits();
  let totDeposited = 0;

  if (isCashMode) {
    rows.push(['ક્રમ', 'તારીખ', '₹ 500', '₹ 200', '₹ 100', '₹ 50', '₹ 20', '₹ 10/સિક્કા', 'કુલ નોટો', 'કુલ રોકડ (₹)', 'બેંકમાં જમા રોકડ વિગત']);
    targetDates.forEach((date, i) => {
      const rec = records[date];
      const notes = rec.notes || [];
      const getC = (v) => {
        const found = notes.find(n => Number(n.note) === v);
        return found ? found.count : 0;
      };
      const c500 = getC(500), c200 = getC(200), c100 = getC(100), c50 = getC(50), c20 = getC(20), c10 = getC(10);
      const nCount = rec.noteCountTotal || (c500 + c200 + c100 + c50 + c20 + c10);
      const cAmt = Number(rec.cashTotal) || 0;

      tot500 += c500; tot200 += c200; tot100 += c100; tot50 += c50; tot20 += c20; tot10 += c10;
      totNotes += nCount;
      totCash += cAmt;

      const depList = allDeposits.filter(d => d.depositDate === date);
      let depText = '-';
      if (depList.length > 0) {
        depText = depList.map(d => `${d.bankName || 'બેંક'}: ₹${Number(d.amount).toLocaleString('en-IN')} (${d.fromDate} થી ${d.toDate} - ${d.daysCount || '-'} દિવસ)`).join(' | ');
        depList.forEach(d => { totDeposited += Number(d.amount) || 0; });
      }

      rows.push([i + 1, date, c500, c200, c100, c50, c20, c10, nCount, cAmt, depText]);
    });

    rows.push(['']);
    rows.push(['', 'કુલ સરવાળો', tot500, tot200, tot100, tot50, tot20, tot10, totNotes, totCash, `કુલ બેંક જમા: ₹${totDeposited.toLocaleString('en-IN')}`]);
  } else {
    rows.push(['ક્રમ', 'તારીખ', 'રોકડ રકમ (₹)', 'બેંક ટ્રાન્સફર (₹)', 'વાઉચર ખર્ચ (₹)', 'બેંકમાં જમા રોકડ વિગત (કઈ બેંક & ગાળો)', 'કુલ સરવાળો (₹)']);
    targetDates.forEach((date, i) => {
      const rec = records[date];
      const cAmt = Number(rec.cashTotal) || 0;
      const bAmt = Number(rec.bankTotal) || 0;
      const vAmt = Number(rec.voucherTotal) || 0;
      const gAmt = Number(rec.grandTotal) || (cAmt + bAmt + vAmt);

      totCash += cAmt;
      totBank += bAmt;
      totVoucher += vAmt;
      totGrand += gAmt;

      const depList = allDeposits.filter(d => d.depositDate === date);
      let depText = '-';
      if (depList.length > 0) {
        depText = depList.map(d => `${d.bankName || 'બેંક'}: ₹${Number(d.amount).toLocaleString('en-IN')} (${d.fromDate} થી ${d.toDate} - ${d.daysCount || '-'} દિવસ)`).join(' | ');
        depList.forEach(d => { totDeposited += Number(d.amount) || 0; });
      }

      rows.push([i + 1, date, cAmt, bAmt, vAmt, depText, gAmt]);
    });

    rows.push(['']);
    rows.push(['', 'કુલ સરવાળો', totCash, totBank, totVoucher, `કુલ બેંક જમા: ₹${totDeposited.toLocaleString('en-IN')}`, totGrand]);
  }

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(rows);

  ws['!cols'] = isCashMode
    ? [{ wch: 6 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 42 }]
    : [{ wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 45 }, { wch: 20 }];

  xlsx.utils.book_append_sheet(wb, ws, 'Hisab_History');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const safeLabel = (month || fy || 'All').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename=Hisab_History_${safeLabel}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// =========================================================================
// EMPLOYEE & SALARY / UPAD MANAGEMENT APIs
// =========================================================================

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

function getDefaultSalaryMonth(dateStr = null) {
  const dStr = dateStr || getTodayDateStr();
  return dStr.slice(0, 7);
}

// Robust Staff Salary & Upad Balance Engine (With opening balance carry-forward, absent deduction, unclamped balance)
function calculateEmployeeBalances(emp, targetMonth = null) {
  const currentMonth = targetMonth || getDefaultSalaryMonth();
  const salary = Number(emp.salary) || 0;
  const upads = emp.upads || [];
  const pagars = emp.pagars || [];

  // Sort chronologically ascending for timeline calculation
  const sortedUpads = [...upads].sort((a, b) => ((a.date || '') + (a.time || '')).localeCompare((b.date || '') + (b.time || '')));
  const sortedPagars = [...pagars].sort((a, b) => ((a.date || '') + (a.time || '')).localeCompare((b.date || '') + (b.time || '')));

  // Collect all distinct months
  const allMonthsSet = new Set();
  sortedUpads.forEach(u => {
    const m = u.forMonth || (u.date ? u.date.slice(0, 7) : '');
    if (m) allMonthsSet.add(m);
  });
  sortedPagars.forEach(p => {
    const m = p.forMonth || (p.date ? p.date.slice(0, 7) : '');
    if (m) allMonthsSet.add(m);
  });
  if (currentMonth) allMonthsSet.add(currentMonth);

  // Determine starting month for automatic continuous tracking
  // To avoid phantom debts for years prior to software adoption, start from either salaryStartMonth,
  // or joiningDate if >= '2026-07', or earliest transaction month
  let startMonth = emp.salaryStartMonth || null;
  if (!startMonth) {
    if (emp.joiningDate && emp.joiningDate >= '2026-07') {
      startMonth = emp.joiningDate.slice(0, 7);
    } else {
      const transMonths = Array.from(allMonthsSet).sort();
      startMonth = transMonths[0] || currentMonth;
    }
  }

  // Ensure continuous monthly sequence from startMonth to currentMonth
  if (startMonth && startMonth <= currentMonth) {
    let cur = startMonth;
    while (cur <= currentMonth) {
      allMonthsSet.add(cur);
      const parts = cur.split('-').map(Number);
      const nextM = parts[1] === 12 ? 1 : parts[1] + 1;
      const nextY = parts[1] === 12 ? parts[0] + 1 : parts[0];
      cur = `${nextY}-${String(nextM).padStart(2, '0')}`;
    }
  }

  const sortedMonths = Array.from(allMonthsSet).sort();

  let runningOpeningBalance = Number(emp.initialBalance) || 0;
  let targetOpeningBalance = 0;
  let targetEarnedSalary = salary;
  let targetMonthUpad = 0;
  let targetMonthPagarPaid = 0;
  let targetAbsentDays = 0;
  let targetAbsentDeduction = 0;
  let targetTotalDays = 30;

  const monthlyHistory = [];

  for (const m of sortedMonths) {
    const mUpads = sortedUpads.filter(u => (u.forMonth || (u.date ? u.date.slice(0, 7) : '')) === m);
    const mPagars = sortedPagars.filter(p => (p.forMonth || (p.date ? p.date.slice(0, 7) : '')) === m);

    const mUpadTotal = mUpads.reduce((s, u) => s + (Number(u.amount) || 0), 0);
    const mPagarTotal = mPagars.reduce((s, p) => s + (Number(p.amount) || 0), 0);

    let mAbsentDays = 0;
    let mAbsentDeduction = 0;
    let mTotalDays = 30;
    mPagars.forEach(p => {
      if (p.absentDays) mAbsentDays += Number(p.absentDays) || 0;
      if (p.absentDeduction) mAbsentDeduction += Number(p.absentDeduction) || 0;
      if (p.totalMonthDays) mTotalDays = Number(p.totalMonthDays) || 30;
    });

    const mEarnedSalary = Math.max(0, salary - mAbsentDeduction);
    const mOpening = runningOpeningBalance;
    // Closing = Opening + Earned Salary - Upads - Pagars Paid
    const mClosing = mOpening + mEarnedSalary - mUpadTotal - mPagarTotal;

    monthlyHistory.push({
      month: m,
      monthLabel: getGujaratiMonthLabel(m),
      openingBalance: mOpening,
      salary,
      totalMonthDays: mTotalDays,
      absentDays: mAbsentDays,
      absentDeduction: mAbsentDeduction,
      earnedSalary: mEarnedSalary,
      upadTotal: mUpadTotal,
      pagarTotal: mPagarTotal,
      closingBalance: mClosing,
      upadsCount: mUpads.length,
      pagarsCount: mPagars.length
    });

    if (m === currentMonth) {
      targetOpeningBalance = mOpening;
      targetEarnedSalary = mEarnedSalary;
      targetMonthUpad = mUpadTotal;
      targetMonthPagarPaid = mPagarTotal;
      targetAbsentDays = mAbsentDays;
      targetAbsentDeduction = mAbsentDeduction;
      targetTotalDays = mTotalDays;
    }

    runningOpeningBalance = mClosing;
  }

  // True net balance for currentMonth
  // Net balance = opening balance from past months + earned salary of this month - upad of this month - pagar paid of this month
  const netBalance = targetOpeningBalance + targetEarnedSalary - targetMonthUpad - targetMonthPagarPaid;

  const totalUpadAllTime = upads.reduce((s, u) => s + (Number(u.amount) || 0), 0);
  const totalPagarPaidAllTime = pagars.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  // Sort descending by date for ledger display
  const sortedUpadsDesc = [...upads].sort((a, b) => ((b.date || '') + (b.time || '')).localeCompare((a.date || '') + (a.time || '')));
  const sortedPagarsDesc = [...pagars].sort((a, b) => ((b.date || '') + (b.time || '')).localeCompare((a.date || '') + (a.time || '')));

  return {
    ...emp,
    paymentType: emp.paymentType || 'monthly',
    paymentMode: emp.paymentMode === 'bank' ? 'bank' : 'cash',
    salary,
    currentMonth,
    currentMonthLabel: getGujaratiMonthLabel(currentMonth),
    openingBalance: targetOpeningBalance, // અગાઉના મહિનાઓની બાકી (+ એટલે ચૂકવવાપાત્ર, - એટલે એડવાન્સ/ઉપાડ જમા)
    absentDays: targetAbsentDays,
    absentDeduction: targetAbsentDeduction,
    totalMonthDays: targetTotalDays,
    earnedSalary: targetEarnedSalary,
    currentMonthUpad: targetMonthUpad,
    currentMonthPagarPaid: targetMonthPagarPaid,
    totalUpadAllTime,
    totalPagarPaidAllTime,
    netBalance, // Can be positive (Payable), negative (Advance/Overdrawn), or zero (Settled)
    upads: sortedUpadsDesc,
    pagars: sortedPagarsDesc,
    upadsCount: upads.length,
    monthUpadsCount: upads.filter(u => (u.forMonth || (u.date ? u.date.slice(0, 7) : '')) === currentMonth).length,
    pagarsCount: pagars.length,
    monthPagarsCount: pagars.filter(p => (p.forMonth || (p.date ? p.date.slice(0, 7) : '')) === currentMonth).length,
    monthlyHistory
  };
}

// 9d. Get all employees with calculated salary, upad, pagar and net balance
app.get('/api/employees', (req, res) => {
  const employees = getEmployees();
  const currentMonth = req.query.month || getDefaultSalaryMonth(); // 'YYYY-MM'

  const enriched = employees.map(emp => calculateEmployeeBalances(emp, currentMonth));

  const cashEmployees = enriched.filter(e => (e.paymentMode || 'cash') !== 'bank');
  const bankEmployees = enriched.filter(e => e.paymentMode === 'bank');

  const totalPayroll = enriched.reduce((s, e) => s + (e.salary || 0), 0);
  const totalCashPayroll = cashEmployees.reduce((s, e) => s + (e.salary || 0), 0);
  const totalBankPayroll = bankEmployees.reduce((s, e) => s + (e.salary || 0), 0);

  const totalOpeningBalance = cashEmployees.reduce((s, e) => s + (e.openingBalance || 0), 0);
  const totalMonthUpad = enriched.reduce((s, e) => s + (e.currentMonthUpad || 0), 0);
  const totalCashMonthUpad = cashEmployees.reduce((s, e) => s + (e.currentMonthUpad || 0), 0);
  const totalBankMonthUpad = bankEmployees.reduce((s, e) => s + (e.currentMonthUpad || 0), 0);
  const totalMonthPagarPaid = cashEmployees.reduce((s, e) => s + (e.currentMonthPagarPaid || 0), 0);
  const totalNetPayable = cashEmployees.reduce((s, e) => s + (e.netBalance > 0 ? e.netBalance : 0), 0);
  const totalNetAdvance = cashEmployees.reduce((s, e) => s + (e.netBalance < 0 ? Math.abs(e.netBalance) : 0), 0);

  res.json({
    success: true,
    currentMonth,
    currentMonthLabel: getGujaratiMonthLabel(currentMonth),
    summary: {
      totalEmployees: enriched.length,
      totalCashEmployees: cashEmployees.length,
      totalBankEmployees: bankEmployees.length,
      totalPayroll,
      totalCashPayroll,
      totalBankPayroll,
      totalOpeningBalance,
      totalMonthUpad,
      totalCashMonthUpad,
      totalBankMonthUpad,
      totalMonthPagarPaid,
      totalNetPayable,
      totalNetAdvance
    },
    employees: enriched
  });
});

// 9e. Add New Employee
app.post('/api/employees', (req, res) => {
  const { name, role, phone, salary, joiningDate, paymentType, paymentMode } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'કર્મચારીનું નામ જરૂરી છે (Employee name is required)' });
  }

  const cleanPaymentType = paymentType === '15days' ? '15days' : 'monthly';
  const cleanPaymentMode = paymentMode === 'bank' ? 'bank' : 'cash';
  const employees = getEmployees();
  const newEmp = {
    id: 'emp_' + Date.now(),
    name: name.trim(),
    role: (role || 'સ્ટાફ').trim(),
    phone: (phone || '').trim(),
    salary: Number(salary) || 0,
    paymentType: cleanPaymentType,
    paymentMode: cleanPaymentMode,
    joiningDate: joiningDate || getTodayDateStr(),
    status: 'active',
    upads: [],
    pagars: []
  };

  employees.push(newEmp);
  saveEmployees(employees);
  logAdminActivity(
    'STAFF_ADD',
    'STAFF',
    `નવો કર્મચારી ઉમેર્યો: ${newEmp.name}`,
    `Added Staff Member: ${newEmp.name}`,
    `હોદ્દો: ${newEmp.role}, પદ્ધતિ: ${cleanPaymentMode === 'bank' ? '🏦 બેંક' : '💵 રોકડ'}, પ્રકાર: ${cleanPaymentType === '15days' ? '૧૫ દિવસીય ચૂકવણી' : 'માસિક ચૂકવણી'}, પગાર: ₹${newEmp.salary}`,
    `Role: ${newEmp.role}, Mode: ${cleanPaymentMode === 'bank' ? 'Bank' : 'Cash'}, Type: ${cleanPaymentType === '15days' ? '15-Day' : 'Monthly'}, Salary: ₹${newEmp.salary}`,
    'success',
    req
  );
  res.json({ success: true, employee: newEmp });
});

// 9f. Update Employee
app.put('/api/employees/:id', (req, res) => {
  const { id } = req.params;
  const { name, role, phone, salary, paymentType, paymentMode, joiningDate, status, pagars, upads, monthlyHistory } = req.body;
  const employees = getEmployees();
  const emp = employees.find(e => e.id === id);

  if (!emp) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી (Employee not found)' });
  }

  const oldEmp = {
    name: emp.name,
    role: emp.role,
    phone: emp.phone,
    salary: emp.salary,
    paymentType: emp.paymentType || 'monthly',
    paymentMode: emp.paymentMode || 'cash',
    status: emp.status
  };

  const staffChanges = [];
  if (name !== undefined && name.trim() !== oldEmp.name) {
    staffChanges.push({ field: 'નામ (Name)', before: oldEmp.name, after: name.trim() });
    emp.name = name.trim();
  }
  if (role !== undefined && role.trim() !== oldEmp.role) {
    staffChanges.push({ field: 'હોદ્દો (Role)', before: oldEmp.role, after: role.trim() });
    emp.role = role.trim();
  }
  if (phone !== undefined && phone.trim() !== oldEmp.phone) {
    staffChanges.push({ field: 'ફોન (Phone)', before: oldEmp.phone || 'ખાલી', after: phone.trim() || 'ખાલી' });
    emp.phone = phone.trim();
  }
  if (salary !== undefined && Number(salary) !== oldEmp.salary) {
    staffChanges.push({ field: 'પગાર (Salary)', before: '₹' + oldEmp.salary, after: '₹' + Number(salary) });
    emp.salary = Number(salary) || 0;
  }
  if (paymentType !== undefined) {
    const cleanPaymentType = paymentType === '15days' ? '15days' : 'monthly';
    if (cleanPaymentType !== oldEmp.paymentType) {
      staffChanges.push({
        field: 'ચૂકવણી પ્રકાર (Payment Type)',
        before: oldEmp.paymentType === '15days' ? '૧૫ દિવસીય (15-Day)' : 'માસિક (Monthly)',
        after: cleanPaymentType === '15days' ? '૧૫ દિવસીય (15-Day)' : 'માસિક (Monthly)'
      });
    }
    emp.paymentType = cleanPaymentType;
  }
  if (paymentMode !== undefined) {
    const cleanPaymentMode = paymentMode === 'bank' ? 'bank' : 'cash';
    if (cleanPaymentMode !== oldEmp.paymentMode) {
      staffChanges.push({
        field: 'ચૂકવણી પદ્ધતિ (Payment Mode)',
        before: oldEmp.paymentMode === 'bank' ? '🏦 બેંક ટ્રાન્સફર' : '💵 રોકડ ચુકવણી',
        after: cleanPaymentMode === 'bank' ? '🏦 બેંક ટ્રાન્સફર' : '💵 રોકડ ચુકવણી'
      });
    }
    emp.paymentMode = cleanPaymentMode;
  }
  if (joiningDate !== undefined && joiningDate !== emp.joiningDate) {
    staffChanges.push({ field: 'જોડાવાની તારીખ', before: emp.joiningDate || '-', after: joiningDate });
    emp.joiningDate = joiningDate;
  }
  if (status !== undefined && status !== oldEmp.status) {
    staffChanges.push({ field: 'સ્થિતિ (Status)', before: oldEmp.status === 'active' ? 'Active (ચાલુ)' : 'Inactive (બંધ)', after: status === 'active' ? 'Active (ચાલુ)' : 'Inactive (બંધ)' });
    emp.status = status;
  }
  if (Array.isArray(pagars)) emp.pagars = pagars;
  if (Array.isArray(upads)) emp.upads = upads;
  if (Array.isArray(monthlyHistory)) emp.monthlyHistory = monthlyHistory;

  if (staffChanges.length === 0) {
    staffChanges.push({ field: 'કર્મચારી પ્રોફાઇલ', before: 'જૂની વિગત', after: 'અપડેટ કરી' });
  }

  saveEmployees(employees);
  logAdminActivity(
    'STAFF_UPDATE',
    'STAFF',
    `કર્મચારી વિગત અપડેટ: ${emp.name}`,
    `Updated Staff: ${emp.name}`,
    `હોદ્દો: ${emp.role}, પ્રકાર: ${emp.paymentType === '15days' ? '૧૫ દિવસીય' : 'માસિક'}, સ્થિતિ: ${emp.status}, પગાર: ₹${emp.salary}`,
    `Role: ${emp.role}, Type: ${emp.paymentType === '15days' ? '15-Day' : 'Monthly'}, Status: ${emp.status}, Salary: ₹${emp.salary}`,
    'info',
    req,
    {
      type: 'STAFF_UPDATE',
      staffName: emp.name,
      changes: staffChanges
    }
  );
  res.json({ success: true, employee: emp });
});

// 9g. Delete Employee
app.delete('/api/employees/:id', (req, res) => {
  const { id } = req.params;
  let employees = getEmployees();
  const initialLen = employees.length;
  const targetEmp = employees.find(e => e.id === id);
  employees = employees.filter(e => e.id !== id);

  if (employees.length === initialLen) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી' });
  }

  saveEmployees(employees);
  logAdminActivity(
    'STAFF_DELETE',
    'STAFF',
    `કર્મચારી કાઢી નાખ્યો: ${targetEmp ? targetEmp.name : id}`,
    `Deleted Staff Member: ${targetEmp ? targetEmp.name : id}`,
    `કર્મચારી રેકોર્ડ સફળતાપૂર્વક હટાવી દેવામાં આવ્યો`,
    `Staff record successfully removed from system`,
    'warning',
    req
  );
  res.json({ success: true, message: 'કર્મચારી કાઢી નાખવામાં આવ્યો છે.' });
});

// 9h. Add Upad (Advance) to Employee and sync with Daily Expense & UPAD voucher
app.post('/api/employees/:id/upad', (req, res) => {
  const { id } = req.params;
  const { amount, title, remarks, date, time, forMonth, addToHisab } = req.body;

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'સાચી રકમ લખો (Valid amount required)' });
  }

  const employees = getEmployees();
  const emp = employees.find(e => e.id === id);
  if (!emp) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી' });
  }

  const upadDate = date || getTodayDateStr();
  const today = getTodayDateStr();
  if (upadDate < today && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${upadDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં ઉપાડ આપવા માટે એડમિન પિન જરૂરી છે.`,
      isLocked: true,
      sessionRequired: true
    });
  }
  const upadTime = time || getTodayTimeStr();
  const upadForMonth = forMonth || upadDate.slice(0, 7);
  const monthLabel = getGujaratiMonthLabel(upadForMonth);
  const upadTitle = (title || 'ઉપાડ').trim();
  const upadRemarks = (remarks || '').trim();

  const upadId = 'upd_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

  const newUpad = {
    id: upadId,
    date: upadDate,
    time: upadTime,
    forMonth: upadForMonth,
    amount: amt,
    title: upadTitle,
    remarks: upadRemarks,
    expenseItemId: req.body.expenseItemId || ('exp_' + upadId)
  };

  if (!Array.isArray(emp.upads)) emp.upads = [];
  emp.upads.unshift(newUpad);
  saveEmployees(employees);

  // If addToHisab is true, record in records.json under UPAD
  if (addToHisab !== false) {
    const records = getRecords();
    let rec = records[upadDate];
    if (!rec) {
      rec = createBlankRecord(upadDate, getSettings());
      records[upadDate] = rec;
    }

    if (!Array.isArray(rec.expenseItems)) rec.expenseItems = [];
    const itemTitle = `${emp.name} - ${monthLabel} માસનો ઉપાડ${upadTitle && upadTitle !== 'ઉપાડ' && upadTitle !== `${emp.name} ઉપાડ` ? ` (${upadTitle})` : ''}`;
    rec.expenseItems.unshift({
      id: 'exp_' + upadId,
      time: upadTime,
      title: itemTitle,
      amount: amt,
      category: 'UPAD',
      categoryType: 'voucher',
      employeeId: emp.id,
      employeeName: emp.name,
      employeeEntryId: upadId,
      forMonth: upadForMonth,
      remarks: upadRemarks
    });

    // Auto-increase UPAD voucher
    let upadVoucher = (rec.vouchers || []).find(v => v.name.trim() === 'UPAD');
    if (upadVoucher) {
      upadVoucher.amount = (Number(upadVoucher.amount) || 0) + amt;
    } else {
      rec.vouchers.push({ name: 'UPAD', amount: amt });
    }

    rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
    rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
    rec.updatedAt = new Date().toISOString();
    saveRecords(records);
  }

  res.json({ success: true, upad: newUpad, employee: emp });
});

// 9i. Delete Upad from Employee
app.delete('/api/employees/:id/upad/:upadId', (req, res) => {
  const { id, upadId } = req.params;
  const employees = getEmployees();
  const emp = employees.find(e => e.id === id);
  if (!emp) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી' });
  }

  const idx = (emp.upads || []).findIndex(u => u.id === upadId);
  if (idx === -1) {
    return res.status(404).json({ error: 'ઉપાડ એન્ટ્રી મળી નથી' });
  }

  const targetUpad = emp.upads[idx];
  const isPast = targetUpad.date < getTodayDateStr();
  if (isPast && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${targetUpad.date} નો હિસાબ લૉક છે! પાછલી તારીખની એન્ટ્રી કાઢવા માટે એડમિન પિન જરૂરી છે.`,
      sessionRequired: true,
      isLocked: true
    });
  }

  const removed = emp.upads.splice(idx, 1)[0];
  saveEmployees(employees);

  // Two-way sync: Also clean up from daily records if present!
  try {
    const records = getRecords();
    const rec = records[removed.date];
    if (rec && Array.isArray(rec.expenseItems)) {
      const eIdx = rec.expenseItems.findIndex(e => 
        (e.employeeId === id) &&
        (e.id === ('exp_' + upadId) || e.id === removed.expenseItemId || (Number(e.amount) === Number(removed.amount) && (e.category || '').toUpperCase().includes('UPAD')))
      );
      if (eIdx !== -1) {
        rec.expenseItems.splice(eIdx, 1);
        const catSums = {};
        rec.expenseItems.forEach(it => {
          const k = (it.category || '').trim().toUpperCase();
          catSums[k] = (catSums[k] || 0) + (Number(it.amount) || 0);
        });
        (rec.vouchers || []).forEach(v => {
          const vKey = (v.name || '').trim().toUpperCase();
          if (vKey === 'UPAD' || catSums[vKey] !== undefined) {
            v.amount = catSums[vKey] || 0;
          }
        });
        rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
        rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
        rec.updatedAt = new Date().toISOString();
        saveRecords(records);
      }
    }
  } catch (err) {
    console.error('Error syncing employee upad deletion to daily records:', err);
  }

  res.json({ success: true, removed, employee: emp });
});

// 9j. Add Pagar (Salary Payment) to Employee and sync with Daily Expense & PAGAR voucher
app.post('/api/employees/:id/pagar', (req, res) => {
  const { id } = req.params;
  const { 
    amount, 
    title, 
    remarks, 
    date, 
    time, 
    forMonth, 
    addToHisab,
    totalMonthDays,
    absentDays,
    absentDeduction,
    earnedSalary,
    openingBalance,
    upadDeduction
  } = req.body;

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'સાચી રકમ લખો (Valid amount required)' });
  }

  const employees = getEmployees();
  const emp = employees.find(e => e.id === id);
  if (!emp) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી' });
  }

  const is15Days = emp.paymentType === '15days';
  const pagarDate = date || getTodayDateStr();
  const today = getTodayDateStr();
  if (pagarDate < today && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${pagarDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં પગાર ચૂકવવા માટે એડમિન પિન જરૂરી છે.`,
      isLocked: true,
      sessionRequired: true
    });
  }
  const pagarTime = time || getTodayTimeStr();
  const pagarForMonth = forMonth || pagarDate.slice(0, 7);
  const monthLabel = getGujaratiMonthLabel(pagarForMonth);
  const defaultTitle = is15Days ? '૧૫ દિવસનો પગાર' : `${monthLabel} માસનો પગાર`;
  const pagarTitle = (title || defaultTitle).trim();
  
  // Construct detailed auto-remarks for complete accounting transparency
  const autoRemarksParts = [];
  autoRemarksParts.push(is15Days ? `૧૫ દિવસીય પગાર: ₹${emp.salary || 0}` : `માસિક પગાર: ₹${emp.salary || 0}`);
  if (absentDays > 0) {
    autoRemarksParts.push(`ગેરહાજર: ${absentDays} દિવસ (-₹${absentDeduction || 0})`);
  }
  if (openingBalance) {
    autoRemarksParts.push(`જૂની બાકી: ${openingBalance > 0 ? '+' : ''}₹${openingBalance}`);
  }
  if (upadDeduction > 0) {
    autoRemarksParts.push(`ઉપાડ કપાત: -₹${upadDeduction}`);
  }
  autoRemarksParts.push(`ચૂકવેલ ચોખ્ખો પગાર: ₹${amt}`);
  if (remarks && remarks.trim()) {
    autoRemarksParts.push(`(${remarks.trim()})`);
  }
  const pagarRemarks = autoRemarksParts.join(' | ');

  const pagarId = 'pgr_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

  const newPagar = {
    id: pagarId,
    date: pagarDate,
    time: pagarTime,
    forMonth: pagarForMonth,
    fromDate: req.body.fromDate || null,
    toDate: req.body.toDate || null,
    amount: amt,
    title: pagarTitle,
    remarks: pagarRemarks,
    totalMonthDays: Number(totalMonthDays) || (is15Days ? 15 : 30),
    absentDays: Number(absentDays) || 0,
    absentDeduction: Number(absentDeduction) || 0,
    earnedSalary: Number(earnedSalary) || (emp.salary - (Number(absentDeduction) || 0)),
    openingBalance: Number(openingBalance) || 0,
    upadDeduction: Number(upadDeduction) || 0,
    expenseItemId: req.body.expenseItemId || ('exp_' + pagarId)
  };

  if (!Array.isArray(emp.pagars)) emp.pagars = [];
  emp.pagars.unshift(newPagar);
  saveEmployees(employees);

  // If addToHisab is true, record in records.json under PAGAR voucher ONLY for CASH employees (Bank employees are never added to daily voucher!)
  const isBankEmp = (emp.paymentMode === 'bank');
  if (addToHisab !== false && !isBankEmp) {
    const records = getRecords();
    let rec = records[pagarDate];
    if (!rec) {
      rec = createBlankRecord(pagarDate, getSettings());
      records[pagarDate] = rec;
    }

    if (!Array.isArray(rec.expenseItems)) rec.expenseItems = [];
    const itemTitle = (pagarTitle && pagarTitle.trim())
      ? `${pagarTitle}${absentDays > 0 ? ` (${absentDays} દિ. કપાત)` : ''}`
      : (is15Days
        ? `${emp.name} - ૧૫ દિવસનો પગાર${absentDays > 0 ? ` (${absentDays} દિ. કપાત)` : ''}`
        : `${emp.name} - ${monthLabel} માસનો પગાર${absentDays > 0 ? ` (${absentDays} દિ. કપાત)` : ''}`);
    rec.expenseItems.unshift({
      id: 'exp_' + pagarId,
      time: pagarTime,
      title: itemTitle,
      amount: amt,
      category: 'PAGAR',
      categoryType: 'voucher',
      employeeId: emp.id,
      employeeName: emp.name,
      employeeEntryId: pagarId,
      forMonth: pagarForMonth,
      remarks: pagarRemarks
    });

    // Auto-increase PAGAR voucher
    let pagarVoucher = (rec.vouchers || []).find(v => v.name.trim() === 'PAGAR');
    if (pagarVoucher) {
      pagarVoucher.amount = (Number(pagarVoucher.amount) || 0) + amt;
    } else {
      rec.vouchers.push({ name: 'PAGAR', amount: amt });
    }

    rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
    rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
    rec.updatedAt = new Date().toISOString();
    saveRecords(records);
  }

  res.json({ success: true, pagar: newPagar, employee: emp, isBank: isBankEmp });
});

// 9j-2. Bulk Pagar Payout (Selected or All employees pagar charged to kharch)
app.post('/api/employees/bulk-pagar', (req, res) => {
  const { items, date, time, forMonth, addToHisab } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'કોઈ કર્મચારી પસંદ કરેલ નથી' });
  }

  const employees = getEmployees();
  const pagarDate = date || getTodayDateStr();
  const today = getTodayDateStr();
  if (pagarDate < today && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${pagarDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં જથ્થાબંધ પગાર ચૂકવવા માટે એડમિન પિન જરૂરી છે.`,
      isLocked: true,
      sessionRequired: true
    });
  }
  const pagarTime = time || getTodayTimeStr();
  const bulkMonth = forMonth || pagarDate.slice(0, 7);
  const monthLabel = getGujaratiMonthLabel(bulkMonth);
  let totalBulkAmount = 0;
  const processedItems = [];

  items.forEach(item => {
    const emp = employees.find(e => e.id === (item.id || item.employeeId));
    const amt = Number(item.amount);
    if (emp && !isNaN(amt) && amt > 0) {
      const is15 = emp.paymentType === '15days';
      const isBank = (emp.paymentMode === 'bank');
      const pagarId = 'pgr_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      const defaultTitle = is15 ? `${emp.name} - ૧૫ દિવસનો પગાર` : `${emp.name} - ${monthLabel} માસનો પગાર`;
      const pagarTitle = (item.title || defaultTitle).trim();
      const pagarRemarks = (item.remarks || '').trim();

      const newPagar = {
        id: pagarId,
        date: pagarDate,
        time: pagarTime,
        forMonth: bulkMonth,
        amount: amt,
        title: pagarTitle,
        remarks: pagarRemarks,
        expenseItemId: 'exp_' + pagarId
      };

      if (!Array.isArray(emp.pagars)) emp.pagars = [];
      emp.pagars.unshift(newPagar);

      if (!isBank) {
        totalBulkAmount += amt;
      }

      processedItems.push({
        pagarId,
        empId: emp.id,
        empName: emp.name,
        amount: amt,
        isBank,
        title: pagarTitle,
        remarks: pagarRemarks
      });
    }
  });

  if (processedItems.length === 0) {
    return res.status(400).json({ error: 'કોઈ માન્ય પગાર રકમ મળી નથી' });
  }

  saveEmployees(employees);

  // If addToHisab is true, record ONLY CASH employees under PAGAR voucher (Bank employees are never added to voucher)
  if (addToHisab !== false && totalBulkAmount > 0) {
    const records = getRecords();
    let rec = records[pagarDate];
    if (!rec) {
      rec = createBlankRecord(pagarDate, getSettings());
      records[pagarDate] = rec;
    }

    if (!Array.isArray(rec.expenseItems)) rec.expenseItems = [];
    processedItems.filter(p => !p.isBank).forEach(p => {
      rec.expenseItems.unshift({
        id: 'exp_' + p.pagarId,
        time: pagarTime,
        title: p.title,
        amount: p.amount,
        category: 'PAGAR',
        categoryType: 'voucher',
        employeeId: p.empId,
        employeeName: p.empName,
        forMonth: bulkMonth,
        remarks: p.remarks
      });
    });

    // Auto-increase PAGAR voucher
    let pagarVoucher = (rec.vouchers || []).find(v => v.name.trim() === 'PAGAR');
    if (pagarVoucher) {
      pagarVoucher.amount = (Number(pagarVoucher.amount) || 0) + totalBulkAmount;
    } else {
      rec.vouchers.push({ name: 'PAGAR', amount: totalBulkAmount });
    }

    rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
    rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
    rec.updatedAt = new Date().toISOString();
    saveRecords(records);
  }

  res.json({
    success: true,
    count: processedItems.length,
    totalPaid: totalBulkAmount,
    forMonth: bulkMonth,
    monthLabel,
    items: processedItems
  });
});

// 9k. Delete Pagar payment from Employee
app.delete('/api/employees/:id/pagar/:pagarId', (req, res) => {
  const { id, pagarId } = req.params;
  const employees = getEmployees();
  const emp = employees.find(e => e.id === id);
  if (!emp) {
    return res.status(404).json({ error: 'કર્મચારી મળ્યો નથી' });
  }

  const idx = (emp.pagars || []).findIndex(p => p.id === pagarId);
  if (idx === -1) {
    return res.status(404).json({ error: 'પગાર ચૂકવણી એન્ટ્રી મળી નથી' });
  }

  const targetPagar = emp.pagars[idx];
  const isPast = targetPagar.date < getTodayDateStr();
  if (isPast && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${targetPagar.date} નો હિસાબ લૉક છે! પાછલી તારીખની એન્ટ્રી કાઢવા માટે એડમિન પિન જરૂરી છે.`,
      sessionRequired: true,
      isLocked: true
    });
  }

  const removed = emp.pagars.splice(idx, 1)[0];
  saveEmployees(employees);

  // Two-way sync: Also clean up from daily records if present!
  try {
    const records = getRecords();
    const rec = records[removed.date];
    if (rec && Array.isArray(rec.expenseItems)) {
      const eIdx = rec.expenseItems.findIndex(e => 
        (e.employeeId === id) &&
        (e.id === ('exp_' + pagarId) || e.id === removed.expenseItemId || (Number(e.amount) === Number(removed.amount) && (e.category || '').toUpperCase().includes('PAGAR')))
      );
      if (eIdx !== -1) {
        rec.expenseItems.splice(eIdx, 1);
        const catSums = {};
        rec.expenseItems.forEach(it => {
          const k = (it.category || '').trim().toUpperCase();
          catSums[k] = (catSums[k] || 0) + (Number(it.amount) || 0);
        });
        (rec.vouchers || []).forEach(v => {
          const vKey = (v.name || '').trim().toUpperCase();
          if (vKey === 'PAGAR' || catSums[vKey] !== undefined) {
            v.amount = catSums[vKey] || 0;
          }
        });
        rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
        rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
        rec.updatedAt = new Date().toISOString();
        saveRecords(records);
      }
    }
  } catch (err) {
    console.error('Error syncing employee pagar deletion to daily records:', err);
  }

  res.json({ success: true, removed, employee: emp });
});

// =========================================================================
// UCHAK / ADVANCE & VOUCHER SETTLEMENT MANAGEMENT APIs
// =========================================================================

// 1. Get all uchak records with statistics
app.get('/api/uchak', (req, res) => {
  const items = getUchakRecords();
  // Ensure default remainingAmount and installments for backward compatibility
  items.forEach(x => {
    if (x.remainingAmount === undefined) {
      x.remainingAmount = x.status === 'settled' ? 0 : (Number(x.givenAmount) || 0);
    }
    if (!Array.isArray(x.installments)) {
      x.installments = [];
    }
  });

  // Sort descending by givenDate and createdAt
  items.sort((a, b) => (b.givenDate + (b.createdAt || '')).localeCompare(a.givenDate + (a.createdAt || '')));

  const totalPendingItems = items.filter(x => x.status === 'pending' || x.status === 'partial');
  const totalSettledItems = items.filter(x => x.status === 'settled');

  const totalPendingAmount = totalPendingItems.reduce((s, x) => s + (Number(x.remainingAmount !== undefined ? x.remainingAmount : x.givenAmount) || 0), 0);
  const totalGivenAllTime = items.reduce((s, x) => s + (Number(x.givenAmount) || 0), 0);
  
  const totalVoucherAllTime = items.reduce((s, x) => {
    let v = 0;
    if (x.settlement && x.settlement.voucherAmount) v += Number(x.settlement.voucherAmount) || 0;
    if (Array.isArray(x.installments)) {
      x.installments.forEach(inst => { v += Number(inst.voucherAmount) || 0; });
    }
    return s + v;
  }, 0);

  const totalCashReturnedAllTime = items.reduce((s, x) => {
    let c = 0;
    if (x.settlement && x.settlement.cashReturned) c += Number(x.settlement.cashReturned) || 0;
    if (Array.isArray(x.installments)) {
      x.installments.forEach(inst => { c += Number(inst.cashReturned) || 0; });
    }
    return s + c;
  }, 0);

  res.json({
    items,
    summary: {
      totalCount: items.length,
      pendingCount: totalPendingItems.length,
      settledCount: totalSettledItems.length,
      totalPendingAmount,
      totalGivenAllTime,
      totalVoucherAllTime,
      totalCashReturnedAllTime
    }
  });
});

// 2. Add new uchak entry (Does NOT add to expense! Remains pure Uchak advance)
app.post('/api/uchak', (req, res) => {
  const { personName, phone, purpose, givenDate, givenTime, givenAmount, remarks, employeeId } = req.body;

  if (!personName || !personName.trim()) {
    return res.status(400).json({ error: 'વ્યક્તિનું નામ લખવું જરૂરી છે' });
  }

  const amt = Number(givenAmount !== undefined ? givenAmount : req.body.amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'સાચી ઉચક રકમ લખો (Valid amount required)' });
  }

  const items = getUchakRecords();
  const id = 'uchak_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

  // Auto-detect employeeId if not explicitly provided
  let matchedEmpId = employeeId || null;
  if (!matchedEmpId) {
    try {
      const employees = getEmployees();
      const pNameLower = personName.trim().toLowerCase();
      const matched = employees.find(e => {
        const eNameLower = (e.name || '').trim().toLowerCase();
        return eNameLower === pNameLower ||
          pNameLower.includes(eNameLower) ||
          eNameLower.includes(pNameLower);
      });
      if (matched) {
        matchedEmpId = matched.id;
      }
    } catch (e) {
      console.error('Error auto-detecting employee for uchak:', e);
    }
  }

  const uDate = givenDate || getTodayDateStr();
  const today = getTodayDateStr();
  if (uDate < today && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${uDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં ઉચક આપવા માટે એડમિન પિન જરૂરી છે.`,
      isLocked: true,
      sessionRequired: true
    });
  }

  const newEntry = {
    id,
    employeeId: matchedEmpId,
    personName: personName.trim(),
    phone: (phone || '').trim(),
    purpose: (purpose || 'પરચૂરણ કામ માટે ઉચક').trim(),
    givenDate: uDate,
    givenTime: givenTime || getTodayTimeStr(),
    givenAmount: amt,
    remainingAmount: amt,
    installments: [],
    remarks: (remarks || '').trim(),
    status: 'pending', // 'pending' | 'partial' | 'settled'
    settlement: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  items.unshift(newEntry);
  saveUchakRecords(items);

  res.json({ success: true, item: newEntry });
});

// 3. Settle uchak (Partial or full settlement: cash returned OR voucher bill submitted)
app.post('/api/uchak/:id/settle', (req, res) => {
  const { id } = req.params;
  const {
    settledDate,
    settledTime,
    settleType, // 'voucher' | 'all_cash_returned' | 'extra_paid' | 'partial_voucher' | 'partial_cash'
    voucherAmount,
    voucherCategory,
    voucherTitle,
    cashReturned,
    extraPaid,
    notes,
    remarks,
    addToHisab,
    employeeId,
    employeeName,
    forMonth,
    isFinalSettlement
  } = req.body;

  const items = getUchakRecords();
  const entry = items.find(x => x.id === id);
  if (!entry) {
    return res.status(404).json({ error: 'ઉચક નોંધ મળી નથી' });
  }

  if (entry.remainingAmount === undefined) {
    entry.remainingAmount = entry.status === 'settled' ? 0 : (Number(entry.givenAmount) || 0);
  }
  if (!Array.isArray(entry.installments)) {
    entry.installments = [];
  }

  const currentRemaining = Number(entry.remainingAmount);
  let vAmt = Math.max(0, Number(voucherAmount) || 0);
  let cRet = Math.max(0, Number(cashReturned) || 0);
  const sDate = settledDate || getTodayDateStr();
  const today = getTodayDateStr();
  if (sDate < today && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${sDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં ઉચક જમા/સેટલ કરવા માટે એડમિન પિન જરૂરી છે.`,
      isLocked: true,
      sessionRequired: true
    });
  }
  const sTime = settledTime || getTodayTimeStr();
  let extra = Math.max(0, Number(extraPaid) || 0);

  if (settleType === 'all_cash_returned') {
    cRet = currentRemaining;
    vAmt = 0;
    extra = 0;
  }

  let clearedAmt = vAmt + cRet;
  let newRemaining = 0;

  if (extra > 0 || (vAmt > currentRemaining && settleType === 'extra_paid')) {
    if (extra === 0) extra = vAmt - currentRemaining;
    clearedAmt = currentRemaining;
    newRemaining = 0;
  } else {
    newRemaining = Math.max(0, currentRemaining - clearedAmt);
  }

  const isFullySettled = Boolean(isFinalSettlement || newRemaining === 0 || settleType === 'all_cash_returned' || extra > 0);

  let expenseItemId = null;
  const shouldAddToHisab = vAmt > 0 && addToHisab !== false;
  const userRemark = (remarks || notes || '').trim();

  if (shouldAddToHisab) {
    const records = getRecords();
    let rec = records[sDate];
    if (!rec) {
      rec = createBlankRecord(sDate, getSettings());
      records[sDate] = rec;
    }

    if (!Array.isArray(rec.expenseItems)) rec.expenseItems = [];
    expenseItemId = 'exp_' + entry.id + '_' + Date.now() + '_' + Math.floor(Math.random() * 100);
    const finalTitle = (voucherTitle || `${entry.personName} - ઉચક પતાવટ (${entry.purpose || 'ખર્ચ'})`).trim();
    const catName = (voucherCategory || 'MANDIRKHARCH').trim();
    const targetMonth = forMonth || sDate.slice(0, 7);

    rec.expenseItems.unshift({
      id: expenseItemId,
      time: sTime,
      title: finalTitle,
      amount: vAmt,
      category: catName,
      categoryType: 'voucher',
      uchakId: entry.id,
      employeeId: employeeId || null,
      employeeName: employeeName || null,
      forMonth: targetMonth,
      remarks: userRemark
    });

    let vObj = (rec.vouchers || []).find(v => v.name.trim() === catName);
    if (vObj) {
      vObj.amount = (Number(vObj.amount) || 0) + vAmt;
    } else {
      rec.vouchers.push({ name: catName, amount: vAmt });
    }

    rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
    rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
    rec.updatedAt = new Date().toISOString();
    saveRecords(records);

    // If an employee is linked and category is PAGAR or UPAD, sync with employee ledger
    if (employeeId && (catName === 'PAGAR' || catName === 'UPAD')) {
      try {
        const employees = getEmployees();
        const emp = employees.find(e => e.id === employeeId);
        if (emp) {
          if (catName === 'PAGAR') {
            if (!Array.isArray(emp.pagars)) emp.pagars = [];
            emp.pagars.unshift({
              id: 'pgr_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
              date: sDate,
              time: sTime,
              forMonth: targetMonth,
              amount: vAmt,
              title: finalTitle,
              remarks: userRemark
            });
          } else {
            if (!Array.isArray(emp.upads)) emp.upads = [];
            emp.upads.unshift({
              id: 'upd_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
              date: sDate,
              time: sTime,
              forMonth: targetMonth,
              amount: vAmt,
              title: finalTitle,
              remarks: userRemark
            });
          }
          saveEmployees(employees);
        }
      } catch (e) {
        console.error('Error syncing uchak voucher to employee ledger:', e);
      }
    }
  }

  const installmentRecord = {
    id: 'inst_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    settledDate: sDate,
    settledTime: sTime,
    settleType: settleType || (vAmt === 0 ? 'all_cash_returned' : (cRet > 0 ? 'voucher_and_cash' : 'voucher_only')),
    voucherAmount: vAmt,
    voucherCategory: voucherCategory || '',
    voucherTitle: (voucherTitle || '').trim(),
    cashReturned: cRet,
    extraPaid: extra,
    clearedAmount: clearedAmt,
    remainingBefore: currentRemaining,
    remainingAfter: newRemaining,
    notes: userRemark,
    remarks: userRemark,
    employeeId: employeeId || null,
    employeeName: employeeName || null,
    forMonth: forMonth || null,
    addedToHisab: shouldAddToHisab,
    expenseItemId: expenseItemId,
    createdAt: new Date().toISOString()
  };

  entry.installments.push(installmentRecord);
  entry.remainingAmount = newRemaining;
  entry.status = isFullySettled ? 'settled' : 'partial';

  // For backward compatibility with legacy views
  entry.settlement = installmentRecord;
  entry.updatedAt = new Date().toISOString();

  saveUchakRecords(items);
  res.json({ success: true, item: entry, installment: installmentRecord });
});

// 4. Unsettle / Re-open uchak (Reverts the last installment or full settlement)
app.post('/api/uchak/:id/unsettle', (req, res) => {
  const { id } = req.params;
  const items = getUchakRecords();
  const entry = items.find(x => x.id === id);
  if (!entry) {
    return res.status(404).json({ error: 'ઉચક નોંધ મળી નથી' });
  }

  // If there are installments, remove the last installment
  let removedInst = null;
  if (Array.isArray(entry.installments) && entry.installments.length > 0) {
    removedInst = entry.installments.pop();
  } else if (entry.settlement) {
    removedInst = entry.settlement;
    entry.settlement = null;
  }

  // Clean up removed installment from daily hisab if applicable
  if (removedInst && removedInst.expenseItemId && removedInst.addedToHisab) {
    try {
      const records = getRecords();
      const prevDate = removedInst.settledDate;
      const rec = records[prevDate];
      if (rec && Array.isArray(rec.expenseItems)) {
        const idx = rec.expenseItems.findIndex(e => e.id === removedInst.expenseItemId);
        if (idx !== -1) {
          rec.expenseItems.splice(idx, 1);
          const cat = removedInst.voucherCategory;
          const vObj = (rec.vouchers || []).find(v => v.name.trim() === cat.trim());
          if (vObj) {
            vObj.amount = Math.max(0, (Number(vObj.amount) || 0) - (Number(removedInst.voucherAmount) || 0));
          }
          rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
          rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
          rec.updatedAt = new Date().toISOString();
          saveRecords(records);
        }
      }
    } catch (e) {
      console.error('Error removing settlement voucher during unsettle:', e);
    }
  }

  // Recalculate remainingAmount
  if (Array.isArray(entry.installments) && entry.installments.length > 0) {
    const totalCleared = entry.installments.reduce((s, inst) => s + (Number(inst.clearedAmount) || 0), 0);
    entry.remainingAmount = Math.max(0, (Number(entry.givenAmount) || 0) - totalCleared);
    entry.status = entry.remainingAmount === 0 ? 'settled' : 'partial';
    entry.settlement = entry.installments[entry.installments.length - 1];
  } else {
    entry.remainingAmount = Number(entry.givenAmount) || 0;
    entry.status = 'pending';
    entry.settlement = null;
    entry.installments = [];
  }

  entry.updatedAt = new Date().toISOString();
  saveUchakRecords(items);
  res.json({ success: true, item: entry });
});

// 5. Delete uchak entry
app.delete('/api/uchak/:id', (req, res) => {
  const { id } = req.params;
  const items = getUchakRecords();
  const idx = items.findIndex(x => x.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'ઉચક નોંધ મળી નથી' });
  }

  const removed = items.splice(idx, 1)[0];

  // Clean up all expense items created by all installments or legacy settlement
  const allExpenseItemsToClean = [];
  if (Array.isArray(removed.installments)) {
    removed.installments.forEach(inst => {
      if (inst.expenseItemId && inst.addedToHisab) {
        allExpenseItemsToClean.push({ id: inst.expenseItemId, date: inst.settledDate, cat: inst.voucherCategory, amt: inst.voucherAmount });
      }
    });
  }
  if (removed.settlement && removed.settlement.expenseItemId && removed.settlement.addedToHisab) {
    allExpenseItemsToClean.push({ id: removed.settlement.expenseItemId, date: removed.settlement.settledDate, cat: removed.settlement.voucherCategory, amt: removed.settlement.voucherAmount });
  }

  if (allExpenseItemsToClean.length > 0) {
    try {
      const records = getRecords();
      let changed = false;
      allExpenseItemsToClean.forEach(itemToClean => {
        const rec = records[itemToClean.date];
        if (rec && Array.isArray(rec.expenseItems)) {
          const eIdx = rec.expenseItems.findIndex(e => e.id === itemToClean.id);
          if (eIdx !== -1) {
            rec.expenseItems.splice(eIdx, 1);
            const vObj = (rec.vouchers || []).find(v => v.name.trim() === itemToClean.cat.trim());
            if (vObj) {
              vObj.amount = Math.max(0, (Number(vObj.amount) || 0) - (Number(itemToClean.amt) || 0));
            }
            rec.voucherTotal = (rec.vouchers || []).reduce((s, v) => s + (Number(v.amount) || 0), 0);
            rec.grandTotal = (rec.cashTotal || 0) + (rec.bankTotal || 0) + rec.voucherTotal;
            rec.updatedAt = new Date().toISOString();
            changed = true;
          }
        }
      });
      if (changed) saveRecords(records);
    } catch (e) {
      console.error('Error cleaning up daily hisab on uchak deletion:', e);
    }
  }

  saveUchakRecords(items);
  res.json({ success: true, removed });
});

// =========================================================================
// BANK CASH DEPOSIT & UNBANKED ROLLING CASH TRACKER APIs
// =========================================================================

// Helper date math functions
function addDaysToStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 1. Get Bank Deposits & Multi-Bank Accumulation Summary
app.get('/api/bank-deposits', (req, res) => {
  const activeDate = req.query.date || getTodayDateStr();
  const deposits = getBankDeposits();
  const settings = getSettings();
  const records = getRecords();

  const allRecordDates = Object.keys(records).sort();

  // Sort deposits ascending (oldest first) to evaluate fully settled periods sequentially
  const sortedDepositsAsc = [...deposits].sort((a, b) =>
    ((a.createdAt || a.depositDate) + (a.id || '')).localeCompare((b.createdAt || b.depositDate) + (b.id || ''))
  );

  let unbankedFromDate = (allRecordDates.length > 0 ? allRecordDates[0] : activeDate);

  // Evaluate fully settled periods to determine unbankedFromDate
  const checkedPeriods = new Set();
  for (const dep of sortedDepositsAsc) {
    const depFrom = dep.fromDate;
    const depTo = dep.toDate;
    const key = `${depFrom}_${depTo}`;

    if (depFrom && depTo && depFrom >= unbankedFromDate && !checkedPeriods.has(key)) {
      checkedPeriods.add(key);

      let cashInPeriod = 0;
      let curD = depFrom;
      while (curD <= depTo) {
        cashInPeriod += Number(records[curD] ? records[curD].cashTotal : 0) || 0;
        curD = addDaysToStr(curD, 1);
      }

      let totalDepForPeriod = 0;
      sortedDepositsAsc.forEach(d => {
        if (d.fromDate === depFrom && d.toDate === depTo) {
          totalDepForPeriod += Number(d.amount) || 0;
        }
      });

      // Period is fully settled if total deposited is >= total cash in period (even if cash was 0)
      if (totalDepForPeriod >= cashInPeriod) {
        const nextStart = addDaysToStr(depTo, 1);
        if (nextStart > unbankedFromDate) {
          unbankedFromDate = nextStart;
        }
      }
    }
  }

  let accumulatedCashTotal = 0;
  let accumulatedDaysCount = 0;
  let accumulatedNoteCount = 0;
  const noteTotals = {
    500: { count: 0, amount: 0 },
    200: { count: 0, amount: 0 },
    100: { count: 0, amount: 0 },
    50: { count: 0, amount: 0 },
    20: { count: 0, amount: 0 },
    10: { count: 0, amount: 0 }
  };
  const dailyBreakdown = [];

  // Exclude activeDate (current date) as requested ("current date ka hisab nahi ginana hain")
  // Iterate through EVERY calendar day from unbankedFromDate up to the day before activeDate.
  // Even if a day has 0 cash (or no notes entered), it MUST be included and counted (0 ganatri)!
  const lastUnbankedDate = addDaysToStr(activeDate, -1);
  let dayCursor = unbankedFromDate;

  while (dayCursor <= lastUnbankedDate) {
    const rec = records[dayCursor];
    const cTotal = Number(rec ? rec.cashTotal : 0) || 0;
    const nCount = Number(rec ? rec.noteCountTotal : 0) || 0;
    accumulatedCashTotal += cTotal;
    accumulatedDaysCount++;
    accumulatedNoteCount += nCount;

    const dayNotes = rec && Array.isArray(rec.notes) ? rec.notes : [];
    dayNotes.forEach(n => {
      const val = Number(n.note);
      if (noteTotals[val]) {
        noteTotals[val].count += Number(n.count) || 0;
        noteTotals[val].amount += Number(n.amount) || 0;
      }
    });

    dailyBreakdown.push({
      date: dayCursor,
      cashTotal: cTotal,
      noteCountTotal: nCount,
      notes: dayNotes
    });

    dayCursor = addDaysToStr(dayCursor, 1);
  }

  const unbankedToDate = lastUnbankedDate >= unbankedFromDate ? lastUnbankedDate : unbankedFromDate;

  // Calculate total bank deposits recorded for this current unbanked period
  let periodDepositedTotal = 0;
  const periodDepositsList = [];
  deposits.forEach(dep => {
    const depFrom = dep.fromDate || dep.depositDate;
    if (depFrom >= unbankedFromDate && dep.depositDate <= activeDate) {
      periodDepositedTotal += Number(dep.amount) || 0;
      periodDepositsList.push(dep);
    }
  });

  const remainingCashToBank = Math.max(0, accumulatedCashTotal - periodDepositedTotal);

  // Sort deposits descending for display
  deposits.sort((a, b) => (b.depositDate + (b.createdAt || '')).localeCompare(a.depositDate + (a.createdAt || '')));
  const lastDeposit = deposits[0] || null;

  res.json({
    deposits,
    lastDeposit,
    unbankedSummary: {
      activeDate,
      lastDepositDate: lastDeposit ? lastDeposit.depositDate : null,
      lastDepositBank: lastDeposit ? lastDeposit.bankName : null,
      lastDepositAmount: lastDeposit ? lastDeposit.amount : 0,
      unbankedFromDate,
      unbankedToDate,
      accumulatedDaysCount,
      accumulatedCashTotal,
      accumulatedNoteCount,
      periodDepositedTotal,
      periodDepositsCount: periodDepositsList.length,
      periodDepositsList,
      remainingCashToBank,
      noteTotals,
      dailyBreakdown
    },
    availableBanks: settings.defaultBanks || ['IOB TRF', 'BOB TRF ', 'SBI TRF']
  });
});

// 2. Save new Bank Cash Deposit
app.post('/api/bank-deposits', (req, res) => {
  const { depositDate, bankName, amount, slipNo, remarks, fromDate, toDate, daysCount } = req.body;

  if (!bankName || !bankName.trim()) {
    return res.status(400).json({ error: 'કૃપા કરીને બેંકનું નામ પસંદ કરો' });
  }
  const amt = Number(amount);
  if (isNaN(amt) || amt < 0) {
    return res.status(400).json({ error: 'કૃપા કરીને માન્ય જમા રકમ દાખલ કરો' });
  }

  const deposits = getBankDeposits();
  const dDate = depositDate || getTodayDateStr();

  const newDeposit = {
    id: 'dep_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    depositDate: dDate,
    bankName: bankName.trim(),
    amount: amt,
    fromDate: fromDate || dDate,
    toDate: toDate || dDate,
    daysCount: Number(daysCount) || 1,
    slipNo: (slipNo || '').trim(),
    remarks: (remarks || '').trim(),
    createdAt: new Date().toISOString()
  };

  deposits.unshift(newDeposit);
  saveBankDeposits(deposits);

  res.json({ success: true, deposit: newDeposit });
});

// 3. Delete a Bank Cash Deposit (Requires Admin PIN / Password)
app.delete('/api/bank-deposits/:id', (req, res) => {
  const { id } = req.params;
  const pin = (req.body && req.body.pin) || req.headers['x-admin-pin'] || req.query.pin;
  const settings = getSettings();
  const currentPin = settings.adminPin || '1234';

  const isSessionValid = isValidAdminSession(req);
  const isPinValid = pin && String(pin).trim() === String(currentPin).trim();

  if (!isSessionValid && !isPinValid) {
    return res.status(401).json({
      success: false,
      error: 'ખોટો એડમિન પાસવર્ડ! બેંક જમા નોંધ રદ કરવા માટે સાચો એડમિન પાસવર્ડ જરૂરી છે.'
    });
  }

  const deposits = getBankDeposits();
  const idx = deposits.findIndex(d => d.id === id);

  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'બેંક જમા નોંધ મળી નથી' });
  }

  const removed = deposits.splice(idx, 1)[0];
  saveBankDeposits(deposits);

  res.json({ success: true, removed });
});

// Helper for Excel/Print English Khata Name (matching PDF layout exactly)
const GUJ_TO_ENG_KHATA_MAP = {
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
  'પ્રસાદી': 'PRASADI'
};

function getEnglishKhataNameServer(name) {
  if (!name) return '';
  const trimmed = String(name).trim();
  if (GUJ_TO_ENG_KHATA_MAP[trimmed]) return GUJ_TO_ENG_KHATA_MAP[trimmed];
  return trimmed.toUpperCase();
}

// 10. Export record as Excel (.xlsx) matching exact PDF / HISAB print layout
app.get(['/api/export/excel/:date', '/api/export/excel/:date/:filename'], (req, res) => {
  const { date } = req.params;
  const records = getRecords();
  const settings = getSettings();
  let record = records[date];

  if (!record) {
    record = createBlankRecord(date, settings);
  }

  const wb = xlsx.utils.book_new();
  const rows = [];
  const merges = [];

  const orgName = settings.orgName || 'HISAB REPORT';
  rows.push(['', orgName, date]);
  rows.push(['', '', '']);
  rows.push(['NOTE', 'COUNT', 'AMOUNT']);

  // Note Denominations (500, 200, 100, 50, 20, 10)
  (record.notes || []).forEach(n => {
    rows.push([Number(n.note) || 0, Number(n.count) || 0, Number(n.amount) || 0]);
  });

  // CASH TOTAL row (Col A & B merged, amount in Col C)
  const cashTotalRow = rows.length;
  rows.push(['CASH TOTAL', '', Number(record.cashTotal) || 0]);
  merges.push({ s: { r: cashTotalRow, c: 0 }, e: { r: cashTotalRow, c: 1 } });

  // Spacer Row
  rows.push(['', '', '']);

  // BANK Section (3 rows minimum, Col A merged with 'BANK')
  const bankStartRow = rows.length;
  const banks = record.banks || [];
  const bankRowCount = Math.max(banks.length, 3);
  for (let i = 0; i < bankRowCount; i++) {
    const b = banks[i];
    const bName = b && b.name ? getEnglishKhataNameServer(b.name) : '';
    const bAmt = b && Number(b.amount) > 0 ? Number(b.amount) : (b ? 0 : '');
    rows.push([i === 0 ? 'BANK' : '', bName, bAmt]);
  }
  const bankEndRow = rows.length - 1;
  merges.push({ s: { r: bankStartRow, c: 0 }, e: { r: bankEndRow, c: 0 } });

  // BANK TOTAL row (Col A & B merged)
  const bankTotalRow = rows.length;
  rows.push(['BANK TOTAL', '', Number(record.bankTotal) || 0]);
  merges.push({ s: { r: bankTotalRow, c: 0 }, e: { r: bankTotalRow, c: 1 } });

  // Spacer Row
  rows.push(['', '', '']);

  // VOUCHER Section (9 rows minimum, Col A merged with 'VOUCHER')
  const voucherStartRow = rows.length;
  const allVouchers = record.vouchers || [];
  const activeVouchers = allVouchers.filter(v => Number(v.amount) > 0);
  const vRowCount = Math.max(activeVouchers.length, 9);
  for (let i = 0; i < vRowCount; i++) {
    const v = activeVouchers[i];
    const vName = v ? getEnglishKhataNameServer(v.name) : '';
    const vAmt = v && Number(v.amount) > 0 ? Number(v.amount) : '';
    rows.push([i === 0 ? 'VOUCHER' : '', vName, vAmt]);
  }
  const voucherEndRow = rows.length - 1;
  merges.push({ s: { r: voucherStartRow, c: 0 }, e: { r: voucherEndRow, c: 0 } });

  // VOUCHER TOTAL row (Col A & B merged)
  const voucherTotalRow = rows.length;
  rows.push(['VOUCHER TOTAL', '', Number(record.voucherTotal) || 0]);
  merges.push({ s: { r: voucherTotalRow, c: 0 }, e: { r: voucherTotalRow, c: 1 } });

  // TOTAL / GRAND TOTAL row (Col A & B merged)
  const grandTotalRow = rows.length;
  rows.push(['TOTAL', '', Number(record.grandTotal) || 0]);
  merges.push({ s: { r: grandTotalRow, c: 0 }, e: { r: grandTotalRow, c: 1 } });

  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 18 }, { wch: 28 }, { wch: 18 }];
  ws['!merges'] = merges;
  xlsx.utils.book_append_sheet(wb, ws, 'Daily Hisab');

  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `HISAB_${date}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
});

// 11. Import Excel file (.xlsx / .xlsm)
app.post('/api/import/excel', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const wb = xlsx.readFile(filePath);
    const sheetName = wb.Sheets['Sheet1'] ? 'Sheet1' : wb.SheetNames[0];
    const s = wb.Sheets[sheetName];

    if (!s) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Valid sheet not found in file' });
    }

    const settings = getSettings();
    const noteList = settings.notes || [500, 200, 100, 50, 20, 10];

    const notes = [
      { note: 500, count: s['E28'] ? Number(s['E28'].v) || 0 : 0, amount: s['F28'] ? Number(s['F28'].v) || 0 : 0 },
      { note: 200, count: s['E29'] ? Number(s['E29'].v) || 0 : 0, amount: s['F29'] ? Number(s['F29'].v) || 0 : 0 },
      { note: 100, count: s['E30'] ? Number(s['E30'].v) || 0 : 0, amount: s['F30'] ? Number(s['F30'].v) || 0 : 0 },
      { note: 50, count: s['E31'] ? Number(s['E31'].v) || 0 : 0, amount: s['F31'] ? Number(s['F31'].v) || 0 : 0 },
      { note: 20, count: s['E32'] ? Number(s['E32'].v) || 0 : 0, amount: s['F32'] ? Number(s['F32'].v) || 0 : 0 },
      { note: 10, count: s['E33'] ? Number(s['E33'].v) || 0 : 0, amount: s['F33'] ? Number(s['F33'].v) || 0 : 0 },
    ];

    const banks = [];
    for (let r = 36; r <= 38; r++) {
      const name = s['E' + r] ? s['E' + r].v : undefined;
      const amt = (s['F' + r] ? Number(s['F' + r].v) : 0) || 0;
      if (name && String(name).trim()) {
        banks.push({ name: String(name).trim(), amount: amt });
      }
    }

    const vouchers = [];
    for (let r = 41; r <= 43; r++) {
      const name = s['E' + r] ? s['E' + r].v : undefined;
      const amt = (s['F' + r] ? Number(s['F' + r].v) : 0) || 0;
      if (name && String(name).trim()) {
        vouchers.push({ name: String(name).trim(), amount: amt });
      }
    }

    const cashTotal = notes.reduce((sum, n) => sum + (n.note * n.count), 0);
    const bankTotal = banks.reduce((sum, b) => sum + b.amount, 0);
    const voucherTotal = vouchers.reduce((sum, v) => sum + v.amount, 0);
    const grandTotal = cashTotal + bankTotal + voucherTotal;

    const targetDate = req.body.date || getTodayDateStr();

    const importedRecord = {
      date: targetDate,
      notes,
      cashTotal,
      noteCountTotal: notes.reduce((s, n) => s + n.count, 0),
      banks,
      bankTotal,
      vouchers,
      voucherTotal,
      grandTotal,
      remarks: `Imported from ${req.file.originalname}`,
      updatedAt: new Date().toISOString()
    };

    const records = getRecords();
    records[targetDate] = importedRecord;
    saveRecords(records);

    fs.unlinkSync(filePath);
    res.json({ success: true, record: importedRecord });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to import Excel file: ' + err.message });
  }
});

// 12. Save PDF / Report to local disk
app.post('/api/save-report', (req, res) => {
  const { date, htmlContent } = req.body;
  const settings = getSettings();
  const folder = settings.exportFolder || 'D:\\Account Report';

  let targetFolder = folder;
  try {
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }
  } catch (e) {
    targetFolder = REPORTS_DIR;
  }

  const filename = `${date}.html`;
  const filePath = path.join(targetFolder, filename);

  try {
    fs.writeFileSync(filePath, htmlContent, 'utf8');
    res.json({ success: true, path: filePath, folder: targetFolder });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save report: ' + err.message });
  }
});

// =========================================================================
// AI VOICE COMMAND PARSER & MULTI-INTENT ENGINE
// =========================================================================
function parseSingleVoiceText(text, activeDate = getTodayDateStr(), forcedType = null) {
  const raw = text.toLowerCase().trim();

  // 0. Check if user is asking for summary query (e.g. "aaj no hisab", "ketla rs thaya", "summary")
  const isSummaryQuery = raw.includes('હિસાબ') || raw.includes('hisab') || raw.includes('કેટલા') || raw.includes('ketla') || raw.includes('summary') || raw.includes('કુલ') || raw.includes('total');
  if (isSummaryQuery && !raw.match(/\b\d+[\d,]*\b/)) {
    return { isQuery: true, queryType: 'summary', date: activeDate, rawText: text };
  }

  // 1. Extract Amount
  let amount = 0;
  const numMatch = text.match(/\b\d+[\d,]*\b/);
  if (numMatch) {
    amount = parseInt(numMatch[0].replace(/,/g, ''), 10);
  } else {
    if (raw.includes('એક હજાર') || raw.includes('ek hazar') || raw.includes('one thousand')) amount = 1000;
    else if (raw.includes('બે હજાર') || raw.includes('do hazar') || raw.includes('two thousand')) amount = 2000;
    else if (raw.includes('ત્રણ હજાર') || raw.includes('teen hazar') || raw.includes('three thousand')) amount = 3000;
    else if (raw.includes('ચાર હજાર') || raw.includes('char hazar')) amount = 4000;
    else if (raw.includes('પાંચ હજાર') || raw.includes('panch hazar') || raw.includes('paanch hazar')) amount = 5000;
    else if (raw.includes('દસ હજાર') || raw.includes('das hazar')) amount = 10000;
    else if (raw.includes('પાંચસો') || raw.includes('panchso')) amount = 500;
    else if (raw.includes('બસો') || raw.includes('banso')) amount = 200;
    else if (raw.includes('સો') || raw.includes('so')) amount = 100;
  }

  // 2. Identify Intent / Type
  let type = forcedType || 'voucher';
  if (!forcedType) {
    const isExplicitUchak = raw.includes('ઉચક') || raw.includes('uchak') || raw.includes('ઓચક') || raw.includes('peticash') || raw.includes('petty cash') || raw.includes('અગાઉથી');
    const isExplicitUpad = raw.includes('ઉપાડ') || raw.includes('upad') || raw.includes('પગાર') || raw.includes('pagar') || raw.includes('salary');

    if (isExplicitUchak) {
      type = 'uchak';
    } else if (isExplicitUpad) {
      type = 'upad';
    } else {
      type = 'voucher'; // Default to Voucher expense
    }
  }

  // 3. Extract Name / Title / Category
  let personName = '';
  let itemTitle = '';
  let category = 'MANDIRKHARCH';

  if (type === 'uchak') {
    let cleaned = text
      .replace(/\b\d+[\d,]*\b/gi, '')
      .replace(/\b(ઉચક|uchak|ઓચક|રૂપિયા|રૂ|rs|rupees|લઈ|ગયા|ગયેલ|આપ્યા|અને|ને|તેના|માટે|લેવા|lay|gaya|laya|gaye|aapa|aapiya|apya)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    personName = cleaned || 'અજ્ઞાત (Voice AI)';
  } else if (type === 'upad') {
    let cleaned = text
      .replace(/\b\d+[\d,]*\b/gi, '')
      .replace(/\b(ઉપાડ|upad|પગાર|pagar|salary|રૂપિયા|રૂ|rs|rupees|લઈ|ગયા|આપ્યા|ને|તેના|માટે|લેવા|lay|gaya|laya|gaye|aapa|apya)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    personName = cleaned || 'કર્મચારી (Voice AI)';
  } else {
    let cleaned = text
      .replace(/\b\d+[\d,]*\b/gi, '')
      .replace(/વાઉચર|voucher|વાઉચરમાં|રૂપિયા|રૂ\.|રૂ|rs|rupees|આવી|આવ્યા|આપ્યા|થયા|થઈ|ગયા/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    itemTitle = cleaned || 'વાઉચર ખર્ચ';

    // Intelligent Auto Categorization
    if (raw.includes('રસોડા') || raw.includes('rasoda') || raw.includes('ખાવાના') || raw.includes('શાકભાજી') || raw.includes('દૂધ') || raw.includes('ઘી') || raw.includes('કરિયાણું') || raw.includes('ચાય') || raw.includes('ચા') || raw.includes('તેલ')) {
      category = 'RASODAKHARCH';
    } else if (raw.includes('પગાર') || raw.includes('pagar') || raw.includes('સાન')) {
      category = 'PAGAR';
    } else {
      category = 'MANDIRKHARCH';
    }
  }

  return {
    rawText: text,
    type,
    amount,
    personName,
    itemTitle,
    category,
    date: activeDate
  };
}

app.post('/api/ai/parse-voice', (req, res) => {
  const { text, date, autoExecute = true, forcedType = null } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'કોઈ અવાજ અથવા લખાણ મળ્યું નથી' });
  }

  const targetDate = date || getTodayDateStr();

  // Check multi-command split (e.g., "1000 rs ni pani bottle ane kaushik uchak 2000 lay gaya")
  const phrases = text.split(/\b(?:અને|પછી|તથા|and|ane)\b/gi).map(s => s.trim()).filter(Boolean);

  const results = [];
  let summaryQueryObj = null;

  for (const phrase of phrases) {
    const parsed = parseSingleVoiceText(phrase, targetDate, forcedType);

    if (parsed.isQuery) {
      const records = getRecords();
      const rec = records[targetDate] || { cashTotal: 0, bankTotal: 0, voucherTotal: 0, grandTotal: 0 };
      summaryQueryObj = {
        isQuery: true,
        date: targetDate,
        cashTotal: rec.cashTotal || 0,
        bankTotal: rec.bankTotal || 0,
        voucherTotal: rec.voucherTotal || 0,
        grandTotal: rec.grandTotal || 0,
        message: `📊 ${targetDate} નો કુલ હિસાબ: ગ્રાન્ડ ટોટલ ₹${(rec.grandTotal || 0).toLocaleString('en-IN')} (રોકડ: ₹${(rec.cashTotal || 0).toLocaleString('en-IN')}, બેંક: ₹${(rec.bankTotal || 0).toLocaleString('en-IN')}, વાઉચર: ₹${(rec.voucherTotal || 0).toLocaleString('en-IN')})`
      };
      break;
    }

    if (!autoExecute) {
      results.push({ parsed, executed: false });
      continue;
    }

    // Strict validation: Amount must be spoken and greater than 0
    if (!parsed.amount || isNaN(parsed.amount) || Number(parsed.amount) <= 0) {
      results.push({
        parsed,
        executed: false,
        noAmount: true,
        error: '⚠️ કોઈ રકમ (રૂપિયા) જણાયેલ નથી. કૃપા કરીને રકમ પણ સાથે બોલો (દા.ત. "પાણી ની બોટલ ૧૦૦૦ વાઉચર"). રકમ વગર હિસાબમાં ઉમેરી શકાય નહીં.',
        message: '⚠️ રકમ (રૂપિયા) બોલવી જરૂરી છે! રકમ વગર હિસાબમાં ઉમેરાયું નથી.'
      });
      continue;
    }

    let executionResult = null;
    let message = '';

    try {
      if (parsed.type === 'uchak') {
        const items = getUchakRecords();
        const id = 'uchak_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        let matchedEmpId = null;

        if (parsed.personName) {
          try {
            const employees = getEmployees();
            const matched = employees.find(e =>
              e.name.toLowerCase().includes(parsed.personName.toLowerCase()) ||
              parsed.personName.toLowerCase().includes(e.name.toLowerCase())
            );
            if (matched) matchedEmpId = matched.id;
          } catch (e) { }
        }

        const newEntry = {
          id,
          employeeId: matchedEmpId,
          personName: parsed.personName,
          phone: '',
          purpose: 'ઉચક નોંધ (AI Voice)',
          givenDate: parsed.date,
          givenTime: getTodayTimeStr(),
          givenAmount: parsed.amount,
          remainingAmount: parsed.amount,
          installments: [],
          remarks: `AI Voice Command: "${phrase.trim()}"`,
          status: 'pending',
          settlement: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        items.unshift(newEntry);
        saveUchakRecords(items);
        executionResult = newEntry;
        message = `✅ ${parsed.personName} ના ₹${parsed.amount.toLocaleString('en-IN')} નો ઉચક રેકોર્ડ સફળતાપૂર્વક ઉમેરાયો!`;

      } else if (parsed.type === 'upad') {
        const employees = getEmployees();
        let matchedEmp = employees.find(e =>
          e.name.toLowerCase().includes(parsed.personName.toLowerCase()) ||
          parsed.personName.toLowerCase().includes(e.name.toLowerCase())
        );

        if (matchedEmp) {
          const upadObj = {
            id: 'upad_' + Date.now(),
            date: parsed.date,
            time: getTodayTimeStr(),
            amount: parsed.amount,
            remarks: `AI Voice: "${phrase.trim()}"`,
            forMonth: parsed.date.slice(0, 7)
          };
          if (!Array.isArray(matchedEmp.upads)) matchedEmp.upads = [];
          matchedEmp.upads.unshift(upadObj);
          saveEmployees(employees);
          executionResult = upadObj;
          message = `✅ ${matchedEmp.name} ના ₹${parsed.amount.toLocaleString('en-IN')} નો ઉપાડ સફળતાપૂર્વક નોંધાયો!`;
        } else {
          const items = getUchakRecords();
          const id = 'uchak_' + Date.now();
          const newEntry = {
            id,
            employeeId: null,
            personName: parsed.personName,
            phone: '',
            purpose: 'ઉપાડ / ઉચક (AI Voice)',
            givenDate: parsed.date,
            givenTime: getTodayTimeStr(),
            givenAmount: parsed.amount,
            remainingAmount: parsed.amount,
            installments: [],
            remarks: `AI Voice: "${phrase.trim()}"`,
            status: 'pending',
            settlement: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          items.unshift(newEntry);
          saveUchakRecords(items);
          executionResult = newEntry;
          message = `✅ ${parsed.personName} ના ₹${parsed.amount.toLocaleString('en-IN')} નો ઉચક નોંધાયો!`;
        }
      } else {
        // Voucher / Expense - Add directly to "ખર્ચ વિગત" (record.vouchers)
        const records = getRecords();
        let record = records[targetDate];
        if (!record) {
          record = createBlankRecord(targetDate, getSettings());
          records[targetDate] = record;
        }

        if (!Array.isArray(record.expenseItems)) record.expenseItems = [];
        if (!Array.isArray(record.vouchers)) record.vouchers = [];

        const vAmt = parsed.amount;
        const vTitle = parsed.itemTitle || 'વાઉચર ખર્ચ';
        const catName = parsed.category || vTitle;

        // 1. Add to detailed expenseItems diary (with empty remarks so it doesn't pollute notes)
        const expId = 'exp_voice_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        record.expenseItems.unshift({
          id: expId,
          time: getTodayTimeStr(),
          title: vTitle,
          amount: vAmt,
          category: vTitle,
          categoryType: 'voucher',
          remarks: ''
        });

        // 2. Add directly into "ખર્ચ વિગત" table (record.vouchers)
        let vObj = record.vouchers.find(v => v.name.trim().toLowerCase() === vTitle.trim().toLowerCase());
        if (vObj) {
          vObj.amount = (Number(vObj.amount) || 0) + vAmt;
        } else {
          // If title matches a predefined category (MANDIRKHARCH, RASODAKHARCH, PAGAR), use that, else add new row with exact title
          const catUpper = (catName || '').toUpperCase();
          let matchedCat = record.vouchers.find(v => v.name.trim().toUpperCase() === catUpper);
          if (matchedCat && (!vTitle || vTitle === 'વાઉચર ખર્ચ')) {
            matchedCat.amount = (Number(matchedCat.amount) || 0) + vAmt;
          } else {
            record.vouchers.push({ name: vTitle, amount: vAmt });
          }
        }

        record.voucherTotal = record.vouchers.reduce((s, v) => s + (Number(v.amount) || 0), 0);
        record.grandTotal = (record.cashTotal || 0) + (record.bankTotal || 0) + record.voucherTotal;
        record.updatedAt = new Date().toISOString();

        saveRecords(records);
        executionResult = record;
        message = `✅ "${vTitle}" નો ₹${vAmt.toLocaleString('en-IN')} નો ખર્ચ વાઉચર વિગતમાં સફળતાપૂર્વક ઉમેરાયો!`;
      }

      results.push({ parsed, executed: true, message, item: executionResult });
    } catch (err) {
      results.push({ parsed, executed: false, error: err.message });
    }
  }

  if (summaryQueryObj) {
    return res.json({ success: true, isQuery: true, summary: summaryQueryObj, message: summaryQueryObj.message });
  }

  const anyExecuted = results.some(r => r.executed);
  const allFailedNoAmount = results.length > 0 && results.every(r => !r.executed && r.noAmount);

  res.json({
    success: anyExecuted,
    executed: anyExecuted,
    noAmount: allFailedNoAmount,
    multi: results.length > 1,
    count: results.filter(r => r.executed).length,
    parsed: (results[0] && results[0].parsed),
    message: results.map(r => r.message || r.error).join(' | '),
    results
  });
});

// 13. Open Report folder
app.post('/api/open-folder', (req, res) => {
  const settings = getSettings();
  const folder = settings.exportFolder || 'D:\\Account Report';
  const targetFolder = fs.existsSync(folder) ? folder : REPORTS_DIR;

  const { exec } = require('child_process');
  exec(`explorer.exe "${targetFolder}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, folder: targetFolder });
  });
});

// ==================== 14. BHAKT SEVA / NITYA DAAN REGISTER ====================

// 14a. Get All Bhakts with summary
app.get('/api/bhakts', (req, res) => {
  const bhakts = getBhakts();
  const deposits = getBhaktDeposits();
  
  const enriched = bhakts.map(b => {
    const bDeps = deposits.filter(d => d.bhaktId === b.id).sort((x, y) => {
      const endX = x.periodEnd || x.date || '';
      const endY = y.periodEnd || y.date || '';
      return endY.localeCompare(endX);
    });
    const lastDep = bDeps[0] || null;
    const totalDaysPaid = bDeps.reduce((sum, d) => sum + (Number(d.days) || 0), 0);
    const totalAmountPaid = bDeps.reduce((sum, d) => sum + (Number(d.totalAmount) || 0), 0);
    return {
      ...b,
      lastDeposit: lastDep,
      totalDaysPaid,
      totalAmountPaid
    };
  });
  
  res.json({ success: true, bhakts: enriched });
});

// 14b. Add New Bhakt (Admin Protected)
app.post('/api/bhakts', requireAdminAuth, (req, res) => {
  const { name, phone, dailyAmount, donorId, payType } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'ભક્તનું નામ લખવું જરૂરી છે' });
  }
  const amt = Number(dailyAmount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'રોજની સાચી રકમ લખો (દા.ત. ૧૫ અથવા ૧૦૦)' });
  }

  const bhakts = getBhakts();
  const finalDonorId = (donorId && donorId.trim()) ? donorId.trim() : String(bhakts.length + 101);

  const newBhakt = {
    id: 'bhakt_' + Date.now(),
    donorId: finalDonorId,
    name: name.trim(),
    phone: (phone || '').trim(),
    dailyAmount: amt,
    payType: (payType === 'month_wise') ? 'month_wise' : 'date_wise',
    status: 'active',
    createdAt: new Date().toISOString()
  };

  bhakts.push(newBhakt);
  saveBhakts(bhakts);
  logAdminActivity(
    'BHAKT_ADD',
    'SETTINGS',
    `નવા ભક્ત ઉમેર્યા: ${newBhakt.name}`,
    `Added Donor/Bhakt: ${newBhakt.name}`,
    `ખાતા નંબર: ${newBhakt.donorId}, દૈનિક રકમ: ₹${newBhakt.dailyAmount}`,
    `Donor ID: ${newBhakt.donorId}, Daily Amount: ₹${newBhakt.dailyAmount}`,
    'success',
    req
  );
  res.json({ success: true, bhakt: newBhakt });
});

// 14c. Update Bhakt (Admin Protected)
app.put('/api/bhakts/:id', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { name, phone, dailyAmount, status, donorId, payType } = req.body;
  const bhakts = getBhakts();
  const bhakt = bhakts.find(b => b.id === id);

  if (!bhakt) {
    return res.status(404).json({ error: 'ભક્ત મળ્યા નથી' });
  }

  if (donorId !== undefined) bhakt.donorId = donorId.trim();
  if (name !== undefined) bhakt.name = name.trim();
  if (phone !== undefined) bhakt.phone = phone.trim();
  if (dailyAmount !== undefined) bhakt.dailyAmount = Number(dailyAmount) || bhakt.dailyAmount;
  if (payType !== undefined) bhakt.payType = (payType === 'month_wise') ? 'month_wise' : 'date_wise';
  if (status !== undefined) bhakt.status = status;

  saveBhakts(bhakts);
  logAdminActivity(
    'BHAKT_UPDATE',
    'SETTINGS',
    `ભક્ત વિગત અપડેટ: ${bhakt.name}`,
    `Updated Donor/Bhakt: ${bhakt.name}`,
    `ખાતા નંબર: ${bhakt.donorId}, સ્થિતિ: ${bhakt.status}`,
    `Donor ID: ${bhakt.donorId}, Status: ${bhakt.status}`,
    'info',
    req
  );
  res.json({ success: true, bhakt });
});

// 14d. Delete Bhakt (Admin Protected)
app.delete('/api/bhakts/:id', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  let bhakts = getBhakts();
  const initLen = bhakts.length;
  const targetBhakt = bhakts.find(b => b.id === id);
  bhakts = bhakts.filter(b => b.id !== id);

  if (bhakts.length === initLen) {
    return res.status(404).json({ error: 'ભક્ત મળ્યા નથી' });
  }

  saveBhakts(bhakts);
  logAdminActivity(
    'BHAKT_DELETE',
    'SETTINGS',
    `ભક્ત કાઢી નાખ્યા: ${targetBhakt ? targetBhakt.name : id}`,
    `Deleted Donor/Bhakt: ${targetBhakt ? targetBhakt.name : id}`,
    `ભક્ત રેકોર્ડ સફળતાપૂર્વક હટાવી દેવામાં આવ્યો`,
    `Donor record successfully removed from system`,
    'warning',
    req
  );
  res.json({ success: true, message: 'ભક્ત કાઢી નાખવામાં આવ્યા છે.' });
});

// 14e. Get Bhakt Deposits (Passbook History)
app.get('/api/bhakts/:id/deposits', (req, res) => {
  const { id } = req.params;
  const deposits = getBhaktDeposits();
  const bhaktDeposits = deposits.filter(d => d.bhaktId === id).sort((a, b) => {
    const endA = a.periodEnd || a.date || '';
    const endB = b.periodEnd || b.date || '';
    return endB.localeCompare(endA);
  });
  res.json({ success: true, deposits: bhaktDeposits });
});

// 14f. Record Deposit & Generate Receipt
app.post('/api/bhakts/:id/deposit', (req, res) => {
  const { id } = req.params;
  const { date, periodStart, periodEnd, days, dailyAmount, totalAmount, paymentMode, remarks } = req.body;

  const bhakts = getBhakts();
  const bhakt = bhakts.find(b => b.id === id);
  if (!bhakt) {
    return res.status(404).json({ error: 'ભક્ત મળ્યા નથી' });
  }

  const dCount = Number(days);
  const rate = Number(dailyAmount) || bhakt.dailyAmount;
  const total = Number(totalAmount) || (dCount * rate);

  if (isNaN(total) || total <= 0) {
    return res.status(400).json({ error: 'સાચી રકમ અથવા દિવસો લખો' });
  }

  const deposits = getBhaktDeposits();
  const receiptNo = deposits.length + 101;
  const depositDate = date || getTodayDateStr();
  const today = getTodayDateStr();
  if (depositDate < today && !isValidAdminSession(req)) {
    return res.status(403).json({
      error: `તારીખ ${depositDate} નો હિસાબ લૉક છે! પાછલી તારીખમાં રકમ જમા કરવા માટે એડમિન પિન જરૂરી છે.`,
      isLocked: true,
      sessionRequired: true
    });
  }

  const depositRecord = {
    id: 'bdep_' + Date.now(),
    receiptNo: receiptNo,
    bhaktId: bhakt.id,
    donorId: bhakt.donorId || '',
    bhaktName: bhakt.name,
    date: depositDate,
    periodStart: periodStart || date || getTodayDateStr(),
    periodEnd: periodEnd || date || getTodayDateStr(),
    days: dCount || 1,
    dailyAmount: rate,
    totalAmount: total,
    paymentMode: (paymentMode || 'cash').trim(),
    settlementMode: (req.body.settlementMode || 'date_wise').trim(),
    remarks: (remarks || '').trim(),
    createdAt: new Date().toISOString()
  };

  deposits.push(depositRecord);
  saveBhaktDeposits(deposits);

  res.json({
    success: true,
    message: `${bhakt.name} પાસેથી ₹ ${total.toLocaleString('en-IN')} ની રસીદ નં. ${receiptNo} સફળતાપૂર્વક બની ગઈ!`,
    deposit: depositRecord
  });
});

app.get('/api/cloud-status', async (req, res) => {
  const isOnline = await dbSync.checkRealtimeCloudStatus();
  res.json({
    online: isOnline,
    cloudDB: 'MongoDB Atlas (GadiSthan)',
    status: isOnline ? 'Online Connected' : 'Offline / Local Cache'
  });
});

// =========================================================================
// DUES / RECEIVABLES & PAYABLES (લેણાં અને દેવાં રજિસ્ટર) API
// =========================================================================

// 1. Get all dues with summary
app.get('/api/dues', (req, res) => {
  try {
    const { type, status, search } = req.query;
    let list = getDues();

    if (type && type !== 'all') {
      list = list.filter(d => d.type === type);
    }
    if (status && status !== 'all') {
      list = list.filter(d => d.status === status);
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(d =>
        (d.name && d.name.toLowerCase().includes(q)) ||
        (d.description && d.description.toLowerCase().includes(q)) ||
        (d.date && d.date.includes(q))
      );
    }

    // Sort descending by date, then id
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id || '').localeCompare(a.id || ''));

    // Compute all-time summary from base list
    const allDues = getDues();
    const summary = {
      totalReceivable: 0,
      settledReceivable: 0,
      pendingReceivable: 0,
      countReceivablePending: 0,
      totalPayable: 0,
      settledPayable: 0,
      pendingPayable: 0,
      countPayablePending: 0
    };

    allDues.forEach(d => {
      const amt = Number(d.amount) || 0;
      const settled = Number(d.settledAmount) || 0;
      const rem = Math.max(0, amt - settled);
      if (d.type === 'receivable') {
        summary.totalReceivable += amt;
        summary.settledReceivable += settled;
        summary.pendingReceivable += rem;
        if (rem > 0) summary.countReceivablePending++;
      } else if (d.type === 'payable') {
        summary.totalPayable += amt;
        summary.settledPayable += settled;
        summary.pendingPayable += rem;
        if (rem > 0) summary.countPayablePending++;
      }
    });

    return res.json({ success: true, dues: list, summary });
  } catch (err) {
    console.error('Error fetching dues:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Add new due entry
app.post('/api/dues', (req, res) => {
  try {
    const { type, date, name, amount, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'નામ લખવું ફરજિયાત છે' });
    }
    const amt = Math.round(Number(amount));
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'માન્ય રકમ લખવી ફરજિયાત છે' });
    }

    const dues = getDues();
    const newDue = {
      id: `due_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      type: type === 'payable' ? 'payable' : 'receivable',
      date: date || getTodayDateStr(),
      name: name.trim(),
      amount: amt,
      description: (description || '').trim(),
      settledAmount: 0,
      remainingAmount: amt,
      status: 'pending',
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    dues.push(newDue);
    saveDues(dues);

    logAdminActivity(
      'DUES_ADD',
      'HISAB',
      `${newDue.type === 'receivable' ? 'લેવાના બાકી' : 'આપવાના બાકી'} એન્ટ્રી ઉમેરી: ${newDue.name}`,
      `Added ${newDue.type === 'receivable' ? 'Receivable' : 'Payable'}: ${newDue.name}`,
      `રકમ: ₹ ${newDue.amount} | વિગત: ${newDue.description || '-'}`,
      `Amount: ₹ ${newDue.amount} | Details: ${newDue.description || '-'}`,
      'info',
      req,
      { dueId: newDue.id, type: newDue.type, name: newDue.name, amount: newDue.amount }
    );

    return res.json({ success: true, due: newDue });
  } catch (err) {
    console.error('Error adding due:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Update due entry
app.put('/api/dues/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { date, name, amount, description } = req.body;
    const dues = getDues();
    const idx = dues.findIndex(d => d.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'એન્ટ્રી મળી નથી' });
    }

    const due = dues[idx];
    if (name && name.trim()) due.name = name.trim();
    if (date) due.date = date;
    if (description !== undefined) due.description = description.trim();

    if (amount !== undefined) {
      const newAmt = Math.round(Number(amount));
      if (!isNaN(newAmt) && newAmt >= (due.settledAmount || 0)) {
        due.amount = newAmt;
      }
    }

    due.remainingAmount = Math.max(0, due.amount - (due.settledAmount || 0));
    due.status = due.remainingAmount === 0 ? 'settled' : ((due.settledAmount || 0) > 0 ? 'partial' : 'pending');
    due.updatedAt = new Date().toISOString();

    dues[idx] = due;
    saveDues(dues);

    return res.json({ success: true, due });
  } catch (err) {
    console.error('Error updating due:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Settle / Partial repayment or payment
app.post('/api/dues/:id/settle', (req, res) => {
  try {
    const { id } = req.params;
    const { date, amount, note } = req.body;

    const dues = getDues();
    const idx = dues.findIndex(d => d.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'એન્ટ્રી મળી નથી' });
    }

    const due = dues[idx];
    const settleAmt = Math.round(Number(amount));
    if (isNaN(settleAmt) || settleAmt <= 0) {
      return res.status(400).json({ success: false, error: 'માન્ય રકમ લખવી જરૂરી છે' });
    }

    if (settleAmt > due.remainingAmount) {
      return res.status(400).json({
        success: false,
        error: `બાકી રકમ (₹ ${due.remainingAmount}) કરતાં વધુ રકમ જમા/ચૂકવી શકાય નહીં`
      });
    }

    if (!Array.isArray(due.history)) due.history = [];
    const settlementEntry = {
      id: `st_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      date: date || getTodayDateStr(),
      amount: settleAmt,
      note: (note || '').trim(),
      createdAt: new Date().toISOString()
    };

    due.history.push(settlementEntry);
    due.settledAmount = (due.settledAmount || 0) + settleAmt;
    due.remainingAmount = Math.max(0, due.amount - due.settledAmount);
    due.status = due.remainingAmount === 0 ? 'settled' : 'partial';
    due.updatedAt = new Date().toISOString();

    dues[idx] = due;
    saveDues(dues);

    logAdminActivity(
      'DUES_SETTLE',
      'HISAB',
      `${due.name} માટે ₹ ${settleAmt} ની ${due.type === 'receivable' ? 'વસૂલાત/જમા' : 'ચુકવણી'} નોંધાઈ`,
      `Recorded ${due.type === 'receivable' ? 'Collection' : 'Payment'} of ₹ ${settleAmt} for ${due.name}`,
      `બાકી રકમ: ₹ ${due.remainingAmount}`,
      `Remaining Due: ₹ ${due.remainingAmount}`,
      'success',
      req,
      { dueId: due.id, type: due.type, name: due.name, settledAmount: settleAmt, remainingAmount: due.remainingAmount }
    );

    return res.json({ success: true, due, settlement: settlementEntry });
  } catch (err) {
    console.error('Error settling due:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Delete specific settlement entry from history
app.delete('/api/dues/:id/settle/:settleId', (req, res) => {
  try {
    const { id, settleId } = req.params;
    const dues = getDues();
    const idx = dues.findIndex(d => d.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'એન્ટ્રી મળી નથી' });
    }

    const due = dues[idx];
    if (!Array.isArray(due.history)) due.history = [];
    const sIdx = due.history.findIndex(h => h.id === settleId);
    if (sIdx === -1) {
      return res.status(404).json({ success: false, error: 'ચુકવણી એન્ટ્રી મળી નથી' });
    }

    const removed = due.history.splice(sIdx, 1)[0];
    due.settledAmount = due.history.reduce((s, h) => s + (Number(h.amount) || 0), 0);
    due.remainingAmount = Math.max(0, due.amount - due.settledAmount);
    due.status = due.remainingAmount === 0 ? 'settled' : (due.settledAmount > 0 ? 'partial' : 'pending');
    due.updatedAt = new Date().toISOString();

    dues[idx] = due;
    saveDues(dues);

    return res.json({ success: true, due });
  } catch (err) {
    console.error('Error deleting settlement:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Delete entire due record
app.delete('/api/dues/:id', (req, res) => {
  try {
    const { id } = req.params;
    let dues = getDues();
    const target = dues.find(d => d.id === id);
    if (!target) {
      return res.status(404).json({ success: false, error: 'એન્ટ્રી મળી નથી' });
    }

    dues = dues.filter(d => d.id !== id);
    saveDues(dues);

    logAdminActivity(
      'DUES_DELETE',
      'HISAB',
      `${target.type === 'receivable' ? 'લેવાના બાકી' : 'આપવાના બાકી'} એન્ટ્રી ડિલીટ કરી: ${target.name}`,
      `Deleted ${target.type === 'receivable' ? 'Receivable' : 'Payable'} entry: ${target.name}`,
      `રકમ: ₹ ${target.amount}`,
      `Amount: ₹ ${target.amount}`,
      'danger',
      req,
      { dueId: target.id, name: target.name }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleting due:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
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
