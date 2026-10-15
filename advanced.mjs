import crypto from 'node:crypto';
export function advancedERP({db,inputError,postJournal,inventory,erp}){
 const now=()=>new Date().toISOString(),today=()=>now().slice(0,10);
 const column=(table,name,type)=>{if(!db.prepare('PRAGMA table_info('+table+')').all().some(x=>x.name===name))db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type)};
 column('sale_items','loaded_qty','INTEGER NOT NULL DEFAULT 0');
 column('sale_invoices','shipping_version','INTEGER NOT NULL DEFAULT 0');
 db.exec(`CREATE TABLE IF NOT EXISTS shipments(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES sale_invoices(id), date TEXT NOT NULL, net INTEGER NOT NULL, paid INTEGER NOT NULL, cost INTEGER NOT NULL, journal_id INTEGER REFERENCES journal_entries(id));
 CREATE TABLE IF NOT EXISTS shipment_lines(id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id), item_id INTEGER NOT NULL REFERENCES sale_items(id), qty INTEGER NOT NULL CHECK(qty>0), net INTEGER NOT NULL, cost INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS period_closings(id INTEGER PRIMARY KEY, period_id INTEGER NOT NULL REFERENCES fiscal_periods(id), entry_id INTEGER REFERENCES journal_entries(id), reversed_by INTEGER REFERENCES journal_entries(id), created_at TEXT NOT NULL);
 `);
 db.exec("UPDATE sale_items SET loaded_qty=qty WHERE invoice_id IN(SELECT id FROM sale_invoices WHERE status='paid' AND shipping_version=0)");
 db.prepare('INSERT OR IGNORE INTO accounts(id,code,name,type,parent_id) VALUES(?,?,?,?,?)').run('301','3010','الأرباح المحتجزة','equity','3');
 function integer(x,label,min=0){const n=Number(x);if(!Number.isSafeInteger(n)||n<min)inputError(label+' غير صحيح');return n}
 const ratio=(n,a,b)=>b?Number(BigInt(n)*BigInt(a)/BigInt(b)):0;
 function load(invoice,v){
  if(!['approved','partial'].includes(invoice.workflow))inputError('اعتمد الفاتورة قبل التحميل');
  if(v.expected_version!==undefined&&integer(v.expected_version,'إصدار التحميل')!==invoice.shipping_version)inputError('تغيرت الكميات المحملة؛ أعد تحميل الفاتورة');
  const items=db.prepare('SELECT * FROM sale_items WHERE invoice_id=? ORDER BY id').all(invoice.id),selected=v.lines??items.filter(x=>x.qty>x.loaded_qty).map(x=>({item_id:x.id,qty:x.qty-x.loaded_qty}));
  if(!Array.isArray(selected)||!selected.length)inputError('حدد كميات التحميل');
  const seen=new Set(),lines=[];let net=0,cost=0;
  for(const line of selected){const id=integer(line.item_id,'سطر المادة',1),qty=integer(line.qty,'الكمية',1),item=items.find(x=>x.id===id);if(!item||seen.has(id)||qty>item.qty-item.loaded_qty)inputError('كمية التحميل أكبر من المتبقي أو السطر مكرر');seen.add(id);const amount=ratio(item.net_amount??item.line_total,item.loaded_qty+qty,item.qty)-ratio(item.net_amount??item.line_total,item.loaded_qty,item.qty);net+=amount;lines.push({item,qty,net:amount})}
  // Release this invoice's reservation only inside the dispatch transaction.
  db.prepare('UPDATE stock_reservations SET active=0 WHERE invoice_id=?').run(invoice.id);
  const shipment=Number(db.prepare('INSERT INTO shipments(invoice_id,date,net,paid,cost) VALUES(?,?,?,?,?)').run(invoice.id,now(),net,0,0).lastInsertRowid),reference='SHIP-'+shipment;
  for(const line of lines){const value=erp.inventoryCost(line.item.product_id,line.qty);cost+=value;inventory(line.item.product_id,invoice.warehouse_id,-line.qty,'sale',reference,value);db.prepare('UPDATE sale_items SET loaded_qty=loaded_qty+?,cost_total=COALESCE(cost_total,0)+?,cost_snapshot=COALESCE(cost_snapshot,0) WHERE id=?').run(line.qty,value,line.item.id);db.prepare('INSERT INTO shipment_lines(shipment_id,item_id,qty,net,cost) VALUES(?,?,?,?,?)').run(shipment,line.item.id,line.qty,line.net,value)}
  const previous=db.prepare('SELECT COALESCE(SUM(net),0) AS n FROM shipments WHERE invoice_id=? AND id<>?').get(invoice.id,shipment).n,invoicePaid=invoice.paid??(invoice.payment_method==='credit'?0:invoice.net),paid=ratio(invoicePaid,previous+net,invoice.net)-ratio(invoicePaid,previous,invoice.net),cash=invoice.payment_method==='bank'?'103':'101';
  const journal=postJournal('تحميل '+invoice.invoice_no+' / '+shipment,reference,[[cash,paid,0],['104',net-paid,0],['401',0,net],['501',cost,0],['102',0,cost]]);
  db.prepare('UPDATE shipments SET paid=?,cost=?,journal_id=? WHERE id=?').run(paid,cost,journal,shipment);
  const remaining=db.prepare('SELECT product_id,SUM(qty-loaded_qty) AS qty FROM sale_items WHERE invoice_id=? GROUP BY product_id HAVING SUM(qty-loaded_qty)>0').all(invoice.id);
  for(const item of remaining)db.prepare('INSERT INTO stock_reservations(product_id,warehouse_id,qty,customer,start,end,invoice_id) VALUES(?,?,?,?,?,?,?)').run(item.product_id,invoice.warehouse_id,item.qty,invoice.invoice_no,today(),'9999-12-31',invoice.id);
  db.prepare('UPDATE sale_invoices SET workflow=?,status=?,shipping_version=shipping_version+1 WHERE id=?').run(remaining.length?'partial':'loaded',remaining.length?'held':'paid',invoice.id);
  erp.audit('partial-shipment',shipment,{invoice_id:invoice.id,net,paid,cost});return {id:invoice.id,shipment_id:shipment,net,paid,cost,complete:!remaining.length};
 }
 function closePeriod(row,reopen=false){
  if(reopen){
   if(!row.closed)inputError('الفترة مفتوحة بالفعل');
   if(db.prepare('SELECT id FROM fiscal_periods WHERE start>? AND closed=1').get(row.end))inputError('أعد فتح الفترات اللاحقة أولاً');
   db.prepare('UPDATE fiscal_periods SET closed=0 WHERE id=?').run(row.id);
   const closing=db.prepare('SELECT * FROM period_closings WHERE period_id=? AND reversed_by IS NULL ORDER BY id DESC LIMIT 1').get(row.id);
   if(closing?.entry_id){const lines=db.prepare('SELECT account_id,debit,credit FROM journal_items WHERE entry_id=?').all(closing.entry_id),id=postJournal('إعادة فتح '+row.name,'REOPEN-'+closing.id,lines.map(x=>[x.account_id,x.credit,x.debit]),row.end);db.prepare('UPDATE period_closings SET reversed_by=? WHERE id=?').run(id,closing.id)}
   erp.audit('period-reopen',row.id);return {ok:true};
  }
  if(row.closed)inputError('الفترة مغلقة بالفعل');
  if(row.end>today())inputError('لا تقفل فترة لم تنته بعد');
  // Close all nominal balances up to this cutoff. Earlier unclosed activity
  // cannot silently be carried forward in revenue/expense accounts.
  if(db.prepare('SELECT id FROM fiscal_periods WHERE end<? AND closed=0').get(row.start))inputError('أقفل الفترات السابقة أولاً');
  const balances=db.prepare("SELECT a.id,COALESCE(SUM(i.debit-i.credit),0) AS balance FROM accounts a LEFT JOIN journal_items i ON i.account_id=a.id LEFT JOIN journal_entries e ON e.id=i.entry_id WHERE a.type IN('revenue','expense') AND (e.date<=? OR e.id IS NULL) GROUP BY a.id").all(row.end);
  const lines=balances.filter(x=>x.balance).map(x=>[x.id,Math.max(0,-x.balance),Math.max(0,x.balance)]),net=balances.reduce((n,x)=>n+x.balance,0);if(net)lines.push(['301',Math.max(0,net),Math.max(0,-net)]);
  const reference='YEARCLOSE-'+crypto.randomUUID(),entry=postJournal('قيد إقفال '+row.name,reference,lines,row.end);
  db.prepare('INSERT INTO period_closings(period_id,entry_id,created_at) VALUES(?,?,?)').run(row.id,entry,now());db.prepare('UPDATE fiscal_periods SET closed=1 WHERE id=?').run(row.id);erp.audit('period-close',row.id,{entry});return {ok:true,entry_id:entry,profit:-net};
 }
 return {load,closePeriod};
}
