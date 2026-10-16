// Automated Windows clean install and same-version upgrade in an isolated profile.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
if(process.platform!=='win32')throw Error('Windows installer acceptance must run on Windows');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const installer=path.join(root,'dist',`AlMahasibPro-Offline-Setup-${version}-x64.exe`);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alma-installer-')),install=path.join(dir,'application'),profile=path.join(dir,'profile');
const executable=path.join(install,'AlMahasibPro Offline.exe'),dbPath=path.join(profile,'company.sqlite');
async function installApp(){await new Promise((resolve,reject)=>{const child=spawn(installer,['/S','/D='+install],{windowsHide:true});const timer=setTimeout(()=>{try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'])}catch{}reject(Error('Installer timed out'))},120000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Installer exit '+code))})});assert.ok(fs.existsSync(executable),'Installed executable missing')}
async function launch(){
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(executable,[],{env:{...process.env,ALMAHASIB_USER_DATA:profile,PORT:String(port)},stdio:'ignore'}),base='http://127.0.0.1:'+port;
 try{
 let ready=false;for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error('Installed app exited '+child.exitCode);try{const r=await fetch(base+'/api/health');if(r.ok){assert.equal((await r.json()).version,version);ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}assert.ok(ready,'Installed application server did not start');
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 const license=await fetch(base+'/api/license',{headers:{Cookie:cookie}});assert.equal(license.status,200);const state=await license.json();assert.equal(state.active,false);assert.equal(state.required,true);assert.match(state.machine_id,/^[a-f0-9]{64}$/);
 assert.equal((await fetch(base+'/api/products',{headers:{Cookie:cookie}})).status,403,'Packaged app must require license even if parent environment disables it');
 }finally{if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'})}catch{}await exited}}
}
(async()=>{
 try{
 assert.ok(fs.existsSync(installer),'Build installer first');process.env.ALMAHASIB_REQUIRE_LICENSE='';
 await installApp();await launch();let db=new DatabaseSync(dbPath);db.prepare("INSERT INTO settings(key,value) VALUES('installer_test_marker','preserve-me')").run();db.close();console.log('WINDOWS clean NSIS install, packaged startup, login and mandatory activation: PASS');
 await installApp();await launch();db=new DatabaseSync(dbPath);assert.equal(db.prepare("SELECT value FROM settings WHERE key='installer_test_marker'").get().value,'preserve-me');db.close();console.log('WINDOWS same-version installer upgrade preserves isolated database: PASS');
 }finally{await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
})().catch(e=>{console.error(e);process.exitCode=1});
