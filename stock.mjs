// Local warehouse documents, shared-unit barcodes and physical batch ledger.
export function stockERP({db,inputError,inventory,erp,transaction,postJournal,send,readJSON}){
 const day=()=>new Date().toISOString().slice(0,10);
 const fail=inputError;
 const int=(v,min=0)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<min)fail('الكمية أو القيمة غير صحيحة');return n};
 const date=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('تاريخ غير صحيح');return v};
 const product=id=>{const p=db.prepare('SELECT * FROM products WHERE id=?').get(String(id));if(!p)fail('المادة غير موجودة');return p};
 for(const name of ['color','size'])if(!db.prepare('PRAGMA table_info(products)').all().some(x=>x.name===name))db.exec(`ALTER TABLE products ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
 db.exec(`CREATE TABLE IF NOT EXISTS stock_barcodes(code TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),unit TEXT NOT NULL,factor INTEGER NOT NULL CHECK(factor>0));
 CREATE TABLE IF NOT EXISTS stock_batches(id INTEGER PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),lot TEXT NOT NULL DEFAULT '',expiry TEXT NOT NULL DEFAULT '',qty INTEGER NOT NULL CHECK(qty>=0),UNIQUE(product_id,warehouse_id,lot,expiry));
 CREATE TABLE IF NOT EXISTS stock_documents(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,posted_at TEXT);
 CREATE TABLE IF NOT EXISTS stock_recipes(product_id TEXT NOT NULL REFERENCES products(id),component_id TEXT NOT NULL REFERENCES products(id),qty INTEGER NOT NULL CHECK(qty>0),PRIMARY KEY(product_id,component_id),CHECK(product_id<>component_id));
 CREATE TABLE IF NOT EXISTS stock_batch_moves(id INTEGER PRIMARY KEY,move_id INTEGER NOT NULL REFERENCES inventory_moves(id),batch_id INTEGER NOT NULL REFERENCES stock_batches(id),delta INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS stock_label_templates(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);`);
 // Preserve pre-existing stock as an undated batch; never invent expiry dates.
 db.exec(`INSERT OR IGNORE INTO stock_batches(product_id,warehouse_id,lot,expiry,qty) SELECT product_id,warehouse_id,'','',stock FROM product_warehouse;
 UPDATE stock_batches SET qty=qty+MAX(0,COALESCE((SELECT stock FROM product_warehouse w WHERE w.product_id=stock_batches.product_id AND w.warehouse_id=stock_batches.warehouse_id),0)-COALESCE((SELECT SUM(b.qty) FROM stock_batches b WHERE b.product_id=stock_batches.product_id AND b.warehouse_id=stock_batches.warehouse_id),0)) WHERE lot='' AND expiry='';`);
 let context=null;
 function withBatch(meta,fn){const previous=context;context=meta;try{return fn()}finally{context=previous}}
 function beforeMove(id,warehouse,delta,type,reference){
  if(delta<0){let left=-delta;
   const batches=db.prepare('SELECT * FROM stock_batches WHERE product_id=? AND warehouse_id=? AND qty>0 ORDER BY CASE WHEN expiry=\'\' THEN 1 ELSE 0 END,expiry,id').all(id,warehouse);
   const chosen=batches.filter(b=>(!b.expiry||b.expiry>=day())&&(!context?.lot||b.lot===context.lot)&&(!context?.expiry||b.expiry===context.expiry));
   if(chosen.reduce((s,b)=>s+b.qty,0)<left)fail('الرصيد الصالح غير كاف؛ يمنع صرف المنتهي');
   const used=[];for(const b of chosen){const qty=Math.min(left,b.qty);if(!qty)continue;db.prepare('UPDATE stock_batches SET qty=qty-? WHERE id=?').run(qty,b.id);used.push({...b,qty});left-=qty;if(!left)break}
   if(type==='transfer')transferBatches.set(reference,used);
   return used.map(b=>({id:b.id,delta:-b.qty}));
  }
  const incoming=type==='transfer'?transferBatches.get(reference):null;
  let returned=null;
  if(type==='return'&&/^R-\d+$/.test(reference)){
   const document=db.prepare("SELECT * FROM document_returns WHERE id=? AND kind='sale'").get(Number(reference.slice(2)));
   if(document){
    const source=db.prepare(`SELECT b.lot,b.expiry,-m.delta AS qty FROM stock_batch_moves m JOIN stock_batches b ON b.id=m.batch_id JOIN inventory_moves i ON i.id=m.move_id WHERE i.product_id=? AND i.warehouse_id=? AND m.delta<0 AND (i.reference=? OR i.reference IN(SELECT 'SHIP-'||id FROM shipments WHERE invoice_id=?)) ORDER BY m.id`).all(id,warehouse,'S-'+document.invoice_id,document.invoice_id);
    let skip=db.prepare("SELECT COALESCE(SUM(l.qty),0) AS qty FROM document_return_lines l JOIN document_returns r ON r.id=l.return_id WHERE r.kind='sale' AND r.invoice_id=? AND l.product_id=?").get(document.invoice_id,id).qty,left=delta;
    if(source.length){returned=[];for(const b of source){const ignored=Math.min(skip,b.qty);skip-=ignored;const qty=Math.min(left,b.qty-ignored);if(qty){returned.push({...b,qty});left-=qty}if(!left)break}if(left)fail('لا توجد وجبات أصلية كافية للمرتجع')}
   }
  }
  const rows=incoming||returned||[{lot:context?.lot||'',expiry:context?.expiry||'',qty:delta}];
  const changes=[];
  for(const b of rows){db.prepare('INSERT INTO stock_batches(product_id,warehouse_id,lot,expiry,qty) VALUES(?,?,?,?,?) ON CONFLICT(product_id,warehouse_id,lot,expiry) DO UPDATE SET qty=qty+excluded.qty').run(id,warehouse,b.lot,b.expiry,b.qty);const row=db.prepare('SELECT id FROM stock_batches WHERE product_id=? AND warehouse_id=? AND lot=? AND expiry=?').get(id,warehouse,b.lot,b.expiry);changes.push({id:row.id,delta:b.qty})}
  if(incoming)transferBatches.delete(reference);return changes;
 }
 const transferBatches=new Map();
 function afterMove(moveId,changes){for(const c of changes)db.prepare('INSERT INTO stock_batch_moves(move_id,batch_id,delta) VALUES(?,?,?)').run(moveId,c.id,c.delta)}
 function normalize(v){
  if(!['in','out','return-in','return-out','assemble','disassemble'].includes(v.kind))fail('نوع المستند غير صحيح');
  const warehouse_id=int(v.warehouse_id,1);if(!db.prepare('SELECT id FROM warehouses WHERE id=?').get(warehouse_id))fail('المخزن غير موجود');
  if(!Array.isArray(v.lines)||!v.lines.length||v.lines.length>500)fail('أضف مواد المستند');
  const lines=v.lines.map(l=>{const alias=l.code?db.prepare('SELECT * FROM stock_barcodes WHERE code=?').get(String(l.code)):null,p=product(alias?.product_id||l.product_id),factor=alias?.factor||1,qty=int(l.qty,1)*factor;int(qty,1);return {product_id:p.id,qty,cost:int(l.cost??p.cost),lot:String(l.lot||'').trim(),expiry:l.expiry?date(l.expiry):''}});
  const reason=String(v.reason||'').trim();if(!reason)fail('بيان المستند مطلوب');
  if(v.kind.includes('return')&&!String(v.reference||'').trim())fail('مرجع المستند الأصلي مطلوب للمرتجع');
  if(['assemble','disassemble'].includes(v.kind)&&lines.length!==1)fail('حدد سيتاً واحداً');
  return {kind:v.kind,warehouse_id,reason,reference:String(v.reference||''),lines};
 }
 function detail(id){const d=db.prepare('SELECT * FROM stock_documents WHERE id=?').get(int(id,1));if(!d)fail('المستند غير موجود');return {...d,payload:JSON.parse(d.payload)}}
 function post(id,revision){
  const d=detail(id);if(d.status!=='draft')fail('المستند معتمد بالفعل');if(int(revision,1)!==d.revision)fail('تغير المستند؛ أعد فتحه');erp.periodOpen();
  const v=normalize(d.payload),ref='STK-'+d.id;let debit=0,credit=0;
  const move=(l,delta,cost)=>withBatch(l,()=>inventory(l.product_id,v.warehouse_id,delta,'adjustment',ref,cost));
  if(['assemble','disassemble'].includes(v.kind)){
   const line=v.lines[0],recipe=db.prepare('SELECT * FROM stock_recipes WHERE product_id=?').all(line.product_id);if(!recipe.length)fail('حدد مكونات السيت أولاً');
   const assembly=v.kind==='assemble';let total=0;
   if(assembly){const expiries=[];for(const c of recipe){const qty=int(c.qty*line.qty,1),value=erp.inventoryCost(c.component_id,qty);move({product_id:c.component_id},-qty,value);total+=value;expiries.push(...db.prepare('SELECT b.expiry FROM stock_batch_moves m JOIN stock_batches b ON b.id=m.batch_id JOIN inventory_moves i ON i.id=m.move_id WHERE i.reference=? AND i.product_id=? AND m.delta<0 AND b.expiry<>\'\'').all(ref,c.component_id).map(b=>b.expiry))}int(total);const earliest=[...expiries,...(line.expiry?[line.expiry]:[])].sort()[0]||'';move({...line,expiry:earliest},line.qty,total)}
   else {total=erp.inventoryCost(line.product_id,line.qty);move(line,-line.qty,total);const expiry=db.prepare('SELECT MIN(NULLIF(b.expiry,\'\')) AS expiry FROM stock_batch_moves m JOIN stock_batches b ON b.id=m.batch_id JOIN inventory_moves i ON i.id=m.move_id WHERE i.reference=? AND m.delta<0').get(ref).expiry||'';const weights=recipe.map(c=>int(product(c.component_id).cost*c.qty)),sum=weights.reduce((s,n)=>s+n,0);let allocated=0;recipe.forEach((c,i)=>{const value=i===recipe.length-1?total-allocated:sum?Number(BigInt(total)*BigInt(weights[i])/BigInt(sum)):Math.floor(total/recipe.length);allocated+=value;move({...line,expiry,product_id:c.component_id},int(c.qty*line.qty,1),value)})}
  }else {
   const original=v.kind==='return-in'&&/^STK-\d+$/.test(v.reference)?detail(Number(v.reference.slice(4))):null;
   if(original&&(original.status!=='posted'||!['out','return-out'].includes(original.kind)||original.payload.warehouse_id!==v.warehouse_id))fail('مرجع المرتجع لا يخص مستند إخراج معتمد من المخزن نفسه');
   const returned=new Map();if(original)for(const prior of db.prepare("SELECT payload FROM stock_documents WHERE status='posted' AND kind='return-in'").all()){const payload=JSON.parse(prior.payload);if(payload.reference===v.reference)for(const l of payload.lines)returned.set(l.product_id,(returned.get(l.product_id)||0)+l.qty)}
   for(const l of v.lines){const incoming=['in','return-in'].includes(v.kind),value=incoming?int(l.cost*l.qty):erp.inventoryCost(l.product_id,l.qty);
    if(original){let skip=returned.get(l.product_id)||0,left=l.qty,allocated=0;const source=db.prepare('SELECT b.lot,b.expiry,-m.delta AS qty FROM stock_batch_moves m JOIN stock_batches b ON b.id=m.batch_id JOIN inventory_moves i ON i.id=m.move_id WHERE i.reference=? AND i.product_id=? AND m.delta<0 ORDER BY m.id').all(v.reference,l.product_id);for(const b of source){const ignored=Math.min(skip,b.qty);skip-=ignored;const qty=Math.min(left,b.qty-ignored);if(qty){const amount=left===qty?value-allocated:Number(BigInt(value)*BigInt(qty)/BigInt(l.qty));move({...l,lot:b.lot,expiry:b.expiry},qty,amount);allocated+=amount;left-=qty}if(!left)break}if(left)fail('كمية المرتجع أكبر من المتبقي في المستند الأصلي');returned.set(l.product_id,(returned.get(l.product_id)||0)+l.qty)}
    else move(l,incoming?l.qty:-l.qty,value);if(incoming)debit+=value;else credit+=value;
   }
  }
  if(debit||credit)postJournal(v.reason,ref,[['102',debit,credit],['502',credit,debit]]);
  db.prepare("UPDATE stock_documents SET status='posted',posted_at=? WHERE id=?").run(new Date().toISOString(),d.id);erp.audit('stock-document-post',d.id,{kind:v.kind});return detail(d.id);
 }
 function handle(req,res,p,body,url){
  if(!p.startsWith('/api/stock/'))return false;const get=req.method==='GET',write=req.method==='POST',v=write?readJSON(body):{},ok=(data,status=200)=>{send(res,status,data);return true};
  if(get&&p==='/api/stock/catalog')return ok(db.prepare('SELECT * FROM products ORDER BY name').all().map(p=>({...p,barcodes:db.prepare('SELECT * FROM stock_barcodes WHERE product_id=?').all(p.id),components:db.prepare('SELECT * FROM stock_recipes WHERE product_id=?').all(p.id)})));
  if(write&&p==='/api/stock/product')return ok(transaction(()=>{const p=product(v.product_id);db.prepare('UPDATE products SET category=?,color=?,size=?,price=? WHERE id=?').run(String(v.category||''),String(v.color||''),String(v.size||''),int(v.price??p.price),p.id);erp.audit('stock-product',p.id);return {ok:true}}));
  if(write&&p==='/api/stock/barcodes')return ok(transaction(()=>{const p=product(v.product_id),code=String(v.code||'').trim(),unit=String(v.unit||'حبة').trim(),factor=int(v.factor,1);if(!code||!unit)fail('الباركود والوحدة مطلوبان');const primary=db.prepare('SELECT id FROM products WHERE barcode=? OR id=?').all(code,code);if(primary.some(x=>x.id!==p.id)||(primary.length&&factor!==1))fail('الرمز مستخدم أو يتعارض مع وحدة الحبة');const prior=db.prepare('SELECT * FROM stock_barcodes WHERE code=?').get(code);if(prior)fail('الباركود مستخدم بالفعل');db.prepare('INSERT INTO stock_barcodes VALUES(?,?,?,?)').run(code,p.id,unit,factor);erp.audit('stock-barcode',p.id,{code,factor});return {ok:true}}),201);
  if(write&&p==='/api/stock/recipe')return ok(transaction(()=>{const p=product(v.product_id);if(!Array.isArray(v.components)||!v.components.length)fail('أضف مكونات السيت');if(db.prepare('SELECT 1 FROM product_warehouse WHERE product_id=? AND stock>0').get(p.id)||db.prepare('SELECT 1 FROM stock_recipes WHERE component_id=?').get(p.id))fail('لا يمكن تغيير مكونات سيت ذي رصيد أو مكوّن مستخدم');const seen=new Set();const rows=v.components.map(c=>{const id=product(c.product_id).id;if(id===p.id||seen.has(id)||db.prepare('SELECT 1 FROM stock_recipes WHERE product_id=?').get(id))fail('مكونات مكررة أو متداخلة');seen.add(id);return {id,qty:int(c.qty,1)}});db.prepare('DELETE FROM stock_recipes WHERE product_id=?').run(p.id);for(const c of rows)db.prepare('INSERT INTO stock_recipes VALUES(?,?,?)').run(p.id,c.id,c.qty);erp.audit('stock-recipe',p.id);return {ok:true}}));
  if(get&&p==='/api/stock/batches')return ok(db.prepare('SELECT b.*,p.name,w.name AS warehouse FROM stock_batches b JOIN products p ON p.id=b.product_id JOIN warehouses w ON w.id=b.warehouse_id WHERE b.qty>0 ORDER BY p.name,b.expiry').all());
  if(get&&p==='/api/stock/card'){const id=product(url.searchParams.get('product_id')).id;const warehouse=url.searchParams.get('warehouse_id');const rows=db.prepare('SELECT m.*,w.name AS warehouse FROM inventory_moves m LEFT JOIN warehouses w ON w.id=m.warehouse_id WHERE product_id=? AND (? IS NULL OR warehouse_id=?) ORDER BY m.id').all(id,warehouse,warehouse);let balance=0;return ok(rows.map(x=>({...x,balance:balance+=x.delta})));}
  if(get&&p==='/api/stock/documents')return ok(db.prepare('SELECT * FROM stock_documents ORDER BY id DESC').all().map(x=>({...x,payload:JSON.parse(x.payload)})));
  if(write&&p==='/api/stock/documents')return ok(transaction(()=>{const payload=normalize(v);let id;if(v.id){const d=detail(v.id);if(d.status!=='draft'||int(v.expected_revision,1)!==d.revision)fail('المستند معتمد أو تغير');id=d.id;db.prepare('UPDATE stock_documents SET payload=?,kind=?,revision=revision+1 WHERE id=?').run(JSON.stringify(payload),payload.kind,id)}else id=Number(db.prepare('INSERT INTO stock_documents(kind,payload,created_at) VALUES(?,?,?)').run(payload.kind,JSON.stringify(payload),new Date().toISOString()).lastInsertRowid);erp.audit('stock-document-save',id);return v.status==='posted'?post(id,detail(id).revision):detail(id)}),201);
  const match=p.match(/^\/api\/stock\/documents\/(\d+)(\/post)?$/);if(match&&get&&!match[2])return ok(detail(match[1]));if(match&&write&&match[2])return ok(transaction(()=>post(match[1],v.expected_revision)));
  if(get&&p==='/api/stock/label-templates')return ok(db.prepare('SELECT * FROM stock_label_templates ORDER BY name').all().map(x=>({...x,payload:JSON.parse(x.payload)})));
  if(write&&p==='/api/stock/label-templates')return ok(transaction(()=>{const name=String(v.name||'').trim(),width=int(v.width,20),height=int(v.height,15),font=int(v.font,8);if(!name||width>150||height>150||font>40)fail('أبعاد الملصق غير صحيحة');const payload={width,height,font,show_name:v.show_name!==false,show_price:v.show_price!==false};db.prepare('INSERT INTO stock_label_templates(name,payload) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload').run(name,JSON.stringify(payload));return {ok:true}}));
  if(get&&p==='/api/stock/label'){const code=url.searchParams.get('code')||'',alias=db.prepare('SELECT * FROM stock_barcodes WHERE code=?').get(code);const p=alias?product(alias.product_id):db.prepare('SELECT * FROM products WHERE barcode=? OR id=?').get(code,code);if(!p)fail('الباركود غير موجود');return ok({code,name:p.name,unit:alias?.unit||'حبة',price:int(p.price*(alias?.factor||1)),currency:'IQD'})}
  return false;
 }
 return {handle,beforeMove,afterMove,withBatch};
}
