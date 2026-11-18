"""Offline import preview/review candidate. Never writes a live data member.
Run only via dataMerge.ts, JSON request on stdin. Standard library only.
A candidate is deliberately NOT a nis-backup and cannot be imported as a restore.
"""
import sys, os, json, hashlib, pathlib, sqlite3, tarfile, shutil, time, uuid, re
from dataMergeDatabase import merge as merge_database
from dataMergeApply import prepare as prepare_merge, marker as merge_marker, cancel_pending, baseline as merge_baseline

def prog(percent,phase):
    try:
        sys.stderr.write('#p %d %s\n'%(int(percent),phase));sys.stderr.flush()
    except Exception:pass

MAX_BYTES = 8 * 1024**3
MAX_FILE = 2 * 1024**3
MAX_ENTRIES = 100000
MAX_JSON = 128 * 1024**2
PARTS = {
    'sessions': [('data', 'sessions'), ('data', 'session-assets')],
    'notebook': [('data', 'notebook.json'), ('data', 'notebook-assets')],
    'memory': [('memory', 'memory_system.db')],
    'knowledge': [('memory', 'knowledge.db'), ('data','knowledge-attachments')],
}
REVIEW_PARTS = {'sessions', 'notebook'}
RESERVED = {'CON','PRN','AUX','NUL', *('COM'+str(i) for i in range(1,10)), *('LPT'+str(i) for i in range(1,10))}

def fail(s): raise ValueError(s)
def safe_rel(s):
    if not isinstance(s, str) or not s or any(ord(c)<32 for c in s) or '\\' in s or ':' in s or s.startswith('/'): return False
    xs=s.rstrip('/').split('/')
    return all(x and x not in ('.','..') and not x.endswith((' ','.')) and not any(c in x for c in '<>"|?*') and x.split('.')[0].upper() not in RESERVED for x in xs)
def no_links(p):
    p=pathlib.Path(p)
    for q in [p,*p.parents]:
        if q.exists() or q.is_symlink():
            st=q.lstat()
            if q.is_symlink() or getattr(st,'st_file_attributes',0)&0x400: fail('拒绝符号链接/目录联接')
