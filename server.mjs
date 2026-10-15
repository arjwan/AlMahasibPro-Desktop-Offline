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
    
    if(currentVersion<1){
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
    
    if(currentVersion<2){
        log('Migrating to v2 (Adding missing columns/indexes)');
        // Ensure cost exists in products if old DB was used
        const cols=db.prepare('PRAGMA table_info(products)').all();
        if(!cols.find(c=>c.name==='cost')){
            db.exec('ALTER TABLE products ADD COLUMN cost INTEGER NOT NULL DEFAULT 0 CHECK(cost>=0)');
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_journal_account ON journal_items(account_id)');
        db.exec('PRAGMA user_version=2');
    }
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

const all=()=>db.prepare('SELECT * FROM products ORDER by id').all();
function send(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body))}

const server=http.createServer((req,res)=>{
    let body='';
    req.on('data',chunk=>body+=chunk);
    req.on('end',async()=>{
        try{
            const url=new URL(req.url,'http://localhost');
            if(req.method==='GET'&&url.pathname==='/'){
                res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
                res.end(fs.readFileSync(path.join(root,'index.html')));
                return;
            }
            if(req.method==='GET'&&url.pathname==='/api/health'){
                send(res,200,{status:'ok',version:'1.0.0'});
                return;
            }
            if(req.method==='GET'&&url.pathname==='/api/products'){
                send(res,200,all());
                return;
            }
            // Rest of APIs will be implemented here...
            send(res,404,{error:'Not Found'});
        }catch(e){
            send(res,500,{error:e.message});
        }
    })});
const host=process.env.ALMAHASIB_HOST||'127.0.0.1';const port=Number(process.env.PORT||3765);server.listen(port,host,()=>console.log(`AlMahasibPro Desktop: http://${host}:${port} | DB: ${dbPath}`));

