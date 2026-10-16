// Creates a NEW isolated demo database. Never connects to an existing company.
import {demoImage} from './demo-image.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {startServer} from '../tests/helpers/server.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.resolve(process.argv[2]||path.join(root,'work/demo-market-large-0.5.2'));
fs.mkdirSync(output,{recursive:true});
const dbPath=path.join(output,'company.sqlite');if(fs.existsSync(dbPath))throw Error('Demo database already exists. Choose a new directory; existing data will never be overwritten.');
const categories=[
 ['مواد غذائية',['رز عنبر','رز بسمتي','سكر أبيض','طحين أبيض','عدس أحمر','حمص','فاصوليا بيضاء','برغل','معكرونة','نشا']],
 ['زيوت ومعلبات',['زيت دوار الشمس','زيت زيتون','سمن نباتي','معجون طماطم','فول معلب','حمص معلب','تونة','سردين','ذرة معلبة','بازلاء معلبة']],
 ['أجبان وألبان',['حليب طويل الأمد','حليب بودرة','جبن أبيض','جبن مثلثات','قشطة','لبن','زبادي','زبدة','جبن شرائح','حليب مكثف']],
 ['عصائر ومشروبات غازية',['ماء معدني','عصير برتقال','عصير تفاح','عصير رمان','بيبسي','سفن أب','ميرندا برتقال','عصير مانجو','عصير كوكتيل','مشروب شعير خال من الكحول']],
 ['حلويات وبسكويت',['بسكويت سادة','كيك شوكولاتة','شوكولاتة بالحليب','حلوى فواكه','ويفر','تمر','دبس تمر','عسل','طحينية','حلاوة']],
 ['منظفات',['مسحوق غسيل','سائل غسيل','سائل صحون','كلور','مطهر أرضيات','منظف زجاج','معطر جو','صابون غسيل','إسفنج تنظيف','أكياس نفايات']],
 ['لحوم ودواجن مجمدة',['دجاج كامل مجمد','صدور دجاج','أفخاذ دجاج','أجنحة دجاج','لحم بقري مفروم','لحم غنم','كبدة دجاج','برغر لحم','كباب مجمد','سمك فيليه مجمد']],
 ['سكائر ولوازمها',['سكائر أحمر طويل','سكائر أزرق طويل','سكائر أبيض خفيف','سكائر فضي','سكائر ذهبي','سكائر أسود','سكائر أحمر قصير','سكائر أزرق قصير','ولاعة','علبة كبريت']],
 ['جبس وسناكات',['جبس ملح','جبس جبن','جبس حار','جبس كاتشب','جبس خل','ذرة مقرمشة','فستق محمص','بذور دوار الشمس','فشار','بقسماط']],
 ['بهارات وشاي وقهوة',['فلفل أسود','كمون','كركم','دارسين','هيل','بهارات مشكلة','ملح طعام','شاي أسود','قهوة عربية','قهوة سريعة']],
 ['مخللات وصلصات',['مخلل خيار','مخلل مشكل','زيتون أخضر','زيتون أسود','كاتشب','مايونيز','صلصة حارة','دبس رمان','خل تفاح','صلصة ثوم']],
 ['مخبوزات وعناية منزلية',['خبز توست','صمون معبأ','كعك','كيك عائلي','مناديل ورقية','مناديل مبللة','صابون يد','شامبو','معجون أسنان','ورق مطبخ']]
];
const barcode=n=>{const prefix='200'+String(n).padStart(9,'0');return prefix+((10-[...prefix].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0)%10)%10)};
const rows=[];let number=0;
for(let c=0;c<categories.length;c++)for(let n=0;n<10;n++)for(let size=0;size<2;size++){
 number++;const cost=(c+1)*250+(n+1)*100+size*500;
 rows.push({id:'DEMO-'+String(number).padStart(4,'0'),name:categories[c][1][n]+' — '+(size?'عبوة عائلية':'عبوة صغيرة'),category:categories[c][0],barcode:barcode(number),cost,price:Math.ceil(cost*1.3/50)*50,qty:600+(number%12)*200,supplier:c,warehouse_id:1+(number%3)});
}
const server=await startServer(dbPath);let cookie='';
async function api(route,method='GET',value){const r=await fetch(server.base+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:value===undefined?undefined:JSON.stringify(value)});const data=await r.json();if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');if(!r.ok)throw Error(route+': '+JSON.stringify(data));return data}
try{
 await api('/api/auth/login','POST',{username:'admin',password:'admin123'});
 await api('/api/warehouses','POST',{name:'مخزن الجملة التجريبي'});await api('/api/warehouses','POST',{name:'مخزن الكاشير التجريبي'});
 const total=rows.reduce((s,r)=>s+r.qty*r.cost,0);
 await api('/api/journal','POST',{description:'رأس مال التجربة لتمويل التوريد',reference:'DEMO-CAPITAL',lines:[{account_id:'101',debit:total},{account_id:'3',credit:total}]});
 const suppliers=[];for(let c=0;c<categories.length;c++)suppliers.push(await api('/api/partners','POST',{name:'مورد تجريبي '+(c+1)+' — '+categories[c][0],type:'supplier',phone:'DEMO-'+(c+1)}));
 fs.mkdirSync(path.join(output,'images'),{recursive:true});
 for(const row of rows){const image=demoImage(Number(row.id.slice(5)),row.supplier);fs.writeFileSync(path.join(output,'images',row.id+'.png'),image);row.image_data='data:image/png;base64,'+image.toString('base64');await api('/api/products','POST',row);}
 const purchases=[];for(let c=0;c<categories.length;c++)for(let w=1;w<=3;w++){
 const products=rows.filter(r=>r.supplier===c&&r.warehouse_id===w),net=products.reduce((s,r)=>s+r.qty*r.cost,0),paid=c%3===0?net:c%3===1?Math.floor(net/2):0;
 purchases.push(await api('/api/purchases','POST',{partner_id:suppliers[c].id,supplier_invoice_no:'DEMO-SUP-'+(c+1)+'-W'+w,warehouse_id:w,paid,lines:products.map(r=>({product_id:r.id,qty:r.qty,cost:r.cost}))}));
 }
 const products=await api('/api/products'),balances=await api('/api/stock/balances'),journal=await api('/api/journal'),financial=await api('/api/reports/financial');
 assert.equal(products.length,240);assert.equal(purchases.length,36);assert.equal(financial.debit,financial.credit);
 for(const r of rows)assert.equal(balances.filter(x=>x.id===r.id).reduce((s,x)=>s+x.stock,0),r.qty);
 const csvEscape=v=>'"'+String(v).replaceAll('"','""')+'"';
 const csv=[['id','name','barcode','category','cost','price','quantity','warehouse_id','supplier'],...rows.map(r=>[r.id,r.name,r.barcode,r.category,r.cost,r.price,r.qty,r.warehouse_id,'مورد تجريبي '+(r.supplier+1)])].map(r=>r.map(csvEscape).join(',')).join('\r\n');
 fs.writeFileSync(path.join(output,'barcodes-and-prices.csv'),'\ufeff'+csv);
 fs.writeFileSync(path.join(output,'catalog.json'),JSON.stringify(rows.map(({image_data,...row})=>({...row,image_file:'images/'+row.id+'.png'})),null,2));
 const summary={version:'0.5.2',demo_only:true,products:240,suppliers:12,warehouses:3,purchase_documents:36,stock_units:rows.reduce((s,r)=>s+r.qty,0),stock_value:total,journal_entries:journal.length,debit:financial.debit,credit:financial.credit,profit:financial.profit};
 fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(summary,null,2));
 const htmlEscape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;');
 const script=fs.readFileSync(path.join(root,'node_modules/jsbarcode/dist/JsBarcode.all.min.js'),'utf8');
 fs.writeFileSync(path.join(output,'barcodes-print.html'),'<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>باركودات التجربة</title><style>body{font:14px Arial}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}.label{border:1px solid #aaa;text-align:center;break-inside:avoid;padding:3mm}svg{width:55mm;height:22mm}@media print{button{display:none}@page{size:A4;margin:8mm}}</style><h1>باركودات مواد التجربة — لا تستخدم كبيانات فعلية</h1><button onclick="print()">طباعة</button><div class="grid">'+rows.map(r=>'<div class="label">'+htmlEscape(r.name)+'<br>'+r.id+' | شراء '+r.cost+' | بيع '+r.price+' د.ع<svg data-code="'+r.barcode+'"></svg></div>').join('')+'</div><script>'+script+'</script><script>document.querySelectorAll("svg").forEach(el=>JsBarcode(el,el.dataset.code,{format:"EAN13",width:2,height:40,displayValue:true}))</script></html>');
 fs.writeFileSync(path.join(output,'README.txt'),'بيانات تجربة فقط — لا تستعدها فوق قاعدة شركة فعلية.\n240 مادة، 12 مورداً، 36 فاتورة شراء مرحلة، 3 مخازن.\nالمدير التجريبي admin / admin123.\nbarcodes-print.html ملف مستقل لطباعة الباركودات.\nbarcodes-and-prices.csv الأسعار والكميات بالدينار، احفظ الباركود كنص عند فتحه في Excel.\nللتشغيل من مصدر المشروع: عيّن ALMAHASIB_DB إلى company.sqlite في هذا المجلد ثم npm start.\nيمنع مولد البيانات الكتابة فوق قاعدة موجودة.\n');
 console.log(JSON.stringify(summary));
}finally{await server.stop()}
