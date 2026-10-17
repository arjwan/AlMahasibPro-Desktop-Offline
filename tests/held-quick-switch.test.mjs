import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import crypto from 'node:crypto';
import {startServer} from './helpers/server.mjs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('async function parkCurrentInvoice()'),html.indexOf('async function refreshHeldRail()'));
test('Held invoice switches with one click, parks current invoice, preserves prices and rejects save failures without losing the cart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'held-quick-')),server=await startServer(join(dir,'company.sqlite'));let cookie='';
 async function request(route,method='GET',body){const r=await fetch(server.base+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
 try{
 await request('/api/auth/login','POST',{username:'admin',password:'admin123'});
 const supplier=await request('/api/partners','POST',{name:'Held test supplier',type:'supplier'});
 await request('/api/products','POST',{id:'QUICK',name:'Quick item',barcode:'12345678',price:250,cost:100});
 await request('/api/purchases','POST',{partner_id:supplier.id,paid:10000,lines:[{product_id:'QUICK',qty:100,cost:100}]});
 const held=await request('/api/invoices','POST',{status:'held',source:'pos',discount:5,lines:[{id:'QUICK',qty:2}]});
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{value:id==='payment'?'نقدي':'',disabled:false,focus(){},textContent:''});return elements.get(id)};
 const storage=new Map();let fail=false,posts=0;
 const context=vm.createContext({$:get,window:{almaRequestId:()=>crypto.randomUUID()},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},percentInput:{reportValidity:()=>true,setCustomValidity(){},value:''},toolsMenu:{hidePopover(){}},api:route=>request(route),fetch:async(route,opts)=>{posts++;if(fail)throw Error('offline');return fetch(server.base+route,{...opts,headers:{...opts.headers,Cookie:cookie}})},fresh(){vm.runInContext("cart=[];posDraftId=null;posDraftNumber='';",context)},refreshLive:async()=>{},notice:message=>get('message').textContent=message,render(){},updatePOSPaymentFields(){},confirm(){throw Error('Confirmation must not be shown')}});
 vm.runInContext("let cart=[{id:'QUICK',qty:3,price:250}],products=[{id:'QUICK',name:'Quick item',price:999}],posDraftId=null,posDraftNumber='',posDraftWarehouse=1,posDiscountRate=null,posHeldBusy=false;"+source,context);
 await context.openHeldInvoice(held.id);
 assert.equal(vm.runInContext('posDraftId',context),held.id);assert.equal(vm.runInContext('cart[0].qty',context),2);assert.equal(vm.runInContext('cart[0].price',context),250);
 const parked=(await request('/api/held')).find(x=>x.id!==held.id);assert.ok(parked);assert.equal((await request('/api/invoices/'+parked.id)).lines[0].qty,3);
 const before=posts;await context.openHeldInvoice(held.id);assert.equal(posts,before);
 vm.runInContext('cart[0].qty=4',context);await context.openHeldInvoice(parked.id);assert.equal(vm.runInContext('cart[0].qty',context),3);assert.equal((await request('/api/invoices/'+held.id)).lines[0].qty,4);
 fail=true;await context.openHeldInvoice(held.id);assert.equal(vm.runInContext('posDraftId',context),parked.id);assert.equal(vm.runInContext('cart[0].qty',context),3);assert.equal(get('message').textContent,'offline');assert.equal(vm.runInContext('posHeldBusy',context),false);
 fail=false;await get('hold').onclick();assert.equal(vm.runInContext('cart.length',context),0);assert.equal((await request('/api/held')).length,2);
 }finally{await server.stop();rmSync(dir,{recursive:true,force:true})}
});
