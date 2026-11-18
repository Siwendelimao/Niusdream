"""Additive offline merge. No live RPC apply; kernel locks and journal gate every write.
Sessions/notebook and audited databases. Original objects remain in a non-runnable archive.
"""
import json, pathlib, shutil, hashlib, time, os, uuid, re
from dataMergeLocks import DataLocks

def canon(p):
    s=os.path.normcase(os.path.realpath(str(p)))
    if s.startswith('\\\\?\\unc\\'):s='\\\\'+s[8:]
    elif s.startswith('\\\\?\\'):s=s[4:]
    return s

def checked(p):
    p=pathlib.Path(p).absolute()
    if os.name=='nt' and not str(p).startswith('\\\\?\\'):
        raw=str(p)
        p=pathlib.Path('\\\\?\\UNC\\'+raw[2:] if raw.startswith('\\\\') else '\\\\?\\'+raw)
    for q in (p,*p.parents):
        if q.exists() or q.is_symlink():
            st=q.lstat()
            if q.is_symlink() or getattr(st,'st_file_attributes',0)&0x400:raise ValueError('拒绝链接/目录联接')
    return p

def sha(p):
    checked(p);h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()
def tree(root):
    root=checked(root);out={}
    if not root.exists():return out
    for folder,dirs,files in os.walk(root,followlinks=False):
        for n in dirs:checked(pathlib.Path(folder)/n)
        for n in files:
            p=checked(pathlib.Path(folder)/n);out[p.relative_to(root).as_posix()]=sha(p)
    return out
