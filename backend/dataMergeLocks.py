"""Kernel locks for runtime, bridges and offline commits. Stdlib, no application imports.
Runtime: exclusive owner + shared barrier; bridge: shared memory barrier;
commit: exclusive owner + exclusive barriers. Locks auto-release on process death.
"""
import os, sys, pathlib, hashlib, json

def canonical(p):
    s=os.path.normcase(os.path.realpath(str(p)))
    if s.startswith('\\\\?\\unc\\'):s='\\\\'+s[8:]
    elif s.startswith('\\\\?\\'):s=s[4:]
    return s

class DataLocks:
    def __init__(self, roots, mode):
        self.files=[]
        try:
            for root in sorted(set(canonical(p) for p in roots)): 
                p=pathlib.Path(root);p.parent.mkdir(parents=True,exist_ok=True)
                digest=hashlib.sha256(root.encode('utf-8')).hexdigest()[:24]
                names=[('owner',True)] if mode=='runtime' else []
                if mode=='bridge':names=[]
                if mode=='commit':names=[('owner',True)]
                names.append(('barrier',mode=='commit'))
                if mode=='journal':names=[('journal',True)]
                for name,exclusive in names:
                    f=open(p.parent/('.nis-'+digest+'-'+name+'.lock'),'a+b',buffering=0)
                    self.files.append(f)
                    if os.name=='nt':
                        import ctypes, msvcrt
                        from ctypes import wintypes
                        class OVERLAPPED(ctypes.Structure):
                            _fields_=[('Internal',ctypes.c_size_t),('InternalHigh',ctypes.c_size_t),('Offset',wintypes.DWORD),('OffsetHigh',wintypes.DWORD),('hEvent',wintypes.HANDLE)]
                        ov=OVERLAPPED();kernel=ctypes.WinDLL('kernel32',use_last_error=True)
                        lock=kernel.LockFileEx;lock.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.DWORD,wintypes.DWORD,wintypes.DWORD,ctypes.POINTER(OVERLAPPED)];lock.restype=wintypes.BOOL
                        flags=1 | (2 if exclusive else 0) # fail immediately; never steal a stale PID lock
                        if not lock(wintypes.HANDLE(msvcrt.get_osfhandle(f.fileno())),flags,0,1,0,ctypes.byref(ov)):
                            raise RuntimeError('数据正在使用，禁止合并或重复启动：'+root)
                    else:
                        import fcntl
                        fcntl.flock(f.fileno(),(fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)|fcntl.LOCK_NB)
        except:
            self.close();raise
    def close(self):
        for f in reversed(self.files):f.close()
        self.files=[]
    def __enter__(self):return self
    def __exit__(self,*args):self.close()

if __name__=='__main__':
    try:
        req=json.loads(sys.stdin.buffer.readline())
        with DataLocks(req['roots'],req['mode']):
            print(json.dumps({'ok':True,'pid':os.getpid()}),flush=True)
            # Parent owns stdin. EOF on graceful exit or abrupt parent death releases kernel locks.
            sys.stdin.buffer.read()
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=True),flush=True);sys.exit(1)
