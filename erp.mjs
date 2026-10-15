import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export function extendERP({db,dbPath,send,inputError,readJSON,transaction,inventory,postJournal,postSale}){
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS branches(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, address TEXT DEFAULT '');
 CREATE TABLE IF NOT EXISTS agents(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '', branch_id INTEGER REFERENCES branches(id));
 CREATE TABLE IF NOT EXISTS fiscal_periods(id INTEGER PRIMARY KEY, name TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN(0,1)), CHECK(start<=end));
 CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY, date TEXT NOT NULL, action TEXT NOT NULL, entity TEXT, details TEXT);
 CREATE TABLE IF NOT EXISTS stock_reservations(id INTEGER PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), qty INTEGER NOT NULL CHECK(qty>0), customer TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, active INTEGER DEFAULT 1 CHECK(active IN(0,1)), CHECK(start<=end));
 CREATE TABLE IF NOT EXISTS document_returns(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('sale','purchase')), invoice_id INTEGER NOT NULL, date TEXT NOT NULL, amount INTEGER NOT NULL, cash_refund INTEGER NOT NULL, reason TEXT NOT NULL, entry_id INTEGER REFERENCES journal_entries(id));
 CREATE TABLE IF NOT EXISTS document_return_lines(id INTEGER PRIMARY KEY, return_id INTEGER NOT NULL REFERENCES document_returns(id), item_id INTEGER NOT NULL, product_id TEXT NOT NULL REFERENCES products(id), qty INTEGER NOT NULL, amount INTEGER NOT NULL, cost INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS journal_reversals(original_id INTEGER PRIMARY KEY REFERENCES journal_entries(id), reversal_id INTEGER NOT NULL UNIQUE REFERENCES journal_entries(id));
 CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY, user_name TEXT NOT NULL, opened_at TEXT NOT NULL, opening INTEGER NOT NULL, closed_at TEXT, counted INTEGER, expected INTEGER, difference INTEGER);
 CREATE TABLE IF NOT EXISTS fixed_assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, cost INTEGER NOT NULL CHECK(cost>0), residual INTEGER NOT NULL DEFAULT 0, months INTEGER NOT NULL CHECK(months>0), acquired TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), accumulated_account TEXT NOT NULL REFERENCES accounts(id), expense_account TEXT NOT NULL REFERENCES accounts(id), entry_id INTEGER REFERENCES journal_entries(id));
 CREATE TABLE IF NOT EXISTS asset_depreciation(id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES fixed_assets(id), month TEXT NOT NULL, amount INTEGER NOT NULL, entry_id INTEGER NOT NULL REFERENCES journal_entries(id), UNIQUE(asset_id,month));
 CREATE TABLE IF NOT EXISTS budgets(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), year INTEGER NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0), UNIQUE(account_id,year));
 CREATE TABLE IF NOT EXISTS bank_reconciliations(id INTEGER PRIMARY KEY, date TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), book_balance INTEGER NOT NULL, statement_balance INTEGER NOT NULL, difference INTEGER NOT NULL, description TEXT);
 CREATE TABLE IF NOT EXISTS request_keys(key TEXT PRIMARY KEY, route TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL);
 `);
 function column(table,name,type){if(!db.prepare('PRAGMA table_info('+table+')').all().some(x=>x.name===name)){db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type);return true}return false}
 column('purchase_invoices','warehouse_id','INTEGER NOT NULL DEFAULT 1');if(column('purchase_invoices','paid','INTEGER NOT NULL DEFAULT 0'))db.exec("UPDATE purchase_invoices SET paid=COALESCE((SELECT SUM(i.credit) FROM journal_items i JOIN journal_entries e ON e.id=i.entry_id WHERE e.reference=purchase_invoices.invoice_no AND i.account_id='101'),CASE WHEN payment_status='paid' THEN net ELSE 0 END)");
 column('stock_reservations','invoice_id','INTEGER');
 column('sale_invoices','source',"TEXT NOT NULL DEFAULT 'pos'");column('sale_invoices','workflow',"TEXT NOT NULL DEFAULT 'loaded'");
 column('sale_invoices','cancelled','INTEGER NOT NULL DEFAULT 0');column('sale_invoices','paid','INTEGER');column('sale_invoices','agent_id','INTEGER');column('sale_invoices','branch_id','INTEGER');
 column('sale_items','cost_snapshot','INTEGER');column('sale_items','net_amount','INTEGER');column('sale_items','product_name','TEXT');column('purchase_items','product_name','TEXT');column('audit_events','actor_id','TEXT');column('cash_vouchers','partner_id','TEXT');
 for(const [id,code,name,type,parent] of [['105','1050','الأصول الثابتة','asset','1'],['106','1060','مجمع الاندثار','asset','1'],['502','5020','فروق الجرد والصندوق','expense','5'],['503','5030','مصروف الاندثار','expense','5']])db.prepare('INSERT OR IGNORE INTO accounts(id,code,name,type,parent_id) VALUES(?,?,?,?,?)').run(id,code,name,type,parent);
 const now=()=>new Date().toISOString(),today=()=>now().slice(0,10);
 let actor=null;function setActor(id){actor=id}
 function audit(action,entity,details={}){db.prepare('INSERT INTO audit_events(date,action,entity,details,actor_id) VALUES(?,?,?,?,?)').run(now(),action,String(entity),JSON.stringify(details),actor)}
 function integer(v,label,min=0){const n=Number(v);if(!Number.isSafeInteger(n)||n<min)inputError(label+' غير صحيح');return n}
 function date(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(v))||Number.isNaN(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)inputError('تاريخ غير صحيح');return v}
 function periodOpen(day=today()){if(db.prepare('SELECT id FROM fiscal_periods WHERE closed=1 AND start<=? AND end>=?').get(day,day))inputError('الفترة المحاسبية مغلقة')}
 function reserved(product,warehouse){
 const rows=db.prepare('SELECT start,end,qty FROM stock_reservations WHERE product_id=? AND warehouse_id=? AND active=1 AND end>=?').all(product,warehouse,today());let maximum=0;
 for(const day of new Set([today(),...rows.map(x=>x.start<today()?today():x.start)]))maximum=Math.max(maximum,rows.filter(x=>x.start<=day&&x.end>=day).reduce((n,x)=>n+x.qty,0));return maximum;
 }
 function available(product,warehouse){return (db.prepare('SELECT stock FROM product_warehouse WHERE product_id=? AND warehouse_id=?').get(product,warehouse)?.stock||0)-reserved(product,warehouse)}
 function stockValue(){return db.prepare('SELECT p.*,w.warehouse_id,w.stock,h.name AS warehouse,COALESCE((SELECT SUM(r.qty) FROM stock_reservations r WHERE r.product_id=p.id AND r.warehouse_id=w.warehouse_id AND r.active=1 AND r.start<=? AND r.end>=?),0) AS reserved FROM products p JOIN product_warehouse w ON w.product_id=p.id JOIN warehouses h ON h.id=w.warehouse_id ORDER BY p.name,h.id').all(today(),today()).map(x=>({...x,available:x.stock-x.reserved,value:x.stock*x.cost}))}
 function one(table,id){const x=db.prepare('SELECT * FROM '+table+' WHERE id=?').get(id);if(!x)inputError('السجل غير موجود');return x}
 function postReturn(v){
  periodOpen();const kind=v.kind;if(!['sale','purchase'].includes(kind))inputError('نوع المرتجع غير صحيح');
  const invoiceId=integer(v.invoice_id,'رقم الفاتورة',1),sale=kind==='sale',invoice=one(sale?'sale_invoices':'purchase_invoices',invoiceId);
  if(sale&&invoice.status!=='paid')inputError('يمكن إرجاع فاتورة معتمدة فقط');
  if(!Array.isArray(v.lines)||!v.lines.length)inputError('أضف مواد المرتجع');
  const refund=integer(v.cash_refund||0,'المبلغ النقدي'),reason=String(v.reason||'').trim();if(!reason)inputError('سبب الإرجاع مطلوب');
  const prior=db.prepare('SELECT COALESCE(SUM(amount),0) AS amount,COALESCE(SUM(cash_refund),0) AS cash FROM document_returns WHERE kind=? AND invoice_id=?').get(kind,invoiceId);
  const seen=new Set(),lines=[];let total=0,totalCost=0;
  for(const line of v.lines){const itemId=integer(line.item_id,'سطر الفاتورة',1),qty=integer(line.qty,'الكمية',1);if(seen.has(itemId))inputError('سطر مكرر');seen.add(itemId);
   const item=one(sale?'sale_items':'purchase_items',itemId);if(item.invoice_id!==invoiceId)inputError('المادة لا تخص الفاتورة');
   const returned=db.prepare('SELECT COALESCE(SUM(l.qty),0) AS n FROM document_return_lines l JOIN document_returns r ON r.id=l.return_id WHERE r.kind=? AND r.invoice_id=? AND l.item_id=?').get(kind,invoiceId,itemId).n;
   if(qty>item.qty-returned)inputError('كمية المرتجع أكبر من المتبقي');
   if(sale&&item.cost_snapshot===null)inputError('الفاتورة قديمة ولا تحمل تكلفة محفوظة؛ تحتاج مراجعة محاسبية');
   // Cumulative allocation avoids rounding drift across partial returns.
   let netAmount=item.line_total;
   if(sale){if(item.net_amount!==null)netAmount=item.net_amount;else{const prefix=db.prepare('SELECT COALESCE(SUM(line_total),0) AS n FROM sale_items WHERE invoice_id=? AND id<?').get(invoiceId,item.id).n;netAmount=invoice.subtotal?Number((BigInt(prefix)+BigInt(item.line_total))*BigInt(invoice.net)/BigInt(invoice.subtotal)-BigInt(prefix)*BigInt(invoice.net)/BigInt(invoice.subtotal)):0}}
   const amount=Number(BigInt(netAmount)*BigInt(returned+qty)/BigInt(item.qty)-BigInt(netAmount)*BigInt(returned)/BigInt(item.qty));
   const cost=sale?item.cost_snapshot: item.cost;
   if(!sale&&available(item.product_id,invoice.warehouse_id)<qty)inputError('الرصيد المتاح لا يكفي لإرجاع المشتريات');
   total+=amount;totalCost+=qty*cost;lines.push({item,qty,amount,cost});
  }
  if(total+prior.amount>invoice.net||refund>total)inputError('مبلغ المرتجع غير صحيح');
  const paid=invoice.paid??(invoice.payment_method==='credit'?0:invoice.net);
  const outstanding=Math.max(0,invoice.net-paid-(prior.amount-prior.cash));
  if(total-refund>outstanding)inputError('حدد المبلغ النقدي المسترد بما يطابق رصيد الفاتورة');
  if(refund>Math.max(0,paid-prior.cash))inputError('المسترد النقدي أكبر من المدفوع المتبقي');
  const id=Number(db.prepare('INSERT INTO document_returns(kind,invoice_id,date,amount,cash_refund,reason) VALUES(?,?,?,?,?,?)').run(kind,invoiceId,today(),total,refund,reason).lastInsertRowid),ref='R-'+id;
  for(const l of lines){
   if(sale){const stock=db.prepare('SELECT COALESCE(SUM(stock),0) AS n FROM product_warehouse WHERE product_id=?').get(l.item.product_id).n,current=one('products',l.item.product_id).cost;db.prepare('UPDATE products SET cost=? WHERE id=?').run(Math.round((stock*current+l.qty*l.cost)/(stock+l.qty)),l.item.product_id)}
   inventory(l.item.product_id,invoice.warehouse_id,sale?l.qty:-l.qty,'return',ref);db.prepare('INSERT INTO document_return_lines(return_id,item_id,product_id,qty,amount,cost) VALUES(?,?,?,?,?,?)').run(id,l.item.id,l.item.product_id,l.qty,l.amount,l.cost)}
  const cash=invoice.payment_method==='bank'?'103':'101';
  const inventoryCost=sale?totalCost:lines.reduce((n,l)=>n+l.qty*one('products',l.item.product_id).cost,0);
  const entries=sale?[[cash,0,refund],['104',0,total-refund],['401',total,0],['102',totalCost,0],['501',0,totalCost]]:[['101',refund,0],['201',total-refund,0],['102',0,inventoryCost],['501',Math.max(0,inventoryCost-total),Math.max(0,total-inventoryCost)]];
  const entry=postJournal('مرتجع '+invoice.invoice_no,ref,entries);db.prepare('UPDATE document_returns SET entry_id=? WHERE id=?').run(entry,id);audit('return',id,{kind,invoiceId,total});return {id,amount:total,entry_id:entry};
 }
 function submitCompany(id){
 const invoice=one('sale_invoices',id);if(invoice.source!=='company'||invoice.status!=='held'||invoice.cancelled)inputError('الفاتورة غير متاحة للإرسال');
 const lines=db.prepare('SELECT product_id,SUM(qty) AS qty FROM sale_items WHERE invoice_id=? GROUP BY product_id').all(id);
 for(const line of lines){if(available(line.product_id,invoice.warehouse_id)<line.qty)inputError('الرصيد المتاح لا يكفي لإرسال الفاتورة');db.prepare('INSERT INTO stock_reservations(product_id,warehouse_id,qty,customer,start,end,invoice_id) VALUES(?,?,?,?,?,?,?)').run(line.product_id,invoice.warehouse_id,line.qty,invoice.invoice_no,today(),'9999-12-31',id)}
 db.prepare("UPDATE sale_invoices SET workflow='pending' WHERE id=?").run(id);audit('sale-submitted',id);
 }
 function handle(req,res,p,body,url){
  const get=req.method==='GET',post=req.method==='POST';
  const ok=(data,status=200)=>{send(res,status,data);return true};
  const v=post?readJSON(body):{};
  if(get&&p==='/api/audit')return ok(db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 500').all());
  if(get&&p==='/api/stock/balances')return ok(stockValue());
  if(get&&p==='/api/units')return ok(db.prepare('SELECT * FROM units ORDER BY name').all());
  if(post&&p==='/api/units'){const id=String(v.id||'').trim(),name=String(v.name||'').trim();if(!id||!name)inputError('الرمز والاسم مطلوبان');db.prepare('INSERT INTO units(id,name,abbreviation) VALUES(?,?,?)').run(id,name,String(v.abbreviation||''));return ok({id},201)}
  if(post&&p==='/api/warehouses'){const name=String(v.name||'').trim();if(!name)inputError('اسم المخزن مطلوب');const id=Number(db.prepare('INSERT INTO warehouses(name,location) VALUES(?,?)').run(name,String(v.location||'')).lastInsertRowid);audit('warehouse',id);return ok({id},201)}
  for(const [route,table] of [['/api/branches','branches'],['/api/agents','agents']]){
   if(get&&p===route)return ok(db.prepare('SELECT * FROM '+table+' ORDER BY id').all());
   if(post&&p===route){const name=String(v.name||'').trim();if(!name)inputError('الاسم مطلوب');const r=table==='branches'?db.prepare('INSERT INTO branches(name,address) VALUES(?,?)').run(name,String(v.address||'')):db.prepare('INSERT INTO agents(name,phone,branch_id) VALUES(?,?,?)').run(name,String(v.phone||''),v.branch_id?integer(v.branch_id,'الفرع',1):null);audit(table,r.lastInsertRowid.toString());return ok({id:Number(r.lastInsertRowid)},201)}
  }
  if(get&&p==='/api/settings')return ok(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x=>[x.key,x.value])));
  if(post&&p==='/api/settings')return ok(transaction(()=>{for(const key of ['company_name','company_phone','company_address','tax_number','receipt_footer'])if(v[key]!==undefined)db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(v[key]).slice(0,500));audit('settings','company');return {ok:true}}));
  if(post&&p==='/api/accounts'){const id='acc-'+crypto.randomUUID(),name=String(v.name||'').trim(),code=String(v.code||'').trim();if(!name||!code||!['asset','liability','equity','revenue','expense'].includes(v.type))inputError('بيانات الحساب غير صحيحة');if(v.parent_id&&one('accounts',String(v.parent_id)).type!==v.type)inputError('نوع الحساب لا يطابق الأصل');db.prepare('INSERT INTO accounts(id,code,name,type,parent_id) VALUES(?,?,?,?,?)').run(id,code,name,v.type,v.parent_id||null);audit('account',id);return ok({id},201)}
  if(get&&p==='/api/assets')return ok(db.prepare('SELECT a.*,COALESCE((SELECT SUM(amount) FROM asset_depreciation d WHERE d.asset_id=a.id),0) AS depreciation FROM fixed_assets a ORDER BY id DESC').all());
  if(post&&p==='/api/assets')return ok(transaction(()=>{periodOpen();const name=String(v.name||'').trim(),cost=integer(v.cost,'الكلفة',1),residual=integer(v.residual||0,'القيمة المتبقية'),months=integer(v.months,'أشهر الاندثار',1),acquired=date(v.acquired);periodOpen(acquired);if(!name||residual>cost||months>1200)inputError('بيانات الأصل غير صحيحة');const entry=postJournal('شراء أصل ثابت '+name,'ASSET-'+crypto.randomUUID(),[['105',cost,0],['101',0,cost]],acquired);const id=Number(db.prepare('INSERT INTO fixed_assets(name,cost,residual,months,acquired,account_id,accumulated_account,expense_account,entry_id) VALUES(?,?,?,?,?,?,?,?,?)').run(name,cost,residual,months,acquired,'105','106','503',entry).lastInsertRowid);audit('asset-create',id);return {id}}),201);
  const depreciation=p.match(/^\/api\/assets\/(\d+)\/depreciate$/);if(post&&depreciation)return ok(transaction(()=>{periodOpen();const asset=one('fixed_assets',Number(depreciation[1])),month=String(v.month||'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<asset.acquired.slice(0,7)||month>today().slice(0,7))inputError('شهر الاندثار غير صحيح');periodOpen(month+'-01');const prior=db.prepare('SELECT COALESCE(SUM(amount),0) AS amount,COUNT(*) AS n FROM asset_depreciation WHERE asset_id=?').get(asset.id);if(prior.n>=asset.months)inputError('الأصل مستهلك بالكامل');const amount=prior.n===asset.months-1?asset.cost-asset.residual-prior.amount:Math.floor((asset.cost-asset.residual)/asset.months);if(!amount)inputError('لا يوجد مبلغ اندثار لهذا الأصل');const entry=postJournal('اندثار '+asset.name+' '+month,'DEP-'+asset.id+'-'+month,[[asset.expense_account,amount,0],[asset.accumulated_account,0,amount]],month+'-01');db.prepare('INSERT INTO asset_depreciation(asset_id,month,amount,entry_id) VALUES(?,?,?,?)').run(asset.id,month,amount,entry);audit('depreciation',asset.id,{month,amount});return {amount,entry_id:entry}}),201);
  if(get&&p==='/api/budgets')return ok(db.prepare("SELECT b.*,a.name,COALESCE((SELECT SUM(i.debit-i.credit) FROM journal_items i JOIN journal_entries e ON e.id=i.entry_id WHERE i.account_id=b.account_id AND substr(e.date,1,4)=CAST(b.year AS TEXT)),0) AS actual FROM budgets b JOIN accounts a ON a.id=b.account_id ORDER BY b.year DESC,a.code").all());
  if(post&&p==='/api/budgets'){const year=integer(v.year,'السنة',2000),amount=integer(v.amount,'الموازنة');if(year>2200)inputError('السنة غير صحيحة');one('accounts',String(v.account_id));db.prepare('INSERT INTO budgets(account_id,year,amount) VALUES(?,?,?) ON CONFLICT(account_id,year) DO UPDATE SET amount=excluded.amount').run(String(v.account_id),year,amount);audit('budget',v.account_id,{year,amount});return ok({ok:true},201)}
  if(get&&p==='/api/bank/reconciliations')return ok(db.prepare('SELECT * FROM bank_reconciliations ORDER BY id DESC').all());
  if(post&&p==='/api/bank/reconciliations')return ok(transaction(()=>{const statement=Number(v.statement_balance);if(!Number.isSafeInteger(statement))inputError('رصيد كشف البنك غير صحيح');const balance=db.prepare("SELECT COALESCE(SUM(debit-credit),0) AS n FROM journal_items WHERE account_id='103'").get().n;const id=Number(db.prepare('INSERT INTO bank_reconciliations(date,account_id,book_balance,statement_balance,difference,description) VALUES(?,?,?,?,?,?)').run(today(),'103',balance,statement,statement-balance,String(v.description||'')).lastInsertRowid);audit('bank-reconciliation',id);return {id,book_balance:balance,difference:statement-balance}}),201);
  if(post&&p==='/api/stock/count')return ok(transaction(()=>{periodOpen();const product=one('products',String(v.product_id)),warehouse=integer(v.warehouse_id,'المخزن',1),counted=integer(v.counted,'الكمية الفعلية'),record=db.prepare('SELECT stock FROM product_warehouse WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse),stock=record?.stock||0;if(v.expected!==undefined&&Number(v.expected)!==stock)inputError('تغير الرصيد منذ فتح الجرد؛ أعد تحميل الصفحة');const delta=counted-stock,ref='COUNT-'+crypto.randomUUID();if(delta){inventory(product.id,warehouse,delta,'adjustment',ref);const amount=Math.abs(delta)*product.cost;postJournal('تسوية جرد '+product.name,ref,delta>0?[['102',amount,0],['502',0,amount]]:[['502',amount,0],['102',0,amount]])}audit('stock-count',ref,{product:product.id,warehouse,stock,counted});return {reference:ref,delta}}),201);
  if(post&&p==='/api/products/import')return ok(transaction(()=>{if(!Array.isArray(v.rows)||!v.rows.length||v.rows.length>10000)inputError('ملف الاستيراد غير صحيح');const ids=[];for(const row of v.rows){const id=String(row.id||'').trim(),name=String(row.name||'').trim(),price=integer(row.price,'السعر'),cost=integer(row.cost||0,'التكلفة');if(!id||!name)inputError('رمز واسم المادة مطلوبان');db.prepare('INSERT INTO products(id,name,barcode,price,cost,category,emoji) VALUES(?,?,?,?,?,?,?)').run(id,name,row.barcode?String(row.barcode):null,price,cost,String(row.category||''),'📦');ids.push(id)}audit('product-import','catalog',{count:ids.length});return {count:ids.length}}),201);
  if(get&&p==='/api/periods')return ok(db.prepare('SELECT * FROM fiscal_periods ORDER BY start DESC').all());
  if(post&&p==='/api/periods')return ok(transaction(()=>{const start=date(v.start),end=date(v.end);if(start>end||db.prepare('SELECT id FROM fiscal_periods WHERE start<=? AND end>=?').get(end,start))inputError('الفترة متداخلة أو تاريخها غير صحيح');const id=Number(db.prepare('INSERT INTO fiscal_periods(name,start,end) VALUES(?,?,?)').run(String(v.name||'فترة'),start,end).lastInsertRowid);audit('period-create',id);return {id}}),201);
  const period=p.match(/^\/api\/periods\/(\d+)\/(close|reopen)$/);
  if(post&&period)return ok(transaction(()=>{const row=one('fiscal_periods',Number(period[1]));db.prepare('UPDATE fiscal_periods SET closed=? WHERE id=?').run(period[2]==='close'?1:0,row.id);audit('period-'+period[2],row.id);return {ok:true}}));
  const reversal=p.match(/^\/api\/journal\/(\d+)\/reverse$/);
  if(post&&reversal)return ok(transaction(()=>{periodOpen();const id=Number(reversal[1]);one('journal_entries',id);if(db.prepare('SELECT * FROM journal_reversals WHERE original_id=? OR reversal_id=?').get(id,id))inputError('القيد معكوس سابقاً');const ref=one('journal_entries',id).reference||'';if(/^(S-|P-|R-|V-)/.test(ref))inputError('استخدم مرتجع المستند أو سنداً مقابلاً لتصحيح العملية');const lines=db.prepare('SELECT * FROM journal_items WHERE entry_id=?').all(id);const entry=postJournal('عكس قيد '+id,'REV-'+id,lines.map(x=>[x.account_id,x.credit,x.debit]));db.prepare('INSERT INTO journal_reversals(original_id,reversal_id) VALUES(?,?)').run(id,entry);audit('journal-reverse',id,{entry});return {id:entry}}),201);
  const cancel=p.match(/^\/api\/held\/(\d+)\/cancel$/);if(post&&cancel)return ok(transaction(()=>{const invoice=one('sale_invoices',Number(cancel[1]));if(invoice.status!=='held'||invoice.cancelled)inputError('المسودة غير متاحة');if(invoice.source==='company'&&['pending','approved'].includes(invoice.workflow)&&!['admin','manager'].includes(req.user.role))inputError('إلغاء الفاتورة المرسلة يحتاج المدير');db.prepare('UPDATE sale_invoices SET cancelled=1 WHERE id=?').run(invoice.id);db.prepare('UPDATE stock_reservations SET active=0 WHERE invoice_id=?').run(invoice.id);audit('draft-cancelled',invoice.id);return {ok:true}}));
  if(post&&p==='/api/stock/transfer')return ok(transaction(()=>{periodOpen();const from=integer(v.from,'مخزن المصدر',1),to=integer(v.to,'مخزن الوجهة',1),qty=integer(v.qty,'الكمية',1),product=String(v.product_id);if(from===to)inputError('حدد مخزنين مختلفين');one('warehouses',to);if(available(product,from)<qty)inputError('الرصيد المتاح غير كاف');const ref='T-'+crypto.randomUUID();inventory(product,from,-qty,'transfer',ref);inventory(product,to,qty,'transfer',ref);audit('stock-transfer',ref,{product,from,to,qty});return {reference:ref}}),201);
  if(get&&p==='/api/reservations')return ok(db.prepare('SELECT r.*,p.name AS product_name,w.name AS warehouse FROM stock_reservations r JOIN products p ON p.id=r.product_id JOIN warehouses w ON w.id=r.warehouse_id ORDER BY r.id DESC').all());
  if(post&&p==='/api/reservations')return ok(transaction(()=>{const product=String(v.product_id),warehouse=integer(v.warehouse_id,'المخزن',1),qty=integer(v.qty,'الكمية',1),start=date(v.start),end=date(v.end),customer=String(v.customer||'').trim();if(start>end||!customer)inputError('حدد الفترة والعميل');const stock=db.prepare('SELECT stock FROM product_warehouse WHERE product_id=? AND warehouse_id=?').get(product,warehouse)?.stock||0;
   const overlapping=db.prepare('SELECT start,end,qty FROM stock_reservations WHERE active=1 AND product_id=? AND warehouse_id=? AND start<=? AND end>=?').all(product,warehouse,end,start);
   // Check each point where active quantities can increase, not just today's balance.
   for(const day of new Set([start,...overlapping.map(x=>x.start<start?start:x.start)])){const booked=overlapping.filter(x=>x.start<=day&&x.end>=day).reduce((n,x)=>n+x.qty,0);if(booked+qty>stock)inputError('الرصيد لا يكفي للحجز خلال الفترة')}
   const id=Number(db.prepare('INSERT INTO stock_reservations(product_id,warehouse_id,qty,customer,start,end) VALUES(?,?,?,?,?,?)').run(product,warehouse,qty,customer,start,end).lastInsertRowid);audit('reserve',id);return {id}}),201);
  const release=p.match(/^\/api\/reservations\/(\d+)\/release$/);if(post&&release){const id=Number(release[1]);const record=one('stock_reservations',id);if(record.invoice_id)inputError('حجز الفاتورة يرفع بقرار رفضها أو إلغائها');db.prepare('UPDATE stock_reservations SET active=0 WHERE id=?').run(id);audit('release',id);return ok({ok:true})}
  const workflow=p.match(/^\/api\/company-sales\/(\d+)\/(approve|reject|load|submit)$/);
  if(post&&workflow)return ok(transaction(()=>{
   periodOpen();const invoice=one('sale_invoices',Number(workflow[1])),action=workflow[2];if(invoice.source!=='company'||invoice.cancelled||invoice.status!=='held')inputError('الفاتورة غير متاحة');
   const grants=req.user.role==='admin'?['sales','stock']:db.prepare('SELECT module FROM user_grants WHERE user_id=?').all(req.user.id).map(x=>x.module);
   if(['approve','reject'].includes(action)&&!['admin','manager'].includes(req.user.role))inputError('الموافقة والرفض للمدير');
   if(action==='submit'){if(!['draft','rejected'].includes(invoice.workflow))inputError('الفاتورة مرسلة سابقاً');submitCompany(invoice.id)}
   if(action==='approve'){if(invoice.workflow!=='pending')inputError('الفاتورة ليست بانتظار الموافقة');db.prepare("UPDATE sale_invoices SET workflow='approved' WHERE id=?").run(invoice.id)}
   if(action==='reject'){if(!['pending','approved'].includes(invoice.workflow))inputError('الفاتورة ليست بانتظار القرار');db.prepare("UPDATE sale_invoices SET workflow='rejected' WHERE id=?").run(invoice.id);db.prepare('UPDATE stock_reservations SET active=0 WHERE invoice_id=?').run(invoice.id)}
   if(action==='load'){
    if(!grants.includes('stock'))inputError('التحميل يحتاج صلاحية المخزن');if(invoice.workflow!=='approved')inputError('اعتمد الفاتورة قبل التحميل');
    db.prepare('UPDATE stock_reservations SET active=0 WHERE invoice_id=?').run(invoice.id);
    for(const item of db.prepare('SELECT * FROM sale_items WHERE invoice_id=?').all(invoice.id)){
     const product=one('products',item.product_id);db.prepare('UPDATE sale_items SET cost_snapshot=? WHERE id=?').run(product.cost,item.id);inventory(item.product_id,invoice.warehouse_id,-item.qty,'sale',invoice.invoice_no);
    }
    db.prepare("UPDATE sale_invoices SET workflow='loaded',status='paid' WHERE id=?").run(invoice.id);postSale(invoice.id);
   }
   audit('company-sale-'+action,invoice.id);return {id:invoice.id,action};
  }));
  if(get&&p==='/api/returns')return ok(db.prepare('SELECT * FROM document_returns ORDER BY id DESC').all());
  if(post&&p==='/api/returns')return ok(transaction(()=>postReturn(v)),201);
  const purchase=p.match(/^\/api\/purchases\/(\d+)$/);if(get&&purchase){const invoice=one('purchase_invoices',Number(purchase[1]));return ok({...invoice,lines:db.prepare('SELECT * FROM purchase_items WHERE invoice_id=?').all(invoice.id)})}
  if(get&&p==='/api/partners/statement'){
   const id=String(url.searchParams.get('id')||'');one('partners',id);
   const rows=[];
   for(const x of db.prepare("SELECT * FROM sale_invoices WHERE partner_id=? AND status='paid'").all(id))rows.push({date:x.date,reference:x.invoice_no,description:'مبيعات',debit:x.net-(x.paid??(x.payment_method==='credit'?0:x.net)),credit:0});
   for(const x of db.prepare('SELECT * FROM purchase_invoices WHERE partner_id=?').all(id))rows.push({date:x.date,reference:x.invoice_no,description:'مشتريات',debit:0,credit:x.net-x.paid});
   for(const x of db.prepare('SELECT * FROM cash_vouchers WHERE partner_id=?').all(id))rows.push({date:x.date,reference:'V-'+x.id,description:x.description,debit:x.kind==='payment'?x.amount:0,credit:x.kind==='receipt'?x.amount:0});
   for(const x of db.prepare("SELECT r.* FROM document_returns r LEFT JOIN sale_invoices s ON r.kind='sale' AND s.id=r.invoice_id LEFT JOIN purchase_invoices p ON r.kind='purchase' AND p.id=r.invoice_id WHERE COALESCE(s.partner_id,p.partner_id)=?").all(id))rows.push({date:x.date,reference:'R-'+x.id,description:'مرتجع',debit:x.kind==='purchase'?x.amount-x.cash_refund:0,credit:x.kind==='sale'?x.amount-x.cash_refund:0});
   rows.sort((a,b)=>a.date.localeCompare(b.date)||a.reference.localeCompare(b.reference));let balance=0;return ok(rows.map(x=>({...x,balance:balance+=x.debit-x.credit})));
  }
  if(get&&p==='/api/shifts')return ok(db.prepare('SELECT * FROM shifts ORDER BY id DESC').all());
  if(post&&p==='/api/shifts/open')return ok(transaction(()=>{if(db.prepare('SELECT id FROM shifts WHERE closed_at IS NULL').get())inputError('يوجد شفت مفتوح');const opening=integer(v.opening||0,'الرصيد الافتتاحي'),name=String(v.user_name||'').trim();if(!name)inputError('اسم الكاشير مطلوب');const id=Number(db.prepare('INSERT INTO shifts(user_name,opened_at,opening) VALUES(?,?,?)').run(name,now(),opening).lastInsertRowid);db.prepare("INSERT INTO settings(key,value) VALUES('shift_cash_start',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(db.prepare("SELECT COALESCE(SUM(debit-credit),0) AS n FROM journal_items WHERE account_id='101'").get().n));audit('shift-open',id);return {id}}),201);
  const close=p.match(/^\/api\/shifts\/(\d+)\/close$/);if(post&&close)return ok(transaction(()=>{const row=one('shifts',Number(close[1]));if(row.closed_at)inputError('الشفت مغلق');const counted=integer(v.counted,'المبلغ الفعلي'),cash=db.prepare("SELECT COALESCE(SUM(debit-credit),0) AS n FROM journal_items WHERE account_id='101'").get().n,start=Number(db.prepare("SELECT value FROM settings WHERE key='shift_cash_start'").get()?.value||0),expected=row.opening+cash-start;db.prepare('UPDATE shifts SET closed_at=?,counted=?,expected=?,difference=? WHERE id=?').run(now(),counted,expected,counted-expected,row.id);if(counted!==expected){const delta=counted-expected;postJournal('فرق إغلاق الصندوق','CLOSE-'+row.id,delta>0?[['101',delta,0],['502',0,delta]]:[['502',-delta,0],['101',0,-delta]])}audit('shift-close',row.id,{expected,counted});return {id:row.id,expected,counted,difference:counted-expected}}));
  if(get&&p==='/api/backup'){
   const folder=path.join(path.dirname(dbPath),'backups');fs.mkdirSync(folder,{recursive:true});const target=path.join(folder,'company-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex')+'.sqlite');db.prepare('VACUUM INTO ?').run(target);const data=fs.readFileSync(target);res.writeHead(200,{'Content-Type':'application/vnd.sqlite3','Content-Disposition':'attachment; filename="company-backup.sqlite"','Cache-Control':'no-store'});res.end(data);return true;
  }
  if(post&&p==='/api/backup/restore'){
   if(typeof v.base64!=='string'||v.base64.length>40e6)inputError('ملف النسخة غير صحيح أو كبير جداً');const file=path.join(path.dirname(dbPath),'restore-'+crypto.randomUUID()+'.sqlite'),buffer=Buffer.from(v.base64,'base64');if(buffer.subarray(0,16).toString()!=='SQLite format 3\u0000')inputError('الملف ليس قاعدة SQLite');fs.writeFileSync(file,buffer);let check;
   try{check=new DatabaseSync(file,{readOnly:true});if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')inputError('النسخة تالفة');const names=new Set(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));for(const name of ['users','products','accounts','journal_entries','journal_items','settings','sale_invoices','product_warehouse'])if(!names.has(name))inputError('النسخة ليست من هذا البرنامج');check.close();check=null;fs.renameSync(file,dbPath+'.restore-pending');audit('restore-staged','backup');return ok({ok:true,restart_required:true})}finally{if(check)check.close();if(fs.existsSync(file))fs.unlinkSync(file)}
  }
  return false;
 }
 db.exec('PRAGMA user_version=4');
 return {handle,audit,periodOpen,available,reserved,submitCompany,setActor};
}
