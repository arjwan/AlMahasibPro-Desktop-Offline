import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf("const customerName=document.getElementById('ws-sale-partyname')"),html.indexOf("document.getElementById('ws-saleadd').onclick=addLine;"));
function fixture(initial=[]){
 const fields=new Map(),rows=initial.map(x=>({...x}));let creates=0,lost=false;
 const document={getElementById:id=>{if(!fields.has(id))fields.set(id,{value:'',readOnly:false,innerHTML:''});return fields.get(id)}};
 const context=vm.createContext({document,parties:initial.map(x=>({...x})),htmlEscape:x=>String(x).replaceAll('"','&quot;'),apiRequest:async(route,method,body)=>{if(!method)return rows.map(x=>({...x}));creates++;const row={id:'new-'+creates,...body};rows.push(row);if(lost){lost=false;throw Error('lost response')}return row;}});
 vm.runInContext(source,context);
 return {context,get:id=>document.getElementById(id),get creates(){return creates},loseResponse(){lost=true},rows};
}
const client={id:'c1',name:'أحمد',phone:'0771',address:'بغداد',type:'customer'};
test('Customer name selects a registered customer and fills phone/address',async()=>{
 const f=fixture([client]);f.get('ws-sale-partyname').value='أحمد';f.context.syncSaleCustomer();
 assert.equal(f.get('ws-saleclient').value,'c1');assert.equal(f.get('ws-sale-partyphone').value,'0771');assert.equal(f.get('ws-sale-partyaddress').value,'بغداد');assert.equal(await f.context.resolveSaleCustomer(),'c1');assert.equal(f.creates,0);
});
test('A new typed name is automatically saved and reused after invoice retry',async()=>{
 const f=fixture([client]);f.context.selectSaleCustomer(client);f.get('ws-sale-partyname').value='علي';f.context.syncSaleCustomer();assert.equal(f.get('ws-saleclient').value,'');assert.equal(f.get('ws-sale-partyphone').readOnly,false);
 f.get('ws-sale-partyphone').value='0772';const id=await f.context.resolveSaleCustomer();assert.equal(id,'new-1');assert.equal(f.rows[1].phone,'0772');assert.equal(await f.context.resolveSaleCustomer(),id);assert.equal(f.creates,1);
});
test('A lost customer-create response is recovered without creating another customer',async()=>{
 const f=fixture();f.get('ws-sale-partyname').value='زبون جديد';f.loseResponse();await assert.rejects(f.context.resolveSaleCustomer(),/lost response/);assert.equal(await f.context.resolveSaleCustomer(),'new-1');assert.equal(f.creates,1);
});
test('Duplicate names require choosing a specific customer, while an empty name is direct sale',async()=>{
 const f=fixture([client,{...client,id:'c2',phone:'0772'}]);assert.equal(await f.context.resolveSaleCustomer(),null);
 f.get('ws-sale-partyname').value='أحمد';await assert.rejects(f.context.resolveSaleCustomer(),/أكثر من زبون/);assert.equal(f.creates,0);
 f.get('ws-sale-partyname').value='أحمد — 0772';assert.equal(await f.context.resolveSaleCustomer(),'c2');
});
