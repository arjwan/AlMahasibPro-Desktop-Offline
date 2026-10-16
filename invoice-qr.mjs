import { deflateRawSync, inflateRawSync } from 'node:zlib';

const PREFIX = 'ALMA1:';
const MAX_QR_BYTES = 1700;
const MAX_JSON_BYTES = 200000;
const clean = value => String(value ?? '').trim();

export function invoiceQrPayload(invoice, kind) {
 if (!['sale', 'purchase'].includes(kind)) throw Error('Unsupported invoice type');
 if (!invoice || !Array.isArray(invoice.lines) || !invoice.lines.length) throw Error('Invoice lines required');
 const lines = invoice.lines.map(line => ({
  id: clean(line.product_id ?? line.id),
  name: clean(line.product_name ?? line.name),
  barcode: clean(line.barcode),
  qty: Number(line.qty),
  price: Number(line.price ?? line.cost ?? 0),
  total: Number(line.line_total ?? (Number(line.qty) * Number(line.price ?? line.cost ?? 0)))
 }));
 if (lines.some(x => !x.id || !Number.isSafeInteger(x.qty) || x.qty <= 0 || !Number.isFinite(x.price) || x.price < 0 || !Number.isFinite(x.total))) throw Error('Invalid invoice line');
 return {v:1,type:kind,no:clean(invoice.invoice_no),date:clean(invoice.date),party:clean(invoice.party_name ?? invoice.supplier ?? invoice.customer),currency:clean(invoice.currency || 'IQD'),lines,discount:Number(invoice.discount || 0),net:Number(invoice.net ?? lines.reduce((n,x)=>n+x.total,0))};
}

export function encodeInvoiceQr(invoice, kind) {
 const payload=invoiceQrPayload(invoice,kind);
 const json=Buffer.from(JSON.stringify(payload),'utf8');
 if(json.length>MAX_JSON_BYTES) throw Error('Invoice too large');
 const code=PREFIX+deflateRawSync(json,{level:9}).toString('base64url');
 if(Buffer.byteLength(code,'utf8')>MAX_QR_BYTES) throw Error('Invoice too large for one reliable offline QR; use multiple codes or a local invoice lookup');
 return code;
}

export function decodeInvoiceQr(code) {
 if(typeof code!=='string'||!code.startsWith(PREFIX)||Buffer.byteLength(code)>MAX_QR_BYTES) throw Error('Invalid invoice QR');
 const bytes=inflateRawSync(Buffer.from(code.slice(PREFIX.length),'base64url'),{maxOutputLength:MAX_JSON_BYTES});
 const payload=JSON.parse(bytes.toString('utf8'));
 if(payload.v!==1||!['sale','purchase'].includes(payload.type)||!Array.isArray(payload.lines)||!payload.lines.length)throw Error('Invalid invoice data');
 invoiceQrPayload(payload,payload.type);
 return payload;
}
