import {startServer,stopChild} from './helpers/server.mjs';
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

test('Stock: preliminary documents, revision, atomic approval, shared carton units, card and current-price labels',async()=>{
 const f=await fixture();try{await f.login();await created(f,'/api/products',{id:'S',name:'صنف',cost:10,price:25});
 await created(f,'/api/stock/barcodes',{product_id:'S',code:'CARTON',unit:'كرتون',factor:12});
 assert.equal((await f.request('/api/stock/barcodes','POST',{product_id:'S',code:'S',factor:12})).status,400);
 let d=await created(f,'/api/stock/documents',{kind:'in',warehouse_id:1,reason:'افتتاح',lines:[{code:'CARTON',qty:2,lot:'B1',expiry:'2099-12-31'}]});
 assert.equal(d.payload.lines[0].qty,24);assert.equal((await f.request('/api/products')).data[0].stock,0);assert.equal((await f.request('/api/journal')).data.length,0);
 d=await created(f,'/api/stock/documents',{...d.payload,id:d.id,expected_revision:d.revision,reason:'تعديل'});
 assert.equal((await f.request('/api/stock/documents/'+d.id+'/post','POST',{expected_revision:1})).status,400);
 assert.equal((await f.request('/api/stock/documents/'+d.id+'/post','POST',{expected_revision:2})).status,200);
 assert.equal((await f.request('/api/stock/documents/'+d.id+'/post','POST',{expected_revision:2})).status,400);
 assert.equal((await f.request('/api/products')).data[0].stock,24);
 await created(f,'/api/stock/documents',{kind:'out',status:'posted',warehouse_id:1,reason:'صرف',lines:[{code:'CARTON',qty:1}]});
 assert.equal((await f.request('/api/products')).data[0].stock,12);
 const card=(await f.request('/api/stock/card?product_id=S')).data;assert.equal(card.at(-1).balance,12);assert.equal(card.length,2);
 assert.equal((await f.request('/api/stock/label?code=CARTON')).data.price,300);
 assert.equal((await f.request('/api/stock/product','POST',{product_id:'S',price:30,category:'ملابس',color:'أحمر',size:'L'})).status,200);
 assert.equal((await f.request('/api/stock/label?code=CARTON')).data.price,360);
 await f.request('/api/stock/label-templates','POST',{name:'صغير',width:50,height:30,font:12});assert.equal((await f.request('/api/stock/label-templates')).data.length,1);
 const before=(await f.request('/api/products')).data[0].stock;
 assert.equal((await f.request('/api/stock/documents','POST',{kind:'out',status:'posted',warehouse_id:1,reason:'فشل ذري',lines:[{product_id:'S',qty:1},{product_id:'S',qty:100}]})).status,400);
 assert.equal((await f.request('/api/products')).data[0].stock,before);assert.equal((await f.request('/api/stock/batches')).data[0].qty,before);
 const report=(await f.request('/api/reports/financial')).data;assert.equal(report.debit,report.credit);
 await f.stop();await f.start();await f.login();assert.equal((await f.request('/api/stock/batches')).data[0].qty,12);
 // A legacy opening balance may precede all recorded movements.
 await f.stop();const legacy=new DatabaseSync(f.dbPath);legacy.prepare("UPDATE product_warehouse SET stock=stock+7 WHERE product_id='S'").run();legacy.prepare("UPDATE stock_batches SET qty=qty+7 WHERE product_id='S' AND lot='B1'").run();legacy.close();await f.start();await f.login();const legacyCard=(await f.request('/api/stock/card?product_id=S')).data;assert.equal(legacyCard[0].type,'opening');assert.equal(legacyCard[0].balance,7);assert.equal(legacyCard.at(-1).balance,19);
 }finally{await f.cleanup()}
});

test('Stock: expired batches cannot be dispatched by documents, sales or legacy adjustments; transfer preserves expiry',async()=>{
 const f=await fixture();try{await f.login();await created(f,'/api/products',{id:'E',name:'صلاحية',cost:10,price:30});
 const doc=lines=>({kind:'in',warehouse_id:1,reason:'استلام',status:'posted',lines});
 await created(f,'/api/stock/documents',doc([{product_id:'E',qty:3,lot:'OLD',expiry:'2000-01-01'},{product_id:'E',qty:2,lot:'NEW',expiry:'2099-01-01'}]));
 const expired=await f.request('/api/stock/documents','POST',{kind:'out',warehouse_id:1,reason:'صرف',status:'posted',lines:[{product_id:'E',qty:3}]});assert.equal(expired.status,400);
 assert.equal((await f.request('/api/invoices','POST',{lines:[{id:'E',qty:3}]})).status,400);
 assert.equal((await f.request('/api/stock/adjust','POST',{product_id:'E',delta:-3})).status,400);
 const w=await created(f,'/api/warehouses',{name:'ثان'});await created(f,'/api/stock/transfer',{product_id:'E',from:1,to:w.id,qty:1});
 const moved=(await f.request('/api/stock/batches')).data.find(b=>b.warehouse_id===w.id);assert.equal(moved.expiry,'2099-01-01');assert.equal(moved.lot,'NEW');
 await created(f,'/api/stock/documents',{kind:'out',warehouse_id:1,reason:'صرف الصالح',status:'posted',lines:[{product_id:'E',qty:1}]});
 const batches=(await f.request('/api/stock/batches')).data;assert.equal(batches.find(b=>b.lot==='OLD').qty,3);
 assert.equal((await f.request('/api/stock/documents','POST',{kind:'return-in',warehouse_id:1,reason:'مرتجع',lines:[{product_id:'E',qty:1}]})).status,400);
 await created(f,'/api/stock/documents',{kind:'return-in',warehouse_id:1,reason:'مرتجع',reference:'EXT-3',status:'posted',lines:[{product_id:'E',qty:1,lot:'OLD',expiry:'2000-01-01'}]});
 assert.equal((await f.request('/api/stock/adjust','POST',{product_id:'E',delta:-1})).status,400);
 }finally{await f.cleanup()}
});

