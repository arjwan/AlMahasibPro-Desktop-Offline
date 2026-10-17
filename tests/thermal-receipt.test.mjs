import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const helper=html.slice(html.indexOf('function thermalReceiptHTML('),html.indexOf("$('posReprint').onclick="));
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>Number(n).toLocaleString('en-US')+' د.ع';
test('Thermal receipt prints cashier, stable invoice time, company, totals, thanks and escaped names',()=>{
 const c=vm.createContext({esc,money});vm.runInContext(helper,c);
 const data={invoice:{invoice_no:'S-000003',created_at:'2026-10-17T11:56:07Z'},lines:[{name:'صابون <script>',qty:2,price:1500}],discount:100,total:3000,settings:{company_name:'شركة الأرجوان',receipt_footer:'حياكم الله'},cashier:'محمد علي'};
 const out=c.thermalReceiptHTML(data);
 for(const text of ['محمد علي','شركة الأرجوان','الكاشير','التاريخ','الوقت','شكراً لتسوقكم معنا','2,900','&lt;script&gt;','حياكم الله'])assert.ok(out.includes(text),text);
 assert.ok(!out.includes('<script>'));assert.equal(c.thermalReceiptHTML(data),out);
});
test('Thermal print uses the saved 58/80mm width and measured content height',()=>{
 for(const width of ['58','80','invalid']){
  const receipt={children:[{}],style:{setProperty(){}},classList:{add(){},remove(){}},getBoundingClientRect:()=>({height:600})},sheet={textContent:''};let printed=0;
  const c=vm.createContext({esc,money,$:id=>id==='receipt'?receipt:sheet,localStorage:{getItem:()=>JSON.stringify({width})},window:{print(){printed++}}});vm.runInContext(helper,c);c.printThermalReceipt();
  const actual=width==='58'?58:80;assert.equal(receipt.style.width,(actual-4)+'mm');assert.ok(sheet.textContent.includes('size:'+actual+'mm 165mm'));assert.equal(printed,1);assert.ok(!sheet.textContent.includes(' auto;'));
 }
});
