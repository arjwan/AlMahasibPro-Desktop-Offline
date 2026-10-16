const {chromium:playwright}=await import(process.env.ALMAHASIB_PLAYWRIGHT||'playwright');
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'alma-ui-'));let logs='';const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,ALMAHASIB_DB:join(dir,'test.sqlite'),PORT:'0'},stdio:['ignore','pipe','pipe']});child.stderr.on('data',x=>logs+=x);const base=await new Promise((resolve,reject)=>{child.stdout.on('data',x=>{const m=String(x).match(/http:\/\/127.0.0.1:\d+/);if(m)resolve(m[0])});child.on('exit',()=>reject(Error(logs)))});let browser;
try{
 browser=await playwright.launch({executablePath:process.env.ALMAHASIB_CHROMIUM||undefined,args:process.env.ALMAHASIB_CHROMIUM&&process.platform!=='win32'?['--no-sandbox','--disable-gpu','--disable-software-rasterizer','--disable-dev-shm-usage','--no-zygote','--single-process']:[],headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',x=>{errors.push(x.message);console.log('BROWSER ERROR',x.message)});page.on('dialog',d=>{console.log('DIALOG',d.message());d.accept()});
 async function submit(id){await page.evaluate(id=>{const form=document.getElementById(id),handler=form.onsubmit;window.reviewSubmit=new Promise((resolve,reject)=>{form.onsubmit=event=>Promise.resolve(handler(event)).then(resolve,reject)})},id);await page.locator('#'+id+' button').click();await page.evaluate(()=>window.reviewSubmit)}
 await page.goto(base);await page.locator('#erp-loginuser').fill('admin');await page.locator('#erp-loginpass').fill('admin123');await page.locator('#erp-loginform button').click();await page.locator('#erp-login').waitFor({state:'detached'});
 await page.evaluate(()=>window.go('stock'));
 await page.locator('#stk-id').fill('UI-STOCK');await page.locator('#stk-name').fill('صنف اختبار المخازن');await page.locator('#stk-barcode').fill('778899');await page.locator('#stk-newcost').fill('10');await page.locator('#stk-price').fill('25');await submit('stk-create-form');
 if(await page.locator('.stk-balance[open]').count())throw Error('Balances must initially be collapsed');
 await page.locator('#stk-search').fill('778899');if(await page.locator('.stk-balance').count()!==1)throw Error('Barcode balance search failed');
 await page.locator('.stk-balance summary').click();if(await page.locator('.stk-balance[open]').count()!==1)throw Error('Balance did not expand');
 await page.locator('#stk-alias-code').fill('BOX-12');await page.locator('#stk-alias-factor').fill('12');await submit('stk-alias-form');
 await page.locator('#stk-reason').fill('استلام مراجعة');await page.locator('#stk-scan').fill('BOX-12');await page.locator('#stk-scan').press('Enter');await page.locator('#stk-scan').fill('BOX-12');await page.locator('#stk-scan').press('Enter');
 if(await page.locator('#stk-lines tbody tr').count()!==1||!(await page.locator('#stk-lines').innerText()).includes('24'))throw Error('Repeated scans must merge into 24 pieces');
 if(await page.locator('#stk-scan').evaluate(e=>e!==document.activeElement))throw Error('Scanner lost focus');
 await page.locator('#stk-draft').click();await page.waitForFunction(()=>document.querySelector('.stk-open'));await page.locator('.stk-open').click();
 const draftStock=await page.evaluate(async()=>{const p=await (await fetch('/api/products')).json();return p.find(p=>p.id==='UI-STOCK').stock});if(draftStock!==0)throw Error('Draft changed stock');
 await page.locator('#stk-post').click();await page.waitForFunction(()=>document.querySelector('.stk-balance')?.textContent.includes('24'));
 await page.locator('.stk-balance summary').click();const popupEvent=page.waitForEvent('popup');await page.locator('.stk-card').click();const popup=await popupEvent;await popup.waitForLoadState();if(!(await popup.locator('body').innerText()).includes('24'))throw Error('Stock card print missing balance');await popup.close();
 await page.locator('#stk-meta-price').fill('30');await submit('stk-meta-form');await page.locator('#stk-label-code').fill('BOX-12');
 const labelEvent=page.waitForEvent('popup');await page.locator('#stk-label-print').click();const label=await labelEvent;await label.waitForLoadState();if(!(await label.locator('.stock-label').innerText()).includes('360'))throw Error('Label must use live carton price');if(await label.locator('svg rect').count()<10)throw Error('Barcode not rendered');await label.close();
 mkdirSync(join(root,'work/readiness'),{recursive:true});await page.screenshot({path:join(root,'work/readiness/stock-review.png'),fullPage:true});
 if(errors.length)throw Error(errors.join('; '));console.log('STOCK UI: COLLAPSED SEARCH, OPEN, REPEATED SCANS, DRAFT, APPROVAL, CARD PRINT AND LIVE BARCODE LABEL PASS');
}finally{if(browser)await browser.close();const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
