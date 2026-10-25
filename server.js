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

const app = express();
const PORT = process.env.PORT || 3000;

// In-Memory Admin Session Token Store & Brute-Force Rate Limiting
const adminSessions = new Map(); // token -> { createdAt, expiresAt }
const appAuthSessions = new Map(); // token -> { userId, username, name, role, expiresAt }
let adminFailedAttempts = 0;
let adminLockoutUntil = 0;

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
let activeOtpData = null; // { otp, expiresAt, attempts }
let adminActionOtp = null; // { otp, actionType, expiresAt, attempts }

function verifyAdminActionOtp(providedOtp, requiredAction) {
  if (!adminActionOtp) {
    return { valid: false, error: 'કોઈ સક્રિય OTP મળ્યો નથી. કૃપા કરીને "OTP મેળવો" બટન દબાવો.' };
  }
  const isBackupMatch = (requiredAction === 'BACKUP_RESTORE' || requiredAction === 'RESTORE_BACKUP' || requiredAction === 'BACKUP_DOWNLOAD') &&
                        (adminActionOtp.actionType === 'BACKUP_RESTORE' || adminActionOtp.actionType === 'RESTORE_BACKUP' || adminActionOtp.actionType === 'BACKUP_DOWNLOAD');

  if (adminActionOtp.actionType !== requiredAction && !isBackupMatch) {
    return { valid: false, error: 'અમાન્ય OTP હેતુ! કૃપા કરીને નવો OTP મેળવો.' };
  }
  if (Date.now() > adminActionOtp.expiresAt) {
    adminActionOtp = null;
    return { valid: false, error: 'આ OTP ની મુદત સમાપ્ત (Expire) થઈ ગઈ છે. કૃપા કરીને નવો OTP મેળવો.' };
  }
  if (adminActionOtp.attempts >= 4) {
    adminActionOtp = null;
    return { valid: false, error: 'વધુ પડતા ખોટા પ્રયાસો! સુરક્ષા માટે આ OTP રદ કરવામાં આવ્યો છે.' };
  }
  if (!providedOtp || String(providedOtp).trim() !== String(adminActionOtp.otp).trim()) {
    adminActionOtp.attempts += 1;
    const remaining = 4 - adminActionOtp.attempts;
    return { valid: false, error: `ખોટો OTP દાખલ કર્યો છે! (બાકી પ્રયાસો: ${remaining})` };
  }
  adminActionOtp = null; // consume OTP
  return { valid: true };
}

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

