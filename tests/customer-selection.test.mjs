import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf("const customerName=document.getElementById('ws-sale-partyname')"),html.indexOf("document.getElementById('ws-saleadd').onclick=addLine;"));
function fixture(initial=[]){
 const fields=new Map(),rows=initial.map(x=>({...x}));let creates=0,lost=false;
 const document={getElementById:id=>{if(!fields.has(id))fields.set(id,{value:'',readOnly:false,hidden:false,innerHTML:''});return fields.get(id)}};
 const context=vm.createContext({document,parties:initial.map(x=>({...x})),htmlEscape:x=>String(x).replaceAll('"','&quot;'),apiRequest:async(route,method,body)=>{if(!method)return rows.map(x=>({...x}));creates++;const row={id:'new-'+creates,...body};rows.push(row);if(lost){lost=false;throw Error('lost response')}return row;}});
 vm.runInContext(source,context);
 return {context,get:id=>document.getElementById(id),get creates(){return creates},loseResponse(){lost=true},rows,choose(id){const select=document.getElementById('ws-saleclient');select.value=id;select.onchange();}};
}
const client={id:'c1',name:'أحمد',phone:'0771',address:'بغداد',type:'customer'};
test('Customer uses a real select and chooses a registered customer by id',async()=>{
 assert.match(html,/<select class="input" id="ws-saleclient"/);const f=fixture([client]);f.choose('c1');
 assert.equal(f.get('ws-sale-partyphone').value,'0771');assert.equal(f.get('ws-sale-partyaddress').value,'بغداد');assert.equal(f.get('ws-sale-newcustomer').hidden,true);assert.equal(await f.context.resolveSaleCustomer(),'c1');assert.equal(f.creates,0);
});
test('New customer option reveals fields and saves the customer once',async()=>{
 const f=fixture([client]);f.choose('__new__');assert.equal(f.get('ws-sale-newcustomer').hidden,false);assert.equal(f.get('ws-sale-partyphone').readOnly,false);
 await assert.rejects(f.context.resolveSaleCustomer(),/اسم الزبون/);
 f.get('ws-sale-partyname').value='علي';f.get('ws-sale-partyphone').value='0772';const id=await f.context.resolveSaleCustomer();assert.equal(id,'new-1');assert.equal(f.rows[1].phone,'0772');assert.equal(await f.context.resolveSaleCustomer(),id);assert.equal(f.creates,1);
});
test('Lost customer-create response is recovered without duplication',async()=>{
 const f=fixture();f.choose('__new__');f.get('ws-sale-partyname').value='زبون جديد';f.loseResponse();await assert.rejects(f.context.resolveSaleCustomer(),/lost response/);assert.equal(await f.context.resolveSaleCustomer(),'new-1');assert.equal(f.creates,1);
});
test('Same names remain separate select options and direct sale clears the customer',async()=>{
 const f=fixture([client,{...client,id:'c2',phone:'0772'}]);f.choose('c2');assert.equal(await f.context.resolveSaleCustomer(),'c2');assert.equal(f.get('ws-sale-partyphone').value,'0772');f.choose('');assert.equal(await f.context.resolveSaleCustomer(),null);assert.equal(f.get('ws-sale-phonefield').hidden,true);assert.equal(f.get('ws-sale-partyname').value,'');
});
