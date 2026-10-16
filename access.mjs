import {isLocal} from './licensing.mjs';
import crypto from 'node:crypto';
const hash=password=>{const salt=crypto.randomBytes(16).toString('hex');return 'scrypt$'+salt+'$'+crypto.scryptSync(password,salt,64).toString('hex')};
function verify(password,stored){if(!stored.startsWith('scrypt$'))return false;const [,salt,value]=stored.split('$');const key=crypto.scryptSync(password,salt,64),expected=Buffer.from(value,'hex');return key.length===expected.length&&crypto.timingSafeEqual(key,expected)}
export function createAccess({db,send,readJSON,inputError,audit,licensing}){
 for(const user of db.prepare('SELECT id,password FROM users').all())if(!user.password.startsWith('scrypt$'))db.prepare('UPDATE users SET password=? WHERE id=?').run(hash(user.password),user.id);
 db.exec('CREATE TABLE IF NOT EXISTS registered_devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)');
 db.exec('CREATE TABLE IF NOT EXISTS user_grants(user_id TEXT NOT NULL REFERENCES users(id),module TEXT NOT NULL,PRIMARY KEY(user_id,module))');
 if(!db.prepare('PRAGMA table_info(registered_devices)').all().some(x=>x.name==='kind'))db.exec("ALTER TABLE registered_devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'cashier'");
 const sessions=new Map(),failures=new Map();
 const modules=['sales','purchases','stock','accounts','banks','partners','reports','branches','agents','settings'];
 function cookieValue(req,name){return req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)}
 function cookie(req){return cookieValue(req,'alma_session')}
 function userFor(req){const token=cookie(req),session=sessions.get(token);if(!session||(session.local&&!isLocal(req))||session.expires<Date.now()||!db.prepare('SELECT id FROM registered_devices WHERE id=? AND revoked=0').get(session?.device||'')){sessions.delete(token);return null}return db.prepare('SELECT id,username,full_name,role FROM users WHERE id=?').get(session.id)||null}
 function grants(user){return user.role==='admin'?modules:db.prepare('SELECT module FROM user_grants WHERE user_id=?').all(user.id).map(x=>x.module)}
 function handle(req,res,p,body){
  if(p==='/'||p==='/api/health')return false;
  if(!p.startsWith('/api/'))return false;
  // A local browser application must not accept mutations initiated by a different website.
  if(req.method!=='GET'&&req.headers.origin&&req.headers.origin!==(req.socket.encrypted?'https://':'http://')+req.headers.host){send(res,403,{error:'مصدر الطلب غير مسموح'});return true}
  if(req.method==='POST'&&p==='/api/auth/login'){
   const v=readJSON(body),ip=req.socket.remoteAddress,attempt=failures.get(ip);if(attempt&&attempt.until>Date.now()&&attempt.count>=20){send(res,429,{error:'محاولات كثيرة؛ حاول بعد 15 دقيقة'});return true}
   const user=db.prepare('SELECT * FROM users WHERE username=?').get(String(v.username||''));
   if(!user||!verify(String(v.password||''),user.password)){const prior=attempt&&attempt.until>Date.now()?attempt:{count:0,until:Date.now()+900000};prior.count++;failures.set(ip,prior);send(res,401,{error:'اسم المستخدم أو كلمة المرور غير صحيحة'});return true}
   failures.delete(ip);for(const [token,s] of sessions)if(s.expires<Date.now())sessions.delete(token);
   let device=cookieValue(req,'alma_device');
   if(licensing?.status().active&&!isLocal(req)&&db.prepare('SELECT kind FROM registered_devices WHERE id=? AND revoked=0').get(device||'')?.kind!=='cashier'&&db.prepare("SELECT COUNT(*) AS n FROM registered_devices WHERE revoked=0 AND kind='cashier'").get().n>=5){send(res,403,{error:'تم بلوغ حد خمسة كاشيرات'});return true}
   if(!device||!db.prepare('SELECT id FROM registered_devices WHERE id=? AND revoked=0').get(device)){
    if((!licensing?.status().active||!isLocal(req))&&db.prepare(licensing?.status().active?"SELECT COUNT(*) AS n FROM registered_devices WHERE revoked=0 AND kind='cashier'":'SELECT COUNT(*) AS n FROM registered_devices WHERE revoked=0').get().n>=5){send(res,403,{error:'تم بلوغ حد خمسة أجهزة. حرر جهازاً من الإعدادات على جهاز مسجل.'});return true}
    device=crypto.randomBytes(24).toString('hex');db.prepare('INSERT INTO registered_devices(id,name,created_at,last_seen) VALUES(?,?,?,?)').run(device,String(v.device_name||req.headers['user-agent']||'جهاز محلي').slice(0,120),new Date().toISOString(),new Date().toISOString());
   }
   db.prepare('UPDATE registered_devices SET kind=? WHERE id=?').run(isLocal(req)?'primary':'cashier',device);
   db.prepare('UPDATE registered_devices SET last_seen=? WHERE id=?').run(new Date().toISOString(),device);
   const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{id:user.id,device,local:isLocal(req),expires:Date.now()+8*3600000});
   res.setHeader('Set-Cookie',['alma_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800','alma_device='+device+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000']);audit('login',user.id);send(res,200,{id:user.id,username:user.username,full_name:user.full_name,role:user.role,modules:grants(user)});return true;
  }
  const user=userFor(req);if(!user){send(res,401,{error:'يرجى تسجيل الدخول'});return true}
  req.user=user;req.sessionId=cookie(req);req.deviceId=sessions.get(cookie(req)).device;
  if(req.method==='GET'&&p==='/api/auth/me'){send(res,200,{...user,modules:grants(user)});return true}
  if(req.method==='POST'&&p==='/api/auth/logout'){sessions.delete(cookie(req));res.setHeader('Set-Cookie','alma_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');send(res,200,{ok:true});return true}
  if(req.method==='POST'&&p==='/api/auth/password'){
   const v=readJSON(body),existing=db.prepare('SELECT password FROM users WHERE id=?').get(user.id);if(!verify(String(v.current||''),existing.password)||String(v.password||'').length<8)inputError('تحقق من كلمة المرور الحالية والجديدة (8 أحرف على الأقل)');db.prepare('UPDATE users SET password=? WHERE id=?').run(hash(String(v.password)),user.id);for(const [token,s] of sessions)if(s.id===user.id&&token!==cookie(req))sessions.delete(token);audit('password-change',user.id);send(res,200,{ok:true});return true;
  }
  if(licensing?.handle(req,res,p,body))return true;
  if(licensing&&!licensing.allowed(req)){send(res,403,{error:'يلزم تفعيل ترخيص الجهاز الرئيسي',code:'LICENSE_REQUIRED'});return true}
  if(p.startsWith('/api/backup')&&user.role!=='admin'){send(res,403,{error:'النسخ والاستعادة للمدير فقط'});return true}
  if(p==='/api/devices'&&req.method==='GET'){if(user.role!=='admin'){send(res,403,{error:'هذه العملية للمدير فقط'});return true}send(res,200,{limit:5,primary_limit:1,license:licensing?.status(),current:sessions.get(cookie(req)).device,devices:db.prepare('SELECT * FROM registered_devices ORDER BY created_at').all()});return true}
  const revoke=p.match(/^\/api\/devices\/([a-f0-9]{48})\/revoke$/);if(revoke&&req.method==='POST'){if(user.role!=='admin'){send(res,403,{error:'هذه العملية للمدير فقط'});return true}if(revoke[1]===sessions.get(cookie(req)).device)inputError('لا تحرر الجهاز الحالي من جلسته');db.prepare('UPDATE registered_devices SET revoked=1 WHERE id=?').run(revoke[1]);for(const [token,s] of sessions)if(s.device===revoke[1])sessions.delete(token);audit('device-revoked',revoke[1]);send(res,200,{ok:true});return true}
  if(p==='/api/users'){
   if(user.role!=='admin'){send(res,403,{error:'هذه العملية للمدير فقط'});return true}
   if(req.method==='GET'){send(res,200,db.prepare('SELECT id,username,full_name,role,created_at FROM users ORDER BY username').all().map(x=>({...x,modules:grants(x)})));return true}
   if(req.method==='POST'){
    const v=readJSON(body);if(!String(v.username||'').trim()||String(v.password||'').length<8||!['admin','manager','cashier'].includes(v.role)||!Array.isArray(v.modules)||v.modules.some(x=>!modules.includes(x)))inputError('بيانات المستخدم أو الصلاحيات غير صحيحة');
    const id='u-'+crypto.randomUUID();db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO users(id,username,password,full_name,role,created_at) VALUES(?,?,?,?,?,?)').run(id,String(v.username).trim(),hash(String(v.password)),String(v.full_name||''),v.role,new Date().toISOString());for(const module of new Set(v.modules))db.prepare('INSERT INTO user_grants(user_id,module) VALUES(?,?)').run(id,module);audit('user-create',id);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}send(res,201,{id});return true;
   }
  }
  // Read-only lookup access is needed for invoice editors; writes remain module-specific.
  const lookup=req.method==='GET'&&['/api/products','/api/warehouses','/api/units','/api/partners','/api/currency','/api/summary','/api/agents','/api/branches'].includes(p);
  const module=p.startsWith('/api/invoice-qr/')?'sales':p==='/api/scanner/config'?'settings':p.startsWith('/api/v1/market/scanner')?'sales':p==='/api/currency/rate'?'settings':p.startsWith('/api/currency/vouchers')?'banks':p.startsWith('/api/currency')?(req.method==='GET'?'reports':'sales'):p.startsWith('/api/company-sales')?(p.endsWith('/load')?'stock':'sales'):p.startsWith('/api/returns')?(req.method==='POST'?(readJSON(body).kind==='sale'?'sales':'purchases'):'reports'):p.startsWith('/api/payments')||p.startsWith('/api/invoices')||p.startsWith('/api/held')||p.startsWith('/api/shifts')?'sales':p.startsWith('/api/purchases')?'purchases':p.startsWith('/api/stock')||p.startsWith('/api/products')||p.startsWith('/api/warehouses')||p.startsWith('/api/units')||p.startsWith('/api/reservations')?'stock':p.startsWith('/api/assets')||p.startsWith('/api/budgets')||p.startsWith('/api/accounts')||p.startsWith('/api/journal')||p.startsWith('/api/periods')||p.startsWith('/api/ledger')?'accounts':p.startsWith('/api/cash')||p.startsWith('/api/bank/')?'banks':p.startsWith('/api/partners')?'partners':p.startsWith('/api/reports')?'reports':p.startsWith('/api/branches')?'branches':p.startsWith('/api/agents')?'agents':'settings';
  const allowed=grants(user);const sharedRead=(p.startsWith('/api/v1/market/scanner')&&allowed.includes('purchases'))||(p==='/api/invoice-qr/decode'&&allowed.some(x=>['sales','purchases'].includes(x)))||req.method==='GET'&&((['/api/accounts','/api/journal','/api/stock/balances'].includes(p)&&allowed.includes('reports'))||((p==='/api/accounts'||p==='/api/ledger')&&allowed.includes('banks'))||(p==='/api/returns'&&allowed.some(x=>['sales','purchases'].includes(x)))||(p.startsWith('/api/invoices')&&allowed.includes('stock')));if(!lookup&&!sharedRead&&!allowed.includes(module)){send(res,403,{error:'لا تملك صلاحية هذا القسم'});return true}
  if(p==='/api/returns'&&req.method==='POST'){
   const kind=readJSON(body).kind;if(!allowed.includes(kind==='sale'?'sales':'purchases')){send(res,403,{error:'لا تملك صلاحية المرتجع'});return true}
  }
  return false;
 }
 return {handle};
}
