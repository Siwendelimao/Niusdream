"""Offline factory reset: quarantine app-owned state, never recursively delete user paths."""
import os,sys,pathlib,json,time,uuid
from dataMergeApply import checked,canon,readj,writej,marker as merge_marker
from dataMergeLocks import DataLocks

CONFIRM='恢复出厂设置'
def marker(data):
    data=pathlib.Path(data).absolute();return data.parent/('.'+data.name+'.nis-reset-pending.json')
def epoch_file(data):
    data=pathlib.Path(data).absolute();return data.parent/('.'+data.name+'.nis-reset-epoch.json')
def context(req):
    roots={k:checked(req[k]) for k in ('dataRoot','memoryRoot','skillsRoot','appRoot')}
    for k,p in roots.items():
        if p.parent==p:raise ValueError('拒绝磁盘根目录')
    app=roots['appRoot'];data=roots['dataRoot']
    if canon(data) not in (canon(app/'data'),canon(app/'backend/data')):raise ValueError('当前数据根不是本安装默认受管目录，拒绝出厂重置；请先迁回默认数据位置')
    if canon(roots['skillsRoot']) not in (canon(app/'skills'),canon(app/'backend/skills')):raise ValueError('自定义或共享技能目录不能用于出厂重置')
    if canon(roots['memoryRoot'])!=canon(app/'memory'):raise ValueError('重置仅允许本安装固定memory目录')
    for k in ('memoryRoot','skillsRoot'):
        if canon(roots[k])==canon(app) or canon(roots[k])==canon(data) or canon(roots[k])==canon(app/'backend'):raise ValueError('重置目录重叠')
    values=list(roots.items())
    for k,p in values:
        if k=='appRoot':continue
        for key,q in values:
            if key in (k,'appRoot'):continue
            if canon(p).startswith(canon(q)+os.sep) or canon(q).startswith(canon(p)+os.sep):raise ValueError('重置根不能互相包含')
    return roots

def targets(roots):
    d=roots['dataRoot'];a=roots['appRoot']
    out=[]
    if d.exists():
        for p in sorted(d.iterdir()):
            # Installed runtime/tooling and actual project files are NOT app-state.
            if p.name in ('env','storage','tools'):continue
            out.append(('data',checked(p)))
    for key,label in [('memoryRoot','memory'),('skillsRoot','skills')]:
        root=roots[key]
        if root.exists():
            out.extend((label,checked(p)) for p in sorted(root.iterdir()))
    for label,p in [('external-credentials',a/'external-agents'/'credentials.json'),('voice-config',d/'env'/'voice'/'config.json'),('merge-review',d.parent/'.nis-merge-review')]:
        if p.exists():out.append((label,checked(p)))
    return out

def validate_tree(p):
    checked(p)
    if p.is_dir():
        for folder,dirs,files in os.walk(p,followlinks=False):
            for name in dirs+files:checked(pathlib.Path(folder)/name)

def preview(req):
    r=context(req);d=r['dataRoot'];entries=targets(r)
    # External env configuration is not deleted by guessing an arbitrary folder.
    settings=d/'settings.json'
    cfg=readj(settings) if settings.exists() else {}
    env=str(cfg.get('envDir') or '').strip()
    if env and canon(env)!=canon(d/'env'):raise ValueError('检测到自定义软件环境目录，暂不支持完整重置；请先将环境迁回默认目录，避免遗漏语音配置或误删共享环境')
    return {'ok':True,'targets':[{'group':g,'path':str(p),'kind':'directory' if p.is_dir() else 'file'} for g,p in entries],
        'preserved':[str(d/'env'),str(d/'storage'),str(d/'tools'),'软件程序/依赖/外部agent安装文件','外部项目和已导出的备份','操作系统环境变量与外部CLI账号'],
        'warning':'清空活动数据与设置；旧数据移入隔离备份，非隐私安全擦除。执行时包括确认后新增的数据。',
        'pending':marker(d).exists(),'confirmation':CONFIRM}

def prepare(req):
    r=context(req);d=r['dataRoot'];preview(req)
    if req.get('confirmation')!=CONFIRM:raise ValueError('必须输入完整确认文字')
    if not req.get('acknowledged'):raise ValueError('必须确认包含当前对话、密钥及登录态，且了解隔离备份仍含旧数据')
    with DataLocks([d],'journal'):
        if merge_marker(d).exists():raise ValueError('请先取消待提交合并，不能同时重置')
        if marker(d).exists():raise ValueError('已有待重置任务')
        job=uuid.uuid4().hex
        j={'format':1,'status':'prepared','id':job,'createdAt':time.time(),'roots':{k:str(p) for k,p in r.items()},'backup':str(d.parent/('.nis-factory-reset-'+job))}
        writej(marker(d),j)
    return {'ok':True,'prepared':True,'restartRequired':True,'id':job,'backup':j['backup']}

