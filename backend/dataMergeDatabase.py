"""Conservative additive merge on OFFLINE database copies, never application stores."""
import sqlite3, pathlib, sys, json, importlib.util

ROOT = pathlib.Path(__file__).parent / 'memory-kernel'

def connect(p):
    raw=str(p)
    if raw.startswith('\\\\?\\UNC\\'):raw='\\\\'+raw[8:]
    elif raw.startswith('\\\\?\\'):raw=raw[4:]
    c=sqlite3.connect(pathlib.Path(raw).absolute().as_uri()+'?mode=ro&immutable=1',uri=True)
    c.row_factory=sqlite3.Row
    return c

def schema(c):
    return [(r[0],r[1],r[2],r[3]) for r in c.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]

def expected(kind, dest):
    file=ROOT/'core'/kind/'schema.py'
    spec=importlib.util.spec_from_file_location('merge_schema_'+kind,file)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    (mod.init_db if kind=='memory' else mod.init_knowledge_db)(str(dest))

def sql_tokens(sql):
    import re
    # Keep literal contents/case/whitespace intact; strip comments only outside quotes.
    pattern = r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|\x60[^\x60]*\x60|\[[^\]]*\]|--[^\n]*|/\*.*?\*/|[A-Za-z_][A-Za-z_0-9]*|[0-9]+(?:\.[0-9]+)?|[^\s]"
    out=[]
    for match in re.finditer(pattern,sql or '',re.S):
        t=match.group()
        if t.startswith(('--','/*')):continue
        if t[0] in ('"','`','['):t=t[1:-1].lower()
        elif not t.startswith("'"):t=t.lower()
        out.append(t)
    return out

def schema_fingerprint(c):
    # Compare complete audited DDL, allowing only column order and known added columns.
    optional={'hard_deleted_at':'hard_deleted_at REAL','summary':"summary TEXT DEFAULT ''",'hit_count':'hit_count INTEGER DEFAULT 0','last_hit_at':'last_hit_at REAL DEFAULT 0'}
    result=[]
    for typ,name,table,sql in schema(c):
        tokens=sql_tokens(sql)
        if name=='memory_vectors':
            want='CREATE TABLE memory_vectors (memory_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, dimensions INTEGER NOT NULL, vector_data BLOB NOT NULL, created_at REAL NOT NULL)'
            if tokens!=sql_tokens(want):raise ValueError('未知向量表定义')
            continue
        if name=='idx_vectors_scope':
            if tokens!=sql_tokens('CREATE INDEX idx_vectors_scope ON memory_vectors(scope_id)'):raise ValueError('未知向量索引定义')
            continue
        if typ=='table' and tokens[:2]==['create','table']:
            pos=tokens.index('(');head=tokens[:pos];depth=0;segments=[];current=[]
            for t in tokens[pos+1:]:
                if t==')' and depth==0:
                    segments.append(current);break
                if t==',' and depth==0:segments.append(current);current=[];continue
                current.append(t)
                if t=='(':depth+=1
                elif t==')':depth-=1
            tail=tokens[len(head)+2+sum(len(x) for x in segments)+len(segments)-1:]
            if not segments or any(not x for x in segments):raise ValueError('无效表定义')
            kept=[]
            for segment in segments:
                if name=='memory_records' and segment[0] in optional:
                    if segment!=sql_tokens(optional[segment[0]]):raise ValueError('扩展列定义变化')
                else:kept.append(tuple(segment))
            result.append((typ,name,tuple(head),tuple(sorted(kept)),tuple(tail)))
        else:result.append((typ,name,table,tuple(tokens)))
    return sorted(result,key=lambda r:(r[0],r[1]))

def rows(c,t):
    return [dict(r) for r in c.execute('SELECT * FROM "'+t+'"')]

def key_columns(c,t):
    return [r[1] for r in sorted(c.execute('PRAGMA table_info("'+t+'")'),key=lambda r:r[5]) if r[5]]

