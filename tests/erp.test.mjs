import https from 'node:https';
import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'alma-erp-')),dbPath=join(dir,'company.sqlite');let child,base,cookie='';let logs='';
 async function start(){child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,ALMAHASIB_DB:dbPath,PORT:'0'},stdio:['ignore','pipe','pipe']});child.stderr.on('data',x=>logs+=x);base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Start timed out: '+logs)),15000);child.stdout.on('data',x=>{const m=String(x).match(/http:\/\/127.0.0.1:(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1])}});child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+': '+logs))})});}
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
 for(let run=0;run<2;run++){child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,ALMAHASIB_DB:database,PORT:'0'},stdio:['ignore','pipe','pipe']});let logs='';child.stderr.on('data',x=>logs+=x);await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error(logs||'migration timed out')),15000);child.stdout.once('data',()=>{clearTimeout(t);resolve()});child.once('exit',()=>{clearTimeout(t);reject(Error(logs))})});const done=new Promise(r=>child.once('exit',r));child.kill();await done}
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

test('ERP: partial shipping reserves remainder, allocates payment exactly, supports returns and rejects repeats',async()=>{
 const f=await fixture();try{await f.login();const customer=await created(f,'/api/partners',{name:'عميل الدفعات',type:'customer'});await created(f,'/api/products',{id:'PART',name:'دفعات',cost:33,price:101});await created(f,'/api/stock/adjust',{product_id:'PART',delta:6});
 const invoice=await created(f,'/api/invoices',{source:'company',partner_id:customer.id,paid:301,discount:1,lines:[{id:'PART',qty:6}]});await f.request('/api/company-sales/'+invoice.id+'/approve','POST',{});let detail=(await f.request('/api/invoices/'+invoice.id)).data;const item=detail.lines[0].id;
 const body={expected_version:0,lines:[{item_id:item,qty:2}]},key={'Idempotency-Key':'ship-once'};let shipped=await f.request('/api/company-sales/'+invoice.id+'/load','POST',body,key);assert.equal(shipped.status,200);assert.equal(shipped.data.net,201);assert.equal(shipped.data.paid,100);assert.equal(shipped.data.complete,false);
 assert.equal((await f.request('/api/company-sales/'+invoice.id+'/load','POST',body,key)).status,200);assert.equal((await f.request('/api/company-sales/'+invoice.id+'/load','POST',body)).status,400);
 let stock=(await f.request('/api/products')).data[0];assert.equal(stock.stock,4);assert.equal(stock.available,0);assert.equal((await f.request('/api/summary')).data.sales,201);
 assert.equal((await f.request('/api/held/'+invoice.id+'/cancel','POST',{})).status,400);assert.equal((await f.request('/api/returns','POST',{kind:'sale',invoice_id:invoice.id,reason:'غير محمل',cash_refund:0,lines:[{item_id:item,qty:3}]})).status,400);
 await created(f,'/api/returns',{kind:'sale',invoice_id:invoice.id,reason:'مرتجع من دفعة محملة',cash_refund:0,lines:[{item_id:item,qty:1}]});
 let remaining=await f.request('/api/company-sales/'+invoice.id+'/load','POST',{expected_version:1,lines:[{item_id:item,qty:1}]});assert.equal(remaining.data.net,101);assert.equal(remaining.data.paid,50);
 remaining=await f.request('/api/company-sales/'+invoice.id+'/load','POST',{expected_version:2});assert.equal(remaining.data.complete,true);detail=(await f.request('/api/invoices/'+invoice.id)).data;assert.equal(detail.shipments.length,3);assert.equal(detail.shipments.reduce((n,x)=>n+x.net,0),605);assert.equal(detail.shipments.reduce((n,x)=>n+x.paid,0),301);assert.equal(detail.lines[0].loaded_qty,6);
 assert.equal((await f.request('/api/partners/statement?id='+customer.id)).data.at(-1).balance,204);const accounts=(await f.request('/api/accounts')).data;assert.equal(accounts.find(x=>x.id==='401').credit,605);assert.equal(accounts.find(x=>x.id==='401').debit,100);assert.equal((await f.request('/api/summary')).data.sales,605);
 }finally{await f.cleanup()}
});

