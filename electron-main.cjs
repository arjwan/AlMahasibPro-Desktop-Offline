const {waitForOwnServer}=require('./desktop-runtime.cjs');const crypto=require('node:crypto');
const {app,BrowserWindow,dialog,ipcMain,clipboard,Menu}=require('electron');const {spawn}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');let server;let window;
process.on('uncaughtException',(e)=>{
    try{
        const data=app ? app.getPath('userData') : (process.env.APPDATA ? path.join(process.env.APPDATA,'AlMahasibPro Offline') : 'C:\\\\temp\\\\electron-error.log');
        const logPath=path.join(data,'critical-error.log');
        fs.appendFileSync(logPath,`[${new Date().toISOString()}] UNCAUGHT EXCEPTION: ${e.stack}\n`, 'utf8');
    }catch(err){}
});
if(process.env.ALMAHASIB_USER_DATA)app.setPath('userData',process.env.ALMAHASIB_USER_DATA);
app.whenReady().then(async()=>{
    const data=app.getPath('userData');
    fs.mkdirSync(data,{recursive:true});
    const logPath=path.join(data,'electron-startup.log');
    const writeLog=(msg)=>fs.appendFileSync(logPath,`[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    
    writeLog('Electron starting... UserData: ' + data);
    
    const serverPath=path.join(__dirname,'server.mjs');
    const port=Number(process.env.PORT||3765);
    
    if(!fs.existsSync(serverPath)){
        writeLog(`CRITICAL: server.mjs NOT FOUND at ${serverPath}`);
        dialog.showErrorBox('خطأ في الملفات','ملف الخادم مفقود: '+serverPath);
        app.quit();
        return;
    }

    writeLog(`Spawning server at ${serverPath} on port ${port} with DB ${path.join(data,'company-clean-v1.sqlite')}`);
    
    const instance=crypto.randomBytes(24).toString('hex');
    server=spawn(process.execPath,[serverPath],{
        env:{...process.env,ELECTRON_RUN_AS_NODE:'1',ALMAHASIB_REQUIRE_LICENSE:app.isPackaged?'1':(process.env.ALMAHASIB_REQUIRE_LICENSE||''),ALMAHASIB_INSTANCE:instance,ALMAHASIB_DB:path.join(data,'company-clean-v1.sqlite'),PORT:String(port),ALMAHASIB_HOST:process.env.ALMAHASIB_HOST||'0.0.0.0'},
        windowsHide:true
    });

    server.stdout.on('data',(d)=>writeLog(`Server STDOUT: ${d}`));
    server.stderr.on('data',(d)=>writeLog(`Server STDERR: ${d}`));
    server.on('error',(err)=>writeLog(`Server Spawn Error: ${err.message}`));
    server.on('exit',(code)=>writeLog(`Server exited with code: ${code}`));

    let ready=false,startupError='';
    try{const health=await waitForOwnServer({child:server,url:`http://127.0.0.1:${port}/api/health`,instance});ready=true;writeLog('Verified own server build: '+health.build)}catch(e){startupError=e.message;writeLog('Readiness rejected: '+startupError)}

    if(!ready){
        const err=`لم يبدأ محرك قاعدة البيانات المحلية\n${startupError}\n\nسجل الأخطاء: ${logPath}`;
        writeLog('Server failed to start in time');
        dialog.showErrorBox('تعذر التشغيل',err);
        app.quit();
        return;
    }

    window=new BrowserWindow({width:1450,height:900,minWidth:1000,minHeight:680,webPreferences:{preload:path.join(__dirname,'desktop-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    function licenseFrame(event){if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==`http://127.0.0.1:${port}/`)throw Error('طلب غير مسموح')}
    // Printer discovery stays in Electron's privileged process; renderer only receives safe metadata.
    ipcMain.handle('devices-list-printers',async(event)=>{
      licenseFrame(event);
      const printers=await window.webContents.getPrintersAsync();
      return printers.map(p=>({name:p.name,displayName:p.displayName||p.name,isDefault:!!p.isDefault,status:Number.isFinite(p.status)?p.status:null}));
    });
    ipcMain.handle('devices-test-print',async(event,printerName,paper)=>{
      licenseFrame(event);
      if(typeof printerName!=='string'||printerName.length>250||!['A4','58','80'].includes(paper))throw Error('إعدادات الطباعة غير صحيحة');
      const installed=await window.webContents.getPrintersAsync();
      if(!installed.some(p=>p.name===printerName))throw Error('الطابعة غير مثبتة على هذا الجهاز');
      const test=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
      try{
        const width=paper==='A4'?'210mm':paper+'mm';
        const html='<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;padding:12px;text-align:center}@page{size:'+width+' auto;margin:4mm}</style><h2>المحاسب برو</h2><p>اختبار الطابعة — '+paper+'</p><p>'+new Date().toLocaleString('ar-IQ')+'</p><hr><p>إذا ظهرت هذه الورقة فالطابعة تعمل</p></html>';
        await test.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
        return await new Promise(resolve=>test.webContents.print({silent:false,deviceName:printerName,printBackground:true},(success,reason)=>resolve({ok:success,error:success?'':String(reason||'أُلغيت الطباعة')})));
      }finally{if(!test.isDestroyed())test.destroy()}
    });
    ipcMain.handle('license-copy-id',(event,id)=>{licenseFrame(event);if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('معرّف الجهاز غير صحيح');clipboard.writeText(id);return {ok:true}});
    ipcMain.handle('license-paste-token',event=>{licenseFrame(event);const token=clipboard.readText().trim();if(token.length>8192||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(token))throw Error('الحافظة لا تحتوي على رمز ترخيص صالح');return token});
    window.webContents.on('context-menu',(_event,params)=>{const items=[];if(params.isEditable)items.push({label:'قص',role:'cut',enabled:params.editFlags.canCut});if(params.selectionText||params.isEditable)items.push({label:'نسخ',role:'copy',enabled:params.editFlags.canCopy});if(params.isEditable)items.push({label:'لصق',role:'paste',enabled:params.editFlags.canPaste});if(items.length){items.push({label:'تحديد الكل',role:'selectAll'});Menu.buildFromTemplate(items).popup({window})}});
    ipcMain.handle('supplier-report-pdf',async(event,query)=>{
      if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==`http://127.0.0.1:${port}/`||typeof query!=='string'||query.length>1000)throw Error('طلب غير مسموح');
      const params=new URLSearchParams(query);for(const key of [...params.keys()])if(!['id','from','to'].includes(key))params.delete(key);params.set('format','print');
      const target=`http://127.0.0.1:${port}/api/partners/supplier-report?${params}`;
      const check=await window.webContents.session.fetch(target,{credentials:'include'});if(!check.ok)throw Error('لا يمكن تصدير الكشف؛ تحقق من الجلسة والصلاحيات');
      const destination=await dialog.showSaveDialog(window,{title:'حفظ كشف المورد PDF',defaultPath:'supplier-statement.pdf',filters:[{name:'PDF',extensions:['pdf']}]});if(destination.canceled)return {canceled:true};
      const report=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
      try{await report.loadURL(target);const bytes=await report.webContents.printToPDF({printBackground:true,landscape:true,pageSize:'A4',preferCSSPageSize:true});fs.writeFileSync(destination.filePath,bytes);return {ok:true}}finally{report.destroy()}
    });
    window.loadURL(`http://127.0.0.1:${port}/`);
    window.on('closed',()=>{window=null})
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{if(server)server.kill()});
