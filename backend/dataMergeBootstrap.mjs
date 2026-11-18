import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { mergePythonCommand } from './dataMergePython.mjs'
const here=import.meta.dirname
const data=path.resolve(process.env.NIS_DATA_DIR||path.join(here,'data'))
const pending=path.join(path.dirname(data),'.'+path.basename(data)+'.nis-merge-pending.json')
const resetPending=path.join(path.dirname(data),'.'+path.basename(data)+'.nis-reset-pending.json')
if(fs.existsSync(resetPending)){
  if(fs.existsSync(pending)){console.error('[bootstrap] merge and reset cannot both be pending');process.exit(73)}
  const py=mergePythonCommand()
  const request={action:process.argv.includes('--cancel-pending-reset')?'cancel':'apply',dataRoot:data,memoryRoot:process.env.NIS_MEMORY_DIR||path.join(here,'..','memory'),skillsRoot:process.env.NIS_SKILLS_DIR||path.join(here,'skills'),appRoot:path.dirname(path.resolve(process.env.NIS_MEMORY_DIR||path.join(here,'..','memory')))}
  const r=spawnSync(py.bin,[...py.pre,'-B',path.join(here,'factoryReset.py')],{input:JSON.stringify(request),cwd:here,encoding:'utf8',windowsHide:true,timeout:120000,env:{...process.env,PYTHONIOENCODING:'utf-8'}})
  if(r.status!==0 || fs.existsSync(resetPending)){console.error('[reset-bootstrap] reset refused:',r.stderr||r.stdout);process.exit(74)}
}
if(process.argv.includes('--cancel-pending-reset')){console.log('Pending reset cancelled or absent; no application started.');process.exit(0)}
if(fs.existsSync(pending)){
  const py=mergePythonCommand();const script=path.join(here,'dataMergeApply.py')
  const req=JSON.stringify({action:process.argv.includes('--cancel-pending-merge')?'cancel':'apply',journal:pending,dataRoot:data,memoryRoot:process.env.NIS_MEMORY_DIR||path.join(here,'..','memory')})
  const r=spawnSync(py.bin,[...(py.pre||[]),'-B',script],{input:req,cwd:here,encoding:'utf8',windowsHide:true,timeout:120000,env:{...process.env,PYTHONIOENCODING:'utf-8'}})
  if(r.status!==0){console.error('[merge-bootstrap] pending merge refused:',r.stderr||r.stdout);process.exit(70)}
  if(fs.existsSync(pending)){console.error('[merge-bootstrap] application did not clear pending marker');process.exit(71)}
}
// Explicit recovery command never starts application modules.
if(process.argv.includes('--cancel-pending-merge')){console.log('Pending merge cancelled or absent; no application started.');process.exit(0)}
// Await protection before even initiating business module evaluation.
await import(new URL('./dataRuntimeGuard.ts', import.meta.url).href)
await import(new URL('./server.ts', import.meta.url).href)
