import {startServer,stopChild} from './helpers/server.mjs';
import crypto from 'node:crypto';
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
 async function start(){const server=await startServer(dbPath);child=server.child;base=server.base;}
 async function stop(){await stopChild(child)}
 async function request(path,method='GET',body,headers={}){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...headers},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.getSetCookie().length){const jar=new Map(cookie.split('; ').filter(Boolean).map(x=>[x.split('=')[0],x]));for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0];jar.set(pair.split('=')[0],pair)}cookie=[...jar.values()].join('; ')}const data=r.headers.get('content-type')?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer());return {status:r.status,data}}
 async function login(username='admin',password='admin123'){const r=await request('/api/auth/login','POST',{username,password});assert.equal(r.status,200,JSON.stringify(r.data));return r}
 await start();return {request,login,start,stop,dbPath,dir,base:()=>base,cleanup:async()=>{await stop();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200})}};
}
async function created(f,path,body){const r=await f.request(path,'POST',body);assert.equal(r.status,201,JSON.stringify(r.data));return r.data}

test('POS atomic mixed payment, retry, rejection rollback, debt collection and returns',async()=>{
 const f=await fixture();try{
 await f.login();await created(f,'/api/products',{id:'PAY',name:'Payment test',price:200,cost:100});
 await created(f,'/api/stock/adjust',{product_id:'PAY',delta:20});
 const customer=await created(f,'/api/partners',{name:'Payment customer',type:'customer'});
 const payload={partner_id:customer.id,lines:[{id:'PAY',qty:2}],payments:[{method:'cash',amount:100},{method:'card',provider:'independent_pos',reference:'TERMINAL-1',amount:200}]};
 const make=(body,key)=>f.request('/api/invoices','POST',body,{'Idempotency-Key':key});
 const first=await make(payload,'checkout-1');assert.equal(first.status,201,JSON.stringify(first.data));
 const retry=await make(payload,'checkout-1');assert.deepEqual(retry.data,first.data);
 assert.equal((await make({...payload,discount:1},'checkout-1')).status,400);
 const invoice=(await f.request('/api/invoices/'+first.data.id)).data;assert.equal(invoice.paid,300);assert.equal(invoice.remaining,100);assert.equal(invoice.payment_status,'partial');
 assert.equal((await f.request('/api/products')).data[0].stock,18);
 let db=new DatabaseSync(f.dbPath);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_transactions').get().n,2);assert.equal(db.prepare("SELECT SUM(debit-credit) AS n FROM journal_items WHERE account_id='pos-card-clearing'").get().n,200);db.close();
 for(const payments of [payload.payments,[{method:'cash',amount:401}],[{method:'card',amount:400,provider:'fake',reference:'FAKE'}],[{method:'cash',amount:1.5}]]){const r=await make({...payload,payments},crypto.randomUUID());assert.equal(r.status,400,JSON.stringify(r.data));}
 assert.equal((await f.request('/api/invoices')).data.length,1);assert.equal((await f.request('/api/products')).data[0].stock,18);
 const pay={invoice_id:invoice.id,method:'cash',amount:100,idempotency_key:'pay-debt'};
 assert.equal((await f.request('/api/payments','POST',pay)).status,201);
 assert.equal((await f.request('/api/payments','POST',pay)).status,201);
 assert.equal((await f.request('/api/payments','POST',{...pay,amount:99})).status,400);
 assert.equal((await f.request('/api/payments','POST',{...pay,idempotency_key:'over'})).status,400);
 const paymentsJournal=(await f.request('/api/journal')).data.filter(x=>x.reference?.startsWith('PAY-'));
 assert.ok(paymentsJournal.length>=3);
 for(const entry of paymentsJournal){assert.equal((await f.request('/api/journal/'+entry.id+'/reverse','POST',{})).status,400);assert.equal((await f.request('/api/journal','POST',{description:'Reserved',reference:entry.reference,lines:[{account_id:'101',debit:1},{account_id:'3',credit:1}]})).status,400)}
 assert.equal((await f.request('/api/invoices/'+invoice.id)).data.paid,400);
 const adjustment={product_id:'PAY',delta:1};
 assert.equal((await f.request('/api/stock/adjust','POST',adjustment,{'Idempotency-Key':'adjust-once'})).status,201);
 assert.deepEqual((await f.request('/api/stock/adjust','POST',adjustment,{'Idempotency-Key':'adjust-once'})).data,{ok:true});
 assert.equal((await f.request('/api/products')).data[0].stock,19);
 const ret={kind:'sale',invoice_id:invoice.id,cash_refund:200,reason:'Partial card reversal',lines:[{item_id:invoice.lines[0].id,qty:1}]};
 const returned=await f.request('/api/returns','POST',ret,{'Idempotency-Key':'return-1'});assert.equal(returned.status,201,JSON.stringify(returned.data));
 assert.deepEqual((await f.request('/api/returns','POST',ret,{'Idempotency-Key':'return-1'})).data,returned.data);
 db=new DatabaseSync(f.dbPath);assert.equal(db.prepare("SELECT SUM(debit-credit) AS n FROM journal_items WHERE account_id='pos-card-clearing'").get().n,0);assert.equal(db.prepare('SELECT card_refund FROM document_returns').get().card_refund,200);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_invoices').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_transactions').get().n,3);db.close();
 assert.equal((await f.request('/api/products')).data[0].stock,20);
 const report=(await f.request('/api/reports/financial')).data;assert.equal(report.debit,report.credit);assert.equal(report.profit,100);
 const partial=await make({partner_id:customer.id,paid:0,payment:'آجل',lines:[{id:'PAY',qty:1}]},'debt-return');assert.equal(partial.status,201);
 const detail=(await f.request('/api/invoices/'+partial.data.id)).data;
 await created(f,'/api/returns',{kind:'sale',invoice_id:detail.id,cash_refund:0,reason:'Cancel debt',lines:[{item_id:detail.lines[0].id,qty:1}]});
 assert.equal((await f.request('/api/payments','POST',{invoice_id:detail.id,amount:1,method:'cash',idempotency_key:'returned-debt'})).status,400);
 const held=await created(f,'/api/invoices',{status:'held',payment:'بطاقة',lines:[{id:'PAY',qty:1}]});
 assert.equal((await f.request('/api/held/'+held.id+'/complete','POST')).status,400);
 const heldPayment=await f.request('/api/held/'+held.id+'/complete','POST',{reference:'HELD-TERMINAL'},{'Idempotency-Key':'held-card'});assert.equal(heldPayment.status,200,JSON.stringify(heldPayment.data));
 assert.deepEqual((await f.request('/api/held/'+held.id+'/complete','POST',{reference:'HELD-TERMINAL'},{'Idempotency-Key':'held-card'})).data,heldPayment.data);
 assert.equal((await f.request('/api/invoices/'+held.id)).data.payment_status,'paid');
 // A cash-only account can collect, but cannot attest terminal settlements.
 await created(f,'/api/users',{username:'cash-payment',password:'test-password',role:'cashier',modules:['sales']});await f.login('cash-payment','test-password');
 const denied=await make({...payload,payments:[{method:'card',provider:'independent_pos',reference:'UNAUTHORIZED',amount:400}]},'denied-card');assert.equal(denied.status,400);
 const cash=await make({lines:[{id:'PAY',qty:1}],payments:[{method:'cash',amount:200}]},'cashier-cash');assert.equal(cash.status,201,JSON.stringify(cash.data));
 }finally{await f.cleanup()}
});
