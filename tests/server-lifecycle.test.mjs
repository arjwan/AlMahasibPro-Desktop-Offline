import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer,stopChild} from './helpers/server.mjs';

test('test server stop is safe after an earlier stop',async()=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
 await stopChild(child);await stopChild(child);assert.ok(child.exitCode!==null||child.signalCode!==null);
});
test('startup timeout terminates the failed server instead of leaving the test runner hanging',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'alma-start-timeout-')),entry=join(dir,'never-ready.cjs');
 writeFileSync(entry,"console.log('PID='+process.pid);setInterval(()=>{},1000)");
 try{
  let error;try{await startServer(join(dir,'test.sqlite'),{entry,timeout:5000});}catch(e){error=e;}
  assert.match(error?.message||'',/startup timed out/);const pid=Number(error.message.match(/PID=(\d+)/)?.[1]);assert.ok(pid,'Startup diagnostics should include child stdout');
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});
