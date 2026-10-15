# AlMahasibPro Desktop Offline — functional parity contract

Source reference: arjwan307/AlMahasibPro, docs/ERP_CORE.md. Source repository is read-only for this effort.

## Product boundaries
- Same business functionality as AlMahasibPro Enterprise, but a new desktop UI and separate POS.
- SQLite is the local source of truth; no cloud connection required for normal operation.
- Main company sales invoice must be distinct from POS; item code, barcode, customer, warehouse, payment, approval and A4 printing.
- POS is a separate workflow with thermal printing.
- Five-device LAN support requires a central local server, authentication, concurrency and license enforcement; not implemented merely by using SQLite.

## Non-negotiable posting rules
1. Check roles, fiscal period, party, item, warehouse and quantity.
2. Compute totals and cost with explicit currency and approved exchange rate.
3. Validate available stock before posting.
4. In one SQLite transaction, persist immutable document, inventory movement, balanced general ledger journal, cash/receivable/payable settlement, and audit event.
5. Use reversal or return documents instead of editing posted transactions.
6. Never seed demo stock, create fake financial figures, or silently mutate production balances.

## Modules to port, in dependency order
1. Company settings, users, permissions, audit and migrations.
2. Chart of accounts, fiscal periods, journal, general ledger and trial balance.
3. Parties, units, catalog and warehouse master data.
4. Purchases, receipt, cost valuation, transfers, reservations and stocktaking.
5. Company sales, discounts, invoices, receivables and returns.
6. Cash, banks, vouchers, reconciliation and cash close.
7. P&L, balance sheet, stock and customer/supplier statements.
8. Offline POS, thermal print, A4 print, backups and local LAN licensing.

## Current status
- Navigation fix committed separately; needs Windows verification.
- Existing stock adjustment and sales APIs are prototypes, not a full ERP posting engine.
- Accounting endpoints currently allow basic balanced manual journal entries only.
- Remaining modules are NOT implemented; do not represent UI placeholders as working features.
- No merge to main or commercial release before migration, end-to-end posting, backup/restore, concurrency and security tests.

## Verified development increment — 2026-10-15
- Cash/bank workspace now supports receipt/payment vouchers and account ledger.
- Sales and held-sale completion post revenue, payment/receivable and cost journals atomically with inventory.
- Financial report displays posted revenue, expenses, profit, assets, liabilities and equity.
- Fixed missing stock-update binding and repeated default warehouse creation on restart.
- Integration test passed on Node 24 Linux: stock, sales, held completion once, purchase, balanced posting, voucher rollback and ledger balances. Windows UI verification remains outstanding.
- Earlier sales are not automatically backfilled; costs use catalog cost, not a historical weighted-average valuation. Full enterprise parity, permissions, periods, returns, company sales editor, backups and LAN licensing remain incomplete.

- Company sales now has an independent multi-line editor, item code/barcode/name selection, customer, warehouse, payment, held save, posting and A4 print view. Held documents are not yet editable company drafts. Windows interaction checks remain outstanding.
