# SPEC.md — Project Specification

> **Status**: `FINALIZED`
>
> 🔒 **Specification Baseline Locked**: Production-ready software specification for Shree Gadisthan Jetpur Daily Accounting & Treasury Management System.

---

## 1. Vision & Overview
**HISAB PRO** is a robust, hybrid cloud-local daily accounting, treasury management, and voucher tracking software designed exclusively for **Shree Gadisthan Jetpur**. It replaces manual bookkeeping and legacy Excel sheets (`HISAB.xlsm`) with an intuitive, bilingual (Gujarati & English) real-time system featuring cash denomination counting, bank transfer reconciliation, multi-account voucher tracking, employee salary/advance ledgers, donor receipts, and atomic cloud synchronization.

---

## 2. Core Goals & Capabilities

1. **Daily Cash Denomination & Reconciliation:**
   - Accurate note denomination calculations (₹500, ₹200, ₹100, ₹50, ₹20, ₹10/Coins).
   - Real-time aggregation of Cash Total, Bank Transfer Total, and Voucher Total into a verified Grand Total:
     $$\text{Grand Total} = \text{Cash Total} + \text{Bank Total} + \text{Voucher Total}$$
   - Bank cash deposit tracking with unbanked cash period calculations.

2. **Master Account Configurations:**
   - Dynamic Bank Transfer accounts (e.g., `IOB TRF`, `BOB TRF`, `SBI TRF`).
   - Dynamic Expense/Voucher accounts (`MANDIRKHARCH`, `RASODAKHARCH`, `PAGAR`, etc.).
   - Bilingual Khata name mapping (Gujarati & English) for official auditing.

3. **Staff & Payroll Management:**
   - Employee profile directory (Name, Role, Phone, Monthly/15-day salary, Cash vs Bank mode).
   - Continuous salary ledger with automatic carry-forward opening balance.
   - Absentee day deductions, advance (Upad) tracking, and one-click bulk payroll payouts.

4. **Subsystems & Registers:**
   - **Uchak (Petty Cash Advance):** Advance disbursements, partial bill settlements, and cash returns.
   - **Bhakt Seva (Nitya Daan):** Donor register, date-to-date and monthly passbook deposits, and instant printable/WhatsApp receipts.
   - **Dues Register (લેણાં અને દેવાં):** Receivables and payables tracking with partial repayment history.
   - **AI Voice Assistant:** Natural Gujarati/English speech recognition for recording voucher expenses and uchak entries.

5. **Data Resilience & Security:**
   - **Atomic File Writing (`safeWriteJson`):** Zero-corruption `.tmp` + `renameSync` file writing protecting against sudden power outages.
   - **Cloud Sync:** MongoDB Atlas (`hisab_db`) cloud database with automatic 15-second background sync.
   - **Role-Based Access Control (RBAC):** Tiered roles (`admin`, `accountant`, `user`) with brute-force rate-limiting, 2-Step Email OTP, and constant-time password verification (`crypto.timingSafeEqual`).
   - **Audit Log:** Comprehensive action logging for all security and administrative operations.

---

## 3. Technical Architecture & Constraints

- **Runtime:** Node.js v24+ with Express.js.
- **Database:** Hybrid Architecture — Local cached JSON files in `data/` synced bidirectionally with MongoDB Atlas Cloud.
- **Frontend:** Vanilla JavaScript + CSS Design System (Zero external framework overhead for ultra-low latency).
- **Communication:** Bilingual user interface (Default: Gujarati `gu`, Secondary: English `en`).
- **Networking:** Localhost execution on port `3000`, with Cloudflare Tunnel (`cloudflared`) for secure remote access.

---

## 4. Success Criteria

- [x] Zero financial calculation discrepancies across Denominations, Banks, and Vouchers.
- [x] Bidirectional synchronization between local cache and MongoDB Atlas cloud.
- [x] Atomic write safety against power cuts.
- [x] Modular server architecture (`routes/auth.js`, `routes/admin.js`, `routes/employees.js`, `routes/records.js`, `routes/subsystems.js`).
- [x] Full audit log trail for admin modifications.

---

*Last updated: 2026-10-25 (Baseline Finalized)*
