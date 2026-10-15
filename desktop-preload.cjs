const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopReports',{pdf:query=>ipcRenderer.invoke('supplier-report-pdf',query)});
