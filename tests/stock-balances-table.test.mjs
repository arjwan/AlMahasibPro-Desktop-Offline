import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../stock-ui.js',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const esc='),source.indexOf('const kinds='))+';globalThis.render=stockBalanceTable;',context);
const products=[{id:'P1',name:'مادة <اختبار>',barcode:'00123',category:'غذاء',price:200},{id:'P2',name:'صنف ثانٍ',barcode:null,price:500}];
const balances=[{id:'P1',warehouse:'الأول',stock:5,reserved:2,available:3,value:500},{id:'P1',warehouse:'الثاني',stock:7,reserved:1,available:6,value:700}];
test('Stock balances have sequential rows, labeled column headers and exact barcode text',()=>{
 const html=context.render(products,balances);
 for(const name of ['ت','رمز المادة','اسم المادة','الباركود','التصنيف','الرصيد الكلي','المحجوز','المتاح','سعر البيع','قيمة المخزون','التفاصيل'])assert.ok(html.includes('<th scope="col">'+name+'</th>'),name);
 assert.ok(html.includes('00123'));assert.ok(html.includes('<tr><td>1</td>'));assert.ok(html.includes('<tr><td>2</td>'));assert.ok(html.includes('&lt;اختبار&gt;'));assert.ok(!html.includes('مادة <اختبار>'));
});
test('Warehouse aggregates are correct and each product retains separate expandable details',()=>{
 const html=context.render(products,balances);for(const n of ['12','3','9','1,200 د.ع'])assert.ok(html.includes('>'+n+'</td>'));
 for(const n of ['0','1']){assert.ok(html.includes('aria-controls="stk-balance-detail-'+n+'"'));assert.ok(html.includes('id="stk-balance-detail-'+n+'" class="stk-balance-detail" hidden'));}
 assert.ok(html.includes('data-id="P1"'));assert.ok(html.includes('data-id="P2"'));assert.ok(html.includes('حركة المادة'));assert.ok(html.includes('الأول'));assert.ok(html.includes('الثاني'));
});
test('No matching stock shows one clear empty row and no details controls',()=>{
 const html=context.render([],balances);assert.ok(html.includes('لا توجد مواد مطابقة للبحث'));assert.ok(html.includes('colspan="11"'));assert.ok(!html.includes('aria-controls='));
});
