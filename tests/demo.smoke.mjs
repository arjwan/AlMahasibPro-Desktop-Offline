import {chromium} from 'playwright';
import {startServer} from './helpers/server.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const dir=path.resolve(process.argv[2]||'work/demo-market-large-0.5.2');
if(!fs.existsSync(path.join(dir,'verification.json')))throw Error('Create isolated demo first with npm run demo:create');
const server=await startServer(path.join(dir,'company.sqlite'));let browser;
try{
 browser=await chromium.launch({headless:true});const context=await browser.newContext({hasTouch:true,viewport:{width:1440,height:1000}}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/auth/me',async route=>{await new Promise(r=>setTimeout(r,150));await route.continue()});await page.goto(server.base);await page.locator('#erp-loginuser').fill('admin');await page.locator('#erp-loginpass').fill('admin123');await page.locator('#erp-loginform button').click();await page.locator('#erp-login').waitFor({state:'detached'});
 await page.evaluate(()=>window.go('pos'));await page.waitForFunction(()=>document.querySelectorAll('.product-image').length===240);
 const id=await page.evaluate(()=>fetch('/api/products').then(r=>r.json()).then(rows=>rows.find(x=>x.available>0).id));const product=page.locator('.product[data-id="'+id+'"]');await product.click();await product.tap();assert.ok((await page.locator('#cart').innerText()).includes('2'));
 assert.equal(await product.locator('img').evaluate(img=>img.naturalWidth),160);assert.equal(await product.locator('img').evaluate(img=>getComputedStyle(img).height),'44px');assert.equal(await product.evaluate(el=>getComputedStyle(el).padding),'15px 8px');
 const report=await context.newPage();await report.goto(pathToFileURL(path.join(dir,'barcodes-print.html')).href);assert.equal(await report.locator('svg').count(),240);assert.ok(await report.locator('svg rect').count()>2400);const pdf=await report.pdf({format:'A4',printBackground:true});assert.equal(pdf.subarray(0,4).toString(),'%PDF');fs.writeFileSync(path.join(dir,'barcodes-print.pdf'),pdf);assert.deepEqual(errors,[]);
 console.log('DEMO 240 product pictures, mouse + touch, barcode SVG and PDF: PASS');
}finally{await browser?.close();await server.stop()}
