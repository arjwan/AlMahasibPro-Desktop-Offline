# AlMahasibPro Desktop Offline — functional parity and evidence

Reference: `arjwan307/AlMahasibPro/docs/ERP_CORE.md` and `ERP_MASTER_BLUEPRINT_AR.md` (read-only). Desktop work stays on `development/functional-desktop`; no changes to the cloud repository.

## Implemented in 0.4 development

- SQLite transactions post stock and balanced journals together. Idempotency keys protect supported transactional operations against identical retries and reject key/payload reuse.
- Company sales: editable drafts, customer/agent/branch/warehouse and line prices, submission reservations, manager approval/rejection, full loading and immutable posting, A4 printing. POS remains separate and posts immediately; thermal layout retained.
- Multi-line purchases, weighted cost rounded to whole IQD, cash/credit/mixed payment, partners and statements.
- Warehouse and unit masters, per-warehouse stock, movements, transfers, dated reservations, stock counts and atomic CSV product import.
- Partial sale/purchase returns with original quantity checks, discounted net allocation, historical sale-cost snapshot, transaction rollback and audit.
- Accounts, manual balanced journals, reversal, ledger and trial balance; fiscal period locks; cash/bank vouchers, party settlement tags, bank reconciliation snapshots, shifts and variance journals.
- Fixed assets with straight-line monthly depreciation, annual account budgets, financial/stock reports and CSV export.
- Settings, hashed passwords, authenticated sessions, per-module server authorization, audit, branch/agent masters, backup download and validated restore on restart with prior-file preservation.
- Five registered browser/device slots with admin revocation; centralized local server may bind to a LAN IP via environment. This is not cryptographic license activation.

## Verified locally on Node 24 / Linux

- API integration covers posting/rollback, stock, transfers and reservations, company approval/load, POS held completion once, partial returns, weighted costs, idempotency, fiscal lock, reversal, cash/bank, asset depreciation, budgets, reconciliation, CSV rollback and stock count concurrency check.
- Backup was downloaded, data changed, restore staged, server restarted, and restored data verified.
- Migration from an old v2 product table missing barcode preserves the product, adds columns, starts twice, and does not duplicate the warehouse.
- Permissions reject unauthenticated API calls and unauthorized stock/backup/users writes. Password changes survive restart. Five device slots and slot release were tested.
- Chromium smoke opens 16 pages and performs actual UI product/supplier creation, multi-line purchase, company submission/approval/load, POS mixed item-entry methods/receipt, and cash voucher.
- Windows CI config runs API, Electron, Chromium and EXE build. Its outcome must be read from GitHub Actions; it has not been inferred from Linux checks.

## Remaining limits — do not market as complete parity

- Real Windows device/thermal printer and five-device LAN testing; actual signed commercial activation.
- Existing Android scanner requires trusted HTTPS; no HTTP workaround or scanner rebuild was introduced.
- Multi-currency exchange-rate snapshots, native XLSX, fractional quantities and unit conversion, partial loading, accounting year-end closing entries, and complete source-module parity review.
- Old posted sales have no historical cost snapshot; automatic financial backfill and their returns are intentionally blocked rather than guessed.
- Inventory average uses rounded whole IQD cost, so report valuation can contain rounding differences from exact purchase totals. A full valuation reconciliation policy remains needed.
- Restore is applied on restart. Protected SQLite snapshots are not a substitute for testing recovery on the customer's Windows machine.