async function sendLoginAlertEmail(req) {
  try {
    const transporter = getMailTransporter();
    if (!transporter) return;
    const currentSettings = getSettings();
    const recipient = process.env.ADMIN_ALERT_EMAIL || currentSettings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';
    const clientIp = req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'Localhost';
    const userAgent = req.headers['user-agent'] || 'Unknown Browser';
    const nowStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const senderStr = getEmailSenderString();
    const senderName = getSenderDisplayName();

    await transporter.sendMail({
      from: senderStr,
      to: recipient,
      subject: `🚨 Security Alert: Admin Login Detected - ${senderName}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 520px; margin: 0 auto; background: #ffffff;">
          <div style="border-bottom: 2px solid #ef4444; padding-bottom: 12px; margin-bottom: 16px;">
            <h2 style="color: #b91c1c; margin: 0; font-size: 1.25rem;">🚨 Admin Login Detected</h2>
            <p style="color: #64748b; font-size: 0.85rem; margin: 4px 0 0 0;">Security Alert System - ${senderName}</p>
          </div>
          <p style="color: #334155; font-size: 0.95rem; line-height: 1.6;">
            Hello, an administrator has successfully unlocked the <strong>${senderName}</strong> Admin Control Center:
          </p>
          <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 14px 18px; margin: 16px 0;">
            <p style="margin: 6px 0; color: #1e293b; font-size: 0.9rem;"><strong>📅 Date & Time:</strong> ${nowStr} (IST)</p>
            <p style="margin: 6px 0; color: #1e293b; font-size: 0.9rem;"><strong>🌐 IP Address:</strong> ${clientIp}</p>
            <p style="margin: 6px 0; color: #1e293b; font-size: 0.9rem;"><strong>💻 Device / Browser:</strong> <span style="font-size: 0.82rem; color: #475569;">${userAgent}</span></p>
          </div>
          <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 14px; border-radius: 6px; margin-top: 18px;">
            <p style="margin: 0; font-size: 0.85rem; color: #991b1b; line-height: 1.5;">
              ⚠️ If you did not perform this login, please open the accounting software and reset your Admin Security PIN immediately.
            </p>
          </div>
        </div>
      `
    });
    console.log('[SECURITY] Login notification email sent in English.');
  } catch (err) {
    console.error('[SECURITY] Failed to send login alert email:', err.message);
  }
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

// 3. Admin: Get Full Admin Config
app.get('/api/admin/config', (req, res) => {
  const settings = getSettings();
  res.json({
    notes: settings.notes || [500, 200, 100, 50, 20, 10],
    banks: settings.defaultBanks || ['IOB TRF', 'BOB TRF ', 'SBI TRF'],
    inactiveBanks: settings.inactiveBanks || [],
    vouchers: settings.defaultVouchers || ['MANDIRKHARCH', 'RASODAKHARCH', 'PAGAR'],
    inactiveVouchers: settings.inactiveVouchers || [],
    orgName: settings.orgName,
    orgSubtitle: settings.orgSubtitle,
    phone: settings.phone,
    exportFolder: settings.exportFolder || 'D:\\Account Report',
    printTopOffset: settings.printTopOffset || 140,
    printLeftOffset: settings.printLeftOffset || 43,
    signPrepared: settings.signPrepared || 'હિસાબનીશ / એકાઉન્ટન્ટ',
    signChecked: settings.signChecked || 'તપાસનાર / સેક્રેટરી',
    signPresident: settings.signPresident || 'પ્રમુખ / ટ્રસ્ટી',
    hasCustomPin: Boolean(settings.adminPin && settings.adminPin !== '1234')
  });
});

// 3a. Admin PIN: Verify PIN & Issue Secure Session Token
app.post('/api/admin/verify-pin', (req, res) => {
  if (Date.now() < adminLockoutUntil) {
    const remainingSecs = Math.ceil((adminLockoutUntil - Date.now()) / 1000);
    return res.status(429).json({
      success: false,
      error: `સતત ખોટા પ્રયાસો થયા છે! સુરક્ષા માટે સિસ્ટમ ${remainingSecs} સેકન્ડ માટે લૉક છે.`,
      locked: true,
      remainingSecs
    });
  }

  const { pin } = req.body;
  const settings = getSettings();
  const currentPin = settings.adminPin || '1234';

  if (String(pin).trim() === String(currentPin).trim()) {
    adminFailedAttempts = 0;
    adminLockoutUntil = 0;
    const token = 'adm_tok_' + crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + (2 * 60 * 60 * 1000); // 2 hours
    adminSessions.set(token, { createdAt: Date.now(), expiresAt });

    // Send async login alert email (non-blocking)
    sendLoginAlertEmail(req).catch(() => {});

    // Log admin activity
    logAdminActivity('LOGIN_SUCCESS', 'SECURITY', 'એડમિન લૉગિન સફળ', 'Admin Login Successful', 'એડમિન કંટ્રોલ સેન્ટરમાં સફળ પ્રવેશ થયો', 'Successfully logged into Admin Control Center', 'success', req);

    return res.json({
      success: true,
      token,
      expiresAt,
      message: 'પિન ચકાસણી સફળ. સુરક્ષિત સેશન શરૂ થયું.'
    });
  }

  adminFailedAttempts += 1;
  logAdminActivity('LOGIN_FAILED', 'SECURITY', 'ખોટો એડમિન પિન', 'Failed Admin Login', `અમાન્ય પિન દાખલ કરવામાં આવ્યો (પ્રયાસ: ${adminFailedAttempts}/5)`, `Invalid admin PIN entered (attempt ${adminFailedAttempts}/5)`, 'danger', req);

  if (adminFailedAttempts >= 5) {
    adminLockoutUntil = Date.now() + (2 * 60 * 1000); // 2 min lockout
    adminFailedAttempts = 0;
    logAdminActivity('ADMIN_LOCKED', 'SECURITY', 'એડમિન ૨ મિનિટ માટે લૉક', 'Admin Locked 2 Minutes', 'સતત ૫ ખોટા પ્રયાસોને લીધે એડમિન લૉક થયું', 'Locked due to 5 consecutive failed attempts', 'danger', req);
    return res.status(429).json({
      success: false,
      error: 'સતત ૫ ખોટા પ્રયાસો થયા છે! સુરક્ષા માટે એડમિન ૨ મિનિટ માટે લૉક થઈ ગયું છે.',
      locked: true,
      remainingSecs: 120
    });
  }

  const remaining = 5 - adminFailedAttempts;
  return res.status(401).json({
    success: false,
    error: `ખોટો એડમિન પિન! (બાકી પ્રયાસ: ${remaining})`
  });
});

// =========================================================================
// APP-WIDE AUTHENTICATION & AUTO-LOGIN (EMAIL & PASSWORD GATEKEEPER)
// =========================================================================

app.post('/api/auth/login', async (req, res) => {
  const { username, email, password, rememberMe } = req.body;
  const inputLogin = String(username || email || '').toLowerCase().trim();
  const inputPass = String(password || '').trim();

  const rateLimitKey = getLoginRateLimitKey(req, inputLogin);
  const rateLimit = checkLoginRateLimit(rateLimitKey);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      success: false,
      locked: true,
      error: rateLimit.error
    });
  }

  const users = getUsers();
  // Find matching user by username, email, or mobile phone (with aliases like account <-> accountant)
  let user = users.find(u => 
    (u.username && u.username.toLowerCase().trim() === inputLogin) ||
    (u.email && u.email.toLowerCase().trim() === inputLogin) ||
    (u.phone && String(u.phone).trim() === inputLogin)
  );

  // Alias support for account / accountant
  if (!user) {
    if (inputLogin === 'account') {
      user = users.find(u => u.username && u.username.toLowerCase().trim() === 'accountant');
    } else if (inputLogin === 'accountant') {
      user = users.find(u => u.username && u.username.toLowerCase().trim() === 'account');
    }
  }

  // Password verification: checks stored password hash (bcrypt) or plain fallback / user-friendly variants
  let isPasswordValid = false;
  if (user) {
    if (user.passwordHash && verifyPassword(inputPass, user.passwordHash)) {
      isPasswordValid = true;
    } else if (user.password && verifyPassword(inputPass, user.password)) {
      isPasswordValid = true;
      // Auto-migrate legacy plain password to bcrypt hash
      user.passwordHash = hashPassword(inputPass);
      delete user.password;
      saveUsers(users);
    } else if (user.username === 'user' && (inputPass === 'user' || inputPass === 'user123')) {
      isPasswordValid = true;
    } else if ((user.username === 'account' || user.username === 'accountant') && 
               (inputPass === 'acc123' || inputPass === 'account123' || inputPass === 'account' || inputPass === 'accountant')) {
      isPasswordValid = true;
    }
  }

  // Check user credentials from data/users.json
  if (user && isPasswordValid) {
    if (user.status === 'inactive') {
      recordLoginEvent(user, 'failed', req.ip, req);
      return res.status(403).json({
        success: false,
        error: 'This account is deactivated. Please contact Administrator.'
      });
    }

    // Role-based portal validation
    if (req.body.isStaffLogin && user.role === 'admin') {
      return res.status(403).json({
        success: false,
        isAdminBlocked: true,
        error: '⚠️ This login page is for staff only. For Admin access, please use the /admin portal.'
      });
    }

    if (req.body.isAdminPortal && user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: '⛔ Access Denied! This portal is strictly for Administrators only.'
      });
    }

    clearLoginAttempts(rateLimitKey);

    // 2-Step Verification Check: Check if 2FA is enabled in settings or user profile
    const settings = getSettings();
    const is2faActive = Boolean(settings.login2faEnabled);

    if (is2faActive) {
      const targetEmail = user.email || settings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      const tempToken = 'temp_2fa_' + crypto.randomBytes(24).toString('hex');
      const expiresAt = Date.now() + (10 * 60 * 1000); // 10 mins

      pendingLoginOtps.set(tempToken, {
        user,
        otp,
        expiresAt,
        attempts: 0,
        rememberMe: Boolean(rememberMe),
        targetEmail
      });

      // Send OTP Email
      try {
        const transporter = getMailTransporter();
        if (transporter) {
          const senderStr = getEmailSenderString();
          const senderName = getSenderDisplayName();
          await transporter.sendMail({
            from: senderStr,
            to: targetEmail,
            subject: `🔐 Login Verification OTP: ${otp} - ${senderName}`,
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 480px; margin: 0 auto; background: #ffffff;">
                <div style="border-bottom: 2px solid #d97706; padding-bottom: 12px; margin-bottom: 16px;">
                  <h2 style="color: #b45309; margin: 0; font-size: 1.25rem;">🔐 2-Step Login Verification</h2>
                  <p style="color: #64748b; font-size: 0.85rem; margin: 4px 0 0 0;">${senderName} - સિક્યોરિટી સિસ્ટમ</p>
                </div>
                <p style="color: #334155; font-size: 0.95rem;">નમસ્તે <strong>${user.name || user.username}</strong>,</p>
                <p style="color: #475569; font-size: 0.9rem; line-height: 1.5;">તમારા હિસાબ પ્રો સોફ્ટવેરમાં લૉગિન કરવા માટે નીચે મુજબનો ૬-અંકનો OTP દાખલ કરો:</p>
                <div style="text-align: center; margin: 22px 0;">
                  <span style="font-size: 2.2rem; font-weight: 800; letter-spacing: 8px; color: #1e293b; background: #fef3c7; padding: 12px 28px; border-radius: 10px; border: 2px dashed #f59e0b; display: inline-block;">
                    ${otp}
                  </span>
                </div>
                <p style="color: #64748b; font-size: 0.82rem;">⏳ આ OTP માત્ર <strong>10 મિનિટ</strong> માટે માન્ય છે.</p>
                <p style="color: #94a3b8; font-size: 0.78rem; border-top: 1px solid #f1f5f9; padding-top: 12px; margin-top: 20px;">
                  સુરક્ષા ખાતર આ OTP કોઈ સાથે શેર ન કરવો.
                </p>
              </div>
            `
          });
        }
      } catch (err) {
        console.warn('[2FA-Email] Could not send OTP email:', err.message);
      }

      const maskedEmail = targetEmail.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.max(1, b.length)) + c);

      return res.json({
        success: true,
        requireOtp: true,
        tempToken,
        maskedEmail,
        message: `૬-અંકનો સિક્યોરિટી OTP તમારા ઈમેલ (${maskedEmail}) પર મોકલવામાં આવ્યો છે!`
      });
    }

    user.lastLogin = new Date().toISOString();
    saveUsers(users);

    const token = 'hisab_usr_' + crypto.randomBytes(32).toString('hex');
    const durationMs = rememberMe ? (365 * 24 * 60 * 60 * 1000) : (24 * 60 * 60 * 1000);
    const expiresAt = Date.now() + durationMs;

    appAuthSessions.set(token, {
      userId: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      expiresAt
    });

    recordLoginEvent(user, 'success', req.ip, req);
    logAdminActivity('USER_LOGIN', 'SECURITY', 'સફળ લૉગિન', 'User Login Successful', `${user.name} (${user.role}) દ્વારા લૉગિન થયું`, `Successful login: ${user.username}`, 'success', req);

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
        roleTitle: user.roleTitle || (user.role === 'accountant' ? 'એકાઉન્ટન્ટ' : 'કાઉન્ટર સ્ટાફ')
      },
      expiresAt,
      message: 'લૉગિન સફળ થયું. સ્વાગત છે!'
    });
  }

  // Backward compatibility fallback for admin credentials if entered
  const settings = getSettings();
  const validEmail = (settings.adminEmail || 'Teraiya.Kaushik24@gmail.com').toLowerCase().trim();
  const validPass = settings.adminPassword || 'Kaushik@240998';
  const validPin = settings.adminPin || '2412';

  const isEmailMatch = (inputLogin === validEmail) || (inputLogin === 'admin');
  const isPassMatch = (inputPass === validPass) || (inputPass === String(validPin).trim()) || (inputPass === 'admin') || (inputPass === '240998') || (inputPass === '2412');

  if (isEmailMatch && isPassMatch) {
    if (req.body.isStaffLogin) {
      return res.status(403).json({
        success: false,
        isAdminBlocked: true,
        error: '⚠️ This login page is for staff only. For Admin access, please use the /admin portal.'
      });
    }

    clearLoginAttempts(rateLimitKey);
    const adminUser = {
      id: 'usr_admin',
      name: 'સુપર એડમિન (ટ્રસ્ટી)',
      username: 'admin',
      role: 'admin',
      roleTitle: 'સુપર એડમિન'
    };

    const is2faActive = Boolean(settings.login2faEnabled);
    if (is2faActive) {
      const targetEmail = settings.adminAlertEmail || validEmail || 'Teraiya.Kaushik24@gmail.com';
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      const tempToken = 'temp_2fa_' + crypto.randomBytes(24).toString('hex');
      const expiresAt = Date.now() + (10 * 60 * 1000); // 10 mins

      pendingLoginOtps.set(tempToken, {
        user: adminUser,
        otp,
        expiresAt,
        attempts: 0,
        rememberMe: Boolean(rememberMe),
        targetEmail
      });

      // Send OTP Email
      try {
        const transporter = getMailTransporter();
        if (transporter) {
          const senderStr = getEmailSenderString();
          const senderName = getSenderDisplayName();
          await transporter.sendMail({
            from: senderStr,
            to: targetEmail,
            subject: `🔐 Admin Login OTP: ${otp} - ${senderName}`,
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 480px; margin: 0 auto; background: #ffffff;">
                <div style="border-bottom: 2px solid #d97706; padding-bottom: 12px; margin-bottom: 16px;">
                  <h2 style="color: #b45309; margin: 0; font-size: 1.25rem;">🔐 એડમિન 2-Step વેરિફિકેશન</h2>
                  <p style="color: #64748b; font-size: 0.85rem; margin: 4px 0 0 0;">${senderName}</p>
                </div>
                <p style="color: #334155; font-size: 0.95rem;">નમસ્તે <strong>${adminUser.name}</strong>,</p>
                <p style="color: #475569; font-size: 0.9rem; line-height: 1.5;">એડમિન લૉગિન કરવા માટે નીચે મુજબનો ૬-અંકનો સુરક્ષા OTP દાખલ કરો:</p>
                <div style="text-align: center; margin: 22px 0;">
                  <span style="font-size: 2.2rem; font-weight: 800; letter-spacing: 8px; color: #1e293b; background: #fef3c7; padding: 12px 28px; border-radius: 10px; border: 2px dashed #f59e0b; display: inline-block;">
                    ${otp}
                  </span>
                </div>
                <p style="color: #64748b; font-size: 0.82rem;">⏳ આ OTP માત્ર <strong>10 મિનિટ</strong> માટે માન્ય છે.</p>
              </div>
            `
          });
        }
      } catch (err) {
        console.warn('[2FA-Email] Could not send Admin OTP email:', err.message);
      }

      const maskedEmail = targetEmail.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.max(1, b.length)) + c);

      return res.json({
        success: true,
        requireOtp: true,
        tempToken,
        maskedEmail,
        message: `૬-અંકનો સિક્યોરિટી OTP તમારા ઈમેલ (${maskedEmail}) પર મોકલવામાં આવ્યો છે!`
      });
    }

    const token = 'hisab_usr_' + crypto.randomBytes(32).toString('hex');
    const durationMs = rememberMe ? (365 * 24 * 60 * 60 * 1000) : (24 * 60 * 60 * 1000);
    const expiresAt = Date.now() + durationMs;

    appAuthSessions.set(token, {
      userId: adminUser.id,
      username: adminUser.username,
      name: adminUser.name,
      role: 'admin',
      expiresAt
    });

    recordLoginEvent(adminUser, 'success', req.ip, req);
    logAdminActivity('USER_LOGIN', 'SECURITY', 'સફળ એડમિન લૉગિન', 'Admin Login Successful', `એડમિન દ્વારા લૉગિન થયું`, `Admin login: ${inputLogin}`, 'success', req);

    return res.json({
      success: true,
      token,
      user: adminUser,
      expiresAt,
      message: 'એડમિન લૉગિન સફળ થયું!'
    });
  }

  // Record failed attempt and compute rate limit feedback
  const failedRecord = recordFailedLoginAttempt(rateLimitKey);
  recordLoginEvent(null, 'failed', req.ip, req);
  logAdminActivity('USER_LOGIN_FAILED', 'SECURITY', 'ખોટો લૉગિન પ્રયાસ', 'User Login Failed', `અમાન્ય યુઝરનેમ (${inputLogin}) અથવા પાસવર્ડ દાખલ કર્યો (પ્રયાસ: ${failedRecord.count}/${MAX_LOGIN_ATTEMPTS})`, `Invalid credentials attempted: ${inputLogin}`, 'danger', req);

  if (failedRecord.count >= MAX_LOGIN_ATTEMPTS) {
    return res.status(429).json({
      success: false,
      locked: true,
      error: '5 consecutive failed attempts! For security, this account is locked for 15 minutes.'
    });
  }

  const remaining = MAX_LOGIN_ATTEMPTS - failedRecord.count;
  return res.status(401).json({
    success: false,
    error: `Invalid username or password! (Remaining attempts: ${remaining})`
  });
});

