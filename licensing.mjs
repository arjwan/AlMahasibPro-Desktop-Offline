import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export const isLocal=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
export function machineId(){
 let id;
 if(process.platform==='win32')id=execFileSync('reg',['query','HKLM\\SOFTWARE\\Microsoft\\Cryptography','/v','MachineGuid'],{encoding:'utf8',windowsHide:true}).match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1];
 else id=fs.readFileSync('/etc/machine-id','utf8').trim();
 if(!id)throw Error('تعذر تحديد هوية الجهاز الرئيسي');
 return crypto.createHash('sha256').update('AlMahasibPro-Offline:'+id).digest('hex');
}
export function verifyLicense(token,publicKey,hardware){
 const parts=String(token).trim().split('.');if(parts.length!==2)throw Error('صيغة الترخيص غير صحيحة');
 const [payload,signature]=parts;
 if(!crypto.verify(null,Buffer.from(payload),publicKey,Buffer.from(signature,'base64url')))throw Error('توقيع الترخيص غير صحيح');
 const value=JSON.parse(Buffer.from(payload,'base64url').toString());
 if(value.product!=='AlMahasibPro-Offline'||value.machine_id!==hardware||!value.customer_id||!value.license_id||value.cashiers!==5||value.primary!==1)throw Error('الترخيص لا يخص هذا الجهاز أو المنتج');
 if(value.expires&&(!Number.isFinite(Date.parse(value.expires))||Date.parse(value.expires)<=Date.now()))throw Error('انتهت صلاحية الترخيص');
 return value;
}
export function createLicensing({dbPath,send,readJSON,publicKeyPath=new URL('./license-public.pem',import.meta.url)}){
 const hardware=machineId(),file=path.join(path.dirname(dbPath),'license.token'),keyFile=publicKeyPath;
 function read(token=fs.readFileSync(file,'utf8')){return verifyLicense(token,fs.readFileSync(keyFile),hardware)}
 function status(){try{return {active:true,...read(),machine_id:hardware}}catch{return {active:false,required:!!process.env.ALMAHASIB_REQUIRE_LICENSE,machine_id:hardware,primary:1,cashiers:5}}}
 function handle(req,res,p,body){
  if(p==='/api/license'&&req.method==='GET'){if(req.user?.role!=='admin'){send(res,403,{error:'للمدير فقط'});return true}send(res,200,status());return true}
  if(p==='/api/license/activate'&&req.method==='POST'){
   if(req.user?.role!=='admin'||!isLocal(req)){send(res,403,{error:'التفعيل من الجهاز الرئيسي بحساب المدير فقط'});return true}
   try{const token=String(readJSON(body).token||'');read(token);fs.writeFileSync(file+'.tmp',token,{mode:0o600});fs.renameSync(file+'.tmp',file);send(res,200,status())}catch{send(res,400,{error:'ترخيص غير صالح لهذا الجهاز أو مفتاح التحقق غير مجهز'})}return true;
  }
  return false;
 }
 // Unpackaged loopback development is available; distributed builds and LAN fail closed.
 function allowed(req){return !process.env.ALMAHASIB_REQUIRE_LICENSE&&isLocal(req)||status().active}
 return {status,handle,allowed};
}
