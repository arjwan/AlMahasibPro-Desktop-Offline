import {migrateProviderSecrets} from './secrets.mjs';
import http from 'node:http';
import {ensureJournalReference} from './accounting-schema.mjs';
import {stockERP} from './stock.mjs';
import {supplierReports} from './supplier-reports.mjs';
import {extendERP} from './erp.mjs';
import {scannerERP} from './scanner.mjs';
import {currencyERP} from './currency.mjs';
import {advancedERP} from './advanced.mjs';
import {createLicensing} from './licensing.mjs';
import {createAccess} from './access.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const dbPath=process.env.ALMAHASIB_DB || path.join(root,'data','company.sqlite');
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const logFile=path.join(path.dirname(dbPath), 'server.log');
function log(msg){
    const timestamp=new Date().toISOString();
    try {
        fs.appendFileSync(logFile,`[${timestamp}] ${msg}\n`, 'utf8');
    } catch(e) {}
}
log(`Server starting. DB Path: ${dbPath}`);
if(fs.existsSync(dbPath+'.restore-pending')){
 if(fs.existsSync(dbPath))fs.copyFileSync(dbPath,dbPath+'.before-restore-'+Date.now()+'.sqlite');
 fs.renameSync(dbPath+'.restore-pending',dbPath);
}
const db=new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');

function migrate(){
    log('Running migrations...');
    const currentVersion=db.prepare('PRAGMA user_version').get().user_version;
    const backupPath=dbPath+'.schema-backup-'+Date.now()+'.sqlite';

    
    const requiredTables=['settings','users','permissions','accounts','journal_entries','journal_items','warehouses','units','products','product_warehouse','inventory_moves','partners','purchase_invoices','purchase_items','sale_invoices','sale_items','sale_returns','sale_return_items'];
    const existingTables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    const productSchema=existingTables.has('products')?db.prepare('PRAGMA table_info(products)').all().map(x=>x.name):[];
    const entryColumns=existingTables.has('journal_entries')?db.prepare('PRAGMA table_info(journal_entries)').all().map(x=>x.name):[];
    const schemaChange=!entryColumns.includes('reference')||currentVersion<6||requiredTables.some(table=>!existingTables.has(table))||['barcode','cost','price','unit_id','category','min_stock','emoji'].some(name=>!productSchema.includes(name));
    if(schemaChange&&fs.statSync(dbPath).size>0)db.prepare('VACUUM INTO ?').run(backupPath);
    if(currentVersion<1 || requiredTables.some(table=>!existingTables.has(table))){
        log('Migrating to v1 (Comprehensive Business Schema)');
        db.exec(`
        PRAGMA foreign_keys=ON;
        
        -- 1. System & Users
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, full_name TEXT, role TEXT CHECK(role IN ('admin','manager','cashier')), created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS permissions(user_id TEXT REFERENCES users(id), permission TEXT PRIMARY KEY);

        -- 2. Accounting (Chart of Accounts)
        CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, type TEXT CHECK(type IN ('asset','liability','equity','revenue','expense')), parent_id TEXT REFERENCES accounts(id), balance INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS journal_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, description TEXT, reference TEXT, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS journal_items(id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL REFERENCES journal_entries(id), account_id TEXT NOT NULL REFERENCES accounts(id), debit INTEGER DEFAULT 0 CHECK(debit>=0), credit INTEGER DEFAULT 0 CHECK(credit>=0), memo TEXT);

        -- 3. Inventory & Warehouses
        CREATE TABLE IF NOT EXISTS warehouses(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location TEXT);
        CREATE TABLE IF NOT EXISTS units(id TEXT PRIMARY KEY, name TEXT NOT NULL, abbreviation TEXT);
        CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, barcode TEXT UNIQUE, unit_id TEXT REFERENCES units(id), category TEXT, cost INTEGER DEFAULT 0 CHECK(cost>=0), price INTEGER NOT NULL CHECK(price>=0), min_stock INTEGER DEFAULT 0, emoji TEXT DEFAULT '📦', archived INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS product_warehouse(product_id TEXT NOT NULL REFERENCES products(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), stock INTEGER DEFAULT 0 CHECK(stock>=0), PRIMARY KEY(product_id, warehouse_id));
        CREATE TABLE IF NOT EXISTS inventory_moves(id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL REFERENCES products(id), warehouse_id INTEGER REFERENCES warehouses(id), delta INTEGER NOT NULL, type TEXT CHECK(type IN ('purchase','sale','transfer','adjustment','return')), reference TEXT, date TEXT NOT NULL, created_at TEXT NOT NULL);

        -- 4. Partners (Customers & Suppliers)
        CREATE TABLE IF NOT EXISTS partners(id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT CHECK(type IN ('customer','supplier','both')), phone TEXT, email TEXT, address TEXT, account_id TEXT REFERENCES accounts(id));

        -- 5. Purchases
        CREATE TABLE IF NOT EXISTS purchase_invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_no TEXT UNIQUE, partner_id TEXT NOT NULL REFERENCES partners(id), date TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER DEFAULT 0, net INTEGER NOT NULL, payment_status TEXT CHECK(payment_status IN ('paid','partial','unpaid')), created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS purchase_items(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id), product_id TEXT NOT NULL REFERENCES products(id), qty INTEGER NOT NULL CHECK(qty>0), cost INTEGER NOT NULL, line_total INTEGER NOT NULL);

        -- 6. Sales & POS
        CREATE TABLE IF NOT EXISTS sale_invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_no TEXT UNIQUE, partner_id TEXT REFERENCES partners(id), cashier_id TEXT REFERENCES users(id), date TEXT NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER DEFAULT 0, net INTEGER NOT NULL, payment_method TEXT CHECK(payment_method IN ('cash','bank','credit')), status TEXT CHECK(status IN ('paid','held','returned')), created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL REFERENCES sale_invoices(id), product_id TEXT NOT NULL REFERENCES products(id), qty INTEGER NOT NULL CHECK(qty>0), price INTEGER NOT NULL, line_total INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sale_returns(id INTEGER PRIMARY KEY AUTOINCREMENT, original_invoice_id INTEGER REFERENCES sale_invoices(id), date TEXT NOT NULL, reason TEXT, net_refund INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sale_return_items(id INTEGER PRIMARY KEY AUTOINCREMENT, return_id INTEGER NOT NULL REFERENCES sale_returns(id), product_id TEXT NOT NULL REFERENCES products(id), qty INTEGER NOT NULL CHECK(qty>0), refund_amount INTEGER NOT NULL);
        `);
        db.exec('PRAGMA user_version=1');
    }
    
    // Legacy databases may advertise v2 while still missing columns.
    // Reconcile column-by-column before creating dependent indexes.
    const columns=table=>new Set(db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name));
    const productColumns=columns('products');
    for(const [column,definition] of [
      ['barcode','TEXT'],['unit_id','TEXT'],['category','TEXT'],
      ['cost','INTEGER NOT NULL DEFAULT 0'],['price','INTEGER NOT NULL DEFAULT 0'],
      ['min_stock','INTEGER NOT NULL DEFAULT 0'],['emoji','TEXT'],
      ['archived','INTEGER NOT NULL DEFAULT 0']
    ]){
      if(!productColumns.has(column)){
        log('Adding missing products column: '+column);
        db.exec('ALTER TABLE products ADD COLUMN '+column+' '+definition);
      }
    }
    if(!columns('sale_invoices').has('warehouse_id'))db.exec('ALTER TABLE sale_invoices ADD COLUMN warehouse_id INTEGER NOT NULL DEFAULT 1');
    // Older installed databases can already have journal_entries without reference.
    // Reconcile before ERP queries use it; preserve amounts and never invent references.
    if(!columns('journal_entries').has('reference')){
      log('Adding missing journal_entries column: reference');
      ensureJournalReference(db);
    }
    const journalColumns=columns('journal_items');
    if(journalColumns.has('account_id'))db.exec('CREATE INDEX IF NOT EXISTS idx_journal_account ON journal_items(account_id)');
    db.exec(`DROP INDEX IF EXISTS idx_journal_ref_date;
CREATE TABLE IF NOT EXISTS journal_postings(
  posting_key TEXT PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  created_at TEXT NOT NULL
);`);
    if(currentVersion<2)db.exec('PRAGMA user_version=2');
}
migrate();
// Verify the same query used by the accounts page before declaring readiness.
db.prepare('SELECT e.reference FROM journal_entries e LIMIT 0').all();
const runtimeBuild=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'server.mjs'))).update(fs.readFileSync(path.join(root,'erp.mjs'))).digest('hex').slice(0,16);

