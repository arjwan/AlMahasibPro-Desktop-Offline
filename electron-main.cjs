const {app,BrowserWindow,dialog}=require('electron');const {spawn}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');let server;let window;
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

    writeLog(`Spawning server at ${serverPath} on port ${port} with DB ${path.join(data,'company.sqlite')}`);
    
    server=spawn(process.execPath,[serverPath],{
        env:{...process.env,ELECTRON_RUN_AS_NODE:'1',ALMAHASIB_DB:path.join(data,'company.sqlite'),PORT:String(port),ALMAHASIB_HOST:'127.0.0.1'},
        windowsHide:true
    });

    server.stdout.on('data',(d)=>writeLog(`Server STDOUT: ${d}`));
    server.stderr.on('data',(d)=>writeLog(`Server STDERR: ${d}`));
    server.on('error',(err)=>writeLog(`Server Spawn Error: ${err.message}`));
    server.on('exit',(code)=>writeLog(`Server exited with code: ${code}`));

    let ready=false;
    for(let i=0;i<100;i++){
        try{
            const r=await fetch(`http://127.0.0.1:${port}/api/health`);
            if(r.ok){ready=true;break}
        }catch(e){}
        await new Promise(r=>setTimeout(r,100))
    }

    if(!ready){
        const err=`لم يبدأ محرك قاعدة البيانات المحلية\n\nسجل الأخطاء: ${logPath}`;
        writeLog('Server failed to start in time');
        dialog.showErrorBox('تعذر التشغيل',err);
        app.quit();
        return;
    }

    window=new BrowserWindow({width:1450,height:900,minWidth:1000,minHeight:680,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.loadURL(`http://127.0.0.1:${port}/`);
    window.on('closed',()=>{window=null})
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{if(server)server.kill()});