def hfile(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()
def stable_read(p):
    no_links(p)
    s=p.stat()
    if s.st_size>MAX_JSON: fail('单个JSON超过预览限制')
    b=p.read_bytes(); after=p.stat()
    if (s.st_size,s.st_mtime_ns)!=(after.st_size,after.st_mtime_ns): fail('数据在预览期间变化，请稍后重试')
    return b

def jhash(x): return hashlib.sha256(json.dumps(x,sort_keys=True,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def json_read(p):
    def dup(pairs):
        d={}
        for k,v in pairs:
            if k in d: fail('JSON含重复字段')
            d[k]=v
        return d
    return json.loads(stable_read(p).decode('utf-8-sig'),object_pairs_hook=dup,parse_constant=lambda _:fail('JSON含非有限数字'))
def put_json(p,x):
    p.parent.mkdir(parents=True,exist_ok=True)
    with open(p,'x',encoding='utf-8') as f: json.dump(x,f,ensure_ascii=True,indent=2,allow_nan=False)

def extract(pkg,target):
    no_links(pkg); before=hfile(pkg)
    with tarfile.open(pkg,'r:gz') as t:
        seen={}; entries=[]; total=0
        # Iterate with quotas; don't materialize an unbounded member list first.
        for m in t:
            if len(entries)>=MAX_ENTRIES: fail('归档成员过多')
            if not safe_rel(m.name) or not (m.isfile() or m.isdir()): fail('归档含危险路径/链接/特殊文件')
            key=m.name.rstrip('/').casefold()
            if key in seen: fail('归档含重复或大小写冲突路径')
            seen[key]=m
            total+=m.size
            if m.size<0 or m.size>MAX_FILE or total>MAX_BYTES: fail('归档展开体积超过限制')
            entries.append(m)
        # Reject file/parent collisions independent of extraction order.
        for key,m in seen.items():
            for p in pathlib.PurePosixPath(key).parents:
                if str(p) in seen and not seen[str(p)].isdir(): fail('归档父路径不是目录')
        if 'nis-manifest.json' not in seen or not seen['nis-manifest.json'].isfile() or seen['nis-manifest.json'].size>4*1024**2: fail('缺少有效清单')
        mf=json.loads(t.extractfile(seen['nis-manifest.json']).read().decode('utf-8-sig'))
        if mf.get('kind')!='nis-backup' or mf.get('version')!=2 or not isinstance(mf.get('parts'),dict): fail('首版预览仅支持nis-backup v2；不支持的版本不会自动降级')
        arcs=[]
        for part,v in mf['parts'].items():
            if not isinstance(v,dict) or not isinstance(v.get('members'),list): fail('清单结构异常')
            for m in v['members']:
                if not isinstance(m,dict) or m.get('root') not in ('data','memory','skills','storage') or not safe_rel(m.get('name')) or not safe_rel(m.get('arc')): fail('清单路径非法')
                arc=m['arc'].rstrip('/')
                arcs.append(arc)
                # Supported parts have an explicit semantic member allowlist.
                if part in PARTS and (m['root'],m['name']) not in PARTS[part]:
                    # WAL/SHM must be understood, not silently discarded.
                    fail('所选格式含未知数据成员，需升级导入器')
                if arc.casefold() not in seen: fail('清单成员缺失')
        for m in entries:
            n=m.name.rstrip('/')
            if n!='nis-manifest.json' and not any(n==a or n.startswith(a+'/') for a in arcs): fail('归档存在清单外成员')
        # Only extract the selected known content parts, never settings/keys/scripts.
        wanted=[]
        for part in REQUEST['parts']:
            if part not in PARTS: continue
            for m in mf['parts'].get(part,{}).get('members',[]): wanted.append(m['arc'].rstrip('/'))
        for m in entries:
            n=m.name.rstrip('/')
            if not any(n==a or n.startswith(a+'/') for a in wanted): continue
            dst=target.joinpath(*n.split('/'))
            if m.isdir(): dst.mkdir(parents=True,exist_ok=True)
            else:
                dst.parent.mkdir(parents=True,exist_ok=True)
                with t.extractfile(m) as src,open(dst,'xb') as out: shutil.copyfileobj(src,out,1024*1024)
    if hfile(pkg)!=before: fail('预览期间数据包发生变化')
    return mf,before

def member(mf,part,root,name,stage):
    for m in mf['parts'].get(part,{}).get('members',[]):
        if m['root']==root and m['name']==name: return stage.joinpath(*m['arc'].split('/'))
    return None

def capture(src,dst,inventory,root):
    if not src.exists(): return
    no_links(src)
    if src.is_dir():
        dst.mkdir(parents=True,exist_ok=True)
        for p in sorted(src.iterdir()): capture(p,dst/p.name,inventory,root)
    else:
        s=src.stat(); dst.parent.mkdir(parents=True,exist_ok=True)
        with open(src,'rb') as i,open(dst,'xb') as o: shutil.copyfileobj(i,o,1024*1024)
        a=src.stat(); v=hfile(dst)
        if (s.st_size,s.st_mtime_ns)!=(a.st_size,a.st_mtime_ns) or hfile(src)!=v: fail('本机数据正在变化，请重新预览')
        inventory.append({'path':str(src.relative_to(root)).replace('\\','/'),'sha256':v,'bytes':s.st_size})

def tree_inventory(root):
    records=[]
    if not root.exists(): return records
    for folder,dirs,files in os.walk(root,followlinks=False):
        no_links(pathlib.Path(folder))
        for name in dirs: no_links(pathlib.Path(folder)/name)
        for name in sorted(files):
            p=pathlib.Path(folder)/name; no_links(p)
            records.append({'path':str(p.relative_to(root)).replace('\\','/'),'sha256':hfile(p)})
    return sorted(records,key=lambda x:x['path'])

def sanitize_session(src, new_id, source_id):
    # Imported history must never resume queued work, tools, external ACP, or a local path.
    keep={'id':new_id,'title':str(src.get('title') or '导入会话'),'messages':src.get('messages',[]),
          'createdAt':src.get('createdAt'),'updatedAt':src.get('updatedAt'),'model':src.get('model',''),
          'modelProviderId':src.get('modelProviderId'),'effort':src.get('effort'),'titleManual':src.get('titleManual'),
          'titleGenerated':src.get('titleGenerated'),'pinned':False,'system':src.get('system'),
          'mode':src.get('mode'),'transcript':src.get('transcript',[]),'extTranscript':src.get('extTranscript',[]),
          'lastUsage':src.get('lastUsage'),'lastUsagePromptEstimate':src.get('lastUsagePromptEstimate'),
          'lastTurnTiming':src.get('lastTurnTiming'),'modelUsage':src.get('modelUsage',{}),'usedModels':src.get('usedModels',{}),
          'turnMetas':src.get('turnMetas',{}),'usageTotals':src.get('usageTotals',{}),
          'importReview':{'sourceSessionId':source_id,'candidateOnly':True,'historyOnly':True,'requiresUserStart':True}}
    return {k:v for k,v in keep.items() if v is not None}
def record_map(p,kind):
    if p is None or not p.exists(): return {}
    if kind=='sessions':
        out={}
        for f in sorted(p.iterdir()):
            # Known local backup/trash entries are not active sessions. Keep them
            # in the local snapshot but don't resurrect them as imported records.
            if f.name == 'sessions.trash' and f.is_dir(): continue
            if f.is_file() and '.json.bak-' in f.name: continue
            if not f.is_file() or f.suffix!='.json': fail('会话目录含未知成员，首版拒绝猜测')
            obj=json_read(f)
            if not isinstance(obj,dict) or not isinstance(obj.get('id'),str) or f.stem!=obj['id'] or not isinstance(obj.get('messages'),list): fail('会话结构或ID不兼容')
            out[obj['id']]=obj
        return out
    obj=json_read(p)
    if not isinstance(obj,dict) or obj.get('version')!=1 or not isinstance(obj.get('items'),list): fail('便签格式不兼容')
    out={}
    for item in obj['items']:
        if not isinstance(item,dict) or not isinstance(item.get('id'),str) or item['id'] in out: fail('便签ID缺失/重复')
        out[item['id']]=item
    return out

def compare(local,incoming):
    same=[];add=[];conflicts=[]
    for key,v in incoming.items():
        if key not in local: add.append(key)
        elif jhash(v)==jhash(local[key]):same.append(key)
        else:conflicts.append(key)
    return {'local':len(local),'incoming':len(incoming),'same':len(same),'added':len(add),'conflicts':len(conflicts),'localOnly':len(set(local)-set(incoming))},add,conflicts

def db_summary(src,dst,table):
    if src is None or not src.exists(): return {'present':False}
    # Package copies and local backup snapshots are read-only here. Don't instantiate application stores.
    raw=str(src); raw=raw[4:] if raw.startswith('\\\\?\\') else raw
    c=sqlite3.connect(pathlib.Path(raw).as_uri()+'?mode=ro&immutable=1',uri=True)
    try:
        if c.execute('PRAGMA integrity_check').fetchone()[0]!='ok': fail('数据库完整性检查失败')
        count=c.execute('SELECT count(*) FROM "'+table+'"').fetchone()[0]
        return {'present':True,'records':count,'userVersion':c.execute('PRAGMA user_version').fetchone()[0]}
    finally:c.close()

def run():
    if REQUEST['action']=='cancel':return cancel_pending(REQUEST['dataRoot'])
    if REQUEST['action']=='status':
        pending=merge_marker(pathlib.Path(REQUEST['dataRoot']))
        if not pending.exists():return {'ok':True,'pending':False}
        j=json_read(pending)
        return {'ok':True,'pending':True,'status':j.get('status'),'restartRequired':True,'token':j.get('token')}
    root=pathlib.Path(REQUEST['workRoot']).absolute(); no_links(root); root.mkdir(parents=True,exist_ok=True)
    if os.name == 'nt' and not str(root).startswith('\\\\?\\'): root=pathlib.Path('\\\\?\\'+str(root))
    token=REQUEST['token']
    if not isinstance(token,str) or len(token)!=32 or any(c not in '0123456789abcdef' for c in token):fail('预览标识非法')
    job=root/token
    if REQUEST['action']=='preview':
        prog(3,'读取数据包')
        job.mkdir(); stage=job/'incoming';stage.mkdir(); mf,pkg_hash=extract(pathlib.Path(REQUEST['zipPath']),stage)
        prog(20,'已解包，正在比对')
        snapshots=job/'local';snapshots.mkdir(); inventory=[];result=[];ops={}
        data=pathlib.Path(REQUEST['dataRoot']); memory=pathlib.Path(REQUEST['memoryRoot']);no_links(data);no_links(memory)
        selected=[p for p in REQUEST['parts'] if p in PARTS]
        prog(25,'扫描本机数据')
        before=merge_baseline(data,selected,memory)
        done=0
        for part in REQUEST['parts']:
            if part not in mf['parts']:fail('包内缺少所选部分')
            prog(30+int(55*done/max(1,len(REQUEST['parts']))),'比对 '+str(part))
            done+=1
            if part not in PARTS:
                result.append({'id':part,'supported':False,'note':'首版不合并此部分，请取消勾选；不会自动恢复覆盖'});continue
            if part in REVIEW_PARTS:
                for r,n in PARTS[part]:capture(data/n,snapshots/r/n,inventory,data)
                n='sessions' if part=='sessions' else 'notebook.json'
                l=record_map(snapshots/'data'/n,part);ip=member(mf,part,'data',n,stage)
                if ip is None or not ip.exists(): fail('所选部分缺少必需记录成员')
                i=record_map(ip,part)
                summary,add,conf=compare(l,i);summary.update({'id':part,'supported':True,'note':'预览不写入。确认准备后由用户手动重启提交；相同跳过、独有追加、冲突保留历史副本及原文。'})
                result.append(summary);ops[part]={'added':add,'conflicts':conf}
            else:
                db='memory_system.db' if part=='memory' else 'knowledge.db';table='memory_records' if part=='memory' else 'knowledge_entries'
                # Online SQLite backup includes committed WAL; merge only its private copy.
                src=memory/db; no_links(src)
                if src.exists():
                    from dataMergeSnapshot import snapshot as db_snapshot
                    db_snapshot(src,snapshots/'memory'/db)
                    from dataMergeSnapshot import revision
                    if revision(snapshots/'memory'/db)!=before.get('memory/'+db):fail('数据库快照期间变化，请重新预览')
                ip=member(mf,part,'memory',db,stage)
                if ip is None or not ip.exists():fail('包内缺少所选数据库')
                analysis=job/'db-preview';analysis.mkdir(exist_ok=True)
                stats=merge_database(part,snapshots/'memory'/db,ip,analysis/db,analysis/(part+'-archive.json'),json_read(data/'merge-import-ledger.json').get('records',{}) if (data/'merge-import-ledger.json').exists() else {})
                primary='memory_records' if part=='memory' else 'knowledge_entries'
                result.append({'id':part,'supported':True,'local':db_summary(snapshots/'memory'/db,None,table),'incoming':db_summary(ip,None,table),'same':stats['same'],'added':stats['tables'].get(primary,0),'conflicts':stats['conflicts'],'withheld':stats['withheld'],'detached':stats['detached'],'database':stats,'note':'保留本机同ID修订；只追加关系闭合的独有记录。统计same/conflicts为业务表行，added为主记录；未接纳的关联与原文另存审阅。不导入任务/项目执行配置。'})
        prog(90,'复验本机数据')
        if merge_baseline(data,selected,memory)!=before:fail('本机数据在预览期间变化，请重新预览')
        prog(95,'写入预览结果')
        plan={'baseline':before,'format':1,'createdAt':time.time(),'zipPath':REQUEST['zipPath'],'packageHash':pkg_hash,'dataRoot':str(data),'memoryRoot':str(memory),'parts':REQUEST['parts'],'inventory':inventory,'results':result,'ops':ops,'manifest':mf,'incomingInventory':tree_inventory(stage),'snapshotInventory':tree_inventory(snapshots)}
        put_json(job/'plan.json',plan)
        return {'ok':True,'token':token,'parts':result,'candidateOnly':True,'canBuild':bool(result) and all(x['supported'] for x in result),'warning':'预览不是一致全量备份；候选不是可恢复包，不会修改当前数据'}
    if REQUEST['action']=='prepare':
        plan=json_read(job/'plan.json')
        if time.time()-plan['createdAt']>1800:fail('预览已过期，请重新预览')
        if not all(x['supported'] for x in plan['results']):fail('请取消尚不支持合并的部分并重新预览')
        if hfile(pathlib.Path(plan['zipPath']))!=plan['packageHash']:fail('数据包已变化，请重新预览')
        if tree_inventory(job/'incoming')!=plan['incomingInventory'] or tree_inventory(job/'local')!=plan['snapshotInventory']:fail('暂存内容已变化，请重新预览')
        if merge_baseline(pathlib.Path(plan['dataRoot']),plan['parts'],pathlib.Path(plan['memoryRoot']))!=plan['baseline']:fail('本机数据自预览后变化，请重新预览')
        journal=prepare_merge(plan['dataRoot'],job/'incoming',plan['packageHash'],plan['parts'],job,REQUEST['token'],plan['memoryRoot'],plan['baseline'])
        return {'ok':True,'prepared':True,'candidateOnly':False,'restartRequired':True,'journal':str(merge_marker(journal['dataRoot'])),'warning':'已生成待下次启动提交的隔离合并；当前后端未写入，必须先停止旧后端再启动应用'}
    if REQUEST['action']!='build':fail('不支持的操作')
    plan=json_read(job/'plan.json')
    if time.time()-plan['createdAt']>1800:fail('预览已过期，请重新预览')
    if not all(x['supported'] for x in plan['results']):fail('请取消尚不支持合并的部分并重新预览')
    if hfile(pathlib.Path(plan['zipPath']))!=plan['packageHash']:fail('数据包已变化，请重新预览')
    if tree_inventory(job/'incoming')!=plan['incomingInventory'] or tree_inventory(job/'local')!=plan['snapshotInventory']:fail('暂存内容已变化，请重新预览')
    data=pathlib.Path(plan['dataRoot']);current=[]
    # Re-list all selected members so new/deleted files also invalidate preview.
    verify=job/('verify-'+uuid.uuid4().hex);verify.mkdir()
    for part in plan['parts']:
        if part in REVIEW_PARTS:
            for r,n in PARTS[part]:capture(data/n,verify/r/n,current,data)
        else:
            db='memory_system.db' if part=='memory' else 'knowledge.db'
            src=pathlib.Path(plan['memoryRoot'])/db
            snap=job/'local'/'memory'/db
            from dataMergeSnapshot import revision
            if revision(src)!=revision(snap):fail('本机数据库已变化，请重新预览')
    if sorted(current,key=lambda x:x['path'])!=sorted(plan['inventory'],key=lambda x:x['path']):fail('本机数据自预览后已变化，请重新预览；未写入当前数据')
    final=job/'candidate'
    if final.exists():return {'ok':True,'candidateOnly':True,'path':str(final),'parts':plan['results'],'alreadyBuilt':True}
    temp=job/('candidate-'+uuid.uuid4().hex);temp.mkdir();stage=job/'incoming';snap=job/'local'
    shutil.copytree(snap,temp/'local-snapshot')
    for part in plan['parts']:
        if part not in REVIEW_PARTS:
            shutil.copytree(job/'db-preview',temp/'database-preview',dirs_exist_ok=True)
            continue
        n='sessions' if part=='sessions' else 'notebook.json'
        incoming=record_map(member(plan['manifest'],part,'data',n,stage),part)
        for kind,ids in plan['ops'][part].items():
            for ident in ids:
                # The review archive must preserve the exact original, including opaque fields.
                # Runnable copies are sanitized separately by the offline merge tool.
                value=incoming[ident];ident_hash=hashlib.sha256(ident.encode('utf-8','surrogatepass')).hexdigest()
                put_json(temp/kind/part/(ident_hash+'-'+jhash(value)+'.json'),value)
        # Preserve incoming assets as a separate namespace; never rewrite active paths/IDs.
        asset='session-assets' if part=='sessions' else 'notebook-assets';p=member(plan['manifest'],part,'data',asset,stage)
        if p and p.exists():shutil.copytree(p,temp/'incoming-assets'/asset)
    put_json(temp/'REVIEW-ONLY.json',{'kind':'nis-merge-review','version':1,'notImportable':True,'createdAt':time.time(),'packageHash':plan['packageHash'],'parts':plan['results'],'warning':'供审阅的候选文件，不是NIS恢复包。未重映射ID、工作区/附件引用或运行态；禁止直接复制到现用数据目录。'})
    temp.rename(final)
    # This marker is deliberately only inside the review candidate. It is never copied
    # into DATA_ROOT, so the running application cannot observe a half-applied import.
    return {'ok':True,'candidateOnly':True,'path':str(final),'parts':plan['results'],'backups':1,'warning':'仅生成候选，本机数据未切换，任务/通道/密钥均未启用'}

if __name__=='__main__':
    try:
        raw=sys.stdin.buffer.read(1024*1024+1)
        if len(raw)>1024*1024:fail('请求过大')
        REQUEST=json.loads(raw.decode('utf-8'))
        if not isinstance(REQUEST.get('parts',[]),list):fail('parts格式错误')
        result=run();print(json.dumps(result,ensure_ascii=True))
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=True));sys.exit(1)