// Initial Setup (Structure only)
const initSystem = () => {
    const users = db.prepare('INSERT OR IGNORE INTO users(id,username,password,full_name,role,created_at) VALUES(?,?,?,?,?,?)');
    users.run('u1','admin','admin123','Administrator','admin',new Date().toISOString());
    
    const units = db.prepare('INSERT OR IGNORE INTO units(id,name,abbreviation) VALUES(?,?,?)');
    units.run('pc','Piece','Pc');
    units.run('kg','Kilogram','Kg');

    const warehouses = db.prepare('INSERT OR IGNORE INTO warehouses(name,location) VALUES(?,?)');
    if(!db.prepare('SELECT id FROM warehouses LIMIT 1').get()) warehouses.run('Main Warehouse','Central');

    const accounts = db.prepare('INSERT OR IGNORE INTO accounts(id,code,name,type,parent_id) VALUES(?,?,?,?,?)');
    accounts.run('1','1000','Assets','asset',null);
    accounts.run('101','1010','Cash','asset','1');
    accounts.run('102','1020','Inventory','asset','1');
    accounts.run('103','1030','البنك','asset','1');
    accounts.run('104','1040','ذمم العملاء','asset','1');
    accounts.run('2','2000','Liabilities','liability',null);
    accounts.run('201','2010','Suppliers','liability','2');
    accounts.run('3','3000','Equity','equity',null);
    accounts.run('4','4000','Revenue','revenue',null);
    accounts.run('401','4010','Sales','revenue','4');
    accounts.run('5','5000','Expenses','expense',null);
    accounts.run('501','5010','Cost of Goods Sold','expense','5');
};
initSystem();

