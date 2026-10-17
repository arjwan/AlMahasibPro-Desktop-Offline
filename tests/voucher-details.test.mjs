import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {startServer} from './helpers/server.mjs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const helpers=html.slice(html.indexOf('function arabicVoucherInteger('),html.indexOf("$('posReprint').onclick="));
const c=vm.createContext({});vm.runInContext(helpers,c);
test('Arabic voucher words retain integer amounts and exact USD cents',()=>{
 assert.equal(c.arabicVoucherInteger(0),'صفر');assert.equal(c.arabicVoucherInteger(125000),'مائة و خمسة و عشرون ألف');
 assert.equal(c.arabicVoucherInteger(987400000),'تسعمائة و سبعة و ثمانون مليون و أربعمائة ألف');
 assert.ok(c.voucherPreviewWords('25.50','USD').includes('خمسة و عشرون دولار أمريكي و خمسون سنت'));
 assert.ok(c.voucherPreviewWords('1.005','USD').includes('بدقتين'));assert.equal(c.arabicVoucherAmount(-1),'المبلغ غير صحيح');
});
test('Voucher print includes stored metadata and does not invent names or times for legacy vouchers',()=>{
 const base={id:5,kind:'receipt',amount:125000,party_name:'علي <اسم>',company_name:'معرض الأرجوان',cashier_name:'أمين سابق',created_at:'2026-10-17T12:00:00Z',exchange_rate:'1350',description:'تسديد دفعة'};
 const out=c.voucherPrintHTML(base);
 for(const s of ['CV-000005','علي &lt;اسم&gt;','معرض الأرجوان','أمين سابق','125,000','سعر الصرف وقت السند','التفاصيل / البيان','مائة و خمسة و عشرون ألف'])assert.ok(out.includes(s),s);
 assert.ok(!out.includes('علي <اسم>'));assert.ok(c.voucherPrintHTML({id:1,kind:'payment',amount:100,date:'2020-01-01'}).includes('غير مسجل في السند القديم'));
 const usd=c.voucherPrintHTML({...base,foreign_amount:125,base_amount:1750,rate:'1400'},'USD');assert.ok(usd.includes('FX-000005'));assert.ok(usd.includes('1.25 USD'));assert.ok(usd.includes('1,750'));
});
test('Cash and FX vouchers snapshot authenticated cashier, party, company, timestamp and rate without changing ledger balance',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'voucher-meta-')),dbPath=join(dir,'company.sqlite');let server=await startServer(dbPath),cookie='';
 const api=async(route,method='GET',body)=>{const r=await fetch(server.base+route,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data};
 try{
 await api('/api/auth/login','POST',{username:'admin',password:'admin123'});
 await api('/api/currency/rate','POST',{rate:'1350'});
 await api('/api/cash/vouchers','POST',{kind:'receipt',cash_account:'101',counterpart:'3',amount:1000,party_name:'علي',company_name:'معرض الأرجوان',cashier_name:'FORGED',description:'دفعة تجريبية'});
 const first=(await api('/api/cash/vouchers'))[0];assert.equal(first.cashier_name,'Administrator');assert.equal(first.party_name,'علي');assert.equal(first.company_name,'معرض الأرجوان');assert.equal(first.exchange_rate,'1350');assert.ok(Number.isFinite(Date.parse(first.created_at)));
 await api('/api/currency/rate','POST',{rate:'1400'});assert.equal((await api('/api/cash/vouchers'))[0].exchange_rate,'1350');
 const supplier=await api('/api/partners','POST',{name:'مورد محفوظ',type:'supplier'});
 await api('/api/currency/vouchers','POST',{kind:'receipt',account_id:'107',counterpart:'201',partner_id:supplier.id,party_name:'WRONG',company_name:'شركة الاختبار',amount:'1.25',rate:'1400',description:'قبض دولار'});
 const fx=(await api('/api/currency/vouchers'))[0];assert.equal(fx.party_name,'مورد محفوظ');assert.equal(fx.cashier_name,'Administrator');assert.equal(fx.foreign_amount,125);assert.equal(fx.base_amount,1750);assert.equal(fx.rate,'1400');assert.ok(fx.created_at);
 const report=await api('/api/reports/financial');assert.equal(report.debit,report.credit);
 await server.stop();
 const db=new DatabaseSync(dbPath);for(const name of ['party_name','company_name','cashier_name','created_at','exchange_rate'])db.exec('ALTER TABLE cash_vouchers DROP COLUMN '+name);db.close();
 server=await startServer(dbPath);cookie='';await api('/api/auth/login','POST',{username:'admin',password:'admin123'});
 const legacy=(await api('/api/cash/vouchers'))[0];assert.equal(legacy.amount,1000);assert.equal(legacy.cashier_name,null);assert.equal(legacy.created_at,null);
 }finally{await server.stop();rmSync(dir,{recursive:true,force:true})}
});