test('ERP: closing transfers profit once, reopening reverses closing and period profit remains readable',async()=>{
 const f=await fixture();try{await f.login();const day=new Date().toISOString().slice(0,10);await created(f,'/api/journal',{lines:[{account_id:'101',debit:1000},{account_id:'401',credit:1000}]});await created(f,'/api/journal',{lines:[{account_id:'501',debit:300},{account_id:'101',credit:300}]});const period=await created(f,'/api/periods',{name:'إقفال',start:day,end:day});const close=await f.request('/api/periods/'+period.id+'/close','POST',{});assert.equal(close.status,200);assert.equal(close.data.profit,700);
 let accounts=(await f.request('/api/accounts')).data;assert.equal(accounts.find(x=>x.id==='401').debit,accounts.find(x=>x.id==='401').credit);assert.equal(accounts.find(x=>x.id==='301').credit,700);assert.equal((await f.request('/api/reports/period-profit?period_id='+period.id)).data.profit,700);assert.equal((await f.request('/api/periods/'+period.id+'/close','POST',{})).status,400);
 assert.equal((await f.request('/api/periods/'+period.id+'/reopen','POST',{})).status,200);accounts=(await f.request('/api/accounts')).data;assert.equal(accounts.find(x=>x.id==='401').credit-accounts.find(x=>x.id==='401').debit,1000);assert.equal(accounts.find(x=>x.id==='301').credit-accounts.find(x=>x.id==='301').debit,0);assert.equal((await f.request('/api/reports/period-profit?period_id='+period.id)).data.profit,700);
 }finally{await f.cleanup()}
});

test('ERP: USD invoice snapshots and physical cash realize exchange differences without changing old rates',async()=>{
 const f=await fixture();try{await f.login();const supplier=await created(f,'/api/partners',{name:'مورد دولار',type:'supplier'});await created(f,'/api/products',{id:'USD',name:'دولار',price:2000,cost:0});assert.equal((await f.request('/api/purchases','POST',{currency:'USD',partner_id:supplier.id,lines:[{product_id:'USD',qty:2,cost:'1.25'}]})).status,400);
 await created(f,'/api/currency/rate',{rate:'1310'});const invoice=await created(f,'/api/purchases',{currency:'USD',exchange_rate:'1310',partner_id:supplier.id,paid:0,lines:[{product_id:'USD',qty:2,cost:'1.25'}]});assert.equal(invoice.net,3275);let detail=(await f.request('/api/purchases/'+invoice.id)).data;assert.equal(detail.currency,'USD');assert.equal(detail.exchange_rate,'1310');assert.equal(JSON.parse(detail.foreign_snapshot).lines[0].cost,'1.25');
 await created(f,'/api/currency/vouchers',{kind:'receipt',account_id:'107',counterpart:'3',amount:'100.00',rate:'1310'});await created(f,'/api/currency/rate',{rate:'1320'});const payment=await created(f,'/api/currency/vouchers',{kind:'payment',account_id:'107',counterpart:'501',amount:'50.00',rate:'1320'});assert.equal(payment.base_amount,66000);assert.equal(payment.carrying,65500);assert.equal(payment.exchange_difference,500);const tiny=await created(f,'/api/purchases',{currency:'USD',exchange_rate:'1320',partner_id:supplier.id,paid:0,lines:[{product_id:'USD',qty:1,cost:'0.03'},{product_id:'USD',qty:1,cost:'0.03'},{product_id:'USD',qty:1,cost:'0.03'}]});assert.equal(tiny.net,119);const balances=(await f.request('/api/currency')).data.balances;assert.equal(balances[0].foreign_cents,5000);assert.equal(balances[0].base_value,65500);
 detail=(await f.request('/api/purchases/'+invoice.id)).data;assert.equal(detail.exchange_rate,'1310');assert.equal((await f.request('/api/currency/vouchers','POST',{kind:'payment',account_id:'107',counterpart:'501',amount:'100.00'})).status,400);assert.equal((await f.request('/api/currency/quote','POST',{amount:'1.00',rate:'1310'})).status,400);
 const financial=(await f.request('/api/reports/financial')).data;assert.equal(financial.debit,financial.credit);
 }finally{await f.cleanup()}
});

