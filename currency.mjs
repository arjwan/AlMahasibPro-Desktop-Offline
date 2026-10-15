export function currencyERP({db,inputError,transaction,postJournal,erp,send,readJSON}){
 const column=(table,name,type)=>{if(!db.prepare('PRAGMA table_info('+table+')').all().some(x=>x.name===name))db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type)};
 for(const table of ['sale_invoices','purchase_invoices']){column(table,'currency',"TEXT NOT NULL DEFAULT 'IQD'");column(table,'exchange_rate',"TEXT NOT NULL DEFAULT '1'");column(table,'foreign_snapshot','TEXT')}
 db.exec(`CREATE TABLE IF NOT EXISTS currency_cash_moves(id INTEGER PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL, currency TEXT NOT NULL, foreign_amount INTEGER NOT NULL, base_amount INTEGER NOT NULL, carrying INTEGER NOT NULL, rate TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), partner_id TEXT REFERENCES partners(id), counterpart TEXT NOT NULL REFERENCES accounts(id), journal_id INTEGER REFERENCES journal_entries(id), description TEXT);
 CREATE TABLE IF NOT EXISTS exchange_rates(id INTEGER PRIMARY KEY, rate TEXT NOT NULL, approved_by TEXT NOT NULL, created_at TEXT NOT NULL);`);
 for(const [id,code,name,type,parent] of [['107','1070','الصندوق بالدولار','asset','1'],['108','1080','البنك بالدولار','asset','1'],['402','4020','أرباح فرق العملة','revenue','4'],['504','5040','خسائر فرق العملة','expense','5']])db.prepare('INSERT OR IGNORE INTO accounts(id,code,name,type,parent_id) VALUES(?,?,?,?,?)').run(id,code,name,type,parent);
 function positive(n,label,min=0){n=Number(n);if(!Number.isSafeInteger(n)||n<min)inputError(label+' غير صحيح');return n}
 function decimal(value,places,label){const text=String(value??'').trim();if(text.length>40||!new RegExp('^\\d+(?:\\.\\d{1,'+places+'})?$').test(text))inputError(label+' غير صحيح');const [whole,fraction='']=text.split('.');const n=BigInt(whole)*10n**BigInt(places)+BigInt(fraction.padEnd(places,'0'));if(n>BigInt(Number.MAX_SAFE_INTEGER))inputError(label+' كبير جداً');return Number(n)}
 function rate(){return db.prepare('SELECT rate FROM exchange_rates ORDER BY id DESC LIMIT 1').get()?.rate||null}
 function approvedRate(value){const active=rate();if(!active)inputError('اعتمد سعر الدولار من الإعدادات أولاً');if(value!==undefined&&String(value)!==active)inputError('تغير سعر الصرف؛ أعد تحميل البيانات');return active}
 function convert(cents,exchange){const scaled=decimal(exchange,6,'سعر الصرف');const denominator=100000000n,numerator=BigInt(positive(cents,'المبلغ بالدولار'))*BigInt(scaled);const result=Number((numerator+denominator/2n)/denominator);return positive(result,'المبلغ بالدينار')}
 function normalize(v,kind){
  v={...v,lines:Array.isArray(v.lines)?v.lines.map(({__base_total,...line})=>line):v.lines};delete v.__fx;
  if(!v.currency||v.currency==='IQD')return v;
  if(v.currency!=='USD')inputError('العملة غير مدعومة');const exchange=approvedRate(v.exchange_rate),original=JSON.parse(JSON.stringify(v));
  if(!Array.isArray(v.lines))inputError('مواد الفاتورة مطلوبة');
  let prefix=0;
  const lines=v.lines.map(line=>{const qty=positive(line.qty,'الكمية',1),key=kind==='sale'?'price':'cost',cents=decimal(line[key],2,'السعر بالدولار'),total=positive(qty*cents,'قيمة السطر بالدولار'),next=positive(prefix+total,'مجموع الفاتورة بالدولار'),base=convert(next,exchange)-convert(prefix,exchange);prefix=next;return {...line,[key]:convert(cents,exchange),__base_total:base}});
  const discountCents=kind==='sale'?decimal(v.discount||0,2,'الخصم بالدولار'):0;if(discountCents>prefix)inputError('الخصم أكبر من قيمة الفاتورة');
  const discount=convert(prefix,exchange)-convert(prefix-discountCents,exchange);
  // Payment is explicitly entered in IQD. Physical USD settlement uses the FX voucher endpoint.
  return {...v,lines,discount,__fx:{currency:'USD',rate:exchange,snapshot:JSON.stringify(original)}};
 }
 function snapshot(table,id,v){if(v.__fx)db.prepare('UPDATE '+table+' SET currency=?,exchange_rate=?,foreign_snapshot=? WHERE id=?').run('USD',v.__fx.rate,v.__fx.snapshot,id);else db.prepare('UPDATE '+table+" SET currency='IQD',exchange_rate='1',foreign_snapshot=NULL WHERE id=?").run(id)}
 function balances(){return ['107','108'].map(account=>{const rows=db.prepare('SELECT kind,foreign_amount,carrying FROM currency_cash_moves WHERE account_id=?').all(account);return {account_id:account,currency:'USD',foreign_cents:rows.reduce((n,x)=>n+(x.kind==='receipt'?x.foreign_amount:-x.foreign_amount),0),base_value:rows.reduce((n,x)=>n+(x.kind==='receipt'?x.carrying:-x.carrying),0)}})}
 function handle(req,res,p,body){
  const get=req.method==='GET',post=req.method==='POST',ok=(x,s=200)=>{send(res,s,x);return true};
  if(get&&p==='/api/currency')return ok({base:'IQD',rate:rate(),balances:balances()});
  if(post&&p==='/api/currency/rate'){
   if(!['admin','manager'].includes(req.user.role))inputError('اعتماد السعر للمدير');const v=readJSON(body),scaled=decimal(v.rate,6,'سعر الدولار');if(scaled<=0)inputError('سعر الصرف يجب أن يكون موجباً');const approved=String(v.rate);return ok(transaction(()=>{db.prepare('INSERT INTO exchange_rates(rate,approved_by,created_at) VALUES(?,?,?)').run(approved,req.user.id,new Date().toISOString());erp.audit('exchange-rate','USD',{rate:approved});return {rate:approved}}),201);
  }
  if(post&&p==='/api/currency/quote'){const v=readJSON(body),exchange=approvedRate(v.rate);return ok({base_amount:convert(decimal(v.amount,2,'المبلغ'),exchange),rate:exchange})}
  if(get&&p==='/api/currency/vouchers')return ok(db.prepare('SELECT * FROM currency_cash_moves ORDER BY id DESC').all());
  if(post&&p==='/api/currency/vouchers')return ok(transaction(()=>{
   erp.periodOpen();const v=readJSON(body),exchange=approvedRate(v.rate),amount=decimal(v.amount,2,'المبلغ بالدولار'),account=String(v.account_id||'107'),counterpart=String(v.counterpart||''),incoming=v.kind==='receipt';
   if(!['receipt','payment'].includes(v.kind)||!['107','108'].includes(account)||!amount||['107','108'].includes(counterpart)||!db.prepare('SELECT id FROM accounts WHERE id=?').get(counterpart))inputError('بيانات السند غير صحيحة');
   if(v.partner_id){const partner=db.prepare('SELECT * FROM partners WHERE id=?').get(String(v.partner_id));if(!partner||!['104','201'].includes(counterpart)||(counterpart==='104'&&!['customer','both'].includes(partner.type))||(counterpart==='201'&&!['supplier','both'].includes(partner.type)))inputError('الطرف وحساب الذمم غير متطابقين')}
   const base=convert(amount,exchange),pool=balances().find(x=>x.account_id===account);if(!incoming&&pool.foreign_cents<amount)inputError('الرصيد بالدولار غير كاف');
   const carrying=incoming?base:Number(BigInt(pool.base_value)*BigInt(amount)/BigInt(pool.foreign_cents)),difference=base-carrying,lines=incoming?[[account,base,0],[counterpart,0,base]]:[[counterpart,base,0],[account,0,carrying],['402',0,Math.max(0,difference)],['504',Math.max(0,-difference),0]];
   if(base<=0)inputError('المبلغ أقل من وحدة العملة الأساسية');
   const id=Number(db.prepare('INSERT INTO currency_cash_moves(date,kind,currency,foreign_amount,base_amount,carrying,rate,account_id,partner_id,counterpart,description) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(new Date().toISOString().slice(0,10),v.kind,'USD',amount,base,carrying,exchange,account,v.partner_id||null,counterpart,String(v.description||'')).lastInsertRowid),journal=postJournal('سند دولار '+id,'FX-'+id,lines);
   db.prepare('UPDATE currency_cash_moves SET journal_id=? WHERE id=?').run(journal,id);erp.audit('currency-voucher',id,{base,carrying,difference});return {id,base_amount:base,carrying,exchange_difference:incoming?0:difference};
  }),201);
  return false;
 }
 return {handle,normalize,snapshot,convert};
}
