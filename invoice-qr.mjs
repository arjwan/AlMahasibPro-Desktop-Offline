import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

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

const PART_PREFIX='ALMAP1:';
function partCode(group,part,total,lines,meta){
 const payload={v:1,g:group,p:part,n:total,m:meta,l:lines};
 return PART_PREFIX+deflateRawSync(Buffer.from(JSON.stringify(payload),'utf8'),{level:9}).toString('base64url');
}
export function encodeInvoiceQrParts(invoice,kind){
 const data=invoiceQrPayload(invoice,kind);
 const meta={type:data.type,no:data.no,date:data.date,party:data.party,currency:data.currency,discount:data.discount,net:data.net};
 const group=createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0,20);
 const chunks=[];let current=[];
 for(const line of data.lines){
  const candidate=[...current,line];
  if(Buffer.byteLength(partCode(group,9999,9999,candidate,meta),'utf8')<=MAX_QR_BYTES){current=candidate;continue;}
  if(!current.length)throw Error('Single invoice line exceeds QR capacity');
  chunks.push(current);current=[line];
  if(Buffer.byteLength(partCode(group,9999,9999,current,meta),'utf8')>MAX_QR_BYTES)throw Error('Single invoice line exceeds QR capacity');
 }
 if(current.length)chunks.push(current);
 if(chunks.length>9999)throw Error('Too many QR parts');
 return chunks.map((lines,i)=>partCode(group,i+1,chunks.length,lines,meta));
}
export function decodeInvoiceQrParts(codes){
 if(!Array.isArray(codes)||!codes.length)throw Error('QR parts required');
 const parts=codes.map(code=>{
  if(typeof code!=='string'||!code.startsWith(PART_PREFIX)||Buffer.byteLength(code)>MAX_QR_BYTES)throw Error('Invalid QR part');
  return JSON.parse(inflateRawSync(Buffer.from(code.slice(PART_PREFIX.length),'base64url'),{maxOutputLength:MAX_JSON_BYTES}).toString('utf8'));
 });
 const first=parts[0],total=first.n;
 if(!Number.isSafeInteger(total)||total<1||total>9999||parts.length!==total)throw Error('Missing QR parts');
 const seen=new Set();
 for(const part of parts){
  if(part.v!==1||part.g!==first.g||part.n!==total||!Number.isSafeInteger(part.p)||part.p<1||part.p>total||seen.has(part.p)||JSON.stringify(part.m)!==JSON.stringify(first.m)||!Array.isArray(part.l)||!part.l.length)throw Error('Mixed or duplicate QR parts');
  seen.add(part.p);
 }
 parts.sort((a,b)=>a.p-b.p);
 const invoice={...first.m,lines:parts.flatMap(x=>x.l)};
 const validated=invoiceQrPayload(invoice,first.m.type);
 const digest=createHash('sha256').update(JSON.stringify(validated)).digest('hex').slice(0,20);
 if(digest!==first.g)throw Error('Invoice QR checksum mismatch');
 return validated;
}
