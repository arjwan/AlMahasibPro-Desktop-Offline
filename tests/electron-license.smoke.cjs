const {app,BrowserWindow,clipboard}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alma-license-clipboard-'));process.env.ALMAHASIB_USER_DATA=dir;
(async()=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));process.env.PORT=String(probe.address().port);await new Promise(r=>probe.close(r));require('../electron-main.cjs');await app.whenReady();
 const url=`http://127.0.0.1:${process.env.PORT}/`;let main;for(let i=0;i<300;i++){main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url&&!w.webContents.isLoading());if(main)break;await new Promise(r=>setTimeout(r,100))}assert.ok(main,'Main application did not load');
 const id=await main.webContents.executeJavaScript(`(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});if(!r.ok)throw Error('Login failed');const license=await fetch('/api/license').then(r=>r.json());await window.desktopLicensing.copyId(license.machine_id);return license.machine_id})()`);assert.equal(clipboard.readText(),id);
 const token='eyJwcm9kdWN0IjoiZGVtbyJ9.c2lnbmF0dXJl';clipboard.writeText(token);assert.equal(await main.webContents.executeJavaScript('window.desktopLicensing.pasteToken()'),token);
 clipboard.writeText('not-a-license');await assert.rejects(main.webContents.executeJavaScript('window.desktopLicensing.pasteToken()'));
 await assert.rejects(main.webContents.executeJavaScript(`window.desktopLicensing.copyId('invalid')`));
 const other=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'../desktop-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});await other.loadURL('about:blank');await assert.rejects(other.webContents.executeJavaScript(`window.desktopLicensing.copyId('${id}')`));other.destroy();clipboard.clear();console.log('ELECTRON license clipboard copy/paste, format restriction and foreign-frame rejection: PASS');app.quit();
})().catch(e=>{console.error(e);app.exit(1)});
app.on('quit',()=>{try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200})}catch{}});
