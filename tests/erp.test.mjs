import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'alma-erp-')),dbPath=join(dir,'company.sqlite');let child,base,cookie='';let logs='';
 async function start(){child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,ALMAHASIB_DB:dbPath,PORT:'0'},stdio:['ignore','pipe','pipe']});child.stderr.on('data',x=>logs+=x);base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Start timed out: '+logs)),7000);child.stdout.on('data',x=>{const m=String(x).match(/http:\/\/127.0.0.1:(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1])}});child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+': '+logs))})});}
 async function stop(){if(child.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit}}
 async function request(path,method='GET',body,headers={}){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...headers},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.getSetCookie().length){const jar=new Map(cookie.split('; ').filter(Boolean).map(x=>[x.split('=')[0],x]));for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0];jar.set(pair.split('=')[0],pair)}cookie=[...jar.values()].join('; ')}const data=r.headers.get('content-type')?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer());return {status:r.status,data}}
 async function login(username='admin',password='admin123'){const r=await request('/api/auth/login','POST',{username,password});assert.equal(r.status,200,JSON.stringify(r.data));return r}
 await start();return {request,login,start,stop,dbPath,dir,base:()=>base,cleanup:async()=>{await stop();rmSync(dir,{recursive:true,force:true})}};
}
async function created(f,path,body){const r=await f.request(path,'POST',body);assert.equal(r.status,201,JSON.stringify(r.data));return r.data}

test('ERP: weighted cost, reservations, transfers, returns, drafts and idempotent posting',async()=>{
 const f=await fixture();try{
 await f.login();const supplier=await created(f,'/api/partners',{name:'مورد',type:'supplier'}),customer=await created(f,'/api/partners',{name:'عميل',type:'customer'});
 await created(f,'/api/products',{id:'A',name:'مادة',price:200,cost:100});
 let purchase=await created(f,'/api/purchases',{partner_id:supplier.id,paid:500,lines:[{product_id:'A',qty:10,cost:100}]});
 const warehouse=await created(f,'/api/warehouses',{name:'مخزن ثاني'});
 await created(f,'/api/stock/transfer',{product_id:'A',from:1,to:warehouse.id,qty:2});
 let balances=(await f.request('/api/stock/balances')).data;assert.equal(balances.find(x=>x.warehouse_id===1).stock,8);
 const today=new Date().toISOString().slice(0,10);const reservation=await created(f,'/api/reservations',{product_id:'A',warehouse_id:1,qty:6,customer:'محجوز',start:today,end:today});
 let rejected=await f.request('/api/invoices','POST',{lines:[{id:'A',qty:3}]});assert.equal(rejected.status,400);
 assert.equal((await f.request('/api/invoices')).data.length,0);
 await f.request('/api/reservations/'+reservation.id+'/release','POST',{});
 let draft=await created(f,'/api/invoices',{source:'company',partner_id:customer.id,payment:'آجل',status:'held',lines:[{id:'A',qty:2}]});
 const edited=await created(f,'/api/invoices',{source:'company',draft_id:draft.id,partner_id:customer.id,paid:100,payment:'مختلط',lines:[{id:'A',qty:3}]});assert.equal(edited.id,draft.id);
 assert.equal((await f.request('/api/company-sales/'+edited.id+'/approve','POST',{})).status,200);assert.equal((await f.request('/api/company-sales/'+edited.id+'/load','POST',{})).status,200);
 let invoice=(await f.request('/api/invoices/'+edited.id)).data;assert.equal(invoice.lines.length,1);assert.equal(invoice.lines[0].cost_snapshot,100);
 let returned=await created(f,'/api/returns',{kind:'sale',invoice_id:edited.id,cash_refund:0,reason:'جزئي',lines:[{item_id:invoice.lines[0].id,qty:1}]});assert.equal(returned.amount,200);
 rejected=await f.request('/api/returns','POST',{kind:'sale',invoice_id:edited.id,cash_refund:0,reason:'زائد',lines:[{item_id:invoice.lines[0].id,qty:3}]});assert.equal(rejected.status,400);
 let statement=(await f.request('/api/partners/statement?id='+customer.id)).data;assert.equal(statement.at(-1).balance,300);
 let before=(await f.request('/api/journal')).data.length;
 const payload={partner_id:supplier.id,paid:0,lines:[{product_id:'A',qty:2,cost:200}]};const headers={'Idempotency-Key':'purchase-once'};
 const first=await f.request('/api/purchases','POST',payload,headers);assert.equal(first.status,201);const second=await f.request('/api/purchases','POST',payload,headers);assert.equal(second.status,200);assert.equal(first.data.id,second.data.id);assert.equal((await f.request('/api/journal')).data.length,before+1);
 const conflict=await f.request('/api/purchases','POST',{...payload,paid:1},headers);assert.equal(conflict.status,400);
 const products=(await f.request('/api/products')).data;assert.equal(products[0].cost,120);
 const purchased=(await f.request('/api/purchases/'+purchase.id)).data;
 returned=await created(f,'/api/returns',{kind:'purchase',invoice_id:purchase.id,cash_refund:100,reason:'إرجاع',lines:[{item_id:purchased.lines[0].id,qty:1}]});assert.equal(returned.amount,100);
 const financial=(await f.request('/api/reports/financial')).data;assert.equal(financial.debit,financial.credit);
 const cancelled=await created(f,'/api/invoices',{status:'held',lines:[{id:'A',qty:1}]});assert.equal((await f.request('/api/held/'+cancelled.id+'/cancel','POST',{})).status,200);assert.equal((await f.request('/api/held/'+cancelled.id+'/complete','POST',{})).status,400);
 const audit=(await f.request('/api/audit')).data;assert.ok(audit.some(x=>x.action==='return'));assert.ok(audit.some(x=>x.action==='stock-transfer'));
 }finally{await f.cleanup()}
});

