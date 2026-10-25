---
milestone: v2.0-modular-architecture
version: 2.0.0
updated: 2026-10-25T10:31:00+05:30
---

# Roadmap — HISAB PRO

> **Current Milestone:** v2.0 Production & Modularization  
> **Status:** ✅ Core Verified & Production Ready

---

## Must-Haves (from SPEC)

- [x] Zero financial calculation discrepancies across Denominations, Banks, and Vouchers
- [x] Atomic write safety against power cuts (`atomicWriteJson`)
- [x] MongoDB Atlas Cloud Database sync (`hisab_db`)
- [x] Full RBAC security with 2-Step OTP and constant-time password verification
- [x] Modular server architecture (`routes/`)
- [x] Modular client architecture (`public/js/modules/`)

---

## Phases

### Phase 1: Core Daily Accounting Engine
**Status:** ✅ Complete  
**Objective:** Deliver daily cash note denomination counting, bank transfer ledger, multi-account voucher tracking, and grand total formula.

**Completed Items:**
- [x] Daily cash notes breakdown (₹500, ₹200, ₹100, ₹50, ₹20, ₹10)
- [x] Dynamic bank accounts (`IOB TRF`, `BOB TRF`, `SBI TRF`)
- [x] Dynamic voucher accounts (`MANDIRKHARCH`, `RASODAKHARCH`, `PAGAR`)
- [x] Exact Excel print layout export (`HISAB_<date>.xlsx`) and PDF template generation

---

### Phase 2: Staff Payroll, Dues & Auxiliary Subsystems
**Status:** ✅ Complete  
**Objective:** Complete employee ledger, advance (Upad) tracking, petty cash (Uchak), donor seva receipts, and dues registers.

**Completed Items:**
- [x] Employee management with 15-day/monthly payroll and continuous balance carry-forward
- [x] Petty cash (Uchak) advance and bill settlement
- [x] Bhakt Seva / Nitya Daan passbook and receipt generator (PDF/WhatsApp)
- [x] Dues / Baki register for receivables and payables
- [x] Gujarati AI voice command parser for hands-free expense entry

---

### Phase 3: Cloud Synchronization & Resilience Hardening
**Status:** ✅ Complete  
**Objective:** Eliminate data corruption risks, implement cloud syncing with MongoDB Atlas, and secure admin operations.

**Completed Items:**
- [x] MongoDB Atlas cloud integration (`hisab_db`) with 15s background sync
- [x] Atomic file writes (`.tmp` + `renameSync`) to safeguard against abrupt power outages
- [x] Constant-time password verification (`crypto.timingSafeEqual`) to prevent timing attacks
- [x] Multi-user RBAC (`admin`, `accountant`, `user`) with brute-force rate-limiting
- [x] Comprehensive automated system test suite (`npm test`)

---

### Phase 4: Codebase Modularization & Refactoring
**Status:** ✅ Complete  
**Objective:** Decompose monolithic codebases into maintainable, high-performance architectural modules.

**Completed Items:**
- [x] Decomposed monolithic `server.js` (6,051 lines) into modular Express routers (`routes/auth.js`, `routes/admin.js`, `routes/employees.js`, `routes/records.js`, `routes/subsystems.js`)
- [x] Decomposed client-side `public/js/app.js` (697 KB) into modular components (`public/js/modules/calculator.js`, `public/js/modules/dues.js`)
- [x] Empirical verification of 10/10 API endpoints and client asset deliveries

---

### Phase 5: Future Enhancements & Continuous Monitoring
**Status:** 🔄 In Progress  
**Objective:** Ongoing operational maintenance, backup scheduling, and advanced visual dashboards.

**Planned Items:**
- [ ] Automated daily backup email dispatch
- [ ] Enhanced annual financial auditing dashboard
- [ ] Multi-device offline cache sync optimizations

---

*Last updated: 2026-10-25*
