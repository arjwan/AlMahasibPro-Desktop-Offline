import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {secretCodec,migrateProviderSecrets} from '../secrets.mjs';

test('AES GCM authenticates ciphertext, IV, tag, version and key',()=>{
 const key=crypto.randomBytes(32),codec=secretCodec(key),encrypted=codec.encrypt('مفتاح سري');assert.equal(codec.decrypt(encrypted),'مفتاح سري');assert.notEqual(codec.encrypt('مفتاح سري'),encrypted);
 for(const i of [2,3,4]){const parts=encrypted.split(':');parts[i]=(parts[i][0]==='0'?'1':'0')+parts[i].slice(1);assert.throws(()=>codec.decrypt(parts.join(':')));}
 assert.throws(()=>secretCodec(crypto.randomBytes(32)).decrypt(encrypted));assert.throws(()=>codec.decrypt(encrypted.replace('v1','v2')));
});
test('legacy CBC and interrupted GCM migrate atomically with backup and survive restart',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alma-secret-')),file=path.join(dir,'test.sqlite'),db=new DatabaseSync(file);
 const saved=process.env.ALMAHASIB_SECRET;delete process.env.ALMAHASIB_SECRET;
 try{
 db.exec('CREATE TABLE payment_providers(id TEXT PRIMARY KEY,api_key_encrypted TEXT,webhook_secret_encrypted TEXT)');
 const legacyKey=Buffer.from('default-secret-key-32-chars-long!!!').subarray(0,32);
 const legacy=(mode,text)=>{const iv=crypto.randomBytes(mode==='cbc'?16:12),c=crypto.createCipheriv('aes-256-'+mode,legacyKey,iv),data=Buffer.concat([c.update(text),c.final()]).toString('hex');return mode==='cbc'?iv.toString('hex')+':'+data:[iv.toString('hex'),c.getAuthTag().toString('hex'),data].join(':');};
 const original=legacy('cbc','original-api-key');db.prepare('INSERT INTO payment_providers VALUES(?,?,?)').run('p',original,legacy('gcm','webhook'));
 db.prepare('INSERT INTO payment_providers VALUES(?,?,?)').run('bad','invalid-secret',null);
 assert.throws(()=>migrateProviderSecrets(db,file));assert.equal(db.prepare("SELECT api_key_encrypted AS v FROM payment_providers WHERE id='p'").get().v,original);
 db.exec("DELETE FROM payment_providers WHERE id='bad'");migrateProviderSecrets(db,file);
 const row=db.prepare('SELECT * FROM payment_providers').get(),key=Buffer.from(fs.readFileSync(file+'.secrets-key','utf8'),'hex'),codec=secretCodec(key);
 assert.equal(codec.decrypt(row.api_key_encrypted),'original-api-key');assert.equal(codec.decrypt(row.webhook_secret_encrypted),'webhook');assert.ok(fs.readdirSync(dir).some(x=>x.includes('before-secret-migration')));
 migrateProviderSecrets(db,file);assert.equal(db.prepare('SELECT api_key_encrypted AS v FROM payment_providers').get().v,row.api_key_encrypted);
 process.env.ALMAHASIB_SECRET='wrong-key-that-is-at-least-32-bytes-long';assert.throws(()=>migrateProviderSecrets(db,file));assert.equal(db.prepare('SELECT api_key_encrypted AS v FROM payment_providers').get().v,row.api_key_encrypted);
 delete process.env.ALMAHASIB_SECRET;fs.renameSync(file+'.secrets-key',file+'.saved-key');assert.throws(()=>migrateProviderSecrets(db,file),/missing/);
 }finally{if(saved===undefined)delete process.env.ALMAHASIB_SECRET;else process.env.ALMAHASIB_SECRET=saved;db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