test('ERP: existing scanner protocol pairs over trusted test TLS, queues barcodes and isolates browser sessions',async()=>{
 const f=await fixture();try{await f.login();assert.equal((await f.request('/api/v1/market/scanner/pair','POST',{})).status,400);
 const cert=readFileSync(join(root,'tests/fixtures/test-only-localhost.crt'),'utf8'),key=readFileSync(join(root,'tests/fixtures/test-only-localhost.key'),'utf8'),probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 let config=await f.request('/api/scanner/config','POST',{hostname:'127.0.0.1',port,cert,key});assert.equal(config.status,200);assert.equal(config.data.restart_required,true);await f.stop();await f.start();await f.login();
 const settings=(await f.request('/api/scanner/config')).data;assert.equal(settings.enabled,true);assert.equal(settings.origin,'https://127.0.0.1:'+port);
 const pair=await created(f,'/api/v1/market/scanner/pair',{});assert.match(pair.qr_url,new RegExp('^https://127\\.0\\.0\\.1:'+port+'/market-scanner\\.html#[a-f0-9]{32}$'));
 function secure(path,method='GET',body){return new Promise((resolve,reject)=>{const request=https.request({hostname:'127.0.0.1',port,path,method,ca:cert,headers:{'Content-Type':'application/json'}},r=>{let text='';r.on('data',x=>text+=x);r.on('end',()=>resolve({status:r.statusCode,data:JSON.parse(text)}))});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body))})}
 const base='/api/v1/market/scanner/'+pair.token;assert.equal((await secure(base+'/status')).status,200);assert.equal((await f.request(base+'/status')).status,403);const event=await secure(base+'/scan','POST',{barcode:'SCANNER-LOCAL'});assert.equal(event.status,200);
 let poll=await f.request(base+'/poll');assert.equal(poll.status,200);assert.equal(poll.data.events[0].barcode,'SCANNER-LOCAL');assert.equal((await f.request(base+'/poll?since='+event.data.id)).data.events.length,0);
 const other=await fetch(f.base()+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});const cookie=other.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');const foreign=await fetch(f.base()+base+'/poll',{headers:{Cookie:cookie}});assert.equal(foreign.status,410);
 assert.equal((await f.request(base+'/revoke','POST',{})).status,200);assert.equal((await secure(base+'/status')).status,410);
 }finally{await f.cleanup()}
});

test('ERP: legacy journal without reference preserves balances and loads accounting/report endpoints twice',async()=>{
 const f=await fixture();try{
 await f.login();
 const entry=await created(f,'/api/journal',{description:'رصيد قديم محفوظ',lines:[{account_id:'101',debit:750},{account_id:'3',credit:750}]});
 await f.stop();
 const old=new DatabaseSync(f.dbPath);
 old.exec('ALTER TABLE journal_entries DROP COLUMN reference');
 old.close();
 for(let run=0;run<2;run++){
  await f.start();await f.login();
  for(const path of ['/api/accounts','/api/journal','/api/periods','/api/assets','/api/budgets','/api/reports/financial','/api/stock/balances','/api/ledger?account_id=101']){
   const result=await f.request(path);assert.equal(result.status,200,path+': '+JSON.stringify(result.data));
  }
  const journals=(await f.request('/api/journal')).data;
  assert.equal(journals.find(x=>x.id===entry.id).description,'رصيد قديم محفوظ');
  assert.equal(journals.find(x=>x.id===entry.id).debit,750);
  const ledger=(await f.request('/api/ledger?account_id=101')).data;
  assert.equal(ledger.at(-1).balance,750);
  const report=(await f.request('/api/reports/financial')).data;
  assert.equal(report.assets,750);assert.equal(report.equity,750);assert.equal(report.debit,report.credit);
  if(run===0)await f.stop();
 }
 const check=new DatabaseSync(f.dbPath,{readOnly:true});
 assert.ok(check.prepare('PRAGMA table_info(journal_entries)').all().some(x=>x.name==='reference'));
 assert.equal(check.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n,1);
 assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');check.close();
 }finally{await f.cleanup()}
});

