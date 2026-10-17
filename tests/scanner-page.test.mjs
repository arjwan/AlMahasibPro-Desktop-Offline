import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../market-scanner.html',import.meta.url),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function page(fetch){
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:true,className:'',textContent:''});return elements.get(id)};
 const context=vm.createContext({document:{getElementById:get},location:{hash:''},localStorage:{getItem:()=>'',setItem(){}},window:{addEventListener(){}},setInterval(){},clearInterval(){},crypto:globalThis.crypto,navigator:{},AbortSignal,fetch});
 vm.runInContext(source,context);return {get,run:code=>vm.runInContext(code,context)};
}
const response=(status,body)=>({ok:status<400,status,json:async()=>body});
test('Phone page resolves a six digit code once before concurrent sends and connection requests',async()=>{
 const token='a'.repeat(32),calls=[];
 const p=page(async(url,options)=>{calls.push([url,options]);await Promise.resolve();return response(200,url.endsWith('/resolve')?{token}:{ok:true})});
 p.get('token').value='012345';
 const result=await p.run("Promise.all([connection(),send('123456789'),connection()])");assert.equal(result[1],true);
 assert.equal(calls.filter(([url])=>url.endsWith('/resolve')).length,1);
 assert.ok(calls.some(([url])=>url==='/api/v1/market/scanner/'+token+'/scan'));
});
test('Phone heartbeat does not consume short code attempts and retries retain scan identity',async()=>{
 let fail=true;const sends=[];
 const p=page(async(url,options)=>{if(url.endsWith('/scan')){sends.push(JSON.parse(options.body));if(fail)throw Error('network');}return response(200,{ok:true})});
 p.get('token').value='123456';await p.run('heartbeat()');assert.equal(sends.length,0);
 p.get('token').value='b'.repeat(32);
 assert.equal(await p.run("send('111')"),false);
 assert.equal(await p.run("send('222')"),false);assert.equal(sends.length,1);
 fail=false;assert.equal(await p.run("send('111')"),true);assert.deepEqual(sends[0],sends[1]);
});
