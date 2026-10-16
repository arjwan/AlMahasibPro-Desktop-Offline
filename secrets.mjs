import crypto from 'node:crypto';
import fs from 'node:fs';

// Versioned, authenticated envelope. Legacy CBC is read only during migration.
export function secretCodec(key){
 if(!Buffer.isBuffer(key)||key.length!==32)throw Error('Encryption key must be 32 bytes');
 return {
  encrypt(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from('almahasib:secrets:v1'));const data=Buffer.concat([c.update(text,'utf8'),c.final()]);return ['gcm','v1',iv.toString('hex'),c.getAuthTag().toString('hex'),data.toString('hex')].join(':');},
  decrypt(text){const parts=text.split(':');if(parts.length!==5||parts[0]!=='gcm'||parts[1]!=='v1'||!/^[a-f0-9]{24}$/.test(parts[2])||!/^[a-f0-9]{32}$/.test(parts[3])||!/^([a-f0-9]{2})*$/.test(parts[4]))throw Error('Invalid encrypted secret');const c=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(parts[2],'hex'));c.setAAD(Buffer.from('almahasib:secrets:v1'));c.setAuthTag(Buffer.from(parts[3],'hex'));return Buffer.concat([c.update(Buffer.from(parts[4],'hex')),c.final()]).toString('utf8');}
 };
}
export function migrateProviderSecrets(db,dbPath){
 const rows=db.prepare('SELECT id,api_key_encrypted,webhook_secret_encrypted FROM payment_providers').all();
 // No key or side effects until there are secrets to protect.
 if(!rows.some(r=>r.api_key_encrypted||r.webhook_secret_encrypted))return;
 const keyPath=dbPath+'.secrets-key';let key;
 if(process.env.ALMAHASIB_SECRET){if(Buffer.byteLength(process.env.ALMAHASIB_SECRET)<32)throw Error('ALMAHASIB_SECRET must contain at least 32 bytes');key=crypto.createHash('sha256').update(process.env.ALMAHASIB_SECRET).digest();}
 else if(fs.existsSync(keyPath)){key=Buffer.from(fs.readFileSync(keyPath,'utf8').trim(),'hex');}
 else {if(rows.some(r=>[r.api_key_encrypted,r.webhook_secret_encrypted].some(v=>v?.startsWith('gcm:v1:'))))throw Error('Secret key file missing');key=crypto.randomBytes(32);fs.writeFileSync(keyPath,key.toString('hex'),{flag:'wx',mode:0o600});}
 const codec=secretCodec(key);
 const legacyKey=Buffer.from(process.env.ALMAHASIB_LEGACY_SECRET||process.env.ALMAHASIB_SECRET||'default-secret-key-32-chars-long!!!').subarray(0,32);
 const convert=value=>{
  if(!value)return value;
  if(value.startsWith('gcm:v1:')){codec.decrypt(value);return value;}
  const parts=value.split(':');let cipher;
  if(parts.length===2&&/^[a-f0-9]{32}$/i.test(parts[0])&&/^([a-f0-9]{32})+$/i.test(parts[1]))cipher=crypto.createDecipheriv('aes-256-cbc',legacyKey,Buffer.from(parts[0],'hex'));
  else if(parts.length===3&&/^[a-f0-9]{24}$/i.test(parts[0])&&/^[a-f0-9]{32}$/i.test(parts[1])&&/^([a-f0-9]{2})*$/i.test(parts[2])){cipher=crypto.createDecipheriv('aes-256-gcm',legacyKey,Buffer.from(parts[0],'hex'));cipher.setAuthTag(Buffer.from(parts[1],'hex'));}
  else throw Error('Unknown legacy secret format');
  return codec.encrypt(Buffer.concat([cipher.update(Buffer.from(parts.at(-1),'hex')),cipher.final()]).toString('utf8'));
 };
 // Decode every row before writing; a bad key never causes partial migration.
 const updates=rows.map(r=>[convert(r.api_key_encrypted),convert(r.webhook_secret_encrypted),r.id]);
 if(updates.some((u,i)=>u[0]!==rows[i].api_key_encrypted||u[1]!==rows[i].webhook_secret_encrypted)){
  db.prepare('VACUUM INTO ?').run(dbPath+'.before-secret-migration-'+crypto.randomUUID()+'.sqlite');
  db.exec('BEGIN IMMEDIATE');try{for(const u of updates)db.prepare('UPDATE payment_providers SET api_key_encrypted=?,webhook_secret_encrypted=? WHERE id=?').run(...u);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 }
}
