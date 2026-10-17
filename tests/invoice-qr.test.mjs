import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeInvoiceQr,decodeInvoiceQr,encodeInvoiceQrParts,decodeInvoiceQrParts} from '../invoice-qr.mjs';

test('purchase QR retains full lines, Arabic names and leading zero barcodes',()=>{
 const source={invoice_no:'P-21',date:'2026-10-17',supplier:'شركة بغداد',lines:[{product_id:'A1',product_name:'سكر',barcode:'0012345678905',qty:3,cost:2500},{product_id:'B2',product_name:'رز',barcode:'0999988877772',qty:2,cost:4000}],discount:500,net:15000};
 const decoded=decodeInvoiceQr(encodeInvoiceQr(source,'purchase'));
 assert.equal(decoded.lines.length,2);
 assert.equal(decoded.lines[0].barcode,'0012345678905');
 assert.equal(decoded.lines[0].qty,3);
 assert.equal(decoded.party,'شركة بغداد');
 assert.equal(decoded.net,15000);
});
test('sales QR preserves itemized prices',()=>{
 const qr=encodeInvoiceQr({invoice_no:'S-1',lines:[{id:'x',name:'قلم',qty:2,price:750}],net:1500},'sale');
 assert.equal(decodeInvoiceQr(qr).lines[0].total,1500);
});
test('rejects invalid and oversized invoices',()=>{
 assert.throws(()=>encodeInvoiceQr({lines:[]},'sale'));
 assert.throws(()=>decodeInvoiceQr('not-an-invoice'));
 const lines=Array.from({length:400},(_,i)=>({id:'item-'+i,name:'material-'+i+'-unique-'+i,qty:1,price:100}));
 assert.throws(()=>encodeInvoiceQr({lines},'purchase'),/too large/);
});

test('splits long invoice by actual compressed QR capacity and restores all lines',()=>{
 const lines=Array.from({length:100},(_,i)=>({id:'item-'+i,name:'مادة رقم '+i+' مختلفة',barcode:'000123456'+String(i).padStart(4,'0'),qty:i+1,price:250+i}));
 const invoice={invoice_no:'P-100',date:'2026-10-17',supplier:'شركة الأرجوان',lines};
 const codes=encodeInvoiceQrParts(invoice,'purchase');
 assert.ok(codes.length>1);
 assert.ok(codes.every(code=>Buffer.byteLength(code,'utf8')<=900));
 const restored=decodeInvoiceQrParts([...codes].reverse());
 assert.equal(restored.lines.length,100);
 assert.equal(restored.lines[99].qty,100);
 assert.equal(restored.lines[0].barcode,'0001234560000');
 assert.throws(()=>decodeInvoiceQrParts(codes.slice(1)),/Missing QR parts/);
 assert.throws(()=>decodeInvoiceQrParts([codes[0],codes[0]]),/Mixed or duplicate|Missing QR parts/);
});