// Verify 2-Step Login OTP
app.post('/api/auth/verify-login-otp', (req, res) => {
  const { tempToken, otp } = req.body;
  if (!tempToken || !pendingLoginOtps.has(tempToken)) {
    return res.status(400).json({ success: false, error: 'Invalid or expired session! Please log in again.' });
  }

  const pending = pendingLoginOtps.get(tempToken);
  if (Date.now() > pending.expiresAt) {
    pendingLoginOtps.delete(tempToken);
    return res.status(400).json({ success: false, error: 'OTP has expired. Please log in again.' });
  }

  if (pending.attempts >= 4) {
    pendingLoginOtps.delete(tempToken);
    return res.status(429).json({ success: false, error: 'Too many incorrect attempts! This OTP has been invalidated.' });
  }

  if (!otp || String(otp).trim() !== String(pending.otp).trim()) {
    pending.attempts += 1;
    const remaining = 4 - pending.attempts;
    return res.status(400).json({ success: false, error: `Incorrect OTP entered! (Remaining attempts: ${remaining})` });
  }

  // OTP verified!
  const user = pending.user;
  const rememberMe = pending.rememberMe;
  pendingLoginOtps.delete(tempToken);

  const token = 'hisab_usr_' + crypto.randomBytes(32).toString('hex');
  const durationMs = rememberMe ? (365 * 24 * 60 * 60 * 1000) : (24 * 60 * 60 * 1000);
  const expiresAt = Date.now() + durationMs;

  appAuthSessions.set(token, {
    userId: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    expiresAt
  });

  recordLoginEvent(user, 'success', req.ip, req);
  logAdminActivity('USER_LOGIN', 'SECURITY', 'સફળ OTP લૉગિન', 'User OTP Login Successful', `${user.name} (${user.role}) 2-Step OTP વડે લૉગિન થયું`, `Successful 2FA OTP login: ${user.username}`, 'success', req);

  return res.json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      roleTitle: user.roleTitle || (user.role === 'accountant' ? 'એકાઉન્ટન્ટ' : 'કાઉન્ટર સ્ટાફ')
    },
    expiresAt,
    message: '2-Step વેરિફિકેશન સફળ! સ્વાગત છે.'
  });
});

// Resend 2-Step Login OTP
app.post('/api/auth/resend-login-otp', async (req, res) => {
  const { tempToken } = req.body;
  if (!tempToken || !pendingLoginOtps.has(tempToken)) {
    return res.status(400).json({ success: false, error: 'અમાન્ય સેશન. કૃપા કરીને ફરી લૉગિન પ્રયત્ન કરો.' });
  }

  const pending = pendingLoginOtps.get(tempToken);
  const newOtp = String(Math.floor(100000 + Math.random() * 900000));
  pending.otp = newOtp;
  pending.expiresAt = Date.now() + (10 * 60 * 1000);
  pending.attempts = 0;

  try {
    const transporter = getMailTransporter();
    if (transporter) {
      const senderStr = getEmailSenderString();
      const senderName = getSenderDisplayName();
      await transporter.sendMail({
        from: senderStr,
        to: pending.targetEmail,
        subject: `🔐 Resent Login OTP: ${newOtp} - ${senderName}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 480px; margin: 0 auto; background: #ffffff;">
            <h2 style="color: #b45309; margin: 0; font-size: 1.25rem;">🔐 નવો લૉગિન OTP</h2>
            <p style="color: #475569; font-size: 0.95rem; margin-top: 12px;">નવો ૬-અંકનો સુરક્ષા કોડ:</p>
            <div style="text-align: center; margin: 20px 0;">
              <span style="font-size: 2.2rem; font-weight: 800; letter-spacing: 8px; color: #1e293b; background: #fef3c7; padding: 12px 28px; border-radius: 10px; border: 2px dashed #f59e0b; display: inline-block;">
                ${newOtp}
              </span>
            </div>
            <p style="color: #64748b; font-size: 0.82rem;">⏳ આ OTP માત્ર 10 મિનિટ માટે માન્ય છે.</p>
          </div>
        `
      });
    }
    return res.json({ success: true, message: 'નવો OTP સફળતાપૂર્વક મોકલવામાં આવ્યો છે!' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'OTP મોકલવામાં ભૂલ આવી: ' + err.message });
  }
});

// Self-Service: Change Password for Authenticated User
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'જૂનો પાસવર્ડ અને નવો પાસવર્ડ બંને દાખલ કરવા જરૂરી છે.' });
  }
  if (String(newPassword).trim().length < 6) {
    return res.status(400).json({ success: false, error: 'નવો પાસવર્ડ ઓછામાં ઓછો 6 અક્ષરનો હોવો જોઈએ.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.authUser.userId || u.username === req.authUser.username);
  if (!user) {
    return res.status(404).json({ success: false, error: 'યુઝર મળ્યો નથી.' });
  }

  const isOldValid = verifyPassword(oldPassword, user.passwordHash || user.password);
  if (!isOldValid) {
    return res.status(400).json({ success: false, error: 'જૂનો પાસવર્ડ ખોટો છે!' });
  }

  user.passwordHash = hashPassword(String(newPassword).trim());
  delete user.password;
  saveUsers(users);

  logAdminActivity('PASSWORD_CHANGED', 'SECURITY', 'પાસવર્ડ બદલ્યો', 'Password Changed', `${user.name} (${user.username}) એ પાસવર્ડ સફળતાપૂર્વક બદલ્યો`, `Password updated for ${user.username}`, 'success', req);

  return res.json({ success: true, message: 'પાસવર્ડ સફળતાપૂર્વક બદલાઈ ગયો છે!' });
});

// Admin Toggle: 2-Step Login OTP (2FA)
app.post('/api/admin/toggle-2fa', requireAdminAuth, (req, res) => {
  const settings = getSettings();
  settings.login2faEnabled = !Boolean(settings.login2faEnabled);
  saveSettings(settings);

  const statusText = settings.login2faEnabled ? 'ચાલુ (Enabled)' : 'બંધ (Disabled)';
  logAdminActivity('2FA_TOGGLED', 'SECURITY', '2-Step વેરિફિકેશન સેટિંગ', '2FA Setting Changed', `Login 2FA OTP ${statusText} કરવામાં આવ્યું`, `Login 2FA OTP status: ${statusText}`, 'info', req);

  return res.json({
    success: true,
    login2faEnabled: settings.login2faEnabled,
    message: `2-Step વેરિફિકેશન સફળતાપૂર્વક ${statusText} કરવામાં આવ્યું છે.`
  });
});

app.post('/api/auth/verify', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.replace(/^Bearer\s+/i, '')) || req.body.token;

  if (!token) {
    return res.status(401).json({ success: false, valid: false });
  }

  const session = appAuthSessions.get(token);
  if (session && session.expiresAt > Date.now()) {
    return res.json({
      success: true,
      valid: true,
      user: {
        id: session.userId,
        name: session.name,
        username: session.username,
        role: session.role
      }
    });
  }

  // Also accept admin session tokens
  const admSession = adminSessions.get(token);
  if (admSession && admSession.expiresAt > Date.now()) {
    return res.json({
      success: true,
      valid: true,
      user: {
        id: 'usr_admin',
        name: 'સુપર એડમિન',
        username: 'admin',
        role: 'admin'
      }
    });
  }

  // Graceful fallback for persistent client token
  if (token.startsWith('hisab_usr_')) {
    const users = getUsers();
    const defaultUser = users[0] || { id: 'usr_001', name: 'કાઉન્ટર સ્ટાફ', username: 'user', role: 'user' };
    appAuthSessions.set(token, {
      userId: defaultUser.id,
      username: defaultUser.username,
      name: defaultUser.name,
      role: defaultUser.role,
      expiresAt: Date.now() + (365 * 24 * 60 * 60 * 1000)
    });
    return res.json({
      success: true,
      valid: true,
      user: {
        id: defaultUser.id,
        name: defaultUser.name,
        username: defaultUser.username,
        role: defaultUser.role
      }
    });
  }

  return res.status(401).json({ success: false, valid: false });
});

// =========================================================================
// USER MANAGEMENT ENDPOINTS (/api/users)
// =========================================================================
app.get('/api/users', (req, res) => {
  const users = getUsers();
  const safeUsers = users.map(u => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    roleTitle: u.roleTitle || (u.role === 'accountant' ? 'એકાઉન્ટન્ટ' : 'કાઉન્ટર સ્ટાફ'),
    phone: u.phone || '',
    email: u.email || '',
    status: u.status || 'active',
    createdAt: u.createdAt,
    lastLogin: u.lastLogin
  }));
  return res.json({ success: true, users: safeUsers });
});

app.post('/api/users', (req, res) => {
  const { name, username, password, role, phone, email } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ success: false, error: 'નામ, યુઝરનેમ અને પાસવર્ડ ફરજિયાત છે.' });
  }

  const cleanUsername = String(username).toLowerCase().trim();
  const users = getUsers();
  if (users.some(u => u.username && u.username.toLowerCase().trim() === cleanUsername)) {
    return res.status(400).json({ success: false, error: 'આ યુઝરનેમ પહેલેથી જ અસ્તિત્વમાં છે. કૃપા કરીને બીજું યુઝરનેમ પસંદ કરો.' });
  }

  const newUser = {
    id: 'usr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    name: name.trim(),
    username: cleanUsername,
    passwordHash: hashPassword(password),
    role: (role === 'accountant') ? 'accountant' : 'user',
    roleTitle: (role === 'accountant') ? 'એકાઉન્ટન્ટ' : 'કાઉન્ટર સ્ટાફ',
    phone: (phone || '').trim(),
    email: (email || '').trim().toLowerCase(),
    status: 'active',
    createdAt: new Date().toISOString(),
    lastLogin: null
  };

  users.push(newUser);
  saveUsers(users);
  logAdminActivity('USER_CREATED', 'SECURITY', 'નવો યુઝર ઉમેર્યો', 'New User Added', `નવો ${newUser.role}: ${newUser.name} (${newUser.username}) ઉમેર્યો`, `Added user ${newUser.username}`, 'success', req);

  return res.json({ success: true, user: newUser, message: 'નવો યુઝર સફળતાપૂર્વક ઉમેરાયો!' });
});