test('ERP: permissions, fiscal lock, reversal, shifts, backup and actual restore',async()=>{
 const f=await fixture();try{
 assert.equal((await f.request('/api/products')).status,401);await f.login();
 const today=new Date().toISOString().slice(0,10),period=await created(f,'/api/periods',{name:'اليوم',start:today,end:today});
 const manual=await created(f,'/api/journal',{description:'رصيد افتتاحي',lines:[{account_id:'101',debit:1000},{account_id:'3',credit:1000}]});
 const reverse=await created(f,'/api/journal/'+manual.id+'/reverse',{});assert.ok(reverse.id);assert.equal((await f.request('/api/journal/'+manual.id+'/reverse','POST',{})).status,400);
 const shift=await created(f,'/api/shifts/open',{user_name:'كاشير',opening:50});await created(f,'/api/cash/vouchers',{kind:'receipt',cash_account:'101',counterpart:'3',amount:100});
 const close=await f.request('/api/shifts/'+shift.id+'/close','POST',{counted:145});assert.equal(close.data.expected,150);assert.equal(close.data.difference,-5);
 await f.request('/api/periods/'+period.id+'/close','POST',{});
 const before=(await f.request('/api/journal')).data.length;assert.equal((await f.request('/api/journal','POST',{lines:[{account_id:'101',debit:100},{account_id:'3',credit:100}]})).status,400);assert.equal((await f.request('/api/journal')).data.length,before);
 await f.request('/api/periods/'+period.id+'/reopen','POST',{});
 await created(f,'/api/branches',{name:'فرع'});const backup=await f.request('/api/backup');assert.equal(backup.status,200);assert.equal(backup.data.subarray(0,16).toString(),'SQLite format 3\u0000');
 await created(f,'/api/branches',{name:'بعد النسخة'});
 assert.equal((await f.request('/api/backup/restore','POST',{base64:Buffer.from('invalid').toString('base64')})).status,400);
 const restored=await f.request('/api/backup/restore','POST',{base64:backup.data.toString('base64')});assert.equal(restored.status,200);assert.equal(restored.data.restart_required,true);
 await f.stop();await f.start();await f.login();assert.equal((await f.request('/api/branches')).data.length,1);
 const users=await created(f,'/api/users',{username:'seller',password:'seller1234',full_name:'بائع',role:'cashier',modules:['sales']});assert.ok(users.id);
 await f.request('/api/auth/logout','POST',{});await f.login('seller','seller1234');assert.equal((await f.request('/api/products')).status,200);assert.equal((await f.request('/api/users')).status,403);assert.equal((await f.request('/api/products','POST',{id:'B',name:'ممنوع',price:1})).status,403);assert.equal((await f.request('/api/backup')).status,403);
 await f.request('/api/auth/logout','POST',{});await f.login();const changed=await f.request('/api/auth/password','POST',{current:'admin123',password:'NewPass1234'});assert.equal(changed.status,200);
 await f.stop();await f.start();await f.login('admin','NewPass1234');const warehouses=(await f.request('/api/warehouses')).data;assert.equal(warehouses.length,1);
 const check=new DatabaseSync(f.dbPath,{readOnly:true});assert.ok(check.prepare("SELECT password FROM users WHERE username='admin'").get().password.startsWith('scrypt$'));assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(check.prepare('PRAGMA foreign_key_check').all().length,0);check.close();
 }finally{await f.cleanup()}
});

