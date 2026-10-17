import {inspectInvoiceQrPart} from './invoice-qr.mjs';
import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
export function scannerERP({db,dbPath,send,readJSON,inputError,audit}){
 db.exec(`CREATE TABLE IF NOT EXISTS scanner_pairs(token TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS scanner_events(id INTEGER PRIMARY KEY, token TEXT NOT NULL REFERENCES scanner_pairs(token), barcode TEXT NOT NULL, created_at TEXT NOT NULL);`);
 for(const [table,name,type] of [['scanner_pairs','last_seen','INTEGER'],['scanner_events','request_id','TEXT']])if(!db.prepare('PRAGMA table_info('+table+')').all().some(x=>x.name===name))db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type);
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS scanner_event_request ON scanner_events(token,request_id) WHERE request_id IS NOT NULL');
 db.exec('CREATE TABLE IF NOT EXISTS scanner_pair_codes(code TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE REFERENCES scanner_pairs(token), expires INTEGER NOT NULL)');
 let tlsServer=null,tlsError=null,config=null,listener=null;
 const codeAttempts=new Map();
 const dir=path.join(path.dirname(dbPath),'tls'),configPath=path.join(dir,'config.json');
 const owner=req=>crypto.createHash('sha256').update((req.deviceId||'')+':'+req.user.id).digest('hex');
 function validate(v){try{
  const hostname=String(v.hostname||'').trim(),port=Number(v.port||3776);if(!hostname||!/^[a-zA-Z0-9.:-]+$/.test(hostname)||!Number.isSafeInteger(port)||port<1||port>65535||port===Number(process.env.PORT||3765))inputError('عنوان HTTPS أو المنفذ غير صحيح');
  const cert=new crypto.X509Certificate(String(v.cert)),key=crypto.createPrivateKey(String(v.key));
  if(!cert.checkPrivateKey(key)||Date.parse(cert.validTo)<=Date.now()||Date.parse(cert.validFrom)>Date.now())inputError('الشهادة والمفتاح غير متطابقين أو الشهادة منتهية');
  if(!(net.isIP(hostname)?cert.checkIP(hostname):cert.checkHost(hostname)))inputError('الشهادة لا تغطي عنوان الخادم');
  return {hostname,port,cert:String(v.cert),key:String(v.key)};
 }catch(error){if(error.status)throw error;inputError('ملفات شهادة HTTPS أو المفتاح الخاص غير صحيحة')} }
 function localOrigin(req){const host=String(req.headers.host||'').split(':')[0];const addresses=Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal);const lan=addresses.find(x=>/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.address))||addresses[0];const advertised=process.env.ALMAHASIB_SCANNER_HOST||lan?.address||host;return 'http://'+advertised+':'+Number(process.env.PORT||3765)}
 function pairingUrl(req,token){return (metadata().origin||localOrigin(req))+'/market-scanner.html#'+token}
 function metadata(){return {enabled:!!tlsServer?.listening,origin:tlsServer?.listening&&config?'https://'+config.hostname+':'+config.port:null,error:tlsError,certificate_required:!config}}
 function startTLS(handler){listener=handler;if(!fs.existsSync(configPath))return;try{const settings=JSON.parse(fs.readFileSync(configPath,'utf8'));config=validate({...settings,cert:fs.readFileSync(path.join(dir,'server.crt'),'utf8'),key:fs.readFileSync(path.join(dir,'server.key'),'utf8')});tlsServer=https.createServer({key:config.key,cert:config.cert,minVersion:'TLSv1.2'},handler);tlsServer.on('error',e=>{tlsError=e.message});tlsServer.listen(config.port,process.env.ALMAHASIB_TLS_HOST||'0.0.0.0')}catch(e){tlsError=e.message}}
 function publicHandle(req,res,p,body){
  if(p==='/api/v1/market/scanner/code/resolve'){
   if(req.method!=='POST'){send(res,405,{error:'الطريقة غير مدعومة'});return true}
   const ip=req.socket.remoteAddress||'unknown',now=Date.now();
   for(const [key,entry] of codeAttempts)if(now-entry.since>600000)codeAttempts.delete(key);
   const entry=codeAttempts.get(ip)||{since:now,count:0};entry.count++;codeAttempts.set(ip,entry);
   if(entry.count>5){send(res,429,{error:'محاولات كثيرة؛ حاول لاحقاً'});return true}
   const code=String(readJSON(body).code||'').trim();
   if(!/^\d{6}$/.test(code)){send(res,400,{error:'رمز غير صالح'});return true}
   const found=db.prepare('SELECT c.token FROM scanner_pair_codes c JOIN scanner_pairs p ON p.token=c.token WHERE c.code=? AND c.expires>? AND p.active=1 AND p.expires>?').get(code,now,now);
   if(!found){send(res,404,{error:'رمز غير صالح أو منتهي'});return true}
   db.prepare('DELETE FROM scanner_pair_codes WHERE code=?').run(code);
   send(res,200,{ok:true,token:found.token});return true;
  }
  const match=p.match(/^\/api\/v1\/market\/scanner\/([a-f0-9]{32})\/(status|scan)$/);if(!match)return false;
  if(req.headers.origin&&req.headers.origin!==(req.socket.encrypted?'https://':'http://')+req.headers.host){send(res,403,{error:'مصدر الطلب غير مسموح'});return true}
  const pair=db.prepare('SELECT * FROM scanner_pairs WHERE token=? AND active=1 AND expires>?').get(match[1],Date.now());if(!pair){send(res,410,{error:'انتهى الربط'});return true}
  if(req.method==='GET'&&match[2]==='status'){db.prepare('UPDATE scanner_pairs SET last_seen=? WHERE token=?').run(Date.now(),pair.token);send(res,200,{ok:true});return true}
  if(req.method==='POST'&&match[2]==='scan'){
   const v=readJSON(body),barcode=String(v.barcode||'').trim();if(barcode.startsWith('ALMAP1:')){try{inspectInvoiceQrPart(barcode)}catch{inputError('رمز QR الفاتورة غير صحيح')}}else if(!barcode||barcode.length>256)inputError('باركود غير صحيح');
   const requestId=v.request_id===undefined?null:String(v.request_id);if(requestId!==null&&!/^[a-zA-Z0-9-]{16,100}$/.test(requestId))inputError('معرف المسح غير صحيح');
   db.prepare('UPDATE scanner_pairs SET last_seen=? WHERE token=?').run(Date.now(),pair.token);
   if(requestId){const prior=db.prepare('SELECT id,barcode FROM scanner_events WHERE token=? AND request_id=?').get(pair.token,requestId);if(prior){if(prior.barcode!==barcode)inputError('معرف المسح مستخدم لباركود آخر');send(res,200,{ok:true,id:prior.id});return true}}
   if(db.prepare('SELECT COUNT(*) AS n FROM scanner_events WHERE token=?').get(pair.token).n>=100000)inputError('قائمة المسح ممتلئة؛ تواصل مع المسؤول');
   const id=Number(db.prepare('INSERT INTO scanner_events(token,barcode,created_at,request_id) VALUES(?,?,?,?)').run(pair.token,barcode,new Date().toISOString(),requestId).lastInsertRowid);send(res,200,{ok:true,id});return true;
  }
  send(res,405,{error:'الطريقة غير مدعومة'});return true;
 }
 function handle(req,res,p,body){
  const get=req.method==='GET',post=req.method==='POST';
  if(get&&p==='/api/scanner/config'){send(res,200,metadata());return true}
  if(post&&p==='/api/scanner/config'){
   if(req.user.role!=='admin'){send(res,403,{error:'إعداد HTTPS للمدير فقط'});return true}const checked=validate(readJSON(body));
   fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'server.crt'),checked.cert,{mode:0o600});fs.writeFileSync(path.join(dir,'server.key'),checked.key,{mode:0o600});fs.writeFileSync(configPath,JSON.stringify({hostname:checked.hostname,port:checked.port}),{mode:0o600});audit('scanner-tls-config','local',{hostname:checked.hostname,port:checked.port});send(res,200,{ok:true,restart_required:true});return true;
  }
  if(get&&p==='/api/v1/market/scanner/pairs'){
   send(res,200,db.prepare('SELECT token,last_seen FROM scanner_pairs WHERE owner=? AND active=1 ORDER BY rowid').all(owner(req)).map(pair=>({...pair,qr_url:pairingUrl(req,pair.token)})));return true;
  }
  if(post&&p==='/api/v1/market/scanner/pair'){
   // Pairing code can be prepared immediately; HTTPS is still required to use the phone camera and transmit scans.
   if(db.prepare('SELECT COUNT(*) AS n FROM scanner_pairs WHERE owner=? AND active=1').get(owner(req)).n>=20)inputError('افصل جهازاً من إعدادات قارئ الهاتف قبل إضافة جهاز آخر');
   const token=crypto.randomBytes(16).toString('hex'),expires=8640000000000000;
   db.prepare('INSERT INTO scanner_pairs(token,owner,expires) VALUES(?,?,?)').run(token,owner(req),expires);
   db.prepare('DELETE FROM scanner_pair_codes WHERE expires<=?').run(Date.now());
   let shortCode;do{shortCode=String(crypto.randomInt(1000000)).padStart(6,'0')}while(db.prepare('SELECT 1 FROM scanner_pair_codes WHERE code=?').get(shortCode));
   db.prepare('INSERT INTO scanner_pair_codes(code,token,expires) VALUES(?,?,?)').run(shortCode,token,Date.now()+300000);
   send(res,201,{token,expires,short_code:shortCode,code_expires:Date.now()+300000,qr_url:pairingUrl(req,token),pairing_origin:metadata().origin||localOrigin(req)});return true;
  }
  const poll=p.match(/^\/api\/v1\/market\/scanner\/([a-f0-9]{32})\/(poll|revoke)$/);
  if(poll){db.prepare('UPDATE scanner_pairs SET owner=?,expires=? WHERE token=? AND owner=? AND active=1').run(owner(req),8640000000000000,poll[1],crypto.createHash('sha256').update(req.sessionId||'').digest('hex'));const pair=db.prepare('SELECT * FROM scanner_pairs WHERE token=? AND owner=? AND active=1 AND expires>?').get(poll[1],owner(req),Date.now());if(!pair){send(res,410,{error:'الربط غير صالح لهذه الجلسة'});return true}
   if(post&&poll[2]==='revoke'){db.prepare('DELETE FROM scanner_pair_codes WHERE token=?').run(pair.token);db.prepare('UPDATE scanner_pairs SET active=0 WHERE token=?').run(pair.token);send(res,200,{ok:true});return true}
   if(get&&poll[2]==='poll'){const since=Number(new URL(req.url,'http://localhost').searchParams.get('since')||0);if(!Number.isSafeInteger(since)||since<0)inputError('مؤشر المسح غير صحيح');send(res,200,{phone_connected:!!pair.last_seen&&Date.now()-pair.last_seen<15000,last_seen:pair.last_seen||null,events:db.prepare('SELECT id,barcode,created_at FROM scanner_events WHERE token=? AND id>? ORDER BY id LIMIT 100').all(pair.token,since)});return true}
  }
  return false;
 }
 return {handle,publicHandle,startTLS,metadata};
}