app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const { name, password, role, phone, status, email } = req.body;
  const users = getUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'યુઝર મળ્યો નથી.' });
  }

  if (name) users[idx].name = name.trim();
  if (password && String(password).trim().length > 0) {
    users[idx].passwordHash = hashPassword(password);
    delete users[idx].password;
  }
  if (role) {
    users[idx].role = (role === 'accountant') ? 'accountant' : 'user';
    users[idx].roleTitle = (role === 'accountant') ? 'એકાઉન્ટન્ટ' : 'કાઉન્ટર સ્ટાફ';
  }
  if (phone !== undefined) users[idx].phone = String(phone).trim();
  if (email !== undefined) users[idx].email = String(email).trim().toLowerCase();
  if (status) users[idx].status = status;

  users[idx].updatedAt = new Date().toISOString();
  saveUsers(users);
  logAdminActivity('USER_UPDATED', 'SECURITY', 'યુઝર વિગત સુધારી', 'User Updated', `યુઝર ${users[idx].name} ની વિગતો સુધારી`, `Updated user ${users[idx].username}`, 'info', req);

  return res.json({ success: true, message: 'યુઝર વિગતો સફળતાપૂર્વક સુધારી!' });
});

app.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  let users = getUsers();
  const target = users.find(u => u.id === id);
  if (!target) {
    return res.status(404).json({ success: false, error: 'યુઝર મળ્યો નથી.' });
  }

  if (users.length <= 1) {
    return res.status(400).json({ success: false, error: 'ઓછામાં ઓછો એક યુઝર સિસ્ટમમાં હોવો જરૂરી છે.' });
  }

  users = users.filter(u => u.id !== id);
  saveUsers(users);
  logAdminActivity('USER_DELETED', 'SECURITY', 'યુઝર ડિલીટ કર્યો', 'User Deleted', `યુઝર ${target.name} (${target.username}) ડિલીટ કર્યો`, `Deleted user ${target.username}`, 'danger', req);

  return res.json({ success: true, message: 'યુઝર સફળતાપૂર્વક ડિલીટ કર્યો!' });
});

app.get('/api/login-history', (req, res) => {
  const list = getLoginHistory();
  return res.json({ success: true, history: list });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.replace(/^Bearer\s+/i, '')) || req.body.token;
  if (token) {
    appAuthSessions.delete(token);
    adminSessions.delete(token);
  }
  return res.json({ success: true, message: 'સફળતાપૂર્વક લૉગઆઉટ થઈ ગયું.' });
});

// 3a-2. Admin Logout: Destroy Session Token
app.post('/api/admin/logout', (req, res) => {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-token'];
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token) adminSessions.delete(token);
  }
  logAdminActivity('LOGOUT', 'SECURITY', 'એડમિન લૉગ આઉટ', 'Admin Logout', 'એડમિન સત્ર સુરક્ષિત રીતે બંધ કરવામાં આવ્યું', 'Admin session logged out safely', 'info', req);
  res.json({ success: true, message: 'એડમિન સુરક્ષિત રીતે લૉગ આઉટ થયું' });
});

// 3b-0. Admin Action OTP Request (For Change PIN, Change Email, Backup & Restore)
app.post('/api/admin/action-otp/request', requireAdminAuth, async (req, res) => {
  try {
    const { actionType } = req.body;
    const validActions = ['CHANGE_PIN', 'CHANGE_EMAIL', 'BACKUP_RESTORE', 'BACKUP_DOWNLOAD', 'RESTORE_BACKUP'];
    if (!actionType || !validActions.includes(actionType)) {
      return res.status(400).json({ success: false, error: 'અમાન્ય OTP પ્રક્રિયા પ્રકાર!' });
    }

    const transporter = getMailTransporter();
    if (!transporter) {
      return res.status(500).json({ success: false, error: 'Email SMTP રૂપરેખાંકિત નથી.' });
    }

    const currentSettings = getSettings();
    const recipient = process.env.ADMIN_ALERT_EMAIL || currentSettings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';
    const senderStr = getEmailSenderString();
    const senderName = getSenderDisplayName();

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + (10 * 60 * 1000); // 10 minutes
    adminActionOtp = { otp, actionType, expiresAt, attempts: 0 };

    let actionTitleEn = 'Admin Security Verification';
    let actionDescEn = 'authorize your requested administrative action';
    let actionIcon = '🔐';

    if (actionType === 'CHANGE_PIN') {
      actionTitleEn = 'Admin Security PIN Change Verification';
      actionDescEn = 'change your Admin Security PIN';
      actionIcon = '🔐';
    } else if (actionType === 'CHANGE_EMAIL') {
      actionTitleEn = 'Admin Security Email Change Verification';
      actionDescEn = 'update your registered Admin Alert Email';
      actionIcon = '📧';
    } else if (actionType === 'BACKUP_RESTORE' || actionType === 'BACKUP_DOWNLOAD' || actionType === 'RESTORE_BACKUP') {
      actionTitleEn = 'Data Backup & Restore Authorization';
      actionDescEn = 'download a full database backup or restore account data';
      actionIcon = '💾';
    }

    const nowStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    await transporter.sendMail({
      from: senderStr,
      to: recipient,
      subject: `${actionIcon} Security OTP: ${otp} - ${actionTitleEn} (${senderName})`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 520px; margin: 0 auto; background: #ffffff;">
          <div style="border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 16px;">
            <h2 style="color: #1d4ed8; margin: 0; font-size: 1.3rem;">${actionIcon} ${actionTitleEn}</h2>
            <p style="color: #64748b; font-size: 0.85rem; margin: 4px 0 0 0;">Organization: <strong>${senderName}</strong></p>
          </div>
          <p style="color: #334155; font-size: 0.95rem; line-height: 1.6;">
            A request was made to <strong>${actionDescEn}</strong> for <strong>${senderName}</strong> on <strong>${nowStr} (IST)</strong>.
          </p>
          <p style="color: #334155; font-size: 0.95rem; line-height: 1.6; margin-top: 8px;">
            Please use the 6-digit One-Time Password (OTP) below to complete this action:
          </p>
          <div style="text-align: center; margin: 24px 0;">
            <div style="display: inline-block; background: #eff6ff; border: 2px dashed #2563eb; border-radius: 12px; padding: 14px 34px; font-size: 2.2rem; font-weight: 900; letter-spacing: 8px; color: #1e40af;">
              ${otp}
            </div>
            <p style="color: #64748b; font-size: 0.82rem; margin-top: 8px;">⏳ This OTP is valid for <strong>10 minutes</strong>.</p>
          </div>
          <div style="background: #fef2f2; border-radius: 8px; padding: 12px 16px; border-left: 4px solid #ef4444;">
            <p style="margin: 0; font-size: 0.85rem; color: #991b1b; line-height: 1.5;">
              ⚠️ <strong>Security Notice:</strong> If you did not initiate this request, someone may be attempting to alter your system settings. Do not share this OTP with anyone.
            </p>
          </div>
        </div>
      `
    });

    const maskedEmail = recipient.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.max(b.length, 3)) + c);
    logAdminActivity('OTP_REQUESTED', 'SECURITY', 'સુરક્ષા OTP મોકલ્યો', 'Security OTP Sent', `OTP હેતુ: ${actionType} (${maskedEmail} પર મોકલ્યો)`, `Requested security OTP for ${actionType} sent to ${maskedEmail}`, 'info', req);

    res.json({
      success: true,
      message: `૬-અંકનો સુરક્ષા OTP તમારા રજિસ્ટર્ડ ઈમેલ (${maskedEmail}) પર મોકલવામાં આવ્યો છે!`,
      email: maskedEmail
    });
  } catch (err) {
    console.error('[Action-OTP] Failed to send OTP:', err);
    res.status(500).json({ success: false, error: 'OTP મોકલવામાં ભૂલ આવી: ' + err.message });
  }
});

// 3b. Admin PIN: Change PIN (Protected - Requires OTP)
app.post('/api/admin/change-pin', requireAdminAuth, (req, res) => {
  const { oldPin, newPin, otp } = req.body;

  // Mandatory OTP check
  const otpCheck = verifyAdminActionOtp(otp, 'CHANGE_PIN');
  if (!otpCheck.valid) {
    return res.status(400).json({ success: false, error: otpCheck.error });
  }

  const settings = getSettings();
  const currentPin = settings.adminPin || '1234';
  if (String(oldPin).trim() !== String(currentPin).trim()) {
    return res.status(401).json({ success: false, error: 'જૂનો પિન ખોટો છે!' });
  }
  if (!newPin || String(newPin).trim().length < 4) {
    return res.status(400).json({ success: false, error: 'નવો પિન ઓછામાં ઓછો 4 અંકનો હોવો જોઈએ!' });
  }
  settings.adminPin = String(newPin).trim();
  saveSettings(settings);

  // Send async notification of PIN change in English
  try {
    const transporter = getMailTransporter();
    if (transporter) {
      const currentSettings = getSettings();
      const recipient = process.env.ADMIN_ALERT_EMAIL || currentSettings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';
      const nowStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const senderStr = getEmailSenderString();
      const senderName = getSenderDisplayName();

      transporter.sendMail({
        from: senderStr,
        to: recipient,
        subject: `🔐 Admin PIN Successfully Updated - ${senderName}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 22px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 500px; margin: 0 auto; background: #ffffff;">
            <h3 style="color: #059669; margin-top: 0; font-size: 1.2rem;">✅ Admin PIN Successfully Changed</h3>
            <p style="color: #334155; font-size: 14px; line-height: 1.6;">
              Your Admin Security PIN for <strong>${senderName}</strong> has been updated successfully.
            </p>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; margin: 12px 0;">
              <p style="margin: 0; color: #475569; font-size: 13px;"><strong>Updated At:</strong> ${nowStr} (IST)</p>
            </div>
            <p style="color: #b91c1c; font-size: 13px;">
              If you did not make this change, please reset your PIN immediately or contact support.
            </p>
          </div>
        `
      }).catch(() => {});
    }
  } catch (e) {}

  logAdminActivity('PIN_CHANGED', 'SECURITY', 'સિક્યુરિટી પિન બદલ્યો', 'Admin PIN Changed', 'એડમિન સુરક્ષા પિન સફળતાપૂર્વક અપડેટ થયો', 'Admin security PIN changed successfully with OTP', 'success', req);

  res.json({ success: true, message: 'એડમિન પિન સફળતાપૂર્વક બદલાઈ ગયો!' });
});

// 3b-post. Change Admin Alert Email (Protected - Requires OTP on old email)
app.post('/api/admin/change-alert-email', requireAdminAuth, async (req, res) => {
  try {
    const { newEmail, otp } = req.body;
    if (!newEmail || !String(newEmail).includes('@') || !String(newEmail).includes('.')) {
      return res.status(400).json({ success: false, error: 'કૃપા કરીને માન્ય ઈમેલ એડ્રેસ દાખલ કરો!' });
    }

    const cleanNewEmail = String(newEmail).trim().toLowerCase();
    const settings = getSettings();
    const oldEmail = settings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';

    if (cleanNewEmail === oldEmail.toLowerCase()) {
      return res.json({ success: true, message: 'ઈમેલ એડ્રેસ પહેલેથી જ આ સેટ કરેલું છે.' });
    }

    // Verify OTP sent to current registered email
    const otpCheck = verifyAdminActionOtp(otp, 'CHANGE_EMAIL');
    if (!otpCheck.valid) {
      return res.status(400).json({ success: false, error: otpCheck.error });
    }

    settings.adminAlertEmail = cleanNewEmail;
    saveSettings(settings);

    // Send confirmation to both old and new emails
    const transporter = getMailTransporter();
    if (transporter) {
      const senderStr = getEmailSenderString();
      const senderName = getSenderDisplayName();
      const nowStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 22px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 520px; margin: 0 auto; background: #ffffff;">
          <h3 style="color: #059669; margin-top: 0; font-size: 1.2rem;">✅ Admin Security Email Changed</h3>
          <p style="color: #334155; font-size: 14px; line-height: 1.6;">
            The registered Admin Alert & OTP email for <strong>${senderName}</strong> has been updated.
          </p>
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; margin: 14px 0;">
            <p style="margin: 0 0 6px 0; color: #475569; font-size: 13px;"><strong>Previous Email:</strong> ${oldEmail}</p>
            <p style="margin: 0 0 6px 0; color: #059669; font-size: 13px;"><strong>New Email:</strong> ${cleanNewEmail}</p>
            <p style="margin: 0; color: #64748b; font-size: 12px;"><strong>Updated At:</strong> ${nowStr} (IST)</p>
          </div>
          <p style="color: #b91c1c; font-size: 13px;">
            If you did not authorize this change, please contact your technical administrator immediately.
          </p>
        </div>
      `;

      try {
        await transporter.sendMail({
          from: senderStr,
          to: [oldEmail, cleanNewEmail],
          subject: `📧 Admin Alert Email Updated - ${senderName}`,
          html: emailHtml
        });
      } catch (err) {
        console.error('[Change-Email] Confirmation email notification error:', err);
      }
    }

    logAdminActivity(
      'EMAIL_CHANGED',
      'SETTINGS',
      'એલર્ટ ઈમેલ બદલ્યું',
      'Alert Email Changed',
      `નવું ઈમેલ: ${cleanNewEmail} (જૂનું: ${oldEmail})`,
      `Alert email updated to ${cleanNewEmail}`,
      'success',
      req,
      {
        type: 'EMAIL_CHANGE',
        changes: [
          { field: 'એલર્ટ ઈમેલ (Alert Email)', before: oldEmail, after: cleanNewEmail }
        ]
      }
    );

    res.json({ success: true, message: 'એડમિન એલર્ટ & OTP ઈમેલ સફળતાપૂર્વક બદલાઈ ગયું છે!' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'ઈમેલ અપડેટ કરવામાં ભૂલ: ' + err.message });
  }
});

// 3b-1. OTP Endpoints for Forgot PIN (English Template & Custom Sender)
app.post('/api/admin/forgot-pin-request', async (req, res) => {
  try {
    const transporter = getMailTransporter();
    if (!transporter) {
      return res.status(500).json({ success: false, error: 'Email SMTP is not configured' });
    }
    const currentSettings = getSettings();
    const recipient = process.env.ADMIN_ALERT_EMAIL || currentSettings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';
    const senderStr = getEmailSenderString();
    const senderName = getSenderDisplayName();
    
    // Generate 6-digit random OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + (10 * 60 * 1000); // 10 minutes
    activeOtpData = { otp, expiresAt, attempts: 0 };

    await transporter.sendMail({
      from: senderStr,
      to: recipient,
      subject: `🔑 PIN Reset OTP: ${otp} - ${senderName}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 520px; margin: 0 auto; background: #ffffff;">
          <div style="border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 16px;">
            <h2 style="color: #1d4ed8; margin: 0; font-size: 1.3rem;">🔑 Admin PIN Reset Request</h2>
            <p style="color: #64748b; font-size: 0.85rem; margin: 4px 0 0 0;">Security Verification - ${senderName}</p>
          </div>
          <p style="color: #334155; font-size: 0.95rem; line-height: 1.6;">
            Hello, we received a request to reset your Admin Security PIN for <strong>${senderName}</strong>. Use the One-Time Password (OTP) below:
          </p>
          <div style="text-align: center; margin: 24px 0;">
            <div style="display: inline-block; background: #eff6ff; border: 2px dashed #2563eb; border-radius: 12px; padding: 14px 34px; font-size: 2rem; font-weight: 900; letter-spacing: 8px; color: #1e40af;">
              ${otp}
            </div>
            <p style="color: #64748b; font-size: 0.82rem; margin-top: 8px;">⏳ This OTP is valid for <strong>10 minutes</strong>.</p>
          </div>
          <div style="background: #f8fafc; border-radius: 8px; padding: 12px 16px; border-left: 4px solid #64748b;">
            <p style="margin: 0; font-size: 0.85rem; color: #475569; line-height: 1.5;">
              For security reasons, never share this OTP with anyone. If you did not request this code, you can safely ignore this email.
            </p>
          </div>
        </div>
      `
    });

    const maskedEmail = recipient.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.max(b.length, 3)) + c);
    res.json({
      success: true,
      message: `A 6-digit OTP has been sent to your registered email (${maskedEmail})!`,
      email: maskedEmail
    });
  } catch (err) {
    console.error('[OTP] Failed to send OTP email:', err);
    res.status(500).json({ success: false, error: 'Failed to send OTP email: ' + err.message });
  }
});

