import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from './helpers/server.mjs';

test('Installed v6 database without inventory type preserves history and posts purchases and sales after repair',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'alma-legacy-inventory-')),file=join(dir,'company.sqlite');let server,db,cookie='';
 async function request(route,method='GET',body,key){
  const r=await fetch(server.base+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const cookies=r.headers.getSetCookie();if(cookies.length){const jar=new Map(cookie.split('; ').filter(Boolean).map(x=>[x.split('=')[0],x]));for(const c of cookies){const pair=c.split(';')[0];jar.set(pair.split('=')[0],pair)}cookie=[...jar.values()].join('; ')}
  return {status:r.status,data:await r.json()};
 }
 async function login(){assert.equal((await request('/api/auth/login','POST',{username:'admin',password:'admin123'})).status,200)}
 async function created(route,body,key){const r=await request(route,'POST',body,key);assert.equal(r.status,201,JSON.stringify(r.data));return r.data}
 try{
  server=await startServer(file);await login();await created('/api/products',{id:'LEGACY',name:'مادة محفوظة قبل الترقية',barcode:'0012345678905',price:1000,cost:500});await created('/api/stock/adjust',{product_id:'LEGACY',delta:10});const supplier=await created('/api/partners',{name:'مورد محفوظ',type:'supplier'});await server.stop();
  // Reproduce the reported installed schema even though it already advertises v6.
  db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;ALTER TABLE inventory_moves DROP COLUMN type;ALTER TABLE products DROP COLUMN archived;PRAGMA user_version=6;');
  const movesBefore=db.prepare('SELECT * FROM inventory_moves ORDER BY id').all(),journalBefore=db.prepare('SELECT * FROM journal_items ORDER BY id').all(),stockBefore=db.prepare('SELECT * FROM product_warehouse ORDER BY product_id').all();
  const backupsBefore=new Set(readdirSync(dir).filter(x=>x.includes('.schema-backup-')));
  server=await startServer(file);await login();
  const payload={payment:'نقدي',lines:[{id:'LEGACY',qty:2}]};const sale=await created('/api/invoices',payload,'legacy-sale-once');assert.equal(sale.net,2000);const retry=await request('/api/invoices','POST',payload,'legacy-sale-once');assert.equal(retry.status,200);assert.equal(retry.data.id,sale.id);
  const backups=readdirSync(dir).filter(x=>x.includes('.schema-backup-')&&!backupsBefore.has(x));assert.equal(backups.length,1,'Repair must back up v6 database before adding missing columns');const backup=new DatabaseSync(join(dir,backups[0]),{readOnly:true});
  try{assert.deepEqual(backup.prepare('SELECT * FROM inventory_moves ORDER BY id').all(),movesBefore);assert.deepEqual(backup.prepare('SELECT * FROM journal_items ORDER BY id').all(),journalBefore);assert.deepEqual(backup.prepare('SELECT * FROM product_warehouse ORDER BY product_id').all(),stockBefore);assert.ok(!backup.prepare('PRAGMA table_info(inventory_moves)').all().some(x=>x.name==='type'))}finally{backup.close()}
  assert.deepEqual(db.prepare('SELECT id,product_id,warehouse_id,delta,reference,date,created_at FROM inventory_moves WHERE id=?').get(movesBefore[0].id),movesBefore[0]);assert.equal(db.prepare('SELECT type FROM inventory_moves WHERE id=?').get(movesBefore[0].id).type,null,'Unknown historical movement types must not be fabricated');
  assert.deepEqual(db.prepare('SELECT * FROM journal_items WHERE id<=? ORDER BY id').all(journalBefore.at(-1).id),journalBefore);
  await created('/api/purchases',{partner_id:supplier.id,warehouse_id:1,paid:1500,lines:[{product_id:'LEGACY',qty:3,cost:500}]},'legacy-purchase-once');
  assert.equal((await request('/api/products')).data.find(x=>x.id==='LEGACY').stock,11);const report=(await request('/api/reports/financial')).data;assert.equal(report.debit,report.credit);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_moves WHERE type='sale'").get().n,1);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_moves WHERE type='purchase'").get().n,1);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  const inventory=db.prepare('SELECT * FROM inventory_moves ORDER BY id').all(),journal=db.prepare('SELECT * FROM journal_items ORDER BY id').all();await server.stop();server=await startServer(file);await login();assert.equal(readdirSync(dir).filter(x=>x.includes('.schema-backup-')&&!backupsBefore.has(x)).length,1);assert.deepEqual(db.prepare('SELECT * FROM inventory_moves ORDER BY id').all(),inventory);assert.deepEqual(db.prepare('SELECT * FROM journal_items ORDER BY id').all(),journal);assert.equal((await request('/api/stock/card?product_id=LEGACY')).status,200);
 }finally{await server?.stop();db?.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
});
