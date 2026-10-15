import http from 'node:http';
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
        fs.appendFileSync(logFile,`[${timestamp}] ${msg}\\n`, 'utf8');
    } catch(e) {}
}
log(`Server starting. DB Path: ${dbPath}`);
const db=new DatabaseSync(dbPath);

function migrate(){
    log('Running migrations...');
    const currentVersion=db.prepare('PRAGMA user_version').get().user_version;
    const backupPath=dbPath+'.bak';
    try{fs.copyFileSync(dbPath,backupPath)}catch(e){}
    
    const requiredTables=['settings','users','permissions','accounts','journal_entries','journal_items','warehouses','units','products','product_warehouse','inventory_moves','partners','purchase_invoices','purchase_items','sale_invoices','sale_items','sale_returns','sale_return_items'];
    const existingTables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
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
        CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, barcode TEXT UNIQUE, unit_id TEXT REFERENCES units(id), category TEXT, cost INTEGER DEFAULT 0 CHECK(cost>=0), price INTEGER NOT NULL CHECK(price>=0), min_stock INTEGER DEFAULT 0, emoji TEXT DEFAULT '📦');
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
      ['min_stock','INTEGER NOT NULL DEFAULT 0'],['emoji','TEXT']
    ]){
      if(!productColumns.has(column)){
        log('Adding missing products column: '+column);
        db.exec('ALTER TABLE products ADD COLUMN '+column+' '+definition);
      }
    }
    const journalColumns=columns('journal_items');
    if(journalColumns.has('account_id'))db.exec('CREATE INDEX IF NOT EXISTS idx_journal_account ON journal_items(account_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)');
    if(currentVersion<2)db.exec('PRAGMA user_version=2');
}
migrate();

// Initial Data for Testing
const initData=()=>{
    const users=db.prepare('INSERT OR IGNORE INTO users(id,username,password,full_name,role,created_at) VALUES(?,?,?,?,?,?)');
    users.run('u1','admin','admin123','Administrator','admin',new Date().toISOString());
    
    const units=db.prepare('INSERT OR IGNORE INTO units(id,name,abbreviation) VALUES(?,?,?)');
    units.run('pc','Piece','Pc');
    units.run('kg','Kilogram','Kg');

    const warehouses=db.prepare('INSERT OR IGNORE INTO warehouses(name,location) VALUES(?,?)');
    warehouses.run('Main Warehouse','Central');

    const accounts=db.prepare('INSERT OR IGNORE INTO accounts(id,code,name,type,parent_id) VALUES(?,?,?,?,?)');
    accounts.run('1','1000','Assets','asset',null);
    accounts.run('101','1010','Cash','asset','1');
    accounts.run('102','1020','Inventory','asset','1');
    accounts.run('2','2000','Liabilities','liability',null);
    accounts.run('201','2010','Suppliers','liability','2');
    accounts.run('3','3000','Equity','equity',null);
    accounts.run('4','4000','Revenue','revenue',null);
    accounts.run('401','4010','Sales','revenue','4');
    accounts.run('5','5000','Expenses','expense',null);
    accounts.run('501','5010','Cost of Goods Sold','expense','5');

    const partners=db.prepare('INSERT OR IGNORE INTO partners(id,name,type,account_id) VALUES(?,?,?,?)');
    partners.run('p1','Default Supplier','supplier','201');
    partners.run('c1','Walk-in Customer','customer','101');
};
initData();