test('ERP: asset depreciation, budgets, bank matching, CSV import, count and five-device limit',async()=>{
 const f=await fixture();try{
 await f.login();const today=new Date().toISOString().slice(0,10);
 const asset=await created(f,'/api/assets',{name:'حاسوب',cost:12000,residual:0,months:12,acquired:today});
 const dep=await created(f,'/api/assets/'+asset.id+'/depreciate',{month:today.slice(0,7)});assert.equal(dep.amount,1000);
 const journals=(await f.request('/api/journal')).data.length;
 assert.equal((await f.request('/api/assets/'+asset.id+'/depreciate','POST',{month:today.slice(0,7)})).status,400);assert.equal((await f.request('/api/journal')).data.length,journals);
 await created(f,'/api/budgets',{account_id:'503',year:Number(today.slice(0,4)),amount:12000});const budgets=(await f.request('/api/budgets')).data;assert.equal(budgets[0].actual,1000);
 await created(f,'/api/cash/vouchers',{kind:'receipt',cash_account:'103',counterpart:'3',amount:500});const reconciliation=await created(f,'/api/bank/reconciliations',{statement_balance:480,description:'عمولة قيد المراجعة'});assert.equal(reconciliation.difference,-20);assert.equal(reconciliation.book_balance,500);
 const imported=await created(f,'/api/products/import',{rows:[{id:'X',name:'منتج',price:20,cost:10},{id:'Y',name:'ثانٍ',price:30,cost:15}]});assert.equal(imported.count,2);
 const failed=await f.request('/api/products/import','POST',{rows:[{id:'Z',name:'جديد',price:1,cost:1},{id:'X',name:'مكرر',price:1,cost:1}]});assert.equal(failed.status,400);assert.equal((await f.request('/api/products')).data.length,2);
 const count=await created(f,'/api/stock/count',{product_id:'X',warehouse_id:1,counted:5,expected:0});assert.equal(count.delta,5);assert.equal((await f.request('/api/stock/count','POST',{product_id:'X',warehouse_id:1,counted:2,expected:0})).status,400);
 const financial=(await f.request('/api/reports/financial')).data;assert.equal(financial.debit,financial.credit);
 for(let i=0;i<4;i++){const r=await fetch(f.base()+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123',device_name:'device-'+i})});assert.equal(r.status,200)}
 const sixth=await fetch(f.base()+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});assert.equal(sixth.status,403);
 const devices=(await f.request('/api/devices')).data;assert.equal(devices.devices.filter(x=>!x.revoked).length,5);const other=devices.devices.find(x=>x.id!==devices.current);assert.equal((await f.request('/api/devices/'+other.id+'/revoke','POST',{})).status,200);
 const released=await fetch(f.base()+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});assert.equal(released.status,200);
 }finally{await f.cleanup()}
});

