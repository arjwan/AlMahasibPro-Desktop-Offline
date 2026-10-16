import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
export function scannerERP({db,dbPath,send,readJSON,inputError,audit}){
 db.exec(`CREATE TABLE IF NOT EXISTS scanner_pairs(token TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS scanner_events(id INTEGER PRIMARY KEY, token TEXT NOT NULL REFERENCES scanner_pairs(token), barcode TEXT NOT NULL, created_at TEXT NOT NULL);`);
 for(const [table,name,type] of [['scanner_pairs','last_seen','INTEGER'],['scanner_events','request_id','TEXT']])if(!db.prepare('PRAGMA table_info('+table+')').all().some(x=>x.name===name))db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type);
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS scanner_event_request ON scanner_events(token,request_id) WHERE request_id IS NOT NULL');
 let tlsServer=null,tlsError=null,config=null,listener=null;
 const dir=path.join(path.dirname(dbPath),'tls'),configPath=path.join(dir,'config.json');
 const owner=req=>crypto.createHash('sha256').update(req.sessionId||'').digest('hex');
 function validate(v){try{
  const hostname=String(v.hostname||'').trim(),port=Number(v.port||3776);if(!hostname||!/^[a-zA-Z0-9.:-]+$/.test(hostname)||!Number.isSafeInteger(port)||port<1||port>65535||port===Number(process.env.PORT||3765))inputError('عنوان HTTPS أو المنفذ غير صحيح');
  const cert=new crypto.X509Certificate(String(v.cert)),key=crypto.createPrivateKey(String(v.key));
  if(!cert.checkPrivateKey(key)||Date.parse(cert.validTo)<=Date.now()||Date.parse(cert.validFrom)>Date.now())inputError('الشهادة والمفتاح غير متطابقين أو الشهادة منتهية');
  if(!(net.isIP(hostname)?cert.checkIP(hostname):cert.checkHost(hostname)))inputError('الشهادة لا تغطي عنوان الخادم');
  return {hostname,port,cert:String(v.cert),key:String(v.key)};
 }catch(error){if(error.status)throw error;inputError('ملفات شهادة HTTPS أو المفتاح الخاص غير صحيحة')} }
 function metadata(){return {enabled:!!tlsServer?.listening,origin:config?'https://'+config.hostname+':'+config.port:null,error:tlsError,certificate_required:!config}}
 function startTLS(handler){listener=handler;if(!fs.existsSync(configPath))return;try{const settings=JSON.parse(fs.readFileSync(configPath,'utf8'));config=validate({...settings,cert:fs.readFileSync(path.join(dir,'server.crt'),'utf8'),key:fs.readFileSync(path.join(dir,'server.key'),'utf8')});tlsServer=https.createServer({key:config.key,cert:config.cert,minVersion:'TLSv1.2'},handler);tlsServer.on('error',e=>{tlsError=e.message});tlsServer.listen(config.port,process.env.ALMAHASIB_TLS_HOST||'0.0.0.0')}catch(e){tlsError=e.message}}
 function publicHandle(req,res,p,body){
  const match=p.match(/^\/api\/v1\/market\/scanner\/([a-f0-9]{32})\/(status|scan)$/);if(!match)return false;
  if(req.headers.origin&&req.headers.origin!=='https://'+req.headers.host){send(res,403,{error:'مصدر الطلب غير مسموح'});return true}
  if(!req.socket.encrypted){send(res,403,{error:'الماسح يحتاج HTTPS موثوقاً'});return true}
  const pair=db.prepare('SELECT * FROM scanner_pairs WHERE token=? AND active=1 AND expires>?').get(match[1],Date.now());if(!pair){send(res,410,{error:'انتهى الربط'});return true}
  if(req.method==='GET'&&match[2]==='status'){db.prepare('UPDATE scanner_pairs SET last_seen=? WHERE token=?').run(Date.now(),pair.token);send(res,200,{ok:true});return true}
  if(req.method==='POST'&&match[2]==='scan'){
   const v=readJSON(body),barcode=String(v.barcode||'').trim();if(!barcode||barcode.length>256)inputError('باركود غير صحيح');
   const requestId=v.request_id===undefined?null:String(v.request_id);if(requestId!==null&&!/^[a-zA-Z0-9-]{16,100}$/.test(requestId))inputError('معرف المسح غير صحيح');
   db.prepare('UPDATE scanner_pairs SET last_seen=? WHERE token=?').run(Date.now(),pair.token);
   if(requestId){const prior=db.prepare('SELECT id,barcode FROM scanner_events WHERE token=? AND request_id=?').get(pair.token,requestId);if(prior){if(prior.barcode!==barcode)inputError('معرف المسح مستخدم لباركود آخر');send(res,200,{ok:true,id:prior.id});return true}}
   if(db.prepare('SELECT COUNT(*) AS n FROM scanner_events WHERE token=?').get(pair.token).n>=10000)inputError('امتلأت قائمة المسح؛ أنشئ ربطاً جديداً');
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
  if(post&&p==='/api/v1/market/scanner/pair'){
   if(!tlsServer?.listening||tlsError)inputError('فعّل HTTPS موثوقاً من الإعدادات أولاً');
   const token=crypto.randomBytes(16).toString('hex'),expires=Date.now()+3600000;
   db.prepare('UPDATE scanner_pairs SET active=0 WHERE owner=?').run(owner(req));db.prepare('INSERT INTO scanner_pairs(token,owner,expires) VALUES(?,?,?)').run(token,owner(req),expires);
   send(res,201,{token,expires,qr_url:metadata().origin+'/market-scanner.html#'+token});return true;
  }
  const poll=p.match(/^\/api\/v1\/market\/scanner\/([a-f0-9]{32})\/(poll|revoke)$/);
  if(poll){const pair=db.prepare('SELECT * FROM scanner_pairs WHERE token=? AND owner=? AND active=1 AND expires>?').get(poll[1],owner(req),Date.now());if(!pair){send(res,410,{error:'الربط غير صالح لهذه الجلسة'});return true}
   if(post&&poll[2]==='revoke'){db.prepare('UPDATE scanner_pairs SET active=0 WHERE token=?').run(pair.token);send(res,200,{ok:true});return true}
   if(get&&poll[2]==='poll'){const since=Number(new URL(req.url,'http://localhost').searchParams.get('since')||0);if(!Number.isSafeInteger(since)||since<0)inputError('مؤشر المسح غير صحيح');send(res,200,{phone_connected:!!pair.last_seen&&Date.now()-pair.last_seen<15000,last_seen:pair.last_seen||null,events:db.prepare('SELECT id,barcode,created_at FROM scanner_events WHERE token=? AND id>? ORDER BY id LIMIT 100').all(pair.token,since)});return true}
  }
  return false;
 }
 return {handle,publicHandle,startTLS,metadata};
}
