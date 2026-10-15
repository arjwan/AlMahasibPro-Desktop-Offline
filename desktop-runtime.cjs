async function waitForOwnServer({child,url,instance,fetchImpl=fetch,attempts=100,delay=100}){
 let last='لم يستجب الخادم';
 for(let i=0;i<attempts;i++){
  if(child.exitCode!==null||child.signalCode)throw Error('توقف محرك البيانات قبل اكتمال التشغيل: '+last);
  try{const response=await fetchImpl(url,{signal:AbortSignal.timeout(750)});if(response.ok){const health=await response.json();if(health.instance===instance&&health.accounting_schema_ok===true)return health;last=health.instance!==instance?'المنفذ مشغول بخادم آخر؛ أغلق النسخة الأخرى ثم افتح البرنامج':'ترقية قاعدة الحسابات لم تكتمل'}}catch(e){last=e.message}
  if(i+1<attempts)await new Promise(r=>setTimeout(r,delay));
 }
 throw Error(last);
}
module.exports={waitForOwnServer};
