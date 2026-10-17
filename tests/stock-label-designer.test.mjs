import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../stock-ui.js',import.meta.url),'utf8'),ctx=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const esc='),source.indexOf('const kinds='))+';globalThis.labelHTML=stockLabelHTML;globalThis.labelStyle=stockLabelStyle;',ctx);
const label={id:'P1',name:'صابون <اسم>',description:'وصف & وصف',code:'2000000000015',price:1500,unit:'حبة',cost:900};
const template={width:50,height:30,font:12,layout:'standard',show_name:true,show_price:true,show_code:true,show_description:true};
test('Barcode label includes chosen fields and sale price, escapes product data, and omits purchase cost',()=>{
 const html=ctx.labelHTML(label,template,'<svg></svg>');
 for(const text of ['P1','صابون &lt;اسم&gt;','وصف &amp; وصف','1,500','<svg>'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('900'));assert.ok(!html.includes('<اسم>'));
});
test('Barcode label respects each visibility setting and physical dimensions',()=>{
 const html=ctx.labelHTML(label,{...template,show_name:false,show_price:false,show_code:false,show_description:false},'<svg></svg>');
 for(const text of ['P1','1,500','صابون','وصف'])assert.ok(!html.includes(text));
 const css=ctx.labelStyle(template);assert.ok(css.includes('width:50mm'));assert.ok(css.includes('height:30mm'));
 assert.ok(ctx.labelStyle({...template,layout:'price'}).includes('font-size:1.5em'));
 assert.ok(ctx.labelStyle({...template,layout:'compact'}).includes('padding:.5mm'));
});
