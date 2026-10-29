const crypto = require('crypto');

module.exports = function registerAdminRoutes(app, deps) {
  const {
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
    getGujaratiKhataName,
    getAuthUser
  } = deps;

  // Admin Security State (Enforced rate limiting & OTPs)
  let adminFailedAttempts = 0;
  let adminLockoutUntil = 0;
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
    // Privilege Escalation Protection: Authenticated accountants/staff cannot elevate to admin via PIN
    const authUser = (typeof getAuthUser === 'function') ? getAuthUser(req) : null;
    if (authUser && authUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'ઍક્સેસ નકારવામાં આવ્યો! એકાઉન્ટન્ટ અથવા સામાન્ય સ્ટાફ આઈડી દ્વારા એડમિન એક્સેસ કરવાની પરવાનગી નથી.'
      });
    }

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
      sendLoginAlertEmail(req).catch(() => { });

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
        }).catch(() => { });
      }
    } catch (e) { }

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
        }).catch(() => { });
      }
    } catch (e) { }

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
          }).catch(() => { });
        }
      } catch (e) { }

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
      res.json({ success: true, message: descGu, messageEn: descEn, clearedCount: initialCount - history.length, remainingCount: history.length });
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

  // 6. Admin Role Permissions Management (Get & Save Dynamic Permissions)
  app.get('/api/admin/permissions', requireAdminAuth, (req, res) => {
    const settings = getSettings();
    res.json({
      success: true,
      rolePermissions: settings.rolePermissions || (DEFAULT_SETTINGS && DEFAULT_SETTINGS.rolePermissions) || {}
    });
  });

  app.post('/api/admin/permissions', requireAdminAuth, (req, res) => {
    const { rolePermissions } = req.body;
    if (!rolePermissions || typeof rolePermissions !== 'object') {
      return res.status(400).json({ success: false, error: 'અમાન્ય પરમિશન ડેટા!' });
    }
    const settings = getSettings();
    settings.rolePermissions = rolePermissions;
    saveSettings(settings);
    logAdminActivity(
      'PERMISSIONS_UPDATE',
      'SECURITY',
      'રોલ પરમિશન અપડેટ કરી',
      'Role Permissions Updated',
      'એકાઉન્ટન્ટ અને યુઝર રોલ પરમિશનમાં ફેરફાર સાચવવામાં આવ્યો',
      'Updated granular role permissions matrix',
      'success',
      req
    );
    res.json({ success: true, message: 'પરમિશન સફળતાપૂર્વક સાચવવામાં આવી.', rolePermissions: settings.rolePermissions });
  });

};
