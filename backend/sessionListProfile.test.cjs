// Profile the actual production session.list case and SessionStore getter in isolation.
// Fixture hydration reads JSON synchronously; no live backend or user data is modified.
const fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),{createRequire}=require('module')
const from=createRequire('D:/nis0924/frontend/package.json'),{transformSync}=createRequire(fs.realpathSync(from.resolve('vite/package.json')))('esbuild')
const file=path.join(__dirname,'server.ts'),source=fs.readFileSync(file,'utf8')
function slice(a,b){const i=source.indexOf(a),j=source.indexOf(b,i);assert.ok(i>=0&&j>i,a);return source.slice(i,j)}
const list=slice("    case 'session.list':", "    case 'session.create':").replace("    case 'session.list':",'function runList(){')+'}'
// Frozen pre-fix call site, with the same surrounding production projection.
const beforeList=list.replace('function runList()', 'function baselineList()')
  .replace('members: countLiveSubRuns((s as any)._body?.subRuns, isRunActive).members,','members: splitRunningSubAgents(s.id).members,')
assert.notEqual(beforeList,list)
const cls=slice('class SessionStore extends','const agents =')
const count=slice('function countLiveSubRuns(', '/** 有没有任何**真在跑**')
const split=slice('function splitRunningSubAgents(', '\n}\n')+'\n}'
const member=slice('function memberAlertOf(', '/** ★1032（P81）：')
const awaiting=slice('function awaitingUserKind(', '/** ★0926 链路修复②')
const resolve=slice('function resolveModelProviderId(', '/** 团队运行时上下文工厂')
const guardStart=source.indexOf('  const isBusy = (s: any) =>',source.indexOf('function evictIdleBodies()'))
const guard=source.slice(guardStart,source.indexOf('  // ① 时间',guardStart))
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nis-list-profile-')),bodyFile=path.join(dir,'body.json')
fs.writeFileSync(bodyFile,JSON.stringify({messages:[{role:'assistant',content:'x'.repeat(128*1024)}],subRuns:{}}))
const live=new Set(['live-team']),clones=new Set(['live-clone'])
const sandbox={console,fs,bodyFile,live,clones,Date,Map,Set,reads:0,upgrades:0}
const support=`
const state={providers:[{id:'p',base:'https://fixture',models:[{id:'m'}]}],providerActive:'p'};
function getState(){return state} const pendingApprovals=new Map(),pendingQuestions=new Map();const dirtySessions=new Set();
function currentStateRev(){return 0} function isRunActive(id){return live.has(id)}function isCloneRunActive(id){return clones.has(id)}
function hydrateSessionsFromDisk({onlyId}) {
 upgrades++;const s=Map.prototype.get.call(sessions,onlyId);delete s._skeleton;
 // Body is deliberately evictable: reading subRuns on a hydrated cold session is still I/O.
 Object.defineProperty(s,'subRuns',{configurable:true,get(){if(!s._body){reads++;s._body=JSON.parse(fs.readFileSync(bodyFile,'utf8'))}return s._body.subRuns}})
}
function seed(n){sessions.clear();reads=0;upgrades=0;for(let i=0;i<n;i++)sessions.putSkeleton('s'+i,{id:'s'+i,title:'Session '+i,model:'m',modelProviderId:'p',status:'idle',_skeleton:true,_summary:{lastMessage:'last',firstMessage:'first',unread:0,msgCount:1}})}
function activeSession(){const s=Map.prototype.get.call(sessions,'s0');delete s._skeleton;s._body={subRuns:{call:[{runId:'live-team',status:'running',memberId:'m1'},{runId:'stale-team',status:'running',memberId:'m2'},{runId:'live-clone',status:'running',memberId:'clone1'},{runId:'done-team',status:'done',memberId:'m3'}]}};return s}
${guard}
globalThis.api={runList,baselineList,seed,activeSession,isBusy,sessions};
`
try{
 const code=transformSync(cls+count+split+member+awaiting+resolve+list+beforeList+support,{loader:'ts',format:'cjs',target:'node24'}).code
 vm.runInNewContext(code,sandbox)
 const {api}=sandbox
 api.seed(720);let t=performance.now();const baseline=api.baselineList();console.log(JSON.stringify({case:'before',ms:+(performance.now()-t).toFixed(2),bodyReads:sandbox.reads,hydrations:sandbox.upgrades}))
 api.seed(720);t=performance.now();const cold=api.runList();const coldMs=performance.now()-t
 assert.equal(JSON.stringify(cold),JSON.stringify(baseline),'metadata response must be identical before/after')
 console.log(JSON.stringify({case:'cold',sessions:cold.sessions.length,ms:+coldMs.toFixed(2),bodyReads:sandbox.reads,hydrations:sandbox.upgrades}))
 t=performance.now();const warm=api.runList();const warmMs=performance.now()-t
 assert.equal(JSON.stringify(cold),JSON.stringify(warm))
 console.log(JSON.stringify({case:'warm',ms:+warmMs.toFixed(2),bodyReads:sandbox.reads,hydrations:sandbox.upgrades}))
 if(process.env.NIS_LIST_BASELINE==='1')return
 assert.equal(sandbox.reads,0,'listing metadata must never hydrate/read bodies')
 assert.equal(sandbox.upgrades,0,'listing must not upgrade skeleton sessions')
 api.seed(3);const active=api.activeSession();Object.defineProperty(active,'subRuns',{get(){return this._body.subRuns}});const result=api.runList()
 assert.equal(result.sessions[0].members,1,'count live team only; ignore clone, stale and done')
 assert.equal(api.isBusy(active),true,'a live child pins its source body even if parent status is idle')
 assert.equal(sandbox.reads,0)
 assert.equal(JSON.stringify(result),JSON.stringify(api.baselineList()),'active member response is unchanged')
 active._body.subRuns.call[0].status='done';active._body.subRuns.call[2].status='done'
 assert.equal(api.runList().sessions[0].members,0)
 assert.equal(api.isBusy(active),false)
 console.log('PASS identical cold/warm metadata; zero body I/O; live member counts and body retention preserve runtime semantics')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
