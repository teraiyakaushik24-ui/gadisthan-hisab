# TODO.md — Completed & Future Tasks

> Quick capture of ideas, tasks, and issues.
> Use `/add-todo` to add items, `/check-todos` to view.

## Priority Levels
| Level | Use For |
|---|---|
| `high` 🔴 | Blocking issues, critical data safety |
| `medium` 🟡 | Architecture improvements, modularity |
| `low` 🟢 | Nice-to-have, future optimizations |

---

## Items

- [x] Implement atomic file writing (temp + rename) in `db.js` & `server.js` to protect JSON files against sudden power-cuts `high` — 2026-10-25 ✓ 2026-10-25
- [x] Add `"test": "node comprehensive_deep_test.js"` script to `package.json` `high` — 2026-10-25 ✓ 2026-10-25
- [x] Secure `verifyPassword` with constant-time comparison and phased-out plain text fallback `low` — 2026-10-25 ✓ 2026-10-25
- [x] Refactor monolithic `server.js` (6,000+ lines) into modular Express routers (`routes/auth.js`, `routes/admin.js`, `routes/employees.js`, `routes/records.js`, `routes/subsystems.js`) `medium` — 2026-10-25 ✓ 2026-10-25
- [x] Decompose monolithic client-side `public/js/app.js` (697 KB) into focused modules (`public/js/modules/calculator.js`, `public/js/modules/dues.js`) `medium` — 2026-10-25 ✓ 2026-10-25

---

*Last updated: 2026-10-25*