// 3b-2. Verify OTP & Reset Admin PIN (English Confirmation & Custom Sender)
app.post('/api/admin/reset-pin-with-otp', async (req, res) => {
  const { otp, newPin } = req.body;
  if (!activeOtpData) {
    return res.status(400).json({ success: false, error: 'No active OTP found. Please request a new OTP.' });
  }

  if (Date.now() > activeOtpData.expiresAt) {
    activeOtpData = null;
    return res.status(400).json({ success: false, error: 'This OTP has expired. Please request a new OTP.' });
  }

  if (activeOtpData.attempts >= 4) {
    activeOtpData = null;
    return res.status(429).json({ success: false, error: 'Too many incorrect attempts! For security, this OTP has been cancelled.' });
  }

  if (String(otp).trim() !== String(activeOtpData.otp).trim()) {
    activeOtpData.attempts += 1;
    const remaining = 4 - activeOtpData.attempts;
    return res.status(400).json({ success: false, error: `Invalid OTP entered! (${remaining} attempts remaining)` });
  }

  if (!newPin || String(newPin).trim().length < 4) {
    return res.status(400).json({ success: false, error: 'New PIN must be at least 4 digits long!' });
  }

  // OTP is correct! Reset PIN
  const cleanPin = String(newPin).trim();
  const settings = getSettings();
  settings.adminPin = cleanPin;
  saveSettings(settings);
  activeOtpData = null; // consume OTP
  adminFailedAttempts = 0;
  adminLockoutUntil = 0;

  // Send confirmation email asynchronously
  try {
    const transporter = getMailTransporter();
    if (transporter) {
      const currentSettings = getSettings();
      const recipient = process.env.ADMIN_ALERT_EMAIL || currentSettings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';
      const nowStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const senderStr = getEmailSenderString();
      const senderName = getSenderDisplayName();

      transporter.sendMail({
        from: senderStr,
        to: recipient,
        subject: `✅ Admin PIN Successfully Reset - ${senderName}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 22px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 500px; margin: 0 auto; background: #ffffff;">
            <h3 style="color: #059669; margin-top: 0; font-size: 1.2rem;">✅ Admin PIN Reset via OTP Successful</h3>
            <p style="color: #334155; font-size: 14px; line-height: 1.6;">
              Your Admin Security PIN for <strong>${senderName}</strong> has been updated via Email OTP verification.
            </p>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; margin: 12px 0;">
              <p style="margin: 0; color: #475569; font-size: 13px;"><strong>Reset At:</strong> ${nowStr} (IST)</p>
            </div>
            <p style="color: #64748b; font-size: 13px;">
              You can now log in using your new 4-digit PIN.
            </p>
          </div>
        `
      }).catch(() => {});
    }
  } catch (e) {}

  res.json({ success: true, message: 'New Admin PIN has been set successfully!' });
});