test('Purchases: supplier numbers, editable dates, repeated materials, atomic posting and retry protection',async()=>{
 const f=await fixture();try{await f.login();const a=await created(f,'/api/partners',{name:'مورد أول',type:'supplier'}),b=await created(f,'/api/partners',{name:'مورد ثان',type:'supplier'});await created(f,'/api/products',{id:'BUY',name:'مادة شراء',barcode:'998811',price:200,cost:0});
 const payload={partner_id:a.id,supplier_invoice_no:' INV-77 ',date:'2026-01-05',time:'09:35',paid:100,discount:10,lines:[{product_id:'BUY',qty:2,cost:100}]};
 const first=await created(f,'/api/purchases',payload),detail=(await f.request('/api/purchases/'+first.id)).data;assert.equal(first.supplier_invoice_no,'INV-77');assert.equal(detail.date,'2026-01-05');assert.equal(detail.invoice_time,'09:35');assert.equal((await f.request('/api/stock/moves')).data[0].date,'2026-01-05');assert.equal(detail.subtotal,200);assert.equal(detail.discount,10);assert.equal(detail.net,190);
 const before=(await f.request('/api/journal')).data.length;
 assert.equal((await f.request('/api/purchases','POST',payload)).status,400);assert.equal((await f.request('/api/journal')).data.length,before);assert.equal((await f.request('/api/products')).data[0].stock,2);
 await created(f,'/api/purchases',{...payload,supplier_invoice_no:'INV-78'});await created(f,'/api/purchases',{...payload,partner_id:b.id});
 assert.equal((await f.request('/api/products')).data[0].stock,6);assert.equal((await f.request('/api/partners/statement?id='+a.id)).data.at(-1).balance,-180);
 const headers={'Idempotency-Key':'purchase-retry'},auto={partner_id:a.id,paid:0,lines:[{product_id:'BUY',qty:1,cost:100}]};
 const once=await f.request('/api/purchases','POST',auto,headers),retry=await f.request('/api/purchases','POST',auto,headers);assert.equal(once.status,201);assert.equal(retry.status,200);assert.equal(once.data.id,retry.data.id);
 const next=await created(f,'/api/purchases',auto);assert.notEqual(next.supplier_invoice_no,once.data.supplier_invoice_no);
 for(const patch of [{date:'2026-02-30'},{time:'25:00'},{paid:9999},{discount:9999}])assert.equal((await f.request('/api/purchases','POST',{...auto,...patch})).status,400);
 const period=await created(f,'/api/periods',{name:'مغلقة',start:'2026-01-01',end:'2026-01-31'});await f.request('/api/periods/'+period.id+'/close','POST',{});assert.equal((await f.request('/api/purchases','POST',{...payload,supplier_invoice_no:'BLOCK'})).status,400);
 const report=(await f.request('/api/reports/financial')).data;assert.equal(report.debit,report.credit);const stock=(await f.request('/api/stock/balances')).data[0];assert.equal(stock.stock,8);assert.equal(stock.value,770);
 }finally{await f.cleanup()}
});

