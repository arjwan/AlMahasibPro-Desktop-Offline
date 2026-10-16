import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {verifyLicense,machineId,createLicensing} from '../licensing.mjs';
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
const hardware=machineId();
const sign=v=>{const p=Buffer.from(JSON.stringify(v)).toString('base64url');return p+'.'+crypto.sign(null,Buffer.from(p),privateKey).toString('base64url')};
const data={product:'AlMahasibPro-Offline',machine_id:hardware,customer_id:'customer-a',license_id:'sale-1',primary:1,cashiers:5};
test('License binds signed customer entitlement to one primary with five cashiers',()=>{
 const token=sign(data);assert.equal(verifyLicense(token,publicKey,hardware).customer_id,'customer-a');
 assert.throws(()=>verifyLicense(token,publicKey,'another-machine'));
 assert.throws(()=>verifyLicense(sign({...data,expires:'2000-01-01'}),publicKey,hardware));
 assert.throws(()=>verifyLicense(sign({...data,cashiers:6}),publicKey,hardware));
 assert.throws(()=>verifyLicense(token.replace(token[0],token[0]==='a'?'b':'a'),publicKey,hardware));
 assert.throws(()=>verifyLicense(sign({...data,customer_id:''}),publicKey,hardware));
});
test('Unactivated LAN always fails closed; packaged local use also requires activation',()=>{
 const license=createLicensing({dbPath:'/nonexistent/company.sqlite'}),remote={socket:{remoteAddress:'192.168.1.20'}},local={socket:{remoteAddress:'127.0.0.1'}};
 assert.equal(license.allowed(remote),false);const saved=process.env.ALMAHASIB_REQUIRE_LICENSE;
 try{process.env.ALMAHASIB_REQUIRE_LICENSE='1';assert.equal(license.allowed(local),false)}finally{if(saved===undefined)delete process.env.ALMAHASIB_REQUIRE_LICENSE;else process.env.ALMAHASIB_REQUIRE_LICENSE=saved}
});

test('Activation persists a valid token, rejects another machine and requires local admin',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alma-license-'));
 try{
 const key=path.join(dir,'public.pem');fs.writeFileSync(key,publicKey.export({type:'spki',format:'pem'}));
 let response;const licensing=createLicensing({dbPath:path.join(dir,'db.sqlite'),publicKeyPath:key,readJSON:JSON.parse,send:(_res,status,body)=>response={status,body}});
 const req={method:'POST',user:{role:'admin'},socket:{remoteAddress:'127.0.0.1'}},res={};
 licensing.handle({...req,socket:{remoteAddress:'192.168.1.5'}},res,'/api/license/activate',JSON.stringify({token:sign(data)}));assert.equal(response.status,403);
 licensing.handle(req,res,'/api/license/activate',JSON.stringify({token:sign({...data,machine_id:'other'})}));assert.equal(response.status,400);
 licensing.handle(req,res,'/api/license/activate',JSON.stringify({token:sign(data)}));assert.equal(response.status,200);assert.equal(licensing.status().active,true);assert.equal(licensing.allowed({socket:{remoteAddress:'192.168.1.5'}}),true);
 fs.writeFileSync(path.join(dir,'license.token'),'forged');assert.equal(licensing.status().active,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('Licensed access reserves local primary separately and admits exactly five remote cashier browsers',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{createAccess}=await import('../access.mjs');
 const db=new DatabaseSync(':memory:');
 try{
 db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,password TEXT,full_name TEXT,role TEXT);INSERT INTO users VALUES('admin','admin','password123','Admin','admin')");
 let result,headers;const res={setHeader:(_k,v)=>headers=v},access=createAccess({db,readJSON:JSON.parse,send:(_r,status,body)=>result={status,body},inputError:message=>{throw Error(message)},audit:()=>{},licensing:{status:()=>({active:true}),allowed:()=>true,handle:()=>false}});
 const login=ip=>{headers=null;access.handle({method:'POST',headers:{},socket:{remoteAddress:ip}},res,'/api/auth/login',JSON.stringify({username:'admin',password:'password123'}));return headers};
 login('127.0.0.1');assert.equal(result.status,200);
 const cashier=login('192.168.1.10');assert.equal(result.status,200);
 for(let i=1;i<5;i++){login('192.168.1.'+(10+i));assert.equal(result.status,200)}
 login('192.168.1.20');assert.equal(result.status,403);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM registered_devices WHERE kind='primary'").get().n,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM registered_devices WHERE kind='cashier'").get().n,5);
 access.handle({method:'POST',headers:{cookie:cashier.map(x=>x.split(';')[0]).join('; ')},socket:{remoteAddress:'192.168.1.10'}},res,'/api/auth/login',JSON.stringify({username:'admin',password:'password123'}));assert.equal(result.status,200);
 }finally{db.close()}
});
