// Start only an isolated metadata snapshot. Track actual fs body reads through an IPC probe.
const fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process'),assert=require('assert/strict')
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nis-list-http-')),data=path.join(root,'data');fs.mkdirSync(data,{recursive:true})
const src='D:/nis0924/backend/data'
const index=JSON.parse(fs.readFileSync(src+'/sessions-index.json','utf8'))
for(const [id,e] of Object.entries(index.sessions)) {
 e.id=id;e.workDir=path.join(root,'work');e.status='idle';e.queuedMessages=[];e.msgCount=1;e.lastMessage='fixture';e.firstMessage='fixture';e.unread=0;
 const dir=path.join(data,'sessions',id);fs.mkdirSync(dir,{recursive:true})
 const msg={id:'message-'+id,role:'user',timestamp:1,content:[{type:'text',text:'fixture'}]}
 const segment=JSON.stringify({v:1,t:'h',id,at:1})+'\n'+JSON.stringify({t:'a',m:msg})+'\n'
 fs.writeFileSync(path.join(dir,'0001.jsonl'),segment)
 const st=fs.statSync(path.join(dir,'0001.jsonl'));e.fileMtime=Math.round(st.mtimeMs);e.fileSize=st.size
 const meta={id,title:e.title,createdAt:e.createdAt,updatedAt:e.updatedAt,model:e.model,modelProviderId:e.modelProviderId,workDir:e.workDir,parentSessionId:e.parentSessionId,memberId:e.memberId,inMainList:e.inMainList,__ms:1,segments:[{f:'0001.jsonl',n:1,bytes:st.size,first:msg.id,last:msg.id}]}
 fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(meta))
}
fs.writeFileSync(data+'/sessions-index.json',JSON.stringify(index))
const trace=path.join(root,'trace.mjs')
fs.writeFileSync(trace,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';let reads=[];const original=fs.readFileSync;fs.readFileSync=function(file,...rest){const p=String(file);if(/(transcript\\.json|\\d{4}\\.jsonl|subruns\\.json)$/i.test(p))reads.push(p);return original.call(this,file,...rest)};syncBuiltinESMExports();process.on('message',msg=>{if(msg==='reset'){reads=[];process.send({reset:true})}if(msg==='stats')process.send({bodyReads:reads.length,examples:reads.slice(0,3)})});`)
const port=19583,log=fs.openSync(path.join(root,'server.log'),'w'),err=fs.openSync(path.join(root,'server.err'),'w')
const env={...process.env,NIS_DATA_DIR:data,NIS_MEMORY_DIR:path.join(root,'memory'),NIS_SKILLS_DIR:path.join(root,'skills'),NIS_PORT:String(port)}
for(const k of ['NIS_BACKEND_PID','NIS_PARENT_PID','NIS_DIST_DIR','NIS_BROWSER_SHELL_FILE'])delete env[k]
const child=spawn('D:/nis0924/toolchain/node/node.exe',['--import','file:///D:/nis0924/backend/node_modules/tsx/dist/esm/index.mjs','--import',require('url').pathToFileURL(trace).href,'D:/nis0924/backend/dataMergeBootstrap.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore',log,err,'ipc']})
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function ask(msg){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('probe timeout')),3000);child.once('message',x=>{clearTimeout(timer);resolve(x)});child.send(msg)})}
async function main(){try{
 let ready=false;for(let i=0;i<100;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/api/ping',{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break}}catch{}await wait(200)}
 assert.ok(ready,fs.readFileSync(path.join(root,'server.err'),'utf8').slice(-2000))
 await ask('reset');const results=[]
 for(let i=0;i<3;i++){const t=performance.now();const r=await fetch('http://127.0.0.1:'+port+'/api/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rpcId:'isolated-list-'+i,method:'session.list',payload:{}})});const body=await r.json();assert.ok(body.result?.ok!==false,JSON.stringify(body).slice(0,300));const list=body.result?.value?.sessions;assert.ok(list?.length>50,JSON.stringify({keys:Object.keys(body),resultKeys:Object.keys(body.result||{}),valueKeys:Object.keys(body.result?.value||{}),count:list?.length}).slice(0,400));results.push({ms:+(performance.now()-t).toFixed(2),count:list.length})}
 const stats=await ask('stats');assert.equal(stats.bodyReads,0,JSON.stringify(stats));console.log('REAL_ISOLATED_HTTP',JSON.stringify({root,results,...stats}))
}catch(e){console.error(e);process.exitCode=1}finally{child.kill();await wait(500)}}
main()
