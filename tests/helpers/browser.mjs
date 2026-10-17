import {chromium} from 'playwright';
export const launchBrowser=()=>chromium.launch({headless:true,executablePath:process.env.ALMAHASIB_CHROMIUM||undefined,args:process.env.ALMAHASIB_CHROMIUM&&process.platform!=='win32'?['--no-sandbox','--disable-gpu','--disable-software-rasterizer','--disable-dev-shm-usage','--no-zygote','--single-process']:[]});
