# AlMahasibPro Desktop Offline — functional parity and evidence

Reference: `arjwan307/AlMahasibPro/docs/ERP_CORE.md` and `ERP_MASTER_BLUEPRINT_AR.md` (read-only). Desktop work stays on `development/functional-desktop`; no changes to the cloud repository.

## Implemented in 0.5.0 development

- SQLite transactions post stock and balanced journals together. Idempotency keys protect supported transactional operations against identical retries and reject key/payload reuse.
- Company sales: editable drafts, customer/agent/branch/warehouse and line prices, submission reservations, manager approval/rejection, partial/full loading, per-batch immutable posting and remaining-stock reservations, A4 printing. POS remains separate and posts immediately; thermal layout retained.
- Multi-line purchases, exact pooled carrying value and allocated sale costs, with rounded unit-cost display, cash/credit/mixed payment, partners and statements.
- Warehouse and unit masters, per-warehouse stock, movements, transfers, dated reservations, stock counts and atomic CSV product import.
- Partial sale/purchase returns with original quantity checks, discounted net allocation, historical sale-cost snapshot, transaction rollback and audit.
- Accounts, manual balanced journals, reversal, ledger and trial balance; real closing journals to retained earnings, closing reversal and fiscal period locks; cash/bank vouchers, party settlement tags, bank reconciliation snapshots, shifts and variance journals.
- Fixed assets with straight-line monthly depreciation, annual account budgets, financial/stock reports and CSV export.
- Settings, hashed passwords, authenticated sessions, per-module server authorization, audit, branch/agent masters, backup download and validated restore on restart with prior-file preservation.
- Five registered browser/device slots with admin revocation; centralized local server may bind to a LAN IP via environment. This is not cryptographic license activation.

## Verified locally on Node 24 / Linux

- API integration covers posting/rollback, stock, transfers and reservations, company approval/load, POS held completion once, partial returns, weighted costs, idempotency, fiscal lock, reversal, cash/bank, asset depreciation, budgets, reconciliation, CSV rollback and stock count concurrency check.
- Backup was downloaded, data changed, restore staged, server restarted, and restored data verified.
- Migration from an old v2 product table missing barcode preserves the product, adds columns, starts twice, and does not duplicate the warehouse.
- Permissions reject unauthenticated API calls and unauthorized stock/backup/users writes. Password changes survive restart. Five device slots and slot release were tested.
- Chromium smoke opens 16 pages and performs actual UI product/supplier creation, multi-line purchase, company submission/approval/load, POS mixed item-entry methods/receipt, and cash voucher.
- Windows CI on the first enterprise commit passed API tests, Electron startup/login and all Chromium smoke paths. The installer build and the latest valuation patch must be checked against their own run.

## Remaining limits — do not market as complete parity

- Real Windows device/thermal printer and five-device LAN testing; actual signed commercial activation.
- Existing Android scanner protocol is implemented locally with persisted pairing/events, session ownership and HTTPS. PEM certificate/key can be configured locally. Trusted certificate, reachable DNS/IP, phone compatibility and physical scanning still require customer-network verification; no TLS bypass or scanner rebuild was introduced.
- Native XLSX, fractional quantities and unit conversion, signed license activation and complete source-module parity review remain outside this increment. Currency ledger base is IQD; USD invoice snapshots and physical USD cash/bank vouchers are supported. Direct invoice payments are entered in IQD; physical USD settlement uses the FX voucher workflow.
- Old posted sales have no historical cost snapshot; automatic financial backfill and their returns are intentionally blocked rather than guessed.
- Precise inventory carrying value, cost allocation and return remainder were verified against journal balances. Old databases initialize carrying value from their recorded catalog cost and stock; historical discrepancies still require accounting review.
- Restore is applied on restart. Protected SQLite snapshots are not a substitute for testing recovery on the customer's Windows machine.

## 0.5.0 additional local verification
- Partial dispatch: exact revenue/paid/cost allocation across batches, stale version rejection, retry deduplication, remainder reservations, returns limited to dispatched quantities and source document immutability.
- Period closing: zeroes nominal balances into retained earnings once; reopening reverses the closing; operating period profit and budgets exclude closing/reopening entries.
- USD: approved rate snapshots, cumulative allocation avoids per-line currency rounding drift, physical foreign cash balance, FIFO-equivalent pooled carrying amount and realized FX gain/loss. Ledger amounts stay IQD integers.
- Scanner: exact existing Android URL and status/scan protocol, trusted test TLS, HTTP rejection, durable barcode queue, cursor polling, cross-session denial and revocation. Test certificate/key are public fixtures only and not packaged.
- Chromium covers company partial loading, USD invoice entry, physical USD receipt, closing entry and TLS configuration in addition to the prior 16-page smoke.