test('Stock: assembly and disassembly conserve carrying value, component stock and earliest expiry',async()=>{
 const f=await fixture();try{await f.login();for(const [id,cost] of [['A',10],['B',21],['SET',0]])await created(f,'/api/products',{id,name:id,cost,price:100});
 await created(f,'/api/stock/documents',{kind:'in',warehouse_id:1,reason:'مكونات',status:'posted',lines:[{product_id:'A',qty:6,expiry:'2090-01-01'},{product_id:'B',qty:3,expiry:'2091-01-01'}]});
 assert.equal((await f.request('/api/stock/recipe','POST',{product_id:'SET',components:[{product_id:'A',qty:2},{product_id:'B',qty:1}]})).status,200);
 const before=(await f.request('/api/products')).data.reduce((s,p)=>s+p.book_value,0);
 await created(f,'/api/stock/documents',{kind:'assemble',warehouse_id:1,reason:'تجميع',status:'posted',lines:[{product_id:'SET',qty:2}]});
 let p=(await f.request('/api/products')).data;assert.equal(p.find(p=>p.id==='A').stock,2);assert.equal(p.find(p=>p.id==='B').stock,1);assert.equal(p.find(p=>p.id==='SET').stock,2);assert.equal(p.reduce((s,p)=>s+p.book_value,0),before);
 assert.equal((await f.request('/api/stock/batches')).data.find(b=>b.product_id==='SET').expiry,'2090-01-01');
 assert.equal((await f.request('/api/stock/recipe','POST',{product_id:'SET',components:[{product_id:'A',qty:1}]})).status,400);
 await created(f,'/api/stock/documents',{kind:'disassemble',warehouse_id:1,reason:'فك',status:'posted',lines:[{product_id:'SET',qty:2}]});
 p=(await f.request('/api/products')).data;assert.equal(p.find(p=>p.id==='A').stock,6);assert.equal(p.find(p=>p.id==='B').stock,3);assert.equal(p.find(p=>p.id==='SET').stock,0);assert.equal(p.reduce((s,p)=>s+p.book_value,0),before);
 }finally{await f.cleanup()}
});

test('Stock: sale returns restore original lot and expiry even when returned after expiration',async()=>{
 const f=await fixture();try{await f.login();await created(f,'/api/products',{id:'R',name:'مرتجع صلاحية',cost:10,price:25});
 await created(f,'/api/stock/documents',{kind:'in',status:'posted',reason:'استلام',warehouse_id:1,lines:[{product_id:'R',qty:1,lot:'RETURN-LOT',expiry:'2099-12-31'}]});
 const sale=await created(f,'/api/invoices',{lines:[{id:'R',qty:1}]}),invoice=(await f.request('/api/invoices/'+sale.id)).data;
 const db=new DatabaseSync(f.dbPath);db.prepare("UPDATE stock_batches SET expiry='2000-01-01' WHERE product_id='R'").run();db.close();
 await created(f,'/api/returns',{kind:'sale',invoice_id:sale.id,cash_refund:25,reason:'مرتجع بعد الصلاحية',lines:[{item_id:invoice.lines[0].id,qty:1}]});
 const batch=(await f.request('/api/stock/batches')).data[0];assert.equal(batch.lot,'RETURN-LOT');assert.equal(batch.expiry,'2000-01-01');
 assert.equal((await f.request('/api/invoices','POST',{lines:[{id:'R',qty:1}]})).status,400);
 await created(f,'/api/products',{id:'SR',name:'مرتجع مستند',cost:10,price:25});await created(f,'/api/stock/documents',{kind:'in',status:'posted',reason:'استلام',warehouse_id:1,lines:[{product_id:'SR',qty:1,lot:'ORIGINAL',expiry:'2099-01-01'}]});
 const out=await created(f,'/api/stock/documents',{kind:'out',status:'posted',reason:'صرف',warehouse_id:1,lines:[{product_id:'SR',qty:1}]});
 const external=new DatabaseSync(f.dbPath);external.prepare("UPDATE stock_batches SET expiry='2000-01-01' WHERE product_id='SR'").run();external.close();
 const payload={kind:'return-in',status:'posted',reason:'مرتجع',reference:'STK-'+out.id,warehouse_id:1,lines:[{product_id:'SR',qty:1,expiry:'2099-01-01'}]};
 await created(f,'/api/stock/documents',payload);assert.equal((await f.request('/api/stock/batches')).data.find(b=>b.product_id==='SR').expiry,'2000-01-01');assert.equal((await f.request('/api/stock/documents','POST',payload)).status,400);
 }finally{await f.cleanup()}
});