db.exec(`CREATE TABLE IF NOT EXISTS cash_vouchers(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('receipt','payment')), cash_account TEXT NOT NULL REFERENCES accounts(id), counterpart TEXT NOT NULL REFERENCES accounts(id), amount INTEGER NOT NULL CHECK(amount>0), description TEXT, entry_id INTEGER NOT NULL REFERENCES journal_entries(id), date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_requests(
  idempotency_key TEXT PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES sale_invoices(id),
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending','success','failed','cancelled')) NOT NULL,
  result_payload TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_transactions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES sale_invoices(id),
  provider TEXT NOT NULL,
  reference TEXT UNIQUE,
  amount INTEGER NOT NULL CHECK(amount>0),
  currency TEXT NOT NULL DEFAULT 'IQD',
  status TEXT CHECK(status IN ('pending','success','failed','cancelled','refunded')) NOT NULL,
  payment_method TEXT CHECK(payment_method IN ('cash','card','mixed')) NOT NULL,
  cashier_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_providers(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_encrypted TEXT,
  webhook_secret_encrypted TEXT,
  merchant_id TEXT,
  settings TEXT,
  active INTEGER DEFAULT 1
);`);
// Preserve existing payment rows while allowing cash receipts.
if(!db.prepare("SELECT sql FROM sqlite_master WHERE name='payment_transactions'").get().sql.includes("'cash'")){
 db.exec("BEGIN IMMEDIATE; ALTER TABLE payment_transactions RENAME TO payment_transactions_legacy");
 try{
 const ddl=db.prepare("SELECT sql FROM sqlite_master WHERE name='payment_transactions_legacy'").get().sql.replace('payment_transactions_legacy','payment_transactions').replace("('card','mixed')","('cash','card','mixed')");
 db.exec(ddl);db.exec('INSERT INTO payment_transactions SELECT * FROM payment_transactions_legacy; DROP TABLE payment_transactions_legacy; COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e}
}
db.prepare("INSERT OR IGNORE INTO accounts(id,code,name,type,parent_id) VALUES('pos-card-clearing','POS-CARD','Card clearing','asset','1')").run();
migrateProviderSecrets(db,dbPath);
function postJournal(description,reference,lines,accountingDate=null){
  erp.periodOpen(accountingDate||new Date().toISOString().slice(0,10));
  const valid=lines.filter(x=>x[1]||x[2]);
  const debit=valid.reduce((n,x)=>n+x[1],0),credit=valid.reduce((n,x)=>n+x[2],0);
  if(!Number.isSafeInteger(debit)||debit!==credit)inputError(`القيد غير متوازن: مدين ${debit}, دائن ${credit}`);
  if(!valid.length)return null;
  
  const now=new Date().toISOString();
  const dateVal=accountingDate||now.slice(0,10);

  const id=Number(db.prepare('INSERT INTO journal_entries(date,description,reference,created_at) VALUES(?,?,?,?)').run(dateVal,description,reference,now).lastInsertRowid);
  for(const [account,d,c] of valid)db.prepare('INSERT INTO journal_items(entry_id,account_id,debit,credit,memo) VALUES(?,?,?,?,?)').run(id,account,d,c,description);
  return id;
}
function postSale(invoiceId){
  const sale=db.prepare('SELECT * FROM sale_invoices WHERE id=?').get(invoiceId);
  if(!sale)inputError('الفاتورة غير موجودة');
  
  const postingKey=`SALE:${sale.invoice_no}:${sale.id}`;
  const existing=db.prepare('SELECT entry_id FROM journal_postings WHERE posting_key=?').get(postingKey);
  if(existing)return {id:sale.id,entry_id:existing.entry_id,status:'already_posted'};

  return transaction(()=>{
    if(sale.source==='pos')db.prepare('UPDATE sale_items SET loaded_qty=qty WHERE invoice_id=?').run(invoiceId);
    
    const items=db.prepare('SELECT * FROM sale_items WHERE invoice_id=?').all(invoiceId);
    let totalCost=0;
    for(const item of items){
      const cost=item.cost_snapshot ?? db.prepare('SELECT cost FROM products WHERE id=?').get(item.product_id).cost;
      const costTotal=item.cost_total ?? item.qty*cost;
      db.prepare('UPDATE sale_items SET cost_snapshot=?,cost_total=? WHERE id=?').run(cost,costTotal,item.id);
      totalCost += costTotal;
    }

    const paid=sale.paid??(sale.payment_method==='credit'?0:sale.net),cash=sale.payment_method==='bank'?'103':'101';
    const entryId=postJournal('فاتورة بيع '+sale.invoice_no,sale.invoice_no,[[cash,paid,0],['104',sale.net-paid,0],['401',0,sale.net],['501',totalCost,0],['102',0,totalCost]]);
    
    db.prepare('INSERT INTO journal_postings(posting_key,entry_id,created_at) VALUES(?,?,?)').run(postingKey,entryId,new Date().toISOString());
    erp.audit('sale-posted',invoiceId,{invoice_no:sale.invoice_no});
    return {id:sale.id,entry_id:entryId,status:'posted'};
  });
}

function postPurchase(invoiceId){
  const invoice=db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(invoiceId);
  if(!invoice)inputError('الفاتورة غير موجودة');
  
  const postingKey=`PURCHASE:${invoice.invoice_no}:${invoice.id}`;
  const existing=db.prepare('SELECT entry_id FROM journal_postings WHERE posting_key=?').get(postingKey);
  if(existing)return {id:invoice.id,entry_id:existing.entry_id,status:'already_posted'};
  
  return transaction(()=>{
    const items=db.prepare('SELECT * FROM purchase_items WHERE invoice_id=?').all(invoiceId);
    let totalNet=0;
    for(const item of items){
      inventory(item.product_id,invoice.warehouse_id,item.qty,'purchase',invoice.invoice_no,item.line_total);
      totalNet += item.line_total;
    }
    
    const paid=invoice.paid||0,cash=invoice.payment_method==='bank'?'103':'101';
    const entryId=postJournal('فاتورة شراء '+invoice.invoice_no,invoice.invoice_no,[['102',invoice.net,0],[cash,0,paid],['201',0,invoice.net-paid]]);
    
    db.prepare('INSERT INTO journal_postings(posting_key,entry_id,created_at) VALUES(?,?,?)').run(postingKey,entryId,new Date().toISOString());
    erp.audit('purchase-posted',invoiceId,{invoice_no:invoice.invoice_no});
    return {id:invoice.id,entry_id:entryId,status:'posted'};
  });
}

function processPayment(invoiceId, data, actor){
 return transaction(()=>{
  const invoice=db.prepare('SELECT * FROM sale_invoices WHERE id=?').get(invoiceId);
  if(!invoice||invoice.cancelled||invoice.status!=='paid'||invoice.source!=='pos')inputError('اختر فاتورة كاشير مرحلة');
  const amount=Number(data.amount),method=data.method,provider=method==='cash'?'manual':data.provider;
  const key=String(data.idempotency_key||operation?.key||'');
  const reference=method==='card'?String(data.reference||'').trim():null;
  if(!key||key.length>150)inputError('معرف الدفع مطلوب');
  if(!Number.isSafeInteger(amount)||amount<=0||!['cash','card'].includes(method))inputError('الدفع غير صحيح');
  const payload=JSON.stringify({invoiceId,amount,method,provider,reference,actor:actor.id});
  const previous=db.prepare('SELECT * FROM payment_requests WHERE idempotency_key=?').get(key);
  if(previous){const cached=JSON.parse(previous.result_payload);if(cached.request!==payload)inputError('معرف الدفع مستخدم لطلب مختلف');return cached.result;}
  if(method==='card'){
   if(provider!=='independent_pos')inputError('مزود الدفع غير مدعوم دون تحقق موثوق');
   if(!['admin','manager'].includes(actor.role))inputError('تأكيد الجهاز المستقل للمدير فقط');
   if(!reference||reference.length>150)inputError('مرجع الجهاز المستقل مطلوب');
   if(db.prepare('SELECT id FROM payment_transactions WHERE reference=?').get(reference))inputError('المرجع مستخدم مسبقاً');
  }
  const returns=db.prepare("SELECT COALESCE(SUM(amount-cash_refund),0) AS credit FROM document_returns WHERE kind='sale' AND invoice_id=?").get(invoiceId).credit;
  const paid=invoice.paid??(invoice.payment_method==='credit'?0:invoice.net),newPaid=paid+amount;
  if(!Number.isSafeInteger(newPaid)||newPaid>invoice.net-returns)inputError('الدفع أكبر من الرصيد المتبقي');
  const now=new Date().toISOString();
  const txId=Number(db.prepare('INSERT INTO payment_transactions(invoice_id,provider,reference,amount,status,payment_method,cashier_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(invoiceId,provider,reference,amount,'success',method,actor.id,now,now).lastInsertRowid);
  db.prepare('UPDATE sale_invoices SET paid=? WHERE id=?').run(newPaid,invoiceId);
  postJournal('تحصيل دفعة فاتورة '+invoice.invoice_no,'PAY-'+txId,[[method==='card'?'pos-card-clearing':'101',amount,0],['104',0,amount]]);
  const result={id:txId,status:'success',amount,paid:newPaid,payment_status:newPaid===invoice.net-returns?'paid':'partial'};
  db.prepare('INSERT INTO payment_requests(idempotency_key,invoice_id,amount,currency,provider,status,result_payload,created_at) VALUES(?,?,?,?,?,?,?,?)').run(key,invoiceId,amount,'IQD',provider,'success',JSON.stringify({request:payload,result}),now);
  erp.audit('payment',txId,{invoiceId,amount,method,reference});return result;
 });
}
function paymentSummary(invoice){
 const r=db.prepare("SELECT COALESCE(SUM(amount),0) AS amount,COALESCE(SUM(cash_refund),0) AS refund FROM document_returns WHERE kind='sale' AND invoice_id=?").get(invoice.id);
 const paid=invoice.paid??(invoice.payment_method==='credit'?0:invoice.net),remaining=Math.max(0,invoice.net-paid-r.amount+r.refund);
 return {...invoice,remaining,payment_status:invoice.status==='held'?'unpaid':remaining===0?'paid':paid>r.refund?'partial':'unpaid'};
}
const all=()=>db.prepare('SELECT p.*, COALESCE(SUM(pw.stock),0) AS stock FROM products p LEFT JOIN product_warehouse pw ON pw.product_id=p.id WHERE p.archived=0 GROUP BY p.id ORDER BY p.name').all().map(p=>({...p,available:erp.available(p.id,1)}));
function send(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body))}
function inputError(message){const e=new Error(message);e.status=400;throw e}
function readJSON(body){try{const value=JSON.parse(body||'{}');if(!value||Array.isArray(value)||typeof value!=='object')inputError('بيانات JSON غير صحيحة');return value}catch{inputError('بيانات JSON غير صحيحة')}}
let stockERPService=null;
function inventory(productId,warehouseId,delta,type,reference,carryingValue=null){
 erp.periodOpen();
 if(delta<0&&erp.available(productId,warehouseId)<-delta)inputError('الرصيد المتاح غير كاف أو محجوز');
 const value=carryingValue??(delta<0?erp.inventoryCost(productId,-delta):db.prepare('SELECT cost FROM products WHERE id=?').get(productId)?.cost*delta);
 if(type!=='transfer'&&(!Number.isSafeInteger(value)||value<0))inputError('قيمة المخزون غير صحيحة');
 const row=db.prepare('SELECT stock FROM product_warehouse WHERE product_id=? AND warehouse_id=?').get(productId,warehouseId);
 if(!row)db.prepare('INSERT INTO product_warehouse(product_id,warehouse_id,stock) VALUES(?,?,0)').run(productId,warehouseId);
 const before=row?.stock||0;if(!Number.isSafeInteger(before+delta))inputError('الرصيد كبير جداً');
 const batchChanges=stockERPService?.beforeMove(productId,warehouseId,delta,type,reference);
 const updated=db.prepare('UPDATE product_warehouse SET stock=stock+? WHERE product_id=? AND warehouse_id=? AND stock+?>=0').run(delta,productId,warehouseId,delta);
 if(!updated.changes)inputError('الرصيد المخزني غير كاف');
 if(type!=='transfer'){
 const product=db.prepare('SELECT book_value FROM products WHERE id=?').get(productId),book=(product.book_value||0)+(delta<0?-value:value);
 if(!Number.isSafeInteger(book)||book<0)inputError('قيمة المخزون كبيرة أو غير صحيحة');
 const qty=db.prepare('SELECT COALESCE(SUM(stock),0) AS n FROM product_warehouse WHERE product_id=?').get(productId).n;
 db.prepare('UPDATE products SET book_value=?,cost=CASE WHEN ?>0 THEN ? ELSE cost END WHERE id=?').run(book,qty,qty?Math.round(book/qty):0,productId);
 }
 const movement=db.prepare('INSERT INTO inventory_moves(product_id,warehouse_id,delta,type,reference,date,created_at) VALUES(?,?,?,?,?,?,?)').run(productId,warehouseId,delta,type,reference,new Date().toISOString().slice(0,10),new Date().toISOString());
 if(batchChanges)stockERPService.afterMove(Number(movement.lastInsertRowid),batchChanges);
}
let operation=null;
function transaction(fn){if(db.isTransaction)return fn();db.exec('BEGIN IMMEDIATE');try{
 const result=fn();
 if(operation?.key)db.prepare('INSERT INTO request_keys(key,route,payload,result) VALUES(?,?,?,?)').run(operation.key,operation.route,operation.payload,JSON.stringify(result));
 db.exec('COMMIT');return result
}catch(e){db.exec('ROLLBACK');throw e}}
const erp=extendERP({db,dbPath,send,inputError,readJSON,transaction,inventory,postJournal,postSale});
const advanced=advancedERP({db,inputError,postJournal,inventory,erp});erp.setAdvanced(advanced);
const currency=currencyERP({db,inputError,transaction,postJournal,erp,send,readJSON});
const licensing=createLicensing({dbPath,send,readJSON});
const access=createAccess({db,send,readJSON,inputError,audit:erp.audit,licensing});db.exec('PRAGMA user_version=6');
const scanner=scannerERP({db,dbPath,send,readJSON,inputError,audit:erp.audit});
const handleSupplier=supplierReports({db,inputError,send});
stockERPService=stockERP({db,inputError,inventory,erp,transaction,postJournal,send,readJSON});
const handler=(req,res)=>{
 let body='';req.on('data',chunk=>{body+=chunk;if(body.length>42e6)req.destroy()});
 req.on('end',()=>{
 try{
 const url=new URL(req.url,'http://localhost'),p=url.pathname;
 erp.setActor(null);
 if(p.startsWith('/api/v1/market/scanner')&&!licensing.allowed(req))return send(res,403,{error:'يتطلب اتصال الشبكة ترخيصاً فعالاً'});
 if(scanner.publicHandle(req,res,p,body))return;
 if(access.handle(req,res,p,body))return;
 erp.setActor(req.user?.id||null);
 operation=null;
 if(req.method==='POST'&&req.headers['idempotency-key']){
 const key=String(req.headers['idempotency-key']);if(key.length>150)inputError('معرف العملية طويل جداً');
 const payload=crypto.createHash('sha256').update(body).digest('hex'),route=p+':'+req.user.id;
 const cached=db.prepare('SELECT * FROM request_keys WHERE key=?').get(key);
 if(cached){if(cached.route!==route||cached.payload!==payload)inputError('معرف العملية مستخدم لطلب مختلف');return send(res,200,JSON.parse(cached.result))}
 operation={key,route,payload};
 }
 if(stockERPService.handle(req,res,p,body,url))return;
 if(handleSupplier(req,res,p,url))return;
 if(scanner.handle(req,res,p,body))return;
 if(currency.handle(req,res,p,body))return;
 if(erp.handle(req,res,p,body,url))return;
 if(req.method==='GET'&&p==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(root,'index.html')));return}
 if(req.method==='GET'&&p==='/erp-ui.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(root,'erp-ui.js')));return}
 if(req.method==='GET'&&p==='/stock-ui.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(root,'stock-ui.js')));return}
 if(req.method==='GET'&&p==='/jsbarcode.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(root,'node_modules/jsbarcode/dist/JsBarcode.all.min.js')));return}
 if(req.method==='GET'&&p==='/advanced-ui.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(root,'advanced-ui.js')));return}
 if(req.method==='GET'&&p==='/scanner-qrcode.js'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});res.end(fs.readFileSync(path.join(root,'scanner-qrcode.js')));return}
 if(req.method==='GET'&&p==='/market-scanner.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(root,'market-scanner.html')));return}
 if(req.method==='GET'&&p==='/api/health')return send(res,200,{status:'ok',version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,instance:process.env.ALMAHASIB_INSTANCE||null,build:runtimeBuild,accounting_schema_ok:true});
 if(req.method==='GET'&&p==='/api/diagnostics/accounting'){
 if(req.user.role!=='admin')return send(res,403,{error:'التشخيص للمدير فقط'});
 return send(res,200,{build:runtimeBuild,database:dbPath,schema_version:db.prepare('PRAGMA user_version').get().user_version,journal_columns:db.prepare('PRAGMA table_info(journal_entries)').all().map(x=>x.name),reference_present:true});
 }
 if(req.method==='GET'&&p==='/api/products')return send(res,200,all());
 if(req.method==='GET'&&p==='/api/warehouses')return send(res,200,db.prepare('SELECT * FROM warehouses ORDER BY id').all());
   if(req.method==='DELETE'&&p==='/api/products'){
    const id=String(url.searchParams.get('id')||'').trim();
    if(!id)inputError('معرف المادة مطلوب');
    const result=transaction(()=>{
      const hasMoves=db.prepare('SELECT id FROM inventory_moves WHERE product_id=? LIMIT 1').get(id);
      const hasSales=db.prepare('SELECT id FROM sale_items WHERE product_id=? LIMIT 1').get(id);
      const hasPurchases=db.prepare('SELECT id FROM purchase_items WHERE product_id=? LIMIT 1').get(id);
      if(hasMoves||hasSales||hasPurchases){
        db.prepare('UPDATE products SET archived=1 WHERE id=?').run(id);
        return {ok:true,archived:true,message:'تمت أرشفة المادة لوجود حركات مرتبطة'};
      }
      db.prepare('DELETE FROM product_warehouse WHERE product_id=?').run(id);
      db.prepare('DELETE FROM products WHERE id=?').run(id);
      return {ok:true,archived:false,message:'تم حذف المادة نهائياً'};
    });
    return send(res,200,result);
  }
 if(req.method==='POST'&&p==='/api/products'){
 const v=readJSON(body),id=String(v.id||'').trim(),name=String(v.name||'').trim(),price=Number(v.price),cost=Number(v.cost||0);
 if(!id||!name||!Number.isSafeInteger(price)||price<0||!Number.isSafeInteger(cost)||cost<0)inputError('الرمز والاسم والسعر والتكلفة مطلوبة بصيغة صحيحة');
 if(!Number.isSafeInteger(Number(v.min_stock||0))||Number(v.min_stock||0)<0)inputError('حد الرصيد غير صحيح');
 if(db.prepare('SELECT code FROM stock_barcodes WHERE code=? OR code=?').get(id,String(v.barcode||'')))inputError('الرمز أو الباركود مستخدم كوحدة بديلة');
 if(v.unit_id&&!db.prepare('SELECT id FROM units WHERE id=?').get(String(v.unit_id)))inputError('الوحدة غير موجودة');
 const image=String(v.image_data||'');if(image&&(image.length>400000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)))inputError('الصورة تحتاج PNG أو JPEG أو WebP بحجم صغير');
 db.prepare('INSERT INTO products(id,name,barcode,category,cost,price,min_stock,emoji,unit_id,image_data) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,name,v.barcode||null,v.category||null,cost,price,Number(v.min_stock||0),'📦',v.unit_id||null,image||null);
 return send(res,201,{ok:true,id});
 }
 if(req.method==='POST'&&p==='/api/stock/adjust'){
 const v=readJSON(body),qty=Number(v.delta),warehouseId=Number(v.warehouse_id||1);
 if(!v.product_id||!Number.isSafeInteger(qty)||qty===0||!Number.isSafeInteger(warehouseId))inputError('بيانات حركة المخزن غير صحيحة');
 transaction(()=>{
 const product=db.prepare('SELECT * FROM products WHERE id=?').get(String(v.product_id));if(!product)inputError('المادة غير موجودة');
 const value=qty<0?erp.inventoryCost(product.id,-qty):qty*product.cost;
 inventory(product.id,warehouseId,qty,'adjustment',String(v.reference||'تسوية يدوية'),value);
 postJournal('تسوية مخزون', 'ADJ-'+crypto.randomUUID(),qty>0?[['102',value,0],['3',0,value]]:[['501',value,0],['102',0,value]]);
 erp.audit('stock-adjust',product.id,{qty,warehouseId});
 return {ok:true};
 });
 return send(res,201,{ok:true});
 }
 if(req.method==='GET'&&p==='/api/partners')return send(res,200,db.prepare('SELECT * FROM partners ORDER BY name').all());
 if(req.method==='POST'&&p==='/api/partners'){
 const v=readJSON(body),name=String(v.name||'').trim(),type=String(v.type||'customer');
 if(!name||!['customer','supplier','both'].includes(type))inputError('اسم ونوع الطرف مطلوبان');
 const id='party-'+crypto.randomUUID();
 db.prepare('INSERT INTO partners(id,name,type,phone,email,address) VALUES(?,?,?,?,?,?)').run(id,name,type,String(v.phone||''),String(v.email||''),String(v.address||''));
 return send(res,201,{id,name,type});
 }
 if(req.method==='GET'&&p==='/api/purchases')return send(res,200,db.prepare('SELECT p.*,v.name AS supplier FROM purchase_invoices p LEFT JOIN partners v ON v.id=p.partner_id ORDER BY p.id DESC LIMIT 200').all());
 if(req.method==='GET'&&p==='/api/purchases/drafts')return send(res,200,db.prepare('SELECT * FROM purchase_drafts WHERE posted_invoice_id IS NULL ORDER BY id DESC').all().map(x=>({...x,payload:JSON.parse(x.payload)})));
 if(req.method==='POST'&&p==='/api/purchases'){
 const original=readJSON(body),v=currency.normalize(original,'purchase'),lines=v.lines,partnerId=String(v.partner_id||''),warehouseId=Number(v.warehouse_id||1),paid=Number(v.paid||0);
 const local=new Date().toLocaleString('sv-SE',{timeZone:'Asia/Baghdad'}),date=String(v.date||local.slice(0,10)),invoiceTime=String(v.time||local.slice(11,16)),supplierNumber=String(v.supplier_invoice_no??v.invoice_no??'').normalize('NFKC').trim();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||!/^([01]\d|2[0-3]):[0-5]\d$/.test(invoiceTime)||supplierNumber.length>100)inputError('رقم الفاتورة أو التاريخ أو الوقت غير صحيح');
 if(!Array.isArray(lines)||!lines.length||!Number.isSafeInteger(warehouseId)||warehouseId<=0||!Number.isSafeInteger(paid)||paid<0)inputError('بيانات فاتورة الشراء غير صحيحة');
 const result=transaction(()=>{
 const draft=v.draft_id?db.prepare('SELECT * FROM purchase_drafts WHERE id=?').get(Number(v.draft_id)):null;
 if(v.draft_id&&(!draft||draft.posted_invoice_id||Number(v.expected_revision)!==draft.revision))inputError('الفاتورة الأولية تغيرت أو اعتُمدت؛ أعد فتحها');
 const party=db.prepare('SELECT * FROM partners WHERE id=?').get(partnerId);
 if(!party||!['supplier','both'].includes(party.type))inputError('اختر مورداً صحيحاً');
 if(!db.prepare('SELECT id FROM warehouses WHERE id=?').get(warehouseId))inputError('المخزن غير موجود');
 if(supplierNumber&&db.prepare('SELECT id FROM purchase_invoices WHERE partner_id=? AND supplier_invoice_no=?').get(partnerId,supplierNumber))inputError('فاتورة المورد بهذا الرقم معتمدة سابقاً');
 let net=0;const items=[];
 for(const line of lines){
 const product=db.prepare('SELECT * FROM products WHERE id=?').get(String(line.product_id||''));
 const qty=Number(line.qty),cost=Number(line.cost);
 if(!product||!Number.isSafeInteger(qty)||qty<=0||!Number.isSafeInteger(cost)||cost<0)inputError('المادة أو الكمية أو التكلفة غير صحيحة');
 const total=line.__base_total??qty*cost;if(!Number.isSafeInteger(total)||!Number.isSafeInteger(net+total))inputError('مبلغ الفاتورة كبير جداً');
 net+=total;items.push({product,qty,cost,total});
 }
 const subtotal=net,discount=Number(v.discount||0);if(!Number.isSafeInteger(discount)||discount<0||discount>subtotal)inputError('الخصم غير صحيح');net=subtotal-discount;
 let prefix=0;for(const item of items){const next=prefix+item.total;item.total=subtotal?Number(BigInt(next)*BigInt(net)/BigInt(subtotal)-BigInt(prefix)*BigInt(net)/BigInt(subtotal)):0;prefix=next}
 if(paid>net)inputError('المدفوع أكبر من قيمة الفاتورة');
 const now=new Date().toISOString();
 if(v.status==='draft'){
  const payload=JSON.stringify({...original,date,time:invoiceTime,supplier_invoice_no:supplierNumber});
  if(draft){db.prepare('UPDATE purchase_drafts SET payload=?,revision=revision+1,updated_at=? WHERE id=?').run(payload,now,draft.id);erp.audit('purchase-draft-updated',draft.id);return {draft_id:draft.id,revision:draft.revision+1,status:'draft'}}
  const id=Number(db.prepare('INSERT INTO purchase_drafts(payload,created_at,updated_at) VALUES(?,?,?)').run(payload,now,now).lastInsertRowid);erp.audit('purchase-draft-created',id);return {draft_id:id,revision:1,status:'draft'};
 }
 if(v.status&&v.status!=='posted')inputError('حالة فاتورة الشراء غير صحيحة');
 erp.periodOpen(date);
 const result=db.prepare('INSERT INTO purchase_invoices(invoice_no,partner_id,date,subtotal,discount,net,payment_status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(null,partnerId,date,subtotal,discount,net,paid===net?'paid':paid?'partial':'unpaid',now);
 const id=Number(result.lastInsertRowid),invoiceNo='P-'+String(id).padStart(6,'0');
 let external=supplierNumber||invoiceNo,suffix=1;while(!supplierNumber&&db.prepare('SELECT id FROM purchase_invoices WHERE partner_id=? AND supplier_invoice_no=?').get(partnerId,external))external=invoiceNo+'-'+suffix++;
 db.prepare('UPDATE purchase_invoices SET supplier_invoice_no=?,invoice_time=? WHERE id=?').run(external,invoiceTime,id);
 db.prepare('UPDATE purchase_invoices SET invoice_no=? WHERE id=?').run(invoiceNo,id);
 db.prepare('UPDATE purchase_invoices SET warehouse_id=?,paid=? WHERE id=?').run(warehouseId,paid,id);currency.snapshot('purchase_invoices',id,v);
 for(const item of items){
 db.prepare('INSERT INTO purchase_items(invoice_id,product_id,qty,cost,line_total) VALUES(?,?,?,?,?)').run(id,item.product.id,item.qty,item.cost,item.total);
 db.prepare('UPDATE purchase_items SET product_name=? WHERE invoice_id=? AND product_id=?').run(item.product.name,id,item.product.id);
 inventory(item.product.id,warehouseId,item.qty,'purchase',invoiceNo,item.total);
 db.prepare("UPDATE inventory_moves SET date=? WHERE type='purchase' AND reference=?").run(date,invoiceNo);
 }
 const entry=db.prepare('INSERT INTO journal_entries(date,description,reference,created_at) VALUES(?,?,?,?)').run(date,'فاتورة شراء '+invoiceNo,invoiceNo,now);
 const journalId=Number(entry.lastInsertRowid),add=db.prepare('INSERT INTO journal_items(entry_id,account_id,debit,credit,memo) VALUES(?,?,?,?,?)');
 if(net)add.run(journalId,'102',net,0,invoiceNo);
 if(paid)add.run(journalId,'101',0,paid,invoiceNo);
 if(net-paid)add.run(journalId,'201',0,net-paid,invoiceNo);
 if(draft)db.prepare('UPDATE purchase_drafts SET posted_invoice_id=?,updated_at=? WHERE id=?').run(id,now,draft.id);
 erp.audit('purchase-posted',id,{invoiceNo,net,paid,draft_id:draft?.id||null});
 return {id,invoice_no:invoiceNo,supplier_invoice_no:external,date,time:invoiceTime,subtotal,discount,net,paid};
 });
 return send(res,201,result);
 }
 if(req.method==='POST'&&p==='/api/payments'){const v=readJSON(body);return send(res,201,processPayment(Number(v.invoice_id),v,req.user));}
 if(req.method==='GET'&&p==='/api/invoices')return send(res,200,db.prepare('SELECT * FROM sale_invoices ORDER BY id DESC LIMIT 200').all().map(paymentSummary));
 if(req.method==='GET'&&p==='/api/held')return send(res,200,db.prepare("SELECT * FROM sale_invoices WHERE status='held' AND cancelled=0 AND source='pos' ORDER BY id DESC").all());
 const invoiceMatch=p.match(new RegExp('^/api/invoices/([0-9]+)$'));
 if(req.method==='GET'&&invoiceMatch){
 const invoice=db.prepare('SELECT * FROM sale_invoices WHERE id=?').get(Number(invoiceMatch[1]));
 if(!invoice)return send(res,404,{error:'الفاتورة غير موجودة'});
 return send(res,200,{...paymentSummary(invoice),shipments:db.prepare('SELECT * FROM shipments WHERE invoice_id=? ORDER BY id').all(invoice.id),lines:db.prepare('SELECT * FROM sale_items WHERE invoice_id=?').all(invoice.id)});
 }
 if(req.method==='POST'&&p==='/api/invoices'){
 const v=currency.normalize(readJSON(body),'sale'),lines=v.lines,status=v.source==='company'?'held':v.status==='held'?'held':'paid',discount=Number(v.discount||0),warehouseId=Number(v.warehouse_id||1);
 if(!Number.isSafeInteger(warehouseId)||!db.prepare('SELECT id FROM warehouses WHERE id=?').get(warehouseId))inputError('المخزن غير موجود');
 if(v.agent_id&&!db.prepare('SELECT id FROM agents WHERE id=?').get(Number(v.agent_id)))inputError('المندوب غير موجود');
 if(v.branch_id&&!db.prepare('SELECT id FROM branches WHERE id=?').get(Number(v.branch_id)))inputError('الفرع غير موجود');
 if(v.partner_id){const party=db.prepare('SELECT type FROM partners WHERE id=?').get(String(v.partner_id));if(!party||!['customer','both'].includes(party.type))inputError('اختر عميلاً صحيحاً');}
 if(!Array.isArray(lines)||!lines.length||!Number.isSafeInteger(discount)||discount<0)inputError('الفاتورة غير صحيحة');
 const result=transaction(()=>{
 if(v.payments&&(!operation?.key||status!=='paid'||v.source==='company'))inputError('الدفع يحتاج معرف عملية وفاتورة كاشير نهائية');
 let subtotal=0;const prepared=[];
 for(const line of lines){
 const product=db.prepare('SELECT * FROM products WHERE id=?').get(String(line.id));
 const qty=Number(line.qty);
 if(!product||!Number.isSafeInteger(qty)||qty<=0)inputError('مادة أو كمية غير صحيحة');
 const price=v.source==='company'&&line.price!==undefined?Number(line.price):product.price;
 if(!Number.isSafeInteger(price)||price<0||(v.source==='company'&&price===0&&!v.__fx))inputError('سعر المادة غير صحيح أو لم يحدد');
 const lineTotal=line.__base_total??qty*price;
 if(!Number.isSafeInteger(lineTotal))inputError('القيمة كبيرة جدًا');
 if(!Number.isSafeInteger(subtotal+lineTotal))inputError('القيمة كبيرة جدًا');
 subtotal+=lineTotal;prepared.push({product,qty,lineTotal,price});
 }
 if(discount>subtotal)inputError('الخصم أكبر من المجموع');
 const now=new Date().toISOString(),net=subtotal-discount;
 const paid=v.payments?0:v.paid===undefined?(v.payment==='آجل'?0:net):Number(v.paid);
 if(!Number.isSafeInteger(paid)||paid<0||paid>net)inputError('المبلغ المدفوع غير صحيح');
 if(status==='paid'&&v.source!=='company'&&v.payment==='بطاقة'&&!v.payments)inputError('دفع البطاقة يتطلب مرجع جهاز وتأكيداً');
 if(paid<net&&!v.partner_id&&!v.payments)inputError('حدد العميل للبيع الآجل أو المختلط');
 const payment=v.payment==='آجل'?'credit':v.payment==='بطاقة'?'bank':'cash';
 const draft=v.draft_id?db.prepare("SELECT * FROM sale_invoices WHERE id=? AND status='held' AND cancelled=0").get(Number(v.draft_id)):null;
 if(draft&&draft.source!==(v.source==='company'?'company':'pos'))inputError('افتح المسودة من قسمها الأصلي');
 if(draft&&draft.cashier_id&&draft.cashier_id!==req.user.id&&req.user.role==='cashier')inputError('لا يمكنك تعديل مسودة مستخدم آخر');
 if(draft&&draft.source==='company'&&!['draft','rejected'].includes(draft.workflow))inputError('لا يمكن تعديل فاتورة مرسلة قبل رفضها');
 if(v.draft_id&&!draft)inputError('المسودة غير متاحة للتعديل');
 const insert=draft?{lastInsertRowid:draft.id}:db.prepare('INSERT INTO sale_invoices(invoice_no,date,subtotal,discount,net,payment_method,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(null,now.slice(0,10),subtotal,discount,net,payment,status,now);
 const id=Number(insert.lastInsertRowid);
 if(draft){db.prepare('DELETE FROM sale_items WHERE invoice_id=?').run(id);db.prepare('UPDATE sale_invoices SET subtotal=?,discount=?,net=?,payment_method=?,status=? WHERE id=?').run(subtotal,discount,net,payment,status,id);erp.audit('draft-edited',id);}
 db.prepare('UPDATE sale_invoices SET invoice_no=?,warehouse_id=?,partner_id=?,paid=?,agent_id=?,branch_id=? WHERE id=?').run('S-'+String(id).padStart(6,'0'),warehouseId,v.partner_id||null,paid,v.agent_id||null,v.branch_id||null,id);
 for(const line of prepared){
 db.prepare('INSERT INTO sale_items(invoice_id,product_id,qty,price,line_total,cost_snapshot) VALUES(?,?,?,?,?,?)').run(id,line.product.id,line.qty,line.price,line.lineTotal,line.product.cost);
 db.prepare('UPDATE sale_items SET product_name=? WHERE invoice_id=? AND product_id=?').run(line.product.name,id,line.product.id);
 if(status==='paid'){const cost=erp.inventoryCost(line.product.id,line.qty);db.prepare('UPDATE sale_items SET cost_total=? WHERE invoice_id=? AND product_id=? AND cost_total IS NULL').run(cost,id,line.product.id);inventory(line.product.id,warehouseId,-line.qty,'sale','S-'+id,cost);}
 }
 db.prepare('UPDATE sale_invoices SET cashier_id=? WHERE id=?').run(req.user.id,id);currency.snapshot('sale_invoices',id,v);
 db.prepare('UPDATE sale_invoices SET source=?,workflow=? WHERE id=?').run(v.source==='company'?'company':'pos',v.source==='company'?'draft':status==='held'?'draft':'loaded',id);
 let allocated=0n;for(const item of db.prepare('SELECT id,line_total FROM sale_items WHERE invoice_id=? ORDER BY id').all(id)){
 const next=allocated+BigInt(item.line_total),amount=subtotal?Number(next*BigInt(net)/BigInt(subtotal)-allocated*BigInt(net)/BigInt(subtotal)):0;
 db.prepare('UPDATE sale_items SET net_amount=? WHERE id=?').run(amount,item.id);allocated=next;
 }
 if(v.source==='company'&&v.status!=='held')erp.submitCompany(id);
 if(status==='paid'){
 postSale(id);
 if(v.payments){
 if(!Array.isArray(v.payments)||!v.payments.length)inputError('أضف دفعة');
 for(const [i,payment] of v.payments.entries())processPayment(id,{...payment,idempotency_key:operation?.key?operation.key+':'+i:payment.idempotency_key},req.user);
 const collected=db.prepare('SELECT paid FROM sale_invoices WHERE id=?').get(id).paid;
 if(collected<net&&!v.partner_id)inputError('حدد العميل للدفع الجزئي');
 }
 }
 return {id,net,status,invoice_no:'S-'+String(id).padStart(6,'0')};
 });
 return send(res,201,result);
 }
 const complete=p.match(new RegExp('^/api/held/([0-9]+)/complete$'));
 if(req.method==='POST'&&complete){
 const paymentData=readJSON(body);
 const result=transaction(()=>{
 const id=Number(complete[1]),invoice=db.prepare('SELECT * FROM sale_invoices WHERE id=?').get(id);
 if(invoice?.source==='company')inputError('فاتورة الشركات تحتاج موافقة وتحميلاً من قسم المبيعات');
 if(!invoice||invoice.status!=='held'||invoice.cancelled)inputError('الفاتورة ليست معلقة');
 for(const item of db.prepare('SELECT * FROM sale_items WHERE invoice_id=?').all(id)){const product=db.prepare('SELECT cost FROM products WHERE id=?').get(item.product_id),cost=erp.inventoryCost(item.product_id,item.qty);db.prepare('UPDATE sale_items SET cost_snapshot=?,cost_total=? WHERE id=?').run(product.cost,cost,item.id);inventory(item.product_id,invoice.warehouse_id,-item.qty,'sale','S-'+id,cost);}
 if(invoice.payment_method==='bank'){
 if(!operation?.key||!paymentData.reference)inputError('اعتماد البطاقة يتطلب مرجع جهاز ومعرف عملية');
 db.prepare('UPDATE sale_invoices SET paid=0 WHERE id=?').run(id);
 }
 db.prepare("UPDATE sale_invoices SET status='paid' WHERE id=?").run(id);
 postSale(id);
 if(invoice.payment_method==='bank'&&invoice.paid>0)processPayment(id,{method:'card',provider:'independent_pos',reference:paymentData.reference,amount:invoice.paid,idempotency_key:operation.key+':held'},req.user);
 return {id,status:'paid'};
 });
 return send(res,200,result);
 }
 if(req.method==='GET'&&p==='/api/cash/vouchers')return send(res,200,db.prepare('SELECT v.*,a.name AS cash_name,b.name AS counterpart_name FROM cash_vouchers v JOIN accounts a ON a.id=v.cash_account JOIN accounts b ON b.id=v.counterpart ORDER BY v.id DESC').all());
 if(req.method==='POST'&&p==='/api/cash/vouchers'){
 const v=readJSON(body),amount=Number(v.amount),cash=String(v.cash_account),counterpart=String(v.counterpart);
 if(!['receipt','payment'].includes(v.kind)||!['101','103'].includes(cash)||cash===counterpart||!Number.isSafeInteger(amount)||amount<=0)inputError('بيانات السند غير صحيحة');
 const result=transaction(()=>{
 if(['107','108'].includes(counterpart))inputError('استخدم سند الدولار لهذا الحساب');
 if(!db.prepare('SELECT id FROM accounts WHERE id=?').get(counterpart))inputError('الحساب المقابل غير موجود');
 const incoming=v.kind==='receipt',description=String(v.description||'سند نقدي');
 if(v.partner_id){const party=db.prepare('SELECT * FROM partners WHERE id=?').get(String(v.partner_id));if(!party)inputError('الطرف غير موجود');if(!['104','201'].includes(counterpart))inputError('تسديد الطرف يحتاج حساب الذمم');if(counterpart==='104'&&!['customer','both'].includes(party.type))inputError('اختر عميلاً');if(counterpart==='201'&&!['supplier','both'].includes(party.type))inputError('اختر مورداً');}
 const entry=postJournal(description,'V-'+crypto.randomUUID(),[[cash,incoming?amount:0,incoming?0:amount],[counterpart,incoming?0:amount,incoming?amount:0]]);
 const id=Number(db.prepare('INSERT INTO cash_vouchers(kind,cash_account,counterpart,amount,description,entry_id,date) VALUES(?,?,?,?,?,?,?)').run(v.kind,cash,counterpart,amount,description,entry,new Date().toISOString().slice(0,10)).lastInsertRowid);
 db.prepare('UPDATE cash_vouchers SET partner_id=? WHERE id=?').run(v.partner_id||null,id);erp.audit('voucher',id,{entry});
 return {id,entry_id:entry};
 });return send(res,201,result);
 }
 if(req.method==='GET'&&p==='/api/ledger'){
 const account=String(url.searchParams.get('account_id')||'');
 if(!db.prepare('SELECT id FROM accounts WHERE id=?').get(account))inputError('اختر الحساب');
 const rows=db.prepare('SELECT e.id,e.date,e.description,e.reference,i.debit,i.credit FROM journal_items i JOIN journal_entries e ON e.id=i.entry_id WHERE i.account_id=? ORDER BY e.date,e.id,i.id').all(account);
 let balance=0;return send(res,200,rows.map(row=>({...row,balance:balance+=row.debit-row.credit})));
 }
 if(req.method==='GET'&&p==='/api/reports/financial'){
 const rows=db.prepare('SELECT a.type,COALESCE(SUM(i.debit),0) AS debit,COALESCE(SUM(i.credit),0) AS credit FROM accounts a LEFT JOIN journal_items i ON i.account_id=a.id GROUP BY a.type').all();
 const net=type=>{const row=rows.find(x=>x.type===type);return row?row.debit-row.credit:0};
 return send(res,200,{revenue:-net('revenue'),expenses:net('expense'),profit:-net('revenue')-net('expense'),assets:net('asset'),liabilities:-net('liability'),equity:-net('equity'),debit:rows.reduce((n,x)=>n+x.debit,0),credit:rows.reduce((n,x)=>n+x.credit,0)});
 }
 if(req.method==='GET'&&p==='/api/accounts')return send(res,200,db.prepare("SELECT a.id,a.code,a.name,a.type,a.parent_id,COALESCE(SUM(j.debit),0) AS debit,COALESCE(SUM(j.credit),0) AS credit FROM accounts a LEFT JOIN journal_items j ON j.account_id=a.id GROUP BY a.id ORDER BY a.code").all());
 if(req.method==='GET'&&p==='/api/journal')return send(res,200,db.prepare("SELECT e.id,e.date,e.description,e.reference,e.created_at,COALESCE(SUM(i.debit),0) AS debit,COALESCE(SUM(i.credit),0) AS credit FROM journal_entries e LEFT JOIN journal_items i ON i.entry_id=e.id GROUP BY e.id ORDER BY e.id DESC LIMIT 200").all());
 if(req.method==='POST'&&p==='/api/journal'){
 const v=readJSON(body),lines=v.lines;
 if(/^(S-|P-|R-|V-|PAY-|EXP-|STK-|SHIP-|FX-|YEARCLOSE-|REOPEN-|COUNT-|ADJ-|ASSET-|DEP-|CLOSE-)/.test(String(v.reference||'')))inputError('هذا المرجع محجوز للمستندات الآلية');
 erp.periodOpen(v.date||new Date().toISOString().slice(0,10));
 if(!Array.isArray(lines)||lines.length<2)inputError('القيد يحتاج سطرين على الأقل');
 const result=transaction(()=>{
 let debit=0,credit=0;
 for(const line of lines){
 const d=Number(line.debit||0),c=Number(line.credit||0);
 if(['107','108'].includes(String(line.account_id)))inputError('استخدم سند الدولار لتحريك رصيده الفعلي');
 if(!db.prepare('SELECT id FROM accounts WHERE id=?').get(String(line.account_id))||!Number.isSafeInteger(d)||!Number.isSafeInteger(c)||d<0||c<0||(d>0&&c>0)||(d===0&&c===0))inputError('سطر قيد غير صحيح');
 debit+=d;credit+=c;
 }
 if(debit!==credit||debit<=0||!Number.isSafeInteger(debit))inputError('القيد غير متوازن');
 const now=new Date().toISOString(),date=String(v.date||now.slice(0,10));
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))inputError('تاريخ غير صحيح');
 const id=Number(db.prepare('INSERT INTO journal_entries(date,description,reference,created_at) VALUES(?,?,?,?)').run(date,String(v.description||''),String(v.reference||''),now).lastInsertRowid);
 for(const line of lines)db.prepare('INSERT INTO journal_items(entry_id,account_id,debit,credit,memo) VALUES(?,?,?,?,?)').run(id,String(line.account_id),Number(line.debit||0),Number(line.credit||0),String(line.memo||''));
 erp.audit('journal',id,{debit,credit});
 return {id,debit,credit};
 });
 return send(res,201,result);
 }
 if(req.method==='GET'&&p==='/api/stock/moves')return send(res,200,db.prepare('SELECT m.*,p.name AS product_name,w.name AS warehouse_name FROM inventory_moves m LEFT JOIN products p ON p.id=m.product_id LEFT JOIN warehouses w ON w.id=m.warehouse_id ORDER BY m.id DESC LIMIT 200').all());
 if(req.method==='GET'&&p==='/api/summary'){
 const sales=db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN shipping_version>0 THEN (SELECT SUM(net) FROM shipments s WHERE s.invoice_id=i.id) ELSE net END),0) AS sales FROM sale_invoices i WHERE (status='paid' AND shipping_version=0) OR shipping_version>0").get();
 const day=new Date().toISOString().slice(0,10);const today=db.prepare("SELECT (SELECT COALESCE(SUM(net),0) FROM sale_invoices WHERE status='paid' AND shipping_version=0 AND date=?)+(SELECT COALESCE(SUM(net),0) FROM shipments WHERE substr(date,1,10)=?) AS total").get(day,day);
 const stock=db.prepare('SELECT COUNT(*) AS products,COALESCE(SUM(stock),0) AS units FROM product_warehouse').get();
 return send(res,200,{...sales,todaySales:today.total,products:all().length,stockUnits:stock.units,held:db.prepare("SELECT COUNT(*) AS n FROM sale_invoices WHERE status='held' AND cancelled=0").get().n});
 }
 return send(res,404,{error:'المسار غير موجود'});
 }catch(e){send(res,e.status||(/constraint|unique|foreign key/i.test(e.message)?400:500),{error:e.status?e.message:/constraint|unique|foreign key/i.test(e.message)?'تعارض في البيانات المدخلة':e.message})}
 });
};
const server=http.createServer(handler);scanner.startTLS(handler);
const host=process.env.ALMAHASIB_HOST||'127.0.0.1',port=Number(process.env.PORT||3765);
server.listen(port,host,()=>console.log('AlMahasibPro Desktop: http://'+host+':'+server.address().port+' | DB: '+dbPath));
