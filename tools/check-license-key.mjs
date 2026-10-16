import fs from 'node:fs';
import crypto from 'node:crypto';
const key=crypto.createPublicKey(fs.readFileSync(new URL('../license-public.pem',import.meta.url)));
if(key.asymmetricKeyType!=='ed25519')throw Error('A developer Ed25519 verification key is required before packaging');
console.log('License verification key: OK');
