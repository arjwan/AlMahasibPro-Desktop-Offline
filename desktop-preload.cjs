const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopReports',{pdf:query=>ipcRenderer.invoke('supplier-report-pdf',query)});

contextBridge.exposeInMainWorld('desktopLicensing',{copyId:id=>ipcRenderer.invoke('license-copy-id',id),pasteToken:()=>ipcRenderer.invoke('license-paste-token')});