test('ERP: old database migration preserves products and startup does not duplicate warehouse',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'alma-legacy-')),database=join(dir,'legacy.sqlite');const old=new DatabaseSync(database);old.exec("CREATE TABLE products(id TEXT PRIMARY KEY,name TEXT NOT NULL,price INTEGER NOT NULL);INSERT INTO products VALUES('legacy','قديم',100);PRAGMA user_version=2");old.close();let child;try{
 for(let run=0;run<2;run++){child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,ALMAHASIB_DB:database,PORT:'0'},stdio:['ignore','pipe','pipe']});let logs='';child.stderr.on('data',x=>logs+=x);await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error(logs||'migration timed out')),7000);child.stdout.once('data',()=>{clearTimeout(t);resolve()});child.once('exit',()=>{clearTimeout(t);reject(Error(logs))})});const done=new Promise(r=>child.once('exit',r));child.kill();await done}
 const check=new DatabaseSync(database,{readOnly:true});assert.equal(check.prepare("SELECT name FROM products WHERE id='legacy'").get().name,'قديم');assert.ok(check.prepare('PRAGMA table_info(products)').all().some(x=>x.name==='barcode'));assert.equal(check.prepare('SELECT COUNT(*) AS n FROM warehouses').get().n,1);assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');check.close();
 }finally{if(child?.exitCode===null)child.kill();rmSync(dir,{recursive:true,force:true})}
});

test('ERP: carrying value and discounted returns preserve rounding remainders exactly',async()=>{
 const f=await fixture();try{
 await f.login();const supplier=await created(f,'/api/partners',{name:'مورد التقريب',type:'supplier'});await created(f,'/api/products',{id:'ROUND',name:'اختبار القيمة',price:100,cost:0});
 await created(f,'/api/purchases',{partner_id:supplier.id,paid:0,lines:[{product_id:'ROUND',qty:2,cost:10},{product_id:'ROUND',qty:1,cost:11}]});
 let balance=(await f.request('/api/stock/balances')).data[0];assert.equal(balance.value,31);assert.equal(balance.stock,3);
 const sale=await created(f,'/api/invoices',{discount:1,lines:[{id:'ROUND',qty:1},{id:'ROUND',qty:2}]});const detail=(await f.request('/api/invoices/'+sale.id)).data;assert.equal(detail.lines.reduce((n,x)=>n+x.cost_total,0),31);assert.equal(detail.lines.reduce((n,x)=>n+x.net_amount,0),299);
 balance=(await f.request('/api/stock/balances')).data[0];assert.equal(balance.value,0);assert.equal(balance.stock,0);
 await created(f,'/api/returns',{kind:'sale',invoice_id:sale.id,cash_refund:99,reason:'أول',lines:[{item_id:detail.lines[0].id,qty:1}]});
 await created(f,'/api/returns',{kind:'sale',invoice_id:sale.id,cash_refund:200,reason:'الباقي',lines:[{item_id:detail.lines[1].id,qty:2}]});
 balance=(await f.request('/api/stock/balances')).data[0];assert.equal(balance.value,31);assert.equal(balance.stock,3);
 const accounts=(await f.request('/api/accounts')).data,stockAccount=accounts.find(x=>x.id==='102');assert.equal(stockAccount.debit-stockAccount.credit,31);const financial=(await f.request('/api/reports/financial')).data;assert.equal(financial.profit,0);assert.equal(financial.debit,financial.credit);
 }finally{await f.cleanup()}
});