def cancel(req):
    r=context(req);d=r['dataRoot']
    with DataLocks([d],'journal'):
        p=marker(d)
        if not p.exists():return {'ok':True,'cancelled':True}
        j=readj(p)
        if j['status']!='prepared':raise ValueError('重置已经开始，不能取消；请先恢复执行')
        p.unlink();return {'ok':True,'cancelled':True}

def apply(req):
    r=context(req);d=r['dataRoot'];p=marker(d)
    with DataLocks([d],'journal'),DataLocks([d,r['memoryRoot'],r['skillsRoot'],r['appRoot']/'external-agents'],'commit'):
        j=readj(p)
        if j.get('format')!=1 or any(canon(v)!=canon(r[k]) for k,v in j['roots'].items()) or set(j['roots'])!=set(r):raise ValueError('重置目录与当前实例不一致')
        backup=checked(d.parent/('.nis-factory-reset-'+j['id']))
        if len(j['id'])!=32 or any(c not in '0123456789abcdef' for c in j['id']):raise ValueError('重置标识非法')
        if canon(backup)!=canon(j['backup']):raise ValueError('隔离备份位置不一致')
        if merge_marker(d).exists():raise ValueError('检测到待提交合并，拒绝重置')
        if j['status']=='prepared':
            preview(req)
            current=targets(r)
            for _,src in current:validate_tree(src)
            # Move plans are journaled before the first rename; recovery only rolls forward.
            j['entries']=[{'source':str(src),'dest':str(backup/g/src.name)} for g,src in current]
            j['status']='applying';writej(p,j)
        if j['status'] not in ('applying','committed'):raise ValueError('未知重置状态')
        allowed_roots=[d,r['memoryRoot'],r['skillsRoot'],r['appRoot']/'external-agents',d.parent]
        for entry in j['entries']:
            src=checked(entry['source']);dest=checked(entry['dest'])
            if not any(canon(src.parent)==canon(x) for x in allowed_roots) and canon(src)!=canon(d/'env/voice/config.json'):raise ValueError('日志清理目标越界')
            if canon(src.parent)==canon(d.parent) and src.name!='.nis-merge-review':raise ValueError('禁止清理数据根的其他兄弟目录')
            if canon(src.parent)==canon(r['appRoot']/'external-agents') and src.name!='credentials.json':raise ValueError('禁止清理外部软件安装文件')
            if src.parent==d and src.name in ('env','storage','tools'):raise ValueError('禁止清理运行环境或项目')
            if not canon(dest).startswith(canon(backup)+os.sep):raise ValueError('日志隔离目标越界')
            if src.exists() and dest.exists():raise ValueError('隔离源与目标同时存在，拒绝覆盖')
            if not src.exists() and not dest.exists():raise ValueError('重置源丢失，需人工核查')
        for entry in j['entries']:
            src=checked(entry['source']);dest=checked(entry['dest'])
            if src.exists():
                dest.parent.mkdir(parents=True,exist_ok=True);os.rename(src,dest)
        for key in ('dataRoot','memoryRoot','skillsRoot'):r[key].mkdir(parents=True,exist_ok=True)
        # Publish the new generation before any application module can load.
        writej(epoch_file(d),{'epoch':j['id'],'resetAt':time.time()})
        j['status']='committed';writej(p,j);writej(backup/'RESET.json',j);p.unlink()
        return {'ok':True,'status':'committed','backup':str(backup),'epoch':j['id']}

def run(req):
    action=req.get('action')
    if action=='preview':return preview(req)
    if action=='prepare':return prepare(req)
    if action=='cancel':return cancel(req)
    if action=='apply':return apply(req)
    if action=='status':
        r=context(req);p=marker(r['dataRoot']);j=readj(p) if p.exists() else None
        return {'ok':True,'pending':bool(j),'status':j['status'] if j else None}
    raise ValueError('未知操作')
if __name__=='__main__':
    try:print(json.dumps(run(json.loads(sys.stdin.buffer.read())),ensure_ascii=True))
    except Exception as e:print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=True));sys.exit(1)
