import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('function syncWorkspaceSection('),html.indexOf('const previous=window.go;'));
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();
 await page.setContent('<html dir="rtl"><style>[hidden]{display:none!important}</style><body><div id="ws-body"></div></body></html>');
 await page.addScriptTag({content:'const pages={banks:1,stock:1,accounts:1,reports:1};'+code});
 for(const tab of ['banks','stock','accounts','reports']){
 await page.evaluate(tab=>{
  const body=document.getElementById('ws-body');body.innerHTML='<section class="panel"><h3>إضافة بيانات</h3><input id="entry" value="محفوظ"><button id="action">حفظ</button></section><div><section class="panel"><h3>سجل البيانات</h3><p id="record">تفاصيل السجل</p></section></div><details class="panel"><summary>قائمة جاهزة</summary><p id="existing">محتوى جاهز</p></details>';
  window.clicks=0;document.getElementById('action').onclick=()=>window.clicks++;
  organizeWorkspaceSections(tab);
 },tab);
 assert.equal(await page.locator('#ws-body summary').count(),3);
 const first=page.locator('#ws-body summary').nth(0),second=page.locator('#ws-body summary').nth(1),third=page.locator('#ws-body summary').nth(2);
 await first.click();await page.waitForFunction(()=>document.getElementById('entry').closest('[data-ws-fold-content]').hidden);
 await first.click();await page.locator('#entry').fill('باقية');await page.locator('#action').click();assert.equal(await page.evaluate(()=>window.clicks),1);
 await second.click();assert.equal(await page.locator('#record').isVisible(),true);
 await second.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#record').isVisible(),false);
 await second.focus();await page.keyboard.press('Space');assert.equal(await page.locator('#record').isVisible(),true);
 await third.click();assert.equal(await page.locator('#existing').isVisible(),true);await third.click();assert.equal(await page.locator('#existing').isVisible(),false);
 await page.evaluate(tab=>organizeWorkspaceSections(tab),tab);await first.click();await first.click();assert.equal(await page.locator('#entry').inputValue(),'باقية');
 }
 console.log('Workspace sections open/close by pointer and keyboard in all four tabs; nested panels and form state preserved: PASS');
}finally{await browser.close()}
