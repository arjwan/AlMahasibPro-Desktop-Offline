import {chromium} from 'playwright';
import {readFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const script=readFileSync(new URL('../stock-ui.js',import.meta.url),'utf8');
const barcode=readFileSync(new URL('../node_modules/jsbarcode/dist/JsBarcode.all.min.js',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true});mkdirSync('artifacts/labels',{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1200,height:1000}});
 const product={id:'P1',name:'صابون تجريبي',category:'منظفات',cost:900,price:1500,barcode:'2000000000015',barcodes:[],components:[]};
 const generated='2000000000022';let barcodeSaved=false;
 await page.route('http://label.test/**',async route=>{
  const u=new URL(route.request().url()),p=u.pathname;
  if(!p.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:'<html dir="rtl"><meta charset="utf-8"><body><main id="root"></main></body></html>'});
  let data=[];
  if(p==='/api/stock/catalog')data=[product];
  else if(p==='/api/warehouses')data=[{id:1,name:'الرئيسي'}];
  else if(p==='/api/stock/barcodes/generate')data={code:generated};
  else if(p==='/api/stock/barcodes'){const b=route.request().postDataJSON();assert.equal(b.product_id,'P1');assert.equal(b.factor,1);barcodeSaved=true;data={ok:true};}
  else if(p==='/api/stock/label'){const code=u.searchParams.get('code');data={code,name:product.name,unit:'حبة',price:product.price};}
  return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('http://label.test/');await page.addScriptTag({content:barcode});await page.addScriptTag({content:script});
 await page.evaluate(()=>window.renderStockPage(document.getElementById('root')));
 await page.waitForFunction(()=>document.querySelector('#stk-label-preview .stock-label svg'));
 assert.equal(await page.locator('#stk-label-id').inputValue(),'P1');assert.equal(await page.locator('#stk-label-cost-price').inputValue(),'900');
 assert.ok((await page.locator('#stk-label-preview').innerText()).includes('1,500'));
 assert.ok(!(await page.locator('#stk-label-preview').innerText()).includes('900'));
 await page.locator('#stk-show-price').uncheck();await page.waitForFunction(()=>!document.querySelector('#stk-label-preview .stock-label-price'));
 await page.locator('#stk-show-price').check();await page.waitForFunction(()=>document.querySelector('#stk-label-preview .stock-label-price'));
 await page.locator('#stk-label-generate').click();await page.waitForFunction(()=>document.getElementById('stk-label-code').value==='2000000000022');assert.ok(barcodeSaved);
 for(const [width,height] of [[50,30],[58,40],[80,50]]){
  await page.locator('#stk-width').fill(String(width));await page.locator('#stk-height').fill(String(height));
  await page.waitForFunction(w=>Math.abs(document.querySelector('#stk-label-preview .stock-label').getBoundingClientRect().width-w*96/25.4)<1,width);
  assert.ok(!(await page.locator('#stk-label-preview-status').innerText()).includes('أكبر من الملصق'));
  await page.locator('#stk-label-preview').screenshot({path:'artifacts/labels/label-'+width+'x'+height+'.png'});
 }
 console.log('Label fields, sale-price visibility, saved generated barcode and 3 preview sizes: PASS');
}finally{await browser.close()}