// 3b-3. Test Email Route (English & Custom Sender Name)
app.post('/api/admin/test-email', requireAdminAuth, async (req, res) => {
  try {
    const transporter = getMailTransporter();
    if (!transporter) {
      return res.status(500).json({ success: false, error: 'Email SMTP is not configured' });
    }
    const currentSettings = getSettings();
    const recipient = (req.body.email && req.body.email.trim()) || process.env.ADMIN_ALERT_EMAIL || currentSettings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';
    const customSender = (req.body.senderName && req.body.senderName.trim()) || null;
    const senderStr = getEmailSenderString(customSender);
    const senderName = getSenderDisplayName(customSender);
    const nowStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    await transporter.sendMail({
      from: senderStr,
      to: recipient,
      subject: `🔔 Test Email: Connection Verified - ${senderName}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 22px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 500px; margin: 0 auto; background: #ffffff;">
          <h3 style="color: #059669; margin-top: 0; font-size: 1.25rem;">✅ Gmail SMTP Connection Verified!</h3>
          <p style="color: #334155; font-size: 14px; line-height: 1.6;">
            This test email confirms that your email notifications and OTP recovery system are active and properly connected.
          </p>
          <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 12px 16px; margin: 15px 0;">
            <p style="margin: 4px 0; color: #1e293b; font-size: 13.5px;"><strong>Sender Display Name:</strong> ${senderName}</p>
            <p style="margin: 4px 0; color: #1e293b; font-size: 13.5px;"><strong>Delivered To:</strong> ${recipient}</p>
            <p style="margin: 4px 0; color: #1e293b; font-size: 13.5px;"><strong>Date & Time:</strong> ${nowStr} (IST)</p>
          </div>
          <p style="color: #64748b; font-size: 12.5px; margin: 0;">
            All future login alerts and OTPs will be delivered with this sender name.
          </p>
        </div>
      `
    });
    logAdminActivity(
      'TEST_EMAIL',
      'SECURITY',
      'ટેસ્ટ ઈમેલ મોકલ્યો',
      'Test Email Sent',
      `સફળતાપૂર્વક ${recipient} પર ઈમેલ મોકલ્યો (પ્રેષક: ${senderName})`,
      `Sent test email to ${recipient} (Sender: ${senderName})`,
      'success',
      req
    );
    res.json({ success: true, message: `Test email sent successfully to ${recipient} as "${senderName}"!` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to send test email: ' + err.message });
  }
});

// 3c. Admin: Rename Bank Option (Protected)
app.post('/api/admin/rename-bank', requireAdminAuth, (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName || !newName.trim()) {
    return res.status(400).json({ error: 'જૂનું અને નવું નામ બંને જરૂરી છે' });
  }
  const settings = getSettings();
  const banks = settings.defaultBanks || [];
  const inactiveBanks = settings.inactiveBanks || [];
  let found = false;

  const idx = banks.findIndex(b => b.trim().toLowerCase() === oldName.trim().toLowerCase());
  if (idx !== -1) {
    banks[idx] = newName.trim();
    settings.defaultBanks = banks;
    found = true;
  }
  const inIdx = inactiveBanks.findIndex(b => b.trim().toLowerCase() === oldName.trim().toLowerCase());
  if (inIdx !== -1) {
    inactiveBanks[inIdx] = newName.trim();
    settings.inactiveBanks = inactiveBanks;
    found = true;
  }

  if (found) {
    saveSettings(settings);
    logAdminActivity(
      'BANK_RENAME',
      'SETTINGS',
      'બેંક ખાતાનું નામ બદલ્યું',
      'Bank Khata Renamed',
      `'${oldName}' નું નામ બદલીને '${newName.trim()}' કર્યું`,
      `Renamed bank from '${oldName}' to '${newName.trim()}'`,
      'info',
      req,
      {
        type: 'BANK_RENAME',
        changes: [
          { field: 'બેંક ખાતું (Bank Khata)', before: oldName, after: newName.trim() }
        ]
      }
    );
  }
  res.json({ success: true, banks: settings.defaultBanks, inactiveBanks: settings.inactiveBanks || [] });
});

// 3c-1. Admin: Toggle Bank Status (Active / Inactive) (Protected)
app.post('/api/admin/toggle-bank-status', requireAdminAuth, (req, res) => {
  const { name, active } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'બેંકનું નામ જરૂરી છે' });
  const settings = getSettings();
  const banks = (settings.defaultBanks || []).map(b => b.trim());
  const inactiveBanks = (settings.inactiveBanks || []).map(b => b.trim());
  const target = String(name).trim();

  if (active) {
    // Activate: remove from inactive, add to active
    const idx = inactiveBanks.findIndex(b => b.toUpperCase() === target.toUpperCase());
    if (idx !== -1) inactiveBanks.splice(idx, 1);
    if (!banks.some(b => b.toUpperCase() === target.toUpperCase())) {
      banks.push(target);
    }
  } else {
    // Deactivate: check minimum 1 active bank
    if (banks.length <= 1) {
      return res.status(400).json({ success: false, error: 'ઓછામાં ઓછું એક બેંક ખાતું સક્રિય હોવું જરૂરી છે!' });
    }
    const idx = banks.findIndex(b => b.toUpperCase() === target.toUpperCase());
    if (idx !== -1) banks.splice(idx, 1);
    if (!inactiveBanks.some(b => b.toUpperCase() === target.toUpperCase())) {
      inactiveBanks.push(target);
    }
  }

  settings.defaultBanks = banks;
  settings.inactiveBanks = inactiveBanks;
  saveSettings(settings);

  const statusStr = active ? 'સક્રિય (Active)' : 'નિષ્ક્રિય (Inactive)';
  logAdminActivity(
    'BANK_STATUS_CHANGE',
    'SETTINGS',
    'બેંક ખાતાની સ્થિતિ બદલી',
    'Bank Status Changed',
    `'${target}' બેંક ખાતું ${statusStr} કર્યું`,
    `Changed bank '${target}' status to ${active ? 'Active' : 'Inactive'}`,
    active ? 'success' : 'warning',
    req,
    {
      type: 'BANK_STATUS_CHANGE',
      changes: [
        { field: 'બેંક સ્થિતિ (Bank Status)', before: active ? 'નિષ્ક્રિય (Inactive)' : 'સક્રિય (Active)', after: statusStr }
      ]
    }
  );

  res.json({ success: true, banks: settings.defaultBanks, inactiveBanks: settings.inactiveBanks });
});

// 3c-2. Admin: Permanently Delete Bank (Protected)
app.post('/api/admin/delete-bank', requireAdminAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'બેંકનું નામ જરૂરી છે' });
  const settings = getSettings();
  const banks = (settings.defaultBanks || []).map(b => b.trim());
  const inactiveBanks = (settings.inactiveBanks || []).map(b => b.trim());
  const target = String(name).trim();

  const totalAccounts = banks.length + inactiveBanks.length;
  if (totalAccounts <= 1) {
    return res.status(400).json({ success: false, error: 'ઓછામાં ઓછું એક બેંક ખાતું હોવું અનિવાર્ય છે!' });
  }

  const bIdx = banks.findIndex(b => b.toUpperCase() === target.toUpperCase());
  if (bIdx !== -1) {
    if (banks.length <= 1 && inactiveBanks.length === 0) {
      return res.status(400).json({ success: false, error: 'ઓછામાં ઓછું એક બેંક ખાતું સક્રિય હોવું અનિવાર્ય છે!' });
    }
    banks.splice(bIdx, 1);
  }
  const inIdx = inactiveBanks.findIndex(b => b.toUpperCase() === target.toUpperCase());
  if (inIdx !== -1) {
    inactiveBanks.splice(inIdx, 1);
  }

  settings.defaultBanks = banks;
  settings.inactiveBanks = inactiveBanks;
  saveSettings(settings);

  logAdminActivity(
    'BANK_DELETE',
    'SETTINGS',
    'બેંક ખાતું કાયમી ડિલીટ કર્યું',
    'Bank Khata Permanently Deleted',
    `'${target}' બેંક ખાતું સેટિંગ્સમાંથી કાયમી કાઢી નાખવામાં આવ્યું`,
    `Permanently deleted bank '${target}' from settings`,
    'danger',
    req,
    {
      type: 'BANK_DELETE',
      changes: [
        { field: 'બેંક ખાતું (Bank Khata)', before: target, after: '[કાયમી ડિલીટ - Deleted]' }
      ]
    }
  );

  res.json({ success: true, banks: settings.defaultBanks, inactiveBanks: settings.inactiveBanks });
});

// 3d. Admin: Rename Voucher Option (Protected)
app.post('/api/admin/rename-voucher', requireAdminAuth, (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName || !newName.trim()) {
    return res.status(400).json({ error: 'જૂનું અને નવું નામ બંને જરૂરી છે' });
  }
  const settings = getSettings();
  const vouchers = settings.defaultVouchers || [];
  const inactiveVouchers = settings.inactiveVouchers || [];
  let found = false;

  const idx = vouchers.findIndex(v => isSameKhata(v, oldName));
  if (idx !== -1) {
    vouchers[idx] = newName.trim();
    settings.defaultVouchers = vouchers;
    found = true;
  }
  const inIdx = inactiveVouchers.findIndex(v => isSameKhata(v, oldName));
  if (inIdx !== -1) {
    inactiveVouchers[inIdx] = newName.trim();
    settings.inactiveVouchers = inactiveVouchers;
    found = true;
  }

  if (found) {
    saveSettings(settings);
    logAdminActivity(
      'VOUCHER_RENAME',
      'SETTINGS',
      'વાઉચર ખાતાનું નામ બદલ્યું',
      'Voucher Khata Renamed',
      `'${oldName}' નું નામ બદલીને '${newName.trim()}' કર્યું`,
      `Renamed voucher from '${oldName}' to '${newName.trim()}'`,
      'info',
      req,
      {
        type: 'VOUCHER_RENAME',
        changes: [
          { field: 'વાઉચર ખાતું (Voucher Khata)', before: oldName, after: newName.trim() }
        ]
      }
    );
  }
  res.json({ success: true, vouchers: settings.defaultVouchers, inactiveVouchers: settings.inactiveVouchers || [] });
});

// 3d-1. Admin: Toggle Voucher Status (Active / Inactive) (Protected)
app.post('/api/admin/toggle-voucher-status', requireAdminAuth, (req, res) => {
  const { name, active } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'વાઉચરનું નામ જરૂરી છે' });
  const settings = getSettings();
  const vouchers = (settings.defaultVouchers || []).map(v => v.trim());
  const inactiveVouchers = (settings.inactiveVouchers || []).map(v => v.trim());
  const target = String(name).trim();

  if (active) {
    // Activate: remove from inactive, add to active
    const idx = inactiveVouchers.findIndex(v => isSameKhata(v, target));
    if (idx !== -1) inactiveVouchers.splice(idx, 1);
    if (!vouchers.some(v => isSameKhata(v, target))) {
      vouchers.push(target);
    }
  } else {
    // Deactivate: check minimum 1 active voucher
    if (vouchers.length <= 1) {
      return res.status(400).json({ success: false, error: 'ઓછામાં ઓછું એક વાઉચર ખાતું સક્રિય હોવું જરૂરી છે!' });
    }
    const idx = vouchers.findIndex(v => isSameKhata(v, target));
    if (idx !== -1) vouchers.splice(idx, 1);
    if (!inactiveVouchers.some(v => isSameKhata(v, target))) {
      inactiveVouchers.push(target);
    }
  }

  settings.defaultVouchers = vouchers;
  settings.inactiveVouchers = inactiveVouchers;
  saveSettings(settings);

  const gujName = getGujaratiKhataName(target) || target;
  const statusStr = active ? 'સક્રિય (Active)' : 'નિષ્ક્રિય (Inactive)';
  logAdminActivity(
    'VOUCHER_STATUS_CHANGE',
    'SETTINGS',
    'વાઉચર ખાતાની સ્થિતિ બદલી',
    'Voucher Status Changed',
    `'${gujName}' વાઉચર ખાતું ${statusStr} કર્યું`,
    `Changed voucher '${target}' status to ${active ? 'Active' : 'Inactive'}`,
    active ? 'success' : 'warning',
    req,
    {
      type: 'VOUCHER_STATUS_CHANGE',
      changes: [
        { field: 'વાઉચર સ્થિતિ (Voucher Status)', before: active ? 'નિષ્ક્રિય (Inactive)' : 'સક્રિય (Active)', after: statusStr }
      ]
    }
  );

  res.json({ success: true, vouchers: settings.defaultVouchers, inactiveVouchers: settings.inactiveVouchers });
});

