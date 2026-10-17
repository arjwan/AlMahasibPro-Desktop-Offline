# Qi POS and payment gateway — deferred integration foundation

Status: **scaffold only**. No Qi merchant credentials, live API integration, payment confirmation, automated posting, or device integration are implemented.

- `qi-payment.mjs` provides local SQLite tables for payment intents, verified provider events, and settlement records.
- Two channels are reserved: physical `pos` and online `gateway`.
- Every payment intent has a unique ID; provider references and event IDs are unique to reduce accidental duplication.
- The function `recordVerifiedQiEvent` MUST only be called by a future adapter after independently authenticating the provider event and checking amount, currency, merchant and intent. It does not mark an invoice paid or create a journal entry.
- Accounting design: card receivables pending settlement, bank settlement, fees, refunds, and manual reconciliation must be implemented with atomic postings and audit history.
- Never store card PAN, CVV, PIN, or secret keys in SQLite. Do not assume the physical Qi POS exposes a local API.
- Future work requires Qi's confirmed device model/protocol, merchant API credentials, callback authentication, sandbox tests, reconciliation API/export specification and explicit activation.
- Existing cash/credit operations remain unchanged. No Windows installer is built by this change.
