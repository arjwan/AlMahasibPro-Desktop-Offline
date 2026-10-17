import {chromium} from 'playwright';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const helper=html.slice(html.indexOf('function thermalReceiptHTML('),html.indexOf("$('posReprint').onclick="));
const css=html.slice(html.lastIndexOf('<style>')+7,html.lastIndexOf('</style>'));
const qrScript=readFileSync(new URL('../scanner-qrcode.js',import.meta.url),'utf8');
mkdirSync('artifacts/thermal-receipts',{recursive:true});
const browser=await chromium.launch({headless:true});
try{
 for(const width of ['58','80']){
  const page=await browser.newPage({viewport:{width:420,height:1000}});
  await page.route('http://receipt.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><style>.receipt{display:none}'+css+'</style><body><div id="receipt" class="receipt"></div></body></html>'}));
  await page.goto('http://receipt.test/');
  await page.addScriptTag({content:qrScript});
  await page.addScriptTag({content:"const $=id=>document.getElementById(id),esc=x=>String(x??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c])),money=n=>Number(n).toLocaleString('en-US')+' د.ع';"+helper});
  const info=await page.evaluate(width=>{
   localStorage.setItem('alma-local-printer-config-v1',JSON.stringify({width}));
   const receipt=document.getElementById('receipt');
   receipt.innerHTML=thermalReceiptHTML({invoice:{invoice_no:'S-000003',created_at:'2026-10-17T11:56:07Z'},lines:[{name:'إسفنج تنظيف — عبوة عائلية',qty:1,price:3800},{name:'إسفنج تنظيف — عبوة صغيرة',qty:1,price:3150},{name:'أكياس نفايات — عبوة عائلية',qty:1,price:3900}],discount:0,total:10850,settings:{company_name:'شركة الأرجوان',company_phone:'07700000000'},cashier:'محمد علي'});
   const qr=qrcode(0,'M');qr.addData('ALMAHASIB-THERMAL-TEST-S-000003');qr.make();receipt.insertAdjacentHTML('beforeend','<div class="invoice-qr">'+qr.createSvgTag({cellSize:4,margin:4,scalable:true})+'</div>');
   window.print=()=>{};printThermalReceipt();return {style:document.getElementById('thermal-page-style').textContent,text:receipt.textContent};
  },width);
  assert.ok(info.style.includes('size:'+width+'mm'));assert.ok(info.text.includes('محمد علي'));assert.ok(info.text.includes('شكراً'));
  await page.emulateMedia({media:'print'});await page.evaluate(()=>document.fonts.ready);
  const size=await page.locator('#receipt').evaluate(el=>({width:el.getBoundingClientRect().width,scroll:el.scrollWidth,height:el.scrollHeight}));
  assert.ok(Math.abs(size.width-(Number(width)-4)*96/25.4)<2);assert.ok(size.scroll<=Math.ceil(size.width)+1);
  await page.setViewportSize({width:Math.ceil(Number(width)*96/25.4),height:Math.ceil(size.height+30)});
  await page.screenshot({path:'artifacts/thermal-receipts/receipt-'+width+'mm.png',fullPage:true});
  writeFileSync('artifacts/thermal-receipts/receipt-'+width+'mm.pdf',await page.pdf({preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false}));
  console.log('Thermal '+width+'mm layout and PDF: PASS');await page.close();
 }
}finally{await browser.close()}