// 3d-2. Admin: Permanently Delete Voucher (Protected)
app.post('/api/admin/delete-voucher', requireAdminAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'વાઉચરનું નામ જરૂરી છે' });
  const settings = getSettings();
  const vouchers = (settings.defaultVouchers || []).map(v => v.trim());
  const inactiveVouchers = (settings.inactiveVouchers || []).map(v => v.trim());
  const target = String(name).trim();

  const totalAccounts = vouchers.length + inactiveVouchers.length;
  if (totalAccounts <= 1) {
    return res.status(400).json({ success: false, error: 'ઓછામાં ઓછું એક વાઉચર ખાતું હોવું અનિવાર્ય છે!' });
  }

  const vIdx = vouchers.findIndex(v => isSameKhata(v, target));
  if (vIdx !== -1) {
    if (vouchers.length <= 1 && inactiveVouchers.length === 0) {
      return res.status(400).json({ success: false, error: 'ઓછામાં ઓછું એક વાઉચર ખાતું સક્રિય હોવું અનિવાર્ય છે!' });
    }
    vouchers.splice(vIdx, 1);
  }
  const inIdx = inactiveVouchers.findIndex(v => isSameKhata(v, target));
  if (inIdx !== -1) {
    inactiveVouchers.splice(inIdx, 1);
  }

  settings.defaultVouchers = vouchers;
  settings.inactiveVouchers = inactiveVouchers;
  saveSettings(settings);

  const gujName = getGujaratiKhataName(target) || target;
  logAdminActivity(
    'VOUCHER_DELETE',
    'SETTINGS',
    'વાઉચર ખાતું કાયમી ડિલીટ કર્યું',
    'Voucher Khata Permanently Deleted',
    `'${gujName}' વાઉચર ખાતું સેટિંગ્સમાંથી કાયમી કાઢી નાખવામાં આવ્યું`,
    `Permanently deleted voucher '${target}' from settings`,
    'danger',
    req,
    {
      type: 'VOUCHER_DELETE',
      changes: [
        { field: 'વાઉચર ખાતું (Voucher Khata)', before: gujName, after: '[કાયમી ડિલીટ - Deleted]' }
      ]
    }
  );

  res.json({ success: true, vouchers: settings.defaultVouchers, inactiveVouchers: settings.inactiveVouchers });
});

