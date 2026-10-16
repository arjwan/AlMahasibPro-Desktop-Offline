# Developer-issued offline licensing — foundation

This is an isolated **draft** for developer-controlled offline licensing. It is not yet connected to the Electron user interface or server gate, and **does not activate the existing app**.

- The developer generates an Ed25519 key pair outside the repository.
- Only the public key is shipped in the desktop application.
- A customer submits a request containing a device hash (not the raw hardware identifiers).
- The developer signs a license file for one installation.
- The application verifies the signature, product and device hash entirely offline.
- Existing installed license flows must be audited and migrated before enabling enforcement.
- Offline revocation is not immediate; devices must accept an updated signed revocation list or connect to a licensing service. Do not promise instant remote revocation.

## Developer CLI (not for customer use)

Generate a key pair (use a PRIVATE path not synced to GitHub):
```
node licensing/developer-issuer.mjs init "C:/private-almahasib-keys"
```

Issue a license (choose a new output file path each time):
```
node licensing/developer-issuer.mjs issue "C:/private-almahasib-keys/developer-private.pem" <64-hex-device-hash> "Customer" "C:/private-almahasib-keys/customer-license.json"
```

The generated `licensing/public-key.pem` is public and should be committed once explicitly reviewed; private PEM files MUST NEVER be added to the repository. The CLI deliberately refuses to overwrite existing keys or licenses.

**Pending integration:** trusted Windows device identity, simple request/import screen, secure storage for installed licenses, startup verification, migration for existing customers, test suite and Windows installer verification. Do not distribute this branch as a licensed release.
