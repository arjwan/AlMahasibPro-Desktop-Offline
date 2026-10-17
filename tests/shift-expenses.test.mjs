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

test('Shift expense requires reason, posts once, reduces expected cash and rejects closed shifts',async()=>{
 const f=await fixture();try{
 await f.login();const shift=await created(f,'/api/shifts/open',{user_name:'Cashier',opening:1000});
 const endpoint='/api/shifts/'+shift.id+'/expenses';
 for(const body of [{amount:10,reason:''},{amount:0,reason:'Fuel'},{amount:-1,reason:'Fuel'},{amount:1.5,reason:'Fuel'}])assert.equal((await f.request(endpoint,'POST',body)).status,400);
 const body={amount:200,reason:'Fuel'},headers={'Idempotency-Key':'fuel-once'};
 const first=await f.request(endpoint,'POST',body,headers);assert.equal(first.status,201,JSON.stringify(first.data));assert.deepEqual((await f.request(endpoint,'POST',body,headers)).data,first.data);
 assert.equal((await f.request(endpoint,'POST',{...body,amount:201},headers)).status,400);
 const expenses=(await f.request('/api/shifts/expenses')).data;assert.equal(expenses.length,1);assert.equal(expenses[0].reason,'Fuel');
 assert.equal((await f.request('/api/journal/'+first.data.entry_id+'/reverse','POST',{})).status,400);
 const closed=await f.request('/api/shifts/'+shift.id+'/close','POST',{counted:800});assert.equal(closed.data.expected,800);assert.equal(closed.data.difference,0);
 assert.equal((await f.request(endpoint,'POST',body)).status,400);
 const report=(await f.request('/api/reports/financial')).data;assert.equal(report.debit,report.credit);assert.equal(report.expenses,200);
 }finally{await f.cleanup()}
});