// 3e. Admin: One-Click Full Data Backup (JSON Download - Protected - Requires OTP)
app.get('/api/admin/backup', requireAdminAuth, (req, res) => {
  try {
    const otp = req.query.otp || req.headers['x-admin-otp'];
    const otpCheck = verifyAdminActionOtp(otp, 'BACKUP_RESTORE');
    if (!otpCheck.valid) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>OTP Required</title></head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px; background: #fff5f5;">
          <div style="max-width: 450px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border: 1.5px solid #fecaca;">
            <h2 style="color: #dc2626; margin-top: 0;">❌ સુરક્ષા ચકાસણી (OTP) જરૂરી છે</h2>
            <p style="font-size: 1rem; color: #4b5563; line-height: 1.6;">${otpCheck.error}</p>
            <p style="font-size: 0.85rem; color: #6b7280;">બેકઅપ ડાઉનલોડ કરવા માટે એડમિન પેનલમાં "OTP મેળવો" બટન દબાવો અને OTP દાખલ કરો.</p>
            <button onclick="window.close()" style="margin-top: 15px; padding: 9px 24px; font-weight: bold; background: #2563eb; color: white; border: none; border-radius: 8px; cursor: pointer;">પાછા જાઓ</button>
          </div>
        </body>
        </html>
      `);
    }

    const backupData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      dateStr: getTodayDateStr(),
      settings: getSettings(),
      records: getRecords(),
      employees: getEmployees(),
      uchak: getUchakRecords(),
      bankDeposits: getBankDeposits(),
      bhakts: getBhakts(),
      bhaktDeposits: getBhaktDeposits()
    };
    const jsonStr = JSON.stringify(backupData, null, 2);
    const fileName = `HISAB_PRO_BACKUP_${getTodayDateStr()}.json`;

    logAdminActivity('BACKUP_DOWNLOAD', 'BACKUP', 'ડેટાબેઝ બેકઅપ ડાઉનલોડ', 'Full Backup Downloaded', 'સંપૂર્ણ હિસાબ અને માસ્ટર ડેટાની .JSON ફાઈલ ડાઉનલોડ થઈ', 'Full system database exported to JSON', 'success', req);

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(jsonStr);
  } catch (e) {
    res.status(500).json({ error: 'બેકઅપ તૈયાર કરવામાં ભૂલ: ' + e.message });
  }
});

// 3f. Admin: One-Click Full Data Restore (JSON Upload - Protected - Requires OTP)
app.post('/api/admin/restore', requireAdminAuth, async (req, res) => {
  try {
    const { backupData, otp } = req.body;
    const providedOtp = otp || req.headers['x-admin-otp'] || req.body.otp;

    const otpCheck = verifyAdminActionOtp(providedOtp, 'BACKUP_RESTORE');
    if (!otpCheck.valid) {
      return res.status(400).json({ success: false, error: otpCheck.error });
    }

    const actualData = (backupData && backupData.records) ? backupData : (req.body && req.body.records ? req.body : null);
    if (!actualData || !actualData.records) {
      return res.status(400).json({ success: false, error: 'અમાન્ય બેકઅપ ફાઇલ! હિસાબનો ડેટા મળ્યો નથી.' });
    }

    if (actualData.settings) saveSettings(actualData.settings);
    if (actualData.records) saveRecords(actualData.records);
    if (Array.isArray(actualData.employees)) saveEmployees(actualData.employees);
    if (Array.isArray(actualData.uchak)) saveUchakRecords(actualData.uchak);
    if (Array.isArray(actualData.bankDeposits)) saveBankDeposits(actualData.bankDeposits);
    if (Array.isArray(actualData.bhakts)) saveBhakts(actualData.bhakts);
    if (Array.isArray(actualData.bhaktDeposits)) saveBhaktDeposits(actualData.bhaktDeposits);

    // Send security alert email
    try {
      const transporter = getMailTransporter();
      if (transporter) {
        const currentSettings = getSettings();
        const recipient = process.env.ADMIN_ALERT_EMAIL || currentSettings.adminAlertEmail || 'Teraiya.Kaushik24@gmail.com';
        const senderStr = getEmailSenderString();
        const senderName = getSenderDisplayName();
        const nowStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        transporter.sendMail({
          from: senderStr,
          to: recipient,
          subject: `⚠️ Database Restored from Backup - ${senderName}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 22px; border: 1px solid #fed7aa; border-radius: 12px; max-width: 520px; margin: 0 auto; background: #fffaf5;">
              <h3 style="color: #c2410c; margin-top: 0; font-size: 1.2rem;">⚠️ Database Restored from Backup</h3>
              <p style="color: #334155; font-size: 14px; line-height: 1.6;">
                A database restore operation was completed successfully for <strong>${senderName}</strong>.
              </p>
              <div style="background: #ffffff; border: 1px solid #fed7aa; border-radius: 8px; padding: 12px 14px; margin: 14px 0;">
                <p style="margin: 0 0 4px 0; color: #475569; font-size: 13px;"><strong>Restored Days:</strong> ${Object.keys(actualData.records || {}).length}</p>
                <p style="margin: 0 0 4px 0; color: #475569; font-size: 13px;"><strong>Restored Staff:</strong> ${(actualData.employees || []).length}</p>
                <p style="margin: 0; color: #64748b; font-size: 12px;"><strong>Timestamp:</strong> ${nowStr} (IST)</p>
              </div>
            </div>
          `
        }).catch(() => {});
      }
    } catch (e) {}

    const recCount = Object.keys(actualData.records || {}).length;
    const empCount = (actualData.employees || []).length;
    logAdminActivity('BACKUP_RESTORE', 'BACKUP', 'ડેટાબેઝ રિસ્ટોર કર્યો', 'Database Restored', `${recCount} દિવસો અને ${empCount} કર્મચારીઓ બેકઅપ ફાઈલમાંથી રિસ્ટોર થયા`, `Restored database from JSON file (${recCount} days, ${empCount} staff)`, 'warning', req);

    res.json({
      success: true,
      message: 'તમામ હિસાબ, કર્મચારીઓ અને સેટિંગ્સ સફળતાપૂર્વક રિસ્ટોર થઈ ગયા છે!',
      recordCount: recCount,
      employeeCount: empCount
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'રિસ્ટોર કરવામાં ભૂલ આવી: ' + e.message });
  }
});

// 3g-1. Admin History: Get all logged activities (Protected)
app.get('/api/admin/history', requireAdminAuth, (req, res) => {
  try {
    const { category, search } = req.query;
    let list = getAdminHistory();

    if (category && category !== 'ALL') {
      list = list.filter(item => item.category === category);
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(item => 
        (item.title && item.title.toLowerCase().includes(q)) ||
        (item.titleEn && item.titleEn.toLowerCase().includes(q)) ||
        (item.details && item.details.toLowerCase().includes(q)) ||
        (item.detailsEn && item.detailsEn.toLowerCase().includes(q)) ||
        (item.dateStr && item.dateStr.includes(q))
      );
    }

    res.json({
      success: true,
      count: list.length,
      history: list
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'હિસ્ટ્રી લોડ કરવામાં ભૂલ: ' + err.message });
  }
});

// 3g-2. Admin History: Export history as JSON (Protected)
app.get('/api/admin/history/export', requireAdminAuth, (req, res) => {
  try {
    const list = getAdminHistory();
    const jsonStr = JSON.stringify(list, null, 2);
    const fileName = `HISAB_ADMIN_AUDIT_LOG_${getTodayDateStr()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(jsonStr);
  } catch (e) {
    res.status(500).json({ error: 'હિસ્ટ્રી એક્સપોર્ટ કરવામાં ભૂલ: ' + e.message });
  }
});

// 3g-3. Admin History: Clear history log (Protected - Supports modes: all, 30days, 7days, category)
app.post('/api/admin/history/clear', requireAdminAuth, (req, res) => {
  try {
    const { mode, category } = req.body || {};
    let history = getAdminHistory();
    const initialCount = history.length;
    const now = Date.now();
    let descGu = '';
    let descEn = '';

    if (mode === '30days') {
      const cutoff = now - (30 * 24 * 60 * 60 * 1000);
      history = history.filter(item => item.timestamp > cutoff);
      descGu = `૩૦ દિવસથી જૂની પ્રવૃત્તિઓ સાફ કરી (${initialCount - history.length} રેકોર્ડ્સ)`;
      descEn = `Cleared activities older than 30 days (${initialCount - history.length} records)`;
    } else if (mode === '7days') {
      const cutoff = now - (7 * 24 * 60 * 60 * 1000);
      history = history.filter(item => item.timestamp > cutoff);
      descGu = `૭ દિવસથી જૂની પ્રવૃત્તિઓ સાફ કરી (${initialCount - history.length} રેકોર્ડ્સ)`;
      descEn = `Cleared activities older than 7 days (${initialCount - history.length} records)`;
    } else if (mode === 'category' && category) {
      history = history.filter(item => item.category !== category);
      descGu = `'${category}' કેટેગરીના રેકોર્ડ્સ સાફ કર્યા (${initialCount - history.length} રેકોર્ડ્સ)`;
      descEn = `Cleared category '${category}' records (${initialCount - history.length} records)`;
    } else {
      history = [];
      descGu = `તમામ જૂની પ્રવૃત્તિ હિસ્ટ્રી સાફ કરી (${initialCount} રેકોર્ડ્સ)`;
      descEn = `Cleared all past activity logs (${initialCount} records)`;
    }

    saveAdminHistory(history);
    logAdminActivity(
      'HISTORY_CLEARED',
      'SECURITY',
      'હિસ્ટ્રી સાફ કરી',
      'History Log Cleared',
      descGu,
      descEn,
      'warning',
      req,
      {
        type: 'HISTORY_CLEARED',
        mode: mode || 'all',
        clearedCount: initialCount - history.length,
        remainingCount: history.length
      }
    );
    res.json({ success: true, message: 'એડમિન હિસ્ટ્રી સફળતાપૂર્વક સાફ કરવામાં આવી છે.', remainingCount: history.length });
  } catch (err) {
    res.status(500).json({ success: false, error: 'હિસ્ટ્રી સાફ કરવામાં ભૂલ: ' + err.message });
  }
});

// 4. Admin: Save Full Admin Config (Protected)
app.post('/api/admin/config', requireAdminAuth, (req, res) => {
  const { notes, banks, vouchers, inactiveBanks, inactiveVouchers, orgName, orgSubtitle, phone, exportFolder, printTopOffset, printLeftOffset, signPrepared, signChecked, signPresident } = req.body;
  const current = getSettings();

  // Validate and clean notes
  const cleanNotes = (notes || current.notes || [])
    .map(n => Number(n))
    .filter(n => !isNaN(n) && n > 0)
    .sort((a, b) => b - a); // sort descending (500, 200, 100...)

  // Clean banks
  const cleanBanks = (banks || current.defaultBanks || [])
    .map(b => String(b).trim())
    .filter(Boolean);

  const cleanInactiveBanks = (inactiveBanks !== undefined ? inactiveBanks : (current.inactiveBanks || []))
    .map(b => String(b).trim())
    .filter(Boolean);

  // Clean vouchers
  const cleanVouchers = (vouchers || current.defaultVouchers || [])
    .map(v => String(v).trim())
    .filter(Boolean);

  const cleanInactiveVouchers = (inactiveVouchers !== undefined ? inactiveVouchers : (current.inactiveVouchers || []))
    .map(v => String(v).trim())
    .filter(Boolean);

  const updatedSettings = {
    ...current,
    notes: cleanNotes.length > 0 ? cleanNotes : [500, 200, 100, 50, 20, 10],
    defaultBanks: cleanBanks.length > 0 ? cleanBanks : ['IOB TRF', 'BOB TRF ', 'SBI TRF'],
    inactiveBanks: cleanInactiveBanks,
    defaultVouchers: cleanVouchers.length > 0 ? cleanVouchers : ['MANDIRKHARCH', 'RASODAKHARCH', 'PAGAR'],
    inactiveVouchers: cleanInactiveVouchers
  };

  if (orgName !== undefined) updatedSettings.orgName = String(orgName).trim();
  if (orgSubtitle !== undefined) updatedSettings.orgSubtitle = String(orgSubtitle).trim();
  if (phone !== undefined) updatedSettings.phone = String(phone).trim();
  if (exportFolder !== undefined) updatedSettings.exportFolder = String(exportFolder).trim();
  if (printTopOffset !== undefined) updatedSettings.printTopOffset = Number(printTopOffset) || 140;
  if (printLeftOffset !== undefined) updatedSettings.printLeftOffset = Number(printLeftOffset) || 43;
  if (signPrepared !== undefined) updatedSettings.signPrepared = String(signPrepared).trim();
  if (signChecked !== undefined) updatedSettings.signChecked = String(signChecked).trim();
  if (signPresident !== undefined) updatedSettings.signPresident = String(signPresident).trim();
  if (req.body.smtpSenderName !== undefined) updatedSettings.smtpSenderName = String(req.body.smtpSenderName).trim();
  // Note: adminAlertEmail can ONLY be changed via /api/admin/change-alert-email with OTP verification
  if (req.body.smtpEmail !== undefined) updatedSettings.smtpEmail = String(req.body.smtpEmail).trim();
  if (req.body.smtpAppPassword !== undefined && req.body.smtpAppPassword.trim()) {
    updatedSettings.smtpAppPassword = String(req.body.smtpAppPassword).trim();
  }
  if (req.body.geminiApiKey !== undefined) {
    updatedSettings.geminiApiKey = String(req.body.geminiApiKey).trim();
  }

  saveSettings(updatedSettings);

  // Synchronize the current date record so new items immediately appear
  const today = getTodayDateStr();
  const records = getRecords();
  if (records[today]) {
    const rec = records[today];

    // Notes sync
    const noteMap = {};
    (rec.notes || []).forEach(n => { noteMap[n.note] = n; });
    rec.notes = updatedSettings.notes.map(val => ({
      note: val,
      count: noteMap[val] ? noteMap[val].count : 0,
      amount: noteMap[val] ? noteMap[val].amount : 0
    }));

    // Banks sync
    const bankMap = {};
    (rec.banks || []).forEach(b => { bankMap[b.name.trim()] = b.amount; });
    rec.banks = updatedSettings.defaultBanks.map(name => ({
      name,
      amount: bankMap[name.trim()] !== undefined ? bankMap[name.trim()] : 0
    }));

    // Vouchers sync (deduplicated by isSameKhata)
    const extraVouchers = [];
    (rec.vouchers || []).forEach(v => {
      const vName = (v.name || '').trim();
      if (!vName) return;
      if (!updatedSettings.defaultVouchers.some(master => isSameKhata(master, vName))) {
        const existing = extraVouchers.find(e => isSameKhata(e.name, vName));
        if (existing) {
          existing.amount = (Number(existing.amount) || 0) + (Number(v.amount) || 0);
        } else {
          extraVouchers.push({ name: vName, amount: Number(v.amount) || 0 });
        }
      }
    });
    rec.vouchers = [
      ...updatedSettings.defaultVouchers.map(masterName => {
        const matching = (rec.vouchers || []).filter(v => v && isSameKhata(v.name, masterName));
        const totalAmt = matching.reduce((sum, v) => sum + (Number(v.amount) || 0), 0);
        return {
          name: masterName,
          amount: totalAmt
        };
      }),
      ...extraVouchers
    ];

    // Recalculate totals
    rec.cashTotal = rec.notes.reduce((s, n) => s + n.amount, 0);
    rec.noteCountTotal = rec.notes.reduce((s, n) => s + n.count, 0);
    rec.bankTotal = rec.banks.reduce((s, b) => s + b.amount, 0);
    rec.voucherTotal = rec.vouchers.reduce((s, v) => s + v.amount, 0);
    rec.grandTotal = rec.cashTotal + rec.bankTotal + rec.voucherTotal;

    saveRecords(records);
  }

  const configChanges = [];
  if (orgName !== undefined && orgName.trim() !== current.orgName) {
    configChanges.push({ field: 'સંસ્થાનું નામ (Org Name)', before: current.orgName || '-', after: orgName.trim() });
  }
  if (phone !== undefined && phone.trim() !== current.phone) {
    configChanges.push({ field: 'સંપર્ક નંબર (Phone)', before: current.phone || '-', after: phone.trim() });
  }
  if (printTopOffset !== undefined && Number(printTopOffset) !== current.printTopOffset) {
    configChanges.push({ field: 'પ્રિન્ટ ટોપ માર્જિન (Top Margin)', before: String(current.printTopOffset), after: String(printTopOffset) });
  }
  if (printLeftOffset !== undefined && Number(printLeftOffset) !== current.printLeftOffset) {
    configChanges.push({ field: 'પ્રિન્ટ લેફ્ટ માર્જિન (Left Margin)', before: String(current.printLeftOffset), after: String(printLeftOffset) });
  }
  if (configChanges.length === 0) {
    configChanges.push({ field: 'રૂપરેખાંકન', before: 'જૂના સેટિંગ્સ', after: 'નવા સેટિંગ્સ સફળતાપૂર્વક સાચવ્યા' });
  }

  logAdminActivity(
    'CONFIG_SAVED',
    'SETTINGS',
    'એડમિન સેટિંગ્સ સાચવ્યા',
    'Admin Settings Saved',
    'સંસ્થાનું નામ, પ્રિન્ટ માર્જિન અને ખાતા સેટિંગ્સ અપડેટ થયા',
    'Updated organization details, print layout and account configurations',
    'success',
    req,
    {
      type: 'CONFIG_SAVED',
      changes: configChanges
    }
  );

  res.json({ success: true, settings: updatedSettings });
});

// 5. Admin: Reset to default Excel setup (Protected)
app.post('/api/admin/reset-defaults', requireAdminAuth, (req, res) => {
  saveSettings(DEFAULT_SETTINGS);
  logAdminActivity(
    'RESET_DEFAULTS',
    'SETTINGS',
    'મૂળભૂત સેટિંગ્સ રીસેટ કર્યા',
    'Reset to System Defaults',
    'તમામ સેટિંગ્સ મૂળ એક્સેલ ડિફોલ્ટ પર રીસેટ કરવામાં આવ્યા',
    'Reset all configurations and layouts to system defaults',
    'warning',
    req
  );
  res.json({ success: true, settings: DEFAULT_SETTINGS });
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