test('New cash boxes retain independent balances and permit receipt and payment vouchers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cash-boxes-')),server=await startServer(join(dir,'company.sqlite'));let cookie='';
 async function api(path,method='GET',body,expected=200){const r=await fetch(server.base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;}
 try{
 await api('/api/auth/login','POST',{username:'admin',password:'admin123'});
 const before=(await api('/api/accounts')).find(x=>x.id==='101');
 const box=await api('/api/cash/boxes','POST',{name:'صندوق المبيعات الثاني'},201);
 assert.equal((await api('/api/cash/boxes','POST',{name:'صندوق المبيعات الثاني'},201)).id,box.id);
 await api('/api/cash/boxes','POST',{name:''},400);
 await api('/api/cash/vouchers','POST',{kind:'receipt',cash_account:box.id,counterpart:'3',amount:1000,party_name:'علي'},201);
 await api('/api/cash/vouchers','POST',{kind:'payment',cash_account:box.id,counterpart:'3',amount:250,party_name:'علي'},201);
 const accounts=await api('/api/accounts'),current=accounts.find(x=>x.id===box.id);
 assert.equal(current.parent_id,'101');assert.equal(current.debit-current.credit,750);
 const main=accounts.find(x=>x.id==='101');assert.equal(main.debit-main.credit,before.debit-before.credit);
 const rows=await api('/api/cash/vouchers');assert.equal(rows.filter(x=>x.cash_account===box.id).length,2);assert.equal(rows[0].cash_name,'صندوق المبيعات الثاني');
 const report=await api('/api/reports/financial');assert.equal(report.debit,report.credit);
 }finally{await server.stop();rmSync(dir,{recursive:true,force:true});}
});

test('Save-and-print uses the saved voucher and keeps both actions disabled until complete',async()=>{
 const fields=Object.fromEntries(['voucher','voucherprintnow','vouchername','vouchercompany','kind','cash','counterpart','voucheramount','voucherdesc'].map(k=>['ws-'+k,{value:({vouchername:'علي',kind:'receipt',cash:'101',counterpart:'3',voucheramount:'500'})[k]||'',disabled:false}]));
 const printed=[],posts=[],alerts=[];let closed=false,organized=false;
 const popup={document:{body:{textContent:''},open(){},write(s){printed.push(s)},close(){}},close(){closed=true}};
 const context=vm.createContext({document:{getElementById:id=>fields[id]},window:{open:()=>popup},page:'banks',Number,Error,alert:s=>alerts.push(s),voucherPrintHTML:v=>'PRINT-'+v.id,organizeWorkspaceSections:()=>{organized=true},show:async()=>{},apiRequest:async(path,method,body)=>{if(method==='POST'){assert.equal(fields['ws-voucher'].disabled,true);assert.equal(fields['ws-voucherprintnow'].disabled,true);posts.push(body);return {id:42}}return [{id:42}]}});
 const begin=html.indexOf('async function saveCashVoucher('),end=html.indexOf("document.getElementById('ws-voucher').onclick=()=>",begin);
 vm.runInContext(html.slice(begin,end),context);await context.saveCashVoucher(true);
 assert.deepEqual(printed,['PRINT-42']);assert.equal(posts.length,1);assert.equal(organized,true);assert.equal(alerts.length,0);assert.equal(closed,false);assert.equal(fields['ws-voucher'].disabled,false);
});
