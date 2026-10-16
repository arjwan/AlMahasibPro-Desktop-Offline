# POS payment readiness — 2026-10-16

Scope: development/production-readiness. Existing local commits and edits were retained. No reset, force push, production database write, or main update was used.

## Behavior

- POS checkout sends the invoice and cash/card components together under one persistent Idempotency-Key. SQLite commits the invoice, inventory movements, cost/revenue journals and confirmed receipts together. A lost HTTP response can be retried without creating a second invoice or collecting again.
- Independent terminal card receipts require an admin or manager and a unique terminal reference. Unsupported online providers are rejected; client claims do not verify an online transaction. No external bank charge is performed by this implementation.
- Cash debits 101; card receipts debit the dedicated account `pos-card-clearing` (code POS-CARD). Account 105 remains the existing fixed-assets account. Both receipt types credit customer receivables 104. Partial checkout requires a customer. The POS also exposes collection against an existing invoice.
- `status=paid` remains the legacy posted-document marker. `payment_status` and `remaining` returned by invoice queries describe collection independently, including return credits. Do not interpret the legacy status as settlement.
- Payment retries are bound to invoice, amount, method, provider, reference and actor. Overpayments, duplicate terminal references, unsupported methods, noninteger amounts and collection of returned debt are rejected.
- Returns restore historical carrying cost and original stock lots through the existing inventory engine. Paid refunds reverse remaining card clearing first, then cash; unpaid portions credit receivables. The returns UI explains this allocation. Terminal refunds must actually be performed on the independent device before recording them; this application records the accounting reversal, not a bank refund API call. Return submissions retain an idempotency key across response failures.
- Held card checkout requires the terminal reference and manager confirmation; retries do not deduct stock twice.

## Secret migration

`secrets.mjs` writes versioned `gcm:v1` AES-256-GCM envelopes with a fresh 96-bit IV, 128-bit tag and authenticated format context. It validates existing GCM records on restart and rejects invalid tags, keys and envelopes.

The migration reads both the original CBC format and the interrupted unversioned GCM format. It decodes every provider secret before changing rows and creates a SQLite backup before committing replacements. A decoding failure leaves all provider rows unchanged.

Configure ALMAHASIB_SECRET with at least 32 bytes; the GCM key is derived with SHA-256. For a different historical key set ALMAHASIB_LEGACY_SECRET during migration. Without ALMAHASIB_SECRET, a random 32-byte key is persisted beside the database as `<database>.secrets-key` only when secrets exist. It is excluded from Git. Existing legacy defaults are used for reading old ciphertext only, never for new encryption.

Keep the key file securely with backups, or retain the configured environment secret separately. Downloading the database alone does not include its key. A missing key for an existing versioned database or an incorrect environment key stops startup without rewriting provider rows. Old schema/secret backup databases can still contain legacy ciphertext and need the same access restrictions as the live database. No live company database was migrated during validation.

## Validation

- `npm test`: full Node/SQLite suite, including real server requests, transactions, restart/migration, permissions, weighted inventory cost, returns, fiscal periods, currencies, scanner TLS and new payment/cryptography regressions.
- `npm run test:ui` with ALMAHASIB_CHROMIUM pointing to installed Microsoft Edge: actual browser interactions, legacy accounting migration, suppliers, purchasing, company shipping, mixed POS checkout, response-loss retry, dedicated card ledger, debt collection, returns, exports, period closing and TLS settings.
- `node --check server.mjs`, `node --check erp-ui.js`, `git diff --check`.

Tests create temporary databases and stop their own child servers. The existing build_log.txt is left untouched and excluded from this commit.

The initial broad run exposed a removed product-creation route and a purchase test relying on a supplier seed removed in prior work. Product creation was restored from main; purchase/UI fixtures now create/select their own supplier. The first card UI test caught the existing account-105 collision; regression coverage now exercises fixed assets and card payments in the same database.

These changes do not assert commercial release acceptance, signed licensing, external payment-provider integration or a newly built Windows installer.

Final observed results: Node/SQLite suite **25 passed, 0 failed**; Edge browser acceptance **ALL UI CHECKS PASS**, including actual returns form and card refund accounting. Syntax and whitespace checks passed. Full test outputs are retained locally under work/ and copied to the task outputs for review.
