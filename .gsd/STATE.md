---
updated: 2026-10-25T10:22:30+05:30
---

# Project State

## Current Position

**Project:** HISAB PRO (Shree Gadisthan Jetpur)
**Status:** ✅ Architecture Modularization & Admin Portal Verified
**Last Action:** Debugged and resolved admin portal login & openAdminModal settings initialization bug; verified all 8 tabs across Admin Control Center.

## System Overview
- **Backend Modular Architecture:**
  - `server.js` reduced from 6,051 lines to 917 lines
  - `routes/auth.js`: User login, 2FA OTP, RBAC, sessions, rate limiting
  - `routes/admin.js`: PIN verification, backup/restore, audit history, settings
  - `routes/employees.js`: Staff salary, upad, monthly balance engine, bulk payouts
  - `routes/records.js`: Daily hisab records, expense diary, visual analytics, Excel export
  - `routes/subsystems.js`: Uchak advances, bank deposits, bhakts/donations, dues register
- **Frontend Modular Architecture:**
  - `public/js/modules/calculator.js`: On-screen floating mini calculator widget
  - `public/js/modules/dues.js`: Receivables and payables register
  - `public/js/app.js`: Core controller and state management
- **Database & Cloud:**
  - MongoDB Atlas Cloud Database connected (`hisab_db`)
  - Bidirectional sync active with local JSON backup
  - Atomic file writing enabled (`safeWriteJson` & `atomicWriteJson`)

## Verification Status
- 10/10 Core API endpoints empirically verified (HTTP 200)
- All client assets verified delivering with HTTP 200
- Node syntax validation checks passed with 0 errors
