import {chromium} from 'playwright';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),helper=html.slice(html.indexOf('function arabicVoucherInteger('),html.indexOf("$('posReprint').onclick="));
const browser=await chromium.launch({headless:true});mkdirSync('artifacts/vouchers',{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:600,height:1000}});
 await page.setContent('<html></html>');await page.addScriptTag({content:helper});
 for(const currency of ['IQD','USD']){
  const output=await page.evaluate(currency=>voucherPrintHTML({id:7,kind:'receipt',amount:125000,foreign_amount:12550,base_amount:175700,rate:'1400',party_name:'علي محمد',company_name:'شركة الأرجوان',cashier_name:'أمين الصندوق',created_at:'2026-10-17T12:00:00Z',description:'تسديد دفعة من حساب الزبون'},currency),currency);
  await page.setContent(output);
  assert.ok((await page.locator('article').innerText()).includes('علي محمد'));assert.ok((await page.locator('article').innerText()).includes('المبلغ كتابةً'));
  const overflow=await page.locator('article').evaluate(el=>el.scrollWidth>el.clientWidth+1);assert.equal(overflow,false);
  await page.emulateMedia({media:'print'});
  await page.screenshot({path:'artifacts/vouchers/voucher-'+currency+'.png',fullPage:true});
  writeFileSync('artifacts/vouchers/voucher-'+currency+'.pdf',await page.pdf({preferCSSPageSize:true,printBackground:true}));
 }
 console.log('IQD and USD voucher print layout: PASS');
}finally{await browser.close()}
