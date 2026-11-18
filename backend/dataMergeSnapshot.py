"""SQLite consistent snapshots and physical-layout-independent revision checks."""
import sys,json,pathlib,sqlite3,time,hashlib,base64
from dataMergeApply import checked

def read_connection(source,offline=False):
    source=checked(source);raw=str(source)
    if raw.startswith('\\\\?\\UNC\\'):raw='\\\\'+raw[8:]
    elif raw.startswith('\\\\?\\'):raw=raw[4:]
    return sqlite3.connect(pathlib.Path(raw).as_uri()+('?mode=ro&immutable=1' if offline else '?mode=ro'),uri=True,timeout=5)

def revision(source,offline=False):
    if not pathlib.Path(source).exists():return None
    c=read_connection(source,offline)
    try:
        c.execute('BEGIN')
        # Full schema and business rows; FTS pages are local derived search indexes.
        definitions=c.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
        tables=[r[1] for r in definitions if r[0]=='table' and not r[1].startswith('sqlite_') and 'fts' not in r[1]]
        def encode(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'),default=lambda b:{'$blob':base64.b64encode(b).decode('ascii')})
        h=hashlib.sha256(encode(definitions).encode())
        for table in tables:
            if '"' in table:raise ValueError('不支持的表名称')
            values=sorted(encode(row) for row in c.execute('SELECT * FROM "'+table+'"'))
            h.update(encode([table,values]).encode())
        return h.hexdigest()
    finally:c.close()

def snapshot(source,destination):
    source=checked(source);destination=checked(destination)
    if not source.is_file():raise ValueError('数据库源不存在')
    destination.parent.mkdir(parents=True,exist_ok=True)
    if destination.exists():raise ValueError('快照目标已存在')
    dest_raw=str(destination)
    if dest_raw.startswith('\\\\?\\UNC\\'):dest_raw='\\\\'+dest_raw[8:]
    elif dest_raw.startswith('\\\\?\\'):dest_raw=dest_raw[4:]
    a=read_connection(source);b=sqlite3.connect(dest_raw);deadline=time.monotonic()+60
    def progress(*args):
        if time.monotonic()>deadline:raise TimeoutError('数据库一致备份超时')
    try:
        a.backup(b,pages=256,progress=progress,sleep=0.05)
        b.execute('PRAGMA journal_mode=DELETE')
        if b.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('数据库备份完整性失败')
        b.commit()
    finally:a.close();b.close()
    return {'ok':True,'path':str(destination)}
if __name__=='__main__':
    try:
        req=json.loads(sys.stdin.buffer.read());print(json.dumps(snapshot(req['source'],req['destination'])))
    except Exception as e:print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=True));sys.exit(1)
