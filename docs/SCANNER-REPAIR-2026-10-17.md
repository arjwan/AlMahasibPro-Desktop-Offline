# Local scanner repair — 2026-10-17

Changes:
- Resolve six-digit codes before sending manual scans; serialize concurrent connection attempts.
- Heartbeats never submit incomplete/short codes, preventing accidental lockout.
- Preserve a pending scan and its request ID on network failures; do not replace it with another barcode.
- Bound phone requests to eight seconds and explain LAN failures without asking for internet.
- Prefer physical network interfaces over common VPN/virtual interfaces, use the actual listener port, and reject loopback/missing LAN addresses.
- Reject cross-origin code resolution. New unclaimed QR/code sessions expire in five minutes; successful connection preserves the existing persistent device protocol.
- Preserve authentication, license enforcement, SQLite financial logic, USB readers and printing.

Automated verification: `npm test`, including phone-page concurrency/retry tests and HTTP/TLS pairing, expiry, revocation, cashier isolation, scan deduplication and invoice API saving. The invoice test exercises API persistence, not a physical phone-to-UI interaction.

Outstanding physical checks: Windows Firewall, multiple adapters, phone/Windows connection, native Android scanner compatibility, USB reader and actual thermal printer.

The AlMahasibCashierPro main tree contains no Android source. Follow-up investigation found the existing native scanner in arjwan307/AlMahasibPro under android-scanner. Its HTTPS-only QR parser and disabled cleartext traffic prevented pairing with this desktop HTTP LAN origin. Native fixes are on development/android-scanner-lan, commit 3c701fed0545dd3831ae991faf51c2d560cc8321, with 26 Java URL validation cases passing. The APK build and physical Android/Windows tests must be checked separately. This user uses the native app, so browser camera restrictions do not apply to their scanner. First-time pairing uses QR to learn the server address; a short code can subsequently use the saved server origin. Automatic server discovery from a six-digit code alone is not implemented.

LAN access remains subject to a valid existing license. No EXE or commercial release was built.
