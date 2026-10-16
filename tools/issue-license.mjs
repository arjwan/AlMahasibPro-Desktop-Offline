// Keep the Ed25519 private key OFF customer computers and out of this repository.
// node tools/issue-license.mjs /secure/private.pem MACHINE_ID CUSTOMER_ID LICENSE_ID
import fs from 'node:fs';
import crypto from 'node:crypto';
const [key,machine_id,customer_id,license_id]=process.argv.slice(2);
if(!key||!machine_id?.match(/^[a-f0-9]{64}$/)||!customer_id||!license_id)throw Error('Usage: issue-license.mjs PRIVATE_KEY MACHINE_ID CUSTOMER_ID LICENSE_ID');
const payload=Buffer.from(JSON.stringify({product:'AlMahasibPro-Offline',machine_id,customer_id,license_id,primary:1,cashiers:5})).toString('base64url');
console.log(payload+'.'+crypto.sign(null,Buffer.from(payload),fs.readFileSync(key)).toString('base64url'));