def merge(kind, local, incoming, output, archive, import_ledger=None):
    """Identical audited schemas only; no updates/deletes, foreign revision closure withheld."""
    import shutil
    if local.exists():shutil.copyfile(local,output)
    else:expected(kind,output)
    expected_path=output.with_suffix('.expected.db');expected(kind,expected_path)
    a=connect(incoming);o=sqlite3.connect(output);o.row_factory=sqlite3.Row;e=connect(expected_path)
    try:
        # SQLite SQL spelling can differ across old migrations. Deliberately refuse, not guess.
        if schema_fingerprint(a)!=schema_fingerprint(o) or schema_fingerprint(o)!=schema_fingerprint(e):raise ValueError('数据库结构不一致或不是已审查版本；未导入此部分')
        if a.execute('PRAGMA integrity_check').fetchone()[0]!='ok' or o.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('数据库损坏')
        tables=[r[0] for r in o.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE '%fts%' ORDER BY name")]
        accepted={};candidates={};existing={};conflicts=[];summary={'added':0,'same':0,'conflicts':0,'withheld':0,'detached':0,'tables':{}}
        for t in tables:
            pk=key_columns(o,t)
            if not pk:raise ValueError('未知无主键业务表 '+t)
            key=lambda r:tuple(r[k] for k in pk)
            local_rows=rows(o,t);remote_rows=rows(a,t)
            for group in (local_rows,remote_rows):
                keys=[key(r) for r in group]
                if any(any(v is None for v in k) for k in keys) or len(keys)!=len(set(keys)):raise ValueError('业务主键为空或重复：'+t)
            existing[t]={key(r):r for r in local_rows}
            candidates[t]={};accepted[t]=set()
            for r in remote_rows:
                k=key(r)
                if k in existing[t]:
                    if r==existing[t][k]:accepted[t].add(k);summary['same']+=1
                    else:conflicts.append({'table':t,'reason':'same-id-different-record','record':r});summary['conflicts']+=1
                else:candidates[t][k]=r
        # Never import operational projects/windows/partners/rules/config/vector metadata.
        import hashlib,base64
        def revision(t,r):return hashlib.sha256(json.dumps([kind,t,r],sort_keys=True,ensure_ascii=True,separators=(',',':'),default=lambda x:{'blob':base64.b64encode(x).decode('ascii')}).encode()).hexdigest()
        allowed={'memory_records','memory_events','scopes'} if kind=='memory' else {'knowledge_entries','knowledge_relations'}
        def dependencies(t,r):
            deps=[]
            for f in o.execute('PRAGMA foreign_key_list("'+t+'")'):
                if r.get(f[3]) not in (None,''):deps.append((f[2],(r[f[3]],)))
            if t=='memory_events':
                for col in ('memory_id','aggregate_id'):
                    if r.get(col):deps.append(('memory_records',(r[col],)))
                if r.get('causation_id'):deps.append(('memory_events',(r['causation_id'],)))
            if t=='memory_records' and r.get('source_event_ids'):
                ids=json.loads(r['source_event_ids'])
                if not isinstance(ids,list) or any(not isinstance(x,str) or not x for x in ids):raise ValueError('未知来源事件引用')
                deps.extend(('memory_events',(x,)) for x in ids)
            if t=='memory_nodes' and r.get('project_id'):deps.append(('projects',(r['project_id'],)))
            if t=='knowledge_entries' and r.get('parent_id'):deps.append(('knowledge_entries',(r['parent_id'],)))
            if t=='knowledge_relations':deps.extend([('knowledge_entries',(r['source_id'],)),('knowledge_entries',(r['target_id'],))])
            return deps
        # Dependency resolution is a fixed point, not INSERT OR IGNORE / guessed new IDs.
        pending=[(t,k,r) for t in tables for k,r in candidates[t].items()]
        while pending:
            progress=False;rest=[]
            for t,k,r in pending:
                if import_ledger is not None and revision(t,r) in import_ledger:
                    conflicts.append({'table':t,'reason':'already-imported-revision-not-revived','record':r});summary['withheld']+=1;continue
                safe=t in allowed
                if t=='scopes':safe=safe and r.get('scope_type') in ('global','nis_core') and not r.get('owner_id')
                if t=='knowledge_entries':safe=safe and not json.loads(r.get('attachments') or '[]')
                if not safe:
                    conflicts.append({'table':t,'reason':'operational-or-external-reference-not-enabled','record':r});summary['withheld']+=1;continue
                if not all(ref in accepted.get(table,set()) for table,ref in dependencies(t,r)):
                    rest.append((t,k,r));continue
                value=dict(r)
                if t=='memory_records':
                    # Remote vector IDs do not refer to our local retrieval backend.
                    conflicts.append({'table':t,'reason':'imported-original-before-local-index-reset','record':r})
                    for col in ('vector_id','indexed_at'):value[col]=None
                    value['reindex_status']='pending'
                if t=='knowledge_entries' and value.get('project_id'):
                    conflicts.append({'table':t,'reason':'project-binding-detached-original','record':r})
                    value['project_id']='';summary['detached']+=1
                # Insert by local column names, never rely on migrated column order.
                local_cols={x[1] for x in o.execute('PRAGMA table_info("'+t+'")')}
                if any(v is not None and name not in local_cols for name,v in value.items()):raise ValueError('导入记录含本机缺失的有效字段')
                value={name:v for name,v in value.items() if name in local_cols}
                cols=list(value);o.execute('INSERT INTO "'+t+'" ('+','.join('"'+c+'"' for c in cols)+') VALUES ('+','.join('?' for _ in cols)+')',tuple(value.values()))
                if import_ledger is not None:import_ledger[revision(t,r)]={'part':kind,'table':t,'sourceId':list(k)}
                accepted[t].add(k);summary['added']+=1;summary['tables'][t]=summary['tables'].get(t,0)+1;progress=True
            if not progress:
                for t,k,r in rest:conflicts.append({'table':t,'reason':'dependency-conflict-or-missing','record':r});summary['withheld']+=1
                break
            pending=rest
        for ft in (['memory_fts','memory_nodes_fts'] if kind=='memory' else ['knowledge_fts']):
            o.execute('INSERT INTO "'+ft+'" ("'+ft+'") VALUES (\'rebuild\')')
        if o.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('合并后数据库完整性失败')
        # Existing dangling foreign keys are not silently made worse.
        old=connect(local) if local.exists() else None
        before=set(tuple(r) for r in old.execute('PRAGMA foreign_key_check')) if old else set()
        if old:old.close()
        if set(tuple(r) for r in o.execute('PRAGMA foreign_key_check'))-before:raise ValueError('合并新增了失效外键')
        # Serialize BLOB values losslessly in the conflict archive before committing output.
        import base64
        encoded=json.dumps(conflicts,ensure_ascii=True,indent=2,default=lambda x:{'$sqliteBlobBase64':base64.b64encode(x).decode('ascii')} if isinstance(x,bytes) else (_ for _ in ()).throw(TypeError(type(x).__name__)))
        archive.write_text(encoded,encoding='utf-8')
        o.commit()
        return summary
    except:
        o.rollback();raise
    finally:
        a.close();o.close();e.close();expected_path.unlink(missing_ok=True)