const all=()=>db.prepare('SELECT p.*, COALESCE(SUM(pw.stock),0) AS stock FROM products p LEFT JOIN product_warehouse pw ON pw.product_id=p.id GROUP BY p.id ORDER BY p.name').all();
function send(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body))}
function inputError(message){const e=new Error(message);e.status=400;throw e}
function readJSON(body){try{return JSON.parse(body||'{}')}catch{inputError('بيانات JSON غير صحيحة')}}
function inventory(productId,warehouseId,delta,type,reference){
 const row=db.prepare('SELECT stock FROM product_warehouse WHERE product_id=? AND warehouse_id=?').get(productId,warehouseId);
 if(!row)db.prepare('INSERT INTO product_warehouse(product_id,warehouse_id,stock) VALUES(?,?,0)').run(productId,warehouseId);
 const updated=db.prepare('UPDATE product_warehouse SET stock=stock+? WHERE product_id=? AND warehouse_id=? AND stock+?>=0').run(delta,productId,warehouseId);
 if(!updated.changes)inputError('الرصيد المخزني غير كاف');
 db.prepare('INSERT INTO inventory_moves(product_id,warehouse_id,delta,type,reference,date,created_at) VALUES(?,?,?,?,?,?,?)').run(productId,warehouseId,delta,type,reference,new Date().toISOString().slice(0,10),new Date().toISOString());
}
function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}
const server=http.createServer((req,res)=>{
 let body='';req.on('data',chunk=>{body+=chunk;if(body.length>1e6)req.destroy()});
 req.on('end',()=>{
 try{
 const url=new URL(req.url,'http://localhost'),p=url.pathname;
 if(req.method==='GET'&&p==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(root,'index.html')));return}
 if(req.method==='GET'&&p==='/api/health')return send(res,200,{status:'ok',version:'0.4.0'});
 if(req.method==='GET'&&p==='/api/products')return send(res,200,all());
 if(req.method==='GET'&&p==='/api/warehouses')return send(res,200,db.prepare('SELECT * FROM warehouses ORDER BY id').all());
 if(req.method==='POST'&&p==='/api/products'){
 const v=readJSON(body),id=String(v.id||'').trim(),name=String(v.name||'').trim(),price=Number(v.price),cost=Number(v.cost||0);
 if(!id||!name||!Number.isSafeInteger(price)||price<0||!Number.isSafeInteger(cost)||cost<0)inputError('الرمز والاسم والسعر والتكلفة مطلوبة بصيغة صحيحة');
 db.prepare('INSERT INTO products(id,name,barcode,category,cost,price,min_stock,emoji) VALUES(?,?,?,?,?,?,?,?)').run(id,name,v.barcode||null,v.category||null,cost,price,Number(v.min_stock||0),'📦');
 return send(res,201,{ok:true,id});
 }
 if(req.method==='POST'&&p==='/api/stock/adjust'){
 const v=readJSON(body),qty=Number(v.delta),warehouseId=Number(v.warehouse_id||1);
 if(!v.product_id||!Number.isSafeInteger(qty)||qty===0||!Number.isSafeInteger(warehouseId))inputError('بيانات حركة المخزن غير صحيحة');
 transaction(()=>inventory(String(v.product_id),warehouseId,qty,'adjustment',String(v.reference||'تسوية يدوية')));
 return send(res,201,{ok:true});
 }
 if(req.method==='GET'&&p==='/api/invoices')return send(res,200,db.prepare('SELECT * FROM sale_invoices ORDER BY id DESC LIMIT 200').all());
 if(req.method==='GET'&&p==='/api/held')return send(res,200,db.prepare("SELECT * FROM sale_invoices WHERE status='held' ORDER BY id DESC").all());
 const invoiceMatch=p.match(new RegExp('^/api/invoices/([0-9]+)$'));
 if(req.method==='GET'&&invoiceMatch){
 const invoice=db.prepare('SELECT * FROM sale_invoices WHERE id=?').get(Number(invoiceMatch[1]));
 if(!invoice)return send(res,404,{error:'الفاتورة غير موجودة'});
 return send(res,200,{...invoice,lines:db.prepare('SELECT * FROM sale_items WHERE invoice_id=?').all(invoice.id)});
 }
 if(req.method==='POST'&&p==='/api/invoices'){
 const v=readJSON(body),lines=v.lines,status=v.status==='held'?'held':'paid',discount=Number(v.discount||0);
 if(!Array.isArray(lines)||!lines.length||!Number.isSafeInteger(discount)||discount<0)inputError('الفاتورة غير صحيحة');
 const result=transaction(()=>{
 let subtotal=0;const prepared=[];
 for(const line of lines){
 const product=db.prepare('SELECT * FROM products WHERE id=?').get(String(line.id));
 const qty=Number(line.qty);
 if(!product||!Number.isSafeInteger(qty)||qty<=0)inputError('مادة أو كمية غير صحيحة');
 const lineTotal=qty*product.price;
 if(!Number.isSafeInteger(lineTotal))inputError('القيمة كبيرة جدًا');
 subtotal+=lineTotal;prepared.push({product,qty,lineTotal});
 }
 if(discount>subtotal)inputError('الخصم أكبر من المجموع');
 const now=new Date().toISOString(),net=subtotal-discount;
 const payment=v.payment==='آجل'?'credit':v.payment==='بطاقة'?'bank':'cash';
 const insert=db.prepare('INSERT INTO sale_invoices(invoice_no,date,subtotal,discount,net,payment_method,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(null,now.slice(0,10),subtotal,discount,net,payment,status,now);
 const id=Number(insert.lastInsertRowid);
 db.prepare('UPDATE sale_invoices SET invoice_no=? WHERE id=?').run('S-'+String(id).padStart(6,'0'),id);
 for(const line of prepared){
 db.prepare('INSERT INTO sale_items(invoice_id,product_id,qty,price,line_total) VALUES(?,?,?,?,?)').run(id,line.product.id,line.qty,line.product.price,line.lineTotal);
 if(status==='paid')inventory(line.product.id,1,-line.qty,'sale','S-'+id);
 }
 return {id,net,status,invoice_no:'S-'+String(id).padStart(6,'0')};
 });
 return send(res,201,result);
 }
 const complete=p.match(new RegExp('^/api/held/([0-9]+)/complete$'));
 if(req.method==='POST'&&complete){
 const result=transaction(()=>{
 const id=Number(complete[1]),invoice=db.prepare('SELECT * FROM sale_invoices WHERE id=?').get(id);
 if(!invoice||invoice.status!=='held')inputError('الفاتورة ليست معلقة');
 for(const item of db.prepare('SELECT * FROM sale_items WHERE invoice_id=?').all(id))inventory(item.product_id,1,-item.qty,'sale','S-'+id);
 db.prepare("UPDATE sale_invoices SET status='paid' WHERE id=?").run(id);
 return {id,status:'paid'};
 });
 return send(res,200,result);
 }
 if(req.method==='GET'&&p==='/api/accounts')return send(res,200,db.prepare("SELECT a.id,a.code,a.name,a.type,a.parent_id,COALESCE(SUM(j.debit),0) AS debit,COALESCE(SUM(j.credit),0) AS credit FROM accounts a LEFT JOIN journal_items j ON j.account_id=a.id GROUP BY a.id ORDER BY a.code").all());
 if(req.method==='GET'&&p==='/api/journal')return send(res,200,db.prepare("SELECT e.id,e.date,e.description,e.reference,e.created_at,COALESCE(SUM(i.debit),0) AS debit,COALESCE(SUM(i.credit),0) AS credit FROM journal_entries e LEFT JOIN journal_items i ON i.entry_id=e.id GROUP BY e.id ORDER BY e.id DESC LIMIT 200").all());
 if(req.method==='POST'&&p==='/api/journal'){
 const v=readJSON(body),lines=v.lines;
 if(!Array.isArray(lines)||lines.length<2)inputError('القيد يحتاج سطرين على الأقل');
 const result=transaction(()=>{
 let debit=0,credit=0;
 for(const line of lines){
 const d=Number(line.debit||0),c=Number(line.credit||0);
 if(!db.prepare('SELECT id FROM accounts WHERE id=?').get(String(line.account_id))||!Number.isSafeInteger(d)||!Number.isSafeInteger(c)||d<0||c<0||(d>0&&c>0)||(d===0&&c===0))inputError('سطر قيد غير صحيح');
 debit+=d;credit+=c;
 }
 if(debit!==credit||debit<=0||!Number.isSafeInteger(debit))inputError('القيد غير متوازن');
 const now=new Date().toISOString(),date=String(v.date||now.slice(0,10));
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))inputError('تاريخ غير صحيح');
 const id=Number(db.prepare('INSERT INTO journal_entries(date,description,reference,created_at) VALUES(?,?,?,?)').run(date,String(v.description||''),String(v.reference||''),now).lastInsertRowid);
 for(const line of lines)db.prepare('INSERT INTO journal_items(entry_id,account_id,debit,credit,memo) VALUES(?,?,?,?,?)').run(id,String(line.account_id),Number(line.debit||0),Number(line.credit||0),String(line.memo||''));
 return {id,debit,credit};
 });
 return send(res,201,result);
 }
 if(req.method==='GET'&&p==='/api/stock/moves')return send(res,200,db.prepare('SELECT m.*,p.name AS product_name,w.name AS warehouse_name FROM inventory_moves m LEFT JOIN products p ON p.id=m.product_id LEFT JOIN warehouses w ON w.id=m.warehouse_id ORDER BY m.id DESC LIMIT 200').all());
 if(req.method==='GET'&&p==='/api/summary'){
 const sales=db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(net),0) AS sales FROM sale_invoices WHERE status='paid'").get();
 const today=db.prepare("SELECT COALESCE(SUM(net),0) AS total FROM sale_invoices WHERE status='paid' AND date=?").get(new Date().toISOString().slice(0,10));
 const stock=db.prepare('SELECT COUNT(*) AS products,COALESCE(SUM(stock),0) AS units FROM product_warehouse').get();
 return send(res,200,{...sales,todaySales:today.total,products:all().length,stockUnits:stock.units,held:db.prepare("SELECT COUNT(*) AS n FROM sale_invoices WHERE status='held'").get().n});
 }
 return send(res,404,{error:'المسار غير موجود'});
 }catch(e){send(res,e.status||(/constraint|unique|foreign key/i.test(e.message)?400:500),{error:e.status?e.message:/constraint|unique|foreign key/i.test(e.message)?'تعارض في البيانات المدخلة':e.message})}
 });
});
const host=process.env.ALMAHASIB_HOST||'127.0.0.1',port=Number(process.env.PORT||3765);
server.listen(port,host,()=>console.log('AlMahasibPro Desktop: http://'+host+':'+port+' | DB: '+dbPath));