test('Purchases: preliminary invoices edit without posting, then approve exactly once',async()=>{
 const f=await fixture();try{await f.login();await created(f,'/api/products',{id:'DRAFTBUY',name:'مادة أولية',price:10,cost:0});
 const v={status:'draft',supplier_invoice_no:'DRAFT-1',partner_id:'p1',paid:0,lines:[{product_id:'DRAFTBUY',qty:2,cost:50}]},draft=await created(f,'/api/purchases',v);
 assert.equal(draft.status,'draft');assert.equal((await f.request('/api/purchases')).data.length,0);assert.equal((await f.request('/api/journal')).data.length,0);assert.equal((await f.request('/api/products')).data[0].stock,0);assert.equal((await f.request('/api/partners/statement?id=p1')).data.length,0);
 const edited=await created(f,'/api/purchases',{...v,draft_id:draft.draft_id,expected_revision:1,lines:[{product_id:'DRAFTBUY',qty:3,cost:50}]});assert.equal(edited.revision,2);
 assert.equal((await f.request('/api/purchases','POST',{...v,draft_id:draft.draft_id,expected_revision:1})).status,400);
 await f.stop();await f.start();await f.login();const saved=(await f.request('/api/purchases/drafts')).data[0];assert.equal(saved.payload.lines[0].qty,3);
 const approved=await created(f,'/api/purchases',{...saved.payload,status:'posted',draft_id:saved.id,expected_revision:saved.revision});assert.equal(approved.net,150);assert.equal((await f.request('/api/products')).data[0].stock,3);assert.equal((await f.request('/api/journal')).data.length,1);assert.equal((await f.request('/api/purchases/drafts')).data.length,0);
 assert.equal((await f.request('/api/purchases','POST',{...saved.payload,status:'posted',draft_id:saved.id,expected_revision:saved.revision})).status,400);assert.equal((await f.request('/api/journal')).data.length,1);
 }finally{await f.cleanup()}
});

test('Suppliers: detail, filtered opening/closing, draft exclusion, exports and permission checks',async()=>{
 const f=await fixture();try{await f.login();const supplier=await created(f,'/api/partners',{name:'مورد كشف <آمن>',type:'supplier'}),other=await created(f,'/api/partners',{name:'آخر',type:'supplier'});await created(f,'/api/products',{id:'SUPREP',name:'مادة الكشف',price:150,cost:0});
 await created(f,'/api/purchases',{partner_id:supplier.id,supplier_invoice_no:'ONE',date:'2026-01-01',paid:40,lines:[{product_id:'SUPREP',qty:2,cost:50}]});
 await created(f,'/api/purchases',{partner_id:supplier.id,supplier_invoice_no:'TWO',date:'2026-02-01',paid:0,lines:[{product_id:'SUPREP',qty:1,cost:50}]});
 await created(f,'/api/purchases',{partner_id:supplier.id,status:'draft',supplier_invoice_no:'DRAFT',date:'2026-02-01',lines:[{product_id:'SUPREP',qty:10,cost:50}]});
 await created(f,'/api/purchases',{partner_id:other.id,lines:[{product_id:'SUPREP',qty:1,cost:999}]});
 const base='/api/partners/supplier-report?id='+supplier.id,all=(await f.request(base)).data;assert.equal(all.closing,110);assert.equal(all.debit,40);assert.equal(all.credit,150);assert.equal(all.invoices.length,2);assert.equal(all.drafts.length,1);assert.equal(all.invoices[0].lines[0].product_name,'مادة الكشف');
 const filtered=(await f.request(base+'&from=2026-02-01&to=2026-02-28')).data;assert.equal(filtered.opening,60);assert.equal(filtered.closing,110);assert.equal(filtered.rows.length,1);assert.equal(filtered.invoices.length,1);assert.equal(filtered.drafts.length,1);
 const empty=(await f.request(base+'&from=2026-03-01&to=2026-03-31')).data;assert.equal(empty.opening,110);assert.equal(empty.closing,110);assert.equal(empty.rows.length,0);
 assert.equal((await f.request(base+'&from=2026-02-30')).status,400);assert.equal((await f.request(base+'&from=2026-03-01&to=2026-01-01')).status,400);
 const excel=await f.request(base+'&format=xlsx');assert.equal(excel.status,200);assert.equal(excel.data.readUInt32LE(0),0x04034b50);assert.ok(excel.data.includes(Buffer.from('xl/worksheets/sheet1.xml')));
 const html=await f.request(base+'&format=print');assert.ok(html.data.toString().includes('مورد كشف &lt;آمن&gt;'));assert.ok(!html.data.toString().includes('<آمن>'));
 await created(f,'/api/users',{username:'noreport',password:'password123',role:'cashier',modules:['sales']});await f.request('/api/auth/logout','POST',{});await f.login('noreport','password123');assert.equal((await f.request(base)).status,403);assert.equal((await f.request(base+'&format=xlsx')).status,403);
 }finally{await f.cleanup()}
});
