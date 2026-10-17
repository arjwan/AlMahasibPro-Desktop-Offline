import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from './helpers/server.mjs';

test('cash voucher persists party/words and prevents retry duplicates',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'alma-voucher-'));let server;
 try{
  server=await startServer(join(dir,'company.sqlite'));
  const login=await fetch(server.base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});
  assert.equal(login.status,200,await login.text().catch(()=>'')); 
  const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const headers={'content-type':'application/json',cookie};
  const payload={kind:'receipt',cash_account:'101',counterpart:'104',amount:45600,party_name:'شركة الاختبار',amount_words:'خمسة وأربعون ألفاً وستمائة دينار عراقي',description:'تحصيل تجريبي',request_key:'voucher-test-20261017-001'};
  const first=await fetch(server.base+'/api/cash/vouchers',{method:'POST',headers,body:JSON.stringify(payload)});
  const saved=await first.json();assert.equal(first.status,201,JSON.stringify(saved));
  assert.equal(saved.voucher_no,'V-'+saved.id);
  const retry=await fetch(server.base+'/api/cash/vouchers',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal(retry.status,200);assert.equal((await retry.json()).id,saved.id);
  const rows=await fetch(server.base+'/api/cash/vouchers',{headers}).then(r=>r.json());
  const matches=rows.filter(x=>x.id===saved.id);
  assert.equal(matches.length,1);
  assert.equal(matches[0].party_name,payload.party_name);
  assert.equal(matches[0].amount_words,payload.amount_words);
  assert.ok(matches[0].occurred_at);
 }finally{if(server)await server.stop();rmSync(dir,{recursive:true,force:true})}
});
