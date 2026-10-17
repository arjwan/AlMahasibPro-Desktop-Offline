import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function stopChild(child){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Test server did not exit after termination'));},10000);
  child.once('exit',()=>{clearTimeout(timer);resolve();});
  child.kill();
 });
}
export async function startServer(dbPath,{timeout=60000,entry='server.mjs'}={}){
 const child=spawn(process.execPath,[entry],{cwd:root,windowsHide:true,env:{...process.env,ALMAHASIB_DB:dbPath,ALMAHASIB_HOST:'127.0.0.1',ALMAHASIB_SCANNER_HOST:'192.168.1.10',PORT:'0'},stdio:['ignore','pipe','pipe']});
 let output='',errors='';
 const diagnostics=()=>{let log='';try{log=readFileSync(join(dirname(dbPath),'server.log'),'utf8').slice(-6000)}catch{}return output+'\n'+errors+'\n'+log;};
 try{
 const base=await new Promise((resolve,reject)=>{
  const done=(err,value)=>{clearTimeout(timer);child.off('exit',exited);child.off('error',failed);err?reject(err):resolve(value);};
  const exited=code=>done(Error('Test server exited '+code+': '+diagnostics()));
  const failed=err=>done(err);
  const timer=setTimeout(()=>done(Error('Test server startup timed out: '+diagnostics())),timeout);
  child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+(?=\s|\|)/);if(match)done(null,match[0]);});
  child.stderr.on('data',chunk=>errors+=chunk);
  child.once('exit',exited);child.once('error',failed);
 });
 return {child,base,stop:()=>stopChild(child)};
 }catch(e){await stopChild(child);throw e;}
}