def jhash(x):return hashlib.sha256(json.dumps(x,sort_keys=True,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def readj(p):return json.loads(checked(p).read_text(encoding='utf-8-sig'))
def writej(p,x):
    p=pathlib.Path(p);p.parent.mkdir(parents=True,exist_ok=True);p=checked(p);p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_name(p.name+'.tmp-'+uuid.uuid4().hex)
    with open(tmp,'x',encoding='utf-8') as f:
        json.dump(x,f,ensure_ascii=True,indent=2,allow_nan=False);f.flush();os.fsync(f.fileno())
    os.replace(tmp,p)
def marker(data):
    data=pathlib.Path(data).absolute()
    return data.parent/('.'+data.name+'.nis-merge-pending.json')
def baseline(data,parts,memory=None,offline=False):
    out={}
    for part in parts:
        if part in ('memory','knowledge'):
            if memory is None:raise ValueError('缺少固定记忆目录')
            db=memory/('memory_system.db' if part=='memory' else 'knowledge.db')
            from dataMergeSnapshot import revision
            if db.exists():out['memory/'+db.name]=revision(db,offline)
            continue
        for name in (('sessions','session-assets') if part=='sessions' else ('notebook.json','notebook-assets')):
            p=data/name
            if p.is_file():out[name]=sha(p)
            elif p.exists():out.update({name+'/'+k:v for k,v in tree(p).items()})
    ledger=data/'merge-import-ledger.json'
    if ledger.exists():out['merge-import-ledger.json']=sha(ledger)
    return out

def session_clean(src,nid,sid,pkg):
    # No workspace, queue, approvals, goal, team, channel, preset, agent or ACP continuation.
    fields=('title','messages','transcript','extTranscript','subRuns','createdAt','updatedAt','titleManual','titleGenerated','lastUsage','lastUsagePromptEstimate','lastTurnTiming','modelUsage','usedModels','turnMetas','usageTotals')
    out={k:src[k] for k in fields if k in src};out.update({'id':nid,'title':'[导入历史] '+str(src.get('title') or '会话'),'permissionMode':'ask','pinned':False,'queuedMessages':[], 'importReview':{'sourceSessionId':sid,'packageHash':pkg,'historyOnly':True}})
    return out

def prepare(data_root,incoming_root,package_hash,parts,work_root,token,memory_root=None,expected_baseline=None):
    data=checked(pathlib.Path(data_root).absolute());incoming=checked(incoming_root);work=checked(work_root);work.mkdir(parents=True,exist_ok=True)
    memory=checked(memory_root) if memory_root else None
    if not parts or any(p not in ('sessions','notebook','memory','knowledge') for p in parts):raise ValueError('不支持此部分的离线提交')
    if (data.parent/('.'+data.name+'.nis-reset-pending.json')).exists():raise ValueError('已有待恢复出厂任务，请先取消')
    if marker(data).exists():raise ValueError('已有待提交合并，请先完成或取消')
    start=baseline(data,parts,memory)
    if expected_baseline is not None and start!=expected_baseline:raise ValueError('本机数据自预览后变化，请重新预览')
    prepared=work/('prepared-'+uuid.uuid4().hex);(prepared/'payload').mkdir(parents=True)
    entries=[];ledger=readj(data/'merge-import-ledger.json') if (data/'merge-import-ledger.json').exists() else {'version':1,'records':{}}
    records=ledger['records'];note_items=None
    def add(rel,obj=None,src=None,root='data'):
        dest=prepared/'payload'/(rel if root=='data' else 'memory/'+rel);dest.parent.mkdir(parents=True,exist_ok=True)
        if obj is not None:writej(dest,obj)
        else:shutil.copyfile(checked(src),dest)
        old=(data if root=='data' else memory)/rel
        entries.append({'root':root,'rel':rel,'payload':str(dest.relative_to(prepared/'payload')).replace('\\','/'),'after':sha(dest),'before':sha(old) if old.exists() else None})
    # Build from private snapshots, not files that the running server may mutate.
    from dataMerge import capture
    snapshot=prepared/'local';snapshot.mkdir()
    for part in parts:
        if part in ('memory','knowledge'):
            name='memory_system.db' if part=='memory' else 'knowledge.db'
            if (memory/name).exists():
                from dataMergeSnapshot import snapshot as db_snapshot
                db_snapshot(memory/name,snapshot/'memory'/name)
        else:
            for name in (('sessions','session-assets') if part=='sessions' else ('notebook.json','notebook-assets')):
                capture(data/name,snapshot/'data'/name,[],data)
    if baseline(data,parts,memory)!=start:raise ValueError('本机数据在快照期间变化，请重新预览')
    for part in parts:
        if part in ('memory','knowledge'):
            from dataMergeSnapshot import revision
            name='memory_system.db' if part=='memory' else 'knowledge.db'
            if revision(snapshot/'memory'/name)!=start.get('memory/'+name):raise ValueError('数据库快照与预览版本不一致')
    db_results={}
    for part in parts:
        if part in ('memory','knowledge'):
            from dataMergeDatabase import merge as merge_database
            name='memory_system.db' if part=='memory' else 'knowledge.db'
            output=prepared/('merged-'+name);archive=prepared/'archive'/(part+'.json');archive.parent.mkdir(parents=True,exist_ok=True)
            db_results[part]=merge_database(part,snapshot/'memory'/name,incoming/'memory'/name,output,archive,records)
            add(name,src=output,root='memory')
            continue
        from dataMerge import record_map
        name='sessions' if part=='sessions' else 'notebook.json'
        remote=record_map(incoming/'data'/name,part)
        local=record_map(snapshot/'data'/name,part)
        if part=='notebook':note_items=list(local.values())
        for sid,obj in remote.items():
            revision=jhash(obj);key=jhash([part,sid,revision])
            if key in records:continue # never resurrect a user-deleted/modified imported copy
            if sid in local and jhash(local[sid])==revision:continue
            nid=('im-' if part=='sessions' else 'nb-im-')+key[:40]
            if nid in local:raise ValueError('导入目标ID冲突，不覆盖')
            archive='archive/'+key+'/'+part+'.json'
            archive_file=prepared/archive;archive_file.parent.mkdir(parents=True,exist_ok=True);writej(archive_file,obj)
            if part=='sessions':add('sessions/'+nid+'.json',obj=session_clean(obj,nid,sid,package_hash))
            else:
                copy=dict(obj);copy['id']=nid;copy['source']='user'
                if sid in local:copy['title']='[导入冲突] '+str(copy.get('title') or '')
                note_items.append(copy)
            records[key]={'part':part,'sourceId':sid,'targetId':nid,'revision':revision,'archive':archive}
        if part=='notebook':add('notebook.json',obj={'version':1,'items':note_items})
        asset='session-assets' if part=='sessions' else 'notebook-assets';src=incoming/'data'/asset
        for rel,digest in tree(src).items():
            # Content-addressed assets keep existing URLs; same-name different bytes is fatal.
            dest=data/asset/rel
            if dest.exists():
                if sha(dest)!=digest:raise ValueError('附件同名不同内容，拒绝导入')
            else:add(asset+'/'+rel,src=src/rel)
    add('merge-import-ledger.json',obj=ledger)
    if baseline(data,parts,memory)!=start:raise ValueError('准备期间本机数据变化，请重新预览')
    j={'format':2,'token':token,'createdAt':time.time(),'dataRoot':str(data),'memoryRoot':str(memory) if memory else None,'parts':parts,'preparedRoot':str(prepared),'baseline':start,'entries':entries,'status':'prepared','archiveHash':tree(prepared/'archive'),'databases':db_results}
    writej(prepared/'commit.json',j)
    # Publication uses exclusive creation; never overwrite a concurrent pending job.
    pending=marker(data)
    with DataLocks([data],'journal'):
        with open(pending,'x',encoding='utf-8') as f:json.dump(j,f,ensure_ascii=True);f.flush();os.fsync(f.fileno())
    return j

def apply_journal(journal_path,expected_data=None,memory_root=None):
    pending=checked(journal_path)
    data=checked(expected_data) if expected_data else checked(readj(pending)['dataRoot'])
    with DataLocks([data],'journal'):
        # Cancellation/publication use this same mutex; never act on a stale journal.
        if not pending.exists():raise ValueError('待提交已取消或不存在')
        return _apply_journal_locked(pending,data,memory_root)

def _apply_journal_locked(pending,expected_data,memory_root):
    j=readj(pending);data=checked(j['dataRoot']);prepared=checked(j['preparedRoot'])
    if j.get('format')!=2 or canon(marker(data))!=canon(pending):raise ValueError('不兼容或错误位置的提交日志')
    if expected_data and canon(data)!=canon(expected_data):raise ValueError('提交目标与本实例不一致')
    memory=checked(memory_root) if memory_root else None
    if j.get('memoryRoot') and (memory is None or canon(memory)!=canon(j['memoryRoot'])):raise ValueError('固定记忆目录已变化，拒绝提交')
    def target_for(e):
        root=e.get('root','data')
        if root not in ('data','memory') or (root=='memory' and memory is None):raise ValueError('提交根非法')
        return checked((data if root=='data' else memory)/e['rel'])
    def source_for(e):return checked(prepared/'payload'/e.get('payload',e['rel']))
    with DataLocks([data,*([memory] if memory else [])],'commit'):
        entries=j['entries'];seen=set()
        if tree(prepared/'archive')!=j.get('archiveHash',{}):raise ValueError('冲突审阅归档已变化')
        for e in entries:
            rel=e['rel'];p=pathlib.PurePosixPath(rel)
            ident=e.get('root','data')+'/'+rel.casefold()
            if p.is_absolute() or any(x in ('','..','.') for x in rel.split('/')) or '\\' in rel or ':' in rel or ident in seen:raise ValueError('提交路径非法')
            payload=e.get('payload',rel)
            if any(x in ('','..','.') for x in payload.split('/')) or '\\' in payload or ':' in payload:raise ValueError('载荷路径非法')
            seen.add(ident);target_for(e)
            if e.get('root')=='memory' and rel not in ('memory_system.db','knowledge.db'):raise ValueError('固定记忆根禁止写入未知文件')
            if e.get('root','data')=='data' and not (rel in ('notebook.json','merge-import-ledger.json') or rel.startswith(('sessions/','session-assets/','notebook-assets/'))):raise ValueError('数据根禁止写入非合并内容')
            if sha(source_for(e))!=e['after']:raise ValueError('待提交内容已变化')
        if j['status']=='committed':
            if any(not target_for(e).exists() or sha(target_for(e))!=e['after'] for e in entries):raise ValueError('已提交数据发生变化，未清理日志')
            pending.unlink();return {'status':'committed','alreadyApplied':True}
        if j['status']=='prepared':
            for e in entries:
                if e.get('root')=='memory':
                    target=target_for(e)
                    wal=pathlib.Path(str(target)+'-wal')
                    if wal.exists() and wal.stat().st_size==0 and not pathlib.Path(str(target)+'-journal').exists():
                        # Exclusive roots are held. Let SQLite close its own empty sidecars;
                        # never unlink a WAL or checkpoint nonempty/unreviewed transactions.
                        import sqlite3
                        raw=str(target)
                        if raw.startswith('\\\\?\\UNC\\'):raw='\\\\'+raw[8:]
                        elif raw.startswith('\\\\?\\'):raw=raw[4:]
                        c=sqlite3.connect(raw,timeout=0)
                        try:
                            status=c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
                            if status and status[0]:raise ValueError('数据库仍有连接占用，拒绝提交')
                        finally:c.close()
                    if any(pathlib.Path(str(target)+s).exists() for s in ('-wal','-journal')):raise ValueError('数据库热日志仍存在，拒绝提交')
            if baseline(data,j['parts'],memory,offline=True)!=j['baseline']:raise ValueError('本机数据在准备后发生变化；未写入，请取消后重新预览')
            backup=prepared/'backup';backup.mkdir(exist_ok=True)
            for e in entries:
                target=target_for(e)
                # A normal WAL checkpoint changes physical DB bytes, not logical rows.
                if e.get('root')=='memory':e['before']=sha(target) if target.exists() else None
                if (sha(target) if target.exists() else None)!=e['before']:raise ValueError('本机文件变化，拒绝提交')
                if e['before']:
                    b=backup/e.get('root','data')/e['rel'];b.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(target,b)
                    if sha(b)!=e['before']:raise ValueError('备份校验失败')
            j['status']='applying';writej(pending,j)
        elif j['status']!='applying':raise ValueError('未知提交日志状态')
        # Validate every target before the first write, including resume across DB/data roots.
        for e in entries:
            target=target_for(e);current=sha(target) if target.exists() else None
            if current not in (e['before'],e['after']):raise ValueError('恢复发现非预期文件变化；禁止启动，需人工核查')
            if e.get('root')=='memory':
                for suffix in ('-wal','-journal'):
                    if pathlib.Path(str(target)+suffix).exists():raise ValueError('数据库热日志仍存在，拒绝提交')
        for e in entries:
            target=target_for(e);current=sha(target) if target.exists() else None
            if current==e['after']:continue
            target.parent.mkdir(parents=True,exist_ok=True);temp=target.with_name(target.name+'.merge-'+uuid.uuid4().hex)
            shutil.copyfile(source_for(e),temp)
            with open(temp,'r+b') as f:f.flush();os.fsync(f.fileno())
            os.replace(temp,target)
        j['status']='committed';writej(pending,j);writej(prepared/'commit.json',j);pending.unlink()
        return {'status':'committed','backup':str(prepared/'backup'),'entries':len(entries)}

def cancel_pending(data_root,token=None):
    data=checked(data_root);pending=marker(data)
    with DataLocks([data],'journal'):
        if not pending.exists():return {'ok':True,'cancelled':True,'alreadyAbsent':True}
        j=readj(pending)
        if canon(j['dataRoot'])!=canon(data) or (token and j.get('token')!=token):raise ValueError('待提交标识不匹配')
        if j.get('status')!='prepared':raise ValueError('已开始提交，不能取消；必须先完成恢复')
        j['status']='cancelled';writej(checked(j['preparedRoot'])/'commit.json',j)
        pending.unlink()
        return {'ok':True,'cancelled':True}

if __name__=='__main__':
    import sys
    try:
        req=json.loads(sys.stdin.buffer.read());print(json.dumps(cancel_pending(req['dataRoot']) if req.get('action')=='cancel' else apply_journal(req['journal'],req['dataRoot'],req['memoryRoot'])))
    except Exception as e:print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=True));sys.exit(1)
