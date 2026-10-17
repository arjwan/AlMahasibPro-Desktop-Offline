import {launchBrowser} from './helpers/browser.mjs';
import {startServer} from './helpers/server.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'alma-interface-')),shots=resolve('work/readiness/interface-review');mkdirSync(shots,{recursive:true});
const server=await startServer(join(temp,'company.sqlite'));let browser;
try{
 browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.base);await page.locator('#erp-loginuser').fill('admin');await page.locator('#erp-loginpass').fill('admin123');await page.locator('#erp-loginform button').click();await page.locator('#erp-login').waitFor({state:'detached'});await page.locator('#erp-license').evaluate(e=>e.remove());
 // Exercise the stretched-row regression with the full permissions list present.
 await page.evaluate(()=>window.go('settings'));const form=page.locator('#erp-form-user');await form.scrollIntoViewIfNeeded();
 for(const id of ['username','fullname','newpassword','role']){const height=await page.locator('#erp-'+id).evaluate(e=>e.getBoundingClientRect().height);assert.ok(height>=44&&height<=48,`${id} height ${height}`)}
 assert.equal(await form.locator('.permission-grid .erp-grant').count(),10);
 await page.locator('#erp-username').fill('reviewcashier');await page.locator('#erp-fullname').fill('كاشير اختبار الواجهة');await page.locator('#erp-newpassword').fill('ReviewCashier2026!');await form.locator('[value=sales]').check();
 await page.screenshot({path:join(shots,'user-permissions.png')});await form.locator('button[type=submit]').click();await page.waitForFunction(()=>document.getElementById('ws-body')?.textContent.includes('reviewcashier'));
 assert.equal(await page.evaluate(()=>fetch('/api/users').then(r=>r.json()).then(rows=>rows.find(x=>x.username==='reviewcashier')?.modules.includes('sales'))),true);
 assert.equal(await page.locator('#advform-tls').evaluate(e=>!!e.closest('details')&&!e.closest('details').open),true);
 for(const route of ['banks','reports','agents','branches']){
  await page.evaluate(p=>window.go(p),route);
  const bad=await page.locator('#ws-body .workspace-form .input').evaluateAll(els=>els.filter(e=>e.type!=='file'&&(e.getBoundingClientRect().height<44||e.getBoundingClientRect().height>48)).map(e=>e.id));assert.deepEqual(bad,[],route);
  await page.screenshot({path:join(shots,route+'.png')});
 }
 await page.evaluate(async()=>{for(const [url,body] of [['/api/products',{id:'REVIEW1',name:'حليب تجريبي',barcode:'0012345678905',cost:500,price:1000}],['/api/stock/adjust',{product_id:'REVIEW1',delta:10}]]){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(await r.text())}});
 await page.evaluate(async()=>{await refreshLive();await window.go('pos')});await page.locator('.product').first().waitFor();
 assert.equal(await page.locator('.top #posToolsOpen').count(),1);assert.equal(await page.locator('.bill #posToolsOpen').count(),0);await page.locator('#posToolsOpen').click();
 assert.equal(await page.locator('#posCustomer').isVisible(),false);assert.equal(await page.locator('#posCard').isVisible(),false);assert.equal(await page.locator('#posReference').isVisible(),false);
 await page.locator('#payment').selectOption({label:'آجل'});assert.equal(await page.locator('#posCustomer').isVisible(),true);assert.equal(await page.locator('#posReference').isVisible(),false);
 await page.locator('#payment').selectOption({label:'بطاقة'});assert.equal(await page.locator('#posCustomer').isVisible(),false);assert.equal(await page.locator('#posReference').isVisible(),true);
 await page.locator('#payment').selectOption({label:'مختلط'});assert.equal(await page.locator('#posCustomer').isVisible(),true);assert.equal(await page.locator('#posCard').isVisible(),true);
 await page.locator('#payment').selectOption({label:'نقدي'});
 await page.evaluate(()=>fetch('/api/shifts/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_name:'Administrator',opening:10000})}).then(async r=>{if(!r.ok)throw Error(await r.text())}));
 await page.getByText('💸 مصروف أثناء الشفت',{exact:true}).click();await page.locator('#posExpenseAmount').fill('500');await page.locator('#posExpenseReason').fill('نقل مواد تجريبية');await page.locator('#posExpenseSave').click();await page.waitForFunction(()=>document.getElementById('posExpenseMessage').textContent.includes('تم'));
 const expenses=await page.evaluate(()=>fetch('/api/shifts/expenses').then(r=>r.json()));assert.equal(expenses.length,1);assert.equal(expenses[0].amount,500);assert.equal(expenses[0].reason,'نقل مواد تجريبية');
 await page.getByText('💸 مصروف أثناء الشفت',{exact:true}).click();await page.screenshot({path:join(shots,'pos-tools.png')});await page.locator('#posToolsMenu button[popovertargetaction=hide]').click();await page.locator('.product').first().click();
 await page.locator('#posDiscountPercent').fill('10');assert.equal(await page.locator('#discount').inputValue(),'100');assert.ok((await page.locator('#net').innerText()).includes('900'));await page.locator('#cart [data-act=plus]').click();assert.equal(await page.locator('#discount').inputValue(),'200');await page.locator('#cart [data-act=minus]').click();await page.locator('#posDiscountPercent').fill('101');assert.equal(await page.locator('#posDiscountPercent').evaluate(e=>e.checkValidity()),false);await page.locator('#posDiscountPercent').fill('١٠');assert.equal(await page.locator('#discount').inputValue(),'100');const discountBox=await page.locator('#posDiscountPercent').boundingBox();assert.ok(discountBox.width<=72);assert.equal(await page.locator('#posDiscountPercent').evaluate(e=>e.parentElement.className),'cash-summary');await page.locator('#posDiscountPercent').fill('');
 await page.locator('#posPrintEnabled').uncheck();await page.locator('.bill-scroll').evaluate(e=>e.scrollTop=0);await page.screenshot({path:join(shots,'pos-cash.png')});await page.locator('#print').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('دون طباعة'));
 assert.equal(await page.evaluate(()=>fetch('/api/invoices').then(r=>r.json()).then(rows=>rows.length)),1);
 await page.locator('.product').first().click();await page.locator('#posToolsOpen').click();await page.locator('#hold').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('تم تعليق'));
 assert.equal(await page.locator('#posHeldCount').innerText(),'1');await page.locator('#posToolsMenu button[popovertargetaction=hide]').click();await page.locator('#restore').click();await page.locator('[data-held-open]').waitFor();await page.screenshot({path:join(shots,'held-invoices.png')});await page.locator('[data-held-open]').click();await page.waitForFunction(()=>document.getElementById('cart').textContent.includes('حليب تجريبي'));
 const stock=await page.evaluate(()=>fetch('/api/products').then(r=>r.json()).then(rows=>rows.find(x=>x.id==='REVIEW1').stock));assert.equal(stock,9,'Opening held invoice must not post or deduct stock');
 await page.locator('#posToolsOpen').click();await page.locator('#hold').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('تم تعليق'));assert.equal(await page.locator('#posHeldCount').innerText(),'1');assert.equal(await page.evaluate(()=>fetch('/api/invoices').then(r=>r.json()).then(rows=>rows.length)),2,'Reholding must edit original invoice, never duplicate');await page.locator('#posToolsMenu button[popovertargetaction=hide]').click();
 const circle=await page.locator('#restore').evaluate(e=>{const b=e.getBoundingClientRect();return {width:b.width,height:b.height,radius:getComputedStyle(e).borderRadius}});assert.equal(circle.width,44);assert.equal(circle.height,44);assert.equal(circle.radius,'50%');await page.screenshot({path:join(shots,'pos-held-icon.png')});
 await page.locator('#restore').click();await page.locator('[data-held-open]').click();await page.locator('#print').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('دون طباعة'));assert.equal(await page.locator('#posHeldCount').innerText(),'0');assert.equal(await page.evaluate(()=>fetch('/api/invoices').then(r=>r.json()).then(rows=>rows.length)),2,'Saving restored invoice must keep original id');assert.equal(await page.evaluate(()=>fetch('/api/products').then(r=>r.json()).then(rows=>rows.find(x=>x.id==='REVIEW1').stock)),8);
 assert.deepEqual(errors,[]);console.log('INTERFACE REVIEW PASS: compact fields, user permissions saved, conditional payment fields, shift expense and cash invoice saved, no browser errors');
}finally{await browser?.close();await server.stop();rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
