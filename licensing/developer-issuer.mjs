import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalLicense,LICENSE_PRODUCT} from './offline-license.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
function fail(message){console.error(message);process.exitCode=1;}
function main(){
 const [command,...args]=process.argv.slice(2);
 if(command==='init'){
  const dir=args[0];if(!dir)return fail('Usage: node licensing/developer-issuer.mjs init <PRIVATE_DIRECTORY_OUTSIDE_REPO>');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const privatePath=path.join(dir,'developer-private.pem');
  const publicPath=path.join(root,'public-key.pem');
  if(fs.existsSync(privatePath)||fs.existsSync(publicPath))return fail('Refusing to overwrite existing keys');
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(privatePath,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
  fs.writeFileSync(publicPath,publicKey.export({type:'spki',format:'pem'}),{flag:'wx'});
  console.log('Private key:',privatePath,'\nPublic key:',publicPath,'\nNEVER commit or share the private key');
  return;
 }
 if(command==='issue'){
  const [privatePath,deviceHash,customer,outFile]=args;
  if(!privatePath||!deviceHash||!customer||!outFile)return fail('Usage: node licensing/developer-issuer.mjs issue <private.pem> <64-hex-device-hash> <customer-name> <output.json>');
  const license={version:1,product:LICENSE_PRODUCT,licenseId:crypto.randomUUID(),customer,deviceHash:deviceHash.toLowerCase(),issuedAt:new Date().toISOString(),expiresAt:null};
  const payload=canonicalLicense(license);
  license.signature=crypto.sign(null,Buffer.from(payload),fs.readFileSync(privatePath)).toString('base64');
  fs.writeFileSync(outFile,JSON.stringify(license,null,2),{flag:'wx',mode:0o600});
  console.log('License created:',outFile,'ID:',license.licenseId);
  return;
 }
 fail('Usage: node licensing/developer-issuer.mjs init|issue ...');
}
main();
