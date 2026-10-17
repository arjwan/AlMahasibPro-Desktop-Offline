const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopReports',{pdf:query=>ipcRenderer.invoke('supplier-report-pdf',query)});

contextBridge.exposeInMainWorld('desktopLicensing',{copyId:id=>ipcRenderer.invoke('license-copy-id',id),pasteToken:()=>ipcRenderer.invoke('license-paste-token')});

// Read-only discovery of printers installed in Windows (USB, network and virtual printers).
contextBridge.exposeInMainWorld('desktopDevices',{listPrinters:()=>ipcRenderer.invoke('devices-list-printers'),testPrint:(name,paper)=>ipcRenderer.invoke('devices-test-print',name,paper)});
