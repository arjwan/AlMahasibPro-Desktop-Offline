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

The AlMahasibCashierPro main tree contains public/market-scanner.html but no Android project or MainActivity/AndroidManifest source. The native phone app cannot be updated from that tree. Browser camera capture on an ordinary LAN HTTP address still requires an alternative to getUserMedia or a trusted secure origin; this repair does not bypass browser security or deliver a complete camera solution. The existing native scanner must be verified on the actual device.

LAN access remains subject to a valid existing license. No EXE or commercial release was built.
