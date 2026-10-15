const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alma-electron-')),root=path.resolve(__dirname,'..'),port=40000+Math.floor(Math.random()*10000);let logs='';
 const child=spawn(require('electron'),[root],{cwd:root,env:{...process.env,ALMAHASIB_USER_DATA:dir,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 try{let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)break;try{const r=await fetch('http://127.0.0.1:'+port+'/api/health');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}assert.ok(ready,'Electron server did not start: '+logs);const r=await fetch('http://127.0.0.1:'+port+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});assert.equal(r.status,200);console.log('Electron startup, SQLite and login: PASS')}
 finally{if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));if(process.platform==='win32')execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});else child.kill();await exited}await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
})().catch(e=>{console.error(e);process.exitCode=1});
